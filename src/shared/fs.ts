/**
 * agent-guardian — 共享文件 IO 瞬态容错。
 *
 * Windows 上多进程并发（读-写同一文件）会以 EBUSY（resource busy or locked，
 * 读撞上他人写锁）或 EPERM（读占用导致的 rename 冲突）瞬态失败。凡读取
 * "其他进程可能正在写"的共享文件（租约账本、事件流、目标会话文件、面板成员
 * 产出等），一律把这两类错误与撕裂尾行同等视为瞬态：短退避重试
 * （TRANSIENT_IO_ATTEMPTS × TRANSIENT_IO_SETTLE_MS），重试耗尽才视为真错误
 * 抛给调用方裁决。tmp+rename 写路径与 O_APPEND 追加写路径（事件流、租约账本）
 * 的 EPERM/EBUSY（读方占用导致的追加/改名冲突）同样瞬态重试。
 *
 * @module
 */

import { appendFileSync, readFileSync } from "node:fs";

/** 瞬态 IO 重试次数（与账本撕裂尾行重读同量级）。 */
export const TRANSIENT_IO_ATTEMPTS = 3;
/** 瞬态 IO 重试退避（ms）。 */
export const TRANSIENT_IO_SETTLE_MS = 15;

/** Windows 瞬态 IO 错误：EBUSY（读撞上他人写锁）、EPERM（读占用导致的 rename 冲突）。 */
export function isTransientIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM";
}

/** 同步短退避（Atomics.wait 定时阻塞主线程；同步读取路径免改 async 签名）。 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 异步短退避。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 同步带瞬态重试执行：EBUSY/EPERM → 短退避重试（TRANSIENT_IO_ATTEMPTS 次）；
 * 重试耗尽或非瞬态错误 → 原样抛出（调用方按"真错误"裁决）。
 */
export function withTransientRetrySync<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientIoError(err) || attempt + 1 >= TRANSIENT_IO_ATTEMPTS) throw err;
      sleepSync(TRANSIENT_IO_SETTLE_MS);
    }
  }
}

/** 异步带瞬态重试执行：语义同 withTransientRetrySync。 */
export async function withTransientRetry<T>(fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientIoError(err) || attempt + 1 >= TRANSIENT_IO_ATTEMPTS) throw err;
      await sleep(TRANSIENT_IO_SETTLE_MS);
    }
  }
}

/** 共享文件同步文本读取（EBUSY/EPERM 瞬态重试，重试耗尽原样抛出）。 */
export function readFileSyncRetry(path: string): string {
  return withTransientRetrySync(() => readFileSync(path, "utf-8"));
}

/** 共享文件同步追加写（O_APPEND 原子小写入；EBUSY/EPERM 瞬态重试，重试耗尽原样抛出）。 */
export function appendFileSyncRetry(path: string, data: string): void {
  withTransientRetrySync(() => appendFileSync(path, data, "utf-8"));
}
