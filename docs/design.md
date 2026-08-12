# agent-guardian — 设计规格（V1）

> 定位：通用跨 CLI 运行期监督与讨论组编排。**LLM 只出现在判断点，循环/状态/执行全部机械化**。
> 来源：supervisor-governor-handoff.md 的教训 + agent-supervisor/agent-panel skill 首次真实演练暴露的半成品病灶（协议写在 prompt 里）。
> 本包是 pi-task-governor 的演进上级：信号引擎 V1.1 起随包内置（src/shared/），本包拥有通道/目标适配器/watcher/panel/状态机，无外部依赖。

## 0. 三条不可让渡的设计原则

> **与移交文档约束的新拓扑再裁决（用户已批准，验收不得重审）**：handoff 的"轨迹诊断不进模型上下文/L3 不存在"针对的是同进程影子监督者。跨 CLI 拓扑下用户明确批准：①steer 提醒可直接进被观察者终端，但内容**只含机械事实+行动指令**（"连续 21 次未保存，检查是否卡住"），禁止对 Agent 的评价性诊断；②机械红线（提醒复现/持续打转/预算超限）允许安全网 stop——执行权属机械内核；③file 通道用 fs.watch 为主 + 慢速兜底（30s），standalone watcher 进程的文件监听不属于 handoff 禁止的"agent 循环内轮询"。④goal-snapshot/freshness 观测接缝归 pi-task-governor 包所有，本包不消费（V1 范围外）。

1. **完全通用**：被观察 CLI、监督 LLM、宿主环境全部可替换。任何 pi 专属假设必须隔离在适配器内。
2. **机械内核拥有循环与执行权**：节拍、游标、状态机、冷却/预算、事件落盘、steer/暂停/停止执行——全部是确定性代码。LLM 只在被回调时产出"决定"，不碰循环与状态。
3. **sufficiency 死刑与噪声纪律**：任何"目标已充分"断言禁止出库；默认沉默、同问题提醒 1 次+冷却、轻提醒上限、预算耗尽即只剩安全网。

## 1. 包结构

```
agent-guardian/
├── package.json            # name agent-guardian, bin: guardian → scripts/guardian.ts
├── tsconfig.json           # 同 pi-task-governor 编译选项
├── README.md
├── docs/design.md          # 本文档
├── scripts/guardian.ts     # CLI 入口：watch / panel / events / report
├── src/
│   ├── orca.ts             # orca CLI 薄封装（execFile + --json，可注入替身）
│   ├── channels/
│   │   ├── types.ts        # Channel 接口
│   │   ├── orca.ts         # 全能力：wait/read/send/stop/list
│   │   └── file.ts         # 纯观察：tail 会话文件 + 写报告（无 Orca 也能用、单测零依赖）
│   ├── targets/
│   │   ├── types.ts        # TargetAdapter 接口：resolveFacts() → BeatFacts
│   │   ├── pi.ts           # pi 会话 JSONL（包内复用 src/shared/ extract+signals）
│   │   ├── codex.ts        # codex rollout JSONL → ToolCallFact（新解析器）
│   │   └── terminal.ts     # 兜底：仅活性+游标（无会话文件场景）
│   ├── watcher/
│   │   ├── loop.ts         # 节拍循环（wait/cursor/sleep/生命周期）
│   │   ├── state.ts        # 状态机：冷却/预算/提醒计数/升级计数，JSON 落盘可恢复
│   │   ├── decide.ts       # 机械决策树 + LLM 回调触发条件
│   │   └── llm.ts          # LLM 回调契约（可插拔命令；默认关闭=纯机械）
│   ├── panel/
│   │   └── runner.ts       # fan-out/收齐/综合/解散，两种后端
│   └── shared/             # 信号引擎+提取单源（V1.1 迁入，随包内置；pi-task-governor 反向相对导入）
├── test/                   # node --test，全部经 file channel + 注入替身，零 Orca 依赖
└── docs/acceptance-<date>.md
```

零运行时依赖；Node ≥23（type-stripping）；独立检出即可运行，无需任何同级项目（V1.1：引擎正主已迁入本包）。

## 2. 核心抽象

```ts
// 通道：监督者如何"看"和"摸"被观察者
export interface Channel {
  waitIdle(handle: string, timeoutMs: number): Promise<"idle" | "timeout" | "stale">;
  read(handle: string): Promise<{ text: string; cursor: string; alive: boolean }>;
  send(handle: string, text: string): Promise<void>;          // steer（file 通道抛 unsupported）
  stop(handle: string): Promise<void>;                        // file 通道抛 unsupported
}

// 目标适配器：从被观察者提取机械事实
export interface BeatFacts {
  toolCallsSeen: number;              // 累计（无法统计时 -1）
  newToolCalls: number;               // 本拍新增
  signals: Signal[];                  // 复用信号引擎
  tailSummary: string;                // 给 LLM 证据包用的尾部摘要（截断）
}
export interface TargetAdapter {
  kind: "pi" | "codex" | "terminal";
  resolveFacts(cursor: string | null): Promise<{ facts: BeatFacts; cursor: string }>;
}

// LLM 回调契约：证据包 → 决定（watcher 校验 schema，非法 = silence + 记录）
export interface EvidencePack { facts: BeatFacts; state: PublicState; taskSummary: string; recentEvents: unknown[]; }
export type Decision =
  | { action: "silence" }
  | { action: "remind"; message: string; reason: string }
  | { action: "pause"; message: string; reason: string }
  | { action: "panel"; question: string; reason: string }
  | { action: "stop"; reason: string };   // 仅机械红线升级时允许，LLM 直接返回 stop 无效（防 LLM 重手）
```

LLM 回调命令可配置（`--llm "<cmd>"`）：watcher 把 evidence.json 路径作为参数传给命令，读其 stdout 的 decision JSON。默认**关闭**（纯机械模式：机械信号→机械动作，无任何 LLM 调用）。

## 3. watcher 行为规格

### 挂接形态（一句话触发，用户裁决的最理想 UX）

用户在主会话里说一句话（如“挂个监督者”/“用 codex+5.6 看着我”）→ 主 Agent 读自己的 `ORCA_TERMINAL_HANDLE` 环境变量，执行：

```bash
orca terminal split --terminal $ORCA_TERMINAL_HANDLE --direction vertical \
  --command "node C:/PiWorkbench/packages/agent-guardian/scripts/guardian.ts watch --terminal $ORCA_TERMINAL_HANDLE [--llm ...]"
```

监督者与主 Agent **同 tab 分屏**（UI 天然在一起）；用户零 ID 感知。CLI/模型由用户那句话指定（映射为 `--llm` 回调命令或 panel 成员命令）。

### 节拍
1. `waitIdle(handle, 600s)`；file 通道轮询间隔 5s（文件 mtime 比较，非 busy-loop）。
2. 每拍 `read()` 拿游标；**游标不前进 → sleep 60s 进下一拍，不取证**（实测教训）。
3. 游标前进 → `resolveFacts()` 取证。

### 机械决策树（decide.ts，纯函数可单测）
1. 无信号 → 沉默。
2. 有信号且非冷却/非重复 → **机械提醒**（steer 模板含具体证据：信号 kind+关键 facts），计数+冷却 3 拍。轻提醒上限 5 次。
3. 同一信号提醒后复现（升级计数 ≥2）→ **LLM 回调点**（若配置）：发证据包，执行返回的合法决定（remind/pause/panel）；未配置 → 进入安全网判定。
4. 机械红线（提醒复现 ≥2 且无 LLM / 持续打转无改善 / wall-clock 超预算）→ 安全网：steer 最后警告 → 无改善 → `stop()`。LLM 返回的 stop 一律降级为 pause 并记录（执行权在内核）。
5. 方向流程（LLM 返回 panel）→ pause steer → `panel run` → 把结论 steer 复工 → 事件落盘。

### 状态机（state.ts）
`{settledBeats, cursor, cooldownUntil: Record<kind,beat>, remindCount, remindHistory: [{kind,beat,factsHash}], escalationCount, llmCalls, startedAt, budget}`，每拍原子落盘（tmp+rename），崩溃恢复续跑。

### 生命周期（Orca 实测语义，2026-08-11 实测）

Orca 的 PTY 生命周期与 UI tab 生命周期是分离的：关 pane（不带 --tab）只灭 pane；关 tab（--tab）只把终端 detach（`connected:false, writable:false, paneRuntimeId:-1`），**PTY 仍活**；再次 close 才 `ptyKilled:true`。因此：

- 每拍 `terminal show` 检查：`connected:false` → **主对话框已被用户关闭** → 写完工汇报 → 退出 0。
- `waitIdle`/`read` 连续 2 次 stale/not-found → PTY 真死 → 同路径退出。
- wall-clock 超预算（默认 2h 可配）→ 同上。
- 收到 SIGINT → 落盘退出 130。

## 4. panel 行为规格

`guardian panel "<问题>" --n 3 --backend orca|headless --materials <paths...> --out <dir>`

1. 生成成员 spec（问题+材料+独立产出要求+候选集格式，模板内嵌）。
2. fan-out：`orca` 后端 = `worker-start` ×N（用户可见）；`headless` 后端 = 并行 `pi -p`（或 `--member-cmd` 自定义）×N。
3. 收齐全部 member-i.md（超时 30min/成员，失败成员记 failed 不阻塞其余）。
4. 综合：默认由一条可配置命令（同 LLM 回调契约变体）产出 panel-result.md（候选集/共识/分歧/推荐+理由/少数派）；`--no-synthesize` 时只做归并索引。
5. 解散：worker-release ×N（orca 后端）。全程事件落盘。

## 5. CLI

```
guardian watch --terminal <handle> [--session <file>] [--llm "<cmd>"] [--budget-min 120] [--remind-max 5]
guardian watch --file <session.jsonl>        # file 通道，纯观察+报告
guardian panel "<问题>" [--n 3] [--backend orca|headless] [--out <dir>]
guardian events [--watch <id>]               # 查看事件流
guardian report --watch <id>                 # 输出/重生成完工汇报
```

## 6. 与既有资产的关系

- 信号引擎/提取：正主在 `src/shared/{signals,extract,contract}.ts`（V1.1 从 pi-task-governor 迁入，禁止复制）；pi-task-governor 的 src/signals.ts / src/extract.ts 变为 re-export 垫片，运行时路径（governor.ts、scripts/observe-session.ts）直接反向相对导入本包。
- agent-supervisor SKILL.md 瘦身为"如何启动 guardian watch + LLM 被回调时的行为说明"；agent-panel SKILL.md 瘦身为"panel 成员行为说明 + guardian panel 调用"。
- pi-task-governor 扩展继续其进程内影子角色，不变。

## 7. 测试要求

全部单测经 file 通道 + 注入替身（orca exec stub、假 LLM 命令），零 Orca/网络依赖：
- 状态机：冷却/预算/提醒上限/升级计数/崩溃恢复。
- decide 决策树全分支（含 LLM 非法输出→silence、LLM stop→降级 pause）。
- 游标纪律：不前进不取证。
- pi/codex 适配器 fixture（codex rollout 用真实样本片段）。
- panel：聚合/超时/失败成员/解散调用序列（stub orca）。
- CLI 参数解析与退出码。

## 8. 明确不做（V1）

自动挂接新终端（automations 集成）；web UI；跨机 supervisor（--on 远端）；codex 目标的 steer 以外深度集成；多 watcher 协调。留接口不实现。

## 9. V2 方向（Sidecar Supervisor 语义层——用户多窗口语料已对齐，2026-08-12）

语料来源：09-00 窗口（归属裁决）、13-51 窗口（完整架构 + 硬软分权 + V1 批判）。本节的每条修订都已获用户立场确认，是 V2 实现基线。

### 9.1 归属
agent-guardian 定位从"pi 系工具"修正为 **Orca sidecar controller**：跨 Agent 的终端编排与生命周期功能归 Orca 侧；pi/codex 各 CLI 只做适配器；pi-task-governor 仅贡献纯信号算法（V1.1 已迁正主入本包）。Skill 只负责一句话启动，不承担循环逻辑。

### 9.2 干预语义重排（V1 行为级变更，用户语料原文依据）

| V1 行为 | V2 行为 | 依据 |
|---|---|---|
| 打转无改善/提醒复现 → 自动 stop | WARNING 须 ACK；无 ACK 升级用户；**pause（可逆）代替 stop** | "检测到 spin → 触发 Supervisor 分析 ≠ spin 本身就是停止依据" |
| 预算到期 → 警告→stop 主 Agent | guardian 汇报并**自己退出**，不动主 Agent | "监督预算到期 → Guardian 汇报并退出 ≠ 主 Agent必须被停止" |
| 机械信号 → 提醒/升级 | 信号只触发 Supervisor 分析（L1 Advise / L2 Acknowledge） | 代理指标可提醒，无资格终止 |
| stop 宽泛 | **L4 仅限客观硬边界**：破坏性命令、凭据泄露、超费用上限、覆盖用户未提交修改 | 硬化四条件：客观可观测/误报已验证/动作与证据成比例/可逆 |

五级干预梯度：L0 Observe / L1 Advise / L2 Acknowledge / L3 Human Gate / L4 Mechanical Block。升级依据=新证据/风险变化/主 Agent 确认/不可逆性，**不是计数器**。

### 9.3 V2 交付项（按序）
1. 任务契约 `contract.json`（原始需求/验收标准/范围边界/已批准决策），watch 时 `--contract` 挂载，不可变。
2. `guardian-judge` profile：固定 supervisor system prompt、只读工具、证据视为不可信数据、强制 JSON schema——让 LLM 层真正工作（V1 的裸 --llm 回调是断的）。
3. 结构化事件传感：git diff 快照、测试结果、工具事件（替代纯终端文本）；milestone_ready 时主 Agent 提供 diff+测试+未决问题。
4. incident 生命周期 FSM：open→delivered→ACK（accepted/rejected-with-reason/deferred）→resolved；机械内核持有 mailbox 与送达确认。
5. 分级消息：NOTE 进队列不阻断 / WARNING 须 ACK（可完成当前原子操作）/ BLOCK 暂停门（仅限破坏性/凭据/越权/验收失效）。
6. 完工后 fresh-context reviewer 独立验收（原始需求+最终 diff+验收标准+测试证据），长期 Supervisor 不得兼任终验。
7. Panel 降级为方向争议辅助件：异步（watch 不停）、带证据材料、只读成员。

### 9.4 不共享原则
Supervisor 共享事实与决策（需求/验收标准/diff/测试输出/主 Agent 声明的阶段），**不继承主 Agent 的推理过程与自我辩护**——防锚定附和。同 checkout 只读，不开独立 worktree。
