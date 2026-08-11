/**
 * agent-guardian — orca.ts 封装测试：命令解析（B1：只接受 .exe）/ --json 追加 /
 * JSON 解析 / 防御性读取 / 无 shell 注入回归。
 *
 * @module
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaCli, resolveOrcaCommand, parseJsonOutput, findDeepString, orcaWindowsInstallPath, defaultExec } from "../src/orca.ts";
import type { OrcaExecutor } from "../src/orca.ts";

/** 断言解析成功并返回指定命令。 */
function expectCommand(env: Record<string, string | undefined>, expected: string): void {
  const r = resolveOrcaCommand(env);
  assert.ok(r.ok, `解析应成功（实际: ${JSON.stringify(r)}）`);
  if (r.ok) assert.strictEqual(r.command, expected);
}

/** 断言解析失败且错误信息包含指定片段。 */
function expectFailure(env: Record<string, string | undefined>, includes: string): void {
  const r = resolveOrcaCommand(env);
  assert.ok(!r.ok, `解析应失败（实际: ${JSON.stringify(r)}）`);
  if (!r.ok) assert.ok(r.error.includes(includes), `错误信息应包含 ${includes}（实际: ${r.error}）`);
}

describe("resolveOrcaCommand（B1：只接受 .exe，无 shell 退路）", () => {
  it("ORCA_CLI_COMMAND 最高优先（显式 .exe 须真实存在；裸命令名交给 PATH）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-priority-"));
    const exe = join(dir, "my orca.exe");
    writeFileSync(exe, "", "utf-8");
    expectCommand({ ORCA_CLI_COMMAND: `  ${exe}  `, PATH: "" }, exe);
    expectCommand({ ORCA_CLI_COMMAND: "  orca-dev  ", PATH: "" }, "orca-dev");
    // 显式 .exe 路径不存在 → fail-fast（调度者裁决：显式路径必须真实存在）
    expectFailure({ ORCA_CLI_COMMAND: "C:/definitely-missing/orca.exe", PATH: "" }, "文件不存在");
  });

  it("ORCA_CLI_COMMAND 指向 .cmd → 推导同目录同名 .exe 并校验存在", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-explicit-exe-"));
    writeFileSync(join(dir, "orca.cmd"), "", "utf-8");
    writeFileSync(join(dir, "orca.exe"), "", "utf-8");
    expectCommand({ ORCA_CLI_COMMAND: join(dir, "orca.cmd"), PATH: "" }, join(dir, "orca.exe"));
  });

  it("纯 .cmd 环境（stub）：ORCA_CLI_COMMAND 指向 .cmd 且同目录无 .exe → 明确报错而非执行（B1）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-cmd-only-"));
    writeFileSync(join(dir, "orca.cmd"), "", "utf-8");
    expectFailure(
      { ORCA_CLI_COMMAND: join(dir, "orca.cmd"), PATH: "" },
      "同目录没有同名 .exe",
    );
  });

  it("PATH 上找到 orca.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-path-"));
    const exeName = process.platform === "win32" ? "orca.exe" : "orca";
    writeFileSync(join(dir, exeName), "", "utf-8");
    expectCommand({ ORCA_CLI_COMMAND: "", PATH: dir }, join(dir, exeName));
  });

  it("PATH 只有 orca.cmd → 不再接受（B1：只接受 .exe）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-path-cmd-"));
    writeFileSync(join(dir, "orca.cmd"), "", "utf-8");
    expectFailure({ ORCA_CLI_COMMAND: "", PATH: dir }, "找不到 orca");
  });

  it("PATH 没有 → 回退 Windows 安装路径约定（按 LOCALAPPDATA/USERPROFILE 推导）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-empty-"));
    // 推导出的路径真实存在 → 返回它
    const local = mkdtempSync(join(tmpdir(), "ag-orca-local-"));
    const orcaExe = join(local, "Programs", "orca", "resources", "bin", "orca.exe");
    mkdirSync(join(local, "Programs", "orca", "resources", "bin"), { recursive: true });
    writeFileSync(orcaExe, "", "utf-8");
    expectCommand({ ORCA_CLI_COMMAND: "", PATH: dir, LOCALAPPDATA: local }, orcaExe);
    // 路径不存在 → 明确报错（不硬编码任何用户目录，也不退回 .cmd）
    expectFailure({ ORCA_CLI_COMMAND: "", PATH: dir, LOCALAPPDATA: dir }, "找不到 orca");
  });

  it("Windows 安装路径：只有 orca.cmd 时解析失败，不再退回 .cmd（B1）", () => {
    const local = mkdtempSync(join(tmpdir(), "ag-orca-install-cmd-"));
    const bin = join(local, "Programs", "orca", "resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "orca.cmd"), "", "utf-8");
    expectFailure({ ORCA_CLI_COMMAND: "", PATH: "", LOCALAPPDATA: local }, "找不到 orca.exe");
  });

  it("orcaWindowsInstallPath：LOCALAPPDATA 优先，USERPROFILE 兜底，都没有 → 空", () => {
    assert.strictEqual(
      orcaWindowsInstallPath({ LOCALAPPDATA: "C:/Users/X/AppData/Local", USERPROFILE: "C:/Users/X" }),
      join("C:/Users/X/AppData/Local", "Programs", "orca", "resources", "bin", "orca.exe"),
    );
    assert.strictEqual(
      orcaWindowsInstallPath({ LOCALAPPDATA: "", USERPROFILE: "C:/Users/Y" }),
      join("C:/Users/Y/AppData/Local", "Programs", "orca", "resources", "bin", "orca.exe"),
    );
    assert.strictEqual(orcaWindowsInstallPath({ LOCALAPPDATA: "", USERPROFILE: "" }), "");
    assert.strictEqual(orcaWindowsInstallPath({}), "");
  });
});

describe("OrcaCli", () => {
  it("自动追加 --json 并解析 stdout JSON", async () => {
    let seenArgs: string[] = [];
    const exec: OrcaExecutor = async (_cmd, args) => {
      seenArgs = args;
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { x: 1 } }), stderr: "" };
    };
    const cli = new OrcaCli(exec, "orca-stub");
    const res = await cli.run(["terminal", "list"]);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(seenArgs.at(-1), "--json");
    assert.deepStrictEqual((res.data as { result: unknown }).result, { x: 1 });
  });

  it("非零退出码 → ok:false + 错误信息", async () => {
    const exec: OrcaExecutor = async () => ({ code: 1, stdout: "oops", stderr: "boom" });
    const cli = new OrcaCli(exec, "orca-stub");
    const res = await cli.run(["terminal", "list"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "boom");
  });

  it("找不到 orca 命令 → ok:false 且不执行", async () => {
    let executed = false;
    const exec: OrcaExecutor = async () => {
      executed = true;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const cli = new OrcaCli(exec, "");
    const res = await cli.run(["terminal", "list"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(executed, false);
    assert.strictEqual(cli.available, false);
  });

  it("B1：ORCA_CLI_COMMAND 指向无 .exe 的 .cmd → available=false + resolveError 清晰报错，且不执行任何命令", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-orca-env-cmd-"));
    writeFileSync(join(dir, "orca.cmd"), "", "utf-8");
    const prev = process.env.ORCA_CLI_COMMAND;
    process.env.ORCA_CLI_COMMAND = join(dir, "orca.cmd");
    let executed = false;
    const exec: OrcaExecutor = async () => {
      executed = true;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    try {
      const cli = new OrcaCli(exec); // cmd=null → 走环境解析（B1 fail-fast）
      assert.strictEqual(cli.available, false);
      assert.ok(cli.resolveError !== null && cli.resolveError.includes("同目录没有同名 .exe"), `应携带清晰错误（实际: ${cli.resolveError}）`);
      const res = await cli.run(["terminal", "list"]);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(executed, false, "解析失败不得执行任何命令（无 shell 退路）");
      assert.strictEqual(res.error, cli.resolveError);
    } finally {
      if (prev === undefined) delete process.env.ORCA_CLI_COMMAND;
      else process.env.ORCA_CLI_COMMAND = prev;
    }
  });

  it("错误 JSON 结构（error 字段）也能给出错误码", async () => {
    const exec: OrcaExecutor = async () => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: { code: "timeout", message: "timeout" } }),
      stderr: "",
    });
    const cli = new OrcaCli(exec, "orca-stub");
    const res = await cli.run(["terminal", "wait"]);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "timeout");
  });
});

describe("B1 注入回归：参数数组逐字传递，无任何 shell 解释", () => {
  it("send 文本含注入字符 x|whoami → 作为单一 argv 元素逐字传给 executor（不拼 shell 串）", async () => {
    let seen: string[] = [];
    const exec: OrcaExecutor = async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const cli = new OrcaCli(exec, "orca-stub");
    const payload = "x|whoami && echo PWNED";
    const res = await cli.run(["terminal", "send", "--terminal", "h", "--text", payload, "--enter"]);
    assert.strictEqual(res.ok, true);
    assert.ok(seen.includes(payload), "注入文本必须是独立 argv 元素（不得被 shell 拆解/解释）");
    assert.ok(!seen.some((a) => a.includes("/c")), "不得出现 cmd.exe /c 包装");
  });

  it("panel objective 含注入字符 → 作为单一 argv 元素逐字传给 executor", async () => {
    let seen: string[] = [];
    const exec: OrcaExecutor = async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    };
    const cli = new OrcaCli(exec, "orca-stub");
    const payload = "请评估：x|whoami 能否执行？$(danger)";
    const res = await cli.run(["orchestration", "run-create", "--objective", payload]);
    assert.strictEqual(res.ok, true);
    assert.ok(seen.includes(payload), "panel objective 必须是独立 argv 元素（不得被 shell 解释）");
  });
});

describe("defaultExec（B1：.exe 直启，无任何 shell 包装）", () => {
  it("参数含注入文本也逐字到达子进程（execFile 参数数组直启，不经 shell）", async () => {
    // 用当前 Node 可执行文件做替身：子进程打印收到的 argv，验证逐字传递
    const script = "console.log(JSON.stringify(process.argv.slice(1)))";
    const res = await defaultExec(process.execPath, ["-e", script, "x|whoami", "--text", "a b;c & d"], 10_000);
    assert.strictEqual(res.code, 0, `stderr: ${res.stderr}`);
    const argv = JSON.parse(res.stdout) as string[];
    assert.deepStrictEqual(argv, ["x|whoami", "--text", "a b;c & d"]);
  });
});

describe("parseJsonOutput", () => {
  it("纯 JSON 与 launcher 前置文本都能解析", () => {
    assert.deepStrictEqual(parseJsonOutput('{"ok":true}'), { ok: true });
    assert.deepStrictEqual(parseJsonOutput('启动中...\n{"ok":true}'), { ok: true });
    assert.strictEqual(parseJsonOutput(""), null);
    assert.strictEqual(parseJsonOutput("纯文本没有 JSON"), null);
  });
});

describe("findDeepString", () => {
  it("任意深度按 key 模式取字符串", () => {
    const data = { result: { worker: { dispatch_id: "d-1" } } };
    assert.strictEqual(findDeepString(data, /dispatch.?id/i), "d-1");
    assert.strictEqual(findDeepString({ a: { b: "x" } }, /dispatch.?id/i), null);
    assert.strictEqual(findDeepString(null, /dispatch.?id/i), null);
    assert.strictEqual(findDeepString(["a", { dispatchId: "d-2" }], /dispatch.?id/i), "d-2");
  });
});
