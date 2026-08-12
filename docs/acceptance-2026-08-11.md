# 验收记录：agent-guardian V1

- 日期：2026-08-11
- 验收范围：全包（scripts/guardian.ts、src/{orca,channels,targets,watcher,panel,events,home}.ts、test/、README、docs/design.md）
- 验收基线：docs/design.md（含 §0"新拓扑再裁决"）；更高权重约束来源 supervisor-governor-handoff.md

## 结论：ACCEPTED（0 blocker / 0 major / 1 minor 已随手修复）

## 编排与证据

调度/设计：company/moonshotai/kimi-k3（本会话，含全部裁决）。
实现：company/deepseek/deepseek-v4-flash:max（worker，fresh context，共 9 轮含 2 次超时续派）。
独立验收：openai-codex/gpt-5.6-luna:max（reviewer，每轮 fresh context，共 9 轮）+ 早期 1 轮 company/anthropic/claude-fable-5:max（超时未完成，由 Luna 接替）。

| 轮次 | 测试 | 结论 | 主要内容 |
|---|---|---|---|
| 实现 1 | 85 | — | 骨架+首次测试（11 失败+整体挂起） |
| 修复 2 | 85 ✓ | — | 测试/实现混合修复（含 panel 死循环） |
| 验收 1 | — | NOT_ACCEPTED | 3B/7M/3m（connected 语义、LLM fail-safe、决策上限等） |
| 修复+验收 2 | 113 ✓ | NOT_ACCEPTED | 3B/4M/3m（活性、文案红线、契约上限） |
| 修复+验收 3 | 135 ✓ | NOT_ACCEPTED | 2B/4M/1m（警告后不停、facts 注入、LLM 冷却） |
| 修复+验收 4 | 147 ✓ | NOT_ACCEPTED | 2B/0M/0m（恢复语义、取证无限重试） |
| 修复+验收 5 | 150 ✓ | NOT_ACCEPTED | 1B/3M/1m（恢复初始化、警告闩锁、panel 隔离、注入面） |
| 修复+验收 6 | 160 ✓ | NOT_ACCEPTED | 2B/2M/1m（orca.cmd EINVAL、空游标恢复、splitCommand） |
| 修复+验收 7 | 175 ✓ | NOT_ACCEPTED | 1B/1M（cmd /c 注入面→全面消除 shell 包装） |
| 修复+验收 8 | 179 ✓ | NOT_ACCEPTED | 2B/1M/1m（注释红线、exe 存在性、字节截断、--json） |
| 修复+验收 9 | 180 ✓ | **ACCEPTED** | 0/0/0 |
| 真实演练 | — | 1B/1m | 安全网警告↔幻影改善 ping-pong（180 单测未覆盖的集成路径） |
| 修复+终审 | 185 ✓ | **ACCEPTED** | 0/0/1m（README Node 版本口径，已修） |

调度者独立复核（每轮）：typecheck/test 亲自重跑；红线 grep；关键修复生产路径实测（orca 封装真实调用、file 通道真实会话文件冒烟、Unicode 重建回归）。

**真实演练证据**：Orca 双 pane 实战（pi 目标 + guardian 分屏监督者）——watcher 真实发现目标、真实 steer 警告、并暴露单测盲区（警告被目标当用户输入处理→幻影改善→循环），该发现促成了"真实改善=信号消失+newToolCalls>0"的最终语义。

## 关键设计裁决（调度者）

- 新拓扑再裁决（§0）：steer 提醒（机械事实+行动）与机械安全网 stop 获用户批准；handoff 的"诊断不进上下文/L3 不存在"针对旧同进程拓扑，不重审。
- LLM 只选 action，steer 文案一律内核模板组装（结构锁死文案红线）。
- shell 包装全面消除（只认 orca.exe），注入面归零。
- 游标前进永不视为安全网改善（回应警告本身即前进，是幻影）。

## 未执行项 / 已知边界

1. worker-read 对 pi 的 hook transcript 可用性未验证（当前取证走自有 pi/codex 适配器，已够用）。
2. 自动挂接新终端（Orca automations 集成）留接口未实现（design §8）。
3. 远端 worker（--on）与多 watcher 协调未实现（design §8）。
4. 同字节数不同内容的会话文件重建不重置（注释已声明；会话文件按契约 append-only）。

---

## V1.1 增补验收：地基加固 + 锁协议 + Windows EBUSY 硬化（v0.2.0）

- 日期：2026-08-12
- 触发：独立批判（Sidecar Watchdog vs Supervisor）+ 用户多窗口设计语料；本轮仅清地基欠债，V2 语义层见 design.md §9。
- 内容：①运行代际/租约/单例锁（append-only 账本选举+断链永久死亡+fencing）；②waitIdle 未知形状→unknown；③stop 验证；④信号引擎正主迁入本包（pi-task-governor shim 反向导入，本包可独立 clone）；⑤证据保留期+脱敏；⑥Windows EBUSY/EPERM 并发读写瞬态重试全覆盖；⑦load error 中止启动（exit 4 零写入）。
- 实现：deepseek/deepseek-v4-flash:max（公司通道额度耗尽后切个人通道）；验收：openai-codex/gpt-5.6-luna:max 多轮（锁协议经 5+ 轮跨进程探针收敛：claim 非原子→回收 TOCTOU→settle 窗口→EBUSY 胜者崩溃假象→写路径无重试→fencing 顺序→finish TOCTOU 缓解→load 中止）。
- 终审证据：275/275 ×2 全绿（governor 95/95）；跨进程 barrier（30-50 子进程）恰 1 胜者零崩溃多轮；W5 调度者亲测探针（load error → exit 4 + 零共享写入）。
- 已知残余（裁决接受）：finish 校验→rename 微秒级窗口无 OS 级可移植原子锁可消除，后果自愈（注释声明）；E-SafeNet 透明加密环境下非白名单进程读到密文——子代理验收的读文件类探针在此环境不可靠，读代码类终审证据以调度者主会话为准。

---

## V2a 增补验收：干预语义重排 + 任务契约 + guardian-judge profile（v0.3.0）

- 日期：2026-08-12
- 内容（design.md §9.2/§9.3-1/2）：①机械信号路径重排为 L1 Advise → L2 WARNING（须 ACK）→ pause（可逆），删除一切"计数→stop"自动路径；②预算到期只退出不动目标；③stop 仅剩 L4 客观硬边界模式表（工作区外删除/凭据外泄）；④--contract 任务契约（形状校验 exit 2，进证据包与汇报头）；⑤guardian-judge 固定 profile（只读角色/证据不可信/强制 schema/禁改代码）；⑥升级阶梯 per-incident（signalKey=kind:factsHash，封顶后只记录；废除全局计数器触发）。
- 实现：deepseek/deepseek-v4-flash:max（个人通道）；验收：openai-codex/gpt-5.6-luna:max 多轮（全局计数器、key 碰撞、封顶不一致等语义缺陷均修复）；终审轮 reviewer 环境异常中断，末轮由调度者亲自复核（signalKey/pauseTrigger 代码直读 + decide/state 测试 47/47、36/36 + 全套 329×3 零 flake）。
- 未执行项：V2b（incident FSM、分级 mailbox+ACK、结构化事件传感、完工 fresh reviewer、panel 异步降级）见 design.md §9.3-3/4/5/6/7。
