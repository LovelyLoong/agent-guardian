/**
 * agent-guardian — 共享文件 IO 瞬态容错测试。
 *
 * 回归：Windows 并发读-写 EBUSY/EPERM 必须按瞬态处理（退避重读），不裸抛。
 * - 确定性单测：mock 抛 EBUSY/EPERM 验证重试路径（次数/退避/重试耗尽/非瞬态不重试）；
 * - 集成：真实并发写者进程持续 append 共享文件，读侧（账本/事件）不得裸抛，
 *   撕裂尾行 / busy 由既有重读逻辑消化。
 * 零 Orca/网络依赖；全部临时目录。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTransientIoError,
  TRANSIENT_IO_ATTEMPTS,
  TRANSIENT_IO_SETTLE_MS,
  withTransientRetry,
  withTransientRetrySync,
} from "../src/shared/fs.ts";
import { StateStore } from "../src/watcher/state.ts";
import { EventStore } from "../src/events.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ag-fs-"));
}

function err(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("shared/fs 瞬态 IO 容错（EBUSY/EPERM）", () => {
  it("isTransientIoError：EBUSY/EPERM 为瞬态，其余不是", () => {
    assert.ok(isTransientIoError(err("EBUSY")));
    assert.ok(isTransientIoError(err("EPERM")));
    assert.ok(!isTransientIoError(err("ENOENT")));
    assert.ok(!isTransientIoError(err("EACCES")));
    assert.ok(!isTransientIoError(new Error("boom")));
  });

  it("withTransientRetrySync：EBUSY 瞬态重试后成功返回", () => {
    let calls = 0;
    const out = withTransientRetrySync(() => {
      calls++;
      if (calls <= 2) throw err("EBUSY");
      return "ok";
    });
    assert.strictEqual(out, "ok");
    assert.strictEqual(calls, 3, "第 1、2 次 EBUSY 重试，第 3 次成功");
  });

  it("withTransientRetrySync：EPERM 同样瞬态重试", () => {
    let calls = 0;
    const out = withTransientRetrySync(() => {
      calls++;
      if (calls === 1) throw err("EPERM");
      return 42;
    });
    assert.strictEqual(out, 42);
    assert.strictEqual(calls, 2);
  });

  it("withTransientRetrySync：重试耗尽才视为真错误（抛末次错误）", () => {
    let calls = 0;
    assert.throws(
      () =>
        withTransientRetrySync(() => {
          calls++;
          throw err("EBUSY");
        }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "EBUSY",
    );
    assert.strictEqual(calls, TRANSIENT_IO_ATTEMPTS, "恰好重试 TRANSIENT_IO_ATTEMPTS 次");
  });

  it("withTransientRetrySync：非瞬态错误不重试，立即抛", () => {
    let calls = 0;
    assert.throws(
      () =>
        withTransientRetrySync(() => {
          calls++;
          throw err("ENOENT");
        }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.strictEqual(calls, 1);
  });

  it("withTransientRetry（异步）：EBUSY 瞬态重试后成功返回", async () => {
    let calls = 0;
    const out = await withTransientRetry(() => {
      calls++;
      if (calls === 1) throw err("EBUSY");
      return "ok";
    });
    assert.strictEqual(out, "ok");
    assert.strictEqual(calls, 2);
  });

  it("重试之间确实退避（≥ TRANSIENT_IO_SETTLE_MS）", () => {
    let calls = 0;
    const start = Date.now();
    withTransientRetrySync(() => {
      calls++;
      if (calls === 1) throw err("EBUSY");
      return null;
    });
    assert.ok(Date.now() - start >= TRANSIENT_IO_SETTLE_MS, "至少退避一次");
  });
});

describe("共享文件并发 append 下读取不裸抛（EBUSY/EPERM 瞬态容忍集成）", () => {
  // 写者进程：循环 append 账本与事件文件（复刻 Windows 上多进程并发追加同一文件的读-写冲突）
  const WRITER_SRC = `
    const { appendFileSync } = require("node:fs");
    const dir = process.argv[1];
    const watchId = process.argv[2];
    const lock = dir + "/" + watchId + ".lock";
    const ev = dir + "/" + watchId + ".jsonl";
    const end = Date.now() + 5000;
    let i = 0;
    for (;;) {
      if (Date.now() > end) break;
      appendFileSync(lock, JSON.stringify({ op: "renew", runId: "writer-" + process.pid, leaseExpiresAt: Date.now() + 600000, ts: Date.now() }) + "\\n", "utf-8");
      appendFileSync(ev, JSON.stringify({ ts: new Date().toISOString(), watchId, type: "noise", i: i++ }) + "\\n", "utf-8");
    }
  `;

  it("读侧（readLedger / readState / claimLock）在持续并发 append 下不裸抛", async () => {
    const dir = tempDir();
    const watchId = "w-busy";
    const writers = Array.from({ length: 8 }, () =>
      spawn(process.execPath, ["-e", WRITER_SRC, dir, watchId], { stdio: "ignore" }),
    );
    // 先注册退出等待再 kill，避免 exit 事件竞争
    const exited = writers.map((w) =>
      w.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => w.once("exit", () => resolve())),
    );
    try {
      const store = new StateStore(dir);
      const events = new EventStore(dir);
      const deadline = Date.now() + 1_500;
      let reads = 0;
      while (Date.now() < deadline) {
        const ledger = store.readLedger(watchId); // 不得裸抛：busy 按瞬态处理
        assert.strictEqual(typeof ledger.busy, "boolean");
        const state = events.readState(watchId); // 不得裸抛：EBUSY/EPERM 瞬态重试后才降级
        assert.strictEqual(typeof state.degraded, "boolean");
        reads++;
        await new Promise((r) => setTimeout(r, 1));
      }
      assert.ok(reads >= 10, `窗口内应完成足量读取（实测 ${reads}）`);
      // 并发写者的行要么完整可见、要么被撕裂跳过：解析出的行必须形状合法
      const ledger = store.readLedger(watchId);
      for (const line of ledger.lines) {
        assert.ok(line.op === "claim" || line.op === "renew" || line.op === "release", "账本行必须合法");
      }
      // claimLock 在持续并发 append 下不得抛异常（acquired/denied 皆可，读侧按瞬态裁决）
      const claim = await store.claimLock(watchId, { prev: null, watchRunId: "run-busy", now: Date.now() });
      assert.ok(claim.kind === "acquired" || claim.kind === "denied", `claim 必须给出裁决（实测 ${claim.kind}）`);
    } finally {
      for (const w of writers) w.kill();
      await Promise.all(exited);
    }
  });
});
