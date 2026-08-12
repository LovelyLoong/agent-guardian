/**
 * agent-guardian — 跨进程单例选举探针（测试专用）：claim 后保持存活。
 *
 * 用法：node hold-claim.ts <stateDir> <watchId>
 * 输出一行：acquired|<runId> 或 denied|<runId>；acquired 后保持存活直到收到
 * SIGTERM/SIGINT（测试杀死 = 模拟胜者进程死亡），denied 后立即退出。
 * 零网络/Orca 依赖；仅用本地账本文件。
 *
 * @module
 */

import { StateStore } from "../../src/watcher/state.ts";

const dir = process.argv[2] ?? "";
const watchId = process.argv[3] ?? "";

const now = Date.now();
const runId = `hold-${process.pid}-${now.toString(36)}`;
const store = new StateStore(dir);
const claim = await store.claimLock(watchId, { prev: null, watchRunId: runId, now });
console.log(`${claim.kind}|${runId}`);
if (claim.kind === "acquired") {
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
}
process.exit(0);
