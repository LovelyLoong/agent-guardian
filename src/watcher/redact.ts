/**
 * agent-guardian — 秘密脱敏（共享单源，位于 sanitize 旁）。
 *
 * 写入事件/证据包前对用户文本执行秘密模式过滤：命中的秘密替换为
 * "[REDACTED]"，并在事件上标 redacted:true（调用方负责标记）。
 * 只做替换，不改其余文本（净化见 sanitize.ts，职责分离）。
 *
 * @module
 */

/** 命中的秘密统一替换为的占位文本。 */
export const REDACTED = "[REDACTED]";

export interface SecretPattern {
  name: string;
  re: RegExp;
}

/** 秘密模式（顺序无关；各模式独立替换）。 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "openai-style-secret", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "bearer-token", re: /\bBearer\s+\S+/g },
  { name: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * 对单段文本执行全部秘密模式过滤。返回替换后的文本与是否命中。
 */
export function redactText(text: string): { text: string; changed: boolean } {
  let out = text;
  let changed = false;
  for (const { re } of SECRET_PATTERNS) {
    if (re.test(out)) {
      changed = true;
      out = out.replace(re, REDACTED);
    }
  }
  return { text: out, changed };
}

/**
 * 递归脱敏任意 JSON 值（字符串替换；数组/对象逐元素处理）。
 * 返回处理后的值与会否命中。
 */
export function redactValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const r = redactText(value);
    return { value: r.text, changed: r.changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const r = redactValue(item);
      if (r.changed) changed = true;
      out.push(r.value);
    }
    return { value: out, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactValue(v);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}
