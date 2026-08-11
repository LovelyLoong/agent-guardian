# agent-guardian

跨 CLI 运行期监督与讨论组编排。在另一个终端会话旁边挂一个监督者：它按固定节奏观察目标（pi / codex / 普通终端），发现原地重复、进展停滞、连续失败、上下文压力时按规则提醒；多次提醒无效时进入安全网（最后警告 → 停止）。需要判断时，可以把证据交给外部模型决定，或拉起一个讨论组收集多个独立意见。

**零运行时依赖**：不安装任何第三方包，直接 `node scripts/guardian.ts` 运行（Node ≥22.18，推荐 24；type-stripping 免编译）。

## 一、挂一个监督者（最常见用法）

在主会话里说一句话（例如"挂个监督者，用 codex 看着我"），主 Agent 读到自己的终端句柄后执行：

```bash
orca terminal split --terminal $ORCA_TERMINAL_HANDLE --direction vertical \
  --command "node C:/PiWorkbench/packages/agent-guardian/scripts/guardian.ts watch --terminal $ORCA_TERMINAL_HANDLE [--llm ...]"
```

监督者与主 Agent 同屏分栏，用户零操作。没有会话文件时是纯活性监控；加上 `--session` 则同时解析 pi/codex 会话记录（按内容自动识别）。

## 二、命令

### watch

```bash
guardian watch --terminal <句柄> [--session <会话文件>] [--llm "<命令>"] [--budget-min 120] [--remind-max 5] [--llm-max-calls 3]
guardian watch --file <会话文件>
```

- `--terminal`：监督 Orca 里的一个终端（完整能力：提醒、暂停、停止）。
- `--file`：纯观察模式——tail 一个会话文件（pi/codex 的 .jsonl），只写记录与汇报，不向任何终端发消息。没有 Orca 也能用。
- `--session`：配合 `--terminal` 给出会话文件，按内容自动识别 pi 或 codex 会话。
- `--llm "<命令>"`：启用外部判断。有信号反复出现时，监督者把证据包（JSON 文件路径）作为最后一个参数传给该命令，读取其标准输出中的决定。命令的输出必须是 JSON：`{"action":"silence"}`、`{"action":"remind","message":"..."}`、`{"action":"pause","message":"..."}` 或 `{"action":"panel","question":"..."}`。输出不合法 → 本次按沉默处理并记录；输出 `stop` → 一律降级为暂停（停止权在监督者内核）。不传 `--llm` 则全程机械判断。LLM 咨询与同种信号的提醒共用冷却窗口，并受全局上限约束（见 `--llm-max-calls`）。
- `--budget-min`：监督时长预算，默认 120 分钟。到期走安全网（警告 → 停止）后写汇报退出。
- `--remind-max`：轻提醒上限，默认 5 次，超过进入安全网。
- `--llm-max-calls`：每次监督的 LLM 回调全局上限，默认 3 次，超过后回到机械安全网路径（不再咨询）。

### panel

```bash
guardian panel "<问题>" [--n 3] [--backend orca|headless] [--out <目录>] [--materials <路径>...]
                 [--agent <名称>] [--member-cmd "<命令>"] [--synthesize-cmd "<命令>"] [--no-synthesize]
```

1. 生成成员任务说明（问题 + 材料节选 + 独立作答要求 + 候选方案格式）。
2. 同时派出 n 名成员独立作答（orca 后端用 Orca 的 worker 机制，用户可见；headless 后端并行执行 `pi -p` 或 `--member-cmd` 自定义命令）。
3. 收齐 `member-<i>.md`（每名成员最多等 30 分钟，超时记失败、不阻塞其余）。
4. 综合为 `panel-result.md`（候选方案、共识、分歧、推荐与理由、少数派意见）；`--no-synthesize` 只写归并索引。
5. 释放成员（orca 后端）。

- `--synthesize-cmd "<命令>"`：自定义综合命令，监督者把产出目录作为最后一个参数传入，命令负责写 `panel-result.md`。默认用 `pi -p` + 内置综合提示词。

### events / report

```bash
guardian events [--watch <id>]        # 查看事件流（不指定则列出全部）
guardian report --watch <id>          # 输出/重新生成完工汇报
```

## 三、数据目录

`~/.agent-guardian/`（`AGENT_GUARDIAN_HOME` 可覆盖）：

- `state/` 监督状态（每次节拍原子落盘，崩溃后从最近一拍恢复）
- `events/` 事件记录（只追加）
- `reports/` 完工汇报
- `panels/` 讨论组产出
- `tmp/` 外部判断用的证据包

## 四、行为边界

- **默认沉默**：只在机械信号触发时发声；同一问题提醒后冷却 3 拍，轻提醒有上限。
- **停止是最后手段**：安全网先发最后警告，下一拍仍无改善才停止；纯观察模式（`--file`）不发送任何消息，安全网只记录。
- **LLM 只出现在判断点**：节拍、游标、状态、冷却、预算、落盘、执行全部是确定性代码。
- 需要与 pi-task-governor 同级检出（`C:\PiWorkbench\packages\` 下两者并列），信号与提取逻辑单源复用，不复制。

## 五、注意事项

- 数据目录里的一切都是本机文件，不会上传；记录文件是纯文本，可随时删除。
- 监督终止不删除任何会话数据；讨论组只写产出目录。
- 详细设计见 `docs/design.md`。
