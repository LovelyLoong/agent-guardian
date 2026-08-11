/**
 * agent-guardian — 机械决策树（纯逻辑，可单测）。
 *
 * 决策树（设计 §3.3）：
 * 1. 无信号 → 沉默。
 * 2. 有信号且非冷却/非重复 → 机械提醒（模板含证据），计数 + 冷却 3 拍；轻提醒上限。
 * 3. 同一信号提醒后复现（升级计数 ≥2）→ LLM 回调点（若配置）：发证据包，
 *    执行返回的合法决定；未配置 → 安全网判定。LLM 咨询与同 kind 信号共享
 *    冷却窗口，并受全局上限（默认 3，可配）约束；超限回到机械安全网路径。
 * 4. 机械红线（升级 ≥2 且无 LLM / 轻提醒达上限 / 超预算）→ 安全网：
 *    先发最后警告，下一拍无改善 → stop。LLM 返回的 stop 一律降级为 pause
 *    （在 llm.ts 完成，执行权在内核）。
 *
 * steer 文案红线（B2）：用户可见文本（提醒/暂停/警告）只含机械事实，
 * facts 值统一经 sanitizeText 净化（去 ANSI 转义/控制字符），防注入。
 *
 * 升级计数语义：状态机只有一个全局 escalationCount（设计 §3.3 状态形状如此），
 * 任一信号在提醒后复现都计入升级，≥2 触发 LLM 回调点。
 *
 * @module
 */

import { computeArgsHash } from "../../../pi-task-governor/src/signals.ts";
import type { Signal } from "../../../pi-task-governor/src/contract.ts";
import { sanitizeText } from "./sanitize.ts";
import type { BeatFacts } from "../targets/types.ts";
import type { WatchState } from "./state.ts";
import type { EvidencePack, LlmNote, LlmResult } from "./llm.ts";

export type DecisionAction =
  | { action: "silence"; reason: string }
  | { action: "remind"; message: string; reason: string }
  | { action: "pause"; message: string; reason: string }
  | { action: "panel"; question: string; reason: string }
  | { action: "safety-warning"; message: string; reason: string }
  | { action: "stop"; reason: string };

export interface DecideOutcome {
  action: DecisionAction;
  /** 本次决定是否经过了 LLM 回调 */
  consulted: boolean;
  /** LLM 输出处理结果（未咨询时为 null） */
  llmNote: LlmNote | null;
}

export interface DecideOptions {
  /** 轻提醒上限（默认 5） */
  remindMax: number;
  /** 冷却拍数（默认 3）：提醒/LLM 咨询后该 kind 抑制其后 cooldownBeats 拍（含边界拍，m1） */
  cooldownBeats: number;
  /** 每 watch LLM 回调全局上限（默认 3）；超限回到机械安全网路径（M1） */
  llmMaxCalls: number;
}

export interface DecideContext {
  facts: BeatFacts;
  /** 就地变更；调用方在决定执行后落盘 */
  state: WatchState;
  /** wall-clock 是否超预算（生命周期红线之一） */
  budgetOver: boolean;
  opts: DecideOptions;
  llmConsult: ((evidence: EvidencePack) => Promise<LlmResult>) | null;
  /** 惰性构造证据包（仅在真正咨询 LLM 时调用） */
  makeEvidence: () => EvidencePack;
}

/** 安全网最后警告文本（内核模板，用户可见；提醒复现/持续打转以外的信号触发）。 */
export const SAFETY_WARNING_TEXT =
  "[监督警告] 连续提醒未见改善，监督将采取停止措施。如仍需继续，请直接说明目标与下一步。";

/** 安全网最后警告文本（内核模板；持续打转触发，LIVE-2 按真实原因区分）。 */
export const SAFETY_WARNING_SPIN_TEXT =
  "[监督警告] 检测到持续打转，连续提醒未见改善，监督将采取停止措施。如仍需继续，请直接说明目标与下一步。";

/** 安全网最后警告文本（内核模板；预算到期触发，LIVE-2：不得提及\"连续提醒\"——此前并无提醒）。 */
export const SAFETY_WARNING_BUDGET_TEXT =
  "[监督警告] 监督时长已达预算，监督将采取停止措施。如仍需继续，请直接说明目标与下一步。";

/** 信号种类稳定排序（同级时按此顺序取一个） */
const KIND_ORDER = ["spin", "failure-cluster", "stall", "context-pressure"] as const;

export async function decide(ctx: DecideContext): Promise<DecideOutcome> {
  // 超预算红线优先于一切信号判断
  if (ctx.budgetOver) {
    return { action: safetyNetAction(ctx.state, "budget", "监督时长已达预算，进入收尾"), consulted: false, llmNote: null };
  }

  if (ctx.facts.signals.length === 0) {
    return { action: { action: "silence", reason: "no-signals" }, consulted: false, llmNote: null };
  }

  const signal = pickStrongest(ctx.facts.signals);
  const key = signalKey(signal);
  const now = ctx.state.settledBeats;
  const prev = ctx.state.remindHistory.find((h) => h.kind === signal.kind && h.factsHash === key);
  // m1：冷却含边界拍——cooldownUntil=3 表示 beat 0 提醒后，beat 1/2/3 抑制（>= 判含）、
  // beat 4 可再提醒；与 state.ts 的“冷却到第几拍（含）”注释一致。
  const inCooldown = (ctx.state.cooldownUntil[signal.kind] ?? -1) >= now;

  if (prev !== undefined) {
    // 同一信号提醒后复现
    if (inCooldown) {
      return { action: { action: "silence", reason: `cooldown:${signal.kind}` }, consulted: false, llmNote: null };
    }
    ctx.state.escalationCount++;
    if (ctx.state.escalationCount >= 2) {
      if (ctx.llmConsult !== null && ctx.state.llmCalls < ctx.opts.llmMaxCalls) {
        // M1：LLM 调用与同 kind 信号共享冷却窗口（本拍咨询后该 kind 进入冷却，
        // 下拍起抑制），并受全局上限约束；超限后落到下方机械安全网，不再咨询。
        ctx.state.llmCalls++;
        ctx.state.cooldownUntil[signal.kind] = ctx.state.settledBeats + ctx.opts.cooldownBeats;
        let res: LlmResult;
        try {
          res = await ctx.llmConsult(ctx.makeEvidence());
        } catch (err) {
          // 回调异常（含证据包写入失败）：降级 silence + 记录，watcher 不得崩溃
          return {
            action: { action: "silence", reason: `llm-invalid: 回调异常: ${String(err)}` },
            consulted: true,
            llmNote: "invalid",
          };
        }
        return { action: res.decision, consulted: true, llmNote: res.note };
      }
      return { action: safetyNetAction(ctx.state, signal.kind, `信号反复未见改善（${signal.kind}）`), consulted: false, llmNote: null };
    }
    // 首次复现：同样受轻提醒上限约束（达上限 → 安全网，不再轻提醒）
    if (ctx.state.remindCount >= ctx.opts.remindMax) {
      return { action: safetyNetAction(ctx.state, signal.kind, "轻提醒已达上限"), consulted: false, llmNote: null };
    }
    return { action: makeRemind(ctx.state, signal, key, ctx.opts, "同信号再次提醒"), consulted: false, llmNote: null };
  }

  // 新信号
  if (inCooldown) {
    return { action: { action: "silence", reason: `cooldown:${signal.kind}` }, consulted: false, llmNote: null };
  }
  if (ctx.state.remindCount >= ctx.opts.remindMax) {
    return { action: safetyNetAction(ctx.state, signal.kind, "轻提醒已达上限"), consulted: false, llmNote: null };
  }
  return { action: makeRemind(ctx.state, signal, key, ctx.opts, "机械提醒"), consulted: false, llmNote: null };
}

function pickStrongest(signals: Signal[]): Signal {
  let best = signals[0]!;
  for (const s of signals) {
    if (s.severity > best.severity) {
      best = s;
    } else if (s.severity === best.severity) {
      const a = KIND_ORDER.indexOf(best.kind as (typeof KIND_ORDER)[number]);
      const b = KIND_ORDER.indexOf(s.kind as (typeof KIND_ORDER)[number]);
      if (b >= 0 && (a < 0 || b < a)) best = s;
    }
  }
  return best;
}

/** 信号身份键：kind + 关键事实摘要（内容寻址，同一信号复现可识别）。 */
export function signalKey(signal: Signal): string {
  return computeArgsHash(signal.facts as Record<string, unknown>, `signal:${signal.kind}`);
}

function makeRemind(
  state: WatchState,
  signal: Signal,
  key: string,
  opts: DecideOptions,
  reason: string,
): DecisionAction {
  state.remindCount++;
  state.cooldownUntil[signal.kind] = state.settledBeats + opts.cooldownBeats;
  state.remindHistory.push({ kind: signal.kind, beat: state.settledBeats, factsHash: key });
  state.lastAction = "remind";
  return { action: "remind", message: remindMessage(signal), reason };
}

/**
 * 安全网动作（LIVE-1/LIVE-2）：首警告记录触发源（state.safetyWarningTrigger，持久化，
 * 供 loop 层判定"触发警告的信号已消失"）并按真实原因选文案；警告已发 → stop。
 */
function safetyNetAction(state: WatchState, trigger: string, reason: string): DecisionAction {
  if (!state.safetyWarningSent) {
    state.safetyWarningSent = true;
    state.safetyWarningTrigger = trigger;
    state.lastAction = "safety-warning";
    return { action: "safety-warning", message: warningText(trigger), reason };
  }
  state.lastAction = "stop";
  return { action: "stop", reason };
}

/** 按触发源选警告文案（LIVE-2）：预算到期不提"连续提醒"；spin=持续打转；其余信号=提醒复现。 */
function warningText(trigger: string): string {
  if (trigger === "budget") return SAFETY_WARNING_BUDGET_TEXT;
  if (trigger === "spin") return SAFETY_WARNING_SPIN_TEXT;
  return SAFETY_WARNING_TEXT;
}

/**
 * 信号机械事实摘要（单行，只含机械事实）：提醒/暂停/面板引导共用。
 */
export function signalSummary(signal: Signal): string {
  const f = signal.facts;
  switch (signal.kind) {
    case "spin":
      return `最近 ${num(f["window"])} 次操作里，同一操作重复了 ${num(f["repeat-count"])} 次`;
    case "stall":
      return `连续 ${num(f["calls-since-success"])} 次操作没有成功保存进展`;
    case "failure-cluster":
      return `最近 ${num(f["window"])} 次操作中有 ${num(f["errors-in-window"])} 次失败`;
    case "context-pressure":
      return `已用约 ${ratioPct(f["ratio"])}% 的上下文空间`;
  }
}

/** 内核证据摘要：当前最强信号的机械事实（无信号时给防御性文案）。 */
export function evidenceSummary(facts: BeatFacts): string {
  if (facts.signals.length === 0) return "检测到需要关注的信号";
  return signalSummary(pickStrongest(facts.signals));
}

/**
 * 内核组装 steer 文案（design §0 红线）：LLM 只选 action，
 * message/reason/question 永不原样 steer；文案 = 内核模板 + 机械事实。
 */
export function buildSteerText(facts: BeatFacts, action: DecisionAction): string {
  switch (action.action) {
    case "remind":
      return facts.signals.length > 0
        ? remindMessage(pickStrongest(facts.signals))
        : "[监督提醒] 检测到需要关注的信号，请核对目标与当前进度。";
    case "pause":
      return `[监督暂停] ${evidenceSummary(facts)}。请暂停当前操作，核对目标与当前进度后再继续。`;
    case "safety-warning":
      // 内核组装文案（LIVE-2）：按触发源区分；safety-warning 只可能来自内核
      // safetyNetAction（LLM schema 不含此 action），message 永为内核模板。
      return action.message;
    default:
      return "";
  }
}

/**
 * 提醒模板（steer 文本，用户可见）：只含具体证据，不含内部词汇。
 */
export function remindMessage(signal: Signal): string {
  switch (signal.kind) {
    case "spin":
      return `[监督提醒] 检测到可能的原地重复：${signalSummary(signal)}。请先确认目标与当前进度是否一致，再继续。`;
    case "stall":
      return `[监督提醒] 检测到进展停滞：${signalSummary(signal)}。请检查是否卡住，必要时调整做法。`;
    case "failure-cluster":
      return `[监督提醒] 检测到连续失败：${signalSummary(signal)}。请先查明失败原因再继续。`;
    case "context-pressure":
      return `[监督提醒] 检测到上下文压力：${signalSummary(signal)}。请考虑精简上下文或尽快收尾。`;
  }
}

function num(v: number | string | undefined): string {
  // B2：facts 值进用户可见文本前统一净化（去 ANSI 转义/控制字符、截断）
  return v === undefined ? "?" : sanitizeText(String(v));
}

/** 上下文占用比（0..1）显示为百分比整数：0.9 → 90%（m1）。 */
function ratioPct(v: number | string | undefined): string {
  if (typeof v === "number") return String(Math.round(v * 100));
  return num(v);
}
