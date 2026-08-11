/**
 * agent-guardian — 数据目录约定。
 *
 * 默认 ~/.agent-guardian/（AGENT_GUARDIAN_HOME 覆盖；测试注入临时目录，
 * 禁止写真实目录）：
 * - state/   状态机 JSON（tmp+rename 原子落盘）
 * - events/  事件 JSONL（append-only）
 * - reports/ 完工汇报
 * - panels/  讨论组产出
 * - tmp/     LLM 证据包
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface GuardianDirs {
  home: string;
  state: string;
  events: string;
  reports: string;
  panels: string;
  tmp: string;
}

export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const override = env["AGENT_GUARDIAN_HOME"];
  if (override !== undefined && override.trim() !== "") return override.trim();
  return join(homedir(), ".agent-guardian");
}

export function dirsFor(home: string): GuardianDirs {
  return {
    home,
    state: join(home, "state"),
    events: join(home, "events"),
    reports: join(home, "reports"),
    panels: join(home, "panels"),
    tmp: join(home, "tmp"),
  };
}
