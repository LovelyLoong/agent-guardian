/**
 * agent-guardian — 任务契约测试（design §9.3 交付项 1，V2a）。
 *
 * 覆盖：形状校验（存在性/JSON/必填字段/数组元素）；CLI --contract 非法 → 退出 2；
 * 契约进完工汇报头部；契约进 LLM 证据包。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContractFile, isTaskContract } from "../src/watcher/contract.ts";
import type { TaskContract } from "../src/watcher/contract.ts";
import { initialState } from "../src/watcher/state.ts";
import { generateReport } from "../src/watcher/report.ts";
import { buildEvidencePack } from "../src/watcher/llm.ts";

const VALID: TaskContract = {
  requirement: "实现 agent-guardian V2a",
  acceptance: ["提醒复现不再自动停止", "预算到期监督者自己退出"],
  scope: ["src/watcher", "scripts"],
  approvedDecisions: ["pause 代替 stop"],
};

function writeContract(dir: string, content: unknown): string {
  const path = join(dir, "contract.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return path;
}

describe("parseContractFile", () => {
  it("合法契约 → ok（完整形状）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-ct-"));
    const path = writeContract(dir, VALID);
    const r = parseContractFile(path);
    assert.strictEqual(r.kind, "ok");
    if (r.kind === "ok") {
      assert.deepStrictEqual(r.contract, VALID);
    }
  });

  it("文件不存在 → error", () => {
    const r = parseContractFile(join(mkdtempSync(join(tmpdir(), "ag-ct-")), "missing.json"));
    assert.strictEqual(r.kind, "error");
    if (r.kind === "error") assert.ok(r.reason.includes("不存在"));
  });

  it("非 JSON → error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-ct-"));
    const path = writeContract(dir, "{ 不是 JSON");
    const r = parseContractFile(path);
    assert.strictEqual(r.kind, "error");
    if (r.kind === "error") assert.ok(r.reason.includes("不是合法 JSON"));
  });

  it("缺 requirement / 空 requirement → error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-ct-"));
    assert.strictEqual(parseContractFile(writeContract(dir, { acceptance: [] })).kind, "error");
    assert.strictEqual(parseContractFile(writeContract(dir, { requirement: "", acceptance: [] })).kind, "error");
  });

  it("acceptance 非数组 / 元素非字符串 / 空串元素 → error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-ct-"));
    const base = { requirement: "r", scope: [], approvedDecisions: [] };
    assert.strictEqual(parseContractFile(writeContract(dir, { ...base, acceptance: "x" })).kind, "error");
    assert.strictEqual(parseContractFile(writeContract(dir, { ...base, acceptance: [1] })).kind, "error");
    assert.strictEqual(parseContractFile(writeContract(dir, { ...base, acceptance: [""] })).kind, "error");
    assert.strictEqual(parseContractFile(writeContract(dir, { ...base, acceptance: [] })).kind, "ok", "空数组合法");
  });

  it("scope / approvedDecisions 缺省或非数组 → error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-ct-"));
    assert.strictEqual(parseContractFile(writeContract(dir, { requirement: "r", acceptance: [] })).kind, "error");
    assert.strictEqual(
      parseContractFile(writeContract(dir, { requirement: "r", acceptance: [], scope: {}, approvedDecisions: [] })).kind,
      "error",
    );
  });

  it("isTaskContract 形状判定（供状态 normalize 复用）", () => {
    assert.strictEqual(isTaskContract(VALID), true);
    assert.strictEqual(isTaskContract(null), false);
    assert.strictEqual(isTaskContract({ requirement: "r" }), false);
    assert.strictEqual(isTaskContract({ ...VALID, acceptance: undefined }), false);
  });
});

describe("CLI --contract（子进程）", () => {
  const cli = join(import.meta.dirname, "..", "scripts", "guardian.ts");

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), "ag-cli-ct-"));
    const res = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf-8",
      env: { ...process.env, AGENT_GUARDIAN_HOME: home },
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it("--contract 指向不存在文件 → 退出 2（校验失败，不进监督循环）", () => {
    const r = run(["watch", "--file", "x.jsonl", "--contract", "C:/nope/contract.json"]);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes("契约"), "stderr 应说明契约错误");
  });

  it("--contract 形状非法 → 退出 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-cli-ct-"));
    const contractPath = writeContract(dir, { requirement: 42 });
    const r = run(["watch", "--file", "x.jsonl", "--contract", contractPath]);
    assert.strictEqual(r.status, 2);
    assert.ok(r.stderr.includes("契约形状非法"), r.stderr);
  });

  it("parseWatchArgs：--contract 解析与缺值", async () => {
    const { parseWatchArgs } = await import("../scripts/guardian.ts");
    const opts = parseWatchArgs(["--file", "s.jsonl", "--contract", "c.json"]);
    assert.ok(typeof opts !== "string");
    assert.strictEqual(opts.contract, "c.json");
    assert.ok(typeof parseWatchArgs(["--file", "s.jsonl", "--contract"]) === "string");
  });
});

describe("契约进汇报头部与证据包", () => {
  it("generateReport 头部含契约（需求/验收/范围/已批准决策）", () => {
    const state = initialState({
      watchId: "w1",
      budgetMs: 120_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "f.jsonl",
      sessionFile: "f.jsonl",
      now: 0,
      contract: VALID,
    });
    const report = generateReport(state, {
      events: [
        { ts: "2026-01-01T00:01:00.000Z", watchId: "w1", type: "escalated", to: "pause", trigger: "spin", pinned: true, reason: "WARNING 未获确认且信号复现，升级为暂停待命" },
      ],
      degraded: false,
    });
    assert.ok(report.includes("## 任务契约"), "契约节在汇报中");
    assert.ok(report.includes("实现 agent-guardian V2a"), "需求");
    assert.ok(report.includes("提醒复现不再自动停止"), "验收标准");
    assert.ok(report.includes("src/watcher"), "范围");
    assert.ok(report.includes("pause 代替 stop"), "已批准决策");
    // 契约节在升级事件节之前（头部优先）
    assert.ok(report.indexOf("## 任务契约") < report.indexOf("## 升级事件"), "契约置顶于头部");
    // 升级事件节在信号统计之前（置顶）
    assert.ok(report.indexOf("## 升级事件") < report.indexOf("## 观察期间触发的信号"), "升级事件置顶展示");
  });

  it("无契约 → 汇报无契约节", () => {
    const state = initialState({
      watchId: "w1",
      budgetMs: 120_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "f.jsonl",
      sessionFile: "f.jsonl",
      now: 0,
    });
    const report = generateReport(state, { events: [], degraded: false });
    assert.ok(!report.includes("## 任务契约"));
  });

  it("buildEvidencePack 从状态携带契约（每次 LLM 证据包均含契约）", () => {
    const state = initialState({
      watchId: "w1",
      budgetMs: 120_000,
      targetKind: "pi",
      channelKind: "file",
      handle: "f.jsonl",
      sessionFile: "f.jsonl",
      now: 0,
      contract: VALID,
    });
    const pack = buildEvidencePack(
      { toolCallsSeen: 1, newToolCalls: 1, signals: [], recentCommands: [], tailSummary: "t" },
      state,
      [],
    );
    assert.deepStrictEqual(pack.contract, VALID);
  });

  it("状态 normalize：契约形状非法 → 降级为 null（不破坏恢复）", async () => {
    const { StateStore } = await import("../src/watcher/state.ts");
    const dir = mkdtempSync(join(tmpdir(), "ag-ct-"));
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(
      join(dir, "state", "w1.json"),
      JSON.stringify({ startedAt: 1, budgetMs: 1000, contract: { requirement: 42 } }),
      "utf-8",
    );
    const store = new StateStore(join(dir, "state"));
    const loaded = await store.load("w1");
    assert.strictEqual(loaded.kind, "ok");
    if (loaded.kind === "ok") {
      assert.strictEqual(loaded.state.contract, null, "非法契约形状 → null（安全侧）");
    }
  });
});
