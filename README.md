# @local/dsh-artex — 把 ARTEX 的 agent 编排搬进 DSH

一个 Host 插件：用 DSH 原生的 subagent 机制，复刻 ARTEX（`Autumn-27/ARTEX`）的**双图 + 事件驱动 planner/worker 编排**。装上之后模型获得 14 个 `artex_*` 工具，可以：

- 用一个总目标启动一次**自主多轮编排**：规划者（planner）每轮派意图，多个执行者（worker）并发领取意图干活，图一变就唤醒规划者，直到目标被**证据**证明；
- 所有中间结论沉淀成可检索的**事实/发现/资源**，而不是散落在对话里；
- worker 之间能**按执行过程**互相复用（"这个命令别人跑过吗？"），而不只是看最终结论；
- 跨唤醒保留规划者的**串行链待办**，让有依赖的多步计划不被一次性并行拆散。

> 本目录是插件的源码与测试。安装后对整个 profile 生效。

---

## 1. 从 ARTEX 里分析出的编排骨架

ARTEX 是一套 Go 写的多 agent 系统。它的编排不是"一个 agent 循环调工具"，而是**两个图 + 一个事件驱动引擎 + 三类角色**：

| ARTEX 机制 | 代码位置 | 本质 |
|---|---|---|
| 探索图（每任务） | `db/schema.sql` `exploration_nodes/edges/anchors` | goal / intent / fact / finding / hint 节点 + `spawns/derived_from/yields/proves` 血缘边 |
| 资源图（跨任务共享） | `assets` 表 | 程序负责去重与父子关系的"真值库"，agent 只提交原始信息 |
| 引擎主循环 | `server/engine.go:800-914` | `select` 三路：边沿唤醒 / 心跳 / 退出；每任务 1 个 planner goroutine + N 个 worker goroutine |
| 边沿去抖 | `engine.go:390, 810-819` | 唤醒后固定 **800ms** 窗口把突发通知合并成一轮 |
| 心跳巡检 | `engine.go:781-787` | `max(plan_heartbeat_seconds, 600s)`，防止死锁并复查在跑 work |
| frontier 领取 | `engine.go:1237-1245`、`exploration.go:1173-1181` | `open` 意图按 `priority DESC, id ASC` 出队，`UPDATE ... WHERE state='open'` CAS 抢占为 `running` |
| 并发上限 | `manager.go:284` | 每任务 worker 数默认 **3** |
| 事件源 | `manager.go:1762-1851` | worker 完成→`done`；`report_finding` 落库当场 `notifyFinding`（**不等 worker 结束**）；goal/hint/删除/编辑也会唤醒 |
| 意图状态机 | `engine.go:1135-1152` + `terminalreason.go` | `open→running→done/exhausted/blocked/stopped`；err→blocked、预算耗尽→exhausted |
| 预算与收尾 | `engine_timeout.go`、`worker.go:423-428`、`wrapup.go` | 任务 deadline 夹逼单轮预算；命中后先跑一轮**收尾**（停用 Bash、要求写回）；`settleDrainGrace=90s` |
| 跨 work 过程复用 | `activity` 表、`tools.go:1821-1971` | 每一步工具调用/结果入库；`search_all_worker_traces(q)` 自动排除自己那条意图；`get_worker_trace(intent_id, step_ids≤5)` 取原文 |
| planner 跨轮待办 | `planner.go:43-48, 106-144, 432` | 按任务保留一个 `TodoStore`，每次唤醒都把清单渲染进 user 提示；串行链只派"前置已满足"的那一步 |
| 角色工具绑定 | `toolcatalog.go:34-50` + DB `tools` 绑定 | planner 只有 `add_intent/prove_goal/...`；worker 只有 `record_fact/insert_assets/report_finding/...`；`add_hint` 只给 mainagent |

角色分工与提示词纪律（`planner.go:298-340`、`worker.go:230-243`）是这套系统真正的"智能"来源：

- **planner 是唯一意图生成者**，且**不是执行者**——不许自己 curl、不许做枚举，只能派意图或判目标；**0 意图必须有正当理由**，目标未达成且无 open/running 意图时**必须**产出；
- **worker 只做一条意图**，**边发现边写回**，越界线索写进 fact 交给规划者而不是自己追；**fact 是观察，finding 才是已验证成果**（必须真实触发 + 可复现证据）；
- **去重与血缘**：`parents` 只能挂 fact/finding，`yields` 记录意图产出，规划者据此判断"哪个方向从哪里来、能不能综合"；
- **深度优先于覆盖面**，保持 2–3 条机理不同的路线，但**多样性服从操作约束**；
- **prove_goal 是唯一收官方式**：逐条用 fact/finding 作证据标记目标，最后一条标记后任务自动完成；量化目标必须先核对实测值。

---

## 2. 映射到 DSH

DSH 没有 "Go goroutine + Postgres"，但有三样正好够用的原语：**子会话**（`ctx.subagents.startActivation`）、**工具注册表**（`ctx.tools.register`）、**会话事件流**（`session/event`）。映射如下：

| ARTEX | 本插件 | 说明 |
|---|---|---|
| planner goroutine，每次唤醒新 session | `plannerRound()` → 每次 `startActivation` 一个 planner 子会话 | 全新会话 + 随附态势 = ARTEX 的"无状态唤醒" |
| worker goroutine ×N | `dispatchWorkers()` → 每条意图一个 worker 子会话 | 并发上限 `maxWorkers`（默认 3） |
| frontier / claimNext | `task.intents` 中 `state==='open'`，`claimIntent` 置 running | 单线程 JS，天然无 CAS 竞争 |
| 800ms 边沿去抖 | `waitEvent()` + `debounceMs`（默认 800） | 唤醒后睡一个窗口再 drain 事件队列 |
| 心跳 ≥600s | `waitEvent(heartbeatMs)`，默认 600000 | 超时即一轮巡检规划 |
| `NotifyDone` / `notifyFinding` | `finishWorker` / `recordFinding` → `pushEvent` | finding 落库当场唤醒规划者，不等 worker 结束 |
| `kill_work` / `steer_work` | `subagents.interrupt` / `subagents.sendMessage` | 预算耗尽先 steer 收尾，宽限期后 interrupt |
| settlement + 90s drain grace | `awaitChild()`：超时 → 发收尾词 → `settleGraceMs` → interrupt | 保证已识别的结论有机会写回 |
| `activity` + trace 检索 | `session/event` 的 `tool/call`/`tool/result`/`assistant/message` 索引成 activity | worker 之间按执行过程互查；JSONL 全量落盘 |
| planner 共享 TodoStore | `task.todos` + `artex_set_todos`（整体替换） | 跨唤醒保留，渲染进每轮提示 |
| 角色工具绑定 | `toolFilter.deny`（子会话）+ execute 内会话身份校验 | 子会话**看不到**越界工具；即使绕过也会被拒 |
| Postgres 双图 | `.artex/` 下的 JSON 快照 + JSONL 过程日志 + 跨任务 `resources.json` | 无外部依赖，可 git diff / 直接读 |

### 角色与工具

| 角色 | 行为 | 工具 |
|---|---|---|
| **所有者会话**（调用 `artex_run_task` 的那个 DSH 会话） | 下发目标/约束、在环路操舵、看报告 | 全部 14 个 |
| **planner**（每轮一个新子会话） | 读态势 → 判目标 → 派 0..4 条意图 / 更新串行链待办 | `artex_add_intent`、`artex_prove_goal`、`artex_set_todos` + 读工具 |
| **worker**（每条意图一个新子会话） | 只做这一条 → 边发现边写回 → 一句话总结 | `artex_record_fact`、`artex_report_finding`、`artex_add_resource` + 读工具 |
| 其它无关子会话 | 什么都不能做（控制/写操作被身份校验拒绝） | 读工具需显式 `task_id` |

### 数据落地

```
<workspace>/.artex/
  resources.json                     # 跨任务资源图（按 type + key||name 去重）
  tasks/<taskId>/task.json           # 探索图快照（goals/intents/facts/findings/hints/todos/stats）
  tasks/<taskId>/activity.jsonl      # 全量过程日志（每步 tool/result）
```

---

## 3. 工具清单

| 工具 | 作用 | 谁可以调 |
|---|---|---|
| `artex_run_task` | 前台跑完整编排，返回报告（阻塞） | 所有者 |
| `artex_start_task` | 后台启动，立即返回 task_id | 所有者 |
| `artex_task_status` | 状态快照 / 列出任务 | 任意 |
| `artex_stop_task` | 中断全部子会话并停止 | 所有者 |
| `artex_add_hint` | 注入战略提示并立刻唤醒规划者 | 所有者 |
| `artex_graph_overview` | 态势快照（目标/意图/事实/发现/血缘） | 任意 |
| `artex_node_detail` | 某节点的完整内容与证据 | 任意 |
| `artex_trace` | 列出 work / 关键字检索过程 / 取某几步原文 | 任意 |
| `artex_add_intent` | 批量派意图（≤4） | planner / 所有者 |
| `artex_prove_goal` | 用 fact/finding 证明目标 | planner / 所有者 |
| `artex_set_todos` | 整体替换跨轮规划待办 | planner / 所有者 |
| `artex_record_fact` | 写回结论（evidence + confidence） | worker / 所有者 |
| `artex_report_finding` | 登记已验证成果 | worker / 所有者 |
| `artex_add_resource` | 登记跨任务复用的资源/实体 | worker / planner / 所有者 |

---

## 4. 安装与使用

本目录是一个**独立仓库**，同时就是插件包根目录（`package.json` 里的 `dsh.bundle.patch` 指向本目录的 `cordis.patch.yml`）。

```powershell
# 在本 profile 里安装：target 指向本仓库根目录
# plugin_manager action: install_bundle, target: <path>/dsh-artex-plugin
```

安装后新会话即可看到 `artex_*` 工具。示例：

```
用 artex_run_task 做这件事：把 docs/ 下所有接口文档和实现对齐，找出不一致；
goals: ["列出所有不一致项", "给出每项的修复建议"]
constraints: ["只读，不修改代码"]
max_workers: 3
```

先看方案不执行：`max_workers: 0`（只跑一轮规划，返回意图清单）。

**成本与时长**：每轮规划 = 1 个 planner 子会话；每条意图 = 1 个 worker 子会话。一个 3 轮 × 2 意图的任务约 8 次模型调用。`max_rounds`、`budget_ms`、`worker_timeout_ms` 是硬上限；`artex_stop_task` 可随时止损。

**配置**（`cordis.patch.yml` 的 config，或安装后按需改）：

| 键 | 默认 | 含义 |
|---|---|---|
| `provider` | `spawn` | 子会话 provider（`spawn` 全新上下文 / `fork` 继承上下文） |
| `maxWorkers` | 3 | 任务内并发 worker |
| `maxRounds` | 24 | 规划轮次上限 |
| `maxStalls` | 2 | 连续空转多少轮后停 |
| `debounceMs` | 800 | 边沿合并窗口 |
| `heartbeatMs` | 600000 | 巡检间隔 |
| `workerTimeoutMs` | 1200000 | 单 worker 预算 |
| `plannerTimeoutMs` | 900000 | 单轮 planner 预算 |
| `settleGraceMs` | 90000 | 收尾宽限 |
| `budgetMs` | 0 | 任务总预算（0=不限） |
| `isolateWorkdir` | false | worker 是否在 `.artex/tasks/<id>/i<n>` 独立 cwd 工作 |

---

## 5. 与 ARTEX 的差异（有意为之 / 尚未实现）

**有意的简化**

- **goals 子代理**：ARTEX 建任务时先用一个 `goals` agent 抽约束、把目标拆成可核验结果。这里改为 `goals`/`constraints` 参数由调用方直接给出（或退化为单目标），省一次模型调用；约束仍然以最高优先级注入两个角色。
- **资产图的程序化层级**：ARTEX 的资产图由程序算 `root_domain→subdomain→service→endpoint` 的父子与去重键。通用场景没有这种固定层级，这里退化为 `(type, key||name)` 去重 + 自由 `attrs`。
- **pause/resume**：用 `artex_stop_task` + 重新 `artex_start_task` 替代；DSH 的子会话本身也可用 `send_message` 续跑。
- **智能体边界**：ARTEX 用 DB 绑定实现"planner 看不到 worker 工具"；这里用 spawn provider 的 `toolFilter` 在子会话作用域内收掉越界工具，并在 execute 里按会话身份二次校验。

**未实现**

- reporter（发现后自动写 Markdown 报告）、retester（复测）、cold digest 冷压缩、coverage 覆盖度、跨任务只读继承（`source_task_ids`）、`steer_work`/`kill_work` 作为 planner 工具（目前只由引擎在预算/停止时使用）、finding 与流量证据的绑定。

---

## 6. 测试

```powershell
node test/graph-smoke.mjs    # 图内核 + 提示词 + 14 个工具 schema
node test/engine-smoke.mjs   # 用假 subagents 跑完整闭环（3 轮、2 意图、prove_goal 收官、过程索引）
```

`test/engine-smoke.mjs` 用脚本化的假子会话驱动真实引擎：规划者按态势派意图、worker 写回事实/发现、规划者用证据标记目标，最终断言 `status=completed`、写回计数、trace 检索命中、以及子会话确实收到了越界工具的 deny 列表。
