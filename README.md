# dsh-artex — 把 ARTEX 的 agent 编排搬进 DSH

用 DSH 原生的 subagent 机制，把 ARTEX（`Autumn-27/ARTEX`）那套「双图 + 事件驱动」的 planner/worker 编排搬过来，做成一个 Host 插件。装上之后，模型会多出 23 个 `artex_*` 工具，能做四件事：

- **一个总目标一路跑到底**：规划者（planner）每轮派意图，多个执行者（worker）并发领取，图上一有变化就唤醒规划者，直到目标有证据支撑。
- **结论沉淀成图**：中间结论写成可检索的事实、发现、资源，而不是散落在对话里。
- **按执行过程复用**：执行者之间可以互查「这条命令别人跑过没有」，不必只看最终结论。
- **串行链不被打散**：规划者的待办跨轮保留，有依赖的多步计划只派「前置已满足」的那一步。

> 本仓库是插件的源码与测试目录，安装后对整个 profile 生效。
>
> ⚠️ 插件会驱动子会话在宿主机上执行命令，仅限用于自有或已获书面授权的系统。使用前请先读文末的「免责声明与合法使用」。

---

## 1. ARTEX 的编排骨架

ARTEX 是 Go 写的一套多智能体系统。它的编排不是「一个 agent 循环调工具」，而是**两张图 + 一个事件驱动引擎 + 三类角色**。

| ARTEX 机制 | 代码位置 | 本质 |
|---|---|---|
| 探索图（每任务） | `db/schema.sql` `exploration_nodes/edges/anchors` | goal / intent / fact / finding / hint 节点，加 `spawns/derived_from/yields/proves` 血缘边 |
| 资源图（跨任务共享） | `assets` 表 | 由程序去重、维护父子关系的「真值库」，agent 只提交原始信息 |
| 引擎主循环 | `server/engine.go:800-914` | `select` 三路：边沿唤醒、心跳、退出；每任务 1 个 planner goroutine，加 N 个 worker goroutine |
| 边沿去抖 | `engine.go:390, 810-819` | 唤醒后固定 **800ms** 窗口，把突发通知合并成一轮 |
| 心跳巡检 | `engine.go:781-787` | `max(plan_heartbeat_seconds, 600s)`，防死锁，顺带复查在跑的 work |
| frontier 领取 | `engine.go:1237-1245`、`exploration.go:1173-1181` | `open` 意图按 `priority DESC, id ASC` 出队，`UPDATE ... WHERE state='open'` CAS 抢占为 `running` |
| 并发上限 | `manager.go:284` | 每任务 worker 数默认 **3** |
| 事件源 | `manager.go:1762-1851` | worker 完成发 `done`；`report_finding` 落库当场 `notifyFinding`（不等 worker 结束）；goal、hint、删除、编辑也会唤醒 |
| 意图状态机 | `engine.go:1135-1152` + `terminalreason.go` | `open→running→done/exhausted/blocked/stopped`；err 转 blocked，预算耗尽转 exhausted |
| 预算与收尾 | `engine_timeout.go`、`worker.go:423-428`、`wrapup.go` | 任务 deadline 夹逼单轮预算；命中后先跑一轮**收尾**（停用 Bash、要求写回）；`settleDrainGrace=90s` |
| 跨 work 过程复用 | `activity` 表、`tools.go:1821-1971` | 每一步工具调用和结果入库；`search_all_worker_traces(q)` 自动排掉自己那条意图；`get_worker_trace(intent_id, step_ids≤5)` 取原文 |
| planner 跨轮待办 | `planner.go:43-48, 106-144, 432` | 每个任务一个 `TodoStore`，每次唤醒都把清单渲染进 user 提示；串行链只派「前置已满足」的那一步 |
| 角色工具绑定 | `toolcatalog.go:34-50` + DB `tools` 绑定 | planner 只有 `add_intent/prove_goal/...`；worker 只有 `record_fact/insert_assets/report_finding/...`；`add_hint` 只给 mainagent |

角色分工和提示词纪律（`planner.go:298-340`、`worker.go:230-243`）才是这套系统真正的「智能」所在：

- **规划者只产意图，不动手**。不许自己 curl，不许自己枚举，只能派意图或者判目标。0 条意图必须有正当理由：目标没达成、又没有 open/running 意图时，必须给出方向。
- **执行者一次只做一条意图，边发现边写回**。越界的线索写成 fact 交给规划者，不要自己追下去。fact 是观察，finding 才是已验证的成果，必须真的触发过、能复现。
- **去重与血缘**。`parents` 只能挂 fact/finding，`yields` 记录意图的产出，规划者据此判断某个方向从哪儿来、能不能综合。
- **深度优先于覆盖面**。同时保持 2–3 条机理不同的路线，但多样性要服从操作约束。
- **`prove_goal` 是唯一的收官方式**。逐条用 fact/finding 作证据标记目标，标完最后一条任务自动结束；量化目标要先核对实测值。

---

## 2. 映射到 DSH

DSH 里没有 Go goroutine，也没有 Postgres，但有三样够用的原语：子会话（`ctx.subagents.startActivation`）、工具注册表（`ctx.tools.register`）、会话事件流（`session/event`）。对应关系如下。

| ARTEX | 本插件 | 说明 |
|---|---|---|
| planner goroutine，每次唤醒新 session | `plannerRound()` → 每次 `startActivation` 一个 planner 子会话 | 全新会话 + 随附态势，相当于 ARTEX 的无状态唤醒 |
| worker goroutine ×N | `dispatchWorkers()` → 每条意图一个 worker 子会话 | 并发上限 `maxWorkers`（默认 3） |
| frontier / claimNext | `task.intents` 里 `state==='open'` 的节点，`claimIntent` 置 running | 单线程 JS，天然没有 CAS 竞争 |
| 800ms 边沿去抖 | `waitEvent()` + `debounceMs`（默认 800） | 唤醒后先等一个窗口，再取事件队列 |
| 心跳 ≥600s | `waitEvent(heartbeatMs)`，默认 600000 | 超时就跑一轮巡检规划，并复查在跑 worker 的静默量（唤醒→中断） |
| `NotifyDone` / `notifyFinding` | `finishWorker` / `recordFinding` → `pushEvent` | finding 落库当场唤醒规划者，不等 worker 结束 |
| `kill_work` / `steer_work` | `subagents.interrupt` / `subagents.sendMessage` | 预算耗尽先 steer 收尾，宽限期后再 interrupt |
| settlement + 90s drain grace | `awaitChild()`：超时 → 发收尾词 → `settleGraceMs` → interrupt | 让已经识别出的结论有机会写回 |
| `activity` + trace 检索 | `session/event` 的 `tool/call`、`tool/result`、`assistant/message` 索引成 activity | 执行者之间按过程互查；JSONL 全量落盘 |
| planner 共享 TodoStore | `task.todos` + `artex_set_todos`（整体替换） | 跨唤醒保留，渲染进每一轮提示 |
| 角色工具绑定 | `toolFilter.deny`（子会话）+ execute 内的身份校验 | 子会话**看不到**越界工具，绕过了也会被拒 |
| Postgres 双图 | `.artex/` 下的 JSON 快照 + JSONL 过程日志 + 跨任务 `resources.json` | 无外部依赖，能 git diff，也能直接读 |

### 角色与工具

| 角色 | 行为 | 工具 |
|---|---|---|
| **所有者会话**（调用 `artex_run_task` 的那个 DSH 会话） | 下目标、给约束、在环操舵、看报告 | 全部 23 个 |
| **planner**（每轮一个新子会话） | 读态势 → 判目标 → 派 0..4 条意图 / 更新串行链待办 | `artex_add_intent`、`artex_prove_goal`、`artex_set_todos` + 读工具 |
| **worker**（每条意图一个新子会话） | 只做这一条 → 边发现边写回 → 一句话总结 | `artex_record_fact`、`artex_report_finding`、`artex_add_resource` + 读工具 |
| 其它无关子会话 | 什么都不能做（控制和写操作会被身份校验拒掉） | 读工具需显式带 `task_id` |

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
| `artex_stop_task` | `mode=stop` 终止；`mode=pause` 暂停保留现场 | 所有者 |
| `artex_resume_task` | 重挂 paused/stopped 任务续跑（必须重给 budget_ms） | 所有者 |
| `artex_add_hint` | 注入战略提示，立刻唤醒规划者 | 所有者 |
| `artex_graph_overview` | 态势快照（目标、意图、事实、发现、血缘） | 任意 |
| `artex_node_detail` | 某个节点的完整内容与证据 | 任意 |
| `artex_trace` | 列出 work / 关键字检索过程 / 取某几步原文 | 任意 |
| `artex_add_intent` | 批量派意图（≤4；kind=pursue/enumerate，state=open/blueprint，支持 depends_on） | planner / 所有者 |
| `artex_plan` | 一轮结构化计划协议：一次提交 decision/todos/intents(≤12)/proofs | planner / 所有者 |
| `artex_promote_intent` | 把 blueprint 提升为 open | planner / 所有者 |
| `artex_set_brief` | 整体替换跨轮全局认知 brief | planner / 所有者 |
| `artex_prove_goal` | 用 fact/finding 证明目标（inferred 默认拒，allow_inferred 放行） | planner / 所有者 |
| `artex_set_todos` | 整体替换跨轮规划待办 | planner / 所有者 |
| `artex_record_fact` | 写回结论（evidence + confidence + outcome；found 必给 evidence） | worker / 所有者 |
| `artex_report_finding` | 登记已验证成果（evidence 硬门必填） | worker / 所有者 |
| `artex_add_resource` | 登记跨任务复用的资源或实体 | worker / planner / 所有者 |
| `artex_set_analysis` | 提交独立分析（只读输入，不改 brief） | analyst / 所有者 |
| `artex_retest_finding` | finding 复测闭环（open → verified/rejected/needs_retest） | verifier / planner / 所有者 |
| `artex_record_conflict` | 两条给出相反结论的节点落成结构化冲突 | worker / analyst / planner / 所有者 |
| `artex_retract_fact` | 撤回事实（留档但不可再作证明） | planner / 所有者 |
| `artex_coverage_report` | 确定性覆盖矩阵（audit 收口前查缺口） | 任意（按读权限） |

---

## 4. 安装与使用

本仓库既是独立仓库，也是插件包的根目录：`package.json` 里的 `dsh.bundle.patch` 就指向本目录的 `cordis.patch.yml`。

```powershell
# 在本 profile 里安装：target 指向本仓库根目录
# plugin_manager action: install_bundle, target: <path>/dsh-artex-plugin
```

装好之后，新会话就能看到 `artex_*` 工具。举个例子：

```
用 artex_run_task 做这件事：把 docs/ 下所有接口文档和实现对齐，找出不一致；
goals: ["列出所有不一致项", "给出每项的修复建议"]
constraints: ["只读，不修改代码"]
max_workers: 3
```

只想先看方案、不执行：给 `max_workers: 0`，只跑一轮规划，返回意图清单。

**成本与时长**：一轮规划对应一个 planner 子会话，一条意图对应一个 worker 子会话。3 轮 × 2 条意图的任务，大约 8 次模型调用。`max_rounds`、`budget_ms`、`max_tokens`、`worker_timeout_ms` 都是硬上限，`artex_stop_task` 可以随时止损。

## 4.0.1 P0 能力：暂停/恢复、token 预算、证据硬门、任务级沙箱

- **暂停/恢复**：`artex_stop_task(mode="pause")` 把任务以 `paused` 状态落盘（facts / findings / 意图 / brief / usage 全部保留；跑中意图回炉 open）。`artex_resume_task(task_id, budget_ms)` 重新挂载续跑——**必须显式给新预算**（旧 deadline 不继承），已完成任务不可恢复。跨进程重启也一样能从任务目录恢复。
- **Token 预算**：`max_tokens`（input+output 合计）由 usage 事件实时累计；超限时先向全部子会话发"收尾证明"指令、宽限期内排干，再以 `timeout · token 预算耗尽（actual/max）` 收口。报告按 **角色 / 意图 / 工具调用计数** 三个维度给成本分解。
- **证据硬门**：服务端强约束而不是提示词纪律——
  - `artex_report_finding` 必须给 `evidence`；
  - `outcome=found` 的 fact 必须给 `evidence`；
  - `prove_goal` 默认只接受 observed 事实 / finding，`confidence=inferred` 需显式 `allow_inferred=true`，`outcome=none` 需显式 `allow_negative=true`。
- **任务级沙箱策略**（start/run 参数落成 spawn 边界，不只是提示词）：
  - `read_only: true` → 子会话的已知写/执行类宿主工具（edit/write/pwsh/terminal/workflow 等）全部经 toolFilter 收掉；
  - `allowed_tools: [...]` → 基础工具白名单，名单之外的同名工具同样收掉；
  - `allowed_paths: [...]` → 路径白名单，作为纪律约束注入所有子会话 prompt。

## 4.0.2 P1 能力：覆盖闭环、生命周期、结构化计划、独立验证者

- **覆盖矩阵 + 收口门禁（audit）**：`coverageOf()` 按 goal 关键字确定性统计相关 fact/finding，`gap=true` 的目标在 audit 终态时随报告落盘（`report.coverage`），让"覆盖不透明"变成一行可核对的数据；planner 可用 `artex_coverage_report` 随时自查。
- **finding 生命周期**：`open → verified / rejected / needs_retest`，由 `artex_retest_finding` 驱动。报告按状态分组（verified/open/rejected/needs_retest），不再只有"found/not found"两种视角。
- **fact 生命周期**：`supersedes / contradicts / retracted`。`artex_record_conflict` 把两条相互矛盾的节点落成图上结构化对象（而不是只剩 planner 嘴上说说）；`artex_retract_fact` 撤回被证伪的旧结论（留档但不能再作 prove 证据）。
- **意图显式依赖**：`depends_on: [意图id...]`。调度器只领依赖全部 done 的意图；依赖落在 failed/exhausted/blocked 的路线会在视图里标 `blocked_by_deps`，planner 负责改路线而不是让它悄悄饿死。
- **结构化计划协议**：`artex_plan` 一次提交 `{ decision, todos, intents[≤12], proofs }`，服务端按 todos → intents → proofs 固定顺序执行；单段失败只记该段，不吞后续段，比一轮里散打 4 个工具更稳也更好审。
- **独立 verifier**（`enable_verifier: true` 开启）：每落一条 finding 就按串行链派一个 verifier 子会话复核，工具面只有"只读 + retest + record_fact"，**不能派意图、不能改 brief**——验证和规划从结构上分离，防止角色膨胀。开启会让每 finding 多花一次模型调用，默认关。

## 4.0.3 P2：暂不实现

报告导出 HTML/JSON/SARIF、npm 发布、层级 planner，这条路线图明确**不做**：层级 planner 过早引入会把 planner/worker 的梯度烧掉（见 ARTEX 自身的双图设计边界）；导出/分发看后续真有消费方再排。（UI client 已由 §4.0.4 的开关 chip / 会话行徽章与 @local/dsh-artex-view 会话视图落地。）

## 4.0.4 会话级开关与调用标识

「这个会话用没用 ARTEX」从隐式变显式，分三层：

- **开关**：会话里输入 `/artex on | off | status`（人类命令，不进模型上下文；`command/run` 连参数落在会话日志里，命令行本身就是切换的可见标记），或点输入框左侧的 **🧭 ARTEX chip**（client 半边，与命令共用同一份状态）。off 之后本会话发起的 `artex_*` 调用一律被 `tools.guard` 拦截并提示如何重开；**运行中的任务不受影响**（它们的写回来自子会话，子会话有自己的会话 id，默认开）。状态持久化在 profile 级 `~/.dsh/artex-session-flags.json`（默认开，装了插件即可用，向后兼容；文件损坏容错为全开）。
- **标识**：23 个 `artex_*` 工具卡片统一 **🧭** 前缀，时间线上一眼可辨；会话列表里有 ARTEX 任务的会话行头显示 **🧭** 徽章（悬停给任务数/运行中数，client 半边轮询 `/api/artex`）。
- **数据通道**：`/api/artex`（POST，只收本机回环来源）——`state {sessionId, cwd?}` 返回 `{enabled, tasks: 轻量摘要[]}`，`setEnabled {sessionId, enabled}` 切换开关；插件自己的 client 半边与任何本地消费方都可用。

硬摘 schema（`tools.restrict` 按会话隐藏 23 个工具以省上下文）验证过机制存在，但 schema 动态性对事件回放的影响未定论，当前只做软门禁。

**配置**（写在 `cordis.patch.yml` 的 config 里，装好之后也可以再改）：

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
| `mode` | `objective` | 默认任务模式：`objective` / `audit` |
| `viewMode` | `hybrid` | 全局视野策略：`planner` / `hybrid` / `analyst` |
| `enableHybrid` | true | hybrid 总开关，false 强制 planner |
| `saveDebounceMs` | 500 | 快照合并写延迟 |
| `plannerRetries` | 2 | planner 瞬态失败的重试次数 |
| `allowCrossTaskRead` | false | 是否允许跨 owner/角色读取任务 |
| `settleGraceMs` | 90000 | 收尾宽限 |
| `budgetMs` | 0 | 任务总预算（0 表示不限） |
| `isolateWorkdir` | false | worker 是否在 `.artex/tasks/<id>/i<n>` 独立 cwd 里工作 |

---

## 4.1 双模式与全局认知

### 两种成功语义

| mode | 目标函数 | 意图类型 | 完成判据 |
|---|---|---|---|
| `objective`（默认） | 首个充分突破 | `pursue`：追一条路径，成功即停；失败写 `outcome=none` 再回溯 | 目标有证据支撑 |
| `audit` | 覆盖最大化 | `enumerate`：逐项验证，命中了也不停，正负结果都写回 | 覆盖维度（goals）都有证据 |

**objective 的路径树与回溯**：pursue 可以带 `path_parent`。某条路径判死后，规划者沿它往上找最近的、还有未尝试 `blueprint` 的祖先，从那儿派下一条。`blueprint` 是候选池，可以直接用 `state:"open"` 创建，也可以用 `artex_promote_intent` 提升。

**突破即停，保留现场**：任意一条 pursue 证明目标后，引擎先冻结派发，给其它在跑的 pursue 发「停止并回报」指令，等 `breakthrough_grace_ms`（默认 30 秒）让它们把进度写回来，到期硬停。这些意图记为 `stopped/sibling_breakthrough`，它们的事实、发现和输出都保留，报告里单列「被中止或判死的路径」。

### 全局认知（brief）

规划者每轮维护一份跨轮持久的 `brief`（`artex_set_brief`，整体替换），引擎另外注入两样东西：

- `delta`：上次规划之后新增或变化的事实、发现，以及结束的意图。
- `digest`：确定性的 outcome 计数、意图状态分布、失败路径清单。

`brief` 要覆盖整个任务的历史（audit 写覆盖地图，objective 写路径树），已确认的结论必须带 `fact#id`。落后超过一轮，下一轮的提示里会标「已过期」。历史信息有固定大小的载体，事实列表就不必随轮次线性膨胀。

### 相关参数

| 位置 | 参数 |
|---|---|
| `artex_run_task` / `artex_start_task` | `mode`：`objective` / `audit`；`breakthrough_grace_ms` |
| `artex_add_intent` | `kind`：`pursue` / `enumerate`；`state`：`open` / `blueprint`；`path_parent` |
| `artex_record_fact` | `outcome`：`found` / `none` / `inconclusive` / `blueprint` |
| `artex_prove_goal` | `allow_negative`：目标本身是负向结论时，允许 `outcome=none` 作证据 |

### 边界

- audit 的「覆盖闭合才算完成」是靠 goals 证据实现的，属于提示词级约束，不是引擎硬门禁。
- 轮次用尽会补一次**收官证明轮**；预算耗尽、且已经有事实时，会补一次**收尾证明轮**，只做目标判定，不再派新意图。
- 插件重载后，进程内的任务状态会清空；历史快照仍在 `.artex/tasks/<id>/` 下。

## 4.2 独立分析者（analyst）

全局视野分三层：引擎 digest（确定性计数）、规划者 brief（战略权威）、analyst（周期性只读重综合）。analyst 通过 `artex_set_analysis` 提交分析，规划者读过之后自己决定采纳还是驳回，再写进 brief。**只有规划者能改 brief**，免得两边同时写、来回震荡。

| `viewMode` | 行为 | 成本 |
|---|---|---|
| `hybrid`（默认） | 按触发条件运行：audit 每 3 轮或新增事实 ≥8；objective 出现 `failed` 路径；brief 过期 | 中 |
| `planner` | 不启用 analyst | 最低 |
| `analyst` | 每个规划轮都跑一次 | 最高 |

触发条件和预算（config）：`analystMaxRuns=4`、`analystEveryRounds=3`、`analystFactThreshold=8`、`analystCooldownMs=30000`、`analystTimeoutMs=180000`。

### 开关

| 层级 | 字段 | 默认 | 作用 |
|---|---|---|---|
| 插件 | `enableHybrid` | `true` | 总开关；`false` 强制 `planner` |
| 插件 | `viewMode` | `hybrid` | 精细策略：`planner` / `hybrid` / `analyst` |
| 任务 | `analyst` | 继承 | `false` 关掉本任务的 analyst |
| 任务 | `view_mode` | 继承 | 覆盖本任务的 `viewMode` |

生效优先级：`analyst:false` 或 `enableHybrid:false` 一律回落到 `planner`；否则按 `view_mode` > `viewMode` > `hybrid` 取。

传统非审计模式 = `mode:"objective"` + `analyst:false`：

```json
artex_run_task({ "goal": "...", "mode": "objective", "analyst": false, "view_mode": "planner" })
```

analyst 的工具面被 `toolFilter` 收窄成「只读 + `artex_set_analysis`」：不能写事实和发现，不能派意图，不能证明目标，也不能改 brief。它的输出一般包括：一致性检查、被忽略的线索（带 trace id）、覆盖缺口或路径重排建议、下一步优先级。

短任务基本不会触发 analyst。长审计里它主要用来纠偏：规划者的 brief 过时了、结论下得过强、或者资源锚点打架。

## 4.3 数据、索引与权限

- **分片持久化**：`task.json` 只存元数据和图状态，facts、findings、activities 分别落在 `facts.jsonl`、`findings.jsonl`、`activity.jsonl`。JSONL 行数超过内存上限两倍时压实，`task.json` 不回写全量集合。
- **合并写**：运行中的高频改动走 `saveDebounceMs`（默认 500 毫秒）合并落盘；收官、停止、插件卸载时强制 flush。
- **集合上限**：facts 2000、findings 500、hints 200；淘汰时保留 `goals[].evidence` 指向的节点，回读时同样保留。brief/analysis 的 citations 最多保留 200 条，所以事实内存保留量的上界是 `2000 + 200`（引用本身也被截到 200，防止保护集无界）。
- **全局任务索引**：`~/.dsh/artex-index.json` 记录 `taskId → cwd` 和 owner，最多 500 条。换个工作区也能按 id 查到历史任务。
- **读权限**：默认只有任务所有者和它的子会话能读；跨会话读取要打开 `allowCrossTaskRead: true`。
- **只读 Host Service `artex`**：`view-api.js` 对外暴露 `ctx.provide('artex', api)`，供
  `@local/dsh-artex-view` 一类视图插件读取：`listTasks({ sessionId, limit })` 返回该会话
  拥有的任务（live + 磁盘索引，磁盘任务只读 `task.json` 元数据）；`taskSnapshot({ taskId,
  sessionId })` 返回 `{ task, resources, resources_total, live, settling }`，磁盘任务复用
  `engine.loadTask()` 合并 JSONL。方法只读、不落盘、不改引擎状态，鉴权口径与
  `tools/read.js` 一致。视图插件再用 HTTP 路由把裁剪后的图/覆盖载荷推给浏览器。
- **敏感数据**：`.artex/` 里可能有证据原文，不要提交到公开仓库。任务 id 经过白名单校验，不能拿来路径穿越。

## 4.4 架构分层

| 模块 | 职责 |
|---|---|
| `index.js` | 插件入口：建引擎、注册工具、订阅会话事件、生命周期 |
| `config.js` | 默认值 + `normalizeConfig`（未知键、非法枚举、类型错误都会显式告警） |
| `policy.js` | 角色工具策略的单一事实来源：`TOOL_NAMES` + `ROLE_ALLOW` 推导 deny |
| `engine.js` | 门面：任务生命周期、注册表与存储、stop/dispose、persist |
| `graph-ops.js` | 图操作门面：意图、事实、发现、brief、分析、目标、资源写回 |
| `reporting.js` | snapshot / status / report |
| `session-indexer.js` | 子会话事件索引（tool/call、tool/result、assistant/message） |
| `scheduler.js` | 主循环、规划轮、派发 worker、突破停止、收尾与证明轮 |
| `runner.js` | 子会话执行器：spawn、等待、中断、续跑提示 |
| `analyst.js` | 独立分析的触发条件与只读运行 |
| `usage.js` | 按角色累计 provider usage |
| `graph.js` | 双图门面，re-export model / views / store |
| `model.js` | 领域模型：goal / intent / fact / finding / brief / analysis |
| `views.js` | 角色视图与查询：overview / plannerView / workerView / digest / delta / trace |
| `store.js` | 资源图、任务快照、全局索引 |
| `view-api.js` | 只读 Host Service `artex`：任务列表 / 任务快照（供视图插件） |
| `prompts.js` | planner / worker / analyst 提示词 |
| `report.js` | 最终报告渲染 |
| `tools.js` | 23 个模型工具的组合入口 |
| `tools/*.js` | 按域分组：control / read / planner / worker / analysis |
| `tools-shared.js` | 工具共享层：schema、artifact、presenter、会话与角色校验、run 参数 |

提示词走角色投影：`plannerView` 只留派意图、判目标要用的字段，`workerView` 只留「别重复、别越界」要用的字段；JSON 紧凑序列化，analysis 正文不在 JSON 里重复一遍。

### 工程化

- **CI**：`.github/workflows/test.yml`，push 和 PR 上跑 `npm test`（Node 22）。
- **许可证**：MIT。
- **版本约束**：`engines.dsh >= 0.1.6-alpha.2`。
- **UI presenter**：`artifact` 统一注入 `presentCall` / `presentResult`，23 个工具都有中文标题、调用 kind 和完成/失败状态。
- **打包**：`package.json` 的 `files` 覆盖全部运行模块、配置、图标、locale 和 LICENSE。

## 4.5 安全与可靠性

- `task_id` 走白名单，再加一层路径包含校验；非法 id 直接拒。
- 读权限默认按 owner 和子会话收紧，跨任务读取要显式打开开关。
- worker 只能写回自己领到的、正在运行的意图；批量写先整体校验再落图，失败不留半批。
- `prove_goal` 拒绝负结果（目标本身是负向结论时要显式 `allow_negative`）、拒绝重复证明、拒绝拿 blueprint 作证据；**`confidence=inferred` 的推断事实也不能作证据**，想证就得先派意图把推断升级成 observed/finding。
- **锚点硬校验**：意图的 `parents` 只能挂仍存在的 fact/finding，`resource_ids` 必须是已登记的资源 id；悬空引用整批拒绝，规划者按报错自纠。trim 证据淘汰保护集除了 `goals[].evidence` 还包括 brief/analysis 的 citations。
- **事实服务端去重**：规范化 summary（小写、折叠空白）命中近期 500 条窗口、且**结局相同**时才跳过；结局不同（audit 里"先判无、重测命中"）按新证据入库，并双向标注 `supersedes` / `supersededBy`，报告里能看出结论被翻过。
- **证据即时落盘**：fact/finding 写回立刻追加进 JSONL（不等合并写窗口），进程崩溃最多丢元数据指针，不丢已确认结论。
- 事实写回不触发规划轮，避免事实风暴把 `maxRounds` 烧完；目标、意图、发现这三类事件按角色唤醒。
- planner 瞬态失败按 `plannerRetries` + 错误分类退避重试（rate_limit 长冷却、context 类直接快速失败）；**子会话静默超时也计入重试**；持续失败且已经有事实时，以 `stopped` 收尾、保留现场。**态势投影构建失败走降级通道**：非强制轮不烧轮次直接跳过，连续 3 次才把错误交给收尾；强制轮用降级视图继续（planner 被提示只做收尾判定）。
- **worker 启动瞬态错误自动重排一次**（rate_limit/server/network 回炉 open，下一拍重领）；启动后 provider 返回 `error` 的停止原因归一化成 `blocked` 而不是误判成 no_evidence。
- **心跳查房**：在跑 worker 静默超过 2× 心跳先发自检提示，下个心跳仍静默则强制中断（记 `stopped`，可被 planner 重派）；只有真实子会话的写回/工具事件会重置静默时钟——引擎自己的巡检记录不算存活信号，否则中断永远不会发生。
- **预算夹逼**：子会话墙钟恒等于 `min(timeoutMs, 任务剩余预算)`，planner、worker、analyst 一视同仁；任务结束回收持久化层内存状态，启动落盘失败不留孤儿 runtime。
- worker 命名单调递增跨轮不重名；`activity.jsonl` 单卷超 64MB 轮转为 `activity.1.jsonl`；任务终态回收内存后不再追加 JSONL（避免已落盘 id 集被清空后整批重写）。
- 写工具（`artex_record_fact` / `artex_add_intent` / `artex_report_finding`）在锚点校验阶段可能**异步拒绝**（校验要读资源图），调用方必须 `await`。
- **`/api/artex` 来源校验**：回环地址只是必要条件——Host 必须是 `localhost`/`127.0.0.1`/`[::1]`（挡 DNS rebinding），Origin 缺省、`app:` 或与 Host 同源（含回环别名与端口漂移）才放行；跨站页面拿不到响应也发不出写请求。
- **workspace store 有上限**：按 cwd 缓存的 store 最多 32 个（LRU），有活任务或有待写内容的条目不淘汰；HTTP 的 `cwd` 只接受绝对路径。
- **列表不再按工作区总量读盘**：先按索引里的 `ownerSession` 过滤，只有索引缺失的才回退读 task.json；`loadMeta` 按 mtime 缓存。
- **撤回会连带回退目标**：`artex_retract_fact` 之后，凡是拿这条 fact 作证据的 goal 一律回退 `open`、清空 evidence，并在报告里标 `evidence_retracted`；节点本身留档。
- **恢复会重置轮次额度**：`artex_resume_task` 把 `round` 归零（累加 `resumes`）并解除终态写保护，恢复后产生的事实/发现照常追加 JSONL。
- 运行状态、usage、settling、降级原因这些字段都写进任务快照/报告（含 goal 的 prove 理由与证据结局），`facts/findings` 的累计真值与内存窗口分开计数并标 `truncated`；被取代/被撤回的事实会在 planner 视图、worker 视图与 digest 里标注。
- 索引写入用目录锁，锁内合并；`status` 的历史列表只列 owner 自己的任务。

---

## 5. 与 ARTEX 的差异

**有意做的简化**

- **goals 子代理**：ARTEX 建任务时先起一个 `goals` agent 抽约束、把目标拆成可核验的结果。这里省掉这一次模型调用，改由调用方直接给 `goals`、`constraints`（也可以退化成单目标）；约束照样以最高优先级注入两个角色。
- **资产图的程序化层级**：ARTEX 用程序算 `root_domain→subdomain→service→endpoint` 的父子关系和去重键。通用场景没有这种固定层级，这里退化成 `(type, key||name)` 去重加自由 `attrs`。
- **pause/resume**：用 `artex_stop_task` 加重新 `artex_start_task` 代替；DSH 的子会话本身也能用 `send_message` 续跑。
- **智能体边界**：ARTEX 靠数据库绑定实现「planner 看不到 worker 的工具」；这里用 spawn provider 的 `toolFilter` 在子会话作用域内收掉越界工具，再在 execute 里按会话身份校验一次。

**还没做的**

- reporter（发现后自动写 Markdown 报告）、retester（复测）、cold digest 冷压缩、coverage 覆盖度、跨任务只读继承（`source_task_ids`）、把 `steer_work`/`kill_work` 开放成 planner 工具（目前只由引擎在预算或停止时使用）、finding 与流量证据的绑定。

---

## 6. 测试

```powershell
node test/graph-smoke.mjs          # 图内核、视图、23 个工具 schema、presenter
node test/engine-smoke.mjs         # 完整闭环、usage、status/report、stop 守卫
node test/modes-smoke.mjs          # objective/audit、突破停兄弟、证明轮、analyst
node test/persistence-smoke.mjs    # 分片、JSONL 回填、合并写、索引
node test/security-smoke.mjs       # 读 ACL、策略一致性、配置归一化
node test/audit-regressions-smoke.mjs  # 审计回归
```

`test/engine-smoke.mjs` 用脚本化的假子会话驱动真实引擎：规划者按态势派意图，worker 写回事实和发现，规划者再用证据标记目标，最后断言 `status=completed`、写回计数、trace 检索命中，以及子会话确实收到了越界工具的 deny 列表。

---

## 7. 免责声明与合法使用

本项目是**编排框架**，本身不含漏洞扫描器、exploit 或攻击载荷。它负责调度子会话、汇总证据、维护计划；真正干活的是宿主提供的工具（Shell、文件读写、HTTP 等）。换句话说，**模型生成的每一条命令，都是以您的身份、在您的权限下执行的**。

### 可以用于

- 您拥有、或已拿到**书面授权**的系统、资产和代码仓库。
- 自建的实验环境、靶场、CTF，以及隔离的虚拟机或容器。
- 对自己项目的代码、配置、日志做只读审计和一致性核对。

### 不得用于

- 未经授权对任何第三方系统、网络、设备做探测、枚举、利用或数据获取。
- 绕过访问控制、规避审计，或在生产环境执行破坏性操作。
- 违反所在地区法律法规、云服务商条款，或所在组织安全策略的任何行为。

### 责任划分

- 使用行为及其后果由您自行承担。作者与贡献者不对误用、数据丢失、服务中断、合规处罚或任何间接损失负责。软件按 **MIT 许可**「按原样」提供，不附带任何明示或默示担保。
- **模型会出错**。它可能把「看起来像」当成「已验证」，也可能生成危险或不可逆的命令。执行前请自行复核，尽量在只读或一次性环境里跑。
- 任务产物放在 `.artex/`（事实、发现、证据、完整过程日志），可能含主机名、端口、路径、命令输出甚至凭据片段。**不要提交到公开仓库**，仓库自带的 `.gitignore` 已经忽略了 `.artex/`。

### 几条使用建议

- 用 `constraints` 写死边界（允许的网段和主机、禁止的操作、只读要求）。它会以最高优先级注入规划者和每个执行者，压过一切探索偏好。
- 用 `max_workers`、`max_rounds`、`budget_ms` 控制规模，别让它无止境地跑。
- 在隔离环境（虚拟机或容器）里用最小权限账户运行；对生产环境先 dry-run，再人工复核。
- 需要可核对的覆盖结论时用 `mode: "audit"`，并且去看报告里的「被中止或判死的路径」和未覆盖项，而不是只看一眼 `completed`。
