/**
 * agent-guardian — watcher 状态机。
 *
 * {settledBeats, cursor, cooldownUntil, remindCount, remindHistory,
 *  escalationCount（纯统计，不作触发）, settledIncidents, llmCalls,
 *  startedAt, budget}，每拍原子落盘
 * （tmp + rename），崩溃恢复续跑。
 * V2a 新增：warningSent/warningTrigger（L2 警告闩锁，取代 V1 的
 * safetyWarningSent/safetyWarningTrigger，旧字段名映射继承）、
 * paused/pauseTrigger（暂停待命闩锁，复工需新工具调用）、contract（任务契约）。
 *
 * V1.1 运行代际/租约/单例（state 文件保持稳定名 <watchId>.json，历史按
 * watchRunId + generation 字段区分）：
 * - watchRunId：每次启动新生成；generation：该 watchId 被接管过的次数；
 * - status: active|finished——finished = 下次启动默认视为新任务（fresh）；
 * - ownerPid + leaseExpiresAt：租约判定——未过期租约且属主存活 = 单例占用
 *   （拒绝启动）；未过期租约且属主已死 = 崩溃恢复（继承旧状态）；
 *   租约过期 = 新任务（旧运行早已失联，不恢复）。
 *   租约随每拍落盘续租（心跳），LEASE_MS 覆盖单次最长 waitIdle 窗口。
 * - 原子单例（V1.2：append-only 租约账本 leader election，替代 V1.1
 *   link/rename 方案——真实 50 进程并发下概率窗口仍多 acquired）：<watchId>.lock
 *   为逐行 JSON 账本，appendFileSync O_APPEND 追加（小写入本地文件原子），永不
 *   删除/改名（无删除竞争，无回收 TOCTOU）。claim = 追加自己的 claim 行 → 重读
 *   账本 → 文件序第一条存活 claim（未 release 且租约未过期且属主存活）为胜者——
 *   所有读者对同一账本求值结果一致，确定性恰一 acquired；续租 = 属主每拍追加
 *   renew（归属校验内建于求值，非胜者 renew 无效）；收尾 = 追加 release（该
 *   runId 永久死亡，账本不删除）。同进程双跑由内存 watchId 注册表拦截。
 * - 断链永久死亡（V1.2.1 防僵尸复活）：按文件序求值、每行自带 ts 作时钟——某 runId 遇到
 *   任一行（claim/renew）时若该行 ts 晚于其当前 leaseExpiresAt，即该 runId 中途断链
 *   （租约曾过期），永久死亡，其后 renew 一律忽略——旧 owner 租约过期被新 claim 接管后，
 *   复活追加的 renew 不得凭更前的文件序赢回锁；新 claim 不受旧 runId 影响。时钟偏斜相对
 *   20min 租约可忽略（续租间隔 ≤60s，余量 ~19min）。
 *
 * @module
 */

import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskContract } from "./contract.ts";
import { isTaskContract } from "./contract.ts";
import {
  appendFileSyncRetry,
  isTransientIoError,
  readFileSyncRetry,
  sleep,
  TRANSIENT_IO_ATTEMPTS,
  TRANSIENT_IO_SETTLE_MS,
  withTransientRetry,
} from "../shared/fs.ts";

/** 租约时长（ms）：每拍续租一行；单次 waitIdle 窗口上限 600s，留足余量。 */
export const LEASE_MS = 20 * 60_000;

/** 同进程已声明 watchId 注册表：防同进程双跑（Promise.all 场景）。 */
const claimedWatchIds = new Set<string>();

/** 账本重读退避（ms）别名：撕裂尾行 / EBUSY 共用同一瞬态重试量级（shared/fs.ts）。 */
const LEDGER_SETTLE_MS = TRANSIENT_IO_SETTLE_MS;

/** 声明本进程对 watchId 的监督权；已被本进程声明 → false（拒绝双跑）。 */
export function claimInProcess(watchId: string): boolean {
  if (claimedWatchIds.has(watchId)) return false;
  claimedWatchIds.add(watchId);
  return true;
}

/** 释放本进程对 watchId 的声明（收尾/拒绝后）。 */
export function releaseInProcess(watchId: string): void {
  claimedWatchIds.delete(watchId);
}

/** 每次启动新生成的运行代 ID。 */
export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** POSIX/Windows 通用进程存活探测（signal 0；EPERM=存在但无权限 → 存活）。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type StartDecision =
  | { kind: "fresh" }
  | { kind: "resume" }
  | { kind: "denied"; reason: string };

/**
 * 本运行锁身份描述（claim/renew/release 参数）：runId + 属主 + 租约，
 * 与状态租约字段同构。
 */
export interface LockInfo {
  watchRunId: string;
  ownerPid: number;
  leaseExpiresAt: number;
}

/** 租约账本行（<watchId>.lock 逐行 JSON，O_APPEND 追加，永不删除/改名）。 */
export type LedgerLine =
  | { op: "claim"; runId: string; ownerPid: number; leaseExpiresAt: number; ts: number }
  | { op: "renew"; runId: string; leaseExpiresAt: number; ts: number }
  | { op: "release"; runId: string };

/** 账本求值胜者：文件序第一条存活 claim。 */
export interface LeaseWinner {
  runId: string;
  ownerPid: number;
  leaseExpiresAt: number;
}

/** 解析一行账本 JSON；坏行（非 JSON/缺字段/类型错）→ null（容忍跳过，不影响求值）。 */
function parseLedgerLine(raw: string): LedgerLine | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const line = value as Record<string, unknown>;
  const runId = typeof line.runId === "string" && line.runId !== "" ? line.runId : null;
  if (runId === null) return null;
  const leaseExpiresAt =
    typeof line.leaseExpiresAt === "number" && Number.isFinite(line.leaseExpiresAt) ? line.leaseExpiresAt : null;
  if (line.op === "claim") {
    const ownerPid = typeof line.ownerPid === "number" && Number.isInteger(line.ownerPid) ? line.ownerPid : null;
    if (leaseExpiresAt === null || ownerPid === null) return null;
    const ts = typeof line.ts === "number" && Number.isFinite(line.ts) ? line.ts : 0;
    return { op: "claim", runId, ownerPid, leaseExpiresAt, ts };
  }
  if (line.op === "renew") {
    if (leaseExpiresAt === null) return null;
    // ts 缺省 0（旧格式账本 renew 无 ts 字段）：0 永不触发断链判定，兼容旧行
    const ts = typeof line.ts === "number" && Number.isFinite(line.ts) ? line.ts : 0;
    return { op: "renew", runId, leaseExpiresAt, ts };
  }
  if (line.op === "release") return { op: "release", runId };
  return null;
}

/** 原子单例 claim 结果：acquired 携带状态裁决（fresh/resume）。 */
export type LockClaim =
  | { kind: "acquired"; start: StartDecision }
  | { kind: "denied"; reason: string };

/**
 * load 可区分结果（W5）：
 * - ok：成功读出状态；
 * - missing：无状态文件（ENOENT）/损坏不可恢复——合法"首次运行"语义（fresh）；
 * - error：读取真失败（EBUSY/EPERM 瞬态重试耗尽、权限等）——调用方中止启动
 *   （打印清晰错误含 reason、不写任何共享文件、以错误退出码退出，可重试），
 *   不得当作无状态 fresh 启动（可能掩盖既有 active 状态/安全闩锁），也不得
 *   降级继续（瞬态风暴下会覆写可能仍有效的旧状态）。
 */
export type LoadResult =
  | { kind: "ok"; state: WatchState }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/**
 * 启动裁决（V1.1 单例/崩溃恢复）：
 * - 无状态或已有 finished 状态 → 新任务（fresh，不继承任何计数）；
 * - active + 未过期租约 + 属主存活 → 拒绝启动（单例）；
 * - active + 未过期租约 + 属主已死 → 崩溃恢复（resume，继承旧状态）；
 * - active + 租约已过期 → 新任务（旧运行早已失联，不恢复）。
 */
export function decideStart(prev: WatchState | null, now: number): StartDecision {
  if (prev === null || prev.status === "finished") return { kind: "fresh" };
  const leaseHeld = now < prev.leaseExpiresAt;
  const ownerAlive = pidAlive(prev.ownerPid);
  if (leaseHeld && ownerAlive) {
    return { kind: "denied", reason: "已有监督者正在运行（同 handle 存在未过期租约且属主进程存活），拒绝重复启动" };
  }
  if (leaseHeld && !ownerAlive) return { kind: "resume" };
  return { kind: "fresh" };
}

/** 本次运行接管状态：新运行代 + 属主 + 租约；崩溃恢复时在旧状态上就地接管。 */
export function claimRun(state: WatchState, opts: { watchRunId: string; generation: number; now: number }): WatchState {
  state.watchRunId = opts.watchRunId;
  state.generation = opts.generation;
  state.status = "active";
  state.ownerPid = process.pid;
  state.leaseExpiresAt = opts.now + LEASE_MS;
  return state;
}

export interface RemindHistoryEntry {
  kind: string;
  beat: number;
  factsHash: string;
}

export interface WatchState {
  watchId: string;
  /** 每次启动新生成的运行代（区分同 watchId 的历史运行；state 文件保持稳定名） */
  watchRunId: string;
  /** 代际：该 watchId 被接管过的次数（首次=1，每次 fresh/resume 接管 +1） */
  generation: number;
  /** 运行状态：active=本次运行中；finished=已正常收尾（下次启动视为新任务） */
  status: "active" | "finished";
  /** 本运行属主进程 pid（单例/崩溃恢复判定用） */
  ownerPid: number;
  /** 租约到期时刻（ms epoch）：每拍落盘续租；未过期租约+属主存活=单例占用 */
  leaseExpiresAt: number;
  settledBeats: number;
  /** 通道游标（file=文件字节数；orca=终端输出游标） */
  cursor: string;
  /** kind → 冷却到第几拍（含）：当前拍 >= cooldownUntil 仍抑制（m1，与 decide.ts 一致） */
  cooldownUntil: Record<string, number>;
  remindCount: number;
  remindHistory: RemindHistoryEntry[];
  /**
   * 复现总累计（纯统计：进报告/证据包；V2b 起不作触发条件——
   * 升级阶梯按 incident（signalKey=kind+factsHash）判定，见 decide.ts）。
   */
  escalationCount: number;
  /**
   * 阶梯已到 pause 封顶的 incident key（signalKey=kind+factsHash，V2b）：
   * 该 incident 不再重复提醒/升级（只记录）；不同 incident 互不影响彼此阶梯。
   */
  settledIncidents: string[];
  llmCalls: number;
  startedAt: number;
  budgetMs: number;
  /** L2 警告闩锁（V2a：提醒复现后的"需要回应"警告；取代 V1 安全网警告闩锁） */
  warningSent: boolean;
  /** L2 警告触发信号 kind（"spin"/"stall"/...）；null=未发警告 */
  warningTrigger: string | null;
  /** 暂停待命闩锁（V2a：警告未确认且信号复现 → pause；复工需新工具调用） */
  paused: boolean;
  /** 暂停触发 incident key（signalKey=kind:factsHash，与 settledIncidents 同源一致）；null=未暂停 */
  pauseTrigger: string | null;
  /** 任务契约（--contract 挂载，不可变；无契约时 null） */
  contract: TaskContract | null;
  /** 事件落盘曾失败（append 返回 false）：报告须显式标注，不静默当已记录 */
  eventsDegraded: boolean;
  targetKind: string;
  channelKind: "file" | "orca";
  handle: string;
  sessionFile: string | null;
  lastAction: string | null;
}

export interface NewStateInput {
  watchId: string;
  budgetMs: number;
  targetKind: string;
  channelKind: "file" | "orca";
  handle: string;
  sessionFile: string | null;
  /** 任务契约（--contract 挂载，不可变；无契约时 null） */
  contract?: TaskContract | null;
  now: number;
  /** 缺省=新生成 */
  watchRunId?: string;
  /** 缺省=1（首次接管） */
  generation?: number;
  ownerPid?: number;
  leaseExpiresAt?: number;
}

export function initialState(input: NewStateInput): WatchState {
  return {
    watchId: input.watchId,
    watchRunId: input.watchRunId ?? newRunId(),
    generation: input.generation ?? 1,
    status: "active",
    ownerPid: input.ownerPid ?? process.pid,
    leaseExpiresAt: input.leaseExpiresAt ?? input.now + LEASE_MS,
    settledBeats: 0,
    cursor: "",
    cooldownUntil: {},
    remindCount: 0,
    remindHistory: [],
    escalationCount: 0,
    settledIncidents: [],
    llmCalls: 0,
    startedAt: input.now,
    budgetMs: input.budgetMs,
    warningSent: false,
    warningTrigger: null,
    paused: false,
    pauseTrigger: null,
    contract: input.contract ?? null,
    eventsDegraded: false,
    targetKind: input.targetKind,
    channelKind: input.channelKind,
    handle: input.handle,
    sessionFile: input.sessionFile,
    lastAction: null,
  };
}

export class StateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(watchId: string): string {
    return join(this.dir, `${watchId}.json`);
  }

  private lockFileFor(watchId: string): string {
    return join(this.dir, `${watchId}.lock`);
  }

  /**
   * 读取状态（W5 错误区分）：ENOENT（无状态文件）= missing（合法首次运行）；
   * EBUSY/EPERM 瞬态重试耗尽或其他读错误 = error（调用方中止启动，不得当作
   * 无状态 fresh 启动）；损坏/字段非法 = missing（既有语义：从头开始）。
   */
  async load(watchId: string): Promise<LoadResult> {
    let text: string;
    try {
      // EBUSY/EPERM（他进程正在写/rename 本文件）→ 瞬态重试，重试耗尽原样抛出
      text = readFileSyncRetry(this.fileFor(watchId));
    } catch (err) {
      if (isTransientIoError(err)) {
        // 瞬态重试耗尽仍不可读 ≠ 无状态文件——真错误，与 missing 区分
        return { kind: "error", reason: `状态文件瞬态重试耗尽仍不可读（${(err as NodeJS.ErrnoException).code}）` };
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "missing" }; // 无状态文件 = 首次运行
      }
      return { kind: "error", reason: `状态文件读取失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      const parsed = JSON.parse(text) as Partial<WatchState>;
      const state = normalizeState(parsed, watchId);
      if (state === null) return { kind: "missing" }; // 损坏/字段非法 → 从头开始（调用方会记录事件）
      return { kind: "ok", state };
    } catch {
      return { kind: "missing" }; // 损坏状态 → 从头开始（调用方会记录事件）
    }
  }

  /**
   * 原子落盘：写 .tmp 再 rename 覆盖。崩溃时最多丢一拍，不会出现半写状态。
   * EPERM/EBUSY（Windows 上他进程读占用导致 rename 冲突）→ 瞬态重试，重试耗尽才抛。
   */
  async save(watchId: string, state: WatchState): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.fileFor(watchId) + ".tmp";
    const target = this.fileFor(watchId);
    await withTransientRetry(() => {
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
      renameSync(tmp, target);
    });
  }

  /**
   * V1.2 单例选举（leader election，替代 V1.1 link/rename 方案）：<watchId>.lock
   * 为 append-only 租约账本——逐行 JSON 由 appendFileSync O_APPEND 追加（小写入
   * 本地文件原子），永不删除/改名（无删除竞争，不存在回收 TOCTOU）。
   * - 追加自己的 claim 行 → 重读账本求值：文件序第一条存活 claim 为胜者
   *   （存活 = 未 release 且租约未过期且属主进程存活）——所有读者对同一账本
   *   求值结果一致，确定性恰一 acquired；
   * - 胜者是自己 → finishClaim（fresh/resume 由状态裁决 decideStart 决定；
   *   状态显示活属主的不一致世界 → 追加 release 撤销自建 claim 并拒绝）；
   * - 胜者非己 → 追加 release 撤销自建 claim 后 denied（exit 3 语义不变；
   *   ghost 防回归：denied 的 claim 若留在账本，会在现任胜者死后凭文件序继位
   *   或阻塞后续 claimer——release 只杀死自己的 runId，永远安全）。
   */
  async claimLock(watchId: string, opts: { prev: WatchState | null; watchRunId: string; now: number }): Promise<LockClaim> {
    const mine: LockInfo = {
      watchRunId: opts.watchRunId,
      ownerPid: process.pid,
      leaseExpiresAt: opts.now + LEASE_MS,
    };
    if (!this.appendLedgerLine(watchId, {
      op: "claim",
      runId: opts.watchRunId,
      ownerPid: process.pid,
      leaseExpiresAt: mine.leaseExpiresAt,
      ts: opts.now,
    })) {
      return { kind: "denied", reason: "单例账本写入失败，拒绝启动" };
    }
    // 重读账本求值（撕裂尾行 → 退避重读；追加者必见自己完整的 claim 行）
    const winner = await this.readWinner(watchId, opts.now);
    if (winner === null) {
      // 撤销自建 claim（防 ghost）：无存活胜者 = 自己的 claim 未生效/账本异常，
      // release 只杀死自己的 runId，永远安全
      this.releaseLock(watchId, mine);
      return { kind: "denied", reason: "单例账本不可读或无存活 claim，拒绝启动" };
    }
    if (winner.runId !== opts.watchRunId) {
      // 胜者非己 → denied 前撤销自建 claim（T1 ghost claim 防回归）：否则本进程
      // 仍存活时其 claim 会在现任胜者死后凭文件序"继位"（ghost），并阻塞后续 claimer
      this.releaseLock(watchId, mine);
      return {
        kind: "denied",
        reason: "已有监督者正在运行（同 handle 存在未过期租约且属主进程存活），拒绝重复启动",
      };
    }
    return this.finishClaim(watchId, mine, opts);
  }

  /** claim 后的裁决收尾：denied → 追加 release 撤销自建 claim；acquired → 返回。 */
  private finishClaim(watchId: string, mine: LockInfo, opts: { prev: WatchState | null; now: number }): LockClaim {
    const start = decideStart(opts.prev, opts.now);
    if (start.kind === "denied") {
      this.releaseLock(watchId, mine);
      return { kind: "denied", reason: start.reason };
    }
    return { kind: "acquired", start };
  }

  /** 追加一行账本（O_APPEND 原子小写入；目录缺失先建；EBUSY/EPERM——他进程
   *  正在读账本时追加会撞写锁——走 shared/fs.ts 瞬态重试，重试耗尽 → false）。 */
  private appendLedgerLine(watchId: string, line: LedgerLine): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSyncRetry(this.lockFileFor(watchId), JSON.stringify(line) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取账本（逐行解析，坏行跳过容忍）。torn=true = 末行不完整（他人追加进行中），
   * 该半行不求值——由追加者自身重读确认，或本次读取后下次再读自然消失。
   * busy=true = EBUSY/EPERM 瞬态重试耗尽仍不可读（Windows 读撞上并发追加写锁）——
   * 调用方与 torn 同等视为瞬态：退避重读，重试耗尽才视为真错误。
   */
  readLedger(watchId: string): { lines: LedgerLine[]; torn: boolean; busy: boolean } {
    let text: string;
    try {
      text = readFileSyncRetry(this.lockFileFor(watchId));
    } catch (err) {
      if (isTransientIoError(err)) return { lines: [], torn: false, busy: true };
      return { lines: [], torn: false, busy: false }; // ENOENT（账本未建）= 合法空；其余同既有容错
    }
    const torn = text.length > 0 && !text.endsWith("\n");
    const parts = text.split("\n");
    if (torn) parts.pop(); // 末行不完整：他人写入进行中的半行，跳过
    const lines: LedgerLine[] = [];
    for (const part of parts) {
      if (part.trim() === "") continue;
      const line = parseLedgerLine(part);
      if (line !== null) lines.push(line);
    }
    return { lines, torn, busy: false };
  }

  /**
   * 重读账本求值胜者：撕裂尾行（并发 claim 追加进行中）或 EBUSY/EPERM 瞬态
   * 不可读 → 短退避重读，防撕裂读——若忽略他人半行直接求值，可能把
   * "他人先行 claim"当不存在而双双当选。重试耗尽才按末次读取求值。
   */
  private async readWinner(watchId: string, now: number): Promise<LeaseWinner | null> {
    for (let attempt = 0; attempt < TRANSIENT_IO_ATTEMPTS; attempt++) {
      const ledger = this.readLedger(watchId);
      if (!ledger.torn && !ledger.busy) return this.evaluateLedger(ledger.lines, now);
      await sleep(LEDGER_SETTLE_MS);
    }
    return this.evaluateLedger(this.readLedger(watchId).lines, now);
  }

  /** 当前胜者（now 时刻求值）；无存活 claim → null。供收尾/测试内省。 */
  leaseWinner(watchId: string, now: number): LeaseWinner | null {
    const ledger = this.readLedger(watchId);
    if (ledger.busy) return null; // 瞬态重试耗尽仍忙 → 视为无胜者（调用方按瞬态裁决）
    return this.evaluateLedger(ledger.lines, now);
  }

  /**
   * 选举求值（确定性：所有读者对同一账本得到同一胜者）：
   * - 按文件序处理，每行自带 ts 作时钟（旧格式 renew 无 ts 视为 0，不触发断链判定）；
   * - 断链永久死亡（F2 防僵尸复活）：某 runId 遇到任一行（claim/renew）时，若该行
   *   ts 晚于其当前 leaseExpiresAt（即该行写入时租约已过期）→ 该 runId 中途断链，
   *   永久死亡，其后一切行忽略——旧 owner 租约过期被新 claim 接管后，复活追加的
   *   renew 不得凭更前的文件序赢回锁；release 同样永久死亡；
   * - renew 仅在其 runId 存活时延展租约；孤儿 renew（无 claim/已死）忽略；
   * - 新 claim 不受旧 runId 影响；claim 存活 = 未死且 leaseExpiresAt > now 且 ownerPid 存活；
   * - 胜者 = 文件序第一条存活 claim；无 → null。
   * 时钟偏斜说明：断链判定依赖各行自身 ts，时钟偏斜可令判定提前/推迟，但相对
   * 20min 租约可忽略（正常续租间隔 ≤60s，余量 ~19min；偏斜超 19min 才可能误判）。
   * 账本体积：每拍一行 renew，2h 约百行；V1 不做 compaction——删除/改写账本会
   * 重新引入竞争窗口，与 append-only 原则相悖（体积有界后可另议 archive）。
   */
  evaluateLedger(lines: LedgerLine[], now: number): LeaseWinner | null {
    const dead = new Set<string>(); // release 或断链 → 永久死亡
    const leases = new Map<string, { ownerPid: number; leaseExpiresAt: number }>();
    const firstClaimIndex = new Map<string, number>();
    let index = 0;
    for (const line of lines) {
      if (dead.has(line.runId)) {
        index++;
        continue; // 已死 → 其后 renew 一律忽略（不复活）
      }
      if (line.op === "release") {
        dead.add(line.runId);
        leases.delete(line.runId);
        index++;
        continue;
      }
      const cur = leases.get(line.runId);
      // 断链检查（claim/renew 均适用；首条 claim 无先例租约不检查）
      if (cur !== undefined && line.ts > cur.leaseExpiresAt) {
        dead.add(line.runId);
        leases.delete(line.runId);
        index++;
        continue;
      }
      if (line.op === "claim") {
        if (!firstClaimIndex.has(line.runId)) firstClaimIndex.set(line.runId, index);
        leases.set(line.runId, { ownerPid: line.ownerPid, leaseExpiresAt: line.leaseExpiresAt });
      } else {
        // renew：存活才延展租约；孤儿 renew（无 claim）忽略
        if (cur !== undefined) cur.leaseExpiresAt = line.leaseExpiresAt;
      }
      index++;
    }
    const order = [...firstClaimIndex.entries()].sort((a, b) => a[1] - b[1]);
    for (const [runId] of order) {
      const lease = leases.get(runId);
      if (lease === undefined) continue;
      if (lease.leaseExpiresAt > now && pidAlive(lease.ownerPid)) {
        return { runId, ownerPid: lease.ownerPid, leaseExpiresAt: lease.leaseExpiresAt };
      }
    }
    return null;
  }

  /**
   * 每拍续租：求值当前胜者——仍归本运行 → 追加 renew 行延长租约（renew 只延长
   * 自己的租约，追加后胜者不变，无需重读）；已非胜者（他人 claim 文件序更前/
   * 租约过期/属主判定死亡/自身断链）→ 丢锁返回 false（调用方走异常收尾 lockLost）。
   * 行自带 ts（写入时刻）：断链判定（F2）以 ts 为时钟——健康续租 ts 恒在租约内。
   * 保守语义（EBUSY 硬化，W2）：账本瞬态不可读（busy=读撞上并发追加写锁且
   * 瞬态重试已耗尽）或 renew 追加失败（含瞬态重试耗尽）→ 一律返回 false 走丢锁
   * 处理（停写状态、lockLost）：瞬时竞争下的误停可恢复（下次重启 fresh/resume），
   * fencing 破坏（丢锁进程继续写 state 覆盖新 owner）不可恢复——宁可误停不可破栅栏。
   */
  renewLock(watchId: string, mine: LockInfo, now: number): boolean {
    const ledger = this.readLedger(watchId);
    if (ledger.busy) return false; // 瞬态重试耗尽仍不可读 → 无法验证归属，保守丢锁
    const winner = this.evaluateLedger(ledger.lines, now);
    if (winner === null || winner.runId !== mine.watchRunId) return false;
    // renew 追加失败（瞬态重试耗尽）→ 租约未实际延长，保守丢锁：不得忽略写失败
    // 当"已续租"继续写 state（否则租约过期后本进程仍覆盖新 owner 的 state）
    if (!this.appendLedgerLine(watchId, {
      op: "renew",
      runId: mine.watchRunId,
      leaseExpiresAt: mine.leaseExpiresAt,
      ts: now,
    })) {
      return false;
    }
    return true;
  }

  /**
   * 正常收尾/撤销自建 claim：追加 release 行——该 runId 永久死亡。账本永不
   * 删除/改名（无删除竞争）；旧 owner 的迟到 release 只杀死自己的 runId，
   * 无害于新胜者。写入走瞬态重试；仍失败（重试耗尽）→ stderr 警告：会留
   * ghost claim（本进程存活期间可能阻塞后续 claimer/在胜者死后凭文件序继位），
   * 但进程退出后属主 pid 死亡，ghost claim 的"属主存活"条件即失效，最终随
   * 租约过期自然消失——pid 死亡兜底，不阻塞收尾。
   */
  releaseLock(watchId: string, mine: LockInfo): void {
    if (!this.appendLedgerLine(watchId, { op: "release", runId: mine.watchRunId })) {
      console.error(
        `[guardian] 租约账本 release 行写入失败（watch ${watchId}），存在 ghost claim 风险；` +
          `本进程退出后属主 pid 死亡，该 claim 随租约过期自然失效`,
      );
    }
  }

  /** 按 mtime 倒序列出 watchId（最新在前）。 */
  list(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const ids: Array<{ id: string; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        ids.push({ id, mtime: statSync(join(this.dir, name)).mtimeMs });
      } catch {
        // 文件消失则跳过
      }
    }
    ids.sort((a, b) => b.mtime - a.mtime);
    return ids.map((e) => e.id);
  }
}

/** 读取可能含旧字段名的未知形状字段（V1 状态兼容）。 */
function legacyField(parsed: Partial<WatchState>, key: string): unknown {
  return (parsed as Record<string, unknown>)[key];
}

/**
 * 对加载的状态做字段级防御：缺字段补默认、类型错误置默认。
 * 旧版本状态文件（无 watchRunId 等新字段）→ 按 legacy 处理：
 * watchRunId="legacy"、status=finished——启动裁决视其为新任务，
 * 不继承无可验证属主/租约的旧计数（安全侧）。
 */
function normalizeState(parsed: Partial<WatchState>, watchId: string): WatchState | null {  if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return null;
  const budgetMs = typeof parsed.budgetMs === "number" && Number.isFinite(parsed.budgetMs) ? parsed.budgetMs : 0;
  const legacy = typeof parsed.watchRunId !== "string" || parsed.watchRunId === "";
  return {
    watchId: typeof parsed.watchId === "string" ? parsed.watchId : watchId,
    watchRunId: legacy ? "legacy" : parsed.watchRunId!,
    generation: typeof parsed.generation === "number" && Number.isFinite(parsed.generation) ? parsed.generation : 0,
    status: legacy ? "finished" : parsed.status === "finished" ? "finished" : "active",
    ownerPid: typeof parsed.ownerPid === "number" && Number.isFinite(parsed.ownerPid) ? parsed.ownerPid : 0,
    leaseExpiresAt: typeof parsed.leaseExpiresAt === "number" && Number.isFinite(parsed.leaseExpiresAt) ? parsed.leaseExpiresAt : 0,
    settledBeats: typeof parsed.settledBeats === "number" ? parsed.settledBeats : 0,
    cursor: typeof parsed.cursor === "string" ? parsed.cursor : "",
    cooldownUntil: typeof parsed.cooldownUntil === "object" && parsed.cooldownUntil !== null
      ? (parsed.cooldownUntil as Record<string, number>)
      : {},
    remindCount: typeof parsed.remindCount === "number" ? parsed.remindCount : 0,
    remindHistory: Array.isArray(parsed.remindHistory) ? parsed.remindHistory : [],
    escalationCount: typeof parsed.escalationCount === "number" ? parsed.escalationCount : 0,
    settledIncidents: Array.isArray(parsed.settledIncidents)
      ? parsed.settledIncidents.filter((s): s is string => typeof s === "string")
      : [],
    llmCalls: typeof parsed.llmCalls === "number" ? parsed.llmCalls : 0,
    startedAt: parsed.startedAt,
    budgetMs,
    // V2a：新字段 warningSent/warningTrigger 取代旧 safetyWarningSent/safetyWarningTrigger；
    // 旧字段名（V1 状态崩溃恢复）映射继承，不丢闩锁。
    warningSent: parsed.warningSent === true || legacyField(parsed, "safetyWarningSent") === true,
    warningTrigger: typeof parsed.warningTrigger === "string"
      ? parsed.warningTrigger
      : typeof legacyField(parsed, "safetyWarningTrigger") === "string"
        ? (legacyField(parsed, "safetyWarningTrigger") as string)
        : null,
    paused: parsed.paused === true,
    pauseTrigger: typeof parsed.pauseTrigger === "string" ? parsed.pauseTrigger : null,
    contract: isTaskContract(parsed.contract) ? parsed.contract : null,
    eventsDegraded: parsed.eventsDegraded === true,
    targetKind: typeof parsed.targetKind === "string" ? parsed.targetKind : "pi",
    channelKind: parsed.channelKind === "orca" ? "orca" : "file",
    handle: typeof parsed.handle === "string" ? parsed.handle : "",
    sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : null,
    lastAction: typeof parsed.lastAction === "string" ? parsed.lastAction : null,
  };
}
