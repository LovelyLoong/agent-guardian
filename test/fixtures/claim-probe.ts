/**
 * agent-guardian — 跨进程单例选举探针（测试专用）。
 *
 * 用法：node claim-probe.ts <stateDir> <watchId> [total]
 * 流程：claimLock → 输出一行 acquired|<runId> 或 denied|<runId> → 向
 * <stateDir>/<watchId>.probe/<pid> 写结果文件。acquired 者保持存活直到结果文件
 * 齐集 <total> 个（即全体读者求值完毕），denied 者立即退出——
 * 保证胜者进程在全体读者求值期间存活（防快速退出干扰选举判定：若胜者先退出，
 * 迟到的求值者会看到其 claim 属主已死而合法当选，探针将误报多 acquired）。
 * 零网络/Orca 依赖；仅用本地账本文件。
 *
 * @module
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateStore } from "../../src/watcher/state.ts";

const dir = process.argv[2] ?? "";
const watchId = process.argv[3] ?? "";
const total = Number(process.argv[4] ?? "1");

const now = Date.now();
const runId = `probe-${process.pid}-${now.toString(36)}`;
const store = new StateStore(dir);
const claim = await store.claimLock(watchId, { prev: null, watchRunId: runId, now });
console.log(`${claim.kind}|${runId}`);
const probeDir = join(dir, `${watchId}.probe`);
mkdirSync(probeDir, { recursive: true });
writeFileSync(join(probeDir, String(process.pid)), runId, "utf-8");
if (claim.kind === "acquired") {
  // 保持存活直到全部 total 个结果文件齐集（全体求值完毕）再退出
  const deadline = Date.now() + 60_000;
  while (readdirSync(probeDir).length < total) {
    if (Date.now() > deadline) {
      console.error("claim-probe: 等待全部结果文件超时");
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
process.exit(0);
