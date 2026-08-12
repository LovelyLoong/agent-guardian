/**
 * agent-guardian — 事件存储（JSONL append-only）。
 *
 * 每行一个事件对象 {ts, watchId, type, ...data}。
 * 失败不静默（fail-open ≠ silent）：
 * - append 返回 boolean（false = 写入降级，调用方可显式记录）；
 * - readState 返回 {events, degraded}，读取/解析失败时 degraded=true，
 *   调用方（报告等）不得把降级结果当作"无事件"。
 *
 * @module
 */

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactValue } from "./watcher/redact.ts";
import { appendFileSyncRetry, readFileSyncRetry } from "./shared/fs.ts";

export interface EventEntry {
  ts: string;
  watchId: string;
  type: string;
  [key: string]: unknown;
}

export interface EventReadResult {
  events: EventEntry[];
  /** true = 事件记录读取/解析降级（文件不可读或存在坏行）；调用方不得静默当空记录 */
  degraded: boolean;
}

export class EventStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(watchId: string): string {
    return join(this.dir, `${watchId}.jsonl`);
  }

  /**
   * 追加一条事件。返回 true = 落盘成功；false = 写入失败（降级）。
   * 失败不阻塞监督主流程，但调用方拿到显式失败信号，不得当作已记录。
   * 写入走 shared/fs.ts 瞬态重试（EBUSY/EPERM——他进程正在读本文件时追加
   * 会撞写锁），重试耗尽才按失败降级（返回 false）。
   * V1.1 脱敏：写入前对事件全量递归执行秘密模式过滤；命中秘密文本时
   * 替换为 [REDACTED] 并在事件上标 redacted:true。
   */
  append(watchId: string, event: { type: string; [key: string]: unknown }): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      const redacted = redactValue({ ts: new Date().toISOString(), watchId, ...event });
      const entry = redacted.value as EventEntry;
      if (redacted.changed) entry["redacted"] = true;
      appendFileSyncRetry(this.fileFor(watchId), JSON.stringify(entry) + "\n");
      return true;
    } catch {
      return false; // 落盘失败不阻塞监督（噪音纪律：默认沉默），但显式返回降级状态
    }
  }

  /** 读取状态：事件列表 + 是否降级。文件不存在 = 合法空（degraded:false）。
   *  EBUSY/EPERM（Windows 读撞上并发追加写锁）→ 瞬态重试，重试耗尽才视为真错误。 */
  readState(watchId: string): EventReadResult {
    let text: string;
    try {
      text = readFileSyncRetry(this.fileFor(watchId));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { events: [], degraded: false };
      return { events: [], degraded: true }; // 不可读（权限/IO/瞬态重试耗尽）→ 显式降级，不静默当空
    }
    const out: EventEntry[] = [];
    let degraded = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isValidEvent(parsed)) {
          out.push(parsed);
        } else {
          degraded = true; // 合法 JSON 但形状不对（{} 等畸形行）→ 数据损坏，不得当合法事件
        }
      } catch {
        degraded = true; // 坏行不静默跳过：标记降级，仍返回可读部分（fail-open）
      }
    }
    return { events: out, degraded };
  }

  /** 读取某 watch 的全部事件（兼容便捷接口；降级信息见 readState）。 */
  read(watchId: string): EventEntry[] {
    return this.readState(watchId).events;
  }

  /** 所有 watch 及其事件数（按事件文件 mtime 倒序）。降级（degraded）保留给调用方。 */
  list(): Array<{ watchId: string; count: number; degraded: boolean }> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: Array<{ watchId: string; count: number; degraded: boolean; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const watchId = name.slice(0, -".jsonl".length);
      const read = this.readState(watchId);
      try {
        const st = statSync(join(this.dir, name));
        out.push({ watchId, count: read.events.length, degraded: read.degraded, mtime: st.mtimeMs });
      } catch {
        out.push({ watchId, count: read.events.length, degraded: read.degraded, mtime: 0 });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.map((e) => ({ watchId: e.watchId, count: e.count, degraded: e.degraded }));
  }
}

/** 合法事件：JSON 对象且 type 为非空字符串（M4：{} 等畸形事件不得视为合法）。 */
function isValidEvent(parsed: unknown): parsed is EventEntry {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const type = (parsed as Record<string, unknown>)["type"];
  return typeof type === "string" && type !== "";
}
