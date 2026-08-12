/**
 * agent-guardian — 机械决策树（纯逻辑，可单测）。V2a 干预语义重排（design §9.2）。
 *
 * 决策树：
 * 0. L4 客观硬边界（本轮新增传感）：steer 前扫描目标会话最近 bash 命令
 *    （facts.recentCommands），命中硬边界模式（删除工作区外路径 / 凭据外泄，
 *    保守误报）→ 唯一允许的 stop 路径。无 L4 命中 → 任何情况下内核不 stop。
 * 1. 暂停待命闩锁在身（paused）：目标回应（游标前进）不视为复工——需新工具
 *    调用（newToolCalls>0）才算复工（清闩）；否则沉默等待。
 * 2. L2 警告闩锁在身（warningSent，未确认）：信号复现（同类或新证据）→
 *    pause（可逆待命）+ 升级事件；触发信号消失且有干活证据 → 确认（清闩）；
 *    信号消失但无干活证据 → 沉默等待。
 * 3. 无信号 → 沉默。
 * 4. 有信号且非冷却/非重复 → 机械提醒（L1 Advise，模板含证据），计数+冷却 3 拍；
 *    轻提醒上限 → 升级 L2 WARNING。
 * 5. 升级阶梯按 incident（signalKey=kind+factsHash）维度（V2b，废除全局
 *    escalationCount 触发——该字段仅作纯统计）：同 incident 复现（过冷却）→
 *    L1 再提醒；同 incident 第 2 次复现 → LLM 回调点（若配置）：发证据包，
 *    执行返回的合法决定；未配置/超限 → L2 WARNING（需要回应，事件记录需
 *    ACK）。LLM 咨询与同 kind 信号共享冷却窗口，并受全局上限约束。
 * 6. 阶梯到 pause 封顶（settledIncidents）：达 pause 的 incident 不再重复
 *    提醒/升级（只记录）；不同 incident 互不影响彼此阶梯。
 *
 * 已删除的 V1 自动路径：提醒复现→stop、持续打转→stop、预算到期→警告→stop。
 * 预算到期由 loop 层直接收尾（监督者写汇报并自己退出，不动目标）。
 *
 * steer 文案红线（B2）：用户可见文本（提醒/警告/暂停）只含机械事实，
 * facts 值统一经 sanitizeText 净化（去 ANSI 转义/控制字符），防注入。
 *
 * @module
 */

import { computeArgsHash } from "../shared/signals.ts";
import type { Signal } from "../shared/contract.ts";
import { sanitizeText } from "./sanitize.ts";
import type { BeatFacts } from "../targets/types.ts";
import type { WatchState } from "./state.ts";
import type { EvidencePack, LlmNote, LlmResult } from "./llm.ts";

export type DecisionAction =
  | { action: "silence"; reason: string }
  | { action: "remind"; message: string; reason: string }
  | { action: "warning"; message: string; reason: string }
  | { action: "pause"; message: string; reason: string }
  | { action: "panel"; question: string; reason: string }
  | { action: "stop"; reason: string };

export interface DecideOutcome {
  action: DecisionAction;
  /** 本次决定是否经过了 LLM 回调 */
  consulted: boolean;
  /** LLM 输出处理结果（未咨询时为 null） */
  llmNote: LlmNote | null;
  /** 升级事件（L2→pause / L4→stop）：loop 落 pinned 置顶事件（design §9.2） */
  escalated?: boolean;
  /** 暂停后复工（新工具调用） */
  resumed?: boolean;
  /** L2 警告被确认（触发信号消失 + 干活证据） */
  acked?: boolean;
}

export interface DecideOptions {
  /** 轻提醒上限（默认 5） */
  remindMax: number;
  /** 冷却拍数（默认 3）：提醒/LLM 咨询后该 kind 抑制其后 cooldownBeats 拍（含边界拍，m1） */
  cooldownBeats: number;
  /** 每 watch LLM 回调全局上限（默认 3）；超限回到机械 L2 警告路径（M1） */
  llmMaxCalls: number;
}

export interface DecideContext {
  facts: BeatFacts;
  /** 就地变更；调用方在决定执行后落盘 */
  state: WatchState;
  opts: DecideOptions;
  llmConsult: ((evidence: EvidencePack) => Promise<LlmResult>) | null;
  /** 惰性构造证据包（仅在真正咨询 LLM 时调用） */
  makeEvidence: () => EvidencePack;
  /**
   * L4 客观硬边界判定用工作区根目录（守护进程启动目录；null = 未知 → 删除类
   * 边界无法验证，保守不命中——不确定即不 stop）。
   */
  workspaceRoot: string | null;
}

// ---------------------------------------------------------------------------
// L4 客观硬边界模式表（design §9.2/§9.3：stop 仅限 L4 客观硬边界）
//
// 只含客观可观测、可机械判定的边界；不确定 → 不命中 → 不 stop（保守误报）。
// 命中后由内核执行 stop；LLM 返回 stop 依旧降级为 pause（执行权在内核）。
// ---------------------------------------------------------------------------

/** 删除类动词（rm/rmdir/del/delete/erase/unlink，整词匹配防 \"model\" 等误伤） */
const L4_DELETE_VERB = /\b(?:rm|rmdir|del|delete|erase|unlink)\b/i;
/** 凭据外泄类客户端（curl/wget/Invoke-WebRequest 等） */
const L4_EXFIL_CLIENT = /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i;
/** 凭据形态标记（Authorization 头 / Bearer / api key / token= / secret / password） */
const L4_CRED_MARKER = /\b(?:authorization|bearer\s+\S+|api[_-]?key|apikey|access[_-]?token|secret|password)\b|token\s*=/i;
/** 本机回环主机：向这些主机发请求不构成\"外泄\" */
const L4_LOCALHOST = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * L4 硬边界命中检测：扫描 facts.recentCommands（最近命令文本，最新在末尾）。
 * 命中 → 返回供事件/汇报使用的原因文本；未命中 → null。
 *
 * 边界一（删除工作区外路径）：删除类动词 + 明确位于工作区之外的绝对路径
 * （含根目录删除——任何工作区下都不可接受）。工作区未知（workspaceRoot=null）
 * 时无法验证\"之外\"，除根目录删除外保守不命中。
 * 边界二（凭据外泄）：向非本机主机发送含凭据形态标记的请求。
 */
export function l4BoundaryHit(facts: BeatFacts, workspaceRoot: string | null): string | null {
  for (const cmd of facts.recentCommands) {
    const reason = l4MatchCommand(cmd, workspaceRoot);
    if (reason !== null) return reason;
  }
  return null;
}

/** 单条命令的 L4 判定（导出供单测）。 */
export function l4MatchCommand(cmd: string, workspaceRoot: string | null): string | null {
  const sanitized = sanitizeText(cmd, 4_000);
  if (L4_DELETE_VERB.test(sanitized)) {
    for (const path of absolutePathTokens(sanitized)) {
      if (isRootPath(path)) {
        return `L4 硬边界：删除根目录（${path}）`;
      }
      if (workspaceRoot !== null && !isUnderWorkspace(path, workspaceRoot)) {
        return `L4 硬边界：删除工作区外路径（${path}）`;
      }
    }
  }
  if (L4_EXFIL_CLIENT.test(sanitized) && L4_CRED_MARKER.test(sanitized)) {
    for (const url of urlTokens(sanitized)) {
      if (!isLocalhostUrl(url)) {
        return `L4 硬边界：凭据外泄（向 ${urlHost(url)} 发送含凭据的请求）`;
      }
    }
  }
  return null;
}

/**
 * 提取命令中的绝对路径 token（POSIX：/ 开头且前导字符非词字符/点/波浪号——
 * `./x`、`src/x` 等相对路径不误判为绝对；Windows：盘符:\ 或盘符:/ 开头）。
 * 保守：flags（-rf 等）不以 / 开头，不会误入；引号内的路径同样被提取（命令
 * 文本是字面字符串，引号无语法意义——提取范围到空白/引号/管道等为止）。
 */
export function absolutePathTokens(cmd: string): string[] {
  const out: string[] = [];
  const posix = /(?<![\w.~])\/(?:[^\s"'`|;&<>()\[\]{}]+)?/g;
  let m: RegExpExecArray | null;
  while ((m = posix.exec(cmd)) !== null) {
    const tok = m[0]!;
    // 根（/）保留；其余须含 ≥2 个分隔符——排除孤立 "/" 噪音（如 "a / b"）
    // 与 Windows cmd 单段 flag（/s、/q 等，不构成可判定的绝对路径）
    if (tok === "/") {
      out.push(tok);
    } else if (tok.split("/").length - 1 >= 2) {
      out.push(tok);
    }
  }
  const win = /[A-Za-z]:[\\/][^\s"'`|;&<>()\[\]{}]*/g;
  while ((m = win.exec(cmd)) !== null) {
    out.push(m[0]!);
  }
  return out;
}

/** 根目录判定（POSIX / 与 Windows 盘符根）。 */
function isRootPath(path: string): boolean {
  if (path === "/") return true;
  return /^[A-Za-z]:[\\/]$/.test(path);
}

/** 路径是否位于工作区之内（归一化：\\→/、去尾部斜杠、盘符小写）。 */
function isUnderWorkspace(path: string, workspaceRoot: string): boolean {
  const p = normalizePath(path);
  const root = normalizePath(workspaceRoot);
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

function normalizePath(path: string): string {
  // 归一化：\\→/、去除 . 段、折叠 .. 段（/ws/../outside → /outside）、小写
  const parts = path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/").toLowerCase();
}

/** 提取命令中的 URL token（http/https）。 */
export function urlTokens(cmd: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s"'`|;&<>()\[\]{}]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const url = m[0]!.replace(/[),.]+$/, "");
    out.push(url);
  }
  return out;
}

/** URL 主机名（含端口则去端口；IPv6 括号保留）。 */
export function urlHost(url: string): string {
  const rest = url.replace(/^https?:\/\//i, "");
  const slash = rest.indexOf("/");
  const hostPort = slash < 0 ? rest : rest.slice(0, slash);
  const colon = hostPort.lastIndexOf(":");
  if (colon > 0 && !hostPort.includes("]")) return hostPort.slice(0, colon);
  return hostPort;
}

/** 本机回环判定（保守：localhost/127.0.0.1/::1 之外一律视为外部）。 */
function isLocalhostUrl(url: string): boolean {
  return L4_LOCALHOST.has(urlHost(url).toLowerCase());
}

// ---------------------------------------------------------------------------
// 干预语义重排（V2a）：L1 Advise → L2 WARNING（需 ACK）→ pause（可逆待命）
// ---------------------------------------------------------------------------

/** L2 警告文案（内核模板，用户可见）：机械事实 + 需要回应的行动指令。 */
export function warningMessage(signal: Signal): string {
  return `[监督警告] ${signalSummary(signal)}。需要你的回应确认：请核对目标与当前进度，确认后继续。`;
}

/** 暂停文案（内核模板，用户可见）：机械事实 + 暂停待命指令（可逆）。 */
export function pauseMessage(signal: Signal): string {
  return `[监督暂停] ${signalSummary(signal)}。请暂停当前操作，核对目标与当前进度，确认后由新操作继续。`;
}

/** 信号种类稳定排序（同级时按此顺序取一个） */
const KIND_ORDER = ["spin", "failure-cluster", "stall", "context-pressure"] as const;

export async function decide(ctx: DecideContext): Promise<DecideOutcome> {
  // L4 客观硬边界：唯一 stop 路径（无命中 → 任何情况下不 stop）
  const l4 = l4BoundaryHit(ctx.facts, ctx.workspaceRoot);
  if (l4 !== null) {
    ctx.state.lastAction = "stop";
    return {
      action: { action: "stop", reason: l4 },
      consulted: false,
      llmNote: null,
      escalated: true,
    };
  }

  // 暂停待命闩锁：目标回应（游标前进）不视为复工——需新工具调用才算（V2a）。
  // 已暂停期间不再重复干预（等待复工或预算到期收尾）。
  if (ctx.state.paused) {
    if (ctx.facts.newToolCalls > 0) {
      ctx.state.paused = false;
      ctx.state.pauseTrigger = null;
      ctx.state.lastAction = "resumed";
      return { action: { action: "silence", reason: "resumed" }, consulted: false, llmNote: null, resumed: true };
    }
    return { action: { action: "silence", reason: "paused" }, consulted: false, llmNote: null };
  }

  // L2 警告闩锁在身（未确认）：复现/新证据 → pause + 升级事件；干活证据 → 确认。
  if (ctx.state.warningSent) {
    if (ctx.facts.signals.length > 0) {
      // WARNING 无 ACK 且信号复现（或新证据）→ pause（可逆待命）+ 升级事件
      const signal = pickStrongest(ctx.facts.signals);
      // M2：pause 触发所属 incident 与 settledIncidents 封顶记录同源一致——
      // pauseTrigger 存完整 incident key（signalKey=kind:factsHash），与
      // settledIncidents 记同一 key（旧实现 pauseTrigger 借 warningTrigger
      // 只存 kind，跨 incident 新证据时封顶对象与暂停闩锁不一致）
      const key = signalKey(signal);
      ctx.state.paused = true;
      ctx.state.pauseTrigger = key;
      ctx.state.warningSent = false;
      ctx.state.warningTrigger = null;
      ctx.state.lastAction = "pause";
      // V2b：阶梯到 pause 封顶——该 incident 不再重复提醒/升级（只记录）
      if (!ctx.state.settledIncidents.includes(key)) {
        ctx.state.settledIncidents.push(key);
      }
      return {
        action: {
          action: "pause",
          message: pauseMessage(signal),
          reason: `WARNING 未获确认且信号复现（${signal.kind}），升级为暂停待命`,
        },
        consulted: false,
        llmNote: null,
        escalated: true,
      };
    }
    if (ctx.facts.newToolCalls > 0) {
      // ACK：触发信号消失且有干活证据（新工具调用）→ 确认清闩
      ctx.state.warningSent = false;
      ctx.state.warningTrigger = null;
      ctx.state.lastAction = "warning-acked";
      return { action: { action: "silence", reason: "warning-acked" }, consulted: false, llmNote: null, acked: true };
    }
    // 信号消失但无干活证据：等待（不重复干预）
    return { action: { action: "silence", reason: "warning-pending" }, consulted: false, llmNote: null };
  }

  if (ctx.facts.signals.length === 0) {
    return { action: { action: "silence", reason: "no-signals" }, consulted: false, llmNote: null };
  }

  const signal = pickStrongest(ctx.facts.signals);
  const key = signalKey(signal);
  // V2b：阶梯已到 pause 封顶的 incident → 不再重复提醒/升级（只记录）；
  // 不同 incident 互不影响（仅按 signalKey=kind+factsHash 匹配）。
  if (ctx.state.settledIncidents.includes(key)) {
    return { action: { action: "silence", reason: "incident-settled" }, consulted: false, llmNote: null };
  }
  const now = ctx.state.settledBeats;
  const prev = ctx.state.remindHistory.find((h) => h.kind === signal.kind && h.factsHash === key);
  // m1：冷却含边界拍——cooldownUntil=3 表示 beat 0 提醒后，beat 1/2/3 抑制（>= 判含）、
  // beat 4 可再提醒；与 state.ts 的"冷却到第几拍（含）"注释一致。
  const inCooldown = (ctx.state.cooldownUntil[signal.kind] ?? -1) >= now;

  if (prev !== undefined) {
    // 同一 incident 提醒后复现（V2b：升级按 incident 阶梯，不用全局计数）
    if (inCooldown) {
      return { action: { action: "silence", reason: `cooldown:${signal.kind}` }, consulted: false, llmNote: null };
    }
    // V2b：escalationCount 只作纯统计（复现总累计，进报告/证据包），不作触发条件
    ctx.state.escalationCount++;
    // 同 incident 第 2 次复现（remindHistory 中同 key 记录 ≥2 条）→ 升级：
    // LLM 回调点（若配置）/ 机械 L2 WARNING（未配置或超限）
    const incidentReminds = ctx.state.remindHistory.filter((h) => h.factsHash === key).length;
    if (incidentReminds >= 2) {
      if (ctx.llmConsult !== null && ctx.state.llmCalls < ctx.opts.llmMaxCalls) {
        // M1：LLM 调用与同 kind 信号共享冷却窗口（本拍咨询后该 kind 进入冷却，
        // 下拍起抑制），并受全局上限约束；超限后落到下方机械 L2 警告路径。
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
        // LLM 返回 pause/stop（降级 pause）：同样进入暂停待命闩锁（复工需新工具调用）
        if (res.decision.action === "pause") {
          ctx.state.paused = true;
          // M2：pauseTrigger 与 settledIncidents 同源一致（同一 incident key）
          ctx.state.pauseTrigger = key;
          ctx.state.lastAction = "pause";
          // V2b：LLM 决定 pause 同样使该 incident 阶梯封顶（不再重复提醒/升级）
          if (!ctx.state.settledIncidents.includes(key)) ctx.state.settledIncidents.push(key);
        }
        return { action: res.decision, consulted: true, llmNote: res.note };
      }
      // 无 LLM（或超限）→ L2 WARNING（需要回应，事件需 ACK）
      return { action: warningAction(ctx.state, signal), consulted: false, llmNote: null };
    }
    // 首次复现：同样受轻提醒上限约束（达上限 → L2 警告，不再轻提醒）
    if (ctx.state.remindCount >= ctx.opts.remindMax) {
      return { action: warningAction(ctx.state, signal), consulted: false, llmNote: null };
    }
    return { action: makeRemind(ctx.state, signal, key, ctx.opts, "同信号再次提醒"), consulted: false, llmNote: null };
  }

  // 新信号
  if (inCooldown) {
    return { action: { action: "silence", reason: `cooldown:${signal.kind}` }, consulted: false, llmNote: null };
  }
  if (ctx.state.remindCount >= ctx.opts.remindMax) {
    return { action: warningAction(ctx.state, signal), consulted: false, llmNote: null };
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

/** 信号身份键：kind + 关键事实摘要（内容寻址，同一信号复现可识别）。
 *  V2b：升级阶梯的 incident 维度——kind+factsHash 相同的信号视为同一 incident，
 *  不同 incident 互不影响彼此阶梯。
 *  M1：kind 显式拼入 key——computeArgsHash 的 toolName 参数不参与哈希输入
 *  （仅影响 bash/command 的空白折叠），旧实现把 kind 借道 toolName 传递，
 *  不同 kind 同 facts 的信号会产出相同 key（跨 kind 碰撞串 incident）。 */
export function signalKey(signal: Signal): string {
  return `${signal.kind}:${computeArgsHash(signal.facts as Record<string, unknown>, "signal")}`;
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
 * L2 警告（V2a）：设置警告闩锁（warningSent + 触发信号 kind，持久化，
 * 供 loop/decide 判 ACK 与复现升级）。文案 = 机械事实 + 需要回应。
 */
function warningAction(state: WatchState, signal: Signal): DecisionAction {
  state.warningSent = true;
  state.warningTrigger = signal.kind;
  state.lastAction = "warning";
  return { action: "warning", message: warningMessage(signal), reason: `信号反复未见改善（${signal.kind}），升级为需要回应的警告` };
}

/**
 * 信号机械事实摘要（单行，只含机械事实）：提醒/警告/暂停共用。
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
    case "warning":
      // 内核组装文案：warning 只可能来自内核 warningAction（LLM schema 不含此
      // action），message 永为内核模板，原样透传。
      return action.message;
    case "pause":
      return facts.signals.length > 0
        ? pauseMessage(pickStrongest(facts.signals))
        : "[监督暂停] 检测到需要关注的信号。请暂停当前操作，核对目标与当前进度后再继续。";
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
