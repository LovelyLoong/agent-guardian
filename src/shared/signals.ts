/**
 * pi-task-governor — Deterministic signal engine (pure functions).
 *
 * Converts a sequence of tool-call facts into mechanical signals.
 * All functions are deterministic and testable in isolation.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { SignalInput, ToolCallFact, Signal, SignalKind } from "./contract.ts";

// ---------------------------------------------------------------------------
// Default thresholds (overridable)
// ---------------------------------------------------------------------------

export interface SignalThresholds {
  /** Window of recent tool calls to examine for spin detection */
  spinWindow: number; // default 8
  /** Number of identical (toolName+argsHash) repeats within window to trigger spin */
  spinThreshold: number; // default 3
  /** Tool calls since last successful write/edit before stall triggers */
  stallThreshold: number; // default 12
  /** Minimum total tool calls before stall is evaluated (short sessions don't stall) */
  stallMinTotal: number; // default 12
  /** Window for failure cluster detection */
  failureWindow: number; // default 5
  /** Minimum errors within window to trigger failure cluster */
  failureMinErrors: number; // default 3
  /** Ratio of contextTokens/contextWindow to trigger pressure */
  contextPressureRatio: number; // default 0.85
}

export const DEFAULT_THRESHOLDS: SignalThresholds = {
  spinWindow: 8,
  spinThreshold: 3,
  stallThreshold: 12,
  stallMinTotal: 12,
  failureWindow: 5,
  failureMinErrors: 3,
  contextPressureRatio: 0.85,
};

// ---------------------------------------------------------------------------
// argsHash: normalized SHA-256 digest prefix
// ---------------------------------------------------------------------------

/**
 * Compute a normalized SHA-256 hash prefix (first 16 hex chars) of tool arguments.
 *
 * Normalisation:
 * - Keys are sorted alphabetically.
 * - String values longer than 200 chars are truncated.
 * - For bash commands, consecutive whitespace is collapsed.
 */
export function computeArgsHash(args: Record<string, unknown>, toolName: string): string {
  const normalized = normalizeArgs(args, toolName);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return hash.slice(0, 16);
}

/**
 * Recursively normalize a value for args hash computation.
 * - Strings: collapse whitespace for bash/command, truncate to 200 chars
 * - Objects: recursively sort keys (nested too)
 * - Primitives: toString
 */
function normalizeValue(val: unknown, toolName: string): string {
  if (typeof val === "string") {
    const normalized = toolName === "bash" || toolName === "command"
      ? val.replace(/\s+/g, " ").trim()
      : val;
    return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
  }
  if (val !== null && typeof val === "object") {
    if (Array.isArray(val)) {
      const items = val.map((v) => normalizeValue(v, toolName));
      return "[" + items.join(",") + "]";
    }
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(`${k}:${normalizeValue(obj[k], toolName)}`);
    }
    return "{" + parts.join(",") + "}";
  }
  return String(val);
}

function normalizeArgs(args: Record<string, unknown>, toolName: string): string {
  const keys = Object.keys(args).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const val = args[key];
    parts.push(`${key}=${normalizeValue(val, toolName)}`);
  }
  return parts.join("&");
}

// ---------------------------------------------------------------------------
// Signal detectors (pure functions)
// ---------------------------------------------------------------------------

/**
 * Detect "spin": same (toolName + argsHash) repeated within a sliding window.
 *
 * Returns a signal with severity proportional to how many excess repeats
 * beyond threshold, up to severity 3.
 */
function detectSpin(input: SignalInput, thresholds: SignalThresholds): Signal | null {
  const calls = input.toolCalls;
  if (calls.length < 2) return null;

  const window = calls.slice(-thresholds.spinWindow);
  const counts = new Map<string, number>();
  for (const call of window) {
    const key = `${call.toolName}:${call.argsHash}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of counts) {
    if (count >= thresholds.spinThreshold) {
      const excess = count - thresholds.spinThreshold;
      const sev: 1 | 2 | 3 = excess > 0 ? 2 : 1;
      const severity = Math.min(3, sev) as 1 | 2 | 3;
      return {
        kind: "spin",
        severity,
        facts: {
          "repeat-key": key,
          "repeat-count": count,
          window: thresholds.spinWindow,
          threshold: thresholds.spinThreshold,
        },
      };
    }
  }

  return null;
}

/**
 * Detect "stall": too many tool calls since the last successful write or edit.
 */
function detectStall(input: SignalInput, thresholds: SignalThresholds): Signal | null {
  const calls = input.toolCalls;
  if (calls.length < thresholds.stallMinTotal) return null;

  // Find the last successful write/edit
  let lastSuccessIndex = -1;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (!c.isError && (c.toolName === "write" || c.toolName === "edit")) {
      lastSuccessIndex = i;
      break;
    }
  }

  if (lastSuccessIndex < 0) {
    // No write/edit ever succeeded — count from start
    if (calls.length >= thresholds.stallThreshold) {
      return {
        kind: "stall",
        severity: 2,
        facts: {
          "calls-since-success": calls.length,
          threshold: thresholds.stallThreshold,
        },
      };
    }
    return null;
  }

  const sinceSuccess = calls.length - 1 - lastSuccessIndex;
  if (sinceSuccess >= thresholds.stallThreshold) {
    return {
      kind: "stall",
      severity: sinceSuccess >= thresholds.stallThreshold * 2 ? 3 : 2,
      facts: {
        "calls-since-success": sinceSuccess,
        threshold: thresholds.stallThreshold,
      },
    };
  }

  return null;
}

/**
 * Detect "failure-cluster": high proportion of errors in recent window.
 */
function detectFailureCluster(input: SignalInput, thresholds: SignalThresholds): Signal | null {
  const calls = input.toolCalls;
  if (calls.length < thresholds.failureWindow) return null;

  const window = calls.slice(-thresholds.failureWindow);
  const errors = window.filter((c) => c.isError).length;

  if (errors >= thresholds.failureMinErrors) {
    return {
      kind: "failure-cluster",
      severity: errors >= thresholds.failureWindow - 1 ? 3 : 2,
      facts: {
        "errors-in-window": errors,
        window: thresholds.failureWindow,
      },
    };
  }

  return null;
}

/**
 * Detect "context-pressure": high context utilisation ratio.
 */
function detectContextPressure(input: SignalInput, thresholds: SignalThresholds): Signal | null {
  if (input.contextTokens === null || input.contextWindow === null || input.contextWindow === 0) {
    return null;
  }

  const ratio = input.contextTokens / input.contextWindow;
  if (ratio >= thresholds.contextPressureRatio) {
    const severity: 1 | 2 | 3 =
      ratio >= thresholds.contextPressureRatio + 0.1 ? 3 : ratio >= thresholds.contextPressureRatio + 0.05 ? 2 : 1;
    return {
      kind: "context-pressure",
      severity,
      facts: {
        "context-tokens": input.contextTokens,
        "context-window": input.contextWindow,
        ratio: Math.round(ratio * 100) / 100,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main signal evaluation entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate all signals from the given input.
 * Returns an array of triggered signals (empty = no signals).
 */
export function evaluateSignals(
  input: SignalInput,
  thresholds: SignalThresholds = DEFAULT_THRESHOLDS,
): Signal[] {
  const signals: Signal[] = [];

  const spin = detectSpin(input, thresholds);
  if (spin) signals.push(spin);

  const stall = detectStall(input, thresholds);
  if (stall) signals.push(stall);

  const fail = detectFailureCluster(input, thresholds);
  if (fail) signals.push(fail);

  const pressure = detectContextPressure(input, thresholds);
  if (pressure) signals.push(pressure);

  return signals;
}