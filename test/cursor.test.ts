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
        newToolCalls: this.calls === 1 ? 1 : 0,
        signals: this.signals,
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
    assert.ok(evs.some((e) => e.type === "budget-expired-idle"));
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
    assert.ok(evs.some((e) => e.type === "budget-expired-idle"));
    assert.ok(!h.channel.sends.some((s) => s.includes("警告")));
    assert.strictEqual(h.channel.stops, 0);
  });
});

// ---------------------------------------------------------------------------
// 安全网 / 停止 / 纯观察 / panel 链路
// ---------------------------------------------------------------------------

describe("安全网与停止", () => {
  it("LIVE-1 回归：预算到期→警告→目标仅回应警告（游标前进但 newToolCalls=0）→ stops=1 且不再发第二次警告", async () => {
    // 实测事件流（19:58~20:03 反复警告不停止）：预算到期+目标活跃 → 警告 steer 以用户输入
    // 提交进目标 → 目标处理警告文本（游标前进）→ 旧 M1 清闩（"改善"）→ 下拍再警告 → 死循环。
    const h = harness({ budgetMs: 10_000, target: new NoNewToolCallsTarget() });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：超预算+活跃 → 最后警告（触发源 budget）
      { text: "b", cursor: "20", alive: true }, // 拍2：游标前进（处理警告）但 newToolCalls=0 → 无真实改善 → 必须 stop
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.sends.filter((s) => s.includes("警告")).length, 1, "不得再发第二次警告（ping-pong 死循环）");
    assert.strictEqual(h.channel.stops, 1, "无真实改善 → 必须 executeStop");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide" && e.action === "safety-warning"));
    assert.ok(!evs.some((e) => e.type === "safety-warning-cleared"), "幻影改善不得清闩");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(!evs.some((e) => e.type === "budget-expired-idle"), "活跃目标不得走静止直接收尾");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, true, "未改善时闩锁不得清除");
    assert.strictEqual(loaded?.safetyWarningTrigger, "budget", "触发源应持久化为 budget");
  });

  it("崩溃恢复：safetyWarningSent=true 恢复续跑 → 同游标+存活 → 次拍必须 stop（B1；纯 terminal 目标无证据源）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget([], "terminal") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
    ];
    // 预置：崩溃前最后警告已发出（safetyWarningSent 已落盘）
    const state = await seedState(h);
    state.cursor = "10";
    state.safetyWarningSent = true;
    state.lastAction = "safety-warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // postWarning 必须从持久化状态恢复：恢复首拍即走无进展分支 → stop，
    // 不得先取证再 sleep 续跑或 budget-expired-idle 绕过。
    assert.strictEqual(h.channel.stops, 1, "恢复后同游标+目标存活 → 必须 stop");
    assert.strictEqual(h.target.calls, 0, "恢复首拍即 stop，不得先取证（B1 恢复初始化）");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "watch_resume"));
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(!evs.some((e) => e.type === "budget-expired-idle"), "恢复后不得走 budget-expired-idle 绕过 stop");
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("安全网收尾")));
  });

  it("B1 恢复初始化：state.cursor 初始化 lastGoodCursor——恢复首拍同游标+存活 → 首拍即 stop（不被取证分支拦截；纯 terminal 目标）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals(), "terminal") });
    h.channel.kind = "orca";
    h.channel.reads = [{ text: "", cursor: "5", alive: true }];
    // 预置：崩溃前已发最后警告且成功取证到游标 '5'
    const state = await seedState(h);
    state.cursor = "5";
    state.safetyWarningSent = true;
    state.lastAction = "safety-warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "恢复首拍同游标+存活 → 必须 stop");
    assert.strictEqual(h.target.calls, 0, "不得先进取证分支再停（B1 结构性修复）");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("安全网收尾")));
  });

  it("B1 恢复+取证异常组合：取证失败按上限退出前仍须先执行 stop（stop 是既有承诺）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new BrokenTarget() });
    h.channel.kind = "orca";
    // 恢复游标 '5'；首拍游标前进到 '6'（改善已观察），此后取证持续失败
    h.channel.reads = [{ text: "b", cursor: "6", alive: true }];
    const state = await seedState(h);
    state.cursor = "5";
    state.safetyWarningSent = true;
    state.lastAction = "safety-warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "目标仍 alive 且 warning 已发，取证失败不得绕过 stop 承诺");
    const evs = h.services.events.read("w-test");
    assert.strictEqual(evs.filter((e) => e.type === "facts-error").length, MAX_CONSECUTIVE_FACTS_ERRORS);
    assert.ok(evs.some((e) => e.type === "facts-error-exhausted"));
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
  });

  it("B2 空游标恢复：持久化空游标 + 警告在身 + 游标不前进 → 取证前即 stop（探针 stops=1；纯 terminal 目标）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget(spinSignals(), "terminal") });
    h.channel.kind = "orca";
    h.channel.reads = [{ text: "", cursor: "", alive: true }];
    // 预置：崩溃前最后警告已发出，但成功取证的游标为空串（空游标恢复场景）
    const state = await seedState(h);
    state.cursor = "";
    state.safetyWarningSent = true;
    state.lastAction = "safety-warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // 旧缺陷：空游标恢复使 lastGoodCursor=null → 取证分支拦截 → 取证成功被
    // M1 的"取证成功=改善"清闩 → 永不 stop。修复后必须取证前兑现 stop 承诺。
    assert.strictEqual(h.channel.stops, 1, "空游标恢复+警告在身+游标不前进 → 必须 stop");
    assert.strictEqual(h.target.calls, 0, "不得先取证（旧清闩路径不得绕过 stop）");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("安全网收尾")));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded.safetyWarningSent, true, "未改善时闩锁不得清除");
  });

  it("LIVE-1 真实改善：warning→触发信号消失且自警告起 newToolCalls>0 → 清闩 → 后续静止拍不得 stop", async () => {
    const h = harness({ budgetMs: 60_000, target: new GenuineImprovementTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → 最后警告
      { text: "b", cursor: "20", alive: true }, // 拍2：信号消失 + 干活证据（newToolCalls>0）= 真实改善 → 清闩
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "真实改善后不得 stop");
    assert.ok(h.channel.sends.some((s) => s.includes("警告")), "第一拍应发最后警告");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, false, "真实改善后闩锁必须清除并持久化");
    assert.strictEqual(loaded?.safetyWarningTrigger, null, "清闩后触发源必须重置");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "safety-warning-cleared"));
    assert.ok(!evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("预算到期，目标静止")));
  });

  it("LIVE-1 幻影改善：warning→游标前进但 newToolCalls=0（仅回应警告）→ 不清闩 → 次拍必须 stop", async () => {
    // 目标回应警告本身就会前进游标——游标前进永不清安全闩；
    // 信号消失但无干活证据 → 仍不算改善 → 警告后无进展拍必须 stop。
    const h = harness({ budgetMs: 60_000, target: new FirstBeatSignalTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → 最后警告
      { text: "b", cursor: "20", alive: true }, // 拍2：信号消失但 newToolCalls=0 → 幻影改善，不清闩
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "无干活证据 → 次拍必须 stop（游标前进不清安全闩）");
    const evs = h.services.events.read("w-test");
    assert.ok(!evs.some((e) => e.type === "safety-warning-cleared"), "幻影改善不得清闩");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded.safetyWarningSent, true, "未真实改善时闩锁不得清除");
  });

  it("残差 blocker：警告后游标前进+触发信号消失+newToolCalls=0 → 次拍即 stop，不静默续跑", async () => {
    // 旧缺陷：警告后游标前进 → 触发信号消失但 newToolCalls=0 → 不清闩也不 stop，
    // 落入 decide 返回 silence → 连续 cursor-only beats 永不停止（探针）。
    // 修复：regular progress 分支在 decide 前统一兑现安全网承诺——无真实改善 →
    // 次拍即 executeStop，且不再发第二次警告。
    const h = harness({ budgetMs: 1_000_000, target: new FirstBeatSignalTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → 最后警告（触发源 spin）
      { text: "b", cursor: "20", alive: true }, // 拍2：游标前进+信号消失但 newToolCalls=0 → 必须 stop
      { text: "c", cursor: "30", alive: true },
      { text: "d", cursor: "40", alive: true },
      { text: "e", cursor: "50", alive: true },
      { text: "f", cursor: "60", alive: true },
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "警告后无真实改善 → 必须 executeStop");
    assert.strictEqual(h.target.calls, 2, "次拍即停，不得静默续跑（连续 cursor-only beats 探针）");
    assert.strictEqual(h.channel.sends.filter((s) => s.includes("警告")).length, 1, "不得再发第二次警告");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide" && e.action === "safety-warning"));
    assert.ok(!evs.some((e) => e.type === "safety-warning-cleared"), "无干活证据不得清闩");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("安全网收尾")));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, true, "未改善时闩锁不得清除");
    assert.strictEqual(loaded?.safetyWarningTrigger, "spin", "触发源应保持为 spin");
  });

  it("残差 blocker 反向：警告后真实改善（信号消失+newToolCalls>0）→ 清闩不 stop，改善后 cursor-only beats 不重复警告", async () => {
    // 真实改善（LIVE-1 口径）→ 清闩并继续进 decide；改善后的拍即使信号消失且
    // newToolCalls=0 也不得 stop、不得再警告（每发一次警告只给一拍宽限，改善后
    // 静止/无进展拍不得再 stop）。
    const h = harness({ budgetMs: 60_000, target: new ImproveThenCursorOnlyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → 最后警告（触发源 spin）
      { text: "b", cursor: "20", alive: true }, // 拍2：信号消失+newToolCalls>0 → 真实改善 → 清闩
      { text: "c", cursor: "30", alive: true }, // 拍3-5：cursor-only beats（信号消失、无新增调用）→ 不得 stop
      { text: "d", cursor: "40", alive: true },
      { text: "e", cursor: "50", alive: true },
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "真实改善后不得 stop");
    assert.strictEqual(h.channel.sends.filter((s) => s.includes("警告")).length, 1, "不得重复警告");
    assert.strictEqual(h.target.calls, 5, "改善后继续正常取证（拍2-5 均走 decide）");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "safety-warning-cleared"));
    assert.ok(!evs.some((e) => e.type === "stop"));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, false, "真实改善后闩锁必须清除并持久化");
    assert.strictEqual(loaded?.safetyWarningTrigger, null, "清闩后触发源必须重置");
  });

  it("警告后目标持续 alive+无进展 → 次拍必须 stop（B1：不依赖预算到期）", async () => {
    const h = harness({ target: new SpyTarget(spinSignals()) }); // 预算 1000 分钟，未到期
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → 安全网最后警告
      { text: "", cursor: "10", alive: true }, // 拍2：游标不前进且仍 alive → 必须 stop
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(h.channel.sends.some((s) => s.includes("警告")), "应先发最后警告");
    assert.strictEqual(h.channel.stops, 1, "警告后次拍无进展必须 stop");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide" && e.action === "safety-warning"));
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
  });

  it("警告后同类信号复现（游标前进）→ 次拍 stop（B1 安全网承诺）", async () => {
    const h = harness({ target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 拍1：复现 → 最后警告
      { text: "b", cursor: "20", alive: true }, // 拍2：同类信号复现 → 停止
    ];
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "警告后同类信号复现必须 stop");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "stop"));
  });

  it("超预算 + 目标活跃（orca 通道）→ 最后警告 → 下一拍停止", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(h.channel.sends.some((s) => s.includes("警告")));
    assert.strictEqual(h.channel.stops, 1);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "decide" && e.action === "safety-warning"));
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
  });

  it("超预算 + 活跃 → 最后警告 → 下一拍目标转静 → 停止后收尾（M2：安全网序列收完）", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true }, // 活跃：超预算 → 最后警告
      { text: "", cursor: "10", alive: true }, // 转静：无改善 → 必须 stop，不得直接收尾
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(h.channel.sends.some((s) => s.includes("警告")));
    assert.strictEqual(h.channel.stops, 1);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    const report = (await import("node:fs")).readFileSync(result.reportPath!, "utf-8");
    assert.ok(report.includes("安全网收尾：最后警告后无改善，已停止"));
  });

  it("纯观察（file 通道）：提醒/警告/停止只记录事件，不发送任何消息", async () => {
    const h = harness({
      budgetMs: 100_000,
      target: new SpyTarget(spinSignals()),
      channel: new ObservingChannel(),
    });
    h.channel.waitResults = ["idle", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
      { text: "c", cursor: "30", alive: true },
    ];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    // 拍 1：预算未到 → 机械提醒（只记录）
    assert.ok(evs.some((e) => e.type === "steer-unsupported" && e.action === "remind"));
    // 拍 2：wait 超时推进时钟 → 超预算 → 警告（只记录）
    assert.ok(evs.some((e) => e.type === "steer-unsupported" && e.action === "safety-warning"));
    // 拍 3：停止（只记录，不实际停止）
    assert.ok(evs.some((e) => e.type === "stop-unsupported"));
    assert.strictEqual(h.channel.sends.length, 0);
    assert.strictEqual(h.channel.stops, 0);
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
    // 预置：同 key 已提醒过、升级计数 1 → 本次复现直接到 LLM 回调点
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);

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
    const state = await seedState(h);
    state.remindCount = 1;
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
    await h.services.state.save("w-test", state);
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
    // 纯 terminal 目标（无证据源）：警告在身的次拍走取证前直接 stop，不触发 M2 探针，
    // 保证本用例专注验证 M3 重试纪律（同一检查点重试）。
    const h = harness({ budgetMs: 10_000, target: new FlakyTarget(1, [], "terminal") });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    // 失败那拍游标不变（仍 ""），下拍用同一检查点重试；成功后状态游标推进到通道游标 "10"
    assert.deepStrictEqual(h.target.cursors, ["", ""]);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "facts-error"));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.cursor, "10");
  });

  it("永久取证异常 + 预算到期 → 汇报退出：finish 事件 + 进程正常结束（B2）", async () => {
    const h = harness({ budgetMs: 10_000, target: new BrokenTarget() });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "finish"), "必须有 finish 事件");
    const finishEv = evs.find((e) => e.type === "finish");
    assert.ok(finishEv !== undefined && String(finishEv["reason"]).includes("取证"), "收尾原因应标注取证失败");
    assert.ok(evs.some((e) => e.type === "facts-error-exhausted"));
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
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
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
    assert.ok(report.includes("预算到期，目标静止"), "报告应显示实际收尾原因");
    assert.ok(!report.includes("未记录收尾事件"), "报告不得误显未记录收尾事件");
  });

  it("汇报信号统计与 decide 事件 signals 字段对齐（M5）", async () => {
    const h = harness({ budgetMs: 10_000, target: new SpyTarget(spinSignals()) });
    h.channel.reads = [{ text: "a", cursor: "10", alive: true }];
    const result = await runWatch(h.watchOpts, h.services);
    const report = (await import("node:fs")).readFileSync(result.reportPath!, "utf-8");
    assert.ok(report.includes("原地重复"), "报告应统计实际触发的信号种类");
    assert.ok(!report.includes("（无）"), "有信号时不得误显无信号");
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

describe("B2 预算安全网误判", () => {
  it("busy + 无新输出 + 预算到期（waitIdle timeout）→ 最后警告 → 停止 → 收尾", async () => {
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
    // 必须出现最后警告与 stop（不得当"目标静止"直接收尾）
    assert.ok(h.channel.sends.some((s) => s.includes("警告")), "应发出最后警告");
    assert.strictEqual(h.channel.stops, 1, "应执行 stop");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(!evs.some((e) => e.type === "budget-expired-idle"), "busy 目标不得走静止直接收尾");
  });
});

describe("M2 会话适配器无进展探针（--terminal + --session 组合）", () => {
  /** 预置：崩溃前最后警告已发出且成功取证到游标 <cursor>。 */
  async function seedWarning(h: ReturnType<typeof harness>, cursor: string): Promise<void> {
    const state = await seedState(h);
    state.cursor = cursor;
    state.safetyWarningSent = true;
    state.lastAction = "safety-warning";
    await h.services.state.save("w-test", state);
  }

  it("LIVE-1 预算触发恢复：trigger=budget 持久化 → 会话文件有新增调用也清不了闩 → 必须 stop", async () => {
    // 崩溃恢复不得绕过安全网承诺：预算到期触发的警告永不改善（预算单调不消失），
    // 即使会话文件探针显示 newToolCalls>0 也必须 stop，不得旧 M2 语义清闩续跑。
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget([], "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [{ text: "", cursor: "10", alive: true }]; // 同游标 + 警告在身 → M2 探针（newToolCalls=1）→ 仍 stop
    const state = await seedState(h);
    state.cursor = "10";
    state.safetyWarningSent = true;
    state.safetyWarningTrigger = "budget";
    state.lastAction = "safety-warning";
    await h.services.state.save("w-test", state);
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "预算触发永不改善 → 探针有新增调用也必须 stop");
    assert.strictEqual(h.target.calls, 1, "探针取证一次");
    const evs = h.services.events.read("w-test");
    assert.ok(!evs.some((e) => e.type === "safety-warning-cleared"));
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningTrigger, "budget", "触发源应持久化（崩溃续跑不丢）");
  });

  it("警告在身 + 终端游标不变 + 会话文件新增调用 → 不 stop 且清闩", async () => {
    const h = harness({ budgetMs: 60_000, target: new SpyTarget([], "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true }, // 拍1：同游标 + 警告在身 → M2 探针（首次取证 newToolCalls=1）→ 清闩
      { text: "", cursor: "10", alive: true }, // 拍2：清闩后无进展拍 → 预算到期（目标静止）→ 收尾
    ];
    await seedWarning(h, "10");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "会话文件有新增调用（newToolCalls>0）→ 不得 stop");
    assert.strictEqual(h.target.calls, 1, "只做一次 M2 探针取证");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, false, "判定改善后闩锁必须清除并持久化");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "safety-warning-cleared"));
    assert.ok(!evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "finish" && String(e.reason).includes("预算到期，目标静止")));
  });

  it("警告在身 + 游标不变 + 会话文件无新增调用 → 探针一次后 stop", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new NoNewToolCallsTarget() });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "10", alive: true },
      { text: "", cursor: "10", alive: true },
    ];
    await seedWarning(h, "10");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 1, "探针无新增调用 → 必须 stop");
    assert.strictEqual(h.target.calls, 1, "先取证一次再判（M2 探针）");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, true, "未改善时闩锁不得清除");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "stop"));
    assert.ok(evs.some((e) => e.type === "stop-issued"));
    assert.ok(!evs.some((e) => e.type === "safety-warning-cleared"));
  });

  it("空游标恢复 + 会话适配器：探针 newToolCalls>0 → 不 stop 且清闩（B2 分支）", async () => {
    const h = harness({ budgetMs: 1_000_000, target: new SpyTarget([], "pi") });
    h.channel.kind = "orca";
    h.channel.reads = [
      { text: "", cursor: "", alive: true }, // 拍1：空游标 + 警告在身 → M2 探针（newToolCalls=1）→ 清闩，sleep 进下一拍
      { text: "", cursor: "", alive: true }, // 拍2：清闩后游标仍空 → 正常取证（calls=2）→ silence
      "dead",
      "dead", // 拍3-4：不可达 → 收尾（保证循环终止）
    ];
    await seedWarning(h, "");
    const result = await runWatch(h.watchOpts, h.services);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(h.channel.stops, 0, "会话文件有新增调用 → 不得 stop");
    assert.strictEqual(h.target.calls, 2, "探针 1 次 + 清闩后正常取证 1 次");
    const loaded = await loadOk(h.services.state, "w-test");
    assert.strictEqual(loaded?.safetyWarningSent, false, "判定改善后闩锁必须清除并持久化");
    const evs = h.services.events.read("w-test");
    assert.ok(evs.some((e) => e.type === "safety-warning-cleared"));
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
    state.escalationCount = 1;
    state.remindHistory = [{ kind: "spin", beat: 0, factsHash: signalKey(spinSignals()[0]!) }];
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
    const h = harness({ budgetMs: 10_000, target: new SpyTarget() });
    h.channel.kind = "orca";
    h.channel.waitResults = ["timeout", "timeout"];
    h.channel.reads = [
      { text: "a", cursor: "10", alive: true },
      { text: "b", cursor: "20", alive: true },
    ];
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
    // 收尾归属校验探针：仅当收尾触发事件（budget-expired-idle）已落盘后，让
    // leaseWinner 返回"他人"——模拟 finish 期间锁已被其他进程接管（真实场景：
    // 本运行租约过期/断链后他人 claim 当选）。收尾前的续租调用不受影响。
    store.leaseWinner = ((watchId: string, now: number) => {
      if (h.services.events.read("w-test").some((e) => e.type === "budget-expired-idle")) {
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
