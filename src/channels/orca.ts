/**
 * agent-guardian — orca 通道（全能力：wait/read/send/stop）。
 *
 * 精确命令面（2026-08 实测）：
 * - waitIdle: orca terminal wait --terminal <h> --for tui-idle --timeout-ms <n> --json
 *   ok:true + wait.satisfied → idle；ok:false + error.code=="timeout" → timeout；其余 → stale。
 * - read:     orca terminal show --terminal <h> --json 先查 connected
 *   （connected:false = 主对话框已被用户关闭，Orca 实测生命周期语义），
 *   再 orca terminal read --terminal <h> --cursor <n> --json 取增量，游标=nextCursor。
 * - send:     orca terminal send --terminal <h> --text <t> --enter --json
 * - stop:     orca terminal send --terminal <h> --interrupt --json
 *   （stop 选择 interrupt（Ctrl-C 语义）而非 close：保留 pane 供用户事后检查，
 *   与 Orca 生命周期语义一致——close 有 pane/tab/PTY 三层不同效果。）
 *
 * @module
 */

import type { OrcaCli } from "../orca.ts";
import type { Channel, ReadResult } from "./types.ts";

export class OrcaChannel implements Channel {
  readonly kind = "orca" as const;
  private cursor = "0";
  private readonly orca: OrcaCli;

  constructor(orca: OrcaCli) {
    this.orca = orca;
  }

  async waitIdle(handle: string, timeoutMs: number): Promise<"idle" | "timeout" | "stale"> {
    const res = await this.orca.run([
      "terminal", "wait",
      "--terminal", handle,
      "--for", "tui-idle",
      "--timeout-ms", String(timeoutMs),
    ]);
    if (res.ok && res.data !== null) {
      const wait = (res.data as Record<string, unknown>)["result"] as Record<string, unknown> | undefined;
      if (wait?.["satisfied"] === true) return "idle";
      if (wait?.["satisfied"] === false) return "timeout";
      // ok 但形状不明 → 视为空闲（防御性，避免空转）
      return "idle";
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
}
