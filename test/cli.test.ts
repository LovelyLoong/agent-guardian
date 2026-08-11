/**
 * agent-guardian — CLI 参数解析与子进程退出码测试。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWatchArgs,
  parsePanelArgs,
  parseIdArgs,
  makeWatchId,
  makePanelExecutor,
  shellExec,
} from "../scripts/guardian.ts";
import { EventStore } from "../src/events.ts";
import { OrcaCli } from "../src/orca.ts";
import { dirsFor } from "../src/home.ts";
import type { ShellExec } from "../src/watcher/llm.ts";

describe("makeWatchId（m3：全路径短哈希防撞名）", () => {
  it("同 basename 不同目录 → 不同 watch ID", () => {
    const a = makeWatchId("C:/work/session-a/session.jsonl", "");
    const b = makeWatchId("D:/other/session-b/session.jsonl", "");
    assert.notStrictEqual(a, b);
    assert.ok(a.startsWith("watch-session-"));
    assert.ok(b.startsWith("watch-session-"));
    assert.ok(/^watch-[A-Za-z0-9._-]+-[0-9a-f]{8}$/.test(a));
  });

  it("同路径 → 同一 ID（确定性）；terminal 句柄模式同样带哈希", () => {
    const a = makeWatchId("C:/work/s.jsonl", "");
    const b = makeWatchId("C:/work/s.jsonl", "");
    assert.strictEqual(a, b);
    const t1 = makeWatchId(null, "term_1");
    const t2 = makeWatchId(null, "term_1");
    assert.strictEqual(t1, t2);
    assert.ok(t1.startsWith("watch-term_1-"));
  });
});

describe("parseWatchArgs", () => {
  it("完整参数", () => {
    const opts = parseWatchArgs([
      "--terminal", "term_1", "--session", "s.jsonl", "--llm", "node x.mjs",
      "--budget-min", "30", "--remind-max", "3", "--llm-max-calls", "1",
    ]);
    assert.ok(typeof opts !== "string");
    assert.strictEqual(opts.terminal, "term_1");
    assert.strictEqual(opts.session, "s.jsonl");
    assert.strictEqual(opts.llm, "node x.mjs");
    assert.strictEqual(opts.budgetMin, 30);
    assert.strictEqual(opts.remindMax, 3);
    assert.strictEqual(opts.llmMaxCalls, 1);
  });

  it("--file 模式与默认值", () => {
    const opts = parseWatchArgs(["--file", "s.jsonl"]);
    assert.ok(typeof opts !== "string");
    assert.strictEqual(opts.file, "s.jsonl");
    assert.strictEqual(opts.budgetMin, 120);
    assert.strictEqual(opts.remindMax, 5);
    assert.strictEqual(opts.llmMaxCalls, 3);
    assert.strictEqual(opts.llm, null);
  });

  it("缺值 / 冲突 / 未知参数 → 错误字符串", () => {
    assert.ok(typeof parseWatchArgs(["--terminal"]) === "string");
    assert.ok(typeof parseWatchArgs(["--terminal", "t", "--file", "f"]) === "string");
    assert.ok(typeof parseWatchArgs([]) === "string");
    assert.ok(typeof parseWatchArgs(["--bogus", "x"]) === "string");
    assert.ok(typeof parseWatchArgs(["--budget-min", "abc"]) === "string");
    assert.ok(typeof parseWatchArgs(["--budget-min", "0"]) === "string");
    assert.ok(typeof parseWatchArgs(["--file", "f", "多余位置参数"]) === "string");
  });
});

describe("parsePanelArgs", () => {
  it("完整参数", () => {
    const opts = parsePanelArgs([
      "问题A", "--n", "4", "--backend", "headless", "--out", "out-dir",
      "--materials", "a.md,b.md", "--agent", "codex", "--no-synthesize",
    ]);
    assert.ok(typeof opts !== "string");
    assert.strictEqual(opts.question, "问题A");
    assert.strictEqual(opts.n, 4);
    assert.strictEqual(opts.backend, "headless");
    assert.strictEqual(opts.out, "out-dir");
    assert.deepStrictEqual(opts.materials, ["a.md", "b.md"]);
    assert.strictEqual(opts.agent, "codex");
    assert.strictEqual(opts.noSynthesize, true);
  });

  it("默认值：n=3、backend=orca、agent=pi、不综合关闭", () => {
    const opts = parsePanelArgs(["问题"]);
    assert.ok(typeof opts !== "string");
    assert.strictEqual(opts.n, 3);
    assert.strictEqual(opts.backend, "orca");
    assert.strictEqual(opts.agent, "pi");
    assert.strictEqual(opts.noSynthesize, false);
    assert.strictEqual(opts.out, null);
  });

  it("缺少问题 / 非法 backend / 非法 n → 错误", () => {
    assert.ok(typeof parsePanelArgs([]) === "string");
    assert.ok(typeof parsePanelArgs(["--backend", "web"]) === "string");
    assert.ok(typeof parsePanelArgs(["--n", "0"]) === "string");
    assert.ok(typeof parsePanelArgs(["--n", "x"]) === "string");
    assert.ok(typeof parsePanelArgs(["a", "b"]) === "string");
  });
});

describe("parseIdArgs", () => {
  it("--watch 与缺省", () => {
    const withWatch = parseIdArgs(["--watch", "w1"]);
    assert.ok(typeof withWatch !== "string");
    assert.strictEqual(withWatch.watch, "w1");
    const empty = parseIdArgs([]);
    assert.ok(typeof empty !== "string");
    assert.strictEqual(empty.watch, null);
    assert.ok(typeof parseIdArgs(["--watch"]) === "string");
    assert.ok(typeof parseIdArgs(["x"]) === "string");
  });
});

describe("makePanelExecutor（M2：watch 内多次 panel 唯一 panelId/子目录）", () => {
  it("多次调用每次生成唯一 panelId/子目录，事件流按 panelId 区分，不覆盖前次结果", async () => {
    const home = mkdtempSync(join(tmpdir(), "ag-cli-panel-"));
    const dirs = dirsFor(home);
    const events = new EventStore(dirs.events);
    // orca 命令名为空 → available=false → headless 后端（无需真实 orca）
    const orca = new OrcaCli(async () => ({ code: 0, stdout: "{}", stderr: "" }), "");
    let memberCallCount = 0;
    const exec: ShellExec = async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if (line.includes("讨论组成员")) {
        memberCallCount++;
        // 每 panel 3 名成员：第 1-3 次调用属 panel-1，第 4-6 次属 panel-2
        const panelSeq = Math.ceil(memberCallCount / 3);
        const outDir = join(dirs.panels, `w-test-panel-${panelSeq}`);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `member-${((memberCallCount - 1) % 3) + 1}.md`), `# 成员 ${memberCallCount}\n`, "utf-8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (line.includes("综合者")) {
        const panelSeq = Math.ceil(memberCallCount / 3);
        const outDir = join(dirs.panels, `w-test-panel-${panelSeq}`);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "panel-result.md"), "# 综合\n", "utf-8");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const executor = makePanelExecutor({ watchId: "w-test", orca, events, dirs, exec });
    const r1 = await executor("第一次讨论问题");
    const r2 = await executor("第二次讨论问题");
    assert.ok(r1 !== null && r1.includes("3/3"), "第一次讨论应完成综合");
    assert.ok(r2 !== null && r2.includes("3/3"), "第二次讨论应完成综合");
    assert.notStrictEqual(r1, r2, "两次结果指向不同输出");
    // 事件流按 panelId 区分：两个独立事件文件，各自含自己的问题
    const ev1 = events.read("w-test-panel-1");
    const ev2 = events.read("w-test-panel-2");
    assert.ok(ev1.some((e) => e.type === "panel_start" && e.question === "第一次讨论问题"));
    assert.ok(ev2.some((e) => e.type === "panel_start" && e.question === "第二次讨论问题"));
    assert.ok(!events.read("w-test-panel-1").some((e) => e.type === "panel_start" && e.question === "第二次讨论问题"), "事件流不得混入前次/后次");
    // 子目录唯一且各自完整：panel-1 与 panel-2 都有 spec 与成员产出，互不覆盖
    const spec1 = readFileSync(join(dirs.panels, "w-test-panel-1", "panel-spec.md"), "utf-8");
    const spec2 = readFileSync(join(dirs.panels, "w-test-panel-2", "panel-spec.md"), "utf-8");
    assert.ok(spec1.includes("第一次讨论问题") && !spec1.includes("第二次讨论问题"));
    assert.ok(spec2.includes("第二次讨论问题") && !spec2.includes("第一次讨论问题"));
    assert.ok(existsSync(join(dirs.panels, "w-test-panel-1", "member-1.md")));
    assert.ok(existsSync(join(dirs.panels, "w-test-panel-2", "member-3.md")), "第二次调用不得覆盖第一次的子目录");
  });

  it("M2 跨重启序号：重启（新 executor）后再次 panel 不复用 panel-1", async () => {
    const home = mkdtempSync(join(tmpdir(), "ag-cli-panel-restart-"));
    const dirs = dirsFor(home);
    const events = new EventStore(dirs.events);
    const orca = new OrcaCli(async () => ({ code: 0, stdout: "{}", stderr: "" }), "");
    let memberCallCount = 0;
    const exec: ShellExec = async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if (line.includes("讨论组成员")) {
        memberCallCount++;
        const panelSeq = Math.ceil(memberCallCount / 3);
        const outDir = join(dirs.panels, `w-restart-panel-${panelSeq}`);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `member-${((memberCallCount - 1) % 3) + 1}.md`), `# 成员 ${memberCallCount}\n`, "utf-8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (line.includes("综合者")) {
        const panelSeq = Math.ceil(memberCallCount / 3);
        const outDir = join(dirs.panels, `w-restart-panel-${panelSeq}`);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "panel-result.md"), "# 综合\n", "utf-8");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    // 模拟重启：每次 makePanelExecutor 都从输出目录推导下一个序号
    const r1 = await makePanelExecutor({ watchId: "w-restart", orca, events, dirs, exec })("第一次讨论问题");
    const r2 = await makePanelExecutor({ watchId: "w-restart", orca, events, dirs, exec })("第二次讨论问题");
    assert.ok(r1 !== null && r1.includes("3/3"), "第一次讨论应完成综合");
    assert.ok(r2 !== null && r2.includes("3/3"), "重启后第二次讨论应完成综合");
    // 重启后不得复用 panel-1：第二次讨论必须落在 panel-2（从磁盘已有目录推导）
    const ev1 = events.read("w-restart-panel-1");
    const ev2 = events.read("w-restart-panel-2");
    assert.ok(ev1.some((e) => e.type === "panel_start" && e.question === "第一次讨论问题"));
    assert.ok(ev2.some((e) => e.type === "panel_start" && e.question === "第二次讨论问题"));
    assert.ok(!ev1.some((e) => e.type === "panel_start" && e.question === "第二次讨论问题"), "panel-1 不得被复用/覆盖");
    const spec1 = readFileSync(join(dirs.panels, "w-restart-panel-1", "panel-spec.md"), "utf-8");
    const spec2 = readFileSync(join(dirs.panels, "w-restart-panel-2", "panel-spec.md"), "utf-8");
    assert.ok(spec1.includes("第一次讨论问题") && !spec1.includes("第二次讨论问题"));
    assert.ok(spec2.includes("第二次讨论问题") && !spec2.includes("第一次讨论问题"));
  });
});

describe("shellExec（M3：参数数组直启，无 shell）", () => {
  it("注入字符只作字面参数传递，不产生注入执行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-cli-exec-"));
    const script = join(dir, "echo-args.mjs");
    const outFile = join(dir, "args.json");
    const pwned = join(dir, "pwned");
    writeFileSync(
      script,
      'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)), "utf-8");\n',
      "utf-8",
    );
    const question = `实现方案 $(touch ${pwned}) 与 \"双引号\" 都保留`;
    const res = await shellExec(process.execPath, [script, outFile, question], 10_000);
    assert.strictEqual(res.code, 0);
    assert.ok(!existsSync(pwned), "$(touch ...) 不得产生注入执行");
    const got = JSON.parse(readFileSync(outFile, "utf-8")) as string[];
    assert.deepStrictEqual(got, [question], "问题文本作为单个字面参数原样传递");
  });
});

describe("CLI 子进程退出码（临时 AGENT_GUARDIAN_HOME）", () => {
  const cli = join(import.meta.dirname, "..", "scripts", "guardian.ts");

  function run(args: string[]): { status: number | null; stdout: string } {
    const home = mkdtempSync(join(tmpdir(), "ag-cli-"));
    const res = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf-8",
      env: { ...process.env, AGENT_GUARDIAN_HOME: home },
    });
    return { status: res.status, stdout: res.stdout };
  }

  it("events 空状态：退出 0，输出（暂无监督记录）", () => {
    const r = run(["events"]);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes("暂无监督记录"));
  });

  it("events 聚合输出对 degraded 显式提示（M4）", () => {
    const home = mkdtempSync(join(tmpdir(), "ag-cli-"));
    mkdirSync(join(home, "events"), { recursive: true });
    // 构造一个含坏行的事件文件（readState degraded）
    writeFileSync(
      join(home, "events", "w-deg.jsonl"),
      '{"ts":"2026-01-01T00:00:00.000Z","watchId":"w-deg","type":"watch_start"}\n{ 坏行\n',
      "utf-8",
    );
    const res = spawnSync(process.execPath, [cli, "events"], {
      encoding: "utf-8",
      env: { ...process.env, AGENT_GUARDIAN_HOME: home },
    });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes("w-deg"));
    assert.ok(res.stdout.includes("记录降级"), "聚合输出应对 degraded 显式提示");
  });

  it("未知命令 → 退出 2", () => {
    assert.strictEqual(run(["frobnicate"]).status, 2);
  });

  it("watch 缺参数 → 退出 2", () => {
    assert.strictEqual(run(["watch"]).status, 2);
  });

  it("report 无记录 → 退出 2", () => {
    assert.strictEqual(run(["report"]).status, 2);
  });

  it("report：reports 目录不存在时也能生成汇报并退出 0（m1：写前 mkdir recursive）", () => {
    const home = mkdtempSync(join(tmpdir(), "ag-cli-report-"));
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      join(home, "state", "w-r.json"),
      JSON.stringify({
        watchId: "w-r",
        settledBeats: 3,
        cursor: "42",
        cooldownUntil: {},
        remindCount: 0,
        remindHistory: [],
        escalationCount: 0,
        llmCalls: 0,
        startedAt: Date.now() - 60_000,
        budgetMs: 120_000,
        safetyWarningSent: false,
        eventsDegraded: false,
        targetKind: "pi",
        channelKind: "file",
        handle: "s.jsonl",
        sessionFile: "s.jsonl",
        lastAction: null,
      }),
      "utf-8",
    );
    // home 下只有 state/，reports/ 尚未创建
    assert.ok(!existsSync(join(home, "reports")));
    const res = spawnSync(process.execPath, [cli, "report", "--watch", "w-r"], {
      encoding: "utf-8",
      env: { ...process.env, AGENT_GUARDIAN_HOME: home },
    });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes("已写入"));
    assert.ok(existsSync(join(home, "reports", "w-r.md")));
  });
});
