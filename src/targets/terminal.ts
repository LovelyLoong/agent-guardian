/**
 * agent-guardian — terminal 兜底适配器。
 *
 * 无会话文件的场景（watch --terminal 不带 --session）：仅活性 + 游标，
 * 不产出信号（信号引擎需要工具调用事实）。
 *
 * @module
 */

import type { TargetAdapter, BeatFacts } from "./types.ts";

export class TerminalAdapter implements TargetAdapter {
  readonly kind = "terminal" as const;

  async resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }> {
    return {
      facts: {
        toolCallsSeen: -1,
        newToolCalls: 0,
        signals: [],
        tailSummary: "(未提供会话文件，仅活性监控)",
      },
      cursor: cursor ?? "",
    };
  }
}
