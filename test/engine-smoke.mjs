import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtexEngine, DEFAULTS } from '../engine.js'
import { searchTraces } from '../graph.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const root = await mkdtemp(join(tmpdir(), 'artex-engine-'))
const warnings = []
let engine
let seq = 0
const prompts = []

const subagents = {
  list: () => ['spawn'],
  getProvider: () => ({ capabilities: { agentOptions: true } }),
  async startActivation(spec) {
    const childId = `child-${++seq}`
    const isPlanner = spec.label.includes('planner')
    prompts.push({ childId, label: spec.label, prompt: spec.request.prompt[0].text, deny: spec.request.toolFilter?.deny?.length ?? 0 })
    const result = new Promise((resolve) => {
      setTimeout(() => {
        const role = engine.roles.get(childId)
        assert.ok(role, `role missing for ${childId}`)
        const task = engine.liveTask(role.taskId).task
        // 模拟 provider usage 事件，验证任务成本统计
        engine.handleSessionEvent(
          { header: { id: childId } },
          {
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: 'step' }] },
              usage: { inputTokens: isPlanner ? 300 : 500, outputTokens: isPlanner ? 80 : 120 },
            },
          },
        )
        if (isPlanner) {
          engine.setBrief(task, `## 已确认\n- 事实 ${task.facts.length} 条\n## 下一步\n- 推进目标`, [])
          const unusedFact = task.facts.find(f => !task.goals.some(g => g.evidence === f.id))
          const unusedFinding = task.findings.find(f => !task.goals.some(g => g.evidence === f.id))
          if (unusedFact) engine.proveGoal(task, task.goals[0].id, unusedFact.id, '事实证明')
          if (unusedFinding) engine.proveGoal(task, task.goals[1].id, unusedFinding.id, '发现证明')
          const busy = task.intents.some(i => i.state === 'open' || i.state === 'running')
          const unmet = task.goals.filter(g => g.status !== 'met')
          if (unmet.length > 0 && !busy) {
            engine.addIntents(task, [{ summary: `推进：${unmet[0].text}`, kind: 'pursue' }])
          }
        } else {
          // 模拟一个 worker 的工具调用过程，验证过程索引
          engine.handleSessionEvent(
            { header: { id: childId } },
            { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: 'echo hello-trace' } },
          )
          engine.handleSessionEvent(
            { header: { id: childId } },
            { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'hello-trace output' }] } } },
          )
          if (task.facts.length === 0) {
            engine.recordFacts(task, [{ summary: '证据 A', evidence: 'bash echo', confidence: 'observed', outcome: 'found' }], role.intentId)
          } else {
            engine.recordFinding(task, { title: '成果 B', severity: 'high', evidence: 'repro', intentId: role.intentId })
          }
        }
        resolve({ output: [{ type: 'text', text: isPlanner ? '本轮规划完成' : '写回完成' }], stopReason: 'completed' })
      }, 5)
    })
    return { childId, result, dispose: async () => undefined }
  },
  async sendMessage() {},
  interrupt() {},
}

const ctx = { subagents, get: () => undefined, logger: { warn: (...a) => warnings.push(a.join(' ')) } }
engine = new ArtexEngine({
  ctx,
  config: {
    ...DEFAULTS,
    indexPath: join(root, 'index.json'),
    viewMode: 'planner',
    debounceMs: 10,
    heartbeatMs: 500,
    maxRounds: 10,
    maxWorkers: 2,
    workerTimeoutMs: 2000,
    plannerTimeoutMs: 2000,
    settleGraceMs: 200,
  },
  logger: { warn: (...a) => warnings.push(a.join(' ')) },
})

try {
  const agent = { id: 'owner-session', session: { header: { cwd: root } } }
  const rt = await engine.startTask({
    agent,
    goal: '完成两个验收目标',
    description: '引擎冒烟',
    goals: ['目标 A', '目标 B'],
    constraints: ['只读'],
    limits: { maxWorkers: 2, maxRounds: 10, debounceMs: 10, heartbeatMs: 500, settleGraceMs: 200 },
  })
  const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
  assert.ok(task, 'engine did not finish in time')
  assert.equal(task.status, 'completed', `status=${task.status} detail=${task.finishDetail}`)
  assert.equal(task.mode, 'objective')
  assert.ok(task.brief?.text, 'planner brief 未写入')
  assert.equal(task.goals.every(g => g.status === 'met'), true)
  assert.equal(task.facts.length, 1)
  assert.equal(task.findings.length, 1)
  assert.ok(task.round >= 3, `rounds=${task.round}`)
  assert.ok(task.intents.length >= 2, `intents=${task.intents.length}`)
  assert.equal(task.intents.every(i => ['done', 'exhausted', 'stopped'].includes(i.state)), true)
  assert.equal(task.intents[0].writes.facts, 1)
  assert.equal(task.intents[1].writes.findings, 1)
  assert.equal(await engine.stopTask(task.id, '测试'), false, '已完成任务不应再被停止')

  // 成本统计：planner 与 worker 的 usage 都计入任务
  assert.ok(task.usage, 'usage missing')
  assert.ok(task.usage.calls >= 3, `usage.calls=${task.usage.calls}`)
  assert.ok(task.usage.input_tokens > 0)
  assert.ok(task.usage.by_role.planner.calls >= 1)
  assert.ok(task.usage.by_role.worker.calls >= 1)
  assert.match(engine.report(task), /用量：输入 \d+ \/ 输出 \d+ tokens/)

  const steps = task.activities.filter(a => a.kind === 'step')
  assert.ok(steps.some(s => s.tool === 'bash'), 'worker tool step not indexed')
  assert.ok(searchTraces(task, 'hello-trace').length > 0, 'trace search missed content')

  // 子会话拿到的工具过滤：planner 不应有执行写回工具，worker 不应有派意图工具
  const plannerCall = prompts.find(p => p.label.includes('planner'))
  const workerCall = prompts.find(p => p.label.includes('worker'))
  assert.ok(plannerCall.deny >= 5)
  assert.ok(workerCall.deny >= 5)
  assert.match(plannerCall.prompt, /ARTEX 规划者/)
  assert.match(workerCall.prompt, /ARTEX 执行者/)
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)

  console.log('OK engine', {
    status: task.status,
    rounds: task.round,
    intents: task.intents.length,
    facts: task.facts.length,
    findings: task.findings.length,
    steps: steps.length,
    promptCalls: prompts.length,
  })
} finally {
  await engine.dispose()
  await rm(root, { recursive: true, force: true })
}
