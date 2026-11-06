# dsh-artex

[![test](https://github.com/Clever-rain/dsh-artex-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/Clever-rain/dsh-artex-plugin/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**把「目标 → 计划 → 并发执行 → 证据 → 报告」这条长链路，做成 DSH 里的一个插件。**

装上之后，模型多出 25 个 `artex_*` 工具和一套会话级开关。你给一个目标，它自己拆成意图、并发派子会话去做、把中间结论写成图上的事实与发现，最后按证据判定目标是否达成并输出报告。适合跨几十步、需要多路并发的任务：梳理一个陌生代码库、把接口文档和实现对齐、按覆盖清单做只读审计、整理一批资料的矛盾点。

> ⚠️ 这是一个**编排框架**，不含扫描器、exploit 或攻击载荷；但子会话会以你的身份执行宿主命令。请只用于自有或已获书面授权的环境，先读文末[使用边界](#使用边界与许可)。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [与 ARTEX 的关系](#与-artex-的关系)
- [环境要求](#环境要求)
- [安装](#安装)
- [在 DSH 里使用](#在-dsh-里使用)
- [工具清单](#工具清单)
- [配置](#配置)
- [数据落盘与上下文治理](#数据落盘与上下文治理)
- [已知边界与排障](#已知边界与排障)
- [开发与测试](#开发与测试)
- [使用边界与许可](#使用边界与许可)

---

## 它解决什么问题

一次长任务里，模型最容易坏在四件事上：忘了目标、重复劳动、结论散落在对话里、上下文越滚越大。dsh-artex 用四个机制对着治：

| 问题 | 机制 |
|---|---|
| 忘了目标 | 目标是图上的节点，只能用 fact/finding 逐条证明（`artex_prove_goal`），没证据就是没完成 |
| 重复劳动 | 每一步工具调用都索引进过程库，执行者之间能查「这条命令跑过没有」（`artex_trace`） |
| 结论散落 | fact / finding / resource 落成可检索的节点与血缘边，而不是只留在对话里 |
| 上下文爆掉 | 状态查询默认只回有界摘要，全量快照落盘给指针（见[上下文治理](#数据落盘与上下文治理)） |

它**不是**：扫描器、doom loop 防护、沙箱。边界控制仍由 DSH 的沙箱/审批/工具白名单负责，本插件只在这些边界之内做编排。

---

## 与 ARTEX 的关系

本插件是 [ARTEX](https://github.com/Autumn-27/ARTEX)（Go + Postgres 的多智能体系统）在 DSH 上的重写，而不是移植同一份代码：DSH 没有 goroutine，也没有数据库，但提供了子会话、工具注册表和会话事件流，足以复刻它的编排骨架。

### 继承的核心机制

| ARTEX 机制 | 在本插件里的形态 |
|---|---|
| 双图：每任务一张探索图 + 跨任务共享的资源图 | `.artex/tasks/<id>/` 下的图快照 + 跨任务 `resources.json`，节点类型 goal/intent/fact/finding/hint/resource 与血缘边保持一致 |
| planner 与 worker 的角色分离，且**规划者不动手** | 每轮一个 planner 子会话，只产意图/判目标；每条意图一个 worker 子会话，只做一件事并写回 |
| 边沿驱动唤醒 + 心跳巡检 | 事件入队后按 `debounceMs`（默认 800ms）合并成一拍；`heartbeatMs`（默认 600s）兜底防死锁，并复查静默的在跑 worker |
| frontier 领取（`priority DESC, id ASC`，CAS 抢占） | 意图按 `open → running` 单线程领取；子会话本身是单线的，天然没有竞态 |
| execution trace 复用 | `session/event` 里的 `tool/call`、`tool/result`、`assistant/message` 索引成过程库，`artex_trace` 支持关键字检索与取某几步原文 |
| planner 跨轮待办 | `task.todos` + `artex_set_todos`，每轮渲染进提示，串行链只派「前置已满足」的那一步 |
| `prove_goal` 作为唯一收官方式 | `artex_prove_goal`，默认只接受 observed 事实与 finding，推断结论必须先升级成证据 |

### 工程上的改写

| 差异点 | ARTEX | 本插件 |
|---|---|---|
| 并发单元 | planner/worker goroutine | `ctx.subagents` 子会话（`provider: spawn` 全新上下文，或 `fork` 继承） |
| 存储 | Postgres 双图 | `.artex/` 下的 JSON 快照 + JSONL 分片，可 git diff、可直接读，无外部依赖 |
| 角色工具绑定 | 数据库里按角色绑工具 | 子会话作用域内的 `toolFilter` 收掉越界工具，execute 里再按会话身份校验一次 |
| 建任务 | 先起 goals 子代理把目标拆成可核验结果 | 省掉这一次调用，由调用方直接给 `goals` / `constraints`（也可只有单目标） |
| 资源图去重 | 程序算 `root_domain→subdomain→service→endpoint` 层级 | 退化为 `(type, key‖name)` 去重 + 自由 `attrs`，因为通用场景没有固定层级 |

### 在 ARTEX 之外新增的

运行态审批门、独立 verifier 子会话、覆盖矩阵与收口、交战绑定与目标审查、证据脱敏、会话级开关（`/artex` + chip）、上下文治理（摘要 + 落盘指针）。这些是为了适配 DSH 长会话与多角色共用同一宿主的现实，不是 ARTEX 原有能力。

### 明确不做的

层级 planner（过早引入会把 planner/worker 的分工烧掉）、报告导出 HTML/SARIF、跨任务只读继承、把 `steer/kill` 开放成 planner 工具。路线是「编排做深，武器不带」。

---

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | `>= 0.1.6-alpha.2`（`package.json` 的 `engines.dsh`） |
| Node | 22 及以上（CI 跑 Node 22） |
| 外部服务 | 无（不依赖 Postgres/Redis/网络端口） |

---

## 安装

本仓库就是插件包的根目录：`package.json` 的 `dsh.bundle.patch` 指向同目录的 `cordis.patch.yml`。

### 方式一：在会话里让插件管理器装（推荐）

clone 到本机后，在 DSH 会话里让 agent 调用 `plugin_manager`：

```
action: install_bundle
target: <你 clone 的绝对路径>/dsh-artex-plugin
```

### 方式二：命令行装到指定 profile

```powershell
dsh plugin --profile <profile> add <你 clone 的绝对路径>\dsh-artex-plugin
```

装完重启 DSH（或让插件层重载），新会话即可看到 `artex_*` 工具。

### 升级

重新 `git pull` 后重装同一条命令即可；配置写在 profile 的 patch 层，升级不会覆盖。装好之后可以在插件页随时启停。

---

## 在 DSH 里使用

### 1. 跑一个任务

```
用 artex_run_task 做这件事：把 docs/ 下所有接口文档和实现对齐，找出不一致。
goals: ["列出所有不一致项", "给出每项的修复建议"]
constraints: ["只读，不修改代码"]
max_workers: 3
```

关键入参（`artex_run_task` 与 `artex_start_task` 共用）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `goal` / `goals` | 必填其一 | 单个目标或可核验的目标清单 |
| `constraints` | — | 最高优先级约束，注入 planner 与每个 worker（允许的主机/网段、禁止操作、只读要求） |
| `mode` | `objective` | `objective`=首个充分突破即收官；`audit`=覆盖最大化，正负结果都写回 |
| `max_workers` | 3 | 任务内并发 worker 数 |
| `max_rounds` | 24 | 规划轮次上限 |
| `budget_ms` | 0 | 任务墙钟预算（0=不限），子会话超时恒被它夹逼 |
| `max_tokens` | 0 | 任务 token 预算（input+output），超限先收尾再硬停 |
| `worker_timeout_ms` | 1200000 | 单 worker 预算 |
| `read_only` | false | 子会话收掉写/执行类宿主工具（edit/write/pwsh/terminal/workflow…） |
| `allowed_tools` | — | 子会话基础工具白名单；名单之外的同名工具一并收掉 |
| `allowed_paths` | — | 路径白名单，作为纪律注入所有子会话 |
| `allowed_targets` | — | 目标白名单（精确主机/后缀/IPv4/CIDR），越界按 `scope_enforcement` 处置 |
| `engagement` | — | 绑定交战：`.artex/engagements/<id>.json` 里的授权说明与时间窗 |
| `skill_packs` | — | 加载内置/自定义打法包（`recon`/`web-audit`/`report`，或 `.artex/skills/<name>.json`） |
| `depth` | 1 | worker 深挖档（1–3，仅 objective 的 pursue 生效；每阶段落检查点 fact 再推进） |
| `max_tokens_per_intent` | 0 | 单意图 token 上限（0=不限），超限先提醒收尾再硬停该 worker |
| `breakthrough_grace_ms` | 30000 | 某条 pursue 证明目标后，其它在跑 pursue 的收尾宽限 |
| `confirm` | — | goal 经确定性词表审查命中时，必须把 `confirm` 精确设为 goal 原文才能启动 |
| `campaign` | — | 归属战役 id，供跨任务聚合 |

**只想先看方案**：`max_workers: 0` —— 只跑一轮规划，返回意图清单，不派 worker。

**成本量级**：一轮规划 = 一个 planner 子会话，一条意图 = 一个 worker 子会话。3 轮 × 2 条意图的任务约 8 次模型调用；`enableVerifier` 开启后每落一条 finding 再多一次。

### 2. 两种模式怎么选

| mode | 目标函数 | 意图类型 | 完成判据 |
|---|---|---|---|
| `objective`（默认） | 首个充分突破 | `pursue`：追一条路径，成功即停；失败写 `outcome=none` 再回溯 | 目标有证据支撑 |
| `audit` | 覆盖最大化 | `enumerate`：逐项验证，命中了也不停，正负结果都写回 | 每个覆盖维度都有证据 |

`objective` 的路径是棵树：pursue 可带 `path_parent`，某条路径判死后规划者沿它向上找「还有未尝试 blueprint 的祖先」，从那儿派下一条（`artex_promote_intent` 把 blueprint 提升为 open）。任意一条 pursue 证明目标后引擎冻结派发，给其它在跑的 pursue 发「停止并回报」，等 `breakthrough_grace_ms` 后硬停——它们的事实与发现保留，报告里单列「被中止或判死的路径」。


### 3. 长任务怎么盯

后台跑（`artex_start_task`）之后，**不要反复拉全量状态**——那正是上下文膨胀的来源：

| 想知道 | 用什么 |
|---|---|
| 现在到哪了 | `artex_task_status(task_id)`：有界摘要（默认 ≤4000 字符）+ 全量快照落盘路径 |
| 要更细 | `artex_graph_overview(task_id, facts_limit=30)` 看态势投影；或直接 read/grep 落盘文件 |
| 某个节点 | `artex_node_detail(task_id, node_id)` |
| 某一步干了什么 | `artex_trace(task_id, query=...)` / `artex_trace(task_id, intent_id, step_ids=[...])` |
| 覆盖缺口 | `artex_coverage_report(task_id)`（audit 收口前必看） |
| 在环纠偏 | `artex_add_hint(task_id, hint)` —— 立即唤醒 planner |
| 停下来 | `artex_stop_task(task_id, mode="stop")`；`mode="pause"` 保留现场，之后 `artex_resume_task(task_id, budget_ms)` 续跑 |

### 4. 审批

高风险动作可以要求人工裁决：planner 派意图时带 `requires_approval: true`，或 worker 自查后调 `artex_request_approval(reason, action)` 挂起本轮。你在会话里用 `artex_resolve_approval(intent_id, approve|reject, note)` 裁决，批示会注入重新派发的 worker 提示词；`pending_approvals` 在状态、态势与报告里都可见。

### 5. 会话级开关

```
/artex on | off | status
```

或在输入框左侧点 **🧭 ARTEX chip**。off 之后本会话发起的 `artex_*` 调用会被 `tools.guard` 拦下并提示重开；**已经在跑的任务不受影响**（它们由子会话写回）。状态存在 profile 级 `~/.dsh/artex-session-flags.json`，默认开。

同一份状态也通过 `POST /api/artex` 暴露给本地消费方（`state {sessionId, cwd?}` 取开关与任务摘要，`setEnabled` 切换）——只接受回环来源，Host 必须是 `localhost`/`127.0.0.1`/`[::1]` 且 Origin 同源，用来挡 DNS rebinding 与跨站写请求。

### 6. 结果去哪了

`artex_run_task` 直接返回报告；后台任务用 `artex_task_status` 看摘要与结束原因，报告正文由引擎在收官时渲染（目标达成与证据、发现按 verified/open/rejected/needs_retest 分组、被中止或判死的路径、覆盖矩阵、成本分解）。落盘文件都在 `.artex/tasks/<id>/`，可以自己读或交给下游插件。

---

## 工具清单

25 个工具，按「谁能调」分三档：所有者会话、planner/analyst/verifier 子会话、worker 子会话。越界调用会被身份校验拒绝，而不只是提示词劝阻。

| 工具 | 作用 | 可调用角色 |
|---|---|---|
| `artex_run_task` | 前台跑完整编排，返回报告（阻塞） | 所有者 |
| `artex_start_task` | 后台启动，立即返回 task_id | 所有者 |
| `artex_task_status` | 状态摘要（有界）+ 快照落盘指针；`detail:"full"`、`sections`、`findings_limit`、`max_chars` 可调 | 所有者 / 任务子会话 |
| `artex_stop_task` | `mode=stop` 终止；`mode=pause` 暂停保留现场 | 所有者 |
| `artex_resume_task` | 重挂 paused/stopped 任务续跑（必须重给 `budget_ms`） | 所有者 |
| `artex_add_hint` | 注入战略提示，立刻唤醒规划者 | 所有者 |
| `artex_graph_overview` | 态势投影（默认 facts 10 条；`sections` 过滤；超 `max_chars` 落盘 `overview_latest.json`） | 所有者 / 任务子会话 |
| `artex_node_detail` | 某个节点的完整内容与证据 | 任意（按读权限） |
| `artex_trace` | 列出 work / 关键字检索过程 / 取某几步原文 | 任意（按读权限） |
| `artex_add_intent` | 派意图（≤4；`kind`=pursue/enumerate，`state`=open/blueprint，支持 `depends_on`） | planner |
| `artex_plan` | 一轮结构化计划：`{decision, todos, intents≤12, proofs}` 一次提交 | planner |
| `artex_promote_intent` | 把 blueprint 提升为 open | planner |
| `artex_set_brief` | 整体替换跨轮全局认知 brief | planner |
| `artex_set_todos` | 整体替换跨轮规划待办 | planner |
| `artex_prove_goal` | 用 fact/finding 证明目标（`allow_inferred` / `allow_negative` 需显式放行） | planner |
| `artex_retract_fact` | 撤回事实（留档、不可再作证明，引用它的目标回退 open） | planner |
| `artex_record_fact` | 写回结论（`outcome=found` 必给 evidence） | worker |
| `artex_report_finding` | 登记已验证成果（evidence 硬门；`evidence_refs` 可绑步骤与工件 sha256） | worker |
| `artex_add_resource` | 登记跨任务复用的资源/实体 | worker / planner |
| `artex_record_conflict` | 两条相反结论落成结构化冲突 | worker / analyst / planner |
| `artex_request_approval` | 高风险动作申请人工审批（挂起意图） | worker |
| `artex_resolve_approval` | 裁决待审批意图（approve/reject） | 所有者 |
| `artex_set_analysis` | 提交独立分析（只读输入，不改 brief） | analyst |
| `artex_retest_finding` | finding 复测闭环（open → verified/rejected/needs_retest） | verifier / planner |
| `artex_coverage_report` | 确定性覆盖矩阵（audit 收口前查缺口） | 任意（按读权限） |

### 角色分工

| 角色 | 做什么 | 工具面 |
|---|---|---|
| 所有者会话 | 下目标、给约束、在环纠偏、看报告 | 全部 25 个 |
| planner（每轮一个新子会话） | 读态势 → 判目标 → 派意图 / 更新待办 | 派意图、证明目标、待办与 brief |
| worker（每条意图一个新子会话） | 只做这一条，边发现边写回 | 写事实/发现/资源 + 读工具 |
| analyst（可选，周期性） | 只读重综合，输出一致性检查与优先级建议 | 只读 + `artex_set_analysis` |
| verifier（`enable_verifier: true`） | 复核每条 finding | 只读 + `artex_retest_finding` |

---

## 配置

写在 profile 的 `cordis.patch.yml`（或插件行 config）里，随时可改；改完对新会话生效。

| 键 | 默认 | 含义 |
|---|---|---|
| `provider` | `spawn` | 子会话 provider：`spawn` 全新上下文 / `fork` 继承上下文 |
| `maxWorkers` | 3 | 任务内并发 worker |
| `maxRounds` | 24 | 规划轮次上限 |
| `maxStalls` | 2 | 连续空转多少轮后停 |
| `debounceMs` | 800 | 边沿合并窗口 |
| `heartbeatMs` | 600000 | 巡检间隔 |
| `workerTimeoutMs` | 1200000 | 单 worker 预算 |
| `plannerTimeoutMs` | 900000 | 单轮 planner 预算 |
| `budgetMs` | 0 | 任务总预算（0=不限） |
| `mode` | `objective` | 默认模式：`objective` / `audit` |
| `viewMode` | `hybrid` | 全局视野：`planner` / `hybrid` / `analyst` |
| `enableHybrid` | true | hybrid 总开关，false 强制 planner |
| `enableVerifier` | false | 每条 finding 派 verifier 复核（多一次调用） |
| `analystEveryRounds` | 3 | audit 每 N 轮触发一次 analyst |
| `analystFactThreshold` | 8 | 新增事实达到 N 条触发 analyst |
| `analystMaxRuns` | 4 | 单任务 analyst 运行上限 |
| `analystCooldownMs` | 30000 | analyst 冷却 |
| `analystTimeoutMs` | 180000 | 单次 analyst 预算 |
| `saveDebounceMs` | 500 | 快照合并写延迟 |
| `plannerRetries` | 2 | planner 瞬态失败重试 |
| `settleGraceMs` | 90000 | 收尾宽限 |
| `isolateWorkdir` | false | worker 是否在 `.artex/tasks/<id>/i<n>` 独立 cwd 工作 |
| `allowCrossTaskRead` | false | 是否允许跨 owner/角色读取任务 |
| `scopeEnforcement` | `warn` | 目标越界处置：`warn` / `stop` / `off` |
| `redactEvidence` | true | 证据写回脱敏（口令/token/私钥打码） |
| `gitIgnoreGuard` | true | 启动时把 `.artex/` 补进所在 git 仓库的 `.gitignore` |
| `maxTokensPerIntent` | 0 | 意图级 token 预算（0=不限） |
| `requireEngagement` | false | 是否要求所有任务绑定交战 |

**视野策略怎么选**：`planner` 最省；`hybrid`（默认）按条件触发 analyst，长审计里用于纠偏；`analyst` 每轮都跑，最贵。传统非审计用法 = `mode:"objective"` + `view_mode:"planner"`。

---

## 数据落盘与上下文治理

### 目录结构

```
<workspace>/.artex/
  resources.json                        # 跨任务资源图（按 type + key‖name 去重）
  engagements/<id>.json                 # 交战：授权说明、目标集、时间窗
  skills/<name>.json                    # 自定义打法包 {prompt, tools[]}
  tasks/<taskId>/
    task.json                           # 元数据 + 图状态（goals/intents/hints/todos/stats）
    facts.jsonl  findings.jsonl         # 结论与发现（追加写，超上限压实）
    activity.jsonl                      # 全量过程日志（单卷 64MB 轮转）
    status_latest.json                  # 最近一次状态查询的完整快照
    overview_latest.json                # 最近一次超限态势投影
```

另有 profile 级 `~/.dsh/artex-index.json`（`taskId → cwd` + owner，最多 500 条，支持跨工作区按 id 找任务）与 `~/.dsh/artex-session-flags.json`（会话开关）。

### 上下文治理：运行态外置

长任务监控最容易把上下文灌爆，因为插件会把服务端已经落盘的状态每次全量倒进会话。这里改成「会话只放指针」：

| 工具 | 默认行为 | 要全量时 |
|---|---|---|
| `artex_task_status` | 有界摘要（≤4000 字符，典型 1–2KB），完整快照尽力写 `status_latest.json` | `detail:"full"` 强制写成功并返回路径+字节数；`sections` 选块，`findings_limit` 控标题条数，`max_chars` 是硬上限 |
| `artex_graph_overview` | `facts_limit` 默认 10，`max_chars` 默认 6000 | 超限时把完整投影原子写到 `overview_latest.json`，返回 `{truncated, bytes, file, preview}` 可解析包装 |

永不裁剪的字段（防退化）：状态、轮次、goals 达成数、发现数量+标题+severity、`pending_approvals`、结束原因、brief 版本号与落盘路径、以及「按 id / 读文件取细节」的通道。

### DSH 侧压缩（可选，按需调）

长任务还建议把 DSH 自身的压缩阈值调紧，命中前就压，而不是等窗口打满：

- `compaction-basic`：`thresholdRatio: 0.5`、`retainRatio: 0.16`；
- `tool-result-pruner`：`thresholdChars: 4096`、`headChars: 2048`、`tailChars: 512`；
- 模型行显式给 `contextWindow` / `maxTokens`（例如 512K 窗口配 8K 输出）。

注意两点：压缩配置属于 DSH 的 preset/profile 层，写在插件 config 里无效；`contextWindow` 要按你实际使用的模型与上游真实窗口填，别照抄数字。

---

## 已知边界与排障

**边界**

- 不是抢占式拦截：`allowed_targets` 是「检测 + 提醒 + 可停任务」，真正的边界靠 `read_only` / `allowed_tools` 与 DSH 沙箱。
- audit 的「覆盖闭合」靠目标证据实现，属于约束级而非引擎强制：报告里要看覆盖矩阵与未覆盖项，别只看 `completed`。
- 插件重载会清空进程内任务状态；历史快照仍在 `.artex/tasks/<id>/`，可按 id 重新读。
- 跨会话读取默认关闭；`allowCrossTaskRead: true` 才放开。
- `.artex/` 可能含证据原文（主机名、端口、命令输出片段），不要提交到公开仓库——`gitIgnoreGuard` 会尽力补 `.gitignore`，但别依赖它。

**排障**

| 现象 | 先查 |
|---|---|
| 看不到 `artex_*` 工具 | 插件是否安装并启用；profile 是否重启过；会话是否被 `/artex off` 关掉 |
| 任务起了但不动 | `artex_task_status` 看 `pending_approvals` 与结束原因；`artex_trace` 看子会话是否报错 |
| 子会话什么都没干 | 检查 `allowed_tools` / `read_only` 是否把需要的工具收掉了 |
| 反复跑同一条命令 | 让 planner 先 `artex_trace(query=...)` 查过程库；或收紧 `constraints` |
| 越跑越贵 | 设 `budget_ms` / `max_tokens` / `maxTokensPerIntent`；`view_mode:"planner"` 省掉 analyst |
| 状态输出被截断 | 这是预期行为；读 `status_latest.json` 全文 |

---

## 开发与测试

```
index.js / engine.js        插件入口、任务生命周期、注册表与存储
scheduler.js / runner.js    主循环、规划轮、派发 worker、子会话 spawn/等待/中断
graph-ops.js / graph.js     图操作与双图门面（model / views / store）
model.js / store.js         领域模型（goal/intent/fact/finding/brief/analysis）、资源图与快照存储
views.js / reporting.js     角色视图（planner/worker 投影）、状态与报告
report.js                   收官报告渲染
policy.js                   TOOL_NAMES + 角色白名单（拒哪些工具的唯一事实来源）
config.js                   默认值与 normalizeConfig（未知键/非法枚举显式告警）
usage.js                    按角色累计 provider usage
session-indexer.js          子会话事件索引成过程库
tools/*.js                  工具实现，按域分组：control / read / planner / worker / analysis
tools/status-format.js      上下文治理：摘要渲染、原子写、输出硬上限
prompts.js                  三类角色提示词
view-api.js                 只读 Host Service，供视图插件读任务列表/快照
```

```bash
node test/graph-smoke.mjs               # 图内核、视图、25 个工具 schema、presenter
node test/engine-smoke.mjs              # 完整闭环、usage、status/report、stop 守卫
node test/modes-smoke.mjs               # objective/audit、突破停兄弟、证明轮、analyst
node test/persistence-smoke.mjs         # 分片、JSONL 回填、合并写、索引
node test/security-smoke.mjs            # 读 ACL、策略一致性、配置归一化
node test/audit-regressions-smoke.mjs   # 审计回归
node test/status-output-smoke.mjs       # 上下文治理：摘要体积/落盘/sections/max_chars
node test/view-api-smoke.mjs            # 只读 service 的任务列表与快照
node test/roadmap-smoke.mjs             # 防线/审计/能力/运营各层回归
```

`npm test` 串起全部九项；CI 在 push 与 PR 上跑 Node 22。测试里的子会话是脚本化假实现，不需要真实模型调用。

---

## 使用边界与许可

本项目是**编排框架**：不含扫描器、exploit 或攻击载荷；真正干活的是宿主提供的工具，**模型生成的每条命令都以你的身份、在你的权限下执行**。

可以用于：自有或已获书面授权的系统与代码仓库；自建靶场、CTF、隔离虚拟机；对自己项目的只读审计与一致性核对。

不得用于：未授权对第三方系统做探测/枚举/利用/取数；绕过访问控制或规避审计；违反法律法规、云服务商条款或组织安全策略的行为。

责任划分：使用后果由使用者承担；软件按 MIT「按原样」提供，不附带担保。**模型会出错**——它可能把"看起来像"当成"已验证"，也可能生成不可逆命令，执行前请复核，尽量在只读或一次性环境里跑。

几条实践建议：用 `constraints` 写死允许的网段/主机与禁止操作；用 `budget_ms`、`max_rounds`、`max_workers` 控制规模；生产环境先 dry-run；需要可核对结论时用 `mode:"audit"` 并读覆盖矩阵。

---

MIT © 见 [LICENSE](LICENSE)。上游项目：[ARTEX](https://github.com/Autumn-27/ARTEX)；宿主：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
