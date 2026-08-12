/**
 * agent-guardian — watcher 循环测试：游标纪律 / 生命周期退出 / 纯观察语义。
 *
 * 全部通过注入替身（脚本化 channel、假 target、假 LLM、假时钟），零 Orca 依赖。
 * 假时钟：waitIdle 超时与 sleep 都会推进时钟，保证循环必然到达收尾路径。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/events.ts";
import { StateStore, initialState } from "../src/watcher/state.ts";
import type { WatchState, LedgerLine } from "../src/watcher/state.ts";
import { runWatch, MAX_CONSECUTIVE_FACTS_ERRORS } from "../src/watcher/loop.ts";
import type { WatchOptions, WatchServices } from "../src/watcher/loop.ts";
import type { Channel, ReadResult } from "../src/channels/types.ts";
import type { TargetAdapter, BeatFacts } from "../src/targets/types.ts";
import type { Signal } from "../src/shared/contract.ts";
import type { LlmResult, EvidencePack } from "../src/watcher/llm.ts";
import { signalKey } from "../src/watcher/decide.ts";
import { generateReport } from "../src/watcher/report.ts";

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

class ScriptedChannel implements Channel {
  kind: "file" | "orca" = "file";
  reads: Array<ReadResult | "dead" | "closed"> = [];
  sends: string[] = [];
  stops = 0;
  waitResults: Array<"idle" | "timeout" | "stale"> = [];
  readCalls = 0;
  private lastCursor = "0";

  async waitIdle(_handle: string, _timeoutMs: number): Promise<"idle" | "timeout" | "stale"> {
    return this.waitResults.shift() ?? "idle";
  }

  async read(): Promise<ReadResult> {
    this.readCalls++;
    const r = this.reads.shift();
    if (r === "dead") return { text: "", cursor: this.lastCursor, alive: false };
    if (r === "closed") return { text: "", cursor: this.lastCursor, alive: false, closed: true };
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

  /** V1.1 停止验证替身：默认立即判定已停（不轮询）。 */
  async verifyStopped(_handle: string, _opts?: import("../src/channels/types.ts").StopVerifyOptions): Promise<"verified" | "unverified"> {
    return "verified";
  }
}

/** read 永远抛异常的通道（B1 探针场景：100ms 内反复 read 失败必须 ≤2 次即收尾）。 */
class DeadReadChannel extends ScriptedChannel {
  override async read(): Promise<ReadResult> {
    throw new Error("read 探针失败（测试注入）");
  }
}

/** 纯观察通道：send/stop 抛错（模拟 file 通道） */
class ObservingChannel extends ScriptedChannel {
  override kind = "file" as const;

  override async send(): Promise<void> {
    throw new Error("send 在纯观察通道不可用");
  }

  override async stop(): Promise<void> {
    throw new Error("stop 在纯观察通道不可用");
  }

  override async verifyStopped(): Promise<"verified" | "unverified"> {
    throw new Error("stop 验证在纯观察通道不可用");
  }
}

class SpyTarget implements TargetAdapter {
  readonly kind: "pi" | "codex" | "terminal";
  calls = 0;
  lastCursor: string | null = null;
  /** 每次取证收到的检查点游标（上次已消费位置） */
  readonly cursors: Array<string | null> = [];
  private readonly signals: Signal[];
  /** V2a L4 传感替身：最近命令文本 */
  recentCommands: string[] = [];
  /** newToolCalls 脚本（缺省：首拍 1，其后 0；V2a 暂停复工语义测试用） */
  newToolCallsScript: ((call: number) => number) | null = null;

  constructor(signals: Signal[] = [], kind: "pi" | "codex" | "terminal" = "pi") {
    this.signals = signals;
    this.kind = kind;
  }

  async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    this.calls++;
    this.lastCursor = cursor;
    this.cursors.push(cursor);
    return {
      facts: {
        toolCallsSeen: this.calls,
        newToolCalls: this.newToolCallsScript !== null ? this.newToolCallsScript(this.calls) : (this.calls === 1 ? 1 : 0),
        signals: this.signals,
        recentCommands: [...this.recentCommands],
        tailSummary: "tail",
        taskSummary: "任务",
      },
      cursor: cursor ?? "",
    };
  }
}

/** 前 failTimes 次取证抛错（模拟取证异常）。 */
class FlakyTarget extends SpyTarget {
  private readonly failTimes: number;

  constructor(failTimes: number, signals: Signal[] = [], kind: "pi" | "codex" | "terminal" = "pi") {
    super(signals, kind);
    this.failTimes = failTimes;
  }

  override async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    if (this.calls < this.failTimes) {
      this.calls++;
      this.cursors.push(cursor); // 失败调用也记录（抛在 super 之前）
      throw new Error("取证异常（测试注入）");
    }
    return super.resolveFacts(cursor); // super 会记录 cursors
  }
}

/** 永久抛错的取证适配器（B2 探针：持续取证失败不得无限重试）。 */
class BrokenTarget extends SpyTarget {
  override async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    this.calls++;
    this.cursors.push(cursor);
    throw new Error("取证永久失败（测试注入）");
  }
}

/** 取证恒无新增调用（M2：无改善场景的探针判定）。 */
class NoNewToolCallsTarget extends SpyTarget {
  override async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    const r = await super.resolveFacts(cursor);
    r.facts.newToolCalls = 0;
    return r;
  }
}

/** 仅首拍返回信号，之后信号消失（M1 目标改善场景）。 */
class FirstBeatSignalTarget extends SpyTarget {
  private first = true;

  override async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    const r = await super.resolveFacts(cursor);
    if (this.first) {
      this.first = false;
    } else {
      r.facts.signals = [];
    }
    return r;
  }
}

/** LIVE-1 真实改善：警告后触发信号消失且自警告起 newToolCalls>0（干活证据）。 */
class GenuineImprovementTarget extends SpyTarget {
  override async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    const r = await super.resolveFacts(cursor);
    if (this.calls === 2) {
      r.facts.signals = [];
      r.facts.newToolCalls = 1;
    }
    return r;
  }
}

/** 残差 blocker：首拍触发警告，次拍真实改善（信号消失+干活证据），此后 cursor-only beats。 */
class ImproveThenCursorOnlyTarget extends SpyTarget {
  override async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    const r = await super.resolveFacts(cursor);
    if (this.calls === 1) return r; // 首拍：信号在身（触发警告）
    r.facts.signals = []; // 次拍起触发信号消失
    if (this.calls === 2) r.facts.newToolCalls = 1; // 次拍：真实改善（干活证据）
    return r;
  }
}

interface HarnessOptions {
  channel?: ScriptedChannel;
  target?: SpyTarget;
  budgetMs?: number;
  llm?: (evidence: EvidencePack) => Promise<LlmResult>;
  runPanel?: (question: string) => Promise<string | null>;
}

function harness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ag-loop-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  const channel = opts.channel ?? new ScriptedChannel();
  const target = opts.target ?? new SpyTarget();
  const events = new EventStore(join(dir, "events"));
  const state = new StateStore(join(dir, "state"));
  const sleeps: number[] = [];
  let clock = 0;
  const waitCalls = { n: 0 };
  const origWaitIdle = channel.waitIdle.bind(channel);
  channel.waitIdle = async (handle, timeoutMs) => {
    waitCalls.n++;
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
    llmConsult: opts.llm ?? null,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  const watchOpts: WatchOptions = {
    watchId: "w-test",
    handle: "h",
    budgetMs: opts.budgetMs ?? 1_000_000,
    remindMax: 5,
    sessionFile: "f.jsonl",
    workspaceRoot: "/workspace", // V2a：L4 硬边界判定的工作区根目录（测试固定）
    runPanel: opts.runPanel ?? null,
  };
  return { services, watchOpts, channel, target, sleeps, dir, clock: () => clock, waitCalls };
}

function spinSignals(): Signal[] {
  return [{ kind: "spin", severity: 2, facts: { window: 8, threshold: 3, "repeat-count": 3, "repeat-key": "bash:h" } }];
}

/**
 * 取 w-test 状态；空目录（尚无状态文件）时先落盘初始状态再返回。
 * 状态机语义：load 对缺失文件返回 null（=首次运行），测试要预置状态必须先建。
 * V1.1：预置状态模拟"崩溃后残留"——属主进程必须是已死 pid（否则启动裁决
 * 视为单例占用而拒绝启动），租约未过期（否则视为新任务不继承）。
 */
async function seedState(h: ReturnType<typeof harness>): Promise<WatchState> {
  const loaded = await h.services.state.load("w-test");
  if (loaded.kind === "ok") return loaded.state;
  const fresh = initialState({
    watchId: "w-test",
    budgetMs: h.watchOpts.budgetMs,
    targetKind: "pi",
    channelKind: "file",
    handle: "h",
    sessionFile: "f.jsonl",
    now: 0,
  });
  // 模拟崩溃残留：属主已死（进程退出后 pid 失效）+ 租约未过期
  fresh.ownerPid = await deadPid();
  fresh.leaseExpiresAt = 1_000_000_000;
  await h.services.state.save("w-test", fresh);
  return fresh;
}

/** 已退出子进程的 pid（进程级"已死"证据；pid 复用在此窗口内可忽略）。 */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid ?? 0));
  });
}

/** load 并断言成功（W5：load 返回 ok/missing/error 可区分结果，形状专项断言见 state.test.ts）。 */
async function loadOk(store: StateStore, watchId: string): Promise<WatchState> {
  const loaded = await store.load(watchId);
  assert.strictEqual(loaded.kind, "ok", `load(${watchId}) 应为 ok（实测 ${JSON.stringify(loaded)}）`);
  return loaded.kind === "ok" ? loaded.state : (undefined as never);
}

// ---------------------------------------------------------------------------
// 游标纪律
// ---------------------------------------------------------------------------

describe("游标纪律", () => {
  it("游标不前进 → 不取证，sleep 60s 进下一拍", async () => {
    const h = harness({ budgetMs: 120_000 });
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.target.calls, 1); // 只取证一次
    assert.ok(h.sleeps.includes(60_000)); // 无进展拍 sleep 60s
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "budget-expired"));
  });

  it("游标前进才取证，取证带上次检查点游标", async () => {
    const h = harness();
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
    ];
    await runWatch(h.watchOpts, h.services);
    assert.strictEqual(h.target.calls, 2);
    // 取证收到的是上次已消费的检查点（初始 ""，第一拍后 "10"），成功后状态游标推进到通道游标
    assert.deepStrictEqual(h.target.cursors, ["", "10"]);
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.cursor, "20");
  });
});

// ---------------------------------------------------------------------------
// 生命周期退出
// ---------------------------------------------------------------------------

describe("生命周期退出路径", () => {
  it("连续 2 次不可达（waitIdle stale）→ 写汇报退出 0", async () => {
    const h = harness();
    h.channel.waitResults = ["stale", "stale"];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.reportPath !== null && existsSync(result.reportPath));
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "target-gone"));
    assert.ok(evs.some((e) => e.type === "finish"));
  });

  it("read 连续 2 次不可用 → 退出 0", async () => {
    const h = harness();
    h.channel.reads = ["dead", "dead"];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(h.services.events.read("w-test").some((e) => e.type === "target-unreachable"));
  });

  it("connected:false（closed）→ 当拍写完工汇报退出，不等第二次（B1）", async () => {
    const h = harness();
    h.channel.kind = "orca";
    h.channel.reads = ["closed"];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // 当拍退出：只消费一次 read，不取证，不等第二次
    assert.strictEqual(h.channel.reads.length, 0);
    assert.strictEqual(h.target.calls, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "target-closed"));
    assert.ok(evs.some((e) => e.type === "finish"));
    assert.ok(result.reportPath !== null && existsSync(result.reportPath));
  });

  it("预算到期且目标静止 → 直接收尾退出 0（不再警告/停止）", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "budget-expired"));
    assert.ok(!h.channel.sends.some((s) => s.includes("警告")));
    assert.strictEqual(h.channel.stops, 0);
  });
});

// ---------------------------------------------------------------------------
// 安全网 / 停止 / 纯观察 / panel 链路
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// V2a：干预语义重排（L1 提醒 → L2 警告需回应 → 暂停待命）与 L4 唯一停止路径
// ---------------------------------------------------------------------------

describe("V2a 干预语义重排", () => {
  /** 预置：同 incident（kind+factsHash）已提醒 2 次 → 本次复现到 L2 警告/LLM 回调点。 */
  async function seedEscalated(h: ReturnType<typeof harness>, extra: Partial<WatchState> = {}): Promise<void> {
    const state = await seedState(h);
    state.remindCount = 1;
    const key = signalKey(spinSignals()[0]!);
    state.remindHistory = [
      { kind: "spin", beat: 0, factsHash: key },
      { kind: "spin", beat: 5, factsHash: key },
    ];
    Object.assign(state, extra);
    await h.services.state.save("w-test", state);
  }

  it("提醒复现 → L2 警告（steer 需回应）；信号复现 → 暂停待命 + 升级事件；无任何 stop", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → L2 警告
      { text: "b", cursor: "20", alive: true }, // 拍2：信号复现（无 ACK）→ 暂停待命 + 升级事件
      { text: "c", cursor: "30", alive: true }, // 拍3：暂停中 → 沉默
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "V2a：无 L4 硬边界任何情况不 stop");
    assert.ok(h.channel.sends.some((s) => s.includes("监督警告") && s.includes("需要你的回应确认")), "L2 警告文案需回应");
    assert.ok(h.channel.sends.some((s) => s.includes("监督暂停")), "升级为暂停待命");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide" && e.action === "warning" && e.ackRequired === true), "警告事件需 ACK");
    assert.ok(evs.some((e) => e.type === "escalated" && e.to === "pause" && e.pinned === true), "升级事件置顶标记");
    assert.ok(!evs.some((e) => e.type === "stop"), "不得产生 stop");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.paused, true, "暂停闩锁持久化");
    assert.strictEqual(loaded?.warningSent, false, "升级为暂停后警告闩锁清除");
  });

  it("L2 警告确认：触发信号消失且 newToolCalls>0 → warning-acked 清闩，不暂停不停止", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new GenuineImprovementTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → L2 警告
      { text: "b", cursor: "20", alive: true }, // 拍2：信号消失 + newToolCalls>0 → 确认
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0);
    assert.ok(h.channel.sends.some((s) => s.includes("监督警告")), "拍1发警告");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "warning-acked"), "警告确认事件");
    assert.ok(!evs.some((e) => e.type === "escalated"), "确认后不得升级");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.warningSent, false, "确认后闩锁清除并持久化");
    assert.strictEqual(loaded?.warningTrigger, null);
  });

  it("警告后信号消失但无干活证据 → 沉默等待（warning-pending），不 stop、不重复干预", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new FirstBeatSignalTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → L2 警告
      { text: "b", cursor: "20", alive: true }, // 拍2：信号消失但 newToolCalls=0 → 等待
      { text: "c", cursor: "30", alive: true }, // 拍3：持续等待（不得重复警告/暂停）
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0);
    assert.strictEqual(h.channel.sends.filter((s) => s.includes("监督警告")).length, 1, "不得重复警告");
    assert.strictEqual(h.channel.sends.filter((s) => s.includes("监督暂停")).length, 0, "无信号复现不得暂停");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.warningSent, true, "无干活证据时闩锁保持");
    assert.strictEqual(loaded?.paused, false);
  });

  it("暂停待命语义：目标回应（游标前进，无新工具调用）不视为复工；新工具调用 → resumed（V2a）", async () => {
    const target = new SpyTarget(spinSignals());
    // call1 触发链起点；call2 复现 → 警告；call3 复现 → 暂停；call4-5 目标仅回应文本
    // （游标前进、无新工具调用）→ 不复工；call6 新工具调用 → 复工
    target.newToolCallsScript = (call) => (call === 1 || call === 6 ? 1 : 0);
    const h = harness({ budgetMs: 1_000_000, target });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → L2 警告
      { text: "b", cursor: "20", alive: true }, // 拍2：复现 → 暂停
      { text: "c", cursor: "30", alive: true }, // 拍3：回应但无工具调用 → 不复工
      { text: "d", cursor: "40", alive: true }, // 拍4：仍无工具调用 → 不复工
      { text: "e", cursor: "50", alive: true }, // 拍5：回应但无工具调用 → 不复工
      { text: "f", cursor: "60", alive: true }, // 拍6：新工具调用 → 复工
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "resumed"), "复工事件");
    assert.ok(evs.filter((e) => e.type === "steer" && e.action === "pause").length === 1, "只暂停一次，不重复干预");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.paused, false, "复工后清闩");
  });

  it("崩溃恢复：warningSent 持久化 → 恢复后同游标 → 取证判复现 → 暂停待命（不再 stop）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true }, // 恢复：同游标 + warningSent → 取证 → 信号复现 → 暂停
      "dead",
      "dead",
    ];
    const state = await seedState(h);
    state.cursor = "10";
    state.warningSent = true;
    state.warningTrigger = "spin";
    state.lastAction = "warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "恢复后不得 stop");
    assert.strictEqual(h.target.calls, 1, "闩锁在身 → 同游标也取证一次");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "watch_resume"));
    assert.ok(evs.some((e) => e.type === "escalated" && e.to === "pause"), "复现 → 暂停升级");
    assert.ok(evs.some((e) => e.type === "steer" && e.action === "pause"));
    assert.ok(!evs.some((e) => e.type === "stop"));
  });

  it("空游标恢复 + warningSent → 取证判复现 → 暂停（不再 stop）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "", alive: true }, // 空游标 + 警告在身 → 取证 → 复现 → 暂停
      "dead",
      "dead",
    ];
    const state = await seedState(h);
    state.cursor = "";
    state.warningSent = true;
    state.warningTrigger = "spin";
    state.lastAction = "warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0);
    assert.strictEqual(h.target.calls, 1, "闩锁在身 → 空游标也取证");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "escalated" && e.to === "pause"));
    assert.ok(!evs.some((e) => e.type === "stop"));
  });

  it("取证持续失败（warning 在身）→ 连续上限后 degraded 收尾，不 stop（V2a）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new BrokenTarget() });
    h.channel.kind = "orca";
    h.channel.reads = [{ text: "", cursor: "10", alive: true }];
    const state = await seedState(h);
    state.cursor = "10";
    state.warningSent = true;
    state.warningTrigger = "spin";
    state.lastAction = "warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "取证失败不再触发 stop（stop 仅剩 L4）");
    const evs = h.services.events.read("w-test");
    assert.strictEqual(evs.filter((e) => e.type === "facts-error").length, MAX_CONSECUTIVE_FACTS_ERRORS);
    assert.ok(evs.some((e) => e.type === "facts-error-exhausted"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("连续取证失败超上限")));
  });

  it("预算到期（busy + 无新输出）→ 监督者直接收尾退出：无警告、无停止（V2a 删除预算安全网）", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout", "timeout"];
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.sends.length, 0, "预算到期不得发任何警告");
    assert.strictEqual(h.channel.stops, 0, "预算到期不得停止目标");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "budget-expired"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("监督预算到期")));
    assert.ok(!evs.some((e) => e.type === "decide" && e.action === "warning"), "预算到期不进决策树");
  });

  it("纯观察（file 通道）：提醒/警告/暂停只记录事件，不发送任何消息", async () => {
    const h = harness({
      budgetMs: 100_000,
      target: new SpyTarget(spinSignals()),
      channel: new ObservingChannel(),
    });
    h.channel.waitResults = ["idle", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：预算未到 → 机械提醒（只记录）
      { text: "b", cursor: "20", alive: true }, // 拍2：wait 超时推进时钟 → 预算到期 → 收尾退出
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "steer-unsupported" && e.action === "remind"));
    assert.ok(evs.some((e) => e.type === "budget-expired"), "纯观察模式预算到期同样只退出");
    assert.strictEqual(h.channel.sends.length, 0);
    assert.strictEqual(h.channel.stops, 0);
  });

  it("L4 硬边界命中 → 唯一 stop 路径：stop-issued + 升级事件置顶（V2a）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget([]) });
    h.channel.kind = "orca";
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    h.target.recentCommands = ["rm -rf /tmp/outside-data"]; // 工作区（/workspace）外删除
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "L4 命中 → stop");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "escalated" && e.to === "stop" && e.pinned === true), "升级事件置顶标记");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(evs.some((e) => e.type === "stop-verified"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("L4")));
  });

  it("L4 无命中（工作区内删除）→ 不 stop，走正常干预链", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
      "dead",
      "dead",
    ];
    h.target.recentCommands = ["rm -rf /workspace/proj/node_modules"];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "工作区内删除不是硬边界");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide" && e.action === "warning"), "正常走 L2 警告链");
    assert.ok(!evs.some((e) => e.type === "stop"));
  });

  it("LLM 返回 panel → 暂停引导 → 执行讨论组 → 复工引导", async () => {
    const h = harness({
      target: new SpyTarget(spinSignals()),
      llm: async () => ({
        decision: { action: "panel", question: "方向问题", reason: "llm-panel" },
        note: "ok",
        detail: null,
      }),
      runPanel: async (q) => `结论：方向 A（成员 2/3 完成，问题：${q}）`,
    });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "llm_call" && e.decision === "panel"));
    assert.ok(evs.some((e) => e.type === "steer" && e.action === "pause"));
    assert.ok(evs.some((e) => e.type === "steer" && e.action === "resume"));
    assert.ok(h.channel.sends.some((s) => s.includes("方向问题")));
    assert.ok(h.channel.sends.some((s) => s.includes("讨论组结论")));
  });

  it("LLM 非法输出 → silence 并记录（不执行任何动作）", async () => {
    const h = harness({
      target: new SpyTarget(spinSignals()),
      llm: async () => ({
        decision: { action: "silence", reason: "llm-invalid: 输出不是合法 JSON" },
        note: "invalid",
        detail: "输出不是合法 JSON",
      }),
    });
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "llm_call" && e.note === "invalid"));
    assert.strictEqual(h.channel.sends.length, 0);
  });
});
describe("事件与状态落盘", () => {
  it("watch_start 事件、状态文件与汇报写入", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    await runWatch(h.watchOpts, h.services);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "watch_start"));
    assert.ok(evs.some((e) => e.type === "finish"));
    assert.ok(existsSync(join(h.dir, "state", "w-test.json")));
    assert.ok(existsSync(join(h.dir, "reports", "w-test.md")));
    const report = await import("node:fs").then((fs) => fs.readFileSync(join(h.dir, "reports", "w-test.md"), "utf-8"));
    assert.ok(report.includes("监督汇报 w-test"));
  });

  it("V2a 任务契约流入：watchOpts.contract → 状态持久化 → 汇报头部", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    h.watchOpts.contract = {
      requirement: "实现 V2a 干预语义重排",
      acceptance: ["预算到期监督者自己退出"],
      scope: ["src/watcher"],
      approvedDecisions: [],
    };
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.contract?.requirement, "实现 V2a 干预语义重排", "契约随状态持久化");
    const report = await import("node:fs").then((fs) => fs.readFileSync(result.reportPath!, "utf-8"));
    assert.ok(report.includes("## 任务契约"), "契约进汇报头部");
    assert.ok(report.includes("预算到期监督者自己退出"), "验收标准进汇报");
  });

  it("崩溃恢复续跑：已有状态时从上次拍数继续", async () => {
    const h = harness({ budgetMs: 10_000 });
    const pre = await seedState(h);
    pre.settledBeats = 42;
    pre.cursor = "42";
    await h.services.state.save("w-test", pre);
    h.channel.reads = [{ text: "a", cursor: "50", alive: true }];
    await runWatch(h.watchOpts, h.services);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "watch_resume" && e.settledBeats === 42));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.ok(loaded.settledBeats >= 42);
    assert.strictEqual(loaded.cursor, "50");
  });
});

// ---------------------------------------------------------------------------
// 取证异常 / LLM 回调异常 / 汇报口径（M3、B2、M5）
// ---------------------------------------------------------------------------

describe("取证与回调异常降级", () => {
  it("取证失败 → 本拍游标不变、落 facts-error，下拍重试（M3）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new FlakyTarget(1, [], "terminal") });
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
      "dead",
      "dead",
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // 失败那拍游标不变（仍 ""），下拍用同一检查点重试；成功后状态游标推进到通道游标 "20"
    assert.deepStrictEqual(h.target.cursors, ["", ""]);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "facts-error"));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.cursor, "20");
  });

  it("永久取证异常 + 预算到期 → 预算收尾退出（V2a：预算到期只退出，不动目标）", async () => {
    const h = harness({ budgetMs: 10_000, target: new BrokenTarget() });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "facts-error"), "取证失败已记录");
    const finishEv = evs.find((e) => e.type === "finish");
    assert.ok(finishEv !== undefined && String(finishEv["reason"]).includes("监督预算到期"), "收尾原因 = 预算到期退出");
    assert.ok(result.reportPath !== null && existsSync(result.reportPath), "应写完工汇报");
  });

  it("永久取证异常（预算未到期）→ 连续 10 次失败后汇报退出，不无限重试（B2）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new BrokenTarget() });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.target.calls, MAX_CONSECUTIVE_FACTS_ERRORS, "连续取证失败应在上限次数时收尾，不得无限重试");
    const evs = h.services.events.read("w-test");
    assert.strictEqual(evs.filter((e) => e.type === "facts-error").length, MAX_CONSECUTIVE_FACTS_ERRORS);
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("连续取证失败超上限")));
    assert.ok(result.reportPath !== null && existsSync(result.reportPath));
  });

  it("LLM 回调抛异常 → 降级 silence + llm_call invalid 事件，watcher 继续不崩溃（B2）", async () => {
    const h = harness({
      target: new SpyTarget(spinSignals()),
      llm: async () => {
        throw new Error("回调进程爆炸");
      },
    });
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    const key = signalKey(spinSignals()[0]!);
    state.remindHistory = [
      { kind: "spin", beat: 0, factsHash: key },
      { kind: "spin", beat: 5, factsHash: key },
    ];
    await h.services.state.save("w-test", state);

    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0); // 不崩溃，正常走收尾退出
    const evs = h.services.events.read("w-test");
    const call = evs.find((e) => e.type === "llm_call");
    assert.ok(call !== undefined, "应记录 llm_call 事件");
    assert.strictEqual(call["note"], "invalid");
    assert.strictEqual(call["decision"], "silence");
    assert.strictEqual(h.channel.sends.length, 0); // 降级为沉默，不执行任何动作
  });

  it("汇报含实际收尾原因：finish 事件先于报告生成（M5）", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    const report = (await import("node:fs")).readFileSync(result.reportPath!, "utf-8");
    assert.ok(report.includes("监督预算到期"), "报告应显示实际收尾原因");
    assert.ok(!report.includes("未记录收尾事件"), "报告不得误显未记录收尾事件");
  });

  it("汇报信号统计与 decide 事件 signals 字段对齐（M5）", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    const report = (await import("node:fs")).readFileSync(result.reportPath!, "utf-8");
    assert.ok(report.includes("原地重复：1 次"), "报告应统计实际触发的信号种类");
    assert.ok(!report.includes("（无，全程沉默观察）"), "有信号时不得误显无动作");
  });
});

// ---------------------------------------------------------------------------
// B1 不可达计数 / B2 预算安全网误判 / M3 空游标边界 / B3 文案红线 / M4 降级传播
// ---------------------------------------------------------------------------

describe("B1 不可达目标收尾", () => {
  it("read 反复抛异常 → 连续 2 次即写汇报退出，不空转（探针场景）", async () => {
    const h = harness({ channel: new DeadReadChannel() });
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.strictEqual(evs.filter((e) => e.type === "target-unreachable").length, 2);
    assert.ok(evs.some((e) => e.type === "finish" && e.reason === "目标连续不可达"));
    assert.ok(h.sleeps.length >= 1, "不可达路径必须退避（await sleep），不得微任务空转");
    assert.ok(result.reportPath !== null && existsSync(result.reportPath));
  });

  it("不可达计数跨类型累计：waitIdle stale + read alive:false → 2 次即收尾（B1）", async () => {
    const h = harness();
    h.channel.waitResults = ["stale"];
    h.channel.reads = ["dead"];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.target.calls, 0, "从未进入取证");
    const evs = h.services.events.read("w-test");
    assert.strictEqual(evs.filter((e) => e.type === "target-unreachable").length, 2);
    assert.ok(evs.some((e) => e.type === "finish" && e.reason === "目标连续不可达"));
  });

  it("仅 read 成功且 alive:true 清零不可达计数（B1）", async () => {
    const h = harness({ target: new SpyTarget(spinSignals()) });
    h.channel.waitResults = ["stale", "idle", "stale", "stale"];
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // 若 read 成功未清零，第 3 拍（stale）即凑满 2 次收尾；清零后需再攒 2 次 stale
    assert.strictEqual(h.waitCalls.n, 4, `清零后应经历 4 次 waitIdle（实际 ${h.waitCalls.n}）`);
    assert.strictEqual(h.channel.readCalls, 1);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide"), "成功拍应产生 decide 事件");
    assert.ok(evs.some((e) => e.type === "target-gone"));
  });
});

describe("B2 预算到期语义（V2a：只退出，不动目标）", () => {
  it("busy + 无新输出 + 预算到期（waitIdle timeout）→ 直接收尾退出，无警告无停止", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget() });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout", "timeout", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.sends.length, 0, "预算到期不得发任何警告");
    assert.strictEqual(h.channel.stops, 0, "预算到期不得停止目标");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "budget-expired"), "统一预算到期事件");
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("监督预算到期")));
  });

  it("预算到期时警告/暂停闩锁在身 → 同样直接收尾退出（不追加干预）", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout"];
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const state = await seedState(h);
    state.warningSent = true;
    state.warningTrigger = "spin";
    state.lastAction = "warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.sends.length, 0);
    assert.strictEqual(h.channel.stops, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "budget-expired"));
  });
});

describe("V2a 警告闩锁会话适配器（--terminal + --session 组合）", () => {
  /** 预置：崩溃前 L2 警告已发出且成功取证到游标 <cursor>。 */
  async function seedWarning(h: ReturnType<typeof harness>, cursor: string): Promise<void> {
    const state = await seedState(h);
    state.cursor = cursor;
    state.warningSent = true;
    state.warningTrigger = "spin";
    state.lastAction = "warning";
    await h.services.state.save("w-test", state);
  }

  it("警告在身 + 终端游标不变 + 会话文件信号复现 → 暂停待命（不 stop）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals(), "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true }, // 同游标 + 警告在身 → 闩锁取证 → 信号复现 → 暂停
      { text: "", cursor: "10", alive: true }, // 暂停中 → 沉默
      "dead",
      "dead",
    ];
    await seedWarning(h, "10");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "会话适配器同样不 stop（stop 仅剩 L4）");
    assert.strictEqual(h.target.calls, 2, "闩锁在身 → 同游标也取证（暂停后拍仍取证）");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "escalated" && e.to === "pause"), "复现 → 暂停升级");
    assert.ok(!evs.some((e) => e.type === "stop"));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.paused, true);
  });

  it("警告在身 + 终端游标不变 + 会话文件信号消失且有新增调用 → 确认清闩（不 stop）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget([], "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true }, // 同游标 + 警告在身 → 闩锁取证：信号消失 + newToolCalls=1 → 确认
      "dead",
      "dead",
    ];
    await seedWarning(h, "10");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0);
    assert.strictEqual(h.target.calls, 1);
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.warningSent, false, "确认后闩锁清除并持久化");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "warning-acked"));
    assert.ok(!evs.some((e) => e.type === "stop"));
  });

  it("警告在身 + 游标不变 + 会话文件无新增调用且信号消失 → 沉默等待（不 stop）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new NoNewToolCallsTarget([], "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    await seedWarning(h, "10");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "无干活证据不 stop（V2a：等待而非停止）");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.warningSent, true, "闩锁保持");
    const evs = h.services.events.read("w-test");
    assert.ok(!evs.some((e) => e.type === "stop"));
  });

  it("空游标恢复 + 会话适配器：信号消失且有新增调用 → 确认清闩（不 stop）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget([], "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "", alive: true }, // 空游标 + 警告在身 → 闩锁取证 → 确认清闩
      { text: "", cursor: "", alive: true }, // 清闩后游标仍空 → 正常取证（calls=2）→ silence
      "dead",
      "dead",
    ];
    await seedWarning(h, "");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0);
    assert.strictEqual(h.target.calls, 1, "确认清闩后同游标拍按游标纪律跳过取证");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.warningSent, false, "确认后闩锁清除并持久化");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "warning-acked"));
    assert.ok(!evs.some((e) => e.type === "stop"));
  });
});
describe("M3 空游标边界", () => {
  it("首拍取证失败且游标为空 → 次拍必须重试取证（取证调用次数 ≥2）", async () => {
    const h = harness({ budgetMs: 120_000, target: new FlakyTarget(1) });
    h.channel.reads = [
      { text: "", cursor: "", alive: true },
      { text: "", cursor: "", alive: true },
      { text: "", cursor: "", alive: true },
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(h.target.calls >= 2, `取证调用次数应 ≥2（实际 ${h.target.calls}）`);
    assert.ok(h.services.events.read("w-test").some((e) => e.type === "facts-error"));
  });
});

describe("B3 LLM 文案红线（loop 层）", () => {
  async function seedEscalated(h: ReturnType<typeof harness>): Promise<void> {
    const state = await seedState(h);
    state.remindCount = 1;
    const key = signalKey(spinSignals()[0]!);
    state.remindHistory = [
      { kind: "spin", beat: 0, factsHash: key },
      { kind: "spin", beat: 5, factsHash: key },
    ];
    await h.services.state.save("w-test", state);
  }

  it("LLM remind → steer 用内核模板文本，LLM 自由文本只进事件记录", async () => {
    const h = harness({
      target: new SpyTarget(spinSignals()),
      llm: async () => ({
        decision: { action: "remind", message: "【LLM 自由文本：完全自定义的提醒】", reason: "LLM 认为需要提醒" },
        note: "ok" as const,
        detail: null,
      }),
    });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.sends.length, 1);
    assert.ok(h.channel.sends[0]!.includes("监督提醒"));
    assert.ok(h.channel.sends[0]!.includes("原地重复"));
    assert.ok(!h.channel.sends[0]!.includes("LLM 自由文本"), "LLM message 不得原样 steer");
    const call = h.services.events.read("w-test").find((e) => e.type === "llm_call");
    assert.ok(call !== undefined);
    assert.strictEqual(call["message"], "【LLM 自由文本：完全自定义的提醒】", "LLM 自由文本应进事件记录");
  });

  it("LLM panel → question 净化（去控制字符）并拼内核证据摘要；结论净化", async () => {
    const seen: { question: string | null } = { question: null };
    const h = harness({
      target: new SpyTarget(spinSignals()),
      llm: async () => ({
        decision: { action: "panel", question: "方向问题\u0000\u001B[31m控制\u0007", reason: "llm-panel" },
        note: "ok" as const,
        detail: null,
      }),
      runPanel: async (q) => {
        seen.question = q;
        return "结论文本\u0000（含控制字符）";
      },
    });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    await seedEscalated(h);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(seen.question !== null, "runPanel 应收到 question");
    if (seen.question !== null) {
      assert.ok(seen.question.includes("方向问题"));
      assert.ok(!seen.question.includes("\u0000") && !seen.question.includes("\u001B"), "question 应去控制字符");
    }
    const pause = h.channel.sends.find((s) => s.includes("讨论组问题"));
    assert.ok(pause !== undefined);
    assert.ok(pause.includes("重复了 3 次"), "steer 应含内核证据摘要");
    assert.ok(!pause.includes("\u0000") && !pause.includes("\u001B"));
    const resume = h.channel.sends.find((s) => s.includes("讨论组结论"));
    assert.ok(resume !== undefined && !resume.includes("\u0000"), "复工引导也应净化");
  });
});

describe("M4 append 失败降级", () => {
  it("append 返回 false → 状态标记 eventsDegraded + 报告显式标注", async () => {
    const h = harness({ target: new SpyTarget(spinSignals()) });
    // 用普通文件占据事件目录 → append 必然失败
    rmSync(join(h.dir, "events"), { recursive: true, force: true });
    writeFileSync(join(h.dir, "events"), "blocker", "utf-8");
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.eventsDegraded, true, "append 失败应标记状态");
    const report = (await import("node:fs")).readFileSync(result.reportPath!, "utf-8");
    assert.ok(report.includes("事件落盘曾失败"), "报告应显式标注记录降级");
  });
});

describe("M3 append 失败传播（steer/stop 路径统一包装）", () => {
  it("steer 路径 append 失败 → 同样标记 eventsDegraded（不只 finish 路径）", async () => {
    const h = harness({ target: new SpyTarget(spinSignals()) });
    // 事件顺序：watch_start(1) → decide(2) → steer(3)。只让 steer 事件落盘失败：
    // 若 steer 路径不传播降级，状态文件将保持 eventsDegraded=false。
    const store = h.services.events;
    const origAppend = store.append.bind(store);
    let n = 0;
    store.append = ((watchId: string, event: { type: string; [key: string]: unknown }) => {
      n++;
      if (n === 3) return false;
      return origAppend(watchId, event);
    }) as typeof store.append;
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      "dead",
      "dead",
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.eventsDegraded, true, "steer 路径 append 失败也应标记降级");
  });

  it("stop 路径 append 失败 → 标记 eventsDegraded → 报告显式标注", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget() });
    h.channel.kind = "orca";
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    h.target.recentCommands = ["rm -rf /tmp/outside-data"]; // V2a：L4 硬边界触发 stop
    // 只让 stop 事件落盘失败（stop 是收尾拍，观察报告标注而非状态文件）
    const store = h.services.events;
    const origAppend = store.append.bind(store);
    store.append = ((watchId: string, event: { type: string; [key: string]: unknown }) => {
      if (event.type === "stop") return false;
      return origAppend(watchId, event);
    }) as typeof store.append;
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "记录失败不得阻断停止执行");
    const report = (await import("node:fs")).readFileSync(result.reportPath!, "utf-8");
    assert.ok(report.includes("事件落盘曾失败"), "stop 路径 append 失败应标记 degraded 并显式标注");
    // m1：终态事件发生后状态必须再次落盘——guardian report 重载不丢降级标记
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.eventsDegraded, true, "终态事件后的状态重存必须带上降级标记");
    const reportReload = generateReport(loaded!, h.services.events.readState("w-test"));
    assert.ok(reportReload.includes("事件落盘曾失败"), "重载状态重新生成汇报也应标注降级");
  });
});

// ---------------------------------------------------------------------------
// T2 finish 丢锁回归（W4 收尾归属校验）：leaseWinner 返回他人时
// 不得写 save/报告（事件先行落一行冗余 finish，属可自愈，见 W4 声明），
// 仅追加自己的 release 行
// ---------------------------------------------------------------------------

describe("T2 finish 丢锁回归（收尾归属校验）", () => {
  it("finish 时锁已被他人接管（W4-① save 前校验拦截）→ 冗余 finish 事件一行、无报告、state 未覆写、仅追加自己的 release 行", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const store = h.services.state;
    const origLeaseWinner = store.leaseWinner.bind(store);
    // 收尾归属校验探针：仅当收尾触发事件（budget-expired）已落盘后，让
    // leaseWinner 返回"他人"——模拟 finish 期间锁已被其他进程接管（真实场景：
    // 本运行租约过期/断链后他人 claim 当选）。收尾前的续租调用不受影响。
    store.leaseWinner = ((watchId: string, now: number) => {
      if (h.services.events.read("w-test").some((e) => e.type === "budget-expired")) {
        return { runId: "run-other", ownerPid: 999_999, leaseExpiresAt: Number.MAX_SAFE_INTEGER };
      }
      return origLeaseWinner(watchId, now);
    }) as typeof store.leaseWinner;
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // W4 声明：事件追加先行可保留——已落一行冗余 finish 事件（自愈，可接受）
    const evs = h.services.events.read("w-test");
    assert.strictEqual(evs.filter((e) => e.type === "finish").length, 1, "恰一行冗余 finish 事件（W4 声明内）");
    // 无报告生成
    assert.strictEqual(result.reportPath, null, "丢锁收尾不写报告");
    assert.ok(!existsSync(join(h.dir, "reports", "w-test.md")), "报告文件不得生成");
    // state 未覆写：磁盘终态仍是收尾前的 active（finish 的 status=finished 未落盘，fencing）
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded.status, "active", "丢锁收尾不得覆写 state（fencing）");
    // 自己的 release 行已追加（release 只杀死自己的 runId，永远安全）
    const ledger = store.readLedger("w-test").lines;
    const claim = ledger.find((l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim");
    assert.ok(claim !== undefined, "本运行 claim 应在账本中");
    assert.ok(
      ledger.some((l) => l.op === "release" && l.runId === claim.runId),
      "丢锁收尾必须追加自己的 release 行",
    );
  });

  it("W4-②：save 后 read-back 复检检出丢锁（校验后注入接管）→ stderr 警告、仅 release 落地、无后续共享写", async () => {
    const h = harness({ budgetMs: 10_000 });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const store = h.services.state;
    const origLeaseWinner = store.leaseWinner.bind(store);
    const stderr: string[] = [];
    const origError = console.error;
    console.error = (msg?: unknown) => {
      stderr.push(String(msg));
    };
    try {
      let checkCalls = 0;
      // 注入接管：第一次归属校验（终态 save 前最后一跳，W4-①）仍归己；第二次
      // （save 后 read-back 复检，W4-②）返回"他人"——模拟校验通过后、终态 rename
      // 前被其他进程 claim 接管（微秒级窗口）。
      store.leaseWinner = ((watchId: string, now: number) => {
        checkCalls++;
        if (checkCalls >= 2) {
          return { runId: "run-other", ownerPid: 999_999, leaseExpiresAt: Number.MAX_SAFE_INTEGER };
        }
        return origLeaseWinner(watchId, now);
      }) as typeof store.leaseWinner;
      const result = await runWatch(h.watchOpts, h.services);
      assert.strictEqual(result.exitCode, 0);
      // read-back 复检检出丢锁 → stderr 警告（W4-②）
      assert.ok(
        stderr.some((s) => s.includes("复检发现单例锁已被其他进程接管")),
        `stderr 应有 read-back 丢锁警告（实测: ${stderr.join(" | ")}）`,
      );
      // 此后不再写任何共享文件：无报告、无报告写失败降级事件
      assert.strictEqual(result.reportPath, null, "复检丢锁后不得写报告");
      assert.ok(!existsSync(join(h.dir, "reports", "w-test.md")), "报告文件不得生成");
      const evs = h.services.events.read("w-test");
      assert.ok(!evs.some((e) => e.type === "report-write-failed"), "复检丢锁后不得追加降级事件");
      // 复检丢锁前的 save 是合法的（save 时仍归己）：终态 status=finished 已落盘
      const loaded = await loadOk(h.services.state, "w-test");
      assert.strictEqual(loaded.status, "finished", "复检丢锁前的终态 save 应已落地（当时仍归己）");
      // 仅追加自己的 release 行（release 只杀死自己的 runId，永远安全）
      const ledger = store.readLedger("w-test").lines;
      const claim = ledger.find((l): l is Extract<LedgerLine, { op: "claim" }> => l.op === "claim");
      assert.ok(claim !== undefined, "本运行 claim 应在账本中");
      assert.ok(
        ledger.some((l) => l.op === "release" && l.runId === claim.runId),
        "复检丢锁后必须追加自己的 release 行",
      );
    } finally {
      console.error = origError;
    }
  });
});
