/**
 * agent-guardian — EBUSY/EPERM 写路径瞬态重试注入夹具（子进程专用）。
 *
 * 由 test/ebusy-write.test.ts 以 `node ebusy-inject.ts <scenario> <dir>` 拉起。
 * 注入机制：node:fs 的 ESM 命名空间在首次 ESM import 时从 module.exports
 * 快照/读取——本夹具在**任何** ESM import node:fs 之前先用 CJS require 拿到
 * 真实 module.exports 并就地替换目标函数（其余导出原样保留，真实引用预先
 * 捕获），之后源模块（events.ts/state.ts 及其依赖）的 ESM 命名导入即读到
 * 补丁版。真实文件系统在 Linux 上不会产生 EBUSY，Windows 上纯 Node 并发读
 * 也无法稳定复现共享冲突，只能靠模块层注入做确定性回归。
 *
 * 每个场景在内部断言，成功打印 `RESULT:<scenario>:ok` 并 exit 0；
 * 失败打印 `RESULT:<scenario>:FAIL:<原因>` 并 exit 1。
 *
 * 零 Orca/网络依赖；全部写入临时目录（调用方传入）。
 *
 * @module
 */

import { createRequire } from "node:module";

// 注意：此处不得 ESM import node:fs（否则命名空间在补丁前创建，补丁不可见）。
// 真实引用全部经 CJS require 捕获（补丁前），补丁只替换 module.exports 上
// 的个别函数，其余导出保持真实。
const req = createRequire(import.meta.url);
const realFs = req("node:fs") as typeof import("node:fs");
const path = req("node:path") as typeof import("node:path");

/** 瞬态 IO 错误工厂（与 shared/fs.ts isTransientIoError 判定口径一致）。 */
function transientErr(code: "EBUSY" | "EPERM"): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const scenario = process.argv[2];
const dirArg = process.argv[3];
if (scenario === undefined || dirArg === undefined) {
  console.error("RESULT:?:FAIL:缺少参数（<scenario> <dir>）");
  process.exit(2);
}
const dir: string = dirArg;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  if (scenario === "append-retry" || scenario === "append-exhausted") {
    // appendFileSync：前 2 次 EBUSY（瞬态重试应消化）→ 之后真实落盘；或恒 EBUSY（重试耗尽）
    const realAppend = realFs.appendFileSync;
    let failsLeft = scenario === "append-retry" ? 2 : Number.POSITIVE_INFINITY;
    let calls = 0;
    const appendMock: typeof realAppend = (p, d) => {
      calls++;
      if (failsLeft > 0) {
        failsLeft--;
        throw transientErr("EBUSY");
      }
      realAppend(p, d, "utf-8");
    };
    realFs.appendFileSync = appendMock;
    const { EventStore } = await import("../../src/events.ts");
    const store = new EventStore(dir);
    const ok = store.append("w1", { type: "watch_start" });
    if (scenario === "append-retry") {
      check(ok === true, `EBUSY 瞬态重试后 append 应成功（实测 ${ok}）`);
      check(failsLeft === 0 && calls >= 3, `应重试后成功（calls=${calls}, failsLeft=${failsLeft}）`);
      const text = realFs.readFileSync(path.join(dir, "w1.jsonl"), "utf-8");
      check(text.includes('"watch_start"'), "真实文件应包含已追加的事件行");
    } else {
      check(ok === false, `EBUSY 重试耗尽 append 应返回 false（实测 ${ok}）`);
      check(calls >= 3, `应恰好重试耗尽（calls=${calls}）`);
    }
  } else if (scenario === "renew-busy" || scenario === "renew-append-fail") {
    if (scenario === "renew-append-fail") {
      // 预置自己的存活 claim（真实 fs 先写），使求值胜者为自己
      realFs.writeFileSync(
        path.join(dir, "w1.lock"),
        JSON.stringify({
          op: "claim",
          runId: "run-me",
          ownerPid: process.pid,
          leaseExpiresAt: Date.now() + 20 * 60_000,
          ts: Date.now(),
        }) + "\n",
        "utf-8",
      );
    }
    if (scenario === "renew-busy") {
      // 读恒 EBUSY：readLedger 瞬态重试耗尽 → busy=true → renewLock 必须保守丢锁
      realFs.readFileSync = () => {
        throw transientErr("EBUSY");
      };
    } else {
      // 读正常、追加恒 EBUSY：renew 追加重试耗尽 → 租约未延长 → renewLock 必须返回 false
      realFs.appendFileSync = (() => {
        throw transientErr("EBUSY");
      }) as typeof realFs.appendFileSync;
    }
    const { StateStore } = await import("../../src/watcher/state.ts");
    const store = new StateStore(dir);
    const renewed = store.renewLock(
      "w1",
      { watchRunId: "run-me", ownerPid: process.pid, leaseExpiresAt: Date.now() + 20 * 60_000 },
      Date.now(),
    );
    check(
      renewed === false,
      `${scenario === "renew-busy" ? "busy 耗尽" : "renew 追加失败"} → renewLock 必须返回 false（实测 ${renewed}）`,
    );
  } else if (scenario === "release-retry" || scenario === "release-exhausted") {
    // 预置他人的存活 claim（真实 fs 先写）：run-me 的 claim 必然 denied → 走 release 撤销
    realFs.writeFileSync(
      path.join(dir, "w1.lock"),
      JSON.stringify({
        op: "claim",
        runId: "run-other",
        ownerPid: process.pid,
        leaseExpiresAt: Date.now() + 20 * 60_000,
        ts: Date.now(),
      }) + "\n",
      "utf-8",
    );
    const realAppend = realFs.appendFileSync;
    const releasePersistent = scenario === "release-exhausted";
    let releaseFailsLeft = releasePersistent ? Number.POSITIVE_INFINITY : 2;
    let releaseCalls = 0;
    // 只对 release 行注入 EBUSY（claim 行须真实落账，否则 readWinner 无我的 claim）
    const appendMock: typeof realAppend = (p, d) => {
      if (typeof d === "string" && d.includes('"op":"release"')) {
        releaseCalls++;
        if (releaseFailsLeft > 0) {
          releaseFailsLeft--;
          throw transientErr("EBUSY");
        }
      }
      realAppend(p, d, "utf-8");
    };
    realFs.appendFileSync = appendMock;
    const { StateStore } = await import("../../src/watcher/state.ts");
    const store = new StateStore(dir);
    const claim = await store.claimLock("w1", { prev: null, watchRunId: "run-me", now: Date.now() });
    check(claim.kind === "denied", `他人存活 claim 在前 → 必须 denied（实测 ${claim.kind}）`);
    const lines = store.readLedger("w1").lines;
    const myRelease = lines.some((l) => l.op === "release" && l.runId === "run-me");
    if (releasePersistent) {
      check(!myRelease, "release 重试耗尽后不得落账（ghost claim 留待 pid 死亡兜底）");
      check(releaseCalls >= 3, `release 应重试耗尽（releaseCalls=${releaseCalls}）`);
    } else {
      check(myRelease, "release 瞬态重试后必须成功落账（撤销自建 claim，防 ghost）");
      check(releaseFailsLeft === 0 && releaseCalls >= 3, `release 应重试后成功（releaseCalls=${releaseCalls}）`);
      check(
        store.leaseWinner("w1", Date.now())?.runId === "run-other",
        "release 只杀死自己的 runId，他人胜者不受影响",
      );
    }
  } else if (scenario === "load-transient-exhausted") {
    // 读恒 EBUSY：readFileSyncRetry 瞬态重试耗尽 → load 必须返回 {kind:"error"}
    // （W5：与 ENOENT 的 missing 区分——missing 侧由 state.test.ts 进程内用例覆盖；
    // ESM 命名空间在首次 import 时从 module.exports 快照，故补丁必须先于 import）
    realFs.readFileSync = (() => {
      throw transientErr("EBUSY");
    }) as typeof realFs.readFileSync;
    const { StateStore } = await import("../../src/watcher/state.ts");
    const store = new StateStore(dir);
    const loaded = await store.load("w1");
    check(loaded.kind === "error", `EBUSY 重试耗尽 → load 应返回 error（实测 ${JSON.stringify(loaded)}）`);
    if (loaded.kind === "error") {
      check(loaded.reason.length > 0, `error 应携带可读 reason（实测 ${loaded.reason}）`);
      check(loaded.reason.includes("EBUSY"), `reason 应指明瞬态重试耗尽（实测 ${loaded.reason}）`);
    }
  } else {
    throw new Error(`未知场景: ${scenario}`);
  }
  console.log(`RESULT:${scenario}:ok`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`RESULT:${scenario}:FAIL:${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
