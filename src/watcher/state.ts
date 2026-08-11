/**
 * agent-guardian — watcher 状态机。
 *
 * {settledBeats, cursor, cooldownUntil, remindCount, remindHistory,
 *  escalationCount, llmCalls, startedAt, budget}，每拍原子落盘
 * （tmp + rename），崩溃恢复续跑。
 *
 * @module
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RemindHistoryEntry {
  kind: string;
  beat: number;
  factsHash: string;
}

export interface WatchState {
  watchId: string;
  settledBeats: number;
  /** 通道游标（file=文件字节数；orca=终端输出游标） */
  cursor: string;
  /** kind → 冷却到第几拍（含）：当前拍 >= cooldownUntil 仍抑制（m1，与 decide.ts 一致） */
  cooldownUntil: Record<string, number>;
  remindCount: number;
  remindHistory: RemindHistoryEntry[];
  escalationCount: number;
  llmCalls: number;
  startedAt: number;
  budgetMs: number;
  safetyWarningSent: boolean;
  /** 安全网警告触发源（LIVE-1）："budget"=预算到期；否则为触发警告的信号 kind；null=未发警告 */
  safetyWarningTrigger: string | null;
  /** 事件落盘曾失败（append 返回 false）：报告须显式标注，不静默当已记录 */
  eventsDegraded: boolean;
  targetKind: string;
  channelKind: "file" | "orca";
  handle: string;
  sessionFile: string | null;
  lastAction: string | null;
}

export interface NewStateInput {
  watchId: string;
  budgetMs: number;
  targetKind: string;
  channelKind: "file" | "orca";
  handle: string;
  sessionFile: string | null;
  now: number;
}

export function initialState(input: NewStateInput): WatchState {
  return {
    watchId: input.watchId,
    settledBeats: 0,
    cursor: "",
    cooldownUntil: {},
    remindCount: 0,
    remindHistory: [],
    escalationCount: 0,
    llmCalls: 0,
    startedAt: input.now,
    budgetMs: input.budgetMs,
    safetyWarningSent: false,
    safetyWarningTrigger: null,
    eventsDegraded: false,
    targetKind: input.targetKind,
    channelKind: input.channelKind,
    handle: input.handle,
    sessionFile: input.sessionFile,
    lastAction: null,
  };
}

export class StateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(watchId: string): string {
    return join(this.dir, `${watchId}.json`);
  }

  async load(watchId: string): Promise<WatchState | null> {
    let text: string;
    try {
      text = readFileSync(this.fileFor(watchId), "utf-8");
    } catch {
      return null; // 无状态文件 = 首次运行
    }
    try {
      const parsed = JSON.parse(text) as Partial<WatchState>;
      return normalizeState(parsed, watchId);
    } catch {
      return null; // 损坏状态 → 从头开始（调用方会记录事件）
    }
  }

  /** 原子落盘：写 .tmp 再 rename 覆盖。崩溃时最多丢一拍，不会出现半写状态。 */
  async save(watchId: string, state: WatchState): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.fileFor(watchId) + ".tmp";
    const target = this.fileFor(watchId);
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmp, target);
  }

  /** 按 mtime 倒序列出 watchId（最新在前）。 */
  list(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const ids: Array<{ id: string; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        ids.push({ id, mtime: statSync(join(this.dir, name)).mtimeMs });
      } catch {
        // 文件消失则跳过
      }
    }
    ids.sort((a, b) => b.mtime - a.mtime);
    return ids.map((e) => e.id);
  }
}

/** 对加载的状态做字段级防御：缺字段补默认、类型错误置默认。 */
function normalizeState(parsed: Partial<WatchState>, watchId: string): WatchState | null {
  if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
  const budgetMs = typeof parsed.budgetMs === "number" && Number.isFinite(parsed.budgetMs) ? parsed.budgetMs : 0;
  return {
    watchId: typeof parsed.watchId === "string" ? parsed.watchId : watchId,
    settledBeats: typeof parsed.settledBeats === "number" ? parsed.settledBeats : 0,
    cursor: typeof parsed.cursor === "string" ? parsed.cursor : "",
    cooldownUntil: typeof parsed.cooldownUntil === "object" && parsed.cooldownUntil !== null
      ? (parsed.cooldownUntil as Record<string, number>)
      : {},
    remindCount: typeof parsed.remindCount === "number" ? parsed.remindCount : 0,
    remindHistory: Array.isArray(parsed.remindHistory) ? parsed.remindHistory : [],
    escalationCount: typeof parsed.escalationCount === "number" ? parsed.escalationCount : 0,
    llmCalls: typeof parsed.llmCalls === "number" ? parsed.llmCalls : 0,
    startedAt: parsed.startedAt,
    budgetMs,
    safetyWarningSent: parsed.safetyWarningSent === true,
    safetyWarningTrigger: typeof parsed.safetyWarningTrigger === "string" ? parsed.safetyWarningTrigger : null,
    eventsDegraded: parsed.eventsDegraded === true,
    targetKind: typeof parsed.targetKind === "string" ? parsed.targetKind : "pi",
    channelKind: parsed.channelKind === "orca" ? "orca" : "file",
    handle: typeof parsed.handle === "string" ? parsed.handle : "",
    sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : null,
    lastAction: typeof parsed.lastAction === "string" ? parsed.lastAction : null,
  };
}
