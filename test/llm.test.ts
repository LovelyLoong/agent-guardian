/**
 * agent-guardian — LLM 回调契约测试：
 * schema 校验（非法 → silence + 记录）、stop → 降级 pause、回调命令执行。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecisionOutput, makeLlmConsult, splitCommand } from "../src/watcher/llm.ts";
import { sanitizeText } from "../src/watcher/sanitize.ts";
import type { ShellExec } from "../src/watcher/llm.ts";

describe("parseDecisionOutput", () => {
  it("合法 silence", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "silence" }));
    assert.strictEqual(r.note, "ok");
    assert.strictEqual(r.decision.action, "silence");
  });

  it("合法 remind/pause/panel", () => {
    const remind = parseDecisionOutput(JSON.stringify({ action: "remind", message: "m", reason: "r" }));
    assert.strictEqual(remind.decision.action, "remind");
    assert.strictEqual(remind.decision.message, "m");
    const pause = parseDecisionOutput(JSON.stringify({ action: "pause", message: "p" }));
    assert.strictEqual(pause.decision.action, "pause");
    assert.strictEqual(pause.decision.reason, "llm-pause"); // reason 缺省时派生
    const panel = parseDecisionOutput(JSON.stringify({ action: "panel", question: "q" }));
    assert.strictEqual(panel.decision.action, "panel");
    assert.strictEqual(panel.decision.question, "q");
  });

  it("remind 缺 message → 非法 → silence + 记录", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "remind" }));
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.startsWith("llm-invalid:"));
    assert.ok(r.detail!.includes("message"));
  });

  it("panel 缺 question → 非法", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "panel", question: "" }));
    assert.strictEqual(r.note, "invalid");
  });

  it("非 JSON 输出 → 非法 → silence", () => {
    const r = parseDecisionOutput("随便一段话");
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.startsWith("llm-invalid:"));
  });

  it("未知 action → 非法", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "explode" }));
    assert.strictEqual(r.note, "invalid");
  });

  it("空输出 → 非法", () => {
    const r = parseDecisionOutput("");
    assert.strictEqual(r.note, "invalid");
  });

  it("LLM 返回 stop → 降级为 pause 并记录 stop-downgraded", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "stop", reason: "模型想停止" }));
    assert.strictEqual(r.note, "stop-downgraded");
    assert.strictEqual(r.decision.action, "pause");
    assert.ok(r.decision.reason.includes("llm-stop-downgraded"));
    assert.ok(r.decision.message.length > 0);
  });
});

describe("makeLlmConsult", () => {
  it("写入证据文件、以 judge 模板渲染的 prompt 作为参数调用命令、解析其 stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-llm-"));
    const calls: string[] = [];
    const fakeExec: ShellExec = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { code: 0, stdout: JSON.stringify({ action: "pause", message: "来自假 LLM" }), stderr: "" };
    };
    const consult = makeLlmConsult({ cmd: "node fake-decider.mjs", exec: fakeExec, evidenceDir: dir, watchId: "w1" });
    const evidence = {
      facts: { toolCallsSeen: 3, newToolCalls: 1, signals: [], recentCommands: [], tailSummary: "t" },
      state: { settledBeats: 5, remindCount: 1, escalationCount: 2, llmCalls: 1, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "任务",
      recentEvents: [{ type: "x" }],
      contract: null,
    };
    const result = await consult(evidence);
    assert.strictEqual(result.note, "ok");
    assert.strictEqual(result.decision.action, "pause");
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0]!.includes("node fake-decider.mjs"));
    // V2a：最后一个参数是渲染后的判断者 prompt（含证据路径指令与输出 schema），不是裸路径
    assert.ok(calls[0]!.includes("guardian-judge"), "应传 judge 模板 prompt");
    assert.ok(calls[0]!.includes(".json"), "prompt 内含证据文件路径指令");
    const files = readdirSync(dir);
    assert.strictEqual(files.length, 1);
    const written = JSON.parse(readFileSync(join(dir, files[0]!), "utf-8"));
    assert.strictEqual(written.taskSummary, "任务");
    assert.strictEqual(written.contract, null);
  });

  it("回调命令以参数数组调用：cmd/args 分离，最后一个字面参数为渲染后的 judge prompt（M3）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-llm-"));
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeExec: ShellExec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ action: "silence" }), stderr: "" };
    };
    const consult = makeLlmConsult({ cmd: "node fake-decider.mjs", exec: fakeExec, evidenceDir: dir, watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "ok");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.cmd, "node", "cmd 不得含 shell 拼接");
    assert.deepStrictEqual(calls[0]!.args.slice(0, 1), ["fake-decider.mjs"]);
    // V2a：最后参数是 prompt 文本（非裸证据路径）；prompt 内含证据文件路径
    const prompt = calls[0]!.args[1]!;
    assert.ok(prompt.includes("guardian-judge"), "prompt 含判断者角色");
    assert.ok(prompt.includes(".json"), "prompt 内含证据文件路径");
    assert.strictEqual(calls[0]!.args.length, 2, "prompt 为单个字面参数（不拆散、不经 shell）");
    const evidencePath = prompt.match(/证据文件（JSON，先读取再判断）：(.+)/)?.[1];
    assert.ok(evidencePath !== undefined && evidencePath.endsWith(".json"), "prompt 含证据路径指令");
  });

  it("命令执行失败 → 非法 → silence", async () => {
    const fakeExec: ShellExec = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const consult = makeLlmConsult({ cmd: "nope", exec: fakeExec, evidenceDir: mkdtempSync(join(tmpdir(), "ag-llm-")), watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "invalid");
  });

  it("非零退出码但 stdout 有合法 JSON → 仍视为回调失败，不执行（B2）", async () => {
    const fakeExec: ShellExec = async () => ({
      code: 2,
      stdout: JSON.stringify({ action: "pause", message: "不该被执行" }),
      stderr: "模型进程崩溃",
    });
    const consult = makeLlmConsult({ cmd: "crashed-decider", exec: fakeExec, evidenceDir: mkdtempSync(join(tmpdir(), "ag-llm-")), watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.includes("非零退出"));
  });

  it("证据包写入异常 → 降级 invalid，不调用命令、不崩溃（B2）", async () => {
    // evidenceDir 指向一个已存在的普通文件：mkdirSync 必然失败
    const notADir = mkdtempSync(join(tmpdir(), "ag-llm-"));
    const blocker = join(notADir, "blocker");
    writeFileSync(blocker, "x", "utf-8");
    let called = false;
    const fakeExec: ShellExec = async () => {
      called = true;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const consult = makeLlmConsult({ cmd: "node x.mjs", exec: fakeExec, evidenceDir: blocker, watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.includes("证据包写入失败"));
    assert.strictEqual(called, false, "证据包写入失败时不得执行回调命令");
  });
});

describe("splitCommand（M3：命令行拆 argv，不经 shell）", () => {
  it("普通命令与默认 memberCmd", () => {
    assert.deepStrictEqual(splitCommand("pi -p"), { cmd: "pi", args: ["-p"] });
    assert.deepStrictEqual(splitCommand("node fake-decider.mjs --flag"), {
      cmd: "node",
      args: ["fake-decider.mjs", "--flag"],
    });
  });

  it("空串/多余空白 → 空 argv", () => {
    assert.deepStrictEqual(splitCommand(""), { cmd: "", args: [] });
    assert.deepStrictEqual(splitCommand("   node    x.mjs   "), { cmd: "node", args: ["x.mjs"] });
  });

  it("含注入字符的命令文本拆为独立 argv 元素，不再经 shell 解释", () => {
    const s = splitCommand('node decider $(touch /tmp/x) "q"');
    assert.strictEqual(s.cmd, "node");
    assert.deepStrictEqual(s.args, ["decider", "$(touch", "/tmp/x)", "q"]);
  });

  it("M1 引号感知：双引号成组、组内空格保留、外层引号剥除（含空格路径）", () => {
    const s = splitCommand('"C:\\Program Files\\agent.exe" -p');
    assert.strictEqual(s.cmd, "C:\\Program Files\\agent.exe");
    assert.deepStrictEqual(s.args, ["-p"]);
  });

  it("M1 引号感知：组内空格保留；未闭合引号吞到行尾", () => {
    const s = splitCommand('node "my decider.mjs" --flag');
    assert.deepStrictEqual(s, { cmd: "node", args: ["my decider.mjs", "--flag"] });
    assert.deepStrictEqual(splitCommand('node "x y'), { cmd: "node", args: ["x y"] });
  });

  it("M1 引号感知边角（文档化）：单引号不成组、反斜杠是字面字符非转义", () => {
    assert.deepStrictEqual(splitCommand("pi 'a b'").args, ["'a", "b'"]);
    assert.deepStrictEqual(splitCommand('node "a\\"b"').args, ["a\\b"]);
  });
});

describe("B3 契约上限与净化", () => {
  it("stdout 超 64KB → invalid → silence（契约上限）", async () => {
    const fakeExec: ShellExec = async () => ({ code: 0, stdout: "x".repeat(64 * 1024 + 1), stderr: "" });    const consult = makeLlmConsult({ cmd: "node x.mjs", exec: fakeExec, evidenceDir: mkdtempSync(join(tmpdir(), "ag-llm-")), watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.includes("契约上限"));
  });

  it("message 超 2KB → invalid → silence（契约上限）", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "remind", message: "x".repeat(2049) }));
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.includes("契约上限"));
  });

  it("message 恰在 2KB 内 → 合法", () => {
    const r = parseDecisionOutput(JSON.stringify({ action: "pause", message: "x".repeat(2048) }));
    assert.strictEqual(r.note, "ok");
    assert.strictEqual(r.decision.action, "pause");
  });

  it("stdout 按 UTF-8 字节计上限：30000 个汉字（约 90KB 字节）→ invalid → silence（M4）", async () => {
    const big = "汉".repeat(30_000);
    assert.ok(Buffer.byteLength(big, "utf8") > 64 * 1024, "前置：字节数应超限");
    const fakeExec: ShellExec = async () => ({ code: 0, stdout: big, stderr: "" });
    const consult = makeLlmConsult({ cmd: "node x.mjs", exec: fakeExec, evidenceDir: mkdtempSync(join(tmpdir(), "ag-llm-")), watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.includes("契约上限"));
  });

  it("stdout 字符数 ≤64K 但 UTF-8 字节 >64KB → invalid（M4：按字节判定，防多字节绕过）", async () => {
    const big = JSON.stringify({ action: "silence", reason: "汉".repeat(22_000) });
    assert.ok(Buffer.byteLength(big, "utf8") > 64 * 1024, "前置：字节数应超限");
    assert.ok(big.length < 64 * 1024, "前置：字符数未超旧按字符判定阈值");
    const fakeExec: ShellExec = async () => ({ code: 0, stdout: big, stderr: "" });
    const consult = makeLlmConsult({ cmd: "node x.mjs", exec: fakeExec, evidenceDir: mkdtempSync(join(tmpdir(), "ag-llm-")), watchId: "w1" });
    const r = await consult({
      facts: { toolCallsSeen: 0, newToolCalls: 0, signals: [], recentCommands: [], tailSummary: "" },
      state: { settledBeats: 0, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1, targetKind: "pi" },
      taskSummary: "",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(r.note, "invalid");
    assert.strictEqual(r.decision.action, "silence");
    assert.ok(r.decision.reason.includes("契约上限"));
  });

  it("sanitizeText：去控制字符（保留换行/制表）、trim、长度截断", () => {
    assert.strictEqual(sanitizeText("a\u0000b\u001Bc\u0007d\ne\tf"), "abcd\ne\tf");
    assert.strictEqual(sanitizeText("   padded  "), "padded");
    assert.strictEqual(sanitizeText("x".repeat(3000), 2000).length, 2000);
  });
});
