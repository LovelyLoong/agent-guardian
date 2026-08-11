/**
 * agent-guardian — orca CLI 薄封装。
 *
 * 所有对 Orca 的调用都必须经过本模块（execFile + --json），
 * 测试通过注入 exec 替身实现零 Orca 依赖。
 *
 * B1（第七轮验收）：彻底取消 shell 包装。解析只接受 .exe（win32）——
 * PATH 只找 orca.exe；Windows 打包安装目录只认 orca.exe；ORCA_CLI_COMMAND
 * 指向 .cmd/.bat 时推导同目录同名 .exe 并 existsSync 校验。任何路径都找不到
 * .exe → fail-fast 报清晰错误，不留 cmd.exe /c 拼字符串的 shell 退路
 * （x|echo:PWNED 类注入面已实测）。参数一律以 argv 数组交给 execFile 直启、
 * 逐字传递，不经任何 shell 解释（panel objective、send 文本中的
 * x|whoami 等注入文本只作字面参数）。
 *
 * @module
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Orca 打包的 Windows 安装路径约定：
 * Orca 桌面版在 Windows 上安装时把 CLI 放在
 * `<user>\AppData\Local\Programs\orca\resources\bin\orca.exe`（安装器同目录
 * 还会放出 orca.cmd，但本工具只接受 .exe——.cmd 需经 cmd.exe /c 包装，
 * 是 shell 注入面，B1 禁用）。
 * 用户目录从 LOCALAPPDATA（或 USERPROFILE\AppData\Local）推导，不硬编码用户名。
 */
export function orcaWindowsInstallPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env["LOCALAPPDATA"];
  const local = explicit !== undefined && explicit.trim() !== ""
    ? explicit
    : (env["USERPROFILE"] !== undefined && env["USERPROFILE"].trim() !== ""
        ? join(env["USERPROFILE"], "AppData", "Local")
        : null);
  if (local === null) return "";
  return join(local, "Programs", "orca", "resources", "bin", "orca.exe");
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type OrcaExecutor = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * execFile 默认实现（Node 子进程）。B1：只直启 .exe（或 POSIX 可执行文件），
 * 参数数组逐字传递——无任何 cmd.exe /c 包装，不存在 shell 解释。
 */
export const defaultExec: OrcaExecutor = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      windowsHide: true,
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      // err.code: 进程退出码（数字）；启动失败（如 ENOENT）或信号终止时为字符串/空。
      const code = typeof (err as { code?: unknown }).code === "number"
        ? (err as { code: number }).code
        : null;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * orca 命令解析结果（B1）：只接受 .exe；找不到时携带清晰错误信息（fail-fast）。
 */
export type OrcaResolve =
  | { ok: true; command: string }
  | { ok: false; error: string };

/**
 * 解析 orca 可执行命令（B1：只接受 .exe，不允许任何 shell 退路），顺序：
 * 1. 环境变量 ORCA_CLI_COMMAND（显式指定，最高优先）：
 *    - win32 下若指向 .cmd/.bat → 推导同目录同名 .exe 并 existsSync 校验；
 *      有 .exe → 返回 .exe；无 → fail-fast 报清晰错误（不再经 cmd.exe 包装）。
 *    - 其余路径原样使用（win32 上应为 .exe）。
 * 2. PATH：win32 只找 orca.exe；POSIX 找 orca（execFile 直启，无 shell）。
 * 3. Orca 打包的 Windows 安装路径（orcaWindowsInstallPath）：只认 orca.exe。
 *
 * 找不到 → { ok:false, error }，调用方 fail-fast 报错退出，不让用户静默失败。
 */
export function resolveOrcaCommand(env: Record<string, string | undefined>): OrcaResolve {
  const explicit = env["ORCA_CLI_COMMAND"];
  if (explicit !== undefined && explicit.trim() !== "") {
    const cmd = explicit.trim();
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd)) {
      const exePath = join(dirname(cmd), `${basename(cmd).replace(/\.(?:cmd|bat)$/i, "")}.exe`);
      if (existsSync(exePath)) return { ok: true, command: exePath };
      return {
        ok: false,
        error:
          `ORCA_CLI_COMMAND 指向 ${cmd}（.cmd/.bat），但同目录没有同名 .exe；` +
          "本工具只接受 .exe（B1：不再经 cmd.exe 包装，消除 shell 注入面）",
      };
    }
    // 显式路径（含分隔符或以 .exe 结尾）必须真实存在；裸命令名交给 PATH 解析。
    const pathLike = /[\\/]/.test(cmd) || cmd.toLowerCase().endsWith(".exe");
    if (pathLike && !existsSync(cmd)) {
      return {
        ok: false,
        error: `ORCA_CLI_COMMAND 指向 ${cmd}，但文件不存在；本工具只接受真实存在的 .exe`,
      };
    }
    return { ok: true, command: cmd };
  }

  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  // Windows PATH 用 ';' 分隔（':' 是盘符的一部分，不能切）；POSIX 用 ':'。
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(sep).map((d) => d.trim()).filter((d) => d !== "");
  const candidates = process.platform === "win32" ? ["orca.exe"] : ["orca"];
  for (const dir of dirs) {
    for (const name of candidates) {
      const full = join(dir, name);
      if (existsSync(full)) return { ok: true, command: full };
    }
  }

  const winPath = orcaWindowsInstallPath(env);
  if (winPath !== "" && existsSync(winPath)) return { ok: true, command: winPath };

  const error = process.platform === "win32"
    ? "找不到 orca.exe（PATH 与 Windows 安装目录 %LOCALAPPDATA%\\Programs\\orca\\resources\\bin 均无；可用环境变量 ORCA_CLI_COMMAND 指定 .exe 绝对路径）"
    : "找不到 orca（PATH 上无 orca；可用环境变量 ORCA_CLI_COMMAND 指定路径）";
  return { ok: false, error };
}

export interface OrcaResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** 解析出的 JSON（整包，含 result/error 字段）；解析失败为 null */
  data: unknown | null;
  error: string | null;
}

/**
 * 在任意深度的对象里找第一个 key 匹配正则的字符串值。
 * 用于对 Orca 各版本返回形状的防御性读取（例如 worker-start 回执里的
 * dispatch id 字段名随版本可能不同）。
 */
export function findDeepString(value: unknown, keyPattern: RegExp): string | null {
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepString(item, keyPattern);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keyPattern.test(k) && typeof v === "string" && v !== "") return v;
      const found = findDeepString(v, keyPattern);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Orca CLI 封装：统一追加 --json、解析 stdout JSON。
 * 解析失败（如 launcher 前置文本）时退化为寻找第一个 "{" 起点的 JSON 包。
 */
export class OrcaCli {
  private readonly cmd: string;
  private readonly errMsg: string | null;
  private readonly exec: OrcaExecutor;

  constructor(exec: OrcaExecutor = defaultExec, cmd: string | null = null) {
    this.exec = exec;
    if (cmd !== null) {
      this.cmd = cmd;
      this.errMsg = null;
      return;
    }
    const resolved = resolveOrcaCommand(process.env);
    if (resolved.ok) {
      this.cmd = resolved.command;
      this.errMsg = null;
    } else {
      this.cmd = "";
      this.errMsg = resolved.error;
    }
  }

  get command(): string {
    return this.cmd;
  }

  get available(): boolean {
    return this.cmd !== "";
  }

  /** B1：命令解析失败原因（供调用方 fail-fast 报清晰错误）；无失败时为 null。 */
  get resolveError(): string | null {
    return this.errMsg;
  }

  async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<OrcaResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    if (this.cmd === "") {
      const err = this.errMsg ?? "no orca command resolved";
      return { ok: false, code: null, stdout: "", stderr: err, data: null, error: err };
    }
    const fullArgs = [...args, "--json"];
    const res = await this.exec(this.cmd, fullArgs, timeoutMs);
    const parsed = parseJsonOutput(res.stdout);
    // JSON 级业务失败：部分 orca 命令退出码为 0 但包内 ok:false + error，同样视为失败。
    const jsonOk = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["ok"] !== false
      : true;
    const ok = res.code === 0 && parsed !== null && jsonOk;
    const error = ok ? null : parseError(parsed, res);
    return { ok, code: res.code, stdout: res.stdout, stderr: res.stderr, data: parsed, error };
  }
}

/** 从 stdout 提取第一个完整 JSON 对象（兼容 launcher 前置文本）。 */
export function parseJsonOutput(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // 退化为寻找第一个 '{' 起点
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function parseError(parsed: unknown | null, res: ExecResult): string {
  if (parsed !== null && typeof parsed === "object") {
    const err = (parsed as Record<string, unknown>)["error"];
    if (err !== null && typeof err === "object") {
      const code = (err as Record<string, unknown>)["code"];
      if (typeof code === "string" && code !== "") return code;
      const msg = (err as Record<string, unknown>)["message"];
      if (typeof msg === "string" && msg !== "") return msg;
    }
  }
  const msg = res.stderr.trim() !== "" ? res.stderr.trim().slice(0, 300) : `exit ${String(res.code)}`;
  return msg;
}
