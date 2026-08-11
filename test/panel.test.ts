/**
 * agent-guardian — 讨论组测试：聚合 / 超时失败成员 / 解散调用序列（stub orca）。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaCli } from "../src/orca.ts";
import type { OrcaExecutor, ExecResult } from "../src/orca.ts";
import { EventStore } from "../src/events.ts";
import { runPanel } from "../src/panel/runner.ts";
import type { PanelOptions, PanelServices } from "../src/panel/runner.ts";
import type { ShellExec } from "../src/watcher/llm.ts";

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

class FakeOrca {
  calls: string[][] = [];
  private workerCount = 0;
  releaseCalls: string[] = [];

  private respond(args: string[]): ExecResult {
    this.calls.push(args);
    if (args.includes("run-create")) {
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { run_id: "run-1" } }), stderr: "" };
    }
    if (args.includes("task-create")) {
      const n = this.calls.filter((c) => c.includes("task-create")).length;
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { task_id: `task-${n}` } }), stderr: "" };
    }
    if (args.includes("worker-start")) {
      this.workerCount++;
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { ready: true, dispatch_id: `d-${this.workerCount}` } }), stderr: "" };
    }
    if (args.includes("worker-release")) {
      const idx = args.indexOf("--dispatch");
      this.releaseCalls.push(args[idx + 1]!);
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { released: true } }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" };
  }

  cli(): OrcaCli {
    const exec: OrcaExecutor = async (_cmd, args) => this.respond(args);
    return new OrcaCli(exec, "orca-stub");
  }
}

interface HarnessOptions {
  n?: number;
  backend?: "orca" | "headless";
  noSynthesize?: boolean;
  memberTimeoutMs?: number;
  /** sleep 回调：第 1 次调用时写入部分成员文件（模拟成员完成） */
  writeMembersOnFirstSleep?: (out: string, n: number) => void;
  synthesizeCode?: number;
  /** 自定义 exec 实现（替代默认：写 panel-result.md / 返回 synthesizeCode） */
  execImpl?: (cmd: string, args: string[], out: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function harness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ag-panel-"));
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  const events = new EventStore(join(dir, "events"));
  const orca = new FakeOrca();
  const execCalls: string[] = [];
  let slept = 0;
  const exec: ShellExec = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    execCalls.push(line);
    if (opts.execImpl !== undefined) {
      return opts.execImpl(cmd, args, out);
    }
    if (opts.synthesizeCode === undefined) {
      writeFileSync(join(out, "panel-result.md"), "# 综合结果\n", "utf-8");
      return { code: 0, stdout: "", stderr: "" };
    }
    // 成员命令必须成功（成员产出由 writeMembersOnFirstSleep 提供），
    // synthesizeCode 只作用于综合命令（M6 判定收口后不再依赖旧时序掩盖）。
    if (args.some((a) => a.includes("讨论组成员"))) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: opts.synthesizeCode, stdout: "", stderr: "synth boom" };
  };
  const services: PanelServices = {
    orca: orca.cli(),
    events,
    exec,
    sleep: async () => {
      slept++;
      if (slept === 1 && opts.writeMembersOnFirstSleep !== undefined) {
        opts.writeMembersOnFirstSleep(out, opts.n ?? 3);
      }
    },
  };
  const panelOpts: PanelOptions = {
    panelId: "panel-test",
    question: "实现方案应该选哪个？",
    n: opts.n ?? 3,
    backend: opts.backend ?? "orca",
    out,
    materials: [],
    agent: "pi",
    memberCmd: null,
    synthesizeCmd: null,
    noSynthesize: opts.noSynthesize ?? false,
    memberTimeoutMs: opts.memberTimeoutMs ?? 30 * 60_000,
  };
  return { services, panelOpts, orca, execCalls, out, events, slept: () => slept };
}

function writeMembers(out: string, n: number): void {
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(out, `member-${i}.md`), `# 成员 ${i} 的回答\n`, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("panel（orca 后端，stub）", () => {
  it("run-create → task-create ×n → worker-start ×n → 收齐 → 综合 → worker-release ×n", async () => {
    const h = harness({ writeMembersOnFirstSleep: writeMembers });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.result, "synthesized");
    assert.strictEqual(summary.members.length, 3);
    assert.ok(summary.members.every((m) => m.status === "done"));
    assert.ok(summary.resultFile!.endsWith("panel-result.md"));
    // 解散序列：3 个 worker 全部 release
    assert.deepStrictEqual(h.orca.releaseCalls.sort(), ["d-1", "d-2", "d-3"]);
    // fan-out 调用形状
    const starts = h.orca.calls.filter((c) => c.includes("worker-start"));
    assert.strictEqual(starts.length, 3);
    assert.ok(starts[0]!.includes("--worktree") && starts[0]!.includes("current"));
    assert.ok(starts[0]!.includes("--agent") && starts[0]!.includes("pi"));
    assert.ok(starts[0]!.includes("--json"));
    // 事件
    const evs = h.events.read("panel-test");
    assert.ok(evs.some((e) => e.type === "panel_start"));
    assert.ok(evs.some((e) => e.type === "panel_run" && e.runId === "run-1"));
    assert.strictEqual(evs.filter((e) => e.type === "panel_member_started").length, 3);
    assert.strictEqual(evs.filter((e) => e.type === "panel_member_done").length, 3);
    assert.ok(evs.some((e) => e.type === "panel_synthesized"));
    assert.strictEqual(evs.filter((e) => e.type === "panel_released").length, 3);
    assert.ok(evs.some((e) => e.type === "panel_done"));
    // 产物
    assert.ok(existsSync(join(h.out, "panel-spec.md")));
    assert.ok(existsSync(join(h.out, "member-1.md")));
  });

  it("成员任务说明自包含：问题、输出路径、候选集格式", async () => {
    const { specForMember, buildSpec } = await import("../src/panel/runner.ts");
    const base = {
      panelId: "p",
      question: "q",
      n: 3,
      backend: "orca" as const,
      out: "/tmp/out",
      materials: [],
      agent: "pi",
      memberCmd: null,
      synthesizeCmd: null,
      noSynthesize: false,
    };
    const spec = specForMember(base, 2);
    assert.ok(spec.includes("问题"));
    assert.ok(spec.includes("member-2.md"));
    assert.ok(spec.includes("候选方案"));
    assert.ok(spec.includes("独立分析"));
    const shared = buildSpec(base);
    assert.ok(shared.includes("独立分析"));
  });

  it("失败成员不阻塞其余：超时记 failed，其余照常综合", async () => {
    const h = harness({
      memberTimeoutMs: 60,
      writeMembersOnFirstSleep: (out) => writeFileSync(join(out, "member-1.md"), "x", "utf-8"),
    });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.members.filter((m) => m.status === "done").length, 1);
    assert.strictEqual(summary.members.filter((m) => m.status === "failed").length, 2);
    assert.strictEqual(summary.result, "synthesized"); // 有成员完成 → 综合
    assert.ok(summary.resultFile!.endsWith("panel-result.md"));
    // 失败的成员也要 release
    assert.strictEqual(h.orca.releaseCalls.length, 3);
    const evs = h.events.read("panel-test");
    assert.strictEqual(evs.filter((e) => e.type === "panel_member_failed").length, 2);
  });

  it("全部失败 → 综合降级为归并索引（不失败崩溃）", async () => {
    const h = harness({ memberTimeoutMs: 50 });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.result, "synthesize-failed");
    assert.ok(summary.resultFile!.endsWith("merge-index.md"));
    assert.ok(existsSync(join(h.out, "merge-index.md")));
  });
});

describe("panel（headless 后端）", () => {
  it("并行 memberCmd（默认 pi -p）×n；不调用 worker-release", async () => {
    const h = harness({ backend: "headless", writeMembersOnFirstSleep: writeMembers });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.result, "synthesized");
    // 成员命令 = 以 pi -p 开头且含成员提示词；综合命令也是 pi -p（设计 §4.4），需区分
    const memberCalls = h.execCalls.filter((c) => c.startsWith("pi -p") && c.includes("讨论组成员"));
    assert.strictEqual(memberCalls.length, 3);
    assert.ok(h.execCalls.some((c) => c.includes("讨论组成员")));
    assert.strictEqual(h.orca.releaseCalls.length, 0);
  });

  it("--no-synthesize → 只写归并索引，不执行综合命令", async () => {
    const h = harness({ backend: "headless", noSynthesize: true, writeMembersOnFirstSleep: writeMembers });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.result, "index-only");
    assert.ok(summary.resultFile!.endsWith("merge-index.md"));
    assert.strictEqual(h.execCalls.filter((c) => c.includes("综合者")).length, 0);
  });

  it("成员进程非零退出码 → 立即标记失败，不等满收齐超时（M6）", async () => {
    const h = harness({
      backend: "headless",
      memberTimeoutMs: 30 * 60_000, // 若未立即标记，将等满 30 分钟
      execImpl: async () => ({ code: 1, stdout: "", stderr: "成员进程崩溃" }),
    });
    const summary = await runPanel(h.panelOpts, h.services);
    // 立即失败：只经过极少轮询就收尾，绝不等待 30 分钟
    assert.ok(h.slept() <= 2, `不应等待超时（实际轮询 ${h.slept()} 次）`);
    assert.strictEqual(summary.members.filter((m) => m.status === "failed").length, 3);
    assert.ok(summary.members.every((m) => m.note !== null && m.note.includes("进程退出码 1")));
    assert.strictEqual(summary.result, "synthesize-failed");
    const evs = h.events.read("panel-test");
    assert.strictEqual(evs.filter((e) => e.type === "panel_member_failed").length, 3);
    assert.ok(evs.every((e) => e.type !== "panel_member_done"));
  });

  it("失败成员留下的文件不得进入综合：综合只看成功成员（M6）", async () => {
    const h = harness({
      backend: "headless",
      writeMembersOnFirstSleep: (out) => {
        writeFileSync(join(out, "member-2.md"), "# 成员 2\n", "utf-8");
        writeFileSync(join(out, "member-3.md"), "# 成员 3\n", "utf-8");
      },
      execImpl: async (cmd, args, out) => {
        const line = [cmd, ...args].join(" ");
        if (line.includes("讨论组成员 1")) {
          // 成员 1：写出了文件但进程非零退出
          writeFileSync(join(out, "member-1.md"), "# 成员 1（进程失败）\n", "utf-8");
          return { code: 1, stdout: "", stderr: "boom" };
        }
        if (line.includes("讨论组成员")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        writeFileSync(join(out, "panel-result.md"), "# 综合结果\n", "utf-8");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.members[0]!.status, "failed");
    assert.strictEqual(summary.members[0]!.note, "进程退出码 1");
    assert.strictEqual(summary.members.filter((m) => m.status === "done").length, 2);
    assert.strictEqual(summary.result, "synthesized");
    // 失败成员的文件已被清除，综合输入只剩成功成员
    assert.ok(!existsSync(join(h.out, "member-1.md")), "失败成员的文件不得残留");
    assert.ok(existsSync(join(h.out, "member-2.md")));
    assert.ok(existsSync(join(h.out, "panel-result.md")));
  });

  it("--out 复用：旧 member-i.md 不得被当成本次结果（m2）", async () => {
    const h = harness({
      backend: "headless",
      n: 2,
      memberTimeoutMs: 50,
      execImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    // 预置上次运行遗留的成员产出与综合结果
    writeFileSync(join(h.out, "member-1.md"), "# 旧结果\n", "utf-8");
    writeFileSync(join(h.out, "member-2.md"), "# 旧结果\n", "utf-8");
    writeFileSync(join(h.out, "panel-result.md"), "# 旧综合\n", "utf-8");
    // 本次没有任何成员产出 → 若旧文件未被清理，member-1/2 会被误判为 done
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.members.filter((m) => m.status === "done").length, 0);
    assert.strictEqual(summary.members.filter((m) => m.status === "failed").length, 2);
    assert.ok(!existsSync(join(h.out, "member-1.md")), "旧成员产出应被清理");
    assert.ok(!existsSync(join(h.out, "panel-result.md")), "旧综合结果应被清理");
    assert.ok(existsSync(join(h.out, "merge-index.md")));
  });

  it("成员正常退出且产物已落盘 → 完成处理器立即标 done，无需收齐轮询（M6）", async () => {
    const h = harness({
      backend: "headless",
      n: 2,
      execImpl: async (cmd, args, out) => {
        const line = [cmd, ...args].join(" ");
        if (line.includes("讨论组成员")) {
          const i = line.includes("讨论组成员 1") ? 1 : 2;
          writeFileSync(join(out, `member-${i}.md`), `# 成员 ${i}\n`, "utf-8");
          return { code: 0, stdout: "", stderr: "" };
        }
        writeFileSync(join(out, "panel-result.md"), "# 综合\n", "utf-8");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(h.slept(), 0, "完成处理器已标 done，收齐轮询无需等待");
    assert.strictEqual(summary.members.filter((m) => m.status === "done").length, 2);
    assert.strictEqual(summary.result, "synthesized");
    const evs = h.events.read("panel-test");
    assert.strictEqual(evs.filter((e) => e.type === "panel_member_done").length, 2);
  });

  it("一成员立即失败 + 一成员挂起 → 失败立即被记录，总耗时不被拖长（M6 回归）", async () => {
    const h = harness({
      backend: "headless",
      n: 2,
      memberTimeoutMs: 60, // stub 短超时：挂起成员由其自身超时兑底
      execImpl: async (cmd, args) => {
        const line = [cmd, ...args].join(" ");
        if (line.includes("讨论组成员 1")) {
          return { code: 1, stdout: "", stderr: "立即失败" };
        }
        if (line.includes("讨论组成员")) {
          // 成员 2：挂起（unref，不拖住测试进程）。收齐循环不得等它的 exec
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5_000);
            t.unref?.();
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const t0 = Date.now();
    const summary = await runPanel(h.panelOpts, h.services);
    const elapsed = Date.now() - t0;
    // 收齐循环消费状态表直到全部终态：不等待挂起成员的 exec（若先 allSettled
    // 全员再收齐，将等满 5s 挂起），立即失败者也不拖长总耗时
    assert.ok(elapsed < 1_000, `总耗时 ${elapsed}ms 不应被拖长`);
    assert.strictEqual(summary.members[0]!.status, "failed");
    assert.ok(summary.members[0]!.note!.includes("进程退出码 1"));
    assert.strictEqual(summary.members[1]!.status, "failed");
    assert.ok(summary.members[1]!.note!.includes("超时未产出"));
    const evs = h.events.read("panel-test");
    assert.ok(evs.some((e) => e.type === "panel_member_failed" && e["i"] === 1), "成员 1 失败应被记录");
  });

  it("综合命令失败 → synthesize-failed + 归并索引", async () => {
    const h = harness({ backend: "headless", synthesizeCode: 1, writeMembersOnFirstSleep: writeMembers });
    const summary = await runPanel(h.panelOpts, h.services);
    assert.strictEqual(summary.result, "synthesize-failed");
    assert.ok(existsSync(join(h.out, "merge-index.md")));
    const evs = h.events.read("panel-test");
    assert.ok(evs.some((e) => e.type === "panel_synthesize_failed"));
  });

  it("headless 问题文本含 $(touch) 与双引号 → 只作字面参数传递，不产生注入执行（M3）", async () => {
    const question = '实现方案 $(touch injected-file) 与 "双引号" 都保留';
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const h = harness({
      backend: "headless",
      n: 1,
      memberTimeoutMs: 50,
      writeMembersOnFirstSleep: (out) => writeFileSync(join(out, "member-1.md"), "# m\n", "utf-8"),
      execImpl: async (cmd, args, out) => {
        calls.push({ cmd, args });
        if (args.some((a) => a.includes("讨论组成员"))) return { code: 0, stdout: "", stderr: "" };
        writeFileSync(join(out, "panel-result.md"), "# 综合\n", "utf-8");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const summary = await runPanel({ ...h.panelOpts, question }, h.services);
    assert.strictEqual(summary.result, "synthesized");
    const memberCall = calls.find((c) => c.args.some((a) => a.includes("讨论组成员")));
    assert.ok(memberCall !== undefined, "应有成员调用");
    // 成员命令：cmd 与参数分离，问题文本是单个字面参数（无 shell 拼接）
    assert.strictEqual(memberCall.cmd, "pi");
    assert.strictEqual(memberCall.args.length, 2, "仅 [flags, prompt] 两个参数");
    assert.strictEqual(memberCall.args[0], "-p");
    assert.ok(memberCall.args[1]!.includes("$(touch injected-file)"), "$(...) 必须原样保留为字面文本");
    assert.ok(memberCall.args[1]!.includes('"双引号"'), "双引号必须原样保留为字面文本");
    assert.ok(!memberCall.args[1]!.startsWith("$") && memberCall.args[1]!.includes(question));
    // 综合调用同样参数数组直启
    const synthCall = calls.find((c) => c.args.some((a) => a.includes("综合者")));
    assert.ok(synthCall !== undefined && synthCall.cmd === "pi", "综合命令同样无 shell 拼接");
  });
});

describe("panel（orca 不可用）", () => {
  it("orca 后端但无 orca 命令 → panel_failed 事件 + 空成员", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-panel-"));
    const out = join(dir, "out");
    mkdirSync(out, { recursive: true });
    const events = new EventStore(join(dir, "events"));
    const unavailable = new OrcaCli(() => Promise.resolve({ code: 0, stdout: "{}", stderr: "" }), "");
    const services: PanelServices = {
      orca: unavailable,
      events,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      sleep: async () => {},
    };
    const summary = await runPanel({
      panelId: "panel-test", question: "q", n: 2, backend: "orca", out,
      materials: [], agent: "pi", memberCmd: null, synthesizeCmd: null, noSynthesize: false,
    }, services);
    assert.strictEqual(summary.members.length, 0);
    assert.strictEqual(summary.result, "synthesize-failed");
    assert.ok(events.read("panel-test").some((e) => e.type === "panel_failed"));
  });
});
