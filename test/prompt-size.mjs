/**
 * 提示词体积基准：构造一个代表性任务，渲染 planner / worker 提示词并报告体积。
 * 用于每次改提示词后对比（v0.1 的基线：planner ≈3,918 / worker ≈2,944 token，
 * 均为 4 意图 / 20 事实 / 6 发现、美化 JSON 的旧实现估算）。
 *
 * 运行：node test/prompt-size.mjs
 */

import {
  createTask, addIntents, recordFact, reportFinding, addHint, setTodos,
  plannerView, workerView,
} from '../graph.js'
import { plannerPrompt, workerPrompt } from '../prompts.js'

const task = createTask({
  id: 't-bench',
  description: '提示词体积基准',
  goal: '对本机监听服务做只读安全评估并输出分级风险清单，覆盖远程访问与共享面',
  goals: [
    '清点本机 TCP/UDP 监听端口、绑定地址与对应进程',
    '识别远程访问与文件共享面的弱配置风险',
    '输出按严重度排序的风险清单与加固建议',
    '给出可复现的证据链与复测方法',
  ],
  constraints: ['仅测试本机地址', '全程只读', '禁止爆破与 DoS', '发现凭据只记录位置'],
  ownerSession: 's',
  cwd: 'C:/tmp',
  outDir: 'C:/tmp/.artex/tasks/t-bench',
  limits: {},
})

addIntents(task, [
  { summary: '枚举本机 TCP/UDP 监听端点与所属进程，标出绑定 0.0.0.0 的通配暴露项' },
  { summary: '采集防火墙各 profile 的入站策略与放通任意来源的规则' },
  { summary: '检查 RDP 的 NLA/安全层、远程登录权限与账户锁定策略' },
  { summary: '检查 SMB 签名、共享列表、guest 访问与目录 ACL' },
])
addHint(task, '优先看远程访问面，不要逐端口扫')
setTodos(task, [
  { content: '清点监听端口', status: 'completed' },
  { content: '核对防火墙规则', status: 'in_progress' },
  { content: '检查远程访问配置', status: 'pending' },
])

for (let i = 1; i <= 20; i++) {
  recordFact(task, {
    summary: `事实 ${i}：服务 X 的配置项 Y 为 Z，存在风险 W（示例摘要，用于测量提示词体积）`,
    detail: '展开细节：这一段是 detail，只在 node_detail 里出现。'.repeat(2),
    evidence: `命令 ${i} 输出关键行`,
    confidence: i % 3 ? 'observed' : 'inferred',
    intentId: 1 + (i % 4),
  })
}
for (let i = 1; i <= 6; i++) reportFinding(task, { title: `发现 ${i}：某项配置过宽`, severity: 'medium', intentId: 2 })
for (const intent of task.intents.slice(0, 3)) intent.state = 'done'

const cjk = s => (s.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
const est = s => Math.round(cjk(s) + (s.length - cjk(s)) / 4)

const planner = plannerPrompt({
  task,
  view: plannerView(task, { factsLimit: 12 }),
  triggers: [{ kind: 'done', intentId: 2, state: 'done', summary: '完成端口清点' }],
  round: 4,
})
const worker = workerPrompt({
  task,
  intent: task.intents[0],
  view: workerView(task, task.intents[0], { factsLimit: 5 }),
})

const rows = [
  ['planner 字符', planner.length, ''],
  ['planner 估算 token', est(planner), '(v0.1 基线 ≈3,918)'],
  ['worker 字符', worker.length, ''],
  ['worker 估算 token', est(worker), '(v0.1 基线 ≈2,944)'],
  ['worker 含 todos/constraints', /todos|constraints/.test(worker) ? '是' : '否', ''],
]
for (const [k, v, note] of rows) console.log(String(k).padEnd(28), String(v).padStart(8), note)

// 体积护栏：防止后续改动把提示词又养胖
if (planner.length > 6000) throw new Error(`planner prompt 超限: ${planner.length}`)
if (worker.length > 4000) throw new Error(`worker prompt 超限: ${worker.length}`)
if (/todos|constraints/.test(worker)) throw new Error('worker 视图不应再包含 todos/constraints')
console.log('OK prompt-size')
