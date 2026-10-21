# ARTEX 插件 v0.4.1 功能测试报告

- 日期：2026-10-21
- 环境：Windows / DSH 桌面版 / 插件 `@local/dsh-artex` v0.4.1（测试开始时为 v0.4.0，边界测试发现缺陷后修复并重装）
- 范围：自动化回归 + 在线工具链 + 真实模型端到端 + 持久化产物 + 边界错误

## 1. 自动化回归

5 个测试文件、10 个场景全部通过：

| 文件 | 场景 | 结果 |
|---|---|---|
| `graph-smoke` | 图内核、角色视图、brief/analysis、17 工具 schema、去重与 promote | PASS |
| `engine-smoke` | objective 闭环、usage、brief、已完成任务不可 stop | PASS |
| `modes-smoke` | 突破停兄弟、audit、max_rounds 证明轮、预算收尾证明、analyst 触发、no-hybrid | PASS |
| `persistence-smoke` | 快照不含 activities、JSONL 回填、合并写、资源并发去重、全局索引 | PASS |
| `security-smoke` | 跨任务读默认拒绝、`allowCrossTaskRead`、`config.mode`、策略一致性、配置归一化 | PASS |
| `prompt-size` | planner/worker 提示词体积基准 | PASS |

## 2. 在线生命周期（后台任务）

任务 `tmvhe9nny5814`（audit / hybrid）：

| 步骤 | 结果 |
|---|---|
| `artex_start_task` | 返回 task_id、快照目录、下一步提示 |
| `artex_task_status`（启动后 1s） | `running`，轮次 1，意图 0 |
| `artex_add_hint` ×2 | 注入 #2/#3，规划者被唤醒 |
| 10s 后 status | 轮次 2，2 条意图（1 running / 1 open），brief 已引用两条提示 |
| `artex_stop_task` | 3s 后状态 `stopped`，`finish_detail` 记录原因，子会话中断 |

## 3. 真实端到端

### 3.1 传统模式（objective + analyst:false）

任务 `tmvhea9ykaee3`：

- 结果：`completed`，16s，2 轮，7 次调用
- 用量：输入 7,937 / 输出 2,132 tokens
- 状态确认：`mode=objective`、`view_mode=planner`、`analysis_runs=0`
- 证据：1 条 fact（`pwsh "8*7"` → 56），goal#1 以 fact#3 证明
- 路径：1 条 pursue → `done/path_success`

### 3.2 审计 + 强制 analyst

任务 `tmvheaoak49ec`（audit / view_mode=analyst）：

- 结果：`completed`，91s，2 轮，19 次调用
- 用量：输入 18,749 / 输出 13,057 tokens
- 角色分布：planner 7 / worker 7 / **analyst 5**
- 产物：5 facts、1 finding、1 resource、28 步；`analysis_runs=1`
- analyst 实际发现问题：
  - brief 仍写“共享数量/清单未测 0/1”，与 fact#5/#6、finding#10 矛盾（过时）；
  - `fact#7` 把 `-Special $false` 的写法错误沉淀成“参数不可用”，结论过强；
  - trace 里已有 LanmanServer 运行状态，但未写回图。
- planner 在 brief 中记录：采纳措辞修正与冗余判断，驳回“必须先补主机上下文字段”的扩张建议，用 finding#10 收官。

## 4. 读工具

| 工具 | 验证 |
|---|---|
| `artex_graph_overview` | 返回 3 条意图、5 条事实（limit=5）、1 条发现、todos、stats |
| `artex_node_detail` | 返回 finding#10 完整 detail/evidence/resourceIds |
| `artex_trace` | `q=Get-SmbShare` 命中 15 条（planner brief、worker step/fact/finding、analyst、prove） |
| `artex_task_status` | 历史任务按 id 可读，`stopped`/`completed` 状态与 detail 正确 |

## 5. 边界与错误

| 用例 | 结果 |
|---|---|
| `artex_run_task` goal="" | 正确报错“goal 不能为空” |
| `artex_node_detail` id=99999 | 正确报错“节点不存在” |
| `artex_stop_task` 已完成任务 | **缺陷**：v0.4.0 返回“已请求停止”；已修为“不在运行中”（v0.4.1）并加回归测试 |
| 读权限/跨任务读取 | 自动化测试覆盖：默认拒绝、`allowCrossTaskRead` 放行 |

## 6. 持久化产物

| 任务 | 状态 | 快照 | activity.jsonl | activities in snapshot |
|---|---|---|---|---|
| `tmvhe9nny5814` | stopped | 4,805 B / 14 步 | 10,437 B | 否 |
| `tmvhea9ykaee3` | completed | 4,274 B / 13 步 | 6,196 B | 否 |
| `tmvheaoak49ec` | completed | 13,734 B / 28 步 | 23,146 B | 否 |

- 全局索引 `~/.dsh/artex-index.json` 含 4 条（含此前 v0.3.6 实测任务），均指向正确 cwd。
- 三个任务均可通过 `artex_task_status` 重新加载，说明快照 + JSONL 回填链路正常。

## 7. 发现的问题

| 严重度 | 问题 | 状态 |
|---|---|---|
| 中 | `stopTask` 只看 runtime 是否存在，不看 `finished`，已完成任务会返回成功并改写内存 `finishedStatus` | **已修 v0.4.1**，新增 engine 回归断言 |

## 8. 未覆盖 / 后续

- objective 的“兄弟路径停掉 + 保留现场”只有确定性测试，未在真实模型上强制复现。
- 多 worker 并发（>2）与真实跨 cwd 查询未在线演练（索引查找有单测）。
- hybrid 的“按触发”路径在 v0.3.3 实测过；本次用 `analyst` 强制模式覆盖 analyst 链路。
- 真实长任务（>5 轮、>100 步）未在 v0.4.x 重跑，快照体积上界仍建议后续用长审计验证。
- 角色越权调用未在真实子会话中演练（确定性测试覆盖工具层校验）。

## 结论

v0.4.1 功能测试通过：自动化 10 场景全绿；后台生命周期、传统 objective、audit+analyst、读工具、持久化与索引均按预期工作；边界测试发现并修复了 1 个 stop 守卫缺陷。
