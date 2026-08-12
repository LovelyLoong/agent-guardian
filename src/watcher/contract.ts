/**
 * agent-guardian — 任务契约（design §9.3 交付项 1，V2a）。
 *
 * `guardian watch --contract <path>` 挂载的不可变契约：
 * {requirement, acceptance[], scope[], approvedDecisions[]}。
 * 启动时校验存在性与形状（非法 → 退出码 2，不进入监督循环）；
 * 契约内容进每次 LLM 证据包（EvidencePack.contract）与完工汇报头部。
 *
 * 校验规则（保守：任何缺失/形状不符即拒绝挂载）：
 * - requirement：非空字符串（原始需求，必填）；
 * - acceptance：字符串数组（验收标准；允许空数组，元素须为非空字符串）；
 * - scope / approvedDecisions：同 acceptance。
 *
 * @module
 */

import { readFileSyncRetry, isTransientIoError } from "../shared/fs.ts";

export interface TaskContract {
  requirement: string;
  acceptance: string[];
  scope: string[];
  approvedDecisions: string[];
}

export type ContractParse =
  | { kind: "ok"; contract: TaskContract }
  | { kind: "error"; reason: string };

/**
 * 校验未知值是否为合法契约形状（供状态 normalize / 证据包复用）。
 * 不抛错；不是合法形状 → false。
 */
export function isTaskContract(value: unknown): value is TaskContract {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["requirement"] !== "string" || obj["requirement"].trim() === "") return false;
  return (
    isStringArray(obj["acceptance"]) &&
    isStringArray(obj["scope"]) &&
    isStringArray(obj["approvedDecisions"])
  );
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return false;
  }
  return true;
}

/**
 * 读取并校验契约文件。
 * - 文件不存在/不可读 → error（含原因）；
 * - JSON 解析失败 / 形状非法 → error（含原因）；
 * - 合法 → ok。
 */
export function parseContractFile(path: string): ContractParse {
  let text: string;
  try {
    text = readFileSyncRetry(path);
  } catch (err) {
    if (isTransientIoError(err)) {
      return { kind: "error", reason: `契约文件瞬态重试耗尽仍不可读: ${(err as NodeJS.ErrnoException).code}` };
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "error", reason: `契约文件不存在: ${path}` };
    }
    return { kind: "error", reason: `契约文件不可读: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "error", reason: `契约文件不是合法 JSON: ${path}` };
  }
  if (!isTaskContract(parsed)) {
    return {
      kind: "error",
      reason:
        `契约形状非法（需 {requirement: string, acceptance: string[], scope: string[], approvedDecisions: string[]}）: ${path}`,
    };
  }
  return { kind: "ok", contract: parsed };
}
