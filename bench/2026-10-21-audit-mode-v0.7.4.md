# v0.7.4 audit 模式实测

- 日期：2026-10-21
- 版本：v0.7.4
- 环境：同一台 Windows 主机、deepseek-flash、只读任务
- 参数：`max_workers=1`、`max_rounds=3`（前两项）/ `2`（防火墙）、`budget_ms=180000`、`worker_timeout_ms=120000`、`planner_timeout_ms=90000`、`settle_grace_ms=40000/30000`、`debounce_ms=300`
- 模式：`audit`；前两项 `view_mode=hybrid`，第三项强制 `view_mode=analyst`

## 原始结果

| Run | 任务 | 目标数 | 状态 | 用时 | 轮次 | 调用 | 输入 | 输出 | 合计 | 事实 | 发现 | 意图 | analyst |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | SMB 共享 | 1 | **completed** | 67s | 2 | 16 | 12,997 | 9,801 | 22,798 | 2 | 1 | done 1 / stopped 3 | 0 |
| B | LISTEN 端口 | 1 | **completed** | 89s | 2 | 18 | 15,609 | 15,530 | 31,139 | 4 | 1 | stopped 3 | 0 |
| C | 防火墙 × 445/3389 | 2 | **timeout** | 235s | 3 | 32 | 34,119 | 22,687 | 56,806 | 3 | 0 | done 2 / open 2 / stopped 1 | 1（5 calls / 7,754 tokens） |

任务 id：A `tmvhudacm8f0b`、B `tmvhuetomd10e`、C `tmvhuh177265a`。

## 与 objective 模式的成本对比

objective 数据来自同版本同任务的 A/B（每任务 2 次均值）：

| 任务 | objective 平均 token | audit token | 变化 | objective 平均用时 | audit 用时 | 变化 |
|---|---|---|---|---|---|---|
| SMB | 17,577 | 22,798 | **+29.7%** | 43.5s | 67s | +54.0% |
| LISTEN | 17,265.5 | 31,139 | **+80.3%** | 42s | 89s | +111.9% |
| 单目标均值 | 17,421.25 | 26,968.5 | **+54.8%** | 42.75s | 78s | +82.5% |

单目标 audit 平均多 **1.5 倍调用**（17 vs 12）、**2 倍事实**（3 vs 1），换来更完整的覆盖（绑定地址分布、PID 归因、双栈差异、默认/非默认共享划分）。

## 观察

### 1. 单目标 audit 稳定完成

A/B 两轮单目标都是 2 轮内完成，`goal_met` 收官，无遗留 open。brief 的覆盖地图能直接回答验收：

- SMB：共享均为默认配置（无非默认共享），`-Special $true/$false` 三路径口径一致（具体条目数略）。
- LISTEN：唯一端口 / 连接 / 绑定地址三类统计均已收敛，绑定以 loopback 为主、混有 wildcard 与少量 NIC 地址；两份工具输出的行数差异已逐条归因（具体计数略）。

### 2. 多目标交叉审计会超时

C 是 2 个验收目标（profile/规则概况 + 445/3389 交叉），180s 预算内只证了 goal1；goal2 因 3389 的 `intent#5` 一直 open 未领取，任务以 `timeout` 结束。没有把未覆盖写成覆盖，状态诚实。

- 说明 audit 的覆盖语义确实按 goals 收敛，不会为了"看起来完成"外推。
- 代价：2 目标 × 跨域 join 在 180s 内不够；应拆成两个单目标任务，或提高 `budget_ms/max_rounds`。

### 3. analyst 的价值与成本

C 强制 `view_mode=analyst`，analyst 跑 1 次（5 calls / 7,754 tokens，占 13.6%），指出：

- `intent#3` 已 done、命令成功，但**零 fact 写回**，属"跑过≠已验证"的伪覆盖；若直接 prove goal1 会因无证据失败。
- 待办状态与实际意图状态不一致；入站策略存在等效放通这一风险未写进 brief。

planner 随后新增 `intent#6` 重跑并写回 fact，goal1 才被证明。这是 analyst 在真实 audit 中抓到的有效问题，不是文案噪声。

A/B 两项都在 2 轮内完成，hybrid 的"每 3 轮"阈值没触发 analyst；**短 audit 不会为 analyst 付费**，符合默认设计。

### 4. 证据质量 vs 成本

audit 比 objective 多写事实（LISTEN 4 条 vs 1 条），但多出的部分是绑定分布、PID 映射、双栈归因等**覆盖证据**，不是重复结论。对需要"证明覆盖"的审计值得；对只问一个数字的任务，objective 更便宜。

## 局限

- 每项只跑 1 次（A/B 的 objective 基线是 2 次均值）；audit 方差未估计。
- C 的目标更宽、轮次/预算也不同，不能与 A/B 直接做严格同条件对比。
- C 超时后未重跑更大预算；结论是"当前参数下会超时"，不是"audit 不能完成"。
- analyst 只在 C 被强制触发；hybrid 的自然触发需要 ≥3 轮或 ≥8 条新事实，本轮 A/B 未覆盖。

## 结论

| 维度 | 结论 |
|---|---|
| 单目标 audit | 2/2 完成，2 轮内收官；成本比 objective +54.8%，换来更完整覆盖证据 |
| 多目标 audit | 1/2 目标完成，180s 超时；应拆任务或加预算 |
| analyst | 强制运行时占 13.6% token，抓到"已跑未写回"的伪覆盖，价值真实 |
| 默认 hybrid | 短 audit 不触发，不增加成本；长 audit 才有收益 |
| 建议 | 单目标 audit 用 `max_rounds=2`；跨域 2+ 目标拆成独立任务，或 `budget_ms≥300s` 并接受 analyst 开销 |
