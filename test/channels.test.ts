/**
 * agent-guardian — 通道测试（file 真实实现 + orca 注入替身）。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileChannel } from "../src/channels/file.ts";
import { OrcaChannel } from "../src/channels/orca.ts";
import { UnsupportedError } from "../src/channels/types.ts";
import { OrcaCli } from "../src/orca.ts";
import type { OrcaExecutor, ExecResult } from "../src/orca.ts";

describe("FileChannel", () => {
  it("read 返回增量与累计游标（字节数）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-chan-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, "line1\n", "utf-8");
    const ch = new FileChannel();
    const r1 = await ch.read(file);
    assert.strictEqual(r1.text, "line1\n");
    assert.strictEqual(r1.cursor, "6");
    assert.strictEqual(r1.alive, true);
    appendFileSync(file, "line2\n", "utf-8");
    const r2 = await ch.read(file);
    assert.strictEqual(r2.text, "line2\n");
    assert.strictEqual(r2.cursor, "12");
  });

  it("文件不存在 → alive:false；send/stop 抛 unsupported", async () => {
    const ch = new FileChannel();
    const missing = join(mkdtempSync(join(tmpdir(), "ag-chan-")), "nope.jsonl");
    const r = await ch.read(missing);
    assert.strictEqual(r.alive, false);
    await assert.rejects(() => ch.send("h", "x"), UnsupportedError);
    await assert.rejects(() => ch.stop("h"), UnsupportedError);
  });

  it("waitIdle：文件静止 → idle；持续变化 → timeout；文件缺失 → stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-chan-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, "a\n", "utf-8");
    const ch = new FileChannel({ quiescentMs: 10, fallbackPollMs: 20 });
    const idle = await ch.waitIdle(file, 1_000);
    assert.strictEqual(idle, "idle");

    // 持续变化：每次轮询前改 mtime
    const ch2 = new FileChannel({ quiescentMs: 10, fallbackPollMs: 10 });
    const timer = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(file, now, now); // touch 变更 mtime
      } catch {
        // 文件被删
      }
    }, 5);
    try {
      const timeout = await ch2.waitIdle(file, 30);
      assert.strictEqual(timeout, "timeout");
    } finally {
      clearInterval(timer);
    }

    const ch3 = new FileChannel({ quiescentMs: 10, fallbackPollMs: 20 });
    rmSync(file, { force: true });
    const stale = await ch3.waitIdle(file, 1_000);
    assert.strictEqual(stale, "stale");
  });

  it("waitIdle：写入活动推迟空闲判定，静默后才判 idle（fs.watch 为主）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-chan-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, "a\n", "utf-8");
    // 兜底间隔远大于静默窗口：若 watch 失效，首次活动要在兜底轮询才被发现
    const ch = new FileChannel({ quiescentMs: 120, fallbackPollMs: 4_000 });
    const burst = setInterval(() => {
      try {
        appendFileSync(file, "x\n", "utf-8");
      } catch {
        // 文件被删
      }
    }, 20);
    const stopBurst = setTimeout(() => clearInterval(burst), 600);
    let result: "idle" | "timeout" | "stale";
    try {
      result = await ch.waitIdle(file, 2_000);
    } finally {
      clearInterval(burst);
      clearTimeout(stopBurst);
    }
    // 写入期间不得提前判 idle；写入停止（~600ms）后静默 120ms 才 idle。
    // 若 fs.watch 完全失效，兜底 4s 轮询在 2s 截止前只会发现活动 → 判 timeout。
    assert.strictEqual(result, "idle");
  });
});

// ---------------------------------------------------------------------------
// OrcaChannel（注入替身 exec）
// ---------------------------------------------------------------------------

function stubCli(handler: (args: string[]) => ExecResult): OrcaCli {
  const exec: OrcaExecutor = async (cmd, args) => handler(args);
  return new OrcaCli(exec, "orca-stub");
}

function jsonResult(data: unknown, ok = true): ExecResult {
  return { code: 0, stdout: JSON.stringify(ok ? { ok: true, result: data } : { ok: false, error: data }), stderr: "" };
}

describe("OrcaChannel（替身 exec）", () => {
  it("waitIdle：satisfied → idle；timeout 错误 → timeout；其他错误 → stale", async () => {
    const calls: string[][] = [];
    const cli = stubCli((args) => {
      calls.push(args);
      if (args.includes("h1")) {
        return jsonResult({ wait: { condition: "tui-idle", satisfied: true } });
      }
      if (args.includes("h2")) {
        return { code: 0, stdout: JSON.stringify({ ok: false, error: { code: "timeout", message: "timeout" } }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }), stderr: "" };
    });
    const ch = new OrcaChannel(cli);
    assert.strictEqual(await ch.waitIdle("h1", 1000), "idle");
    assert.strictEqual(await ch.waitIdle("h2", 1000), "timeout");
    assert.strictEqual(await ch.waitIdle("h3", 1000), "stale");
    // 命令形状：--for tui-idle --timeout-ms
    assert.ok(calls[0]!.includes("--for"));
    assert.ok(calls[0]!.includes("tui-idle"));
    assert.ok(calls[0]!.includes("--timeout-ms"));
  });

  it("read：connected:false → alive:false；正常返回增量与 nextCursor", async () => {
    const cli = stubCli((args) => {
      if (args[1] === "show") {
        return jsonResult({ terminal: { connected: false } });
      }
      return jsonResult({ terminal: { status: "running", tail: ["hello"], nextCursor: "42" } });
    });
    const ch = new OrcaChannel(cli);
    const closed = await ch.read("closed-handle");
    assert.strictEqual(closed.alive, false);

    const cli2 = stubCli((args) => jsonResult({ terminal: { status: "running", tail: ["hello"], nextCursor: "42" } }));
    const ch2 = new OrcaChannel(cli2);
    const r = await ch2.read("h");
    assert.strictEqual(r.text, "hello");
    assert.strictEqual(r.cursor, "42");
    assert.strictEqual(r.alive, true);
    // 空 tail 不推进游标
    const cli3 = stubCli((args) => jsonResult({ terminal: { status: "running", tail: [], nextCursor: "42" } }));
    const ch3 = new OrcaChannel(cli3);
    const r2 = await ch3.read("h");
    assert.strictEqual(r2.cursor, "42");
    assert.strictEqual(r2.text, "");
    const r3 = await ch3.read("h");
    assert.strictEqual(r3.cursor, "42"); // 仍不推进（空读重试）
  });

  it("send 带 --text/--enter；stop 用 --interrupt", async () => {
    const calls: string[][] = [];
    const cli = stubCli((args) => {
      calls.push(args);
      return jsonResult({ ok: true });
    });
    const ch = new OrcaChannel(cli);
    await ch.send("h", "继续");
    await ch.stop("h");
    const send = calls[0]!;
    assert.ok(send.includes("--text") && send.includes("继续") && send.includes("--enter"));
    const stop = calls[1]!;
    assert.ok(stop.includes("--interrupt"));
  });
});
