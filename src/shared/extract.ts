/**
 * pi-task-governor — Shared session-entry → ToolCallFact extraction.
 *
 * Single source of truth for the "branch entries → ToolCallFact" merge
 * (design §5). Used by src/governor.ts, extensions/index.ts (via governor),
 * and scripts/observe-session.ts. Do not fork this logic.
 *
 * @module
 */

import { computeArgsHash } from "./signals.ts";
import type { ToolCallFact } from "./contract.ts";

/** A session entry as produced by ctx.sessionManager.getBranch() / session JSONL. */
export interface SessionEntry {
  type: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
}

/**
 * Extract ToolCallFacts from session branch entries.
 *
 * pi 0.84.1 authoritative shape:
 * - Assistant messages: content[] blocks with {type:"toolCall", id, name, arguments}
 * - Tool results: independent messages {role:"toolResult", toolCallId, toolName, isError, content}
 *
 * Both are merged in chronological order. Each toolCall gets its isError
 * from the corresponding toolResult matched by toolCallId.
 */
export function extractToolCallsFromBranch(
  entries: ReadonlyArray<SessionEntry>,
): ToolCallFact[] {
  // Merge toolCalls and toolResults by toolCallId (design §5).
  // Out-of-order: toolResult arriving before toolCall creates the fact
  // with a fallback argsHash (toolName-based); the later toolCall backfills
  // the same fact with real parameter hash. One logical call → one fact.
  const toolCallMap = new Map<string /* toolCallId */, number /* index */>();
  const facts: ToolCallFact[] = [];
  let turnIndex = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const bt = block as Record<string, unknown>;
        if (bt["type"] === "toolCall") {
          const toolName = String(bt["name"] ?? "");
          const args = (bt["arguments"] ?? {}) as Record<string, unknown>;
          const argsHash = computeArgsHash(args, toolName);
          const toolCallId = bt["id"] as string | undefined;

          if (typeof toolCallId === "string" && toolCallId && toolCallMap.has(toolCallId)) {
            // Out-of-order: toolResult already created the fact → backfill with real args
            const idx = toolCallMap.get(toolCallId)!;
            facts[idx] = {
              ...facts[idx]!,
              toolName,
              argsHash,
              // isError preserved from toolResult, not overwritten
            };
          } else {
            const idx = facts.length;
            facts.push({
              toolName,
              argsHash,
              isError: false, // will be updated by matching toolResult
              turnIndex,
            });
            turnIndex++;

            if (typeof toolCallId === "string" && toolCallId) {
              toolCallMap.set(toolCallId, idx);
            }
          }
        }
      }
    } else if (msg.role === "toolResult") {
      const toolCallId = msg["toolCallId"] as string | undefined;
      const toolName = String(msg["toolName"] ?? "");
      const isError = msg["isError"] === true;

      if (typeof toolCallId === "string" && toolCallId && toolCallMap.has(toolCallId)) {
        // Standard order: toolCall already seen → update isError on existing fact
        const idx = toolCallMap.get(toolCallId)!;
        facts[idx] = { ...facts[idx]!, isError };
      } else if (typeof toolCallId === "string" && toolCallId) {
        // Out-of-order: toolResult before toolCall → create fact, track for backfill.
        // design §5: fallback argsHash uses toolName (not resultContent).
        // Real argsHash is backfilled when the toolCall arrives later.
        const argsHash = computeArgsHash({}, toolName);
        const idx = facts.length;
        facts.push({
          toolName,
          argsHash,
          isError,
          turnIndex,
        });
        turnIndex++;
        toolCallMap.set(toolCallId, idx); // allow toolCall to backfill
      }
    }
  }

  return facts;
}
