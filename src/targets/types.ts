/**
 * agent-guardian — 目标适配器契约。
 *
 * 适配器从被观察者提取机械事实（信号引擎复用 pi-task-governor 单源）。
 * 适配器内部维护自己的解析进度（内存态，崩溃恢复时全量重解析，结果确定性）。
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { Signal } from "../../../pi-task-governor/src/contract.ts";

export interface BeatFacts {
  /** 累计工具调用数（无法统计时 -1） */
  toolCallsSeen: number;
  /** 本拍新增工具调用数 */
  newToolCalls: number;
  /** 复用信号引擎的输出 */
  signals: Signal[];
  /** 给 LLM 证据包用的尾部摘要（截断） */
  tailSummary: string;
  /** 会话文件存在时提供的任务摘要（最后一条用户消息，截断）；无文件时缺省 */
  taskSummary?: string;
}

export interface TargetAdapter {
  readonly kind: "pi" | "codex" | "terminal";
  /**
   * 取证。cursor 是通道游标（file 模式=文件字节数），适配器透传返回；
   * 解析进度由适配器自己维护。
   */
  resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }>;
}

/**
 * 按会话文件内容嗅探目标类型（内容优先，命名兜底）：
 * - 首行 type=="session_meta"（codex rollout 固定开头）→ codex；
 * - 首行 type=="session"（pi 会话固定开头）→ pi；
 * - 文件名含 "rollout" → codex；
 * - 其余默认 pi（pi 提取器对未知行宽容，安全兜底）。
 */
export function detectTargetKind(file: string): "pi" | "codex" {
  try {
    const head = readFileSync(file, "utf-8").split(/\r?\n/, 2).join("\n");
    const firstLine = head.split(/\r?\n/)[0];
    if (firstLine !== undefined) {
      const parsed: unknown = JSON.parse(firstLine);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const type = (parsed as Record<string, unknown>)["type"];
        if (type === "session_meta") return "codex";
        if (type === "session") return "pi";
      }
    }
  } catch {
    // 读不到/坏 JSON → 落到命名兜底
  }
  return /rollout/i.test(file) ? "codex" : "pi";
}
