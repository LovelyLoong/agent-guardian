/**
 * agent-guardian — codex 目标适配器。
 *
 * 解析 codex rollout JSONL（解析器形状以真实样本为权威，见包内测试 fixture）：
 * - {type:"response_item", payload:{type:"function_call", name, arguments(JSON 字符串), call_id}}
 * - {type:"response_item", payload:{type:"function_call_output", call_id, output}}
 * - {type:"response_item", payload:{type:"custom_tool_call", name, input(字符串), call_id, status}}
 * - {type:"response_item", payload:{type:"custom_tool_call_output", call_id, output}}
 * - {type:"event_msg", payload:{type:"token_count", info:{last_token_usage:{input_tokens}, model_context_window}}}
 * - event_msg 的 task_started/task_complete 是会话停歇点（对事实提取无影响，保留用于未来）。
 *
 * isError 保守规则（依据真实样本验证，2026-08-09 rollout）：
 * 样本中 output 既可能是字符串，也可能是 [{type:"input_text", text}] 数组；
 * 失败形态是文本里出现 "Script failed" 或 "Script error:"，或 "Exit code: <n>"
 * 且 n≠0（样本实测失败为 "Exit code: 124"（超时）与 "Exit code: 1"；成功为 "Exit code: 0"）。
 * 保守 = 只在有显式失败证据时判错，无任何标记视为成功。
 *
 * @module
 */

import { readFileSync, statSync } from "node:fs";
import { computeArgsHash, evaluateSignals } from "../shared/signals.ts";
import type { SignalInput, ToolCallFact } from "../shared/contract.ts";
import type { TargetAdapter, BeatFacts } from "./types.ts";
import { withTransientRetry } from "../shared/fs.ts";

const TAIL_SUMMARY_CHARS = 800;
const TASK_SUMMARY_CHARS = 500;

interface CodexLine {
  type: string;
  payload: Record<string, unknown>;
}

/** 把 output（字符串或 input_text 数组）展平成文本。 */
export function codexOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const block of output) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}

/**
 * isError 判定（保守规则，依据见文件头注释）。
 */
export function codexOutputHasError(output: unknown): boolean {
  const text = codexOutputText(output);
  if (/Script failed/.test(text)) return true;
  if (/Script error:/.test(text)) return true;
  const re = /Exit code:\s*(-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== "0") return true;
  }
  return false;
}

export class CodexAdapter implements TargetAdapter {
  readonly kind = "codex" as const;

  private readonly file: string;
  /** call_id → facts 下标（与 pi 提取同款乱序归并） */
  private callIndex = new Map<string, number>();
  private facts: ToolCallFact[] = [];
  private lastTotal = 0;
  private parsedBytes = 0;
  private lastSize = 0;
  private lastMessageText = "";
  private lastUserText = "";
  private contextTokens: number | null = null;
  private contextWindow: number | null = null;

  constructor(file: string) {
    this.file = file;
  }

  async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      return {
        facts: {
          toolCallsSeen: -1,
          newToolCalls: 0,
          signals: [],
          tailSummary: "(会话文件不可读)",
        },
        cursor: cursor ?? "",
      };
    }

    const size = st.size;
    // EBUSY/EPERM（目标 CLI 并发追加写锁）→ 瞬态重试，重试耗尽才抛（调用方按取证失败处理）
    const text = await withTransientRetry(() => readFileSync(this.file, "utf-8"));
    // note：文件被截断/重建（字节大小小于上次记录）→ 重置解析游标与全部内存状态，
    // 全量重解析——截断后的事实（工具调用/信号/上下文用量）不得沿用旧值。
    // parsedBytes 是解码后文本的字符游标；截断检测必须用 st.size（字节），
    // 避免 Unicode 同字符数重建漏检。
    if (size < this.lastSize) {
      this.parsedBytes = 0;
      this.facts = [];
      this.callIndex = new Map();
      this.lastTotal = 0;
      this.lastMessageText = "";
      this.lastUserText = "";
      this.contextTokens = null;
      this.contextWindow = null;
    }
    this.lastSize = size;
    let endOfLastCompleteLine = 0;
    const lines: CodexLine[] = [];

    for (let i = 0; i < text.length;) {
      const nl = text.indexOf("\n", i);
      const lineEnd = nl < 0 ? text.length : nl + 1;
      if (nl >= 0) {
        endOfLastCompleteLine = lineEnd;
        const start = i;
        if (start >= this.parsedBytes) {
          const parsed = parseLine(text.slice(start, nl));
          if (parsed !== null) lines.push(parsed);
        }
      }
      i = lineEnd;
    }
    if (endOfLastCompleteLine > this.parsedBytes) {
      this.parsedBytes = endOfLastCompleteLine;
    }

    for (const line of lines) {
      this.consume(line);
    }

    const signals = evaluateSignals({
      toolCalls: this.facts,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      settledSeq: 1,
    } satisfies SignalInput);
    const newToolCalls = Math.max(0, this.facts.length - this.lastTotal);
    this.lastTotal = this.facts.length;

    return {
      facts: {
        toolCallsSeen: this.facts.length,
        newToolCalls,
        signals,
        tailSummary: this.lastMessageText !== "" ? truncate(this.lastMessageText, TAIL_SUMMARY_CHARS) : "(无消息文本)",
        taskSummary: this.lastUserText !== "" ? truncate(this.lastUserText, TASK_SUMMARY_CHARS) : "",
      },
      cursor: cursor ?? String(this.parsedBytes),
    };
  }

  private consume(line: CodexLine): void {
    const payload = line.payload;

    if (line.type === "response_item") {
      const kind = payload["type"];
      if (kind === "function_call") {
        this.addCall(String(payload["name"] ?? ""), parseArgs(payload["arguments"]), String(payload["call_id"] ?? ""));
        return;
      }
      if (kind === "custom_tool_call") {
        const status = payload["status"];
        const name = String(payload["name"] ?? "");
        const input = payload["input"];
        const args = typeof input === "string" ? { input } : { input: String(input ?? "") };
        const idx = this.addCall(name, args, String(payload["call_id"] ?? ""));
        // custom_tool_call 自带状态；显式失败状态直接判错
        if (typeof status === "string" && (status === "error" || status === "failed")) {
          this.facts[idx] = { ...this.facts[idx]!, isError: true };
        }
        return;
      }
      if (kind === "function_call_output" || kind === "custom_tool_call_output") {
        this.applyOutput(String(payload["call_id"] ?? ""), payload["output"]);
        return;
      }
      if (kind === "message") {
        const role = payload["role"];
        const content = payload["content"];
        const text = contentText(content);
        if (text !== "") {
          this.lastMessageText = text;
          if (role === "user") this.lastUserText = text;
        }
      }
      return;
    }

    if (line.type === "event_msg" && payload["type"] === "token_count") {
      const info = payload["info"] as Record<string, unknown> | undefined;
      const usage = info?.["last_token_usage"] as Record<string, unknown> | undefined;
      if (usage !== undefined && typeof usage["input_tokens"] === "number") {
        this.contextTokens = usage["input_tokens"];
      }
      if (info !== undefined && typeof info["model_context_window"] === "number") {
        this.contextWindow = info["model_context_window"];
      }
    }
  }

  /** 新增或回填一条事实；返回其下标。 */
  private addCall(name: string, args: Record<string, unknown>, callId: string): number {
    const existing = callId !== "" ? this.callIndex.get(callId) : undefined;
    if (existing !== undefined) {
      // 乱序：output 先到已建占位 → 回填真实名称与参数
      this.facts[existing] = { ...this.facts[existing]!, toolName: name, argsHash: computeArgsHash(args, name) };
      return existing;
    }
    const idx = this.facts.length;
    this.facts.push({
      toolName: name,
      argsHash: computeArgsHash(args, name),
      isError: false,
      turnIndex: this.facts.length,
    });
    if (callId !== "") this.callIndex.set(callId, idx);
    return idx;
  }

  private applyOutput(callId: string, output: unknown): void {
    if (callId === "") return;
    const idx = this.callIndex.get(callId);
    const isError = codexOutputHasError(output);
    if (idx !== undefined) {
      this.facts[idx] = { ...this.facts[idx]!, isError };
      return;
    }
    // 乱序：output 先于 call → 建占位事实，等 call 回填
    const newIdx = this.facts.length;
    this.facts.push({
      toolName: "codex-call",
      argsHash: computeArgsHash({}, "codex-call"),
      isError,
      turnIndex: this.facts.length,
    });
    this.callIndex.set(callId, newIdx);
  }
}

function parseLine(line: string): CodexLine | null {
  if (line.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["type"] !== "string") return null;
    const payload = obj["payload"];
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { type: obj["type"], payload: {} };
    }
    return { type: obj["type"], payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** function_call 的 arguments 是 JSON 字符串；解析失败时退化为原样字符串。 */
function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "string") {
    return args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { raw: args };
  } catch {
    return { raw: args };
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "output_text" && typeof b["text"] === "string") parts.push(b["text"]);
    if (b["type"] === "input_text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}
