# ARTEX v0.5.1 结构拆分后测试报告

- 日期：2026-10-21
- 版本：v0.5.1（engine/graph/tools 分层重构完成）
- 目的：确认纯结构拆分没有改变行为，并验证打包与在线链路

## 1. 静态与自动化

| 项 | 结果 |
|---|---|
| 语法检查 | 21 个模块全部通过（engine / runner / scheduler / analyst / usage / util / graph / model / views / store / tools / tools-shared / tools/* / config / policy / index） |
| `graph-smoke` | PASS（17 工具、图内核、视图、schema、去重） |
| `engine-smoke` | PASS（闭环、usage、brief、已完成任务不可 stop） |
| `modes-smoke` | PASS（突破停兄弟、audit、max_rounds 证明轮、预算收尾证明、analyst、no-hybrid） |
| `persistence-smoke` | PASS（快照无 activities、JSONL 回填、合并写、资源并发、索引） |
| `security-smoke` | PASS（读权限、策略一致性、配置归一化、控制工具执行） |
| `prompt-size` | PASS（planner 2,190 / worker 1,293 tokens，与拆分前一致） |

## 2. 打包完整性

- `package.json` 的 `files` 共 21 项，显式文件全部存在。
- `tools/` 下 5 个分组模块齐全：analysis / control / planner / read / worker。
- 未发现漏包文件。

## 3. 在线回归

### 3.1 历史任务读取

- `artex_task_status(tmvheaoak49ec)` 成功从快照 + 全局索引重载。
- 返回 mode、view_mode、brief、analysis、usage by_role、goals、intents、findings 等完整字段。

### 3.2 真实 audit + analyst

任务 `tmvhf4es88b47`（445 监听检查，audit / view_mode=analyst）：

| 指标 | 值 |
|---|---|
| 结果 | **completed** |
| 用时 / 轮次 / 调用 | 95s / 2 / 19 |
| 用量 | 输入 19,070 / 输出 12,754 tokens |
| 角色分布 | planner 8 / worker 7 / **analyst 4** |
| 产物 | 2 facts、1 finding、1 resource、22 步、`analysisRuns=1` |

analyst 实际发现：

1. brief 覆盖地图写“0/3、无事实”，与 fact#6/#7、finding#8 矛盾（严重过时）；
2. `fact#7` 把方法学确认标成 `inconclusive`，会让 audit 覆盖统计漏项；
3. todo 仍把已完成交叉验证标为 in_progress；
4. finding#8 的“对整个网络可达”越界，只说绑定了全部接口，未查防火墙。

planner 采纳了 1/2/4，驳回重复派发 #3/#4/#5，并用 fact#6 收官。

### 3.3 读工具与控制面

| 工具 | 结果 |
|---|---|
| `artex_graph_overview` | 返回意图、事实、发现、todos、stats |
| `artex_trace(q=445)` | 命中 5 条（planner brief/result、worker start/step） |
| `artex_stop_task`（已完成任务） | 正确返回“任务不在运行中”（v0.4.1 守卫仍生效） |

### 3.4 持久化

任务 `tmvhf4es88b47`：

- `task.json` 15,236 B / 22 步，**不含 activities**
- `activity.jsonl` 21,399 B（唯一过程副本）
- 全局索引 6 条，包含该任务
- 重载正常，说明 model/views/store 拆分后路径无回归

## 4. 拆分期间发现的问题

| 版本 | 问题 | 状态 |
|---|---|---|
| v0.5.0 | `tools/control.js` 漏导入 `callerOf`，线上 `artex_task_status` 报错 | **v0.5.1 已修**，补控制工具执行回归测试，线上复核通过 |

## 5. 未覆盖项

- 多 worker（>2）并发未在线演练（确定性测试覆盖 2 worker）。
- 真实跨 cwd 查询未演练（索引查找有单测；历史任务同 cwd 重载已验证）。
- objective 兄弟路径停止未在真实模型上强制复现（确定性测试覆盖）。
- 角色越权未在真实子会话演练（工具层单测覆盖）。
- 观察到一个小体验问题：目标已达成后 planner 偶尔留下 `in_progress` todo（不影响任务状态，属规划者记忆卫生）。

## 结论

v0.5.1 结构拆分后功能测试通过：21 个模块语法与打包完整，10 个自动化场景全绿，在线 audit+analyst、读工具、stop 守卫、持久化与索引均正常；除拆分过程中的一个导入缺陷（已修复）外，未发现行为回归。
