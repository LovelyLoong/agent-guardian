/**
 * agent-guardian — 决策树全分支测试（设计 §7）。
 *
 * 覆盖：无信号沉默 / 机械提醒+冷却+上限 / 升级计数 / LLM 回调点
 * （非法输出→silence、stop→降级 pause）/ 安全网（警告→停止）/ 预算红线。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { Signal } from "../../pi-task-governor/src/contract.ts";
import type { BeatFacts } from "../src/targets/types.ts";
import { initialState } from "../src/watcher/state.ts";
import type { WatchState } from "../src/watcher/state.ts";
import { decide, remindMessage, signalKey, buildSteerText, SAFETY_WARNING_TEXT, SAFETY_WARNING_SPIN_TEXT, SAFETY_WARNING_BUDGET_TEXT } from "../src/watcher/decide.ts";
import type { DecideContext } from "../src/watcher/decide.ts";
import { parseDecisionOutput } from "../src/watcher/llm.ts";
import type { EvidencePack, LlmResult } from "../src/watcher/llm.ts";
import { buildEvidencePack } from "../src/watcher/llm.ts";

const OPTS = { remindMax: 5, cooldownBeats: 3, llmMaxCalls: 3 };

function spinSignal(facts: Record<string, number | string> = { window: 8, threshold: 3, "repeat-count": 3, "repeat-key": "bash:h1" }): Signal {
  return { kind: "spin", severity: 2, facts };
}

function stallSignal(): Signal {
  return { kind: "stall", severity: 2, facts: { "calls-since-success": 12, threshold: 12 } };
}

function factsWith(signals: Signal[], toolCallsSeen = 8): BeatFacts {
  return {
    toolCallsSeen,
    newToolCalls: 1,
    signals,
    tailSummary: "tail",
    taskSummary: "任务摘要",
  };
}

function makeState(overrides: Partial<WatchState> = {}): WatchState {
  return {
    ...initialState({
      watchId: "w1",
      budgetMs: 120_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "f.jsonl",
      sessionFile: "f.jsonl",
      now: 0,
    }),
    ...overrides,
  };
}

async function runDecide(
  state: WatchState,
  facts: BeatFacts,
  opts: {
    budgetOver?: boolean;
    llmMaxCalls?: number;
    llm?: (evidence: EvidencePack) => Promise<LlmResult>;
  } = {},
) {
  const ctx: DecideContext = {
    facts,
    state,
    budgetOver: opts.budgetOver ?? false,
    opts: { ...OPTS, llmMaxCalls: opts.llmMaxCalls ?? OPTS.llmMaxCalls },
    llmConsult: opts.llm ?? null,
    makeEvidence: () => buildEvidencePack(facts, state, []),
  };
  return decide(ctx);
}

describe("机械决策树", () => {
  it("无信号 → 沉默，状态不变", async () => {
    const state = makeState();
    const out = await runDecide(state, factsWith([]));
    assert.strictEqual(out.action.action, "silence");
    assert.strictEqual(out.consulted, false);
    assert.strictEqual(state.remindCount, 0);
    assert.strictEqual(state.escalationCount, 0);
  });

  it("冷却 3 拍抑制其后 3 拍（m1：cooldownUntil 含边界拍）", async () => {
    // beat 0 提醒 → cooldownUntil=3 → beat 1/2/3 抑制（含 3）、beat 4 可再提醒
    const state = makeState({ settledBeats: 0 });
    await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(state.cooldownUntil["spin"], 3);
    // 边界拍 3：仍在冷却（含）
    const s3 = makeState({ settledBeats: 3, cooldownUntil: { spin: 3 } });
    const out3 = await runDecide(s3, factsWith([spinSignal()]));
    assert.strictEqual(out3.action.action, "silence");
    assert.strictEqual(out3.action.reason, "cooldown:spin");
    // 拍 4：冷却结束，可再提醒
    const s4 = makeState({ settledBeats: 4, cooldownUntil: { spin: 3 } });
    const out4 = await runDecide(s4, factsWith([spinSignal()]));
    assert.strictEqual(out4.action.action, "remind");
  });

  it("LLM 咨询写冷却并与同 kind 信号共享窗口：次拍同 kind 复现被抑制（M1）", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state, factsWith([spinSignal()]), {
      llm: async () => ({ decision: { action: "silence", reason: "r" }, note: "ok" as const, detail: null }),
    });
    assert.strictEqual(out.consulted, true);
    assert.strictEqual(state.cooldownUntil["spin"], 20 + 3, "LLM 咨询应写入同 kind 冷却窗口");
    // 次拍（21）同 kind 复现：冷却抑制 → silence，不咨询、不升级
    const state2 = makeState({
      settledBeats: 21,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: { spin: 23 },
    });
    let consulted = 0;
    const out2 = await runDecide(state2, factsWith([spinSignal()]), {
      llm: async () => {
        consulted++;
        return { decision: { action: "silence", reason: "r" }, note: "ok" as const, detail: null };
      },
    });
    assert.strictEqual(out2.action.action, "silence");
    assert.strictEqual(consulted, 0, "冷却内不得再咨询");
    assert.strictEqual(state2.escalationCount, 1, "冷却中不升级");
  });

  it("LLM 调用达全局上限 → 回到机械安全网，不再咨询（M1）", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      llmCalls: 3, // 已达默认上限 3
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    let consulted = 0;
    const out = await runDecide(state, factsWith([spinSignal()]), {
      llm: async () => {
        consulted++;
        return { decision: { action: "silence", reason: "r" }, note: "ok" as const, detail: null };
      },
    });
    assert.strictEqual(out.action.action, "safety-warning", "超限后应走机械安全网");
    assert.strictEqual(out.consulted, false);
    assert.strictEqual(consulted, 0, "超限后不得再调用 LLM");
    assert.strictEqual(state.llmCalls, 3, "超限后不得再计数");
    assert.strictEqual(state.safetyWarningSent, true);
  });

  it("LLM 上限可配（llmMaxCalls=1）：首次复现咨询后，下次复现直接安全网（M1）", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    let consulted = 0;
    const out = await runDecide(state, factsWith([spinSignal()]), {
      llmMaxCalls: 1,
      llm: async () => {
        consulted++;
        return { decision: { action: "silence", reason: "r" }, note: "ok" as const, detail: null };
      },
    });
    assert.strictEqual(out.consulted, true);
    assert.strictEqual(consulted, 1);
    assert.strictEqual(state.llmCalls, 1);
    // 过冷却后再次复现：已达上限 1 → 机械安全网（不再咨询）
    const state2 = makeState({
      settledBeats: 30,
      escalationCount: 2,
      llmCalls: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    let consulted2 = 0;
    const out2 = await runDecide(state2, factsWith([spinSignal()]), {
      llmMaxCalls: 1,
      llm: async () => {
        consulted2++;
        return { decision: { action: "silence", reason: "r" }, note: "ok" as const, detail: null };
      },
    });
    assert.strictEqual(out2.action.action, "safety-warning");
    assert.strictEqual(consulted2, 0);
    assert.strictEqual(state2.llmCalls, 1);
  });

  it("facts 含 ANSI 转义/控制字符 → steer 文本净化，无 ESC（B2）", () => {
    const facts = factsWith([
      spinSignal({ window: 8, threshold: 3, "repeat-count": "\u001b[31m3\u001b[0m", "repeat-key": "bash:\u001b[31mh1\u001b[0m" }),
    ]);
    const remind = buildSteerText(facts, { action: "remind", message: "m", reason: "r" });
    assert.ok(remind.includes("3"), "净化后保留可见数字");
    assert.ok(!remind.includes("\u001b"), "steer 不得含 ESC");
    assert.ok(!remind.includes("[31m"), "steer 不得含 ANSI 序列残留");
    const pause = buildSteerText(facts, { action: "pause", message: "m", reason: "r" });
    assert.ok(!pause.includes("\u001b"), "暂停文案同样净化");
    // 控制字符（BEL）同样去除
    const facts2 = factsWith([spinSignal({ window: 8, threshold: 3, "repeat-count": "3\u0007", "repeat-key": "k" })]);
    const remind2 = buildSteerText(facts2, { action: "remind", message: "m", reason: "r" });
    assert.ok(!remind2.includes("\u0007"));
  });

  it("新信号 → 机械提醒：计数+1、冷却 3 拍、历史记录、模板含证据", async () => {
    const state = makeState();
    const out = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "remind");
    assert.ok(out.action.message.includes("原地重复"));
    assert.ok(out.action.message.includes("3"));
    assert.strictEqual(state.remindCount, 1);
    assert.strictEqual(state.cooldownUntil["spin"], 0 + 3);
    assert.strictEqual(state.remindHistory.length, 1);
    assert.strictEqual(state.remindHistory[0]!.kind, "spin");
    assert.strictEqual(state.remindHistory[0]!.beat, 0);
    assert.ok(state.remindHistory[0]!.factsHash.length > 0);
  });

  it("冷却内的同 kind 新信号 → 沉默（不计数不提醒）", async () => {
    const state = makeState({ cooldownUntil: { spin: 10 }, settledBeats: 8 });
    const out = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "silence");
    assert.strictEqual(out.action.reason, "cooldown:spin");
    assert.strictEqual(state.remindCount, 0);
  });

  it("冷却内同 key 复现 → 沉默且不升级", async () => {
    const state = makeState({ cooldownUntil: { spin: 10 }, settledBeats: 9 });
    const key = signalKey(spinSignal());
    state.remindHistory = [{ kind: "spin", beat: 1, factsHash: key }];
    const out = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "silence");
    assert.strictEqual(state.escalationCount, 0);
  });

  it("提醒后复现（过冷却）→ 升级计数 1，再次轻提醒", async () => {
    const state = makeState({ settledBeats: 10 });
    // 先提醒一次拿到真实 key
    const first = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(first.action.action, "remind");
    const key = state.remindHistory[0]!.factsHash;
    assert.strictEqual(state.escalationCount, 0);
    // 过冷却后同信号复现
    const state2 = makeState({ settledBeats: 20, remindHistory: [{ kind: "spin", beat: 10, factsHash: key }] });
    const out = await runDecide(state2, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "remind");
    assert.strictEqual(state2.escalationCount, 1);
    assert.strictEqual(state2.remindCount, 1);
  });

  it("升级计数 ≥2 且未配置 LLM → 安全网：先最后警告", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "safety-warning");
    assert.ok(out.action.message.includes("警告"));
    assert.strictEqual(state.safetyWarningSent, true);
    assert.strictEqual(out.consulted, false);
  });

  it("安全网警告后仍无改善 → stop", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 30,
      escalationCount: 2,
      safetyWarningSent: true,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "stop");
  });

  it("升级计数 ≥2 且配置 LLM → 回调点：执行 LLM 返回的 remind/pause/panel", async () => {
    for (const llmDecision of [
      { decision: { action: "remind", message: "LLM 提醒", reason: "r" }, note: "ok" as const, detail: null },
      { decision: { action: "pause", message: "LLM 暂停", reason: "r" }, note: "ok" as const, detail: null },
      { decision: { action: "panel", question: "LLM 问题", reason: "r" }, note: "ok" as const, detail: null },
      { decision: { action: "silence", reason: "r" }, note: "ok" as const, detail: null },
    ]) {
      const key = signalKey(spinSignal());
      const state = makeState({
        settledBeats: 20,
        escalationCount: 1,
        remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
        cooldownUntil: {},
      });
      const seen: { pack: EvidencePack | null } = { pack: null };
      const out = await runDecide(state, factsWith([spinSignal()]), {
        llm: async (evidence) => {
          seen.pack = evidence;
          return llmDecision as LlmResult;
        },
      });
      assert.strictEqual(out.action.action, llmDecision.decision.action);
      assert.strictEqual(out.consulted, true);
      assert.strictEqual(out.llmNote, "ok");
      assert.strictEqual(state.llmCalls, 1);
      assert.ok(seen.pack !== null, "llm 回调应被调用");
      assert.strictEqual(seen.pack.taskSummary, "任务摘要");
      // 升级计数先于咨询自增（本拍复现已计入），证据包反映与落盘一致的状态（=2）。
      assert.strictEqual(seen.pack.state.escalationCount, 2);
    }
  });

  it("LLM 非法输出（经 parseDecisionOutput）→ silence + invalid 记录", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state, factsWith([spinSignal()]), {
      llm: async () => parseDecisionOutput("不是 JSON"),
    });
    assert.strictEqual(out.action.action, "silence");
    assert.ok(out.action.reason.startsWith("llm-invalid:"));
    assert.strictEqual(out.llmNote, "invalid");
    assert.strictEqual(state.llmCalls, 1);
  });

  it("LLM 返回 stop → 降级 pause 并记录（执行权在内核）", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state, factsWith([spinSignal()]), {
      llm: async () => parseDecisionOutput(JSON.stringify({ action: "stop", reason: "模型认为应停止" })),
    });
    assert.strictEqual(out.action.action, "pause");
    assert.strictEqual(out.llmNote, "stop-downgraded");
    assert.ok(out.action.reason.includes("llm-stop-downgraded"));
    assert.ok(state.llmCalls >= 1);
  });

  it("轻提醒达上限 → 安全网（不再轻提醒）", async () => {
    const state = makeState({ remindCount: 5 });
    const out = await runDecide(state, factsWith([stallSignal()]));
    assert.strictEqual(out.action.action, "safety-warning");
    assert.strictEqual(state.remindCount, 5);
    assert.strictEqual(state.safetyWarningSent, true);
  });

  it("同一信号复现路径也受轻提醒上限约束：达上限 → 安全网，不再 makeRemind（M1）", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      remindCount: 5, // 已达上限
      escalationCount: 0,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const historyLen = state.remindHistory.length;
    const out = await runDecide(state, factsWith([spinSignal()]));
    assert.strictEqual(out.action.action, "safety-warning");
    assert.strictEqual(state.remindCount, 5, "达上限后不得再计数提醒");
    assert.strictEqual(state.remindHistory.length, historyLen, "达上限后不得再入提醒历史");
    assert.strictEqual(state.safetyWarningSent, true);
    assert.strictEqual(state.escalationCount, 1, "复现仍计入升级计数");
  });

  it("LLM 回调抛异常 → 降级 silence + invalid 记录，decide 不抛（B2）", async () => {
    const key = signalKey(spinSignal());
    const state = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state, factsWith([spinSignal()]), {
      llm: async () => {
        throw new Error("回调爆炸");
      },
    });
    assert.strictEqual(out.action.action, "silence");
    assert.strictEqual(out.consulted, true);
    assert.strictEqual(out.llmNote, "invalid");
    assert.ok(out.action.reason.startsWith("llm-invalid:"));
    assert.strictEqual(state.llmCalls, 1);
  });

  it("预算红线 → 优先安全网（即使无信号）", async () => {
    const state = makeState();
    const out = await runDecide(state, factsWith([]), { budgetOver: true });
    assert.strictEqual(out.action.action, "safety-warning");
    assert.strictEqual(state.safetyWarningSent, true);
    assert.strictEqual(state.safetyWarningTrigger, "budget", "预算触发源应记录");
    const out2 = await runDecide(state, factsWith([]), { budgetOver: true });
    assert.strictEqual(out2.action.action, "stop");
  });

  it("LIVE-2 文案按真实原因区分：预算触发不提\"连续提醒\"，spin=持续打转，其余信号=提醒复现（LIVE-1 触发源随发警告记录）", async () => {
    // spin 复现 → 持续打转文案 + 触发源 spin
    const key = signalKey(spinSignal());
    const s1 = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "spin", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out1 = await runDecide(s1, factsWith([spinSignal()]));
    assert.strictEqual(out1.action.action, "safety-warning");
    assert.strictEqual(out1.action.message, SAFETY_WARNING_SPIN_TEXT);
    assert.ok(out1.action.message.includes("持续打转"));
    assert.strictEqual(s1.safetyWarningTrigger, "spin");
    // stall 复现 → 提醒复现文案
    const s2 = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "stall", beat: 5, factsHash: signalKey(stallSignal()) }],
      cooldownUntil: {},
    });
    const out2 = await runDecide(s2, factsWith([stallSignal()]));
    assert.strictEqual(out2.action.action, "safety-warning");
    assert.strictEqual(out2.action.message, SAFETY_WARNING_TEXT);
    assert.strictEqual(s2.safetyWarningTrigger, "stall");
    // 预算到期 → 预算文案，此前并无提醒，不得提及"连续提醒"
    const s3 = makeState();
    const out3 = await runDecide(s3, factsWith([]), { budgetOver: true });
    assert.strictEqual(out3.action.action, "safety-warning");
    assert.strictEqual(out3.action.message, SAFETY_WARNING_BUDGET_TEXT);
    assert.ok(!out3.action.message.includes("连续提醒"), "预算到期文案不得提及\"连续提醒\"");
    assert.strictEqual(s3.safetyWarningTrigger, "budget");
  });

  it("不同 kind 的复现同样计入升级计数（全局计数语义）", async () => {
    const state = makeState({ settledBeats: 5 });
    await runDecide(state, factsWith([stallSignal()])); // 提醒 stall，拿到真实 key
    const key = state.remindHistory[0]!.factsHash;
    // 此前 spin 已升级过 1 次 → 全局计数使 stall 的首次复现直接到 2
    const state2 = makeState({
      settledBeats: 20,
      escalationCount: 1,
      remindHistory: [{ kind: "stall", beat: 5, factsHash: key }],
      cooldownUntil: {},
    });
    const out = await runDecide(state2, factsWith([stallSignal()]));
    assert.strictEqual(out.action.action, "safety-warning");
    assert.strictEqual(state2.escalationCount, 2);
  });

  it("remindMessage 模板覆盖四种信号且含证据", () => {
    assert.ok(remindMessage(spinSignal()).includes("原地重复"));
    assert.ok(remindMessage(stallSignal()).includes("停滞"));
    assert.ok(remindMessage({ kind: "failure-cluster", severity: 2, facts: { window: 5, "errors-in-window": 3 } }).includes("失败"));
    assert.ok(remindMessage({ kind: "context-pressure", severity: 1, facts: { ratio: 0.9 } }).includes("上下文"));
  });

  it("context-pressure ratio 0.9 显示为 90%（m1：乘 100）", () => {
    const msg = remindMessage({ kind: "context-pressure", severity: 1, facts: { ratio: 0.9 } });
    assert.ok(msg.includes("90%"), msg);
    assert.ok(!msg.includes("0.9%"), "不得把 0.9 直接当百分比显示");
    // ratio 缺失 → 防御性占位
    assert.ok(remindMessage({ kind: "context-pressure", severity: 1, facts: {} }).includes("?"));
  });

  it("buildSteerText：LLM 只选 action，steer 文案由内核模板+机械事实组装（B3）", () => {
    const facts = factsWith([spinSignal()]);
    const remind = buildSteerText(facts, { action: "remind", message: "LLM 自由文本", reason: "r" });
    assert.ok(remind.includes("原地重复"));
    assert.ok(!remind.includes("LLM 自由文本"), "LLM message 不得进入 steer");
    const pause = buildSteerText(facts, { action: "pause", message: "LLM 暂停文本", reason: "r" });
    assert.ok(pause.startsWith("[监督暂停]"));
    assert.ok(pause.includes("重复了 3 次"));
    assert.ok(!pause.includes("LLM 暂停文本"));
    // LIVE-2：safety-warning 文案按触发源由内核模板区分（LLM schema 无此 action，
    // message 永为内核模板，buildSteerText 原样透传）
    assert.strictEqual(
      buildSteerText(facts, { action: "safety-warning", message: SAFETY_WARNING_TEXT, reason: "r" }),
      SAFETY_WARNING_TEXT,
    );
    assert.strictEqual(
      buildSteerText(facts, { action: "safety-warning", message: SAFETY_WARNING_BUDGET_TEXT, reason: "r" }),
      SAFETY_WARNING_BUDGET_TEXT,
    );
    // 无信号时防御性回退
    assert.ok(buildSteerText(factsWith([]), { action: "remind", message: "m", reason: "r" }).includes("监督提醒"));
  });
});
