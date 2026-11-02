# Super-agent 设计模式移植（dsh-superagent → dsh-artex）

来源：`Autumn-L1/dsh-superagent`（Router/Worker 事件驱动原型）与 DeepSeek 官方文章
《Super-agent：让 agent 走出 chat 框》。本文档记录把其中四个关键设计模式移植进
dsh-artex 的映射决策。实现见 `effects.js` / `triggers.js` 与 engine/scheduler/graph-ops 的接线。

## 1. 两级过滤（two-stage filter）→ `triggers.js` + `artex_emit`

| superagent | dsh-artex |
|---|---|
| Source（GitHub/飞书轮询）产出 Trigger | 新工具 `artex_emit`（owner-only）接收外部触发：CI 钩子、定时器、人工上报、其它会话 |
| 第一级：确定性 admission gate（发送者白名单/范围/dedup/自循环过滤） | `admitTriggers()` 纯函数：schema 校验 → 内容哈希去重 → trigger_mode 闸门（off/observe/auto）→ 速率上限（20 条/10 分钟/任务）→ scope 过滤（`guard.scopeCheck` 复用任务 allowedTargets） |
| 第二级：Router LLM 评估（eval，observe/auto 模式） | planner 就是第二级：准入的 trigger 持久化为 `task.triggers[]`（status=pending）并唤醒规划者；规划者用 `artex_add_intent(trigger_id=...)` 接单，或 `artex_decide_trigger ignore` 忽略；每个 trigger 终态都有 decision 记录（accepted/ignored/observed/rejected），可审计 |
| observe 模式：评估留档但不接单 | `trigger_mode=observe` 时 trigger 仅记录 + 唤醒评估，`addIntents` 带 trigger_id 会被拒（强制只研判不接单） |

触发 id 去重键：`sha1(kind|source|text)`，与 superagent 的 Trigger ID 去重同理
（轮询游标抖动/重投不重复接单）。

## 2. 订阅直通（subscription direct delivery）→ hint 路由

| superagent | dsh-artex |
|---|---|
| 已订阅 thread 的消息不进 Router，直投绑定 Session（省 ~37% token） | `artex_add_hint` 新增 `intent_id`（或文本前缀 `#<n>` 自动解析）：目标意图在跑时**直接 nudge 该 worker 子会话**，不唤醒 planner；planner 下一轮自然苏醒时在 hints/activity 里看到路由记录 |
| 直通不等于隐身：Router 事后可见 | 直通提示照常落 `task.hints` 与 activity（kind=hint-routed），只是不触发昂贵的 planner 轮 |

效果：对单个 worker 的人在环路纠偏成本从「一整轮 planner 唤醒」降为「一次 sendMessage」。

## 3. Mandate / Policy 版本化 → `task.policyRev` + `artex_update_policy`

| superagent | dsh-artex |
|---|---|
| Ticket 携带 Mandate，由接单时的 Policy 版本签发 | 意图创建时盖章 `mandateRev = task.policyRev` |
| Policy 变更 → 旧 Mandate 失效，新工作需重新接单 | `artex_update_policy`（owner-only）热更新 constraints/allowed_targets/allowed_tools/read_only/trigger_mode，`policyRev+1`；领取闸（dispatchWorkers）发现 `mandateRev !== policyRev` 的意图 → 终结为 `stopped/mandate_revoked` 并唤醒规划者重新派单 |
| 审批授权随 Mandate 失效 | 待审批意图的 approval 盖章同一 rev；策略变更清空 pending approvals（回到 open，worker 重派后需重新申请） |
| 运行中 worker 的 ticket 写操作被拒 | ARTEX 选择更软的语义：mandate 管「执行授权」（派发闸），不管「记忆写回」——在跑 worker 的 facts/findings 仍受理（证据不因授权变更而失效），但它会收到策略变更 nudge |

## 4. Effects 队列（持久化副作用 outbox）→ `effects.js`

| superagent | dsh-artex |
|---|---|
| effect 表：副作用先落库，pump 按序执行，崩溃恢复重放 | `.artex/tasks/<id>/effects.jsonl`：`emitEffect` 先落 pending 再投递；pump 串行、按 key 幂等；`resumeTask` 重挂时重放 pending |
| Channel 投递（GitHub 评论/飞书回复） | 投递器按 kind 注册：`owner-notice`（给所有者会话发消息）、`log`（落过程库即成功）。任务完成/发现/审批请求等所有者通知全部走 outbox——所有者会话已关闭也不丢，重启后补投 |

## 明确不移植的

- **Router/Worker 两层 agent 角色**：ARTEX 已有 planner/worker 分工，语义不同但骨架同构，不需要第二套。
- **Inline & Spill recall**：ARTEX 的 facts/findings JSONL + trim 策略已覆盖。
- **Watchdog 控制环**：ARTEX 的 checkStalledWorkers + heartbeat 巡检等价。
- **Source 轮询循环本身**：artex 不做 GitHub/飞书连接层；`artex_emit` 是开放的触发入口，
  任何外部轮询器（cron、CI、其它插件）都能把事件推进来。

## 测试

`test/patterns-smoke.mjs`：outbox 幂等与重放、hint 直通路由、trigger 准入（去重/模式/速率/scope）、
mandate 版本吊销。随 `npm test` 运行。
