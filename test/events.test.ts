/**
 * agent-guardian — 事件存储测试（M4）：写入/读取失败显式 degraded，不静默变空记录。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/events.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ag-events-"));
}

describe("EventStore", () => {
  it("append 成功返回 true，read/readState 原样读回", () => {
    const store = new EventStore(tempDir());
    assert.strictEqual(store.append("w1", { type: "watch_start" }), true);
    assert.strictEqual(store.append("w1", { type: "decide", action: "remind" }), true);
    const read = store.readState("w1");
    assert.strictEqual(read.degraded, false);
    assert.strictEqual(read.events.length, 2);
    assert.strictEqual(read.events[0]!.type, "watch_start");
    assert.strictEqual(read.events[1]!.action, "remind");
  });

  it("文件不存在 = 合法空：degraded:false（区别于读取失败）", () => {
    const store = new EventStore(tempDir());
    const read = store.readState("nope");
    assert.strictEqual(read.degraded, false);
    assert.deepStrictEqual(read.events, []);
    assert.deepStrictEqual(store.read("nope"), []);
  });

  it("append 写入失败 → 返回 false（显式降级，不静默）", () => {
    // 事件目录路径被一个普通文件占据：mkdirSync/appendFileSync 必然失败
    const dir = tempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf-8");
    const store = new EventStore(blocker);
    assert.strictEqual(store.append("w1", { type: "watch_start" }), false);
  });

  it("文件不可读 → readState 返回 degraded:true + 空事件（不静默当空记录）", () => {
    const dir = tempDir();
    const store = new EventStore(dir);
    store.append("w1", { type: "watch_start" });
    // 把事件文件换成目录 → readFileSync 失败（EISDIR 等）
    rmSync(join(dir, "w1.jsonl"), { force: true });
    mkdirSync(join(dir, "w1.jsonl"), { recursive: true });
    const read = store.readState("w1");
    assert.strictEqual(read.degraded, true);
    assert.deepStrictEqual(read.events, []);
  });

  it("坏行不静默跳过：readState 标记 degraded 但仍返回可读部分（fail-open）", () => {
    const dir = tempDir();
    const store = new EventStore(dir);
    store.append("w1", { type: "watch_start" });
    // 手工追加坏行
    appendFileSync(join(dir, "w1.jsonl"), "{ 坏行\n", "utf-8");
    const read = store.readState("w1");
    assert.strictEqual(read.degraded, true);
    assert.strictEqual(read.events.length, 1);
    assert.strictEqual(read.events[0]!.type, "watch_start");
  });

  it("{} 与空 type 等畸形行 → 标记 degraded，不得当合法事件（M4）", () => {
    const dir = tempDir();
    const store = new EventStore(dir);
    store.append("w1", { type: "watch_start" });
    appendFileSync(join(dir, "w1.jsonl"), "{}\n", "utf-8");
    appendFileSync(join(dir, "w1.jsonl"), '{"type":""}\n', "utf-8");
    appendFileSync(join(dir, "w1.jsonl"), '[1,2]\n', "utf-8");
    const read = store.readState("w1");
    assert.strictEqual(read.degraded, true);
    assert.strictEqual(read.events.length, 1, "{} 等畸形事件不得计入合法事件");
    assert.strictEqual(read.events[0]!.type, "watch_start");
  });

  it("list() 保留 degraded 标记（M4）", () => {
    const dir = tempDir();
    const store = new EventStore(dir);
    store.append("w1", { type: "watch_start" });
    appendFileSync(join(dir, "w1.jsonl"), "{ 坏行\n", "utf-8");
    const all = store.list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0]!.watchId, "w1");
    assert.strictEqual(all[0]!.count, 1);
    assert.strictEqual(all[0]!.degraded, true, "list 不得丢弃降级信息");
  });
});
