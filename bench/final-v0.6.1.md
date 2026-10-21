# ARTEX v0.6.1 最终测试报告

- 日期：2026-10-21
- 版本：v0.6.1
- 范围：engine/graph/tools 最终分层、report 拆分、CI/LICENSE/engines、UI presenter、在线全链路

## 1. 本轮完成项

| 项 | 结果 |
|---|---|
| engine 剩余职责拆分 | `engine.js` 395 行；新增 `graph-ops.js` 192、`reporting.js` 58、`session-indexer.js` 57 |
| 报告渲染拆分 | `report.js` 54 行；`prompts.js` 保留 re-export，调用方不变 |
| CI | `.github/workflows/test.yml`，push/PR 跑 `npm test`（Node 22） |
| LICENSE | MIT |
| engines.dsh | `>=0.1.6-alpha.2`（当前 DSH 0.1.6-alpha.2） |
| UI presenter | 17 个工具统一注入 `presentCall` / `presentResult`（中文标题、kind、完成/失败） |

## 2. 自动化

| 项 | 结果 |
|---|---|
| 语法检查 | 25 个模块全部通过 |
| `graph-smoke` | PASS（含 presenter 形状断言） |
| `engine-smoke` | PASS（含 status / report / stop 守卫回归） |
| `modes-smoke` | PASS（6 场景） |
| `persistence-smoke` | PASS |
| `security-smoke` | PASS |
| `prompt-size` | PASS（planner 2,190 / worker 1,293 tokens） |
| 打包清单 | 26 项，无缺失；含全部新模块与 LICENSE |

## 3. 在线全链路

任务 `tmvhfo7f98c3e`（Windows 版本与 build，audit / view_mode=analyst）：

| 指标 | 值 |
|---|---|
| 结果 | **completed** |
| 用时 / 轮次 / 调用 | 156s / 2 / 29 |
| 用量 | 输入 24,512 / 输出 27,358 tokens |
| 角色分布 | planner 8 / worker 12 / **analyst 9** |
| 产物 | 4 facts、1 finding、40 步、`analysisRuns=2` |

analyst 实际发现：

- brief 覆盖地图仍写“未测 0 条候选源”、事实库为空，但 fact#4–#7/finding#8 已存在；
- `finding#8` 称“CIM + 注册表 UBR + cmd ver 三方一致”不实：CIM 与注册表 UBR 口径不一致（具体构建号略），仅注册表 UBR 与 `cmd /c ver` 可证；
- 注册表 32 位视图中的旧产品名、kernel/HAL 不同构建分支未在交付口径中解释。

planner 采纳 brief 重建、UBR 口径与收尾建议，驳回重复补测，用 fact#4 证明目标。

## 4. 持久化

任务 `tmvhfo7f98c3e`：

- `task.json` 17,348 B / 40 步，**不含 activities**
- `activity.jsonl` 35,420 B（唯一过程副本）
- 全局索引包含该任务；重载 status 正常
- `artex_task_status` 在 v0.6.1 线上验证通过

## 5. 本轮发现并修复

| 版本 | 问题 | 状态 |
|---|---|---|
| v0.6.0 | `reporting.js` 漏导入 `openIntents` / `runningIntents`，线上 `artex_task_status` 报错 | **v0.6.1 已修**；`engine-smoke` 增加 status/report 回归；线上复核通过 |

## 6. 验证限制

- UI presenter 只有单元断言（`presentCall`/`presentResult` 形状与标题）；Host 的 Tool 检查接口不暴露 presenter，未做真实 Web 卡片截图验证。
- 多 worker（>2）、真实跨 cwd 查询、角色越权子会话仍未在线演练；确定性测试覆盖。
- 长任务（>5 轮 / >100 步）未在本轮重跑。

## 结论

v0.6.1 最终测试通过：25 个模块、10 个自动化场景、26 项打包清单全部正常；在线 audit+analyst、status/report、持久化与索引均工作；本轮唯一缺陷（reporting 导入遗漏）已修复并补回归。
