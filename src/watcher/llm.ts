/**
 * agent-guardian — LLM 回调契约。
 *
 * 默认关闭（纯机械模式）。--llm "<cmd>" 提供时启用：
 * watcher 把 evidence.json 路径作为最后一个参数传给命令，
 * 读其 stdout 的 decision JSON。
 *
 * schema 校验（watcher 权威）：action ∈ {silence, remind, pause, panel}；
 * remind/pause 必须有非空 message；panel 必须有非空 question。
 * 非法输出 → 降级为 silence 并记录；LLM 返回 stop → 一律降级为 pause 并记录
 * （停止执行权在内核，防 LLM 重手）。
 *
 * @module
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeatFacts } from "../targets/types.ts";
import type { WatchState } from "./state.ts";
import type { DecisionAction } from "./decide.ts";

/** LLM 证据包（watcher 校验 schema 的输入） */
export interface EvidencePack {
  facts: BeatFacts;
  state: PublicState;
  taskSummary: string;
  recentEvents: unknown[];
}

/** 给 LLM 的状态子集（不含内部游标细节） */
export interface PublicState {
  settledBeats: number;
  remindCount: number;
  escalationCount: number;
  llmCalls: number;
  startedAt: number;
  budgetMs: number;
  targetKind: string;
}

export type LlmNote = "ok" | "invalid" | "stop-downgraded";

/** 契约上限：stdout 超过该字节数（UTF-8 字节，M4）→ invalid → silence */
export const LLM_STDOUT_MAX_BYTES = 64 * 1024;
/** 契约上限：message 超过该字符数 → invalid → silence */
export const LLM_MESSAGE_MAX_CHARS = 2 * 1024;

export interface LlmResult {
  decision: DecisionAction;
  note: LlmNote;
  detail: string | null;
}

export type ShellExec = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * 把命令串拆成 argv（引号感知）：memberCmd/--llm 是操作者配置的命令行，
 * 执行时不经 shell（M3：禁止 shell 拼字符串），由 execFile 以参数数组
 * 直启，问题文本/证据路径中的 $(...)、引号等不会产生注入执行。
 *
 * 引号规则（M1）：双引号成组——组内空格保留、外层引号剥除（支持含空格的
 * 路径/命令，如 "C:\Program Files\agent.exe" -p）；未闭合的引号吞到行尾。
 * 不支持的边角（文档化）：组内转义（\\" 中的反斜杠是字面字符，引号仍按
 * 配对切换）、单引号不成组（按普通字符处理）、空引号组产出空 token 被丢弃。
 */
export function splitCommand(commandLine: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let token = "";
  let inQuotes = false;
  const s = commandLine.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (token !== "") {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }
  if (token !== "") tokens.push(token);
  const cmd = tokens.shift() ?? "";
  return { cmd, args: tokens };
}

/**
 * 解析 LLM stdout 为合法决定。永不抛错：
 * - 非 JSON / 非对象 / 未知 action / 缺必填字段 → {silence, reason:"llm-invalid: <原因>"}；
 * - action==="stop" → {pause, reason:"llm-stop-downgraded"}。
 */
export function parseDecisionOutput(stdout: string): LlmResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return invalid(`输出不是合法 JSON（前 80 字符：${stdout.trim().slice(0, 80)}）`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("输出不是 JSON 对象");
  }
  const obj = parsed as Record<string, unknown>;
  const action = obj["action"];
  switch (action) {
    case "silence":
      return { decision: { action: "silence", reason: reasonOf(obj, "llm-silence") }, note: "ok", detail: null };
    case "remind": {
      const message = stringField(obj, "message");
      if (message === null) return invalid("remind 缺少 message");
      if (message.length > LLM_MESSAGE_MAX_CHARS) {
        return invalid(`remind message 超出契约上限（${LLM_MESSAGE_MAX_CHARS} 字符）`);
      }
      return { decision: { action: "remind", message, reason: reasonOf(obj, "llm-remind") }, note: "ok", detail: null };
    }
    case "pause": {
      const message = stringField(obj, "message");
      if (message === null) return invalid("pause 缺少 message");
      if (message.length > LLM_MESSAGE_MAX_CHARS) {
        return invalid(`pause message 超出契约上限（${LLM_MESSAGE_MAX_CHARS} 字符）`);
      }
      return { decision: { action: "pause", message, reason: reasonOf(obj, "llm-pause") }, note: "ok", detail: null };
    }
    case "panel": {
      const question = stringField(obj, "question");
      if (question === null) return invalid("panel 缺少 question");
      return { decision: { action: "panel", question, reason: reasonOf(obj, "llm-panel") }, note: "ok", detail: null };
    }
    case "stop": {
      const message = stringField(obj, "message") ?? "LLM 请求停止，已按规则降级为暂停";
      return {
        decision: { action: "pause", message, reason: "llm-stop-downgraded" },
        note: "stop-downgraded",
        detail: reasonOf(obj, "llm-stop"),
      };
    }
    default:
      return invalid(`未知决定类型: ${String(action)}`);
  }
}

export function invalid(reason: string): LlmResult {
  return { decision: { action: "silence", reason: `llm-invalid: ${reason}` }, note: "invalid", detail: reason };
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") return null;
  return v;
}

function reasonOf(obj: Record<string, unknown>, fallback: string): string {
  const v = obj["reason"];
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/** 执行 LLM 回调命令（参数数组形式，无 shell），写入证据文件后追加路径参数调用。 */
export function makeLlmConsult(opts: {
  cmd: string;
  exec: ShellExec;
  evidenceDir: string;
  watchId: string;
  timeoutMs?: number;
}): (evidence: EvidencePack) => Promise<LlmResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return async (evidence) => {
    // 证据包写入异常全部捕获：不得让 watcher 崩溃（降级为 silence + 记录）
    let path: string;
    try {
      mkdirSync(opts.evidenceDir, { recursive: true });
      path = join(opts.evidenceDir, `${opts.watchId}-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
    } catch (err) {
      return invalid(`证据包写入失败: ${String(err)}`);
    }
    const { cmd, args } = splitCommand(opts.cmd);
    let res;
    try {
      res = await opts.exec(cmd, [...args, path], timeoutMs);
    } catch (err) {
      return invalid(`回调命令执行失败: ${String(err)}`);
    }
    // 非零退出码 = 回调失败：即使 stdout 有合法 JSON 也不执行
    if (res.code !== 0) {
      const detail = res.stderr.trim() !== "" ? res.stderr.trim().slice(0, 200) : `退出码 ${String(res.code)}`;
      return invalid(`回调命令非零退出（${detail}）`);
    }
    // 契约上限：stdout 按 UTF-8 字节计超 64KB → invalid → silence（M4：
    // 多字节字符按字节判定，字符数达标但字节超限同样拒绝）
    if (Buffer.byteLength(res.stdout, "utf8") > LLM_STDOUT_MAX_BYTES) {
      return invalid(`stdout 超出契约上限（${LLM_STDOUT_MAX_BYTES} 字节）`);
    }
    return parseDecisionOutput(res.stdout);
  };
}

/** 构造证据包。 */
export function buildEvidencePack(
  facts: BeatFacts,
  state: WatchState,
  recentEvents: unknown[],
): EvidencePack {
  return {
    facts,
    state: {
      settledBeats: state.settledBeats,
      remindCount: state.remindCount,
      escalationCount: state.escalationCount,
      llmCalls: state.llmCalls,
      startedAt: state.startedAt,
      budgetMs: state.budgetMs,
      targetKind: state.targetKind,
    },
    taskSummary: facts.taskSummary ?? "",
    recentEvents,
  };
}
