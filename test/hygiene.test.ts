/**
 * agent-guardian — V1.1 证据卫生测试：秘密脱敏（事件/证据包）与保留期清理。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/events.ts";
import { dirsFor } from "../src/home.ts";
import { cleanupOldWatches, DEFAULT_RETENTION_DAYS } from "../src/retention.ts";
import { redactText, redactValue, REDACTED, SECRET_PATTERNS } from "../src/watcher/redact.ts";
import { makeLlmConsult } from "../src/watcher/llm.ts";
import type { ShellExec } from "../src/watcher/llm.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ag-hygiene-"));
}

// ---------------------------------------------------------------------------
// 脱敏（redact.ts）
// ---------------------------------------------------------------------------

describe("redactText 秘密模式", () => {
  it("AWS AKIA 密钥：AKIA[0-9A-Z]{16}", () => {
    const r = redactText("key=AKIAIOSFODNN7EXAMPLE 其余文本");
    assert.strictEqual(r.changed, true);
    assert.ok(r.text.includes(REDACTED));
    assert.ok(!/AKIA[A-Z0-9]{16}/.test(r.text));
    assert.ok(r.text.includes("其余文本"), "非秘密文本保留");
  });

  it("sk- 风格密钥：sk-[A-Za-z0-9]{20,}", () => {
    const r = redactText("sk-abcdefghijklmnopqrstuvwxyz123456");
    assert.strictEqual(r.changed, true);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(r.text));
  });

  it("Bearer token：Bearer\\s+\\S+", () => {
    const r = redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx");
    assert.strictEqual(r.changed, true);
    assert.ok(!/Bearer\s+\S+/.test(r.text));
  });

  it("PEM 私钥整块（多行）", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const r = redactText(`证书前文 ${pem} 证书后文`);
    assert.strictEqual(r.changed, true);
    assert.ok(!r.text.includes("BEGIN"), "私钥整块替换，不留残片");
    assert.ok(r.text.includes("证书前文") && r.text.includes("证书后文"));
  });

  it("无秘密 → changed=false 且文本原样", () => {
    const r = redactText("普通文本，无秘密");
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.text, "普通文本，无秘密");
  });

  it("redactValue 递归：数组与嵌套对象内字符串同样脱敏", () => {
    const r = redactValue({
      note: "AKIAIOSFODNN7EXAMPLE",
      list: ["sk-abcdefghijklmnopqrstuvwxyz123456"],
      nested: { deep: { auth: "Bearer tok123" } },
      keep: 42,
    });
    assert.strictEqual(r.changed, true);
    const v = r.value as Record<string, unknown>;
    assert.ok(String(v["note"]).includes(REDACTED));
    assert.ok(String((v["list"] as string[])[0]).includes(REDACTED));
    assert.ok(String((v["nested"] as { deep: { auth: string } }).deep.auth).includes(REDACTED));
    assert.strictEqual(v["keep"], 42);
  });

  it("SECRET_PATTERNS 全部可执行且带全局标志（多命中替换）", () => {
    for (const { re } of SECRET_PATTERNS) {
      assert.ok(re.global, `模式必须带 g 标志: ${re}`);
      re.lastIndex = 0; // 复用前重置
    }
    const r = redactText("a AKIAIOSFODNN7EXAMPLE b AKIAABCDEFGHIJKLMNOP c");
    assert.strictEqual(r.text.match(/\[REDACTED\]/g)?.length, 2, "多处命中全部替换");
  });
});

describe("EventStore 事件脱敏", () => {
  it("命中秘密 → 落盘文本替换并在事件上标 redacted:true", () => {
    const home = tempHome();
    const store = new EventStore(join(home, "events"));
    const ok = store.append("w1", {
      type: "steer",
      text: "请检查 AKIAIOSFODNN7EXAMPLE 与 Bearer tok123 配置",
    });
    assert.strictEqual(ok, true);
    const raw = readFileSync(join(home, "events", "w1.jsonl"), "utf-8");
    assert.ok(!raw.includes("AKIAIOSFODNN7EXAMPLE"), "秘密不得落盘");
    assert.ok(!raw.includes("tok123"));
    const read = store.readState("w1");
    assert.strictEqual(read.degraded, false);
    const ev = read.events[0]!;
    assert.strictEqual(ev["redacted"], true, "命中时事件标 redacted:true");
    assert.ok(String(ev["text"]).includes(REDACTED));
  });

  it("无秘密 → 不标 redacted，文本原样", () => {
    const dir = join(tempHome(), "events");
    const store = new EventStore(dir);
    store.append("w1", { type: "decide", action: "silence", reason: "no-signals" });
    const ev = store.readState("w1").events[0]!;
    assert.strictEqual(ev["redacted"], undefined);
    assert.strictEqual(ev["reason"], "no-signals");
  });
});

describe("LLM 证据包脱敏", () => {
  it("写入证据文件的文本执行秘密过滤（尾部摘要含密钥 → [REDACTED]）", async () => {
    const dir = join(tempHome(), "tmp");
    let evidencePath = "";
    const exec: ShellExec = async (_cmd, args) => {
      // V2a：证据路径不裸传——从渲染 prompt 指令行提取
      const m = args[args.length - 1]!.match(/证据文件（JSON，先读取再判断）：(.+)/);
      evidencePath = m?.[1] ?? "";
      return { code: 0, stdout: JSON.stringify({ action: "silence" }), stderr: "" };
    };
    const consult = makeLlmConsult({ cmd: "node fake.mjs", exec, evidenceDir: dir, watchId: "w1" });
    const result = await consult({
      facts: {
        toolCallsSeen: 1,
        newToolCalls: 1,
        signals: [],
        recentCommands: [],
        tailSummary: "Bearer supersecrettoken 与 AKIAIOSFODNN7EXAMPLE",
      },
      state: { settledBeats: 1, remindCount: 0, escalationCount: 0, llmCalls: 0, startedAt: 0, budgetMs: 1000, targetKind: "pi" },
      taskSummary: "正常任务摘要",
      recentEvents: [],
      contract: null,
    });
    assert.strictEqual(result.note, "ok");
    const raw = readFileSync(evidencePath, "utf-8");
    assert.ok(!raw.includes("supersecrettoken"), "证据包不得含 Bearer 秘密");
    assert.ok(!raw.includes("AKIAIOSFODNN7EXAMPLE"), "证据包不得含 AKIA 密钥");
    assert.ok(raw.includes(REDACTED));
    assert.ok(raw.includes("正常任务摘要"), "非秘密文本保留");
  });
});

// ---------------------------------------------------------------------------
// 保留期清理（retention.ts）
// ---------------------------------------------------------------------------

describe("cleanupOldWatches", () => {
  const DAY = 86_400_000;
  const now = Date.now();

  function makeHome(): string {
    const home = tempHome();
    for (const sub of ["state", "events", "reports", "tmp", "panels"]) {
      mkdirSync(join(home, sub), { recursive: true });
    }
    return home;
  }

  function backdate(path: string, ageMs: number): void {
    const t = new Date(now - ageMs);
    utimesSync(path, t, t);
  }

  it("超过保留期（默认 14 天）的 watch 整组删除：state/events/reports/tmp/panels", () => {
    const home = makeHome();
    const dirs = dirsFor(home);
    // 旧 watch：15 天前
    writeFileSync(join(dirs.state, "w-old.json"), "{}");
    writeFileSync(join(dirs.events, "w-old.jsonl"), "{}\n");
    writeFileSync(join(dirs.reports, "w-old.md"), "# r\n");
    writeFileSync(join(dirs.tmp, "w-old-123.json"), "{}");
    mkdirSync(join(dirs.panels, "w-old-panel-1"), { recursive: true });
    writeFileSync(join(dirs.panels, "w-old-panel-1", "member-1.md"), "# m\n");
    for (const f of [
      join(dirs.state, "w-old.json"),
      join(dirs.events, "w-old.jsonl"),
      join(dirs.reports, "w-old.md"),
      join(dirs.tmp, "w-old-123.json"),
      join(dirs.panels, "w-old-panel-1"),
    ]) {
      backdate(f, 15 * DAY);
    }
    // 新 watch：1 小时前
    writeFileSync(join(dirs.state, "w-new.json"), "{}");
    writeFileSync(join(dirs.events, "w-new.jsonl"), "{}\n");
    backdate(join(dirs.state, "w-new.json"), 3_600_000);
    backdate(join(dirs.events, "w-new.jsonl"), 3_600_000);

    const removed = cleanupOldWatches(dirs, DEFAULT_RETENTION_DAYS, now);
    assert.deepStrictEqual(removed.sort(), ["w-old"]);
    assert.ok(!exists(join(dirs.state, "w-old.json")), "旧 state 已删");
    assert.ok(!exists(join(dirs.events, "w-old.jsonl")), "旧 events 已删");
    assert.ok(!exists(join(dirs.reports, "w-old.md")), "旧 reports 已删");
    assert.ok(!exists(join(dirs.tmp, "w-old-123.json")), "旧 tmp 证据包已删");
    assert.ok(!exists(join(dirs.panels, "w-old-panel-1")), "旧 panels 目录已删");
    assert.ok(exists(join(dirs.state, "w-new.json")), "新 watch 保留");
    assert.ok(exists(join(dirs.events, "w-new.jsonl")), "新 watch 保留");
  });

  it("组内任一产物新近 → 整组保留（按最新 mtime 判定，不误删活跃 watch）", () => {
    const home = makeHome();
    const dirs = dirsFor(home);
    writeFileSync(join(dirs.state, "w-mix.json"), "{}");
    writeFileSync(join(dirs.events, "w-mix.jsonl"), "{}\n");
    backdate(join(dirs.state, "w-mix.json"), 20 * DAY);
    backdate(join(dirs.events, "w-mix.jsonl"), 1_000); // 事件文件新近 → 组仍活跃
    const removed = cleanupOldWatches(dirs, DEFAULT_RETENTION_DAYS, now);
    assert.deepStrictEqual(removed, []);
    assert.ok(exists(join(dirs.state, "w-mix.json")));
    assert.ok(exists(join(dirs.events, "w-mix.jsonl")));
  });

  it("可配保留期：--retention-days 口径（3 天内的旧产物保留，4 天前删除）", () => {
    const home = makeHome();
    const dirs = dirsFor(home);
    writeFileSync(join(dirs.state, "w-a.json"), "{}");
    writeFileSync(join(dirs.state, "w-b.json"), "{}");
    backdate(join(dirs.state, "w-a.json"), 2 * DAY);
    backdate(join(dirs.state, "w-b.json"), 4 * DAY);
    const removed = cleanupOldWatches(dirs, 3, now);
    assert.deepStrictEqual(removed, ["w-b"]);
    assert.ok(exists(join(dirs.state, "w-a.json")));
  });

  it("空目录/不存在目录 → 返回空列表，不抛错", () => {
    const home = tempHome(); // 无任何子目录
    const dirs = dirsFor(home);
    assert.deepStrictEqual(cleanupOldWatches(dirs, DEFAULT_RETENTION_DAYS, now), []);
  });
});

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
