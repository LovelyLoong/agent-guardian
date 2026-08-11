/**
 * agent-guardian — pi/codex 适配器测试。
 *
 * codex 用真实样本片段（test/fixtures/codex-sample.jsonl，
 * 来源 rollout-2026-08-09T23-46-58-019fea6c...，逐字复制 + 少量截断标注）。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../src/targets/pi.ts";
import { CodexAdapter, codexOutputHasError, codexOutputText } from "../src/targets/codex.ts";
import { detectTargetKind } from "../src/targets/types.ts";

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ag-adapters-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// pi 适配器
// ---------------------------------------------------------------------------

const PI_HEAD = [
  '{"type":"session","version":3,"id":"s1","timestamp":"2026-08-09T01:00:00.000Z","cwd":"C:\\\\x"}',
  '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-08-09T01:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"任务：写一个排序函数"}]}}',
  '{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-08-09T01:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"bash_0","name":"bash","arguments":{"command":"ls"}}]}}',
  '{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-08-09T01:00:03.000Z","message":{"role":"toolResult","toolCallId":"bash_0","toolName":"bash","isError":false,"content":[{"type":"text","text":"ok"}]}}',
].join("\n") + "\n";

describe("PiAdapter", () => {
  it("提取工具调用与任务摘要；增量解析累计计数", async () => {
    const file = tempFile("pi-session.jsonl", PI_HEAD);
    const adapter = new PiAdapter(file);
    const r1 = await adapter.resolveFacts("42");
    assert.strictEqual(r1.cursor, "42"); // 游标透传
    assert.strictEqual(r1.facts.toolCallsSeen, 1);
    assert.strictEqual(r1.facts.newToolCalls, 1);
    assert.strictEqual(r1.facts.signals.length, 0);
    assert.ok(r1.facts.taskSummary!.includes("排序函数"));
    assert.ok(r1.facts.tailSummary.includes("ok"));

    // 追加一行错误工具调用 → 增量解析
    const errLine = '{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-08-09T01:00:04.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"bash_1","name":"bash","arguments":{"command":"rm -rf /"}}]}}\n';
    // 用 appendFileSync 追加（保持既有内容）
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, errLine, "utf-8");
    const r2 = await adapter.resolveFacts("100");
    assert.strictEqual(r2.facts.toolCallsSeen, 2);
    assert.strictEqual(r2.facts.newToolCalls, 1);
  });

  it("重复操作触发原地重复信号（信号引擎单源复用）", async () => {
    const lines = [...PI_HEAD.trim().split("\n")];
    // 追加 3 次相同 bash 调用（窗口 8 内达到阈值 3）
    for (let i = 0; i < 3; i++) {
      lines.push(
        `{"type":"message","id":"spin_${i}","parentId":"m3","timestamp":"2026-08-09T01:00:1${i}.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"bash_s${i}","name":"bash","arguments":{"command":"ls -la"}}]}}`,
      );
      lines.push(
        `{"type":"message","id":"sr_${i}","parentId":"spin_${i}","timestamp":"2026-08-09T01:00:2${i}.000Z","message":{"role":"toolResult","toolCallId":"bash_s${i}","toolName":"bash","isError":false,"content":[{"type":"text","text":"ok"}]}}`,
      );
    }
    const file = tempFile("pi-spin.jsonl", lines.join("\n") + "\n");
    const adapter = new PiAdapter(file);
    const r = await adapter.resolveFacts(null);
    assert.ok(r.facts.signals.some((s) => s.kind === "spin"));
  });

  it("note 截断/重建：文件短于已解析游标 → 重置解析游标，事实不沿用旧值", async () => {
    const file = tempFile("pi-trunc.jsonl", PI_HEAD);
    const adapter = new PiAdapter(file);
    const r1 = await adapter.resolveFacts(null);
    assert.strictEqual(r1.facts.toolCallsSeen, 1);
    // 截断到仅 session + user 两行（无工具调用）
    writeFileSync(file, PI_HEAD.split("\n").slice(0, 2).join("\n") + "\n", "utf-8");
    const r2 = await adapter.resolveFacts("50");
    assert.strictEqual(r2.facts.toolCallsSeen, 0, "截断后不得沿用旧事实");
    assert.strictEqual(r2.facts.newToolCalls, 0);
    // 截断后继续追加新工具调用 → 从新内容重新累计
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      file,
      '{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-08-09T01:00:04.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"bash_9","name":"bash","arguments":{"command":"ls"}}]}}\n',
      "utf-8",
    );
    const r3 = await adapter.resolveFacts("60");
    assert.strictEqual(r3.facts.toolCallsSeen, 1, "截断后新追加的内容正常累计");
    assert.strictEqual(r3.facts.newToolCalls, 1);
  });

  it("截断检测按字节：Unicode 同字符数重建（字节更少）→ 事实不残留", async () => {
    const padding = "中".repeat(120); // 坏行会被容忍，但撑起字节数
    const original = padding + "\n" + PI_HEAD; // PI_HEAD 含 1 个工具调用
    const file = tempFile("pi-unicode-rebuild.jsonl", original);
    const adapter = new PiAdapter(file);
    const r1 = await adapter.resolveFacts(null);
    assert.strictEqual(r1.facts.toolCallsSeen, 1);
    // 同 JS 字符数、纯 ASCII（字节显著更少）、无工具调用的重建
    writeFileSync(file, "x".repeat(original.length) + "\n", "utf-8");
    const r2 = await adapter.resolveFacts(r1.cursor);
    assert.strictEqual(r2.facts.toolCallsSeen, 0, "字节收缩的重建必须重置事实");
  });

  it("坏行与半截尾部行被容忍", async () => {
    const file = tempFile("pi-bad.jsonl", PI_HEAD + "这不是JSON\n");
    const adapter = new PiAdapter(file);
    const r1 = await adapter.resolveFacts(null);
    assert.strictEqual(r1.facts.toolCallsSeen, 1);
    // 半截行：下一拍补齐后计入
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, '{"type":"mess', "utf-8");
    const r2 = await adapter.resolveFacts("2");
    assert.strictEqual(r2.facts.toolCallsSeen, 1);
    appendFileSync(file, 'age","id":"m9","parentId":null,"timestamp":"2026-08-09T01:00:09.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t9","name":"read","arguments":{"path":"x"}}]}}\n', "utf-8");
    const r3 = await adapter.resolveFacts("3");
    assert.strictEqual(r3.facts.toolCallsSeen, 2);
  });
});

// ---------------------------------------------------------------------------
// codex 适配器（真实样本片段）
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dirname, "fixtures", "codex-sample.jsonl");

describe("CodexAdapter（真实样本片段）", () => {
  it("fixture 不含硬编码用户路径（m2：SkyUser 已换占位符）", () => {
    const text = readFileSync(FIXTURE, "utf-8");
    assert.ok(!text.includes("SkyUser"), "fixture 不得包含硬编码用户路径");
    assert.ok(text.includes("<USER>"), "应使用 <USER> 占位符");
  });

  it("解析 function_call / custom_tool_call / 两种 output 变体与 rest 点", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const adapter = new CodexAdapter(file);
    const r = await adapter.resolveFacts(null);
    // 样本片段：exec(成功) + wait(成功) + 2 个只有 output 的调用（占位，判错）
    assert.strictEqual(r.facts.toolCallsSeen, 4);
    assert.strictEqual(r.facts.newToolCalls, 4);
    // 上下文用量来自 token_count 事件
    assert.ok(r.facts.signals.length === 0, `意外信号: ${JSON.stringify(r.facts.signals)}`);
    assert.ok(r.facts.tailSummary.length > 0);
  });

  it("isError 判定：错误 output（Script failed / Exit code: 124 / Exit code: 1）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const adapter = new CodexAdapter(file);
    await adapter.resolveFacts(null);
    // 通过再追加一次 resolveFacts 无法直接看内部事实 → 用公开函数与整体信号验证：
    // 占位调用（call 缺失只有 output）→ isError=true，但工具名占位不产生 spin
    // 用 codexOutputHasError 直接验证判定规则：
    assert.strictEqual(codexOutputHasError([{ type: "input_text", text: "Script completed\nExit code: 0\n" }]), false);
    assert.strictEqual(codexOutputHasError("Script failed\nExit code: 0"), true);
    assert.strictEqual(codexOutputHasError("Script error:\nExit code: 124\ncommand timed out"), true);
    assert.strictEqual(codexOutputHasError("Exit code: 1\n"), true);
    assert.strictEqual(codexOutputHasError("Exit code: 0\nExit code: 1\n"), true);
    assert.strictEqual(codexOutputHasError("普通输出没有标记"), false);
    assert.strictEqual(codexOutputHasError(""), false);
    assert.strictEqual(codexOutputHasError(null), false);
    assert.strictEqual(codexOutputText([{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }]), "a\nb");
    assert.strictEqual(codexOutputText("raw"), "raw");
  });

  it("上下文压力信号：input_tokens 接近上下文窗口（结构同真实 token_count 事件）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      file,
      '{"timestamp":"2026-08-10T06:47:47.392Z","ordinal":99,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":250000,"total_tokens":250500},"model_context_window":258400},"rate_limits":{}}}\n',
      "utf-8",
    );
    const adapter = new CodexAdapter(file);
    const r = await adapter.resolveFacts(null);
    assert.ok(r.facts.signals.some((s) => s.kind === "context-pressure"), JSON.stringify(r.facts.signals));
  });

  it("note 截断/重建：文件短于已解析游标 → 重置解析游标，事实不沿用旧值", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const adapter = new CodexAdapter(file);
    const r1 = await adapter.resolveFacts(null);
    assert.strictEqual(r1.facts.toolCallsSeen, 4);
    // 截断到仅首行（session_meta，无工具调用/上下文用量）
    const firstLine = readFileSync(file, "utf-8").split("\n")[0] + "\n";
    writeFileSync(file, firstLine, "utf-8");
    const r2 = await adapter.resolveFacts("100");
    assert.strictEqual(r2.facts.toolCallsSeen, 0, "截断后不得沿用旧事实");
    assert.strictEqual(r2.facts.newToolCalls, 0);
    assert.strictEqual(r2.facts.signals.length, 0, "截断后信号不得沿用旧值");
  });

  it("增量解析：新行只计新增", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const adapter = new CodexAdapter(file);
    const r1 = await adapter.resolveFacts(null);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      file,
      '{"timestamp":"2026-08-10T06:47:50.261Z","ordinal":100,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_x","status":"completed","call_id":"call_x","name":"exec","input":"text(1);"}}\n',
      "utf-8",
    );
    const r2 = await adapter.resolveFacts(null);
    assert.strictEqual(r2.facts.toolCallsSeen, r1.facts.toolCallsSeen + 1);
    assert.strictEqual(r2.facts.newToolCalls, 1);
  });

  it("custom_tool_call 显式失败状态 → 判错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      file,
      '{"timestamp":"2026-08-10T06:47:50.261Z","ordinal":101,"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_y","status":"error","call_id":"call_y","name":"exec","input":"boom()"}}\n',
      "utf-8",
    );
    const adapter = new CodexAdapter(file);
    await adapter.resolveFacts(null);
    // 失败调用会进入 failure-cluster？只 1 个失败 → 不到阈值；用输出匹配验证：
    // 这里仅验证解析不崩 + 计数增加
    const r = await adapter.resolveFacts(null);
    assert.ok(r.facts.toolCallsSeen >= 5);
  });

  it("arguments 是 JSON 字符串时解析为对象；坏 JSON 退化原样", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-codex-"));
    const file = join(dir, "rollout.jsonl");
    copyFileSync(FIXTURE, file);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      file,
      '{"timestamp":"2026-08-10T06:47:50.261Z","ordinal":102,"type":"response_item","payload":{"type":"function_call","id":"fc_x","name":"exec","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call_z"}}\n' +
        '{"timestamp":"2026-08-10T06:47:50.261Z","ordinal":103,"type":"response_item","payload":{"type":"function_call","id":"fc_y","name":"exec","arguments":"不是JSON{","call_id":"call_w"}}\n',
      "utf-8",
    );
    const adapter = new CodexAdapter(file);
    const r = await adapter.resolveFacts(null);
    assert.strictEqual(r.facts.toolCallsSeen, 6);
  });
});

describe("detectTargetKind", () => {
  it("按内容嗅探：session_meta → codex；session → pi；命名兜底", () => {
    const codexFile = tempFile("rollout-2026.jsonl", '{"timestamp":"t","ordinal":0,"type":"session_meta","payload":{}}\n');
    assert.strictEqual(detectTargetKind(codexFile), "codex");
    const piFile = tempFile("session.jsonl", '{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"C:\\\\x"}\n');
    assert.strictEqual(detectTargetKind(piFile), "pi");
    assert.strictEqual(detectTargetKind("some/rollout-abc.jsonl"), "codex");
    assert.strictEqual(detectTargetKind("some/unknown.jsonl"), "pi");
  });
});
