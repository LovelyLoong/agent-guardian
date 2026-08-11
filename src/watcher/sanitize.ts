/**
 * agent-guardian — 自由文本净化（共享单源）。
 *
 * 用户可见面（steer 文案、面板问题/结论、事件引用）的统一净化：
 * - LLM 自由文本（原 llm.ts 的 sanitizeLlmText 语义，本模块为单源）；
 * - 机械 facts 值（decide.ts 组装 steer 时的防注入：ANSI 转义/控制字符）。
 *
 * @module
 */

/** 自由文本进入用户可见面前的净化上限（字符）。 */
export const TEXT_MAX_CHARS = 2_000;

/**
 * 净化自由文本：先去除完整 ANSI 转义序列（CSI：ESC [ 参数 最终字节，如 \u001B[31m），
 * 再去掉其余控制字符（仅保留 \t 与 \n），超过上限截断并 trim。
 * 覆盖 C0 控制区（含 ESC \u001B、NUL/BEL/CR 等）与 C1 控制区（\u007F-\u009F）。
 */
export function sanitizeText(text: string, maxLength = TEXT_MAX_CHARS): string {
  const noAnsi = text.replace(/\u001B\[[0-9;?]*[ -\/]*[@-~]/g, "");
  const cleaned = noAnsi.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
