/**
 * agent-guardian — orca 通道（全能力：wait/read/send/stop）。
 *
 * 精确命令面（2026-08 实测）：
 * - waitIdle: orca terminal wait --terminal <h> --for tui-idle --timeout-ms <n> --json
 *   ok:true + wait.satisfied → idle；ok:false + error.code=="timeout" → timeout；其余 → stale。
 *   V1.1：ok:true 但形状无法识别（无 wait/result.satisfied 等预期字段）→ "unknown"——
 *   调用方按 stale 同等计数，不得当 idle 向忙碌 Agent 注入。
 * - read:     orca terminal show --terminal <h> --json 先查 connected
 *   （connected:false = 主对话框已被用户关闭，Orca 实测生命周期语义），
 *   再 orca terminal read --terminal <h> --cursor <n> --json 取增量，游标=nextCursor。
 * - send:     orca terminal send --terminal <h> --text <t> --enter --json
 * - stop:     orca terminal send --terminal <h> --interrupt --json
 *   （stop 选择 interrupt（Ctrl-C 语义）而非 close：保留 pane 供用户事后检查，
 *   与 Orca 生命周期语义一致——close 有 pane/tab/PTY 三层不同效果。）
 * - verifyStopped: 轮询 orca terminal show --terminal <h> --json，确认目标真的
 *   停下/退出（connected:false / ptyKilled:true / status exited|closed 任一即验证通过）。
 *
 * @module
 */

import type { OrcaCli } from "../orca.ts";
import type { Channel, ReadResult, StopVerifyOptions } from "./types.ts";

export class OrcaChannel implements Channel {
  readonly kind = "orca" as const;
  private cursor = "0";
  private readonly orca: OrcaCli;

  constructor(orca: OrcaCli) {
    this.orca = orca;
  }

  async waitIdle(handle: string, timeoutMs: number): Promise<"idle" | "timeout" | "stale" | "unknown"> {
    const res = await this.orca.run([
      "terminal", "wait",
      "--terminal", handle,
      "--for", "tui-idle",
      "--timeout-ms", String(timeoutMs),
    ]);
    if (res.ok && res.data !== null) {
      const data = res.data as Record<string, unknown>;
      const result = data["result"] as Record<string, unknown> | undefined;
      // wait 形状容忍：result.wait（嵌套）/ result（扁平）/ data.wait（顶层）
      const wait = (result?.["wait"] ?? result ?? data["wait"]) as Record<string, unknown> | undefined;
      if (wait?.["satisfied"] === true) return "idle";
      if (wait?.["satisfied"] === false) return "timeout";
      // V1.1：ok 但形状无法识别（无 wait/result.satisfied 等预期字段）→ unknown。
      // 不得当 idle 向忙碌 Agent 注入——由调用方按 stale 同等计数。
      return "unknown";
    }
    if (res.error === "timeout") return "timeout";
    return "stale";
  }

  async read(handle: string): Promise<ReadResult> {
    // 生命周期检查：connected:false → 用户已关闭主对话框（PTY 可能仍活，但监督目标消失）
    const show = await this.orca.run(["terminal", "show", "--terminal", handle]);
    if (show.ok && show.data !== null) {
      const terminal = (show.data as Record<string, unknown>)["result"] as Record<string, unknown> | undefined;
      const t = terminal?.["terminal"] as Record<string, unknown> | undefined;
      if (t?.["connected"] === false) {
        // 主对话框已被用户关闭：标记 closed，watcher 当拍收尾退出（不等连续 2 次）
        return { text: "", cursor: this.cursor, alive: false, closed: true };
      }
    } else {
      // show 失败（句柄失效等）→ 视为消失
      return { text: "", cursor: this.cursor, alive: false };
    }

    const res = await this.orca.run(["terminal", "read", "--terminal", handle, "--cursor", this.cursor]);
    if (!res.ok || res.data === null) {
      return { text: "", cursor: this.cursor, alive: false };
    }
    const terminal = (res.data as Record<string, unknown>)["result"] as Record<string, unknown> | undefined;
    const t = terminal?.["terminal"] as Record<string, unknown> | undefined;
    const tail = Array.isArray(t?.["tail"]) ? (t!["tail"] as unknown[]) : [];
    const text = tail.map((line) => String(line)).join("\n");
    const nextCursor = typeof t?.["nextCursor"] === "string" ? t!["nextCursor"] : this.cursor;
    const status = t?.["status"];

    // 每次成功 read 都对齐服务器游标（nextCursor），即使空 tail 也采纳：
    // 游标是服务器给出的权威位置，拒绝采纳会在服务器游标前移时永远重读同一区间。
    this.cursor = nextCursor;
    return { text, cursor: this.cursor, alive: status !== "exited" && status !== "closed" };
  }

  async send(handle: string, text: string): Promise<void> {
    const res = await this.orca.run(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]);
    if (!res.ok) {
      throw new Error(`terminal send 失败: ${res.error}`);
    }
  }

  async stop(handle: string): Promise<void> {
    const res = await this.orca.run(["terminal", "send", "--terminal", handle, "--interrupt"]);
    if (!res.ok) {
      throw new Error(`terminal stop 失败: ${res.error}`);
    }
  }

  /**
   * V1.1 停止验证：轮询 terminal show 确认目标真的停下/退出（有界重试）。
   * 任一证据即视为已停：connected:false（主对话框关闭）、ptyKilled:true
   * （PTY 已死）、status 为 exited/closed（进程退出）。show 调用失败（句柄
   * 失效/瞬断）不立即定论，继续轮询；次数耗尽仍未确认 → unverified。
   */
  async verifyStopped(handle: string, opts: StopVerifyOptions = {}): Promise<"verified" | "unverified"> {
    const attempts = opts.attempts ?? 5;
    const intervalMs = opts.intervalMs ?? 2_000;
    const sleepFn = opts.sleep ?? defaultSleep;
    for (let i = 0; i < attempts; i++) {
      const res = await this.orca.run(["terminal", "show", "--terminal", handle]);
      if (res.ok && res.data !== null) {
        const terminal = (res.data as Record<string, unknown>)["result"] as Record<string, unknown> | undefined;
        const t = terminal?.["terminal"] as Record<string, unknown> | undefined;
        if (t?.["connected"] === false || t?.["ptyKilled"] === true) return "verified";
        const status = t?.["status"];
        if (status === "exited" || status === "closed") return "verified";
      }
      // 形状不可识别或仍在运行：有界重试，避免无限轮询
      if (i < attempts - 1) await sleepFn(intervalMs);
    }
    return "unverified";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
