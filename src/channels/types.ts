/**
 * agent-guardian — 通道契约。
 *
 * 通道回答"监督者如何看和摸被观察者"：
 * - file 通道：纯观察（tail 会话文件 + 写报告），send/stop/verifyStopped 不支持；
 * - orca 通道：全能力（wait/read/send/stop/verifyStopped）。
 *
 * V1.1：waitIdle 增加 "unknown"——命令成功但返回形状无法识别时，调用方
 * 不得当 idle 处理；verifyStopped——发出停止信号后轮询确认目标停下/退出。
 *
 * @module
 */

export interface ReadResult {
  /** 本次新增的文本（自上次 read 以来的增量） */
  text: string;
  /** 单调前进的游标（file=文件字节数；orca=终端输出字节游标）；不前进即无新内容 */
  cursor: string;
  /** false = 被观察对象已关闭/消失（连续 2 次进入收尾退出路径） */
  alive: boolean;
  /** true = 主对话框/UI 已被用户关闭（Orca connected:false，PTY 可能仍活）→ 当拍收尾退出，不等 2 次 */
  closed?: boolean;
}

export interface StopVerifyOptions {
  /** 轮询次数（默认 5） */
  attempts?: number;
  /** 轮询间隔 ms（默认 2000） */
  intervalMs?: number;
  /** 注入睡眠（测试用；缺省 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

export interface Channel {
  readonly kind: "file" | "orca";
  waitIdle(handle: string, timeoutMs: number): Promise<"idle" | "timeout" | "stale" | "unknown">;
  read(handle: string): Promise<ReadResult>;
  /** steer；file 通道抛 unsupported */
  send(handle: string, text: string): Promise<void>;
  /** 停止；file 通道抛 unsupported */
  stop(handle: string): Promise<void>;
  /**
   * 停止后验证：轮询确认目标真的停下/退出（有界重试）；
   * file 通道抛 unsupported（纯观察模式无停止能力，不会被调用）。
   */
  verifyStopped(handle: string, opts?: StopVerifyOptions): Promise<"verified" | "unverified">;
}

export class UnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} 在该通道上不支持（纯观察模式）`);
    this.name = "UnsupportedError";
  }
}
