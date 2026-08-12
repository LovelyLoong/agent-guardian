/**
 * agent-guardian — 跨进程 barrier 选举探针（测试专用）。
 *
 * 用法：node barrier-claim.ts <stateDir> <watchId> <readyDir> <goFile> <resultFile> <total>
 * 流程：① 以与 StateStore 相同的账本行格式 O_APPEND 追加自己的 claim 行；
 * ② 写就绪文件 <readyDir>/<pid>；③ 轮询等待主进程写 go 文件；
 * ④ 所有 claim 齐集后同时求值 leaseWinner → 向 <resultFile> 上报一行
 *    <pid>|<runId>|<winnerRunId>；⑤ 自认胜者保持存活直到 <resultFile> 凑齐
 *    <total> 行（全部上报完），非胜者立即退出。
 * 零网络/Orca 依赖；仅用本地账本文件。
 *
 * @module
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateStore, LEASE_MS } from "../../src/watcher/state.ts";

const args = process.argv.slice(2);
const dir = args[0] ?? "";
const watchId = args[1] ?? "";
const readyDir = args[2] ?? "";
const goFile = args[3] ?? "";
const resultFile = args[4] ?? "";
const total = Number(args[5] ?? "0");

const runId = `barrier-${process.pid}-${Date.now().toString(36)}`;
const now = Date.now();
// ① 追加 claim（O_APPEND，与 StateStore 相同的账本行格式）
mkdirSync(dir, { recursive: true });
appendFileSync(
  join(dir, `${watchId}.lock`),
  JSON.stringify({ op: "claim", runId, ownerPid: process.pid, leaseExpiresAt: now + LEASE_MS, ts: now }) + "\n",
  "utf-8",
);
// ② 就绪
mkdirSync(readyDir, { recursive: true });
writeFileSync(join(readyDir, String(process.pid)), runId, "utf-8");
// ③ 等 go（所有 claim 已齐集后主进程放行）
const goDeadline = Date.now() + 60_000;
while (!existsSync(goFile)) {
  if (Date.now() > goDeadline) {
    console.error("barrier: 等待 go 超时");
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
// ④ 同时求值：账本文件序首条存活 claim 为唯一胜者（所有读者结果一致）
const winner = new StateStore(dir).leaseWinner(watchId, Date.now());
const winnerRunId = winner?.runId ?? "none";
appendFileSync(resultFile, `${process.pid}|${runId}|${winnerRunId}\n`, "utf-8");
// ⑤ 自认胜者保持存活至全部上报完（非胜者立即退出）
if (winnerRunId === runId) {
  const collectDeadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > collectDeadline) {
      console.error("barrier: 等待全部上报超时");
      process.exit(3);
    }
    let n = 0;
    try {
      const text = readFileSync(resultFile, "utf-8").trim();
      n = text === "" ? 0 : text.split("\n").length;
    } catch {
      // Windows 并发 append 的瞬态读锁（EBUSY/EPERM）：本拍读不到 → 下拍再读，异常不裸抛
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    if (n >= total) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
process.exit(0);
