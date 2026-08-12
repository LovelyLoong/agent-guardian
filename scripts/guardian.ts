#!/usr/bin/env node
/**
 * agent-guardian — CLI 入口。
 *
 *   guardian watch --terminal <handle> [--session <file>] [--llm "<cmd>"] [--budget-min 120] [--remind-max 5] [--llm-max-calls 3] [--retention-days 14]
 *   guardian watch --file <session.jsonl>
 *   guardian panel "<问题>" [--n 3] [--backend orca|headless] [--out <dir>] [--materials <p>...]
 *                        [--agent <name>] [--member-cmd "<cmd>"] [--synthesize-cmd "<cmd>"] [--no-synthesize]
 *   guardian events [--watch <id>] [--retention-days 14]
 *   guardian report --watch <id>
 *
 * 退出码：0 正常；2 参数/环境错误；3 已有监督者在跑（单例）；130 SIGINT。
 *
 * @module
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { OrcaCli } from "../src/orca.ts";
import { FileChannel } from "../src/channels/file.ts";
import { OrcaChannel } from "../src/channels/orca.ts";
import { EventStore } from "../src/events.ts";
import { dirsFor, resolveHome } from "../src/home.ts";
import type { GuardianDirs } from "../src/home.ts";
import { CodexAdapter } from "../src/targets/codex.ts";
import { PiAdapter } from "../src/targets/pi.ts";
import { TerminalAdapter } from "../src/targets/terminal.ts";
import { detectTargetKind } from "../src/targets/types.ts";
import type { TargetAdapter } from "../src/targets/types.ts";
import { StateStore } from "../src/watcher/state.ts";
import { makeLlmConsult } from "../src/watcher/llm.ts";
import type { ShellExec } from "../src/watcher/llm.ts";
import { runWatch, PANEL_MEMBER_TIMEOUT_MS } from "../src/watcher/loop.ts";
import type { WatchOptions, WatchServices } from "../src/watcher/loop.ts";
import { generateReport } from "../src/watcher/report.ts";
import { cleanupOldWatches, DEFAULT_RETENTION_DAYS } from "../src/retention.ts";
import { runPanel } from "../src/panel/runner.ts";
import type { PanelOptions, PanelServices } from "../src/panel/runner.ts";

// ---------------------------------------------------------------------------
// 参数解析（可单测，不触发 main）
// ---------------------------------------------------------------------------

export interface WatchCliOptions {
  terminal: string | null;
  file: string | null;
  session: string | null;
  llm: string | null;
  budgetMin: number;
  remindMax: number;
  llmMaxCalls: number;
  retentionDays: number;
}

export function parseWatchArgs(argv: string[]): WatchCliOptions | string {
  const opts: WatchCliOptions = {
    terminal: null,
    file: null,
    session: null,
    llm: null,
    budgetMin: 120,
    remindMax: 5,
    llmMaxCalls: 3,
    retentionDays: DEFAULT_RETENTION_DAYS,
  };
  let positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--terminal":
      case "--file":
      case "--session":
      case "--llm":
      case "--budget-min":
      case "--remind-max":
      case "--llm-max-calls":
      case "--retention-days": {
        const value = argv[i + 1];
        if (value === undefined) return `${arg} 缺少参数值`;
        if (arg === "--terminal") opts.terminal = value;
        else if (arg === "--file") opts.file = value;
        else if (arg === "--session") opts.session = value;
        else if (arg === "--llm") opts.llm = value;
        else if (arg === "--budget-min") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) return "--budget-min 必须是正整数（分钟）";
          opts.budgetMin = n;
        } else if (arg === "--remind-max") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) return "--remind-max 必须是正整数";
          opts.remindMax = n;
        } else if (arg === "--retention-days") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) return "--retention-days 必须是正整数（天）";
          opts.retentionDays = n;
        } else {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) return "--llm-max-calls 必须是正整数";
          opts.llmMaxCalls = n;
        }
        i++;
        break;
      }
      default:
        if (arg.startsWith("-")) return `未知参数: ${arg}`;
        positionals.push(arg);
    }
  }
  if (positionals.length > 0) return `不支持的参数: ${positionals.join(" ")}`;
  if (opts.terminal !== null && opts.file !== null) return "--terminal 与 --file 只能二选一";
  if (opts.terminal === null && opts.file === null) return "watch 需要 --terminal <handle> 或 --file <会话文件>";
  if (opts.terminal !== null && opts.session !== null) {
    // session 文件必须存在，稍后由适配器检测
    if (opts.session === "") return "--session 不能为空";
  }
  return opts;
}

export interface PanelCliOptions {
  question: string;
  n: number;
  backend: "orca" | "headless";
  out: string | null;
  materials: string[];
  agent: string;
  memberCmd: string | null;
  synthesizeCmd: string | null;
  noSynthesize: boolean;
}

export function parsePanelArgs(argv: string[]): PanelCliOptions | string {
  const opts: PanelCliOptions = {
    question: "",
    n: 3,
    backend: "orca",
    out: null,
    materials: [],
    agent: "pi",
    memberCmd: null,
    synthesizeCmd: null,
    noSynthesize: false,
  };
  let positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--n":
      case "--backend":
      case "--out":
      case "--materials":
      case "--agent":
      case "--member-cmd":
      case "--synthesize-cmd": {
        const value = argv[i + 1];
        if (value === undefined) return `${arg} 缺少参数值`;
        if (arg === "--n") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) return "--n 必须是正整数";
          opts.n = n;
        } else if (arg === "--backend") {
          if (value !== "orca" && value !== "headless") return "--backend 只能是 orca 或 headless";
          opts.backend = value;
        } else if (arg === "--out") {
          opts.out = value;
        } else if (arg === "--materials") {
          for (const p of value.split(",")) {
            if (p.trim() !== "") opts.materials.push(p.trim());
          }
        } else if (arg === "--agent") {
          opts.agent = value;
        } else if (arg === "--member-cmd") {
          opts.memberCmd = value;
        } else if (arg === "--synthesize-cmd") {
          opts.synthesizeCmd = value;
        }
        i++;
        break;
      }
      case "--no-synthesize":
        opts.noSynthesize = true;
        break;
      default:
        if (arg.startsWith("-")) return `未知参数: ${arg}`;
        positionals.push(arg);
    }
  }
  if (positionals.length === 0) return "panel 需要问题文本（guardian panel \"<问题>\"）";
  if (positionals.length > 1) return "panel 只接受一个问题（多余参数: " + positionals.slice(1).join(" ") + "）";
  opts.question = positionals[0]!;
  return opts;
}

export interface IdCliOptions {
  watch: string | null;
  retentionDays: number;
}

export function parseIdArgs(argv: string[]): IdCliOptions | string {
  const opts: IdCliOptions = { watch: null, retentionDays: DEFAULT_RETENTION_DAYS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--watch") {
      const value = argv[i + 1];
      if (value === undefined) return "--watch 缺少参数值";
      opts.watch = value;
      i++;
    } else if (arg === "--retention-days") {
      const value = argv[i + 1];
      if (value === undefined) return "--retention-days 缺少参数值";
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return "--retention-days 必须是正整数（天）";
      opts.retentionDays = n;
      i++;
    } else if (arg.startsWith("-")) {
      return `未知参数: ${arg}`;
    } else {
      return `不支持的参数: ${arg}`;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export const shellExec: ShellExec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    // M3：headless 成员/综合与 LLM 回调一律 execFile(cmd, argsArray, {shell:false})——
    // 不经过 shell，问题文本/证据路径中的 $(...)、引号等只作字面参数，不产生注入执行。
    execFile(cmd, args, { shell: false, windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
}

/**
 * watch ID：basename（或句柄）+ 全路径短哈希。
 * 仅 basename 会撞名（不同目录同名会话文件/同名句柄），短哈希保证隔离且确定。
 */
export function makeWatchId(file: string | null, handle: string): string {
  const base = file !== null ? basename(file, ".jsonl") : handle;
  const source = file !== null ? file : handle;
  const digest = createHash("sha256").update(source, "utf-8").digest("hex").slice(0, 8);
  return `watch-${sanitizeId(base)}-${digest}`;
}

function makeAdapter(kind: "pi" | "codex" | "terminal", sessionFile: string | null): TargetAdapter {
  if (sessionFile === null) return new TerminalAdapter();
  return kind === "codex" ? new CodexAdapter(sessionFile) : new PiAdapter(sessionFile);
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/**
 * watch 内的 panel 执行器（M2）：每次调用生成唯一 panelId/子目录
 * （watchId + 序号），禁止覆盖前次结果；事件流按 panelId 区分（EventStore 按 id 分文件）。
 * 序号从输出目录已有 watchId-panel-* 推导（M2）：崩溃/重启后续跑不复用旧序号，
 * 避免覆盖前次讨论组产出；进程内继续递增。
 */
export function makePanelExecutor(opts: {
  watchId: string;
  orca: OrcaCli;
  events: EventStore;
  dirs: GuardianDirs;
  exec: ShellExec;
}): (question: string) => Promise<string | null> {
  let seq = nextPanelSeq(opts.dirs.panels, opts.watchId);
  return (question: string): Promise<string | null> => {
    seq++;
    const panelId = `${opts.watchId}-panel-${seq}`;
    return runPanel({
      panelId,
      question,
      n: 3,
      backend: opts.orca.available ? "orca" : "headless",
      out: join(opts.dirs.panels, panelId),
      materials: [],
      agent: "pi",
      memberCmd: null,
      synthesizeCmd: null,
      noSynthesize: false,
    } satisfies PanelOptions, {
      orca: opts.orca,
      events: opts.events,
      exec: opts.exec,
      sleep,
    } satisfies PanelServices).then((summary) => {
      if (summary.result === "synthesized" && summary.resultFile !== null) {
        // 返回简短结论供复工引导
        const done = summary.members.filter((m) => m.status === "done").length;
        return `${done}/${summary.members.length} 名成员完成，综合结果见 ${summary.resultFile}`;
      }
      return null;
    });
  };
}

/** 输出目录里已有 watchId-panel-<n> 的最大序号（目录缺失/无匹配 → 0）。 */
function nextPanelSeq(panelsDir: string, watchId: string): number {
  let names: string[];
  try {
    names = readdirSync(panelsDir);
  } catch {
    return 0;
  }
  const prefix = `${watchId}-panel-`;
  let max = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = Number(tail);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

async function cmdWatch(argv: string[]): Promise<number> {
  const parsed = parseWatchArgs(argv);
  if (typeof parsed === "string") {
    console.error(`guardian watch: 参数错误: ${parsed}`);
    return 2;
  }
  const home = resolveHome();
  const dirs = dirsFor(home);
  const orca = new OrcaCli();
  // V1.1 证据卫生：启动前清理超保留期（默认 14 天）的旧 watch 产物。
  const removed = cleanupOldWatches(dirs, parsed.retentionDays);
  if (removed.length > 0) {
    console.log(`guardian: 已清理超保留期（${parsed.retentionDays} 天）的旧记录: ${removed.join(", ")}`);
  }

  let handle: string;
  let channel: WatchServices["channel"];
  let sessionFile: string | null = null;

  if (parsed.file !== null) {
    handle = parsed.file;
    channel = new FileChannel();
    sessionFile = parsed.file;
  } else {
    if (!orca.available) {
      // B1：解析失败（找不到 .exe / ORCA_CLI_COMMAND 指向无 .exe 的 .cmd）→ fail-fast 报清晰错误，不留 shell 退路
      console.error(`guardian watch: ${orca.resolveError ?? "找不到 orca 命令（可用环境变量 ORCA_CLI_COMMAND 指定 .exe 路径）"}`);
      return 2;
    }
    handle = parsed.terminal!;
    channel = new OrcaChannel(orca);
    sessionFile = parsed.session;
  }

  const watchId = makeWatchId(parsed.file, handle);
  const target = makeAdapter(
    sessionFile !== null ? detectTargetKind(sessionFile) : "terminal",
    sessionFile,
  );

  const events = new EventStore(dirs.events);
  const stateStore = new StateStore(dirs.state);
  const llmConsult = parsed.llm !== null
    ? makeLlmConsult({ cmd: parsed.llm, exec: shellExec, evidenceDir: dirs.tmp, watchId })
    : null;

  const runPanelExecutor = makePanelExecutor({ watchId, orca, events, dirs, exec: shellExec });

  // SIGINT：落盘退出 130（状态每拍已落盘，至多丢最后一拍）
  process.on("SIGINT", () => {
    events.append(watchId, { type: "sigint" });
    process.exit(130);
  });

  const watchOpts: WatchOptions = {
    watchId,
    handle,
    budgetMs: parsed.budgetMin * 60_000,
    remindMax: parsed.remindMax,
    llmMaxCalls: parsed.llmMaxCalls, // M1：LLM 回调全局上限（默认 3）
    sessionFile,
    runPanel: runPanelExecutor,
  };
  const services: WatchServices = {
    channel,
    target,
    state: stateStore,
    events,
    reportsDir: dirs.reports,
    llmConsult,
    sleep,
    now: Date.now,
  };

  console.log(`guardian: 开始监督 ${watchId}（${target.kind}，预算 ${parsed.budgetMin} 分钟）`);
  const result = await runWatch(watchOpts, services);
  if (result.denied !== null) {
    // 启动被拒：单例锁（退出码 3）或状态读取失败中止启动（退出码 4，可重试）——
    // 打印原因并按各自的错误退出码退出（不得一律压成 3，否则用户无法区分"已有
    // 监督者在跑"与"状态暂不可读，重试即可"）。
    console.error(`guardian: ${result.denied}`);
    return result.exitCode;
  }
  console.log(`guardian: 监督结束，汇报: ${result.reportPath ?? "(写入失败)"}`);
  return result.exitCode;
}

async function cmdPanel(argv: string[]): Promise<number> {
  const parsed = parsePanelArgs(argv);
  if (typeof parsed === "string") {
    console.error(`guardian panel: 参数错误: ${parsed}`);
    return 2;
  }
  const home = resolveHome();
  const dirs = dirsFor(home);
  const orca = new OrcaCli();
  const events = new EventStore(dirs.events);
  const panelId = "panel-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
  const out = parsed.out ?? join(dirs.panels, panelId);

  const summary = await runPanel({
    panelId,
    question: parsed.question,
    n: parsed.n,
    backend: parsed.backend,
    out,
    materials: parsed.materials,
    agent: parsed.agent,
    memberCmd: parsed.memberCmd,
    synthesizeCmd: parsed.synthesizeCmd,
    noSynthesize: parsed.noSynthesize,
    memberTimeoutMs: PANEL_MEMBER_TIMEOUT_MS,
  } satisfies PanelOptions, { orca, events, exec: shellExec, sleep });

  console.log(JSON.stringify(summary, null, 2));
  if (parsed.backend === "orca" && !orca.available) {
    // B1：同 watch——找不到 .exe 时 fail-fast 报清晰错误，不得静默降级
    console.error(`guardian panel: ${orca.resolveError ?? "找不到 orca 命令（可用环境变量 ORCA_CLI_COMMAND 指定 .exe 路径）"}`);
    return 1;
  }
  if (summary.result === "synthesize-failed" && summary.members.length === 0) return 1;
  return 0;
}

async function cmdEvents(argv: string[]): Promise<number> {
  const parsed = parseIdArgs(argv);
  if (typeof parsed === "string") {
    console.error(`guardian events: 参数错误: ${parsed}`);
    return 2;
  }
  const dirs = dirsFor(resolveHome());
  // V1.1 证据卫生：启动时清理超保留期（默认 14 天）的旧 watch 产物。
  const removed = cleanupOldWatches(dirs, parsed.retentionDays);
  if (removed.length > 0) {
    console.log(`已清理超保留期（${parsed.retentionDays} 天）的旧记录: ${removed.join(", ")}`);
  }
  const events = new EventStore(dirs.events);
  if (parsed.watch !== null) {
    const read = events.readState(parsed.watch);
    if (read.degraded) {
      console.log(`（${parsed.watch} 的事件记录读取降级，以下可能不完整）`);
    }
    if (read.events.length === 0 && !read.degraded) {
      console.log(`（无 ${parsed.watch} 的事件记录）`);
      return 0;
    }
    for (const ev of read.events) {
      console.log(JSON.stringify(ev));
    }
    return 0;
  }
  const all = events.list();
  if (all.length === 0) {
    console.log("（暂无监督记录）");
    return 0;
  }
  for (const entry of all) {
    // M4：聚合输出对降级（degraded）显式提示，不得静默当正常记录
    console.log(`${entry.watchId}\t${entry.count} 条事件${entry.degraded ? "（记录降级，可能不完整）" : ""}`);
  }
  return 0;
}

async function cmdReport(argv: string[]): Promise<number> {
  const parsed = parseIdArgs(argv);
  if (typeof parsed === "string") {
    console.error(`guardian report: 参数错误: ${parsed}`);
    return 2;
  }
  const dirs = dirsFor(resolveHome());
  const stateStore = new StateStore(dirs.state);
  const events = new EventStore(dirs.events);

  const watchId = parsed.watch ?? stateStore.list()[0];
  if (watchId === undefined) {
    console.error("guardian report: 没有可用的监督记录（先运行 guardian watch）");
    return 2;
  }
  const loaded = await stateStore.load(watchId);
  if (loaded.kind === "missing") {
    console.error(`guardian report: 找不到 ${watchId} 的状态记录`);
    return 2;
  }
  if (loaded.kind === "error") {
    // W5：状态读取真失败 ≠ 无记录——显式报错退出，不得当作"无状态"静默处理
    console.error(`guardian report: ${watchId} 状态读取失败（${loaded.reason}），无法生成报告`);
    return 2;
  }
  const state = loaded.state;
  const report = generateReport(state, events.readState(watchId));
  const path = join(dirs.reports, `${watchId}.md`);
  // m1：reports 目录可能尚未创建（如仅跑过 watch 未成功收尾），写前 mkdir recursive。
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report, "utf-8");
  console.log(`已写入 ${path}`);
  console.log(report);
  return 0;
}

function usage(): void {
  console.log(`guardian — 跨 CLI 运行期监督与讨论组编排

用法：
  guardian watch --terminal <handle> [--session <file>] [--llm "<cmd>"] [--budget-min 120] [--remind-max 5] [--llm-max-calls 3] [--retention-days 14]
  guardian watch --file <会话文件>
  guardian panel "<问题>" [--n 3] [--backend orca|headless] [--out <dir>] [--materials <p>...]
                  [--agent <name>] [--member-cmd "<cmd>"] [--synthesize-cmd "<cmd>"] [--no-synthesize]
  guardian events [--watch <id>] [--retention-days 14]
  guardian report --watch <id>

数据目录：~/.agent-guardian/（可用 AGENT_GUARDIAN_HOME 覆盖）。
详细说明见 README.md 与 docs/design.md。`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case "watch":
      process.exitCode = await cmdWatch(argv.slice(1));
      return;
    case "panel":
      process.exitCode = await cmdPanel(argv.slice(1));
      return;
    case "events":
      process.exitCode = await cmdEvents(argv.slice(1));
      return;
    case "report":
      process.exitCode = await cmdReport(argv.slice(1));
      return;
    case undefined:
      usage();
      process.exitCode = 2;
      return;
    default:
      console.error(`guardian: 未知命令 ${cmd}`);
      usage();
      process.exitCode = 2;
  }
}

// 被 node 直接执行时（子进程入口）才跑 main；被测试 import 时仅暴露解析函数。
// 用 pathToFileURL 把 argv[1]（普通路径）转成 file:// URL 再比较，避免 fileURLToPath 对非 URL 抛错。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
