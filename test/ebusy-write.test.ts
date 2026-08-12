/**
 * agent-guardian — EBUSY/EPERM 写路径瞬态重试与保守丢锁回归（W1/W2/W3）。
 *
 * 确定性注入：子进程夹具（fixtures/ebusy-inject.ts）在任何 ESM import node:fs
 * 之前用 CJS require 就地替换 module.exports 上的 appendFileSync/readFileSync
 * （ESM 命名空间在首次 import 时读取 module.exports，故源模块必见补丁版）——
 * 跨平台复现 Windows 的"读撞上他人写锁"EBUSY，无需真实并发抢占。
 *
 * 覆盖：
 * - W1：EventStore.append / 账本 appendLedgerLine 走瞬态重试（EBUSY 重试成功、
 *   重试耗尽按降级语义返回 false）；
 * - W2：renewLock 账本 busy 耗尽 → false（保守丢锁）；renew 追加失败 → false；
 *   （"heartbeatAndSave 不写 state"端到端见 lifecycle.test.ts F1 组）
 * - W3：denied 路径 release 瞬态重试成功；持久失败 → stderr 警告不抛错（pid 死亡兜底）。
 *
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

const fixture = join(import.meta.dirname, "fixtures", "ebusy-inject.ts");

interface InjectResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 拉起注入夹具（每次独立临时目录）。 */
function runInject(scenario: string): Promise<InjectResult> {
  const dir = mkdtempSync(join(tmpdir(), "ag-ebusy-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, scenario, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("W1 写路径瞬态重试（EBUSY 不裸失败）", () => {
  it("EventStore.append 遇 EBUSY → 瞬态重试后成功（事件真实落盘）", async () => {
    const r = await runInject("append-retry");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:append-retry:ok"), r.stdout);
  });

  it("EventStore.append 遇 EBUSY 重试耗尽 → 返回 false（降级语义不变，不抛裸错）", async () => {
    const r = await runInject("append-exhausted");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:append-exhausted:ok"), r.stdout);
  });
});

describe("W2 renewLock 保守丢锁（busy/追加失败不得乐观 true）", () => {
  it("账本 busy（瞬态重试耗尽不可读）→ renewLock 返回 false（无法验证归属，宁可误停不可破栅栏）", async () => {
    const r = await runInject("renew-busy");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:renew-busy:ok"), r.stdout);
  });

  it("renew 追加持久失败（EBUSY 重试耗尽，租约未延长）→ renewLock 返回 false", async () => {
    const r = await runInject("renew-append-fail");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:renew-append-fail:ok"), r.stdout);
  });
});

describe("W3 denied 路径 release 失败处理（ghost claim 防回归）", () => {
  it("release 追加遇 EBUSY → 瞬态重试后成功（撤销自建 claim；他人胜者不受影响）", async () => {
    const r = await runInject("release-retry");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:release-retry:ok"), r.stdout);
  });

  it("release 追加持久失败（重试耗尽）→ stderr 警告且不抛错（进程退出后 pid 死亡兜底）", async () => {
    const r = await runInject("release-exhausted");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:release-exhausted:ok"), r.stdout);
    assert.ok(r.stderr.includes("release 行写入失败"), `stderr 应有 ghost 风险警告（实测: ${r.stderr}`);
  });
});

describe("W5 load 错误区分（瞬态耗尽 ≠ 无状态）", () => {
  it("状态文件读恒 EBUSY（瞬态重试耗尽）→ load 返回 {kind:\"error\"}（不得当作 missing/fresh）；ENOENT → missing 可区分", async () => {
    const r = await runInject("load-transient-exhausted");
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("RESULT:load-transient-exhausted:ok"), r.stdout);
  });
});
