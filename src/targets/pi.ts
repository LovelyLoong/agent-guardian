/**
 * agent-guardian — pi 目标适配器。
 *
 * 解析 pi 会话 JSONL（形状：assistant 消息 content[] 里
 * {type:"toolCall", id, name, arguments} 为工具调用；
 * - 独立消息 {role:"toolResult", toolCallId, toolName, isError, content} 为工具结果；
 * 提取与信号引擎包内复用 src/shared/ 单源（禁止复制）。
 *
 * 适配器维护解析进度：每拍只追加新行到内存 entries，全量重跑共享提取
 * （确定性、幂等）；工具调用总数累计，新增数 = 与上一拍之差。
 * 崩溃恢复 = 重建适配器从文件头全量重解析（结果一致）。
 *
 * @module
 */

import { readFileSync, statSync } from "node:fs";
import { extractToolCallsFromBranch } from "../shared/extract.ts";
import type { SessionEntry } from "../shared/extract.ts";
import { evaluateSignals } from "../shared/signals.ts";
import type { SignalInput } from "../shared/contract.ts";
import type { TargetAdapter, BeatFacts } from "./types.ts";
import { withTransientRetry } from "../shared/fs.ts";

const TAIL_SUMMARY_CHARS = 800;
const TASK_SUMMARY_CHARS = 500;
/** L4 传感：保留的最近命令条数（V2a） */
const RECENT_COMMANDS_MAX = 3;

export class PiAdapter implements TargetAdapter {
  readonly kind = "pi" as const;

  private readonly file: string;
  private entries: SessionEntry[] = [];
  private parsedBytes = 0;
  private lastSize = 0;
  private lastTotal = 0;
  /** 最近执行的 bash 命令文本（按时间正序追加，最新在末尾） */
  private recentCommands: string[] = [];

  constructor(file: string) {
    this.file = file;
  }

  async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      // 文件消失：保留已有事实，标记无法统计
      return {
        facts: {
          toolCallsSeen: -1,
          newToolCalls: 0,
          signals: [],
          recentCommands: [],
          tailSummary: "(会话文件不可读)",
        },
        cursor: cursor ?? "",
      };
    }

    // 只解析"完整行"（以换行结尾）；半截尾部行留给下一拍。
    // EBUSY/EPERM（目标 CLI 并发追加写锁）→ 瞬态重试，重试耗尽才抛（调用方按取证失败处理）
    const size = st.size;
    const text = await withTransientRetry(() => readFileSync(this.file, "utf-8"));
    // note：文件被截断/重建（字节大小小于上次记录）→ 重置解析游标与内存条目，
    // 全量重解析——截断后的事实不得沿用旧值。
    // parsedBytes 是解码后文本的字符游标；截断检测必须用 st.size（字节），
    // 避免 Unicode 同字符数重建漏检（同字节数不同内容不重置属可接受残余，会话文件按契约 append-only）。
    if (size < this.lastSize) {
      this.parsedBytes = 0;
      this.entries = [];
      this.lastTotal = 0;
      this.recentCommands = [];
    }
    this.lastSize = size;
    let endOfLastCompleteLine = 0;
    const newEntries: SessionEntry[] = [];

    for (let i = 0; i < text.length;) {
      const nl = text.indexOf("\n", i);
      const lineEnd = nl < 0 ? text.length : nl + 1;
      const isComplete = nl >= 0;
      if (isComplete) {
        endOfLastCompleteLine = lineEnd;
        const start = i;
        if (start >= this.parsedBytes) {
          const line = text.slice(start, nl);
          const entry = parseLine(line);
          if (entry !== null) newEntries.push(entry);
        }
      }
      i = lineEnd;
    }
    if (endOfLastCompleteLine > this.parsedBytes) {
      this.parsedBytes = endOfLastCompleteLine;
    }

    this.entries.push(...newEntries);
    this.collectCommands(newEntries);

    const toolCalls = extractToolCallsFromBranch(this.entries);
    const total = toolCalls.length;
    const newToolCalls = Math.max(0, total - this.lastTotal);
    this.lastTotal = total;
    const signals = evaluateSignals({
      toolCalls,
      // 离线会话文件不带上下文用量 → 不评估上下文压力（与 observe-session 行为一致）
      contextTokens: null,
      contextWindow: null,
      settledSeq: 1,
    } satisfies SignalInput);

    return {
      facts: {
        toolCallsSeen: total,
        newToolCalls,
        signals,
        recentCommands: [...this.recentCommands],
        tailSummary: tailOf(this.entries, TAIL_SUMMARY_CHARS),
        taskSummary: lastUserMessage(this.entries, TASK_SUMMARY_CHARS),
      },
      cursor: cursor ?? String(this.parsedBytes),
    };
  }

  /** L4 传感：从新增条目收集 bash 工具调用命令（V2a）。 */
  private collectCommands(newEntries: SessionEntry[]): void {
    for (const entry of newEntries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg === undefined || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b["type"] !== "toolCall") continue;
        if (b["name"] !== "bash" && b["name"] !== "shell") continue;
        const args = (b["arguments"] ?? {}) as Record<string, unknown>;
        const cmd = args["command"];
        if (typeof cmd !== "string" || cmd.trim() === "") continue;
        this.recentCommands.push(cmd);
        if (this.recentCommands.length > RECENT_COMMANDS_MAX) {
          this.recentCommands.shift();
        }
      }
    }
  }
}

function parseLine(line: string): SessionEntry | null {
  if (line.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SessionEntry;
  } catch {
    return null; // 坏行跳过（与观察脚本同规则）
  }
}

/** 尾部摘要：最后一条消息的文本（任意角色），截断。 */
function tailOf(entries: SessionEntry[], maxChars: number): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i]?.["message"];
    if (msg === undefined) continue;
    const text = contentText(msg["content"]);
    if (text !== "") return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  }
  return "(无消息文本)";
}

/** 任务摘要：最后一条用户消息文本，截断。 */
function lastUserMessage(entries: SessionEntry[], maxChars: number): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const msg = entries[i]?.["message"];
    if (msg === undefined || msg["role"] !== "user") continue;
    const text = contentText(msg["content"]);
    if (text !== "") return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
  }
  return parts.join("\n");
}
