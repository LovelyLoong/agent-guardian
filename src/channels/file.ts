/**
 * agent-guardian — file 通道。
 *
 * 纯观察：把会话文件当作"终端"来 tail。无 Orca 也能用，单测零依赖。
 * - waitIdle：fs.watch 为主 + 30s 慢速兜底轮询（设计 §0 新拓扑再裁决 ③）：
 *   目录 watch 捕获变更事件（含文件重建），事件到达立即醒来复查；
 *   watch 事件丢失/不可用时按兜底间隔轮询 mtime，保证不空转、不漏变化。
 *   连续 quiescentMs（默认 10s）无变更视为空闲；文件不存在视为 stale。
 * - read：返回自上次读取以来的新增字节，游标 = 文件总字节数。
 * - send/stop：不支持（抛 UnsupportedError），监督只能看。
 *
 * @module
 */

import { readFileSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { Channel, ReadResult } from "./types.ts";
import { UnsupportedError } from "./types.ts";
import { withTransientRetry } from "../shared/fs.ts";

/** 无变更静默窗口：超过该时长无变更 → 判空闲 */
export const FILE_QUIESCENT_MS = 10_000;
/** 慢速兜底轮询间隔：watch 事件丢失/不可用时的兜底 */
export const FILE_FALLBACK_POLL_MS = 30_000;

export interface FileChannelOptions {
  /** 无变更静默窗口：超过该时长无变更视为空闲（测试可注入小值提速） */
  quiescentMs?: number;
  /** 慢速兜底轮询间隔：watch 事件丢失/不可用时的兜底（默认 30s） */
  fallbackPollMs?: number;
}

export class FileChannel implements Channel {
  readonly kind = "file" as const;
  private cursorBytes = 0;
  private readonly quiescentMs: number;
  private readonly fallbackPollMs: number;

  constructor(opts: FileChannelOptions = {}) {
    this.quiescentMs = opts.quiescentMs ?? FILE_QUIESCENT_MS;
    this.fallbackPollMs = opts.fallbackPollMs ?? FILE_FALLBACK_POLL_MS;
  }

  async waitIdle(handle: string, timeoutMs: number): Promise<"idle" | "timeout" | "stale"> {
    const deadline = Date.now() + timeoutMs;
    let lastActivity = Date.now();
    let lastMtime = -1;
    let firstStat = true;
    // 本次醒来是 watch 事件（true，快路径：按静默窗口复查）还是计时器/兜底（false，慢路径：按兜底间隔轮询）
    let wokeByEvent = true;

    const watcher = this.watchFile(handle, () => {
      lastActivity = Date.now();
    });

    try {
      for (;;) {
        let st;
        try {
          st = statSync(handle);
        } catch {
          return "stale"; // 文件不存在/不可读 → 视为被观察对象消失
        }
        const now = Date.now();
        if (firstStat) {
          firstStat = false;
          lastMtime = st.mtimeMs;
          lastActivity = now;
        } else if (st.mtimeMs !== lastMtime) {
          // 兜底轮询发现变化（watch 事件可能被吞）→ 同样计为活动
          lastMtime = st.mtimeMs;
          lastActivity = now;
          wokeByEvent = true;
        }
        if (now - lastActivity >= this.quiescentMs) return "idle";
        // 剩余时间不足以再来一轮检查 → 超时
        if (now + 100 >= deadline) return "timeout";
        const waitMs = wokeByEvent
          ? Math.min(this.quiescentMs, deadline - now)
          : Math.min(this.fallbackPollMs, deadline - now);
        wokeByEvent = await this.waitForEventOrTimer(watcher, waitMs);
      }
    } finally {
      watcher?.close();
    }
  }

  /** 等待一次 watch 变更事件或计时器到期；返回是否由事件唤醒。 */
  private waitForEventOrTimer(watcher: FSWatcher | null, ms: number): Promise<boolean> {
    if (watcher === null) {
      return sleep(ms).then(() => false);
    }
    const w: FSWatcher = watcher; // 闭包内保留窄化后的类型
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, ms);
      const onEvent = () => {
        cleanup();
        resolve(true);
      };
      function cleanup(): void {
        clearTimeout(timer);
        w.removeListener("change", onEvent);
        w.removeListener("error", onEvent);
      }
      w.on("change", onEvent);
      w.on("error", onEvent);
    });
  }

  /** 监听文件所在目录（兼容文件重建）；失败（目录不存在/watch 不可用）→ null，纯兜底轮询。 */
  private watchFile(handle: string, onActivity: () => void): FSWatcher | null {
    try {
      const dir = dirname(handle);
      const base = basename(handle);
      const w = watch(dir, { persistent: false });
      w.on("change", (_eventType, filename) => {
        if (filename === null || String(filename) === base) onActivity();
      });
      w.on("error", () => {
        // watch 失效：兜底轮询接管，无需动作
      });
      return w;
    } catch {
      return null;
    }
  }

  async read(handle: string): Promise<ReadResult> {
    let st;
    try {
      st = statSync(handle);
    } catch {
      return { text: "", cursor: String(this.cursorBytes), alive: false };
    }
    const size = st.size;
    if (size < this.cursorBytes) {
      // 文件被截断/重建（少见）：从头开始
      this.cursorBytes = 0;
    }
    let text = "";
    if (size > this.cursorBytes) {
      // EBUSY/EPERM（目标进程并发追加写锁）→ 瞬态重试；重试耗尽才抛（调用方按不可达处理）
      const buf = await withTransientRetry(() => readFileSync(handle));
      text = buf.subarray(this.cursorBytes, size).toString("utf-8");
      this.cursorBytes = size;
    }
    return { text, cursor: String(size), alive: true };
  }

  async send(_handle: string, _text: string): Promise<void> {
    throw new UnsupportedError("send");
  }

  async stop(_handle: string): Promise<void> {
    throw new UnsupportedError("stop");
  }

  /** 纯观察模式无停止能力：验证随 stop 一起不支持（正常流程不会被调用）。 */
  async verifyStopped(_handle: string, _opts?: import("./types.ts").StopVerifyOptions): Promise<"verified" | "unverified"> {
    throw new UnsupportedError("stop 验证");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
