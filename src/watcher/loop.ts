/**
 * agent-guardian — watcher 节拍循环。
 *
 * 节拍（设计 §3.2）：waitIdle → read 拿游标 → 游标不前进则 sleep 60s 进下一拍
 * （不取证）→ 前进则 resolveFacts 取证 → decide → 执行。
 *
 * 生命周期（Orca 实测语义，设计 §3.4）：
 * - connected:false → 主对话框已被用户关闭 → 当拍写完工汇报 → 退出 0
 *   （不当作普通 alive:false 等两次）；
 * - waitIdle stale / read 抛异常 / read alive:false 统一累计不可达计数（B1），
 *   连续 2 次 → PTY 真死 → 同路径退出；仅"read 成功且 alive:true"清零；
 * - wall-clock 超预算：目标静止（waitIdle idle）→ 直接收尾退出；
 *   目标仍 busy 但无新输出（waitIdle timeout）→ 安全网（最后警告 → 无改善 → 停止）
 *   → 完工汇报 → 退出 0（B2）；
 * - SIGINT → 落盘退出 130（由 CLI 层注册）。
 *
 * 取证纪律（design §3.2 + M3 + B2）：resolveFacts 成功才推进并持久化新游标；
 * 取证异常 → 本拍游标不变、落 degraded 事件，下拍重试；从未成功取证时
 * （含首拍取证失败且游标为空）下拍不得跳过取证。取证失败纳入统一预算检查
 * 与连续失败上限（≥10 次，目标适配器持续损坏属不可恢复）→ 汇报退出，不无限重试。
 *
 * 安全网承诺（B1）：最后警告发出后，下一拍无改善（同类信号复现，或游标
 * 不前进且仍 alive）→ 必须 stop；无进展分支在任何预算检查之前先兑现此承诺。
 * 游标前进的拍同样在 decide 前统一兑现（残差 blocker 修复）：警告后下一拍
 * 无真实改善（isGenuineImprovement=false，含"触发信号消失但 newToolCalls=0"）→
 * 无论预算是否到期一律 executeStop，不再重复警告——连续 cursor-only beats
 * 不得静默续跑。
 * postWarning 从持久化 state.safetyWarningSent 恢复——崩溃续跑不得绕过 stop。
 * 警告闩锁（LIVE-1 收紧）："取证成功"与"游标前进"均不算改善——目标回应警告
 * 本身就会前进游标，是幻影改善。只有"触发警告的信号已消失（state.safetyWarningTrigger
 * 记录的触发源；预算到期触发永不消失）且自警告起 newToolCalls>0（干活证据）"
 * 才清除 postWarning 并持久化 safetyWarningSent=false；预算到期场景警告后下一拍
 * 无真实改善 → 必须 executeStop（steer 抑制窗，不得再发第二次警告）。
 * 空游标恢复（state.cursor 持久化为空）+ 警告在身 + 游标不前进 → 取证前先兑现 stop 承诺。
 * M2：会话适配器（--terminal + --session，目标 kind pi/codex）是例外——它有独立证据源
 * （会话文件），先取证一次再判：newToolCalls>0 → 清闩（改善，不 stop）；否则（无新增调用
 * 或取证失败）→ stop。纯 terminal 目标无证据源 → 维持取证前直接 stop（design §3.2）。
 * 每发一次警告只给一拍宽限，改善后静止拍不得再 stop。
 * 有警告在身的恢复若取证持续失败，按预算/连续失败上限退出前仍须先执行 stop（B1）。
 *
 * 事件落盘降级（M3）：所有路径（常规记录/steer/stop/finish）统一经
 * recordOrDegrade 包装——append 失败即标记 state.eventsDegraded，报告显式标注。
 *
 * 文案红线（design §0 + B3）：LLM 只选 action；steer 文案由内核模板+机械事实
 * 组装（buildSteerText，facts 值经 sanitizeText 净化）；LLM 自由文本只进事件记录。
 *
 * file 通道为纯观察：send/stop 不支持，提醒/警告/停止全部只记录事件。
 *
 * @module
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "../channels/types.ts";
import { UnsupportedError } from "../channels/types.ts";
import type { EventStore } from "../events.ts";
import type { TargetAdapter, BeatFacts } from "../targets/types.ts";
import {
  decide,
  buildSteerText,
  evidenceSummary,
  SAFETY_WARNING_BUDGET_TEXT,
  type DecideOptions,
  type DecideOutcome,
} from "./decide.ts";
import { buildEvidencePack, type EvidencePack, type LlmResult } from "./llm.ts";
import { sanitizeText } from "./sanitize.ts";
import type { StateStore, WatchState } from "./state.ts";
import { initialState } from "./state.ts";
import { generateReport } from "./report.ts";

export const NO_PROGRESS_SLEEP_MS = 60_000;
export const STALE_LIMIT = 2;
export const MAX_CONSECUTIVE_FACTS_ERRORS = 10;
export const BUDGET_CHECK_SLACK_MS = 10_000;
export const POST_WARNING_WAIT_MS = 10_000;
export const WAIT_IDLE_MAX_MS = 600_000;
export const PANEL_MEMBER_TIMEOUT_MS = 30 * 60_000;

export interface WatchOptions {
  watchId: string;
  handle: string;
  budgetMs: number;
  remindMax: number;
  /** 每 watch LLM 回调全局上限（默认 3；M1） */
  llmMaxCalls?: number;
  sessionFile: string | null;
  /** 面板方向流程（LLM 返回 panel）的执行器；null = 跳过并记录 */
  runPanel: ((question: string) => Promise<string | null>) | null;
}

export interface WatchServices {
  channel: Channel;
  target: TargetAdapter;
  state: StateStore;
  events: EventStore;
  reportsDir: string;
  llmConsult: ((evidence: EvidencePack) => Promise<LlmResult>) | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface WatchResult {
  exitCode: number;
  state: WatchState;
  reportPath: string | null;
}

/**
 * 运行监督循环直至正常收尾。返回进程退出码。
 */
export async function runWatch(opts: WatchOptions, services: WatchServices): Promise<WatchResult> {
  const existing = await services.state.load(opts.watchId);
  const state = existing ?? initialState({
    watchId: opts.watchId,
    budgetMs: opts.budgetMs,
    targetKind: services.target.kind,
    channelKind: services.channel.kind,
    handle: opts.handle,
    sessionFile: opts.sessionFile,
    now: services.now(),
  });

  if (existing === null) {
    recordOrDegrade(services, opts, state, {
      type: "watch_start",
      targetKind: services.target.kind,
      channelKind: services.channel.kind,
      handle: opts.handle,
      sessionFile: opts.sessionFile,
    });
  } else {
    recordOrDegrade(services, opts, state, { type: "watch_resume", settledBeats: state.settledBeats });
  }
  await services.state.save(opts.watchId, state);

  const decideOpts: DecideOptions = {
    remindMax: opts.remindMax,
    cooldownBeats: 3,
    llmMaxCalls: opts.llmMaxCalls ?? 3, // M1：全局上限，超限回机械安全网
  };
  // B1：统一不可达计数——waitIdle stale / read 抛异常 / read alive:false 全部累计；
  // 仅"read 成功且 alive:true"清零；连续 2 次 → 写完工汇报退出。
  let staleCount = 0;
  // B1：崩溃恢复不绕过安全网——postWarning 必须从持久化 state.safetyWarningSent
  // 恢复（首次运行时 initialState 恒为 false，恢复续跑时为上次落盘值）；
  // 触发源同样从持久化 state.safetyWarningTrigger 恢复（LIVE-1 改善判定口径）。
  let postWarning = state.safetyWarningSent;
  // B2：连续取证失败计数（成功取证清零）；达上限即目标适配器持续损坏 → 汇报退出。
  let consecutiveFactsErrors = 0;
  // M3：是否有过成功取证（独立记录，不依赖 settledBeats）。从未成功取证时，
  // 即使游标为空/未前进也不得跳过取证——首次取证失败后次拍必然重试。
  // B1：恢复时用持久化 state.cursor 初始化——state.cursor 本就是"最近一次成功
  // 取证后的游标"（M3 语义保证），恢复后 read.cursor 等于它即"无进展"，必须
  // 走安全网/预算分支，不得被取证分支拦截。空游标保留 null：空游标可能是从未
  // 取证，也可能取证成功但游标为空，两者均须取证（M3 边界不收紧）。
  let lastGoodCursor: string | null = state.cursor === "" ? null : state.cursor;
  const record = (event: { type: string; [key: string]: unknown }): void => {
    recordOrDegrade(services, opts, state, event); // M3：统一包装，append 失败即标记降级
  };

  for (;;) {
    // 预算感知的 waitIdle：保证超预算后及时醒来进入安全网（而非干等 600s）
    const remaining = state.startedAt + state.budgetMs - services.now();
    const waitMs = postWarning
      ? POST_WARNING_WAIT_MS
      : clamp(remaining + BUDGET_CHECK_SLACK_MS, 10_000, WAIT_IDLE_MAX_MS);

    let idle: "idle" | "timeout" | "stale";
    try {
      idle = await services.channel.waitIdle(opts.handle, waitMs);
    } catch {
      idle = "stale";
    }
    if (idle === "stale") {
      staleCount++;
      record({ type: "target-unreachable", note: "waitIdle 无法触达被观察对象" });
      if (staleCount >= STALE_LIMIT) {
        record({ type: "target-gone", reason: "连续两次无法触达被观察对象" });
        return finish(services, opts, state, 0, "目标连续不可达");
      }
      // B1：不可达路径必须退避，消除微任务饥饿空转
      await services.sleep(NO_PROGRESS_SLEEP_MS);
      continue;
    }

    let read;
    try {
      read = await services.channel.read(opts.handle);
    } catch {
      staleCount++;
      record({ type: "target-unreachable", note: "read 抛异常" });
      if (staleCount >= STALE_LIMIT) {
        return finish(services, opts, state, 0, "目标连续不可达");
      }
      await services.sleep(NO_PROGRESS_SLEEP_MS);
      continue;
    }
    // 生命周期红线（Orca 实测语义，design §3.4）：connected:false = 主对话框已被用户关闭
    // → 当拍写完工汇报退出，不得当作普通 alive:false 等两次。
    if (read.closed === true) {
      record({ type: "target-closed", note: "被观察终端的主对话框已关闭" });
      return finish(services, opts, state, 0, "被观察终端已关闭（主对话框已关闭）");
    }
    if (!read.alive) {
      staleCount++;
      record({ type: "target-unreachable", note: "read 报告不可用" });
      if (staleCount >= STALE_LIMIT) {
        return finish(services, opts, state, 0, "目标连续不可达");
      }
      await services.sleep(NO_PROGRESS_SLEEP_MS);
      continue;
    }
    staleCount = 0; // 仅 read 成功且 alive:true 清零（B1）

    // 游标纪律：不前进且有过成功取证 → 不取证，sleep 后进下一拍。
    // M3：从未成功取证（lastGoodCursor === null，含首拍取证失败且游标为空）→ 不得跳过取证。
    if (read.cursor === state.cursor && lastGoodCursor !== null) {
      state.settledBeats++;
      await services.state.save(opts.watchId, state);
      // B1 + M2：安全网最后警告已发出 → 本拍无进展（游标不前进且仍 alive）→ 判定改善：
      // 会话适配器（--terminal + --session）先取证一次——newToolCalls>0 → 清闩（改善）；
      // 否则（无新增调用/取证失败）或纯 terminal 目标（无证据源）→ 立即 stop。
      // 不得只在预算到期分支检查 postWarning（否则预算未到期时警告后永不停止）。
      if (postWarning) {
        if ((await warningNoProgressVerdict(services, state)) === "continue") {
          postWarning = false;
          state.safetyWarningSent = false;
          state.safetyWarningTrigger = null;
          await services.state.save(opts.watchId, state);
          record({ type: "safety-warning-cleared", note: "触发信号已消失且会话文件有新增调用（newToolCalls>0），清闩" });
        } else {
          await executeStop(services, opts, state, "最后警告后目标无改善（安全网）");
          return finish(services, opts, state, 0, "安全网收尾：最后警告后无改善，已停止");
        }
      }
      if (services.now() >= state.startedAt + state.budgetMs) {
        if (idle === "idle") {
          // B2：目标真的停了（waitIdle 确认 idle）→ 预算到期直接汇报退出，无警告/停止必要
          record({ type: "budget-expired-idle", note: "目标静止且预算到期" });
          return finish(services, opts, state, 0, "预算到期，目标静止");
        }
        // B2：waitIdle timeout = 目标仍 busy 但无新输出 → 预算到期走安全网序列：
        // 最后警告 → 下拍无改善 → stop → 汇报退出。触发源记 budget（LIVE-1：
        // 预算单调不消失 → 永不改善，下拍必 stop）；文案用预算版（LIVE-2：不提"连续提醒"）。
        state.safetyWarningSent = true;
        state.safetyWarningTrigger = "budget";
        state.lastAction = "safety-warning";
        await services.state.save(opts.watchId, state);
        await steerOrRecord(services, opts, state, "safety-warning", SAFETY_WARNING_BUDGET_TEXT);
        postWarning = true;
        continue;
      }
      await services.sleep(NO_PROGRESS_SLEEP_MS);
      continue;
    }
    // B2 + M2：空游标恢复（lastGoodCursor===null，state.cursor 持久化为空）+ 警告在身
    // + 游标不前进 → 先兑现 stop 承诺；会话适配器（--terminal + --session）例外：
    // 先取证一次再判——newToolCalls>0 → 清闩（改善，不 stop）；否则（无新增调用或
    // 取证失败，以及纯 terminal 目标无证据源）→ 取证前即 stop。不得先取证再用旧 M1 的
    // "取证成功=改善"清闩（同游标+warning 在身时取证成功会清闩 → 永不 stop）。
    if (read.cursor === state.cursor && postWarning) {
      if ((await warningNoProgressVerdict(services, state)) === "continue") {
        postWarning = false;
        state.safetyWarningSent = false;
        state.safetyWarningTrigger = null;
        state.settledBeats++;
        await services.state.save(opts.watchId, state);
        record({ type: "safety-warning-cleared", note: "会话文件新增调用（newToolCalls>0），清闩" });
        await services.sleep(NO_PROGRESS_SLEEP_MS);
        continue;
      }
      await executeStop(services, opts, state, "最后警告后目标无改善（安全网）");
      return finish(services, opts, state, 0, "安全网收尾：最后警告后无改善，已停止");
    }

    // 取证（游标纪律，design §3.2 + M3）：resolveFacts 成功才推进并持久化新游标；
    // 异常 → 本拍游标不变、落 degraded 事件，下拍重试。
    // 游标取通道的 read.cursor（idle 判定的权威）：适配器可能对空游标原样透传，
    // 若存适配器返回值会把空串存回，导致永不 idle。
    let facts;
    try {
      const resolved = await services.target.resolveFacts(state.cursor);
      facts = resolved.facts;
    } catch {
      // B2：取证失败纳入统一预算检查 + 连续失败上限——wall-clock 超预算或连续
      // 失败达上限（目标适配器持续损坏，不可恢复）→ 汇报退出（degraded 收尾），
      // 不得无限重试、不得绕过预算静默空转。
      consecutiveFactsErrors++;
      record({ type: "facts-error", note: "取证失败，本拍跳过（游标不变，下拍重试）" });
      if (services.now() >= state.startedAt + state.budgetMs) {
        record({ type: "facts-error-exhausted", note: "取证持续失败且预算到期，收尾退出" });
        // B1：有警告在身的恢复（目标仍 alive 且 warning 已发）——取证失败不得绕过
        // stop 承诺：按预算/连续失败上限退出前仍须先执行 stop。
        if (postWarning) {
          await executeStop(services, opts, state, "最后警告后目标无改善且取证持续失败（安全网）");
        }
        return finish(services, opts, state, 0, "取证持续失败且预算到期（degraded）");
      }
      if (consecutiveFactsErrors >= MAX_CONSECUTIVE_FACTS_ERRORS) {
        record({
          type: "facts-error-exhausted",
          note: `连续取证失败已达 ${MAX_CONSECUTIVE_FACTS_ERRORS} 次，目标适配器持续不可用，收尾退出`,
        });
        if (postWarning) {
          await executeStop(services, opts, state, "最后警告后目标无改善且取证持续失败（安全网）");
        }
        return finish(services, opts, state, 0, "连续取证失败超上限，目标适配器持续不可用（degraded）");
      }
      state.settledBeats++;
      await services.state.save(opts.watchId, state);
      await services.sleep(NO_PROGRESS_SLEEP_MS);
      continue;
    }
    consecutiveFactsErrors = 0; // B2：成功取证清零连续失败计数
    state.cursor = read.cursor;
    lastGoodCursor = read.cursor; // M3：成功取证后记录
    const budgetOver = services.now() >= state.startedAt + state.budgetMs;
    // LIVE-1 清闩收紧：游标前进永不清安全闩（目标回应警告本身就会前进游标，是幻影改善）。
    // 只有"触发警告的信号已消失 且 自警告起 newToolCalls>0（干活证据）"才算改善；
    // budget 触发（预算单调不消失）→ 永不改善 → 下拍必 stop。游标不前进+警告在身的拍
    // 已由上面的 M2 探针分支拦截，到不了此处。
    // M1 安全网承诺（残差 blocker 修复）：警告后下一拍无真实改善 → 无论预算是否到期、
    // 无论走哪条分支，都必须 executeStop 一次且不再重复警告。旧代码此处只清闩、
    // 清闩失败的路径直接落入 decide——触发信号消失但 newToolCalls=0 时 decide 返回
    // silence → 连续 cursor-only beats 永不停止（探针）。统一判定：无真实改善 →
    // executeStop（与预算路径同一出口），有真实改善 → 清闩并继续进 decide。
    if (postWarning) {
      if (isGenuineImprovement(facts, state, budgetOver)) {
        postWarning = false;
        state.safetyWarningSent = false;
        state.safetyWarningTrigger = null;
        await services.state.save(opts.watchId, state);
        record({ type: "safety-warning-cleared", note: "触发信号已消失且自警告起有新增工具调用，清闩" });
      } else {
        await executeStop(services, opts, state, "最后警告后目标无改善（安全网）");
        return finish(services, opts, state, 0, "安全网收尾：最后警告后无改善，已停止");
      }
    }
    // M2（设计行为，非缺陷）：预算到期 + 游标本拍前进 = 目标仍活跃 → decide 预算红线
    // 优先 → 安全网序列（最后警告 → 下拍无改善 → stop）。活跃目标不得走"静止直接收尾"。
    let outcome: DecideOutcome;
    try {
      outcome = await decide({
        facts,
        state,
        budgetOver,
        opts: decideOpts,
        llmConsult: services.llmConsult,
        makeEvidence: () => buildEvidencePack(facts, state, services.events.read(opts.watchId).slice(-20)),
      });
    } catch (err) {
      // 决策异常（理论不应发生；LLM 回调/取证异常已在 llm.ts/decide.ts 内捕获）：
      // 落 degraded 事件后继续，watcher 不得崩溃。
      record({ type: "decide-error", note: `决策异常，本拍跳过: ${String(err)}` });
      state.settledBeats++;
      await services.state.save(opts.watchId, state);
      await services.sleep(NO_PROGRESS_SLEEP_MS);
      continue;
    }

    if (outcome.consulted) {
      // B3：LLM 自由文本（message/question）只进事件记录，永不原样 steer。
      const ev: { type: string; [key: string]: unknown } = {
        type: "llm_call",
        note: outcome.llmNote ?? "ok",
        decision: outcome.action.action,
        reason: outcome.action.reason,
      };
      if (outcome.action.action === "panel") ev["question"] = outcome.action.question;
      else if ("message" in outcome.action) ev["message"] = outcome.action.message;
      record(ev);
    }
    // 有信号的拍一律落 decide 事件（含冷却沉默），供报告统计真实触发的信号种类。
    if (outcome.action.action !== "silence" || facts.signals.length > 0) {
      record({
        type: "decide",
        action: outcome.action.action,
        reason: outcome.action.reason,
        signals: facts.signals.map((s) => s.kind),
      });
    }

    switch (outcome.action.action) {
      case "silence":
        break;
      case "remind":
        await steerOrRecord(services, opts, state, "remind", buildSteerText(facts, outcome.action));
        break;
      case "pause":
        await steerOrRecord(services, opts, state, "pause", buildSteerText(facts, outcome.action));
        break;
      case "safety-warning":
        await steerOrRecord(services, opts, state, "safety-warning", buildSteerText(facts, outcome.action));
        postWarning = true;
        break;
      case "panel": {
        // B3：panel question 允许 LLM 提供，但须净化（去控制字符、上限 2000）且拼上内核证据摘要
        const question = sanitizeText(outcome.action.question);
        await steerOrRecord(services, opts, state, "pause", `[监督] ${evidenceSummary(facts)}。讨论组问题：${question}`);
        if (opts.runPanel !== null) {
          try {
            const conclusion = await opts.runPanel(question);
            if (conclusion !== null && conclusion !== "") {
              await steerOrRecord(services, opts, state, "resume", `[监督] 讨论组结论：${sanitizeText(conclusion)}`);
            }
          } catch (err) {
            record({ type: "panel-failed", note: String(err) });
          }
        } else {
          record({ type: "panel-skipped", reason: "未配置讨论组执行器" });
        }
        break;
      }
      case "stop":
        await executeStop(services, opts, state, outcome.action.reason);
        return finish(services, opts, state, 0, "安全网收尾：已停止目标");
    }

    state.settledBeats++;
    await services.state.save(opts.watchId, state);
  }
}

/**
 * LIVE-1 真实改善口径：触发警告的信号已消失 且 自警告起 newToolCalls>0（干活证据）。
 * 游标前进不计入（目标回应警告本身就会前进游标，是幻影改善）。
 * - 触发源 "budget"（预算到期）：预算单调不消失 → 永不改善 → 次拍必须 stop；
 * - 触发源为信号 kind：该 kind 不再出现在当前信号集即"已消失"；
 * - 触发源未知（旧状态恢复，无 safetyWarningTrigger）：保守——须完全无信号且未超预算。
 */
function isGenuineImprovement(facts: BeatFacts, state: WatchState, budgetOver: boolean): boolean {
  if (facts.newToolCalls <= 0) return false;
  const trigger = state.safetyWarningTrigger;
  if (trigger === "budget") return false;
  if (trigger !== null && trigger !== undefined) {
    return !facts.signals.some((s) => s.kind === trigger);
  }
  return !budgetOver && facts.signals.length === 0;
}

/**
 * M2：warning 在身 + 终端游标不前进时的安全网判定。
 * - 会话适配器（pi/codex，--terminal + --session 组合）有独立证据源（会话文件）：
 *   先取证一次再判——触发信号已消失且 newToolCalls>0 → "continue"（真实改善，调用方清闩不 stop）；
 *   否则（信号仍在/无新增调用/取证失败）→ "stop"。
 * - 纯 terminal 目标无证据源 → 维持取证前直接 "stop"（design §3.2）。
 */
async function warningNoProgressVerdict(
  services: WatchServices,
  state: WatchState,
): Promise<"stop" | "continue"> {
  if (services.target.kind === "pi" || services.target.kind === "codex") {
    try {
      const resolved = await services.target.resolveFacts(state.cursor);
      const budgetOver = services.now() >= state.startedAt + state.budgetMs;
      if (isGenuineImprovement(resolved.facts, state, budgetOver)) return "continue";
    } catch {
      // 取证失败 → 无改善证据 → stop（不得绕过安全网承诺）
    }
  }
  return "stop";
}

/** steer 或（纯观察通道）仅记录事件。事件落盘失败同样标记降级（M3）。 */
async function steerOrRecord(
  services: WatchServices,
  opts: WatchOptions,
  state: WatchState,
  action: string,
  text: string,
): Promise<void> {
  try {
    await services.channel.send(opts.handle, text);
    recordOrDegrade(services, opts, state, { type: "steer", action, text: truncate(text, 500) });
  } catch (err) {
    recordOrDegrade(services, opts, state, {
      type: "steer-unsupported",
      action,
      note: err instanceof UnsupportedError ? "纯观察模式，未发送" : String(err),
      text: truncate(text, 500),
    });
  }
}

/** 执行停止（发出 stop 信号或纯观察通道仅记录事件）。事件落盘失败同样标记降级（M3）。 */
async function executeStop(services: WatchServices, opts: WatchOptions, state: WatchState, reason: string): Promise<void> {
  recordOrDegrade(services, opts, state, { type: "stop", reason });
  try {
    await services.channel.stop(opts.handle);
    recordOrDegrade(services, opts, state, { type: "stop-issued", note: "已发出停止信号" });
  } catch (err) {
    // file 通道（纯观察）或停止失败：只记录
    recordOrDegrade(services, opts, state, {
      type: "stop-unsupported",
      note: err instanceof UnsupportedError ? "纯观察模式，未发送停止信号" : String(err),
    });
  }
}

/**
 * 事件追加 + 落盘失败降级（M3）：所有路径（常规记录/steer/stop/finish）统一经此包装——
 * append 失败除落 stderr 外，还要标记 state.eventsDegraded（报告据此显式标注），
 * 不静默当作已记录（fail-open ≠ silent）。
 */
function recordOrDegrade(
  services: WatchServices,
  opts: WatchOptions,
  state: WatchState,
  event: { type: string; [key: string]: unknown },
): boolean {
  const ok = recordEvent(services, opts.watchId, event);
  if (!ok) state.eventsDegraded = true;
  return ok;
}

/**
 * 事件追加 + 落盘失败降级（M4）：append 返回 false 时至少落 stderr，
 * 不静默当作已记录（fail-open ≠ silent）。
 */
function recordEvent(
  services: WatchServices,
  watchId: string,
  event: { type: string; [key: string]: unknown },
): boolean {
  const ok = services.events.append(watchId, event);
  if (!ok) {
    console.error(`[guardian] 事件落盘失败（记录降级），未记录事件: ${event.type}`);
  }
  return ok;
}

async function finish(
  services: WatchServices,
  opts: WatchOptions,
  state: WatchState,
  exitCode: number,
  reason: string,
): Promise<WatchResult> {
  state.lastAction = state.lastAction ?? "finished";
  // 先追加 finish 事件（含实际收尾原因）再生成报告：报告必须能看到收尾事件，
  // 不得误显"未记录收尾事件"。reportPath 目标路径可预先确定。
  const path = join(services.reportsDir, `${opts.watchId}.md`);
  const finishRecorded = recordOrDegrade(services, opts, state, {
    type: "finish",
    exitCode,
    reportPath: path,
    reason,
  });
  // m1：终态事件发生后再次落盘状态——recordOrDegrade 可能刚把 eventsDegraded
  // 置 true（stop/steer/finish 记录失败），若不重存，guardian report 重载状态
  // 文件将丢失降级标记。
  await services.state.save(opts.watchId, state);
  const report = generateReport(state, services.events.readState(opts.watchId), { finishRecorded });
  try {
    mkdirSync(services.reportsDir, { recursive: true });
    writeFileSync(path, report, "utf-8");
    return { exitCode, state, reportPath: path };
  } catch {
    recordOrDegrade(services, opts, state, { type: "report-write-failed", note: "报告写入失败" });
    await services.state.save(opts.watchId, state);
    return { exitCode, state, reportPath: null };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}
