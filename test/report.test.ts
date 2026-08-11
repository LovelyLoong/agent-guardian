/**
 * agent-guardian — 完工汇报测试（M5）：统计口径与事件对齐、收尾原因、degraded 显式化。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { EventReadResult } from "../src/events.ts";
import { initialState } from "../src/watcher/state.ts";
import type { WatchState } from "../src/watcher/state.ts";
import { generateReport } from "../src/watcher/report.ts";

function makeState(overrides: Partial<WatchState> = {}): WatchState {
  return {
    ...initialState({
      watchId: "w1",
      budgetMs: 120_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "f.jsonl",
      sessionFile: "f.jsonl",
      now: 1_000,
    }),
    ...overrides,
  };
}

function readOf(events: Array<Record<string, unknown>>, degraded = false): EventReadResult {
  return { events: events as EventReadResult["events"], degraded };
}

function event(ts: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: `2026-01-01T00:${ts}:00.000Z`, watchId: "w1", type, ...extra };
}

describe("generateReport", () => {
  it("信号统计与 decide 事件的 signals 字段对齐（不依赖 cooldown reason）", () => {
    const state = makeState({ settledBeats: 3 });
    const report = generateReport(state, readOf([
      event("01", "decide", { action: "remind", reason: "机械提醒", signals: ["spin"] }),
      event("02", "decide", { action: "silence", reason: "cooldown:spin", signals: ["spin", "stall"] }),
    ]));
    assert.ok(report.includes("原地重复：2 次"), report);
    assert.ok(report.includes("进展停滞：1 次"), report);
    assert.ok(!report.includes("（无）"), "有信号时不得误显无信号");
  });

  it("无 decide 事件 → 信号（无）；无动作 → 全程沉默观察", () => {
    const report = generateReport(makeState(), readOf([event("01", "watch_start")]));
    assert.ok(report.includes("（无）"));
    assert.ok(report.includes("全程沉默观察"));
  });

  it("收尾方式取 finish 事件的 reason（watcher 先追加 finish 再生成报告）", () => {
    const report = generateReport(makeState(), readOf([
      event("01", "watch_start"),
      event("02", "finish", { exitCode: 0, reportPath: "r.md", reason: "预算到期，目标静止" }),
    ]));
    assert.ok(report.includes("- 预算到期，目标静止"));
    assert.ok(!report.includes("未记录收尾事件"));
  });

  it("没有 finish 事件 → 未记录收尾事件（如 SIGINT 中断后的重生成）", () => {
    const report = generateReport(makeState(), readOf([event("01", "watch_start")]));
    assert.ok(report.includes("未记录收尾事件"));
  });

  it("事件读取降级 → 显式标注，不得静默当无记录（M4/M5）", () => {
    const report = generateReport(makeState(), readOf([], true));
    assert.ok(report.includes("事件记录读取降级"));
    assert.ok(report.includes("收尾详情无法确认：事件记录读取降级"));
    assert.ok(!report.includes("（无，全程沉默观察）"));
  });

  it("finish 事件写入失败 → 报告显式声明收尾事件未能记录（fail-open ≠ silent）", () => {
    const report = generateReport(makeState(), readOf([event("01", "watch_start")]), { finishRecorded: false });
    assert.ok(report.includes("收尾事件写入失败（记录降级）"));
    assert.ok(!report.includes("未记录收尾事件"));
  });

  it("reason 输出净化：控制字符剥离、换行压平（m3/B3）", () => {
    const report = generateReport(makeState(), readOf([
      event("01", "decide", { action: "remind", reason: "LLM 文本\u0000\u001B控制\u0007\n第二行" }),
      event("02", "finish", { exitCode: 0, reportPath: "r.md", reason: "正常收尾\u0000" }),
    ]));
    assert.ok(!report.includes("\u0000"), "控制字符不得进入汇报");
    assert.ok(!report.includes("\u001B"));
    assert.ok(report.includes("LLM 文本控制 第二行"), "控制字符剥离、换行压平");
    assert.ok(report.includes("正常收尾"));
  });

  it("eventsDegraded 状态 → 报告显式标注记录降级（M4）", () => {
    const report = generateReport(makeState({ eventsDegraded: true }), readOf([event("01", "watch_start")]));
    assert.ok(report.includes("事件落盘曾失败"));
  });
});
