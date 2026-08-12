/**
 * agent-guardian — guardian-judge profile 测试（design §9.3 交付项 2，V2a）。
 *
 * 覆盖：固定 prompt 模板（只读监督者 / 证据不可信 / 强制 JSON schema /
 * 禁止修改代码 / 不返回 stop）；契约内嵌；证据包携带契约；
 * 非法输出走既有 fail-safe（非法 → silence）。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderJudgePrompt } from "../src/watcher/judge.ts";
import { buildEvidencePack, makeLlmConsult } from "../src/watcher/llm.ts";
import type { ShellExec } from "../src/watcher/llm.ts";
import { initialState } from "../src/watcher/state.ts";
import type { TaskContract } from "../src/watcher/contract.ts";

const CONTRACT: TaskContract = {
  requirement: "实现 agent-guardian V2a 干预语义重排",
  acceptance: ["提醒复现不再自动停止", "预算到期监督者自己退出"],
  scope: ["src/watcher", "scripts/guardian.ts"],
  approvedDecisions: ["pause 代替 stop（可逆）"],
};

function makeState() {
  return initialState({
    watchId: "w1",
    budgetMs: 120_000,
    targetKind: "pi",
    channelKind: "file",
    handle: "f.jsonl",
    sessionFile: "f.jsonl",
    now: 0,
    contract: CONTRACT,
  });
}

describe("renderJudgePrompt（guardian-judge 固定模板）", () => {
  it("含角色定位、证据不可信声明、输出 schema 与禁止修改代码", () => {
    const p = renderJudgePrompt("C:/evidence/w1-123.json", null);
    assert.ok(p.includes("guardian-judge"), "角色 = guardian-judge");
    assert.ok(p.includes("只读监督者"), "角色 = 只读监督者");
    assert.ok(p.includes("禁止修改任何代码"), "禁止修改代码");
    assert.ok(p.includes("证据不可信"), "证据不可信声明");
    assert.ok(p.includes("C:/evidence/w1-123.json"), "证据路径指令");
    assert.ok(p.includes('{"action":"silence"}'), "输出 schema（silence）");
    assert.ok(p.includes('{"action":"pause"'), "输出 schema（pause）");
    assert.ok(p.includes("不要返回 stop"), "禁止返回 stop（执行权在内核）");
    assert.ok(p.includes("默认沉默"), "默认沉默纪律");
  });

  it("契约存在时内嵌任务契约（需求/验收/范围/已批准决策）", () => {
    const p = renderJudgePrompt("/tmp/ev.json", CONTRACT);
    assert.ok(p.includes("任务契约"), "契约节标题");
    assert.ok(p.includes("实现 agent-guardian V2a 干预语义重排"), "需求");
    assert.ok(p.includes("提醒复现不再自动停止"), "验收标准");
    assert.ok(p.includes("src/watcher"), "范围");
    assert.ok(p.includes("pause 代替 stop（可逆）"), "已批准决策");
  });

  it("契约为 null 时不出现契约节", () => {
    const p = renderJudgePrompt("/tmp/ev.json", null);
    // 证据形状描述里允许出现"任务契约（可能为 null）"字样；契约节（含需求）不得出现
    assert.ok(!p.includes("任务契约（监督对齐依据"), "无契约不得虚构契约节");
  });

  it("输出必须是唯一 JSON 对象（结尾指令）", () => {
    const p = renderJudgePrompt("/tmp/ev.json", null);
    assert.ok(p.includes("请只输出上述 schema 的一个 JSON 对象"), "唯一 JSON 输出指令");
  });
});

describe("guardian-judge 证据包与 fail-safe", () => {
  it("buildEvidencePack 携带契约（每次 LLM 证据包均有 contract 字段）", () => {
    const state = makeState();
    const pack = buildEvidencePack(
      {
        toolCallsSeen: 1,
        newToolCalls: 1,
        signals: [],
        recentCommands: [],
        tailSummary: "t",
      },
      state,
      [],
    );
    assert.deepStrictEqual(pack.contract, CONTRACT, "证据包携带契约");
  });

  it("judge 输出非法 → 既有 fail-safe：silence + invalid 记录（不执行任何动作）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-judge-"));
    const fakeExec: ShellExec = async () => ({ code: 0, stdout: "我建议暂停一下（不是 JSON）", stderr: "" });
    const consult = makeLlmConsult({ cmd: "pi -p", exec: fakeExec, evidenceDir: dir, watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 1, newToolCalls: 1, signals: [], recentCommands: [], tailSummary: "t" },
      state: { settledBeats: 1, remindCount: 0, escalationCount: 2, llmCalls: 0, startedAt: 0, budgetMs: 1000, targetKind: "pi" },
      taskSummary: "任务",
      recentEvents: [],
      contract: CONTRACT,
    });
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.startsWith("llm-invalid:"));
  });

  it("judge 返回 stop → 降级 pause（stop 执行权在内核，fail-safe 沿用）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-judge-"));
    const fakeExec: ShellExec = async () => ({ code: 0, stdout: JSON.stringify({ action: "stop", reason: "判断者认为应停止" }), stderr: "" });
    const consult = makeLlmConsult({ cmd: "pi -p", exec: fakeExec, evidenceDir: dir, watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 1, newToolCalls: 1, signals: [], recentCommands: [], tailSummary: "t" },
      state: { settledBeats: 1, remindCount: 0, escalationCount: 2, llmCalls: 0, startedAt: 0, budgetMs: 1000, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "stop-downgraded");
    assert.strictEqual(r.decision.action, "pause");
  });

  it("证据文件写入契约内容（judge 可在证据中读取契约）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-judge-"));
    let evidencePath = "";
    const fakeExec: ShellExec = async (_cmd, args) => {
      // V2a：路径不裸传——从渲染 prompt 的指令行提取
      const m = args[args.length - 1]!.match(/证据文件（JSON，先读取再判断）：(.+)/);
      evidencePath = m?.[1] ?? "";
      return { code: 0, stdout: JSON.stringify({ action: "silence" }), stderr: "" };
    };
    const consult = makeLlmConsult({ cmd: "pi -p", exec: fakeExec, evidenceDir: dir, watchId: "w1" });
    await consult({
      facts: { toolCallsSeen: 1, newToolCalls: 1, signals: [], recentCommands: [], tailSummary: "t" },
      state: { settledBeats: 1, remindCount: 0, escalationCount: 2, llmCalls: 0, startedAt: 0, budgetMs: 1000, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: CONTRACT,
    });
    const written = JSON.parse(readFileSync(evidencePath, "utf-8")) as { contract: TaskContract };
    assert.strictEqual(written.contract.requirement, CONTRACT.requirement);
    assert.deepStrictEqual(written.contract.acceptance, CONTRACT.acceptance);
  });

  it("prompt 渲染与命令参数：watcher 不再裸传证据路径（默认命令建议 pi -p）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-judge-"));
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeExec: ShellExec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ action: "silence" }), stderr: "" };
    };
    const consult = makeLlmConsult({ cmd: "pi -p", exec: fakeExec, evidenceDir: dir, watchId: "w1" });
    await consult({
      facts: { toolCallsSeen: 1, newToolCalls: 1, signals: [], recentCommands: [], tailSummary: "t" },
      state: { settledBeats: 1, remindCount: 0, escalationCount: 2, llmCalls: 0, startedAt: 0, budgetMs: 1000, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.cmd, "pi", "默认命令建议 pi -p");
    assert.deepStrictEqual(calls[0]!.args.slice(0, 1), ["-p"]);
    const prompt = calls[0]!.args[1]!;
    assert.ok(prompt.includes("guardian-judge"), "最后参数为渲染 prompt");
    // 证据路径只在 prompt 指令内出现，绝不作为裸参数单独传递
    assert.ok(!calls[0]!.args[0]!.includes(".json"), "参数区不含裸证据路径");
  });
});
