/**
 * agent-guardian — 讨论组编排（fan-out / 收齐 / 综合 / 解散）。
 *
 * 流程（设计 §4）：
 * 1. 生成成员任务说明（问题 + 材料节选 + 独立产出要求 + 候选集格式）；
 * 2. fan-out：orca 后端 = run-create → task-create ×N → worker-start ×N（用户可见）；
 *    headless 后端 = 并行 memberCmd（默认 pi -p）×N；
 * 3. 收齐全部 member-i.md（超时 30min/成员，失败成员记 failed 不阻塞其余）；
 * 4. 综合：synthesizeCmd（默认 pi -p 综合提示词）产出 panel-result.md；
 *    --no-synthesize 时只写归并索引；
 * 5. 解散：worker-release ×N（orca 后端）。全程事件落盘。
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaCli } from "../orca.ts";
import { findDeepString } from "../orca.ts";
import type { EventStore } from "../events.ts";
import type { ShellExec } from "../watcher/llm.ts";
import { splitCommand } from "../watcher/llm.ts";

export const PANEL_MEMBER_TIMEOUT_MS = 30 * 60_000;
export const PANEL_COLLECT_POLL_MS = 5_000;
const MATERIAL_EXCERPT_CHARS = 1_500;

export interface PanelOptions {
  panelId: string;
  question: string;
  n: number;
  backend: "orca" | "headless";
  out: string;
  materials: string[];
  agent: string;
  memberCmd: string | null;
  synthesizeCmd: string | null;
  noSynthesize: boolean;
  memberTimeoutMs?: number;
}

export interface PanelMemberResult {
  i: number;
  status: "done" | "failed";
  file: string | null;
  note: string | null;
}

export interface PanelSummary {
  panelId: string;
  out: string;
  members: PanelMemberResult[];
  result: "synthesized" | "index-only" | "synthesize-failed";
  resultFile: string | null;
}

export interface PanelServices {
  orca: OrcaCli | null;
  events: EventStore;
  exec: ShellExec;
  sleep: (ms: number) => Promise<void>;
}

export async function runPanel(opts: PanelOptions, services: PanelServices): Promise<PanelSummary> {
  const events = services.events;
  // M4：append 失败不静默——落 stderr，调用方可见降级
  const record = (event: { type: string; [key: string]: unknown }): boolean => {
    const ok = events.append(opts.panelId, event);
    if (!ok) console.error(`[guardian] 面板事件落盘失败（记录降级），未记录事件: ${event.type}`);
    return ok;
  };
  record({
    type: "panel_start",
    question: opts.question,
    n: opts.n,
    backend: opts.backend,
    out: opts.out,
  });

  mkdirSync(opts.out, { recursive: true });
  // m2：--out 复用时不把旧 member-i.md / 结果文件当成本次产出
  clearStaleArtifacts(opts.out);
  const spec = buildSpec(opts);
  writeFileSync(join(opts.out, "panel-spec.md"), spec, "utf-8");

  const memberTimeoutMs = opts.memberTimeoutMs ?? PANEL_MEMBER_TIMEOUT_MS;
  const members: PanelMemberResult[] = [];
  const dispatchIds: string[] = [];

  // ---- fan-out ----
  if (opts.backend === "orca") {
    if (services.orca === null || !services.orca.available) {
      record({ type: "panel_failed", note: "orca 后端需要可用的 orca 命令（可用 ORCA_CLI_COMMAND 指定）" });
      return {
        panelId: opts.panelId,
        out: opts.out,
        members: [],
        result: "synthesize-failed",
        resultFile: null,
      };
    }
    const runRes = await services.orca.run(["orchestration", "run-create", "--objective", opts.question]);
    if (!runRes.ok) {
      record({ type: "panel_failed", note: `run-create 失败: ${runRes.error}` });
      return { panelId: opts.panelId, out: opts.out, members: [], result: "synthesize-failed", resultFile: null };
    }
    const runId = findDeepString(runRes.data, /run.?id|run_id|runId/i);
    record({ type: "panel_run", runId: runId ?? "(未知)" });

    for (let i = 1; i <= opts.n; i++) {
      const memberSpec = specForMember(opts, i);
      const taskRes = await services.orca.run([
        "orchestration", "task-create", "--spec", memberSpec,
        ...(runId !== null ? ["--run", runId] : []),
      ]);
      if (!taskRes.ok) {
        record({ type: "panel_member_failed", i, note: `task-create 失败: ${taskRes.error}` });
        members.push({ i, status: "failed", file: null, note: `task-create: ${taskRes.error}` });
        continue;
      }
      const taskId = findDeepString(taskRes.data, /task.?id|task_id|taskId/i);
      const startRes = await services.orca.run([
        "orchestration", "worker-start",
        "--task", taskId ?? "(unknown)",
        "--worktree", "current",
        "--agent", opts.agent,
      ]);
      if (!startRes.ok) {
        record({ type: "panel_member_failed", i, note: `worker-start 失败: ${startRes.error}` });
        members.push({ i, status: "failed", file: null, note: `worker-start: ${startRes.error}` });
        continue;
      }
      const dispatchId = findDeepString(startRes.data, /dispatch.?id|dispatch_id|dispatchId/i);
      if (dispatchId !== null) dispatchIds.push(dispatchId);
      record({
        type: "panel_member_started",
        i,
        taskId: taskId ?? "(未知)",
        dispatchId: dispatchId ?? "(未知)",
      });
      members.push({ i, status: "failed", file: null, note: null }); // 待收齐时置 done
    }
  } else {
    for (let i = 1; i <= opts.n; i++) {
      const prompt = specForMember(opts, i);
      // M3：禁止 shell 拼字符串——成员命令拆 argv 后以参数数组直启，
      // 问题文本中的 $(...)/引号只作为字面参数传递，不产生注入执行。
      const { cmd, args } = splitCommand(opts.memberCmd ?? "pi -p");
      const memberArgs = [...args, prompt];
      record({ type: "panel_member_started", i, backend: "headless", cmd, args: memberArgs });
      members.push({ i, status: "failed", file: null, note: null });
      // M6：每个成员 exec promise 各自挂完成处理器，即时更新状态表——
      // 非零退出立即标 failed；正常退出且产物已落盘立即标 done。
      // 不再先 allSettled 全员再收齐：挂起成员由收齐循环的自身超时兜底。
      services.exec(cmd, memberArgs, memberTimeoutMs + 60_000).then(
        (res) => {
          if (res.code !== 0) {
            markMemberFailed(members, i, `进程退出码 ${String(res.code)}`);
            record({ type: "panel_member_failed", i, note: `进程退出码 ${String(res.code)}` });
            return;
          }
          const file = join(opts.out, `member-${i}.md`);
          if (existsSync(file) && statSync(file).size > 0) {
            markMemberDone(members, i, file);
            record({ type: "panel_member_done", i, file });
          }
          // 正常退出但尚无产物：保持待收齐状态，由收齐循环等到产物或超时
        },
        (err) => {
          markMemberFailed(members, i, `进程异常: ${String(err)}`);
          record({ type: "panel_member_failed", i, note: String(err) });
        },
      );
    }
    // M6：等已 settle 成员的完成处理器落表，再进入收齐轮询——
    // 防止收齐循环在完成处理器运行前，把失败进程遗留的产物文件误读为 done。
    // 注：异步函数返回 Promise 时，thenable 采纳（PromiseResolveThenableJob）在部分
    // Node 版本上不会被 await Promise.resolve() 排空，必须跨一次 macrotask。
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // ---- 收齐（轮询 member-i.md；超时记 failed，不阻塞其余） ----
  const deadlineByMember = new Map<number, number>();
  const startedAt = Date.now();
  for (const m of members) {
    deadlineByMember.set(m.i, startedAt + memberTimeoutMs);
  }
  // 仍在等待的成员：未完成（done）且无结论（note 为空）——fan-out 失败成员带 note，不参与等待。
  let remaining = members.filter((m) => m.status !== "done" && m.note === null);
  while (remaining.length > 0) {
    const now = Date.now();
    for (const m of remaining) {
      const file = join(opts.out, `member-${m.i}.md`);
      if (existsSync(file) && statSync(file).size > 0) {
        m.status = "done";
        m.file = file;
        record({ type: "panel_member_done", i: m.i, file });
        continue;
      }
      if (now >= (deadlineByMember.get(m.i) ?? 0)) {
        record({ type: "panel_member_failed", i: m.i, note: "超时未产出" });
        m.note = "超时未产出";
        continue;
      }
    }
    remaining = members.filter((m) => m.status !== "done" && m.note === null);
    if (remaining.length === 0) break;
    await services.sleep(PANEL_COLLECT_POLL_MS);
  }

  // ---- 综合 ----
  let result: PanelSummary["result"] = "index-only";
  let resultFile: string | null = null;
  // M6：综合只看成功成员——失败成员即使留下文件也不得进入综合输入
  for (const m of members) {
    if (m.status !== "done") {
      rmSync(join(opts.out, `member-${m.i}.md`), { force: true });
    }
  }
  const doneFiles = members.filter((m) => m.status === "done").map((m) => m.file ?? "");
  if (opts.noSynthesize || doneFiles.length === 0) {
    resultFile = writeMergeIndex(opts, members, "归并索引（未综合）");
    if (doneFiles.length === 0) result = "synthesize-failed";
  } else {
    // M3：综合命令同样以参数数组直启（无 shell），--synthesize-cmd 拆 argv，
    // 默认 pi -p 以 prompt 为参数；问题/路径中的注入字符只作字面参数。
    const synthArgs = opts.synthesizeCmd !== null
      ? [opts.out]
      : ["-p", buildSynthesizerPrompt(opts.out)];
    const { cmd, args } = splitCommand(opts.synthesizeCmd ?? "pi -p");
    const fullArgs = [...args, ...synthArgs];
    record({ type: "panel_synthesize_start", cmd: [cmd, ...fullArgs].join(" ").slice(0, 200) });
    try {
      const res = await services.exec(cmd, fullArgs, memberTimeoutMs + 60_000);
      const outFile = join(opts.out, "panel-result.md");
      if (res.code === 0 && existsSync(outFile)) {
        result = "synthesized";
        resultFile = outFile;
        record({ type: "panel_synthesized", file: outFile });
      } else {
        result = "synthesize-failed";
        resultFile = writeMergeIndex(opts, members, `综合失败（退出码 ${String(res.code)}），仅归并索引`);
        record({ type: "panel_synthesize_failed", code: res.code, note: res.stderr.slice(0, 200) });
      }
    } catch (err) {
      result = "synthesize-failed";
      resultFile = writeMergeIndex(opts, members, "综合命令执行失败，仅归并索引");
      record({ type: "panel_synthesize_failed", note: String(err) });
    }
  }

  // ---- 解散（orca 后端） ----
  if (opts.backend === "orca" && services.orca !== null) {
    for (const dispatchId of dispatchIds) {
      const res = await services.orca.run(["orchestration", "worker-release", "--dispatch", dispatchId]);
      record({
        type: "panel_released",
        dispatchId,
        ok: res.ok,
        note: res.ok ? null : res.error,
      });
    }
  }

  record({ type: "panel_done", done: doneFiles.length, failed: opts.n - doneFiles.length, result });
  return { panelId: opts.panelId, out: opts.out, members, result, resultFile };
}

/** 共享任务说明（panel-spec.md 与每个成员的任务文本）。 */
export function buildSpec(opts: PanelOptions): string {
  const materials = opts.materials.map((p) => `- ${p}\n${excerpt(p)}`).join("\n");
  return [
    "# 讨论组任务",
    "",
    `## 问题`,
    opts.question,
    "",
    `## 材料`,
    materials !== "" ? materials : "（无附加材料）",
    "",
    `## 成员要求`,
    `本讨论组共 ${opts.n} 名成员，各自独立分析，产出到 ${opts.out}/member-<i>.md。`,
    "",
  ].join("\n");
}

/** 第 i 名成员的任务文本（自包含：问题、材料、输出要求、候选集格式）。 */
export function specForMember(opts: PanelOptions, i: number): string {
  const materials = opts.materials.map((p) => `- ${p}\n${excerpt(p)}`).join("\n");
  return [
    `# 讨论组成员 ${i}/${opts.n}（独立作答）`,
    "",
    `## 问题`,
    opts.question,
    "",
    `## 材料`,
    materials !== "" ? materials : "（无附加材料）",
    "",
    `## 要求`,
    `1. 独立分析，不要与其他成员交流。`,
    `2. 在 ${join(opts.out, `member-${i}.md`)} 写入你的完整回答（UTF-8 纯文本/ Markdown），必须包含：`,
    `   - 候选方案清单：每个方案给出做法、理由、风险；`,
    `   - 你的推荐方案及理由；`,
    `   - 你认为存在的分歧点。`,
    `3. 完成后结束进程。`,
    "",
  ].join("\n");
}

function excerpt(path: string): string {
  try {
    const text = readFileSync(path, "utf-8");
    const first = text.slice(0, MATERIAL_EXCERPT_CHARS).replace(/\r\n/g, "\n");
    return first.length < text.length ? first + "\n…（节选）" : first;
  } catch {
    return "（材料不可读）";
  }
}

function buildSynthesizerPrompt(out: string): string {
  return [
    `你是一位讨论组综合者。请阅读 ${out}/member-*.md 中的全部成员回答，`,
    `在 ${join(out, "panel-result.md")} 写入综合结果（UTF-8），包含：`,
    `- 候选方案集合（合并相同方案）；`,
    `- 共识点；`,
    `- 分歧点；`,
    `- 推荐方案及理由；`,
    `- 少数派意见。`,
    `若没有任何成员回答文件，请如实说明。`,
  ].join("");
}

function writeMergeIndex(opts: PanelOptions, members: PanelMemberResult[], title: string): string {
  const lines = [
    `# ${title}`,
    "",
    `- 问题：${opts.question}`,
    `- 成员数：${opts.n}`,
    "",
  ];
  for (const m of members) {
    lines.push(`- 成员 ${m.i}：${m.status === "done" ? "已完成" : "失败"}${m.note !== null ? `（${m.note}）` : ""}`);
  }
  const file = join(opts.out, "merge-index.md");
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

/** 成员立即失败标记（退出码非零/进程异常）：已失败或已完成的成员不覆盖。 */
function markMemberFailed(members: PanelMemberResult[], i: number, note: string): void {
  const m = members.find((x) => x.i === i);
  if (m !== undefined && m.note === null) {
    m.status = "failed";
    m.note = note;
  }
}

/** 成员完成标记（正常退出且产物已落盘）：已失败的成员不覆盖。 */
function markMemberDone(members: PanelMemberResult[], i: number, file: string): void {
  const m = members.find((x) => x.i === i);
  if (m !== undefined && m.note === null) {
    m.status = "done";
    m.file = file;
  }
}

/** 清理 --out 目录里上次运行遗留的产出（旧 member-i.md / 结果文件），避免被当成本次结果。 */
function clearStaleArtifacts(out: string): void {
  let names: string[];
  try {
    names = readdirSync(out);
  } catch {
    return;
  }
  const stale = names.filter(
    (n) => /^member-\d+\.md$/.test(n) || n === "panel-result.md" || n === "merge-index.md",
  );
  for (const n of stale) {
    try {
      rmSync(join(out, n), { force: true });
    } catch {
      // 清不掉也继续：收齐阶段的文件存在性检查仍以磁盘现状为准
    }
  }
}
