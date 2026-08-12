/**
 * agent-guardian — V1.1 运行代际/租约/单例锁 + waitIdle unknown + 停止验证测试。
 *
 * 全部通过注入替身（脚本化 channel、假 target、假时钟），零 Orca 依赖。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/events.ts";
import { StateStore, initialState, LEASE_MS } from "../src/watcher/state.ts";
import type { WatchState, LedgerLine, LoadResult } from "../src/watcher/state.ts";
import { runWatch, STATE_LOAD_ERROR_EXIT_CODE } from "../src/watcher/loop.ts";
import type { WatchOptions, WatchServices } from "../src/watcher/loop.ts";
import type { Channel, ReadResult } from "../src/channels/types.ts";
import type { TargetAdapter, BeatFacts } from "../src/targets/types.ts";
import type { Signal } from "../src/shared/contract.ts";

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

class StubChannel implements Channel {
  kind: "file" | "orca" = "file";
  reads: Array<ReadResult | "dead"> = [];
  waitResults: Array<"idle" | "timeout" | "stale" | "unknown"> = [];
  sends: string[] = [];
  stops = 0;
  verifyResult: "verified" | "unverified" = "verified";
  private lastCursor = "0";

  async waitIdle(_handle: string, _timeoutMs: number): Promise<"idle" | "timeout" | "stale" | "unknown"> {
    return this.waitResults.shift() ?? "idle";
  }

  async read(): Promise<ReadResult> {
    const r = this.reads.shift();
    if (r === "dead") return { text: "", cursor: this.lastCursor, alive: false };
    if (r === undefined) return { text: "", cursor: this.lastCursor, alive: true };
    this.lastCursor = r.cursor;
    return r;
  }

  async send(_handle: string, text: string): Promise<void> {
    this.sends.push(text);
  }

  async stop(_handle: string): Promise<void> {
    this.stops++;
  }

  async verifyStopped(_handle: string, _opts?: unknown): Promise<"verified" | "unverified"> {
    return this.verifyResult;
  }
}

/** 一次性门闩：wait() 挂起直到 open()（测试在运行中途注入接管者用）。 */
class Gate {
  private readonly resolvers: Array<() => void> = [];

  wait(): Promise<void> {
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  open(): void {
    for (const resolve of this.resolvers.splice(0)) resolve();
  }
}

/** readLedger 在 arm() 后恒报 busy（模拟 Windows 读撞上并发追加写锁、瞬态重试耗尽）。 */
class BusyLedgerStore extends StateStore {
  private armed = false;

  arm(): void {
    this.armed = true;
  }

  readLedger(watchId: string): { lines: LedgerLine[]; torn: boolean; busy: boolean } {
    if (this.armed) return { lines: [], torn: false, busy: true };
    return super.readLedger(watchId);
  }
}

/** load 恒返回 {kind:"error"}（模拟状态文件读 EBUSY 瞬态重试耗尽等真错误，W5）。 */
class ErrorLoadStore extends StateStore {
  override async load(_watchId: string): Promise<LoadResult> {
    return { kind: "error", reason: "状态文件瞬态重试耗尽仍不可读（EBUSY）" };
  }
}

/** 首个 waitIdle 阻塞到 gate.open()（之后恒 idle）。 */
class GatedChannel extends StubChannel {
  private readonly gate: Gate;
  private gated = false;

  constructor(gate: Gate) {
    super();
    this.gate = gate;
  }

  async waitIdle(_handle: string, _timeoutMs: number): Promise<"idle" | "timeout" | "stale" | "unknown"> {
    if (!this.gated) {
      this.gated = true;
      await this.gate.wait();
    }
    return "idle";
  }
}

/** 轮询账本直到行数达标（防竞态：A 的 claim 已落账且首拍心跳已完成）。 */
async function waitForLedgerLines(store: StateStore, watchId: string, min: number): Promise<LedgerLine[]> {
  for (let i = 0; i < 500; i++) {
    const lines = store.readLedger(watchId).lines;
    if (lines.length >= min) return lines;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`账本行数未达 ${min}`);
}

/** load 并断言成功（W5：load 返回 ok/missing/error 可区分结果，形状专项断言见 state.test.ts）。 */
async function loadOk(store: StateStore, watchId: string): Promise<WatchState> {
  const loaded = await store.load(watchId);
  assert.strictEqual(loaded.kind, "ok", `load(${watchId}) 应为 ok（实测 ${JSON.stringify(loaded)}）`);
  return loaded.kind === "ok" ? loaded.state : (undefined as never);
}

/** 模拟新 owner B 接管：A 断链（迟到 renew，ts 远晚于其租约）+ B 的 claim。 */
function takeover(h: ReturnType<typeof harness>, aRunId: string): void {
  writeFileSync(
    join(h.dir, "state", "w-life.lock"),
    [
      JSON.stringify({ op: "renew", runId: aRunId, leaseExpiresAt: 9_999_999_999, ts: 9_999_999_999 }) + "\n",
      JSON.stringify({ op: "claim", runId: "run-b", ownerPid: process.pid, leaseExpiresAt: 9_999_999_999, ts: 2_000 }) + "\n",
    ].join(""),
    { flag: "a", encoding: "utf-8" },
  );
}

class StubTarget implements TargetAdapter {
  readonly kind: "pi" | "codex" | "terminal";
  calls = 0;
  private readonly signals: Signal[];

  constructor(signals: Signal[] = [], kind: "pi" | "codex" | "terminal" = "pi") {
    this.signals = signals;
    this.kind = kind;
  }

  async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    this.calls++;
    return {
      facts: {
        toolCallsSeen: this.calls,
        newToolCalls: 1,
        signals: this.signals,
        tailSummary: "tail",
        taskSummary: "任务",
      },
      cursor: cursor ?? "",
    };
  }
}

interface HarnessOptions {
  channel?: StubChannel;
  target?: StubTarget;
  budgetMs?: number;
}

function harness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ag-life-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  const channel = opts.channel ?? new StubChannel();
  const target = opts.target ?? new StubTarget();
  const events = new EventStore(join(dir, "events"));
  const state = new StateStore(join(dir, "state"));
  let clock = 0;
  const origWaitIdle = channel.waitIdle.bind(channel);
  channel.waitIdle = async (handle, timeoutMs) => {
    const r = await origWaitIdle(handle, timeoutMs);
    if (r === "timeout") clock += timeoutMs; // 超时等待真实消耗时间
    return r;
  };
  const services: WatchServices = {
    channel,
    target,
    state,
    events,
    reportsDir: join(dir, "reports"),
    llmConsult: null,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  const watchOpts: WatchOptions = {
    watchId: "w-life",
    handle: "h",
    budgetMs: opts.budgetMs ?? 1_000_000,
    remindMax: 5,
    sessionFile: "f.jsonl",
    runPanel: null,
  };
  return { services, watchOpts, channel, target, events, dir, clock: () => clock };
}

async function seed(h: ReturnType<typeof harness>, overrides: Partial<WatchState> = {}): Promise<void> {
  const s = initialState({
    watchId: "w-life",
    budgetMs: h.watchOpts.budgetMs,
    targetKind: "pi",
    channelKind: "file",
    handle: "h",
    sessionFile: "f.jsonl",
    now: 0,
  });
  // 默认模拟"崩溃残留"：属主已死 + 租约未过期
  s.ownerPid = await deadPid();
  s.leaseExpiresAt = 1_000_000_000;
  Object.assign(s, overrides);
  await h.services.state.save("w-life", s);
}

function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid ?? 0));
  });
}

function spinSignals(): Signal[] {
  return [{ kind: "spin", severity: 2, facts: { window: 8, threshold: 3, "repeat-count": 3, "repeat-key": "bash:h" } }];
}

// ---------------------------------------------------------------------------
// V1.1 启动裁决：新任务 / 崩溃恢复 / 单例拒绝
// ---------------------------------------------------------------------------

describe("V1.1 运行代际与租约", () => {
  it("无状态 → fresh 启动：generation=1、终态 finished、事件携带 runId/generation", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.denied, null);
    const loaded = await loadOk(h.services.state, "w-life");
    assert.ok(loaded.watchRunId.startsWith("run-"), "每次启动新生成 watchRunId");
    assert.strictEqual(loaded.generation, 1);
    assert.strictEqual(loaded.status, "finished", "正常收尾后终态 status=finished");
    assert.strictEqual(loaded.ownerPid, process.pid);
    const evs = h.services.events.read("w-life");
    const start = evs.find((e) => e.type === "watch_start");
    assert.ok(start !== undefined);
    assert.strictEqual(start["runId"], loaded.watchRunId, "事件携带本运行代 runId");
    assert.strictEqual(start["generation"], 1);
    for (const ev of evs) {
      assert.strictEqual(ev["runId"], loaded.watchRunId, "本运行全部事件携带同一 runId");
    }
    // 心跳续租：最后一次落盘的租约 = 收尾时刻 + LEASE_MS
    assert.strictEqual(loaded.leaseExpiresAt, h.clock() + LEASE_MS);
  });

  it("已有 finished 状态 → 默认视为新任务：不继承 startedAt/remindCount/safetyWarningSent", async () => {
    const h = harness({ budgetMs: 10_000 });
    await seed(h, {
      status: "finished",
      watchRunId: "run-old",
      generation: 7,
      settledBeats: 99,
      remindCount: 9,
      safetyWarningSent: true,
      startedAt: 5,
    });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_start"), "finished → 新任务（watch_start 而非 watch_resume）");
    assert.ok(!evs.some((e) => e.type === "watch_resume"));
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.startedAt, 0, "startedAt 不继承旧运行");
    assert.strictEqual(loaded.remindCount, 0, "remindCount 不继承");
    assert.strictEqual(loaded.safetyWarningSent, false, "safetyWarningSent 不继承");
    assert.ok(loaded.settledBeats < 99, "节拍计数不继承");
    assert.strictEqual(loaded.generation, 8, "代际 +1");
    assert.notStrictEqual(loaded.watchRunId, "run-old");
  });

  it("active + 未过期租约 + 属主已死 → 崩溃恢复：继承旧状态，generation+1、新 runId", async () => {
    const h = harness({ budgetMs: 10_000 });
    await seed(h, {
      status: "active",
      watchRunId: "run-old",
      generation: 3,
      settledBeats: 42,
      remindCount: 2,
    });
    h.channel.reads = [{ text: "a", cursor: "50", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_resume" && e.settledBeats === 42));
    assert.ok(!evs.some((e) => e.type === "watch_start"));
    const loaded = await loadOk(h.services.state, "w-life");
    assert.ok(loaded.settledBeats >= 42, "旧计数继承");
    assert.strictEqual(loaded.remindCount, 2, "旧 remindCount 继承");
    assert.strictEqual(loaded.generation, 4);
    assert.notStrictEqual(loaded.watchRunId, "run-old");
    assert.strictEqual(loaded.ownerPid, process.pid, "接管后属主为本次进程");
    assert.strictEqual(loaded.status, "finished");
  });

  it("active + 未过期租约 + 属主存活 → 拒绝启动（单例锁，退出码 3）", async () => {
    const h = harness();
    await seed(h, { status: "active", ownerPid: process.pid, leaseExpiresAt: 1_000_000_000 });
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 3);
    assert.ok(result.denied !== null && result.denied.includes("已有监督者正在运行"));
    assert.strictEqual(result.reportPath, null);
    assert.strictEqual(result.state, null);
    assert.strictEqual(h.target.calls, 0, "拒绝启动不得进入监督循环");
    assert.strictEqual(h.services.events.read("w-life").length, 0, "拒绝启动不写事件");
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.status, "active", "被拒时旧状态不得被改动");
    assert.strictEqual(loaded.ownerPid, process.pid);
  });

  it("active + 租约已过期 → 新任务（不恢复旧状态）", async () => {
    const h = harness({ budgetMs: 10_000 });
    await seed(h, { status: "active", generation: 2, settledBeats: 77, leaseExpiresAt: 0 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_start"), "租约过期 → fresh");
    const loaded = await loadOk(h.services.state, "w-life");
    assert.ok(loaded.settledBeats < 77, "不继承旧节拍");
    assert.strictEqual(loaded.generation, 3);
  });

  it("legacy 状态（无 watchRunId 等新字段）→ 新任务（安全侧，不继承）", async () => {
    const h = harness({ budgetMs: 10_000 });
    // 直接写旧格式状态文件（V1.1 之前的字段集）
    writeFileSync(
      join(h.dir, "state", "w-life.json"),
      JSON.stringify({
        watchId: "w-life",
        settledBeats: 55,
        cursor: "30",
        cooldownUntil: {},
        remindCount: 4,
        remindHistory: [],
        escalationCount: 0,
        llmCalls: 0,
        startedAt: 100,
        budgetMs: 120_000,
        safetyWarningSent: true,
        eventsDegraded: false,
        targetKind: "pi",
        channelKind: "file",
        handle: "f.jsonl",
        sessionFile: "f.jsonl",
        lastAction: null,
      }),
      "utf-8",
    );
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_start"), "legacy 状态视为新任务");
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.generation, 1);
    assert.strictEqual(loaded.remindCount, 0);
    assert.strictEqual(loaded.safetyWarningSent, false);
  });
});

// ---------------------------------------------------------------------------
// V1.2 租约账本单例：<watchId>.lock（append-only leader election）
// ---------------------------------------------------------------------------

describe("V1.2 租约账本单例", () => {
  it("同进程 Promise.all 双 runWatch → 恰一个 denied，另一个正常收尾", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const [r1, r2] = await Promise.all([
      runWatch(h.watchOpts, h.services),
      runWatch(h.watchOpts, h.services),
    ]);
    const denied = [r1, r2].filter((r) => r.exitCode === 3 && r.denied !== null);
    const ran = [r1, r2].filter((r) => r.exitCode === 0);
    assert.strictEqual(denied.length, 1, "同进程双跑恰一个被拒（单例）");
    assert.strictEqual(ran.length, 1, "恰一个正常运行");
    assert.ok(denied[0]!.denied!.includes("本进程"), "拒绝原因应说明进程内单例");
    assert.ok(existsSync(join(h.dir, "state", "w-life.lock")), "账本文件保留（append-only，不删除）");
    assert.strictEqual(h.services.state.leaseWinner("w-life", 0), null, "收尾 release 后账本无存活胜者");
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.status, "finished", "收尾终态 finished");
  });

  it("预置活 claim（未过期租约 + 存活 pid）→ 拒绝启动（exit 3），胜者不变", async () => {
    const h = harness();
    writeFileSync(
      join(h.dir, "state", "w-life.lock"),
      JSON.stringify({ op: "claim", runId: "run-other", ownerPid: process.pid, leaseExpiresAt: 1_000_000_000, ts: 0 }) + "\n",
      "utf-8",
    );
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 3);
    assert.ok(result.denied !== null && result.denied.includes("已有监督者正在运行"));
    assert.strictEqual(result.reportPath, null);
    assert.strictEqual(result.state, null);
    assert.strictEqual(h.target.calls, 0, "拒绝启动不得进入监督循环");
    assert.strictEqual(h.services.events.read("w-life").length, 0, "拒绝启动不写事件");
    assert.strictEqual(h.services.state.leaseWinner("w-life", 0)?.runId, "run-other", "活 claim 不得被后来的 claim 压过");
  });

  it("预置死 claim（过期租约 + 死 pid）→ 回收并正常启动（fresh）", async () => {
    const h = harness({ budgetMs: 10_000 });
    const dead = await deadPid();
    writeFileSync(
      join(h.dir, "state", "w-life.lock"),
      JSON.stringify({ op: "claim", runId: "run-stale", ownerPid: dead, leaseExpiresAt: 0, ts: 0 }) + "\n",
      "utf-8",
    );
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.denied, null);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_start"), "过期租约 → fresh 启动");
    assert.strictEqual(h.services.state.leaseWinner("w-life", 0), null, "收尾 release 后账本无存活胜者");
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.status, "finished");
  });

  it("预置死 claim（未过期租约 + 死 pid）+ 崩溃状态 → 回收并恢复（watch_resume，crash resume 语义不变）", async () => {
    const h = harness({ budgetMs: 10_000 });
    const dead = await deadPid();
    writeFileSync(
      join(h.dir, "state", "w-life.lock"),
      JSON.stringify({ op: "claim", runId: "run-crashed", ownerPid: dead, leaseExpiresAt: 1_000_000_000, ts: 0 }) + "\n",
      "utf-8",
    );
    await seed(h, { status: "active", watchRunId: "run-crashed", generation: 3, settledBeats: 42 });
    h.channel.reads = [{ text: "a", cursor: "50", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_resume" && e.settledBeats === 42), "崩溃恢复语义不变");
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.generation, 4, "接管后代际 +1");
    assert.strictEqual(h.services.state.leaseWinner("w-life", 0), null, "收尾 release 后账本无存活胜者");
  });
});

// ---------------------------------------------------------------------------
// W5 状态读取失败：中止启动（终审裁决）——不得降级继续覆写可能仍有效的旧状态
// ---------------------------------------------------------------------------

describe("W5 状态读取失败中止启动", () => {
  it("load error → 中止启动：错误退出码、无事件/无 state/无报告、账本零写入、不进入监督循环", async () => {
    const h = harness();
    // 与 F1 用例同口径：构造后替换 state 替身（load 恒返回 error，模拟 EBUSY 瞬态重试耗尽）
    h.services.state = new ErrorLoadStore(join(h.dir, "state"));
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, STATE_LOAD_ERROR_EXIT_CODE, "状态读取失败 → 错误退出码（可重试）");
    assert.strictEqual(result.state, null);
    assert.strictEqual(result.reportPath, null);
    assert.ok(
      result.denied !== null && result.denied.includes("EBUSY"),
      `denied 应含可读 reason（实测 ${result.denied}）`,
    );
    assert.strictEqual(h.target.calls, 0, "中止启动不得进入监督循环（无取证）");
    assert.deepStrictEqual(h.channel.sends, [], "不得向目标注入任何内容");
    assert.strictEqual(h.channel.stops, 0);
    const evs = h.services.events.read("w-life");
    assert.strictEqual(evs.length, 0, "不得追加任何事件（无 watch_start/state-load-failed/finish）");
    assert.ok(!existsSync(join(h.dir, "state", "w-life.json")), "不得写 state 文件（既有旧状态不被覆写）");
    assert.ok(!existsSync(join(h.dir, "reports", "w-life.md")), "不得写报告");
    const ledger = h.services.state.readLedger("w-life");
    assert.deepStrictEqual(ledger.lines, [], "中止发生在 claim 之前：账本零写入（无 claim 即无 release）");
  });

  it("load error 中止不触碰他人 claim：既有账本行保持原样", async () => {
    const h = harness();
    h.services.state = new ErrorLoadStore(join(h.dir, "state"));
    writeFileSync(
      join(h.dir, "state", "w-life.lock"),
      JSON.stringify({ op: "claim", runId: "run-prev", ownerPid: 999_999, leaseExpiresAt: 9_999_999_999, ts: 1_000 }) + "\n",
      "utf-8",
    );
    await runWatch(h.watchOpts, h.services);
    const ledger = h.services.state.readLedger("w-life");
    assert.strictEqual(ledger.lines.length, 1, "中止后账本不新增任何行");
    const claim = ledger.lines.find((l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim");
    assert.strictEqual(claim?.runId, "run-prev", "他人 claim 不得被撤销（release 只杀死自己的 runId）");
  });

  it("load missing（无状态文件）→ 正常 fresh 启动（与 error 明确区分：静默 fresh + watch_start）", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.denied, null);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "watch_start"), "missing → 正常 fresh（watch_start 事件）");
    assert.ok(existsSync(join(h.dir, "state", "w-life.json")), "正常落盘状态");
  });
});

// ---------------------------------------------------------------------------
// waitIdle unknown：按 stale 同等计数，不得当 idle 注入
// ---------------------------------------------------------------------------

describe("V1.1 waitIdle 未知形状", () => {
  it("连续 2 次 unknown → 按 stale 计数收尾退出，不向目标注入任何内容", async () => {
    const h = harness();
    h.channel.waitResults = ["unknown", "unknown"];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.target.calls, 0, "未知形状不得当 idle 取证/注入");
    assert.deepStrictEqual(h.channel.sends, [], "不得向忙碌 Agent 注入");
    assert.strictEqual(h.channel.stops, 0);
    const evs = h.services.events.read("w-life");
    assert.strictEqual(evs.filter((e) => e.type === "target-unreachable").length, 2, "unknown 与 stale 同等计数");
    assert.ok(evs.some((e) => e.type === "target-gone"));
    assert.ok(evs.some((e) => e.type === "finish"));
  });

  it("unknown 与 stale 混合累计：各 1 次 → 2 次即收尾", async () => {
    const h = harness();
    h.channel.waitResults = ["unknown", "stale"];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.strictEqual(evs.filter((e) => e.type === "target-unreachable").length, 2);
    assert.ok(evs.some((e) => e.type === "finish" && e.reason === "目标连续不可达"));
  });
});

// ---------------------------------------------------------------------------
// 停止验证：stop-verified / stop-unverified
// ---------------------------------------------------------------------------

describe("V1.1 停止验证", () => {
  function stopScenario(verifyResult: "verified" | "unverified"): ReturnType<typeof harness> {
    const h = harness({ budgetMs: 10_000, target: new StubTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.verifyResult = verifyResult;
    h.channel.waitResults = ["timeout", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
    ];
    return h;
  }

  it("verifyStopped=verified → 记录 stop-verified", async () => {
    const h = stopScenario("verified");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(evs.some((e) => e.type === "stop-verified"));
    assert.ok(!evs.some((e) => e.type === "stop-unverified"));
    assert.ok(!evs.some((e) => e.type === "stop-unsupported"));
  });

  it("verifyStopped=unverified → 记录 stop-unverified（不静默当已停）", async () => {
    const h = stopScenario("unverified");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-life");
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(evs.some((e) => e.type === "stop-unverified"));
    assert.ok(!evs.some((e) => e.type === "stop-verified"));
  });
});

// ---------------------------------------------------------------------------
// F1 fencing：先续租后落盘 / 收尾归属校验（丢锁不写状态、不追加事件）
// ---------------------------------------------------------------------------

describe("V1.2.1 F1 fencing（丢锁进程不得覆盖新 owner）", () => {
  it("心跳续租丢锁 → 不覆写 state、events 无追加、走 lockLost", async () => {
    const gate = new Gate();
    const channel = new GatedChannel(gate);
    channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const h = harness({ budgetMs: 10_000, channel });
    const runPromise = runWatch(h.watchOpts, h.services);
    // A 完成 claim + 首拍心跳（账本 = claim + renew）并阻塞在 waitIdle
    const lines = await waitForLedgerLines(h.services.state, "w-life", 2);
    const aRunId = lines[0]!.runId;
    takeover(h, aRunId);
    const eventsBefore = h.services.events.read("w-life").length;
    gate.open();
    const result = await runPromise;
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.denied, null);
    assert.strictEqual(result.reportPath, null);
    // state 未被覆写：仍是首拍落盘内容（settledBeats=0、cursor=""、status=active）
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.settledBeats, 0, "丢锁拍不得 save（否则 settledBeats=1）");
    assert.strictEqual(loaded.cursor, "", "丢锁拍不得 save（否则 cursor=10）");
    assert.strictEqual(loaded.status, "active");
    // events 无追加：无 lock-lost 事件，数量与接管时一致
    const evs = h.services.events.read("w-life");
    assert.strictEqual(evs.length, eventsBefore, "丢锁后不得向共享 events 追加");
    assert.ok(!evs.some((e) => e.type === "lock-lost"), "lockLost 信息只写 stderr，不进事件流");
    // 账本：新 owner B 仍为胜者
    assert.strictEqual(h.services.state.leaseWinner("w-life", 0)?.runId, "run-b", "新 owner B 不受影响");
  });

  it("心跳续租账本 busy（瞬态重试耗尽）→ renewLock false → 不写 state、走 lockLost（保守丢锁）", async () => {
    const gate = new Gate();
    const channel = new GatedChannel(gate);
    channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const h = harness({ budgetMs: 10_000, channel });
    const busyStore = new BusyLedgerStore(join(h.dir, "state"));
    h.services.state = busyStore;
    const runPromise = runWatch(h.watchOpts, h.services);
    // A 完成 claim + 首拍心跳（账本 = claim + renew）并阻塞在 waitIdle
    const lines = await waitForLedgerLines(busyStore, "w-life", 2);
    const aRunId = lines[0]!.runId;
    busyStore.arm(); // 此后账本恒 busy：renewLock 无法验证归属 → 保守丢锁（宁可误停不可破栅栏）
    const eventsBefore = h.services.events.read("w-life").length;
    gate.open();
    const result = await runPromise;
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.reportPath, null);
    // state 未被覆写：仍是首拍落盘内容（settledBeats=0、cursor=""、status=active）
    const loaded = await loadOk(busyStore, "w-life");
    assert.strictEqual(loaded.settledBeats, 0, "busy 丢锁拍不得 save（否则 settledBeats=1）");
    assert.strictEqual(loaded.cursor, "", "busy 丢锁拍不得 save（否则 cursor=10）");
    assert.strictEqual(loaded.status, "active");
    // events 无追加：无 lock-lost 事件，数量与 arm 时一致
    const evs = h.services.events.read("w-life");
    assert.strictEqual(evs.length, eventsBefore, "丢锁后不得向共享 events 追加");
    assert.ok(!evs.some((e) => e.type === "lock-lost"), "lockLost 信息只写 stderr，不进事件流");
    // 自己的 claim/renew 仍在账本（无人接管，只是读不可用导致保守丢锁）
    const ledgerLines = busyStore.readLedger("w-life");
    assert.strictEqual(ledgerLines.busy, true);
    assert.strictEqual(aRunId, lines[0]!.runId);
  });

  it("收尾时丢锁 → save 前校验拦截：仅一行冗余 finish 事件、无报告、仅追加自己的 release 行（W4）", async () => {
    const gate = new Gate();
    const channel = new GatedChannel(gate);
    channel.reads = [{ text: "", cursor: "10", alive: true, closed: true }];
    const h = harness({ budgetMs: 10_000, channel });
    const runPromise = runWatch(h.watchOpts, h.services);
    const lines = await waitForLedgerLines(h.services.state, "w-life", 2);
    const aRunId = lines[0]!.runId;
    takeover(h, aRunId);
    gate.open();
    const result = await runPromise;
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.reportPath, null, "丢锁收尾不写报告");
    // 跳过 save：状态仍为首拍内容（status 仍是 active，无 finished 终态）
    const loaded = await loadOk(h.services.state, "w-life");
    assert.strictEqual(loaded.status, "active", "丢锁收尾不得写 status=finished");
    assert.strictEqual(loaded.settledBeats, 0);
    // W4：事件追加先行可保留——恰一行冗余 finish 事件（自愈，可接受）
    const evs = h.services.events.read("w-life");
    assert.strictEqual(evs.filter((e) => e.type === "finish").length, 1, "恰一行冗余 finish 事件（W4 声明内）");
    assert.deepStrictEqual(
      evs.map((e) => e.type),
      ["watch_start", "target-closed", "finish"],
    );
    // 仅追加 release 行（自己的 runId）
    const ledger = h.services.state.readLedger("w-life").lines;
    assert.ok(ledger.some((l) => l.op === "release" && l.runId === aRunId), "丢锁收尾仍须追加自己的 release 行");
    // 新 owner B 仍为胜者
    assert.strictEqual(h.services.state.leaseWinner("w-life", 0)?.runId, "run-b");
  });
});
