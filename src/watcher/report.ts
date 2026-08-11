/**
 * agent-guardian — 完工汇报生成（用户语言）。
 *
 * 措辞纪律：用户可见文本只有目标、做法、时间、代价；
 * 禁用词（L0/L1/相位/hash/stale/basis/snapshot/dedupe）不出现在报告中。
 *
 * 统计口径（与 watcher 实际 produce 的事件对齐）：
 * - 信号统计来自 decide 事件自带的 signals 字段（有信号的拍必然落 decide 事件）；
 * - 收尾方式来自 finish 事件（watcher 先追加 finish 再生成报告）；
 * - 事件记录读取降级（degraded）时显式标注，不得误显"无信号/未记录收尾事件"。
 *
 * @module
 */

import type { EventReadResult } from "../events.ts";
import { sanitizeText } from "./sanitize.ts";
import type { WatchState } from "./state.ts";

const KIND_LABELS: Record<string, string> = {
  spin: "原地重复",
  stall: "进展停滞",
  "failure-cluster": "连续失败",
  "context-pressure": "上下文压力",
};

export function generateReport(
  state: WatchState,
  read: EventReadResult,
  opts: { finishRecorded?: boolean } = {},
): string {
  const events = read.events;
  const lines: string[] = [];
  lines.push(`# 监督汇报 ${state.watchId}`);
  lines.push("");
  lines.push(`- 观察对象：${state.channelKind === "orca" ? "终端 " + state.handle : "会话文件"}`);
  if (state.sessionFile !== null) {
    lines.push(`- 会话文件：${state.sessionFile}`);
  }
  lines.push(`- 目标类型：${targetLabel(state.targetKind)}`);
  const durationMin = Math.round((Date.now() - state.startedAt) / 60_000);
  lines.push(`- 起止：${new Date(state.startedAt).toISOString()} 起，持续约 ${durationMin} 分钟`);
  lines.push(`- 节拍数：${state.settledBeats}`);
  lines.push("");

  // 信号统计（口径：decide 事件的 signals 字段 = 该拍实际检测到的信号种类）
  const signalCounts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "decide" && Array.isArray(ev["signals"])) {
      for (const kind of ev["signals"]) {
        if (typeof kind === "string" && KIND_LABELS[kind] !== undefined) {
          signalCounts.set(kind, (signalCounts.get(kind) ?? 0) + 1);
        }
      }
    }
  }
  lines.push("## 观察期间触发的信号");
  if (read.degraded) {
    lines.push("");
    lines.push("（事件记录读取降级，以下统计可能不完整）");
  } else if (signalCounts.size === 0) {
    lines.push("");
    lines.push("（无）");
  } else {
    for (const [kind, count] of signalCounts) {
      lines.push(`- ${KIND_LABELS[kind] ?? kind}：${count} 次`);
    }
  }
  lines.push("");

  // 动作统计
  const actionCounts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "decide" && typeof ev["action"] === "string") {
      const a = ev["action"] as string;
      actionCounts.set(a, (actionCounts.get(a) ?? 0) + 1);
    }
    if (ev.type === "llm_call") {
      actionCounts.set("llm_call", (actionCounts.get("llm_call") ?? 0) + 1);
    }
  }
  lines.push("## 采取的动作");
  if (read.degraded) {
    lines.push("");
    lines.push("（事件记录读取降级，动作统计不完整）");
  } else if (actionCounts.size === 0) {
    lines.push("");
    lines.push("（无，全程沉默观察）");
  } else {
    for (const [action, count] of actionCounts) {
      lines.push(`- ${actionLabel(action)}：${count} 次`);
    }
  }
  lines.push("");

  // 事件时间线（尾部 15 条）
  const tail = events.slice(-15);
  lines.push("## 事件时间线（尾部）");
  for (const ev of tail) {
    lines.push(`- ${String(ev["ts"]).slice(11, 19)} ${String(ev["type"])}${ev["reason"] !== undefined ? " — " + inlineReason(ev["reason"]) : ""}`);
  }
  lines.push("");
  if (state.eventsDegraded === true) {
    lines.push("## 记录降级");
    lines.push("");
    lines.push("- 事件落盘曾失败：部分事件未能写入记录（详见监督进程 stderr）");
    lines.push("");
  }
  lines.push("## 收尾方式");
  const finish = events.findLast((ev) => ev.type === "finish");
  if (finish !== undefined) {
    lines.push(`- ${inlineReason(finish["reason"] ?? "正常收尾")}`);
  } else if (read.degraded) {
    lines.push("- 收尾详情无法确认：事件记录读取降级");
  } else if (opts.finishRecorded === false) {
    lines.push("- 收尾事件写入失败（记录降级），收尾详情未能记录");
  } else {
    lines.push("- 未记录收尾事件");
  }
  return lines.join("\n") + "\n";
}

function targetLabel(kind: string): string {
  switch (kind) {
    case "pi":
      return "pi 会话";
    case "codex":
      return "codex 会话";
    default:
      return "终端活性";
  }
}

function actionLabel(action: string): string {
  switch (action) {
    case "remind":
      return "提醒";
    case "pause":
      return "暂停";
    case "panel":
      return "发起讨论组";
    case "safety-warning":
      return "最后警告";
    case "stop":
      return "停止";
    case "silence":
      return "沉默";
    case "llm_call":
      return "外部判断调用";
    default:
      return action;
  }
}

/**
 * reason 单行输出（m3/B3）：净化控制字符（LLM 自由文本可能进入 reason）、
 * 压平换行、截断，避免畸形文本破坏汇报。
 */
function inlineReason(v: unknown, max = 120): string {
  const oneLine = sanitizeText(String(v), 2_000).replace(/\s*\r?\n\s*/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}
