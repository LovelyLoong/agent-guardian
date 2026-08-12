/**
 * agent-guardian — 信号引擎类型契约（随引擎迁入的单源）。
 *
 * 信号引擎与提取逻辑的正主随 V1.1 迁移从 pi-task-governor 迁入本包
 * （src/shared/{signals,extract,contract}.ts），本包自此无外部依赖；
 * pi-task-governor 反向相对导入本目录。
 * 本文件只含信号引擎所需的类型（pi-task-governor 的
 * Basis/Evaluation/CursorState 等治理专属类型不随迁）。
 *
 * @module
 */

export interface ToolCallFact {
  toolName: string;
  argsHash: string;
  isError: boolean;
  turnIndex: number;
}

export interface SignalInput {
  toolCalls: ToolCallFact[];
  contextTokens: number | null;
  contextWindow: number | null;
  settledSeq: number;
}

export type SignalKind = "spin" | "stall" | "failure-cluster" | "context-pressure";

export interface Signal {
  kind: SignalKind;
  severity: 1 | 2 | 3;
  facts: Record<string, number | string>;
}
