/**
 * agent-guardian — 证据保留期清理。
 *
 * guardian watch / events 启动时清理 AGENT_GUARDIAN_HOME 下超过保留期
 * （默认 14 天，--retention-days 可配）的 watch 目录产物：
 * 以 watchId 聚合 state/*.json（含 *.lock 单例锁）、events/*.jsonl、reports/*.md、
 * tmp/<watchId>-*.json、panels/<watchId>-panel-*（目录），任一产物 mtime 超过
 * 截止线即整组删除（按组内最新 mtime 判定，避免误删仍活跃的 watch）。
 *
 * @module
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GuardianDirs } from "./home.ts";

/** 默认保留期（天）。 */
export const DEFAULT_RETENTION_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** 扫描目录里 <suffix> 结尾文件，把各 watchId 的最新 mtime 并入 out。 */
function newestMtime(dir: string, suffix: string, out: Map<string, number>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 目录不存在/不可读 → 无可清理项
  }
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const watchId = name.slice(0, -suffix.length);
    if (watchId === "") continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      const prev = out.get(watchId) ?? 0;
      if (m > prev) out.set(watchId, m);
    } catch {
      // 文件消失则跳过
    }
  }
}

/** 目录内 <prefix> 开头（且 <suffix> 结尾）的产物最新 mtime；目录缺失 → 0。 */
function newestPrefixed(dir: string, prefix: string, suffix: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // 条目消失则跳过
    }
  }
  return newest;
}

/** 删除目录内 <prefix> 开头且 <suffix> 结尾的条目（目录可 recursive）。 */
function removePrefixed(dir: string, prefix: string, suffix: string, recursive = false): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    rmSync(join(dir, name), { recursive, force: true });
  }
}

/**
 * 清理超过保留期的 watch 产物。返回被清理的 watchId 列表（已删除）。
 * 判定口径：该 watchId 任一产物（state/events/reports/tmp/panels）的最新
 * mtime 早于截止线 → 整组删除。tmp/panels 按已知 watchId 前缀匹配
 * （watchId 本身可含连字符，不能按分隔符反解）。
 */
export function cleanupOldWatches(
  dirs: GuardianDirs,
  retentionDays: number,
  now: number = Date.now(),
): string[] {
  const cutoff = now - retentionDays * MS_PER_DAY;
  const latest = new Map<string, number>();
  newestMtime(dirs.state, ".json", latest);
  newestMtime(dirs.events, ".jsonl", latest);
  newestMtime(dirs.reports, ".md", latest);

  const removed: string[] = [];
  for (const [watchId, mtime] of latest) {
    const aux = Math.max(
      newestPrefixed(dirs.tmp, `${watchId}-`, ".json"),
      newestPrefixed(dirs.panels, `${watchId}-panel-`, ""),
    );
    if (Math.max(mtime, aux) >= cutoff) continue; // 仍有新近产物 → 保留
    removed.push(watchId);
    rmSync(join(dirs.state, `${watchId}.json`), { force: true });
    rmSync(join(dirs.state, `${watchId}.json.tmp`), { force: true });
    rmSync(join(dirs.state, `${watchId}.lock`), { force: true });
    rmSync(join(dirs.events, `${watchId}.jsonl`), { force: true });
    rmSync(join(dirs.reports, `${watchId}.md`), { force: true });
    removePrefixed(dirs.tmp, `${watchId}-`, ".json");
    removePrefixed(dirs.panels, `${watchId}-panel-`, "", true);
  }
  return removed;
}
