/**
 * agent-guardian — 状态机测试：原子落盘 / 崩溃恢复 / 列表顺序。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, initialState } from "../src/watcher/state.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ag-state-"));
}

function makeState(overrides: Partial<Parameters<typeof initialState>[0]> = {}) {
  return initialState({
    watchId: "w1",
    budgetMs: 120_000,
    targetKind: "pi",
    channelKind: "file",
    handle: "f.jsonl",
    sessionFile: "f.jsonl",
    now: 1_000,
    ...overrides,
  });
}

describe("StateStore", () => {
  it("保存后可原样读回（崩溃恢复续跑）", async () => {
    const store = new StateStore(tempDir());
    const s = makeState();
    s.settledBeats = 7;
    s.remindCount = 2;
    s.escalationCount = 1;
    s.cooldownUntil = { spin: 9 };
    s.remindHistory = [{ kind: "spin", beat: 3, factsHash: "abc" }];
    s.llmCalls = 1;
    s.safetyWarningTrigger = "budget";
    await store.save("w1", s);

    const loaded = await store.load("w1");
    assert.ok(loaded !== null);
    assert.strictEqual(loaded.settledBeats, 7);
    assert.strictEqual(loaded.remindCount, 2);
    assert.strictEqual(loaded.escalationCount, 1);
    assert.strictEqual(loaded.llmCalls, 1);
    assert.strictEqual(loaded.startedAt, 1_000);
    assert.deepStrictEqual(loaded.cooldownUntil, { spin: 9 });
    assert.deepStrictEqual(loaded.remindHistory, [{ kind: "spin", beat: 3, factsHash: "abc" }]);
    assert.strictEqual(loaded.safetyWarningSent, false);
    assert.strictEqual(loaded.safetyWarningTrigger, "budget");
    assert.strictEqual(loaded.channelKind, "file");
    assert.strictEqual(loaded.targetKind, "pi");
  });

  it("原子落盘：无 .tmp 残留，覆盖写入不产生半写文件", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    const s = makeState();
    await store.save("w1", s);
    s.settledBeats = 99;
    await store.save("w1", s);
    const files = readdirSync(dir);
    assert.ok(files.includes("w1.json"));
    assert.ok(!files.some((f) => f.endsWith(".tmp")));
    const loaded = await store.load("w1");
    assert.strictEqual(loaded?.settledBeats, 99);
  });

  it("损坏状态文件 → 返回 null（从头开始）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(join(dir, "w1.json"), "{ 不是合法 JSON", "utf-8");
    assert.strictEqual(await store.load("w1"), null);
  });

  it("字段缺失的旧状态 → 补默认值（向前兼容）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(
      join(dir, "w1.json"),
      JSON.stringify({ startedAt: 42, settledBeats: 3, cursor: "c1" }),
      "utf-8",
    );
    const loaded = await store.load("w1");
    assert.ok(loaded !== null);
    assert.strictEqual(loaded.settledBeats, 3);
    assert.strictEqual(loaded.remindCount, 0);
    assert.deepStrictEqual(loaded.cooldownUntil, {});
    assert.strictEqual(loaded.safetyWarningSent, false);
    assert.strictEqual(loaded.safetyWarningTrigger, null);
    assert.strictEqual(loaded.budgetMs, 0);
  });

  it("startedAt 非法 → 视为无状态（重头开始）", async () => {
    const dir = tempDir();
    const store = new StateStore(dir);
    writeFileSync(join(dir, "w1.json"), JSON.stringify({ startedAt: "x" }), "utf-8");
    assert.strictEqual(await store.load("w1"), null);
  });

  it("list 按最近修改倒序", async () => {
    const store = new StateStore(tempDir());
    await store.save("old", makeState());
    await new Promise((r) => setTimeout(r, 10));
    await store.save("new", makeState());
    assert.deepStrictEqual(store.list(), ["new", "old"]);
  });
});
