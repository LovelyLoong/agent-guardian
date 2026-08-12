/**
 * agent-guardian — 状态机测试：原子落盘 / 崩溃恢复 / 列表顺序。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, initialState, decideStart, pidAlive, claimRun, LEASE_MS, claimInProcess, releaseInProcess } from "../src/watcher/state.ts";
import type { WatchState, LedgerLine } from "../src/watcher/state.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ag-state-"));
}

function makeState(overrides: Partial<Parameters<typeof initialState>[0]> = {}) {
  return initialState({
    watchId: "w1",
    budgetMs: 120_000,
    targetKind: "pi",
    channelKind: "file",
    handle: "f.jsonl",
    sessionFile: "f.jsonl",
    now: 1_000,
    ...overrides,
  });
}

/**
 * load 结果收窄为状态（W5）：断言 kind==="ok" 后返回 state。
 * 形状（ok/missing/error 区分）的专项断言见下方用例与 fixtures/ebusy-inject.ts。
 */
async function okState(store: StateStore, watchId: string): Promise<WatchState> {
  const loaded = await store.load(watchId);
  assert.strictEqual(loaded.kind, "ok", `load(${watchId}) 应为 ok（实测 ${JSON.stringify(loaded)}）`);
  return loaded.kind === "ok" ? loaded.state : (undefined as never);
}

describe("StateStore", () => {
  it("保存后可原样读回（崩溃恢复续跑）", async () => {
    const store = new StateStore(tempDir());
    const s = makeState();
    s.settledBeats = 7;
    s.remindCount = 2;
    s.escalationCount = 1;
    s.cooldownUntil = { spin: 9 };
    s.remindHistory = [{ kind: "spin", beat: 3, factsHash: "abc" }];
    s.llmCalls = 1;
    s.safetyWarningTrigger = "budget";
    await store.save("w1", s);

    const loaded = await okState(store, "w1");
    assert.strictEqual(loaded.settledBeats, 7);
    assert.strictEqual(loaded.remindCount, 2);
    assert.strictEqual(loaded.escalationCount, 1);
    assert.strictEqual(loaded.llmCalls, 1);
    assert.strictEqual(loaded.startedAt, 1_000);
    assert.deepStrictEqual(loaded.cooldownUntil, { spin: 9 });
    assert.deepStrictEqual(loaded.remindHistory, [{ kind: "spin", beat: 3, factsHash: "abc" }]);
    assert.strictEqual(loaded.safetyWarningSent, false);
    assert.strictEqual(loaded.safetyWarningTrigger, "budget");
    assert.strictEqual(loaded.channelKind, "file");
    assert.strictEqual(loaded.targetKind, "pi");
  });

  it("原子落盘：无 .tmp 残留，覆盖写入不产生半写文件", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    const s = makeState();
    await store.save("w1", s);
    s.settledBeats = 99;
    await store.save("w1", s);
    const files = readdirSync(dir);
    assert.ok(files.includes("w1.json"));
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
    const loaded = await okState(store, "w1");
    assert.strictEqual(loaded.settledBeats, 99);
  });

  it("损坏状态文件 → missing（从头开始，与 ok/error 区分）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(join(dir, "w1.json"), "{ 不是合法 JSON", "utf-8");
    assert.deepStrictEqual(await store.load("w1"), { kind: "missing" });
  });

  it("字段缺失的旧状态 → 补默认值（向前兼容）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.json"),
      JSON.stringify({ startedAt: 42, settledBeats: 3, cursor: "c1" }),
      "utf-8",
    );
    const loaded = await okState(store, "w1");
    assert.strictEqual(loaded.settledBeats, 3);
    assert.strictEqual(loaded.remindCount, 0);
    assert.deepStrictEqual(loaded.cooldownUntil, {});
    assert.strictEqual(loaded.safetyWarningSent, false);
    assert.strictEqual(loaded.safetyWarningTrigger, null);
    assert.strictEqual(loaded.budgetMs, 0);
  });

  it("startedAt 非法 → missing（重头开始，非 error）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(join(dir, "w1.json"), JSON.stringify({ startedAt: "x" }), "utf-8");
    assert.deepStrictEqual(await store.load("w1"), { kind: "missing" });
  });

  it("list 按最近修改倒序", async () => {
    const store = new StateStore(tempDir());
    await store.save("old", makeState());
    await new Promise((r) => setTimeout(r, 10));
    await store.save("new", makeState());
    assert.deepStrictEqual(store.list(), ["new", "old"]);
  });
});

// ---------------------------------------------------------------------------
// V1.1：运行代际 / 租约 / 单例锁
// ---------------------------------------------------------------------------

describe("V1.1 启动裁决 decideStart", () => {
  function activeState(overrides: Partial<WatchState> = {}): WatchState {
    return {
      ...makeState(),
      status: "active",
      watchRunId: "run-x",
      generation: 2,
      ownerPid: process.pid,
      leaseExpiresAt: 1_000_000,
      ...overrides,
    };
  }

  it("无状态 → fresh", () => {
    assert.deepStrictEqual(decideStart(null, 0), { kind: "fresh" });
  });

  it("finished → fresh（不继承，默认新任务）", () => {
    const s = activeState({ status: "finished" });
    assert.deepStrictEqual(decideStart(s, 0), { kind: "fresh" });
  });

  it("active + 未过期租约 + 属主存活 → denied（单例）", () => {
    const s = activeState();
    const d = decideStart(s, 0);
    assert.strictEqual(d.kind, "denied");
    if (d.kind === "denied") assert.ok(d.reason.includes("已有监督者正在运行"));
  });

  it("active + 未过期租约 + 属主已死 → resume（崩溃恢复）", async () => {
    const dead = await deadPid();
    const s = activeState({ ownerPid: dead });
    assert.deepStrictEqual(decideStart(s, 0), { kind: "resume" });
  });

  it("active + 租约已过期（属主生死不论）→ fresh（不恢复失联旧运行）", async () => {
    const dead = await deadPid();
    assert.deepStrictEqual(decideStart(activeState({ ownerPid: dead, leaseExpiresAt: 0 }), 0), { kind: "fresh" });
    assert.deepStrictEqual(decideStart(activeState({ leaseExpiresAt: 0 }), 0), { kind: "fresh" });
  });

  it("租约边界：now === leaseExpiresAt 视为已过期", () => {
    const s = activeState({ leaseExpiresAt: 100 });
    assert.deepStrictEqual(decideStart(s, 100), { kind: "fresh" });
  });

  it("legacy 状态（无 watchRunId）→ finished 归一 → fresh", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(join(dir, "w1.json"), JSON.stringify({ startedAt: 42, settledBeats: 3 }), "utf-8");
    const loaded = await okState(store, "w1");
    assert.strictEqual(loaded.watchRunId, "legacy");
    assert.strictEqual(loaded.status, "finished");
    assert.strictEqual(loaded.ownerPid, 0);
    assert.strictEqual(loaded.leaseExpiresAt, 0);
    assert.deepStrictEqual(decideStart(loaded, 0), { kind: "fresh" });
  });
});

describe("V1.1 pidAlive 与 claimRun", () => {
  it("pidAlive：0/负数/非法 → false；自身进程 → true；已退出子进程 → false", async () => {
    assert.strictEqual(pidAlive(0), false);
    assert.strictEqual(pidAlive(-1), false);
    assert.strictEqual(pidAlive(Number.NaN), false);
    assert.strictEqual(pidAlive(process.pid), true);
    const dead = await deadPid();
    assert.strictEqual(pidAlive(dead), false);
  });

  it("claimRun：新运行代 + 属主 + 租约就位（就地接管）", () => {
    const s = makeState();
    const out = claimRun(s, { watchRunId: "run-new", generation: 5, now: 1_000 });
    assert.strictEqual(out, s, "就地接管");
    assert.strictEqual(s.watchRunId, "run-new");
    assert.strictEqual(s.generation, 5);
    assert.strictEqual(s.status, "active");
    assert.strictEqual(s.ownerPid, process.pid);
    assert.strictEqual(s.leaseExpiresAt, 1_000 + LEASE_MS);
  });

  it("initialState 缺省：watchRunId 新生成、generation=1、租约=now+LEASE_MS", () => {
    const s = initialState({
      watchId: "w1",
      budgetMs: 1_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "h",
      sessionFile: null,
      now: 500,
    });
    assert.ok(s.watchRunId.startsWith("run-"));
    assert.strictEqual(s.generation, 1);
    assert.strictEqual(s.status, "active");
    assert.strictEqual(s.ownerPid, process.pid);
    assert.strictEqual(s.leaseExpiresAt, 500 + LEASE_MS);
  });
});

describe("V1.2 租约账本单例锁 claimLock（append-only leader election）", () => {
  type ClaimLine = Extract<LedgerLine, { op: "claim" }>;

  function claimLines(store: StateStore, watchId: string): ClaimLine[] {
    return store.readLedger(watchId).lines.filter((l): l is ClaimLine => l.op === "claim");
  }

  it("空账本 → 追加 claim + 重读求值：自己即首条存活 → acquired（fresh）", async () => {
    const store = new StateStore(tempDir());
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-a", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
    if (claim.kind === "acquired") assert.deepStrictEqual(claim.start, { kind: "fresh" });
    const claims = claimLines(store, "w1");
    assert.strictEqual(claims.length, 1);
    assert.deepStrictEqual(claims[0], {
      op: "claim",
      runId: "run-a",
      ownerPid: process.pid,
      leaseExpiresAt: 1_000 + LEASE_MS,
      ts: 1_000,
    });
    assert.strictEqual(store.leaseWinner("w1", 1_000)?.runId, "run-a");
  });

  it("活 claim（未过期租约 + 存活属主）文件序更前 → denied（exit 3 语义），胜者不变", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "claim", runId: "run-other", ownerPid: process.pid, leaseExpiresAt: 1_000_000, ts: 0 }) + "\n",
      "utf-8",
    );
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-b", now: 1_000 });
    assert.strictEqual(claim.kind, "denied");
    if (claim.kind === "denied") assert.ok(claim.reason.includes("已有监督者正在运行"));
    assert.strictEqual(store.leaseWinner("w1", 1_000)?.runId, "run-other", "活 claim 不得被后来的 claim 压过");
  });

  it("过期租约 + 死属主 → 自己的 claim 成为首条存活 → acquired", async () => {
    const dead = await deadPid();
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "claim", runId: "run-stale", ownerPid: dead, leaseExpiresAt: 0, ts: 0 }) + "\n",
      "utf-8",
    );
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-c", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
    assert.strictEqual(store.leaseWinner("w1", 1_000)?.runId, "run-c", "stale claim 死亡后自己的 claim 当选");
  });

  it("未过期租约 + 死属主 → 回收（崩溃恢复的锁侧行为）", async () => {
    const dead = await deadPid();
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "claim", runId: "run-dead", ownerPid: dead, leaseExpiresAt: 1_000_000, ts: 0 }) + "\n",
      "utf-8",
    );
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-d", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
  });

  it("属主存活但租约过期 → 回收（与 decideStart 的 fresh 语义一致）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "claim", runId: "run-e", ownerPid: process.pid, leaseExpiresAt: 0, ts: 0 }) + "\n",
      "utf-8",
    );
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-f", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
  });

  it("无账本但状态显示活属主（不一致世界）→ denied 且追加 release 撤销自建 claim", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    const prev = initialState({
      watchId: "w1",
      budgetMs: 1_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "h",
      sessionFile: null,
      now: 0,
      ownerPid: process.pid,
      leaseExpiresAt: 1_000_000,
    });
    const claim = await store.claimLock("w1", { prev, watchRunId: "run-g", now: 1_000 });
    assert.strictEqual(claim.kind, "denied");
    const lines = store.readLedger("w1").lines;
    assert.ok(lines.some((l) => l.op === "claim" && l.runId === "run-g"), "自建 claim 已追加");
    assert.ok(lines.some((l) => l.op === "release" && l.runId === "run-g"), "拒绝后必须 release 撤销自建 claim");
    assert.strictEqual(store.leaseWinner("w1", 1_000), null, "撤销后无存活胜者");
  });

  it("正常路径：claim→renew→release（renew 延长租约、release 杀死 runId）", async () => {
    const store = new StateStore(tempDir());
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-h", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
    // 己属续租成功：renew 行生效，租约延长
    const renewed = store.renewLock(
      "w1",
      { watchRunId: "run-h", ownerPid: process.pid, leaseExpiresAt: 99_999 },
      50_000,
    );
    assert.strictEqual(renewed, true, "己属续租应成功");
    assert.strictEqual(store.leaseWinner("w1", 90_000)?.leaseExpiresAt, 99_999, "renew 行覆盖 claim 租约");
    // 正常收尾：release 追加，runId 永久死亡（账本不删除）
    store.releaseLock("w1", { watchRunId: "run-h", ownerPid: process.pid, leaseExpiresAt: 99_999 });
    const lines = store.readLedger("w1").lines;
    assert.ok(lines.some((l) => l.op === "release" && l.runId === "run-h"), "收尾追加 release 行");
    assert.strictEqual(store.leaseWinner("w1", 90_000), null, "release 后该 runId 永久死亡");
  });

  it("release 后新 claim 当选", async () => {
    const store = new StateStore(tempDir());
    const c1 = await store.claimLock("w1", { prev: null, watchRunId: "run-x", now: 1_000 });
    assert.strictEqual(c1.kind, "acquired");
    store.releaseLock("w1", { watchRunId: "run-x", ownerPid: process.pid, leaseExpiresAt: 1_000 + LEASE_MS });
    const c2 = await store.claimLock("w1", { prev: null, watchRunId: "run-y", now: 2_000 });
    assert.strictEqual(c2.kind, "acquired", "release 后新 claim 当选");
    assert.strictEqual(store.leaseWinner("w1", 2_000)?.runId, "run-y");
  });

  it("renew 归属校验：非胜者 renew 无效（丢锁），胜者 renew 有效", async () => {
    const dead = await deadPid();
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "claim", runId: "run-old", ownerPid: dead, leaseExpiresAt: 0, ts: 0 }) + "\n",
      "utf-8",
    );
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-new", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
    // 旧 owner 续租 → 非胜者 → false（丢锁）
    const renewed = store.renewLock(
      "w1",
      { watchRunId: "run-old", ownerPid: dead, leaseExpiresAt: 99_999 },
      50_000,
    );
    assert.strictEqual(renewed, false, "旧 owner 续租必须拒绝");
    assert.strictEqual(store.leaseWinner("w1", 50_000)?.runId, "run-new", "旧 owner 不得延续自己的死 claim");
    // 胜者续租 → true，租约延长；过期后胜者消失
    const renewed2 = store.renewLock(
      "w1",
      { watchRunId: "run-new", ownerPid: process.pid, leaseExpiresAt: 99_999 },
      50_000,
    );
    assert.strictEqual(renewed2, true, "胜者续租应成功");
    assert.strictEqual(store.leaseWinner("w1", 99_000)?.runId, "run-new", "renew 后租约仍有效");
    assert.strictEqual(store.leaseWinner("w1", 100_000), null, "租约过期后胜者消失");
  });

  it("旧 owner release 无害：只杀自己的 runId，不伤新胜者", async () => {
    const dead = await deadPid();
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "claim", runId: "run-old", ownerPid: dead, leaseExpiresAt: 0, ts: 0 }) + "\n",
      "utf-8",
    );
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-new", now: 1_000 });
    assert.strictEqual(claim.kind, "acquired");
    // 旧 owner 收尾释放 → 只杀自己的 runId，新胜者不受影响（账本不删除）
    store.releaseLock("w1", { watchRunId: "run-old", ownerPid: dead, leaseExpiresAt: 0 });
    assert.strictEqual(store.leaseWinner("w1", 1_000)?.runId, "run-new", "旧 owner 迟到 release 不得伤及新胜者");
  });

  it("坏行容忍：非 JSON/缺字段/类型错/未知 op 行跳过，不影响求值", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      [
        "{ 不是合法 JSON\n",
        `{"op":"claim","runId":"run-a","ownerPid":${process.pid},"leaseExpiresAt":100000,"ts":0}\n`,
        '{"op":"claim","runId":123}\n', // runId 类型错
        '{"op":"frobnicate","runId":"run-x"}\n', // 未知 op
        "\n", // 空行
        '{"op":"renew","runId":"run-a","leaseExpiresAt":500000}\n',
        '{"op":"claim","runId":"run-b","ownerPid":"x","leaseExpiresAt":900000,"ts":0}\n', // ownerPid 类型错
      ].join(""),
      "utf-8",
    );
    const winner = store.leaseWinner("w1", 400_000);
    assert.strictEqual(winner?.runId, "run-a", "坏行被跳过，run-a 按最后一条 renew 的租约存活");
    assert.strictEqual(winner?.leaseExpiresAt, 500_000, "renew 覆盖 claim 租约");
    assert.strictEqual(store.leaseWinner("w1", 600_000), null, "租约过期后无胜者（run-b 因坏行被忽略）");
  });

  it("多 claimer 竞争（进程内并发）：恰 1 acquired，胜者=文件序首条存活 claim", async () => {
    const store = new StateStore(tempDir());
    const now = 1_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.claimLock("w1", { prev: null, watchRunId: `run-probe-${i}`, now }),
      ),
    );
    const acquired = results.filter((r) => r.kind === "acquired");
    assert.strictEqual(acquired.length, 1, `应恰 1 个 acquired，实测 ${acquired.length}`);
    const claims = claimLines(store, "w1");
    assert.strictEqual(claims.length, 20, "20 个 claim 行全部落账");
    assert.strictEqual(claims[0]?.runId, store.leaseWinner("w1", now)?.runId, "胜者=文件序首条存活 claim");
  });

  it("同进程注册表：claimInProcess 首次成功、重复 false、release 后可再声明", () => {
    assert.strictEqual(claimInProcess("w-reg"), true);
    assert.strictEqual(claimInProcess("w-reg"), false);
    releaseInProcess("w-reg");
    assert.strictEqual(claimInProcess("w-reg"), true);
    releaseInProcess("w-reg");
  });
});

describe("V1.2.1 F2 断链永久死亡（防僵尸复活）", () => {
  it("A 租约过期 → B claim 当选 → A 复活追加 renew → 胜者仍为 B，其后 renew 一律忽略", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      [
        // A 首次 claim（租约 20min）
        JSON.stringify({ op: "claim", runId: "run-a", ownerPid: process.pid, leaseExpiresAt: 1_000 + LEASE_MS, ts: 1_000 }) + "\n",
        // A 断链：租约过期无人续租；30min 后 B claim 当选
        JSON.stringify({ op: "claim", runId: "run-b", ownerPid: process.pid, leaseExpiresAt: 1_800_000 + LEASE_MS, ts: 1_800_000 }) + "\n",
        // A 复活：迟到 renew（ts 晚于其当时租约到期 1_000+LEASE_MS）
        JSON.stringify({ op: "renew", runId: "run-a", leaseExpiresAt: 1_900_000 + LEASE_MS, ts: 1_900_000 }) + "\n",
      ].join(""),
      "utf-8",
    );
    assert.strictEqual(store.leaseWinner("w1", 1_900_000)?.runId, "run-b", "A 断链后迟到 renew 不得赢回锁");
    // A 继续追加 renew（ts 更晚）→ 仍忽略
    writeFileSync(
      join(dir, "w1.lock"),
      JSON.stringify({ op: "renew", runId: "run-a", leaseExpiresAt: 2_100_000 + LEASE_MS, ts: 2_100_000 }) + "\n",
      { flag: "a", encoding: "utf-8" },
    );
    assert.strictEqual(store.leaseWinner("w1", 2_100_000)?.runId, "run-b", "断链后 renew 一律忽略");
    // B 租约过期后无胜者（A 不可复活）
    assert.strictEqual(store.leaseWinner("w1", 1_800_000 + LEASE_MS), null, "B 过期后无胜者（A 永久死亡）");
  });

  it("健康链不受断链判定影响：renew ts 在租约内正常延展；ts == leaseExpiresAt 边界不算断链", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      [
        JSON.stringify({ op: "claim", runId: "run-h", ownerPid: process.pid, leaseExpiresAt: 1_000 + LEASE_MS, ts: 1_000 }) + "\n",
        // 边界：renew ts 恰好 == 当时租约到期 → 不算断链，延展生效
        JSON.stringify({ op: "renew", runId: "run-h", leaseExpiresAt: 1_000 + 2 * LEASE_MS, ts: 1_000 + LEASE_MS }) + "\n",
        // 正常续租：ts 在租约内 → 延展
        JSON.stringify({ op: "renew", runId: "run-h", leaseExpiresAt: 1_000 + 3 * LEASE_MS, ts: 1_000 + 2 * LEASE_MS }) + "\n",
      ].join(""),
      "utf-8",
    );
    const winner = store.leaseWinner("w1", 1_000 + 2 * LEASE_MS);
    assert.strictEqual(winner?.runId, "run-h", "健康链正常延展");
    assert.strictEqual(winner?.leaseExpiresAt, 1_000 + 3 * LEASE_MS);
  });

  it("孤儿 renew（无 claim）忽略；新 claim 不受旧 runId 死亡影响", () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.lock"),
      [
        JSON.stringify({ op: "claim", runId: "run-a", ownerPid: process.pid, leaseExpiresAt: 1_000 + LEASE_MS, ts: 1_000 }) + "\n",
        JSON.stringify({ op: "renew", runId: "run-orphan", leaseExpiresAt: 9_999_999, ts: 9_999_999 }) + "\n", // 孤儿
        JSON.stringify({ op: "renew", runId: "run-a", leaseExpiresAt: 9_999_999, ts: 9_999_999 }) + "\n", // A 断链死亡
        JSON.stringify({ op: "claim", runId: "run-c", ownerPid: process.pid, leaseExpiresAt: 2_000 + LEASE_MS, ts: 2_000 }) + "\n",
      ].join(""),
      "utf-8",
    );
    assert.strictEqual(store.leaseWinner("w1", 2_000)?.runId, "run-c", "新 claim 不受旧 runId 死亡影响，孤儿 renew 忽略");
  });
});

describe("V1.2 租约账本跨进程选举（真实子进程并发探针）", () => {
  const probe = join(import.meta.dirname, "fixtures", "claim-probe.ts");

  function spawnClaimer(dir: string, watchId: string, total: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [probe, dir, watchId, String(total)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", reject);
      child.on("exit", () => resolve(out.trim()));
    });
  }

  it("fresh：40 个真实子进程并发抢同一 watchId → 恰 1 acquired，胜者=账本文件序首条 claim", async () => {
    const dir = tempDir();
    const results = await Promise.all(Array.from({ length: 40 }, () => spawnClaimer(dir, "w-race", 40)));
    const acquired = results.filter((r) => r.startsWith("acquired|"));
    assert.strictEqual(acquired.length, 1, `应恰 1 个 acquired，实测 ${acquired.length}`);
    const winnerRunId = acquired[0]!.split("|")[1]!;
    const store = new StateStore(dir);
    const claims = store.readLedger("w-race").lines.filter(
      (l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim",
    );
    assert.ok(claims.length >= 40, "40 个 claim 行全部落账");
    assert.strictEqual(claims[0]!.runId, winnerRunId, "胜者必须是账本文件序第一条 claim（确定性选举）");
    assert.ok(claims[0]!.ownerPid > 0, "胜者 claim 携带真实属主 pid");
  });

  it("预置 stale 账本（死属主 + 过期租约 ×2）→ 40 个真实子进程并发 → 恰 1 acquired，胜者为 stale 之后首条 claim", async () => {
    const dead = await deadPid();
    const dir = tempDir();
    writeFileSync(
      join(dir, "w-race.lock"),
      [
        JSON.stringify({ op: "claim", runId: "run-stale-1", ownerPid: dead, leaseExpiresAt: 0, ts: 0 }) + "\n",
        JSON.stringify({ op: "claim", runId: "run-stale-2", ownerPid: process.pid, leaseExpiresAt: 0, ts: 0 }) + "\n",
        JSON.stringify({ op: "renew", runId: "run-stale-1", leaseExpiresAt: 50 }) + "\n",
      ].join(""),
      "utf-8",
    );
    const results = await Promise.all(Array.from({ length: 40 }, () => spawnClaimer(dir, "w-race", 40)));
    const acquired = results.filter((r) => r.startsWith("acquired|"));
    assert.strictEqual(acquired.length, 1, `应恰 1 个 acquired，实测 ${acquired.length}`);
    const winnerRunId = acquired[0]!.split("|")[1]!;
    const store = new StateStore(dir);
    const claims = store.readLedger("w-race").lines.filter(
      (l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim",
    );
    assert.strictEqual(claims[0]!.runId, "run-stale-1", "stale claim 保留在账本（append-only，不删除）");
    assert.strictEqual(claims[2]!.runId, winnerRunId, "胜者为 stale 之后文件序首条存活 claim");
  });
});

// ---------------------------------------------------------------------------
// T1 ghost claim 回归：denied 必须撤销自建 claim（防 ghost 占位/继位）
// ---------------------------------------------------------------------------

describe("T1 ghost claim 回归（denied 撤销自建 claim）", () => {
  const holdProbe = join(import.meta.dirname, "fixtures", "hold-claim.ts");

  /** 启动 holder 子进程（claim 后保持存活直到被杀），返回首行输出。 */
  function spawnHolder(dir: string, watchId: string): { child: ChildProcess; firstLine: Promise<string> } {
    const child = spawn(process.execPath, [holdProbe, dir, watchId], { stdio: ["ignore", "pipe", "pipe"] });
    const firstLine = new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          child.stdout!.removeAllListeners("data");
          resolve(buf.slice(0, nl));
        }
      });
      child.once("error", reject);
    });
    return { child, firstLine };
  }

  /** 杀掉 holder 并等待退出（有界超时，防挂起）。 */
  function killAndWait(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("holder 子进程未在预期时间内退出"));
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  it("A 当选、B denied → B 的 claim 行已带 release；A 死后 B 不得继位，新 claim 才当选", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    const watchId = "w-ghost";
    // A：真实子进程当选并保持存活（租约未过期 + 属主存活）
    const a = spawnHolder(dir, watchId);
    const aLine = await a.firstLine;
    assert.ok(aLine.startsWith("acquired|"), `A 应当选（实测 ${aLine}）`);
    const runA = aLine.split("|")[1]!;
    assert.strictEqual(store.leaseWinner(watchId, Date.now())?.runId, runA, "A 当选：恰一存活胜者");
    // B：主进程 claim → denied（A 租约未过期且属主存活）
    const nowB = Date.now();
    const claimB = await store.claimLock(watchId, { prev: null, watchRunId: "run-b", now: nowB });
    assert.strictEqual(claimB.kind, "denied");
    if (claimB.kind === "denied") assert.ok(claimB.reason.includes("已有监督者正在运行"));
    const lines = store.readLedger(watchId).lines;
    assert.ok(lines.some((l) => l.op === "claim" && l.runId === "run-b"), "B 的 claim 行已追加");
    assert.ok(
      lines.some((l) => l.op === "release" && l.runId === "run-b"),
      "B 被拒后其 claim 行必须已有 release（撤销自建 claim，防 ghost）",
    );
    // A 死亡：属主进程已死（租约尚未过期）
    const aPid = a.child.pid!;
    await killAndWait(a.child);
    assert.strictEqual(pidAlive(aPid), false, "A 的 pid 已死");
    assert.strictEqual(
      store.leaseWinner(watchId, nowB + 1_000),
      null,
      "A 死后（未过期租约+死属主）无存活胜者，B 不得凭被撤销的 claim 继位",
    );
    // A 租约也过期 + pid 死 → 仍无存活胜者
    const aClaim = lines.find(
      (l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim" && l.runId === runA,
    )!;
    assert.strictEqual(store.leaseWinner(watchId, aClaim.leaseExpiresAt + 1), null, "A 租约过期 + pid 死 → 仍无存活胜者");
    // 新 claim 才当选（ghost 不得占位）
    const claimC = await store.claimLock(watchId, { prev: null, watchRunId: "run-c", now: nowB + 2_000 });
    assert.strictEqual(claimC.kind, "acquired", "ghost 不得占位，新 claim 才当选");
    assert.strictEqual(store.leaseWinner(watchId, nowB + 2_000)?.runId, "run-c");
  });
});

// ---------------------------------------------------------------------------
// V1.2 barrier 跨进程选举探针（ready/go 同步，任一时刻恰 1 存活胜者）
// ---------------------------------------------------------------------------

describe("V1.2 barrier 跨进程选举探针（ready/go 同步）", () => {
  const barrierProbe = join(import.meta.dirname, "fixtures", "barrier-claim.ts");

  async function runBarrierRound(count: number): Promise<void> {
    const dir = tempDir();
    const watchId = "w-barrier";
    const readyDir = join(dir, "ready");
    const goFile = join(dir, "go");
    const resultFile = join(dir, "results.txt");
    mkdirSync(readyDir, { recursive: true });
    // 全部子进程：先 append claim → 写各自 ready 文件 → 等 go → 同时求值 → 上报
    const errByChild = new Map<ChildProcess, string>();
    const children = Array.from({ length: count }, () => {
      const child = spawn(
        process.execPath,
        [barrierProbe, dir, watchId, readyDir, goFile, resultFile, String(count)],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      errByChild.set(child, "");
      child.stderr!.on("data", (d: Buffer) => errByChild.set(child, errByChild.get(child)! + d.toString()));
      return child;
    });
    // 主进程确认齐集（所有 claim 已落账）后写 go 文件
    const readyDeadline = Date.now() + 60_000;
    while (readdirSync(readyDir).length < count) {
      if (Date.now() > readyDeadline) {
        throw new Error(`barrier：${count} 个子进程未全部就绪（超时）：${[...errByChild.values()].join("\n")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(goFile, "go", "utf-8");
    // 选举窗口内轮询：任一时刻恰 1 存活胜者，且胜者恒定。窗口 = 求值进行中
    // （结果行数 < count：尚未全部上报）；齐集后选举已结束，胜者可能随即退出
    // （其 claim 随进程死亡自然失效），不再轮询——齐集前的每个瞬间胜者进程都
    // 按探针契约保持存活，故窗口内永不出现无胜者。
    const store = new StateStore(dir);
    const observed = new Set<string>();
    const pollDeadline = Date.now() + 120_000;
    const resultCount = (): number => {
      try {
        const t = readFileSync(resultFile, "utf-8").trim();
        return t === "" ? 0 : t.split("\n").length;
      } catch {
        return 0; // 尚无结果文件
      }
    };
    while (resultCount() < count && children.some((c) => c.exitCode === null)) {
      assert.ok(Date.now() < pollDeadline, "barrier：选举窗口超时（子进程未在预期时间内上报）");
      const w = store.leaseWinner(watchId, Date.now());
      assert.ok(w !== null, "选举窗口内任一时刻必须有恰 1 个存活胜者（实测无胜者）");
      observed.add(w.runId);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(observed.size, 1, `选举窗口内胜者必须恒定恰 1 个（实测 ${[...observed].join(",")}）`);
    // 等待全部子进程退出（齐集后胜者才会退出）
    await Promise.all(
      children.map((c) =>
        c.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => c.once("exit", () => resolve())),
      ),
    );
    // 全部子进程正常退出
    for (const c of children) {
      assert.strictEqual(c.exitCode, 0, `子进程异常退出：${errByChild.get(c)}`);
    }
    // 上报齐集：恰 1 个自认胜者，且全体认同同一胜者
    const results = readFileSync(resultFile, "utf-8").trim().split("\n").filter((l) => l !== "");
    assert.strictEqual(results.length, count, `全部子进程必须上报自认胜者（实测 ${results.length}/${count}）`);
    const selfWinners = results.filter((l) => l.split("|")[1] === l.split("|")[2]);
    assert.strictEqual(selfWinners.length, 1, `恰 1 个进程自认胜者（实测 ${selfWinners.length}）`);
    const agreedWinners = new Set(results.map((l) => l.split("|")[2]));
    assert.strictEqual(agreedWinners.size, 1, `全体必须认同同一胜者（实测 ${[...agreedWinners].join(",")}）`);
    const winnerRunId = selfWinners[0]!.split("|")[2]!;
    // 胜者 = 账本文件序首条 claim（确定性选举，所有读者结果一致）
    const ledger = store.readLedger(watchId).lines;
    const firstClaim = ledger.find((l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim");
    assert.ok(firstClaim !== undefined, "账本应有 claim 行");
    assert.strictEqual(firstClaim.runId, winnerRunId, "胜者必须是账本文件序首条 claim");
    // 全体退出后无存活胜者（胜者进程保持存活至全部上报完，随后退出）
    assert.strictEqual(store.leaseWinner(watchId, Date.now()), null, "全体退出后无存活胜者");
  }

  it("30 个真实子进程 barrier 选举：任一时刻恰 1 存活胜者（连续 5 轮查 flake）", async () => {
    for (let round = 1; round <= 5; round++) {
      await runBarrierRound(30);
    }
  });
});

function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid ?? 0));
  });
}
