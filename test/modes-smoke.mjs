/**
 * v0.3 双模式与突破收尾的闭环测试（用脚本化 subagents，不调用真实模型）。
 *
 * objective：两条 pursue 并行，A 突破 → 引擎停 B；B 在宽限内写回进度，
 *            最终 B 为 stopped/sibling_breakthrough 且写回被保留。
 * audit：一条 enumerate 意图逐项写回 found/none，planner 证明覆盖目标后完成。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtexEngine, DEFAULTS } from '../engine.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function runObjective() {
  const root = await mkdtemp(join(tmpdir(), 'artex-obj-'))
  const warnings = []
  const nudged = []
  let engine
  let seq = 0

  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    async startActivation(spec) {
      const childId = `child-${++seq}`
      const isPlanner = spec.label.includes('planner')
      let release
      const result = new Promise((resolve) => { release = resolve })
      const role = () => engine.roles.get(childId)
      const finish = (text) => release({ output: [{ type: 'text', text }], stopReason: 'completed' })
      const nudge = (msg) => {
        nudged.push({ childId, msg })
        const r = role()
        const task = engine.liveTask(r.taskId).task
        // 兄弟被叫停时，先写回现场再结束
        engine.recordFacts(task, [{ summary: 'B：已试默认口令 5 组，有验证码', evidence: 'login attempts', outcome: 'none' }], r.intentId)
        setTimeout(() => finish('B 进度：试了默认口令，被验证码拦住，已写回'), 20)
      }
      setTimeout(() => {
        const r = role()
        const task = engine.liveTask(r.taskId).task
        if (isPlanner) {
          engine.setBrief(task, '## 路径树\n- P1 默认口令\n- P2 已知漏洞', [])
          if (task.intents.length === 0) {
            engine.addIntents(task, [
              { summary: '路径A：默认口令', kind: 'pursue' },
              { summary: '路径B：已知漏洞', kind: 'pursue' },
            ])
          } else if (task.findings.length > 0 && task.goals[0].status !== 'met') {
            engine.proveGoal(task, task.goals[0].id, task.findings[0].id, 'A 已突破')
          }
          setTimeout(() => finish('planner done'), 5)
          return
        }
        const intent = task.intents.find(i => i.id === r.intentId)
        if (intent.summary.includes('路径A')) {
          engine.recordFacts(task, [{ summary: 'A：默认口令命中', evidence: 'login ok', outcome: 'found' }], r.intentId)
          engine.recordFinding(task, { title: '拿到管理入口', severity: 'high', evidence: 'login ok', intentId: r.intentId })
          setTimeout(() => finish('A 突破'), 5)
        } else {
          // B 先不结束，等待兄弟突破后的停止指令
          engine.__bRelease = nudge
        }
      }, 10)
      return { childId, result, dispose: async () => undefined }
    },
    async sendMessage(_sender, childId) {
      if (engine.__bRelease) engine.__bRelease('sibling stop')
    },
    interrupt() {},
  }

  const ctx = { subagents, get: () => undefined, logger: { warn: (...a) => warnings.push(a.join(' ')) } }
  engine = new ArtexEngine({
    ctx,
    config: { ...DEFAULTS, indexPath: join(root, 'index.json'), debounceMs: 10, heartbeatMs: 500, maxRounds: 5, maxWorkers: 2, workerTimeoutMs: 5000, plannerTimeoutMs: 2000, settleGraceMs: 200, breakthroughGraceMs: 500 },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  const agent = { id: 'owner-obj', session: { header: { cwd: root } } }
  try {
    const rt = await engine.startTask({
      agent,
      goal: '拿到管理入口',
      description: 'objective 突破测试',
      goals: ['拿到管理入口'],
      constraints: ['只读'],
      mode: 'objective',
      limits: { maxWorkers: 2, maxRounds: 5, debounceMs: 10, heartbeatMs: 500, settleGraceMs: 200, breakthroughGraceMs: 500 },
    })
    const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
    assert.ok(task, 'objective 任务超时未结束')
    assert.equal(task.status, 'completed', `status=${task.status} detail=${task.finishDetail}`)
    const a = task.intents.find(i => i.summary.includes('路径A'))
    const b = task.intents.find(i => i.summary.includes('路径B'))
    assert.equal(a.state, 'done')
    assert.equal(b.state, 'stopped', `B state=${b.state}`)
    assert.equal(b.reason, 'sibling_breakthrough')
    assert.equal(b.writes.facts, 1, 'B 的写回应被保留')
    assert.match(String(b.output || ''), /进度/)
    assert.ok(task.facts.some(f => f.outcome === 'none' && f.intentId === b.id), 'B 的负结果事实应保留')
    assert.ok(nudged.length >= 1, '未向兄弟发送停止指令')
    assert.equal(task.mode, 'objective')
    assert.ok(task.brief?.text)
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
    console.log('OK objective', { intents: task.intents.map(i => `${i.id}:${i.state}`).join(','), nudged: nudged.length })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function runAudit() {
  const root = await mkdtemp(join(tmpdir(), 'artex-audit-'))
  const warnings = []
  let engine
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    async startActivation(spec) {
      const childId = `child-${++seq}`
      const isPlanner = spec.label.includes('planner')
      const result = new Promise((resolve) => {
        setTimeout(() => {
          const r = engine.roles.get(childId)
          const task = engine.liveTask(r.taskId).task
          if (isPlanner) {
            engine.setBrief(task, '## 覆盖地图\n- 认证面：已测 2/2', [])
            if (task.intents.length === 0) {
              engine.addIntents(task, [{ summary: '枚举认证面：登录、重置、token', kind: 'enumerate' }])
            } else if (task.facts.length >= 2 && task.goals[0].status !== 'met') {
              engine.proveGoal(task, task.goals[0].id, task.facts[0].id, '认证面已覆盖')
            }
          } else {
            engine.recordFacts(task, [{ summary: '登录接口存在，返回 401', evidence: 'GET /login', outcome: 'found' }], r.intentId)
            engine.recordFacts(task, [{ summary: '重置接口不存在（404）', evidence: 'POST /reset -> 404', outcome: 'none' }], r.intentId)
          }
          resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
        }, 10)
      })
      return { childId, result, dispose: async () => undefined }
    },
    async sendMessage() {},
    interrupt() {},
  }
  const ctx = { subagents, get: () => undefined, logger: { warn: (...a) => warnings.push(a.join(' ')) } }
  engine = new ArtexEngine({
    ctx,
    config: { ...DEFAULTS, indexPath: join(root, 'index.json'), debounceMs: 10, heartbeatMs: 500, maxRounds: 5, maxWorkers: 2, workerTimeoutMs: 5000, plannerTimeoutMs: 2000, settleGraceMs: 200 },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  const agent = { id: 'owner-audit', session: { header: { cwd: root } } }
  try {
    const rt = await engine.startTask({
      agent,
      goal: '覆盖认证面并给出结论',
      description: 'audit 覆盖测试',
      goals: ['认证面每个入口都有正/负证据'],
      constraints: ['只读'],
      mode: 'audit',
      limits: { maxWorkers: 1, maxRounds: 5, debounceMs: 10, heartbeatMs: 500, settleGraceMs: 200 },
    })
    const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
    assert.ok(task, 'audit 任务超时未结束')
    assert.equal(task.status, 'completed', `status=${task.status} detail=${task.finishDetail}`)
    assert.equal(task.mode, 'audit')
    assert.equal(task.intents[0].kind, 'enumerate')
    assert.equal(task.facts.filter(f => f.outcome === 'found').length, 1)
    assert.equal(task.facts.filter(f => f.outcome === 'none').length, 1)
    assert.match(task.brief.text, /覆盖地图/)
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
    console.log('OK audit', { facts: task.facts.length, kind: task.intents[0].kind })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function runFinalProof() {
  const root = await mkdtemp(join(tmpdir(), 'artex-final-'))
  const warnings = []
  let engine
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    async startActivation(spec) {
      const childId = `child-${++seq}`
      const isPlanner = spec.label.includes('planner')
      const result = new Promise((resolve) => {
        setTimeout(() => {
          const r = engine.roles.get(childId)
          const task = engine.liveTask(r.taskId).task
          if (isPlanner) {
            // 只在"轮次用尽后被强制补的一轮"里判目标
            if (task.facts.length > 0 && task.round >= 2 && task.goals[0].status !== 'met') {
              engine.proveGoal(task, task.goals[0].id, task.facts[0].id, '证据已足够')
            } else if (task.intents.length === 0) {
              engine.addIntents(task, [{ summary: '采集一条证据', kind: 'pursue' }])
            }
          } else {
            engine.recordFacts(task, [{ summary: '证据到齐', evidence: 'echo ok', outcome: 'found' }], r.intentId)
          }
          resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
        }, 10)
      })
      return { childId, result, dispose: async () => undefined }
    },
    async sendMessage() {},
    interrupt() {},
  }
  const ctx = { subagents, get: () => undefined, logger: { warn: (...a) => warnings.push(a.join(' ')) } }
  engine = new ArtexEngine({
    ctx,
    config: { ...DEFAULTS, indexPath: join(root, 'index.json'), debounceMs: 10, heartbeatMs: 500, maxRounds: 1, maxWorkers: 1, workerTimeoutMs: 5000, plannerTimeoutMs: 2000, settleGraceMs: 100 },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  const agent = { id: 'owner-final', session: { header: { cwd: root } } }
  try {
    const rt = await engine.startTask({
      agent,
      goal: '验证收官证明轮',
      description: 'final proof',
      goals: ['拿到一条证据'],
      constraints: [],
      mode: 'objective',
      limits: { maxWorkers: 1, maxRounds: 1, debounceMs: 10, heartbeatMs: 500, settleGraceMs: 100 },
    })
    const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
    assert.ok(task, 'final-proof 任务超时')
    assert.equal(task.status, 'completed', `status=${task.status} detail=${task.finishDetail}`)
    assert.equal(task.finishDetail.includes('收官证明轮'), true)
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
    console.log('OK final-proof', { rounds: task.round, status: task.status })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function runSettlingProof() {
  const root = await mkdtemp(join(tmpdir(), 'artex-settle-'))
  const warnings = []
  let engine
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    async startActivation(spec) {
      const childId = `child-${++seq}`
      const isPlanner = spec.label.includes('planner')
      const result = new Promise((resolve) => {
        setTimeout(() => {
          const r = engine.roles.get(childId)
          const task = engine.liveTask(r.taskId).task
          if (isPlanner) {
            if (task.facts.length > 0 && task.round >= 3 && task.goals[0].status !== 'met') {
              engine.proveGoal(task, task.goals[0].id, task.facts[0].id, '已有证据')
            } else if (task.intents.length === 0) {
              engine.addIntents(task, [{ summary: '采证', kind: 'pursue' }])
            }
          } else {
            engine.recordFacts(task, [{ summary: '证据', evidence: 'x', outcome: 'found' }], r.intentId)
          }
          resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
        }, 10)
      })
      return { childId, result, dispose: async () => undefined }
    },
    async sendMessage() {},
    interrupt() {},
  }
  const ctx = { subagents, get: () => undefined, logger: { warn: (...a) => warnings.push(a.join(' ')) } }
  engine = new ArtexEngine({
    ctx,
    config: { ...DEFAULTS, indexPath: join(root, 'index.json'), debounceMs: 400, heartbeatMs: 500, maxRounds: 5, maxWorkers: 1, workerTimeoutMs: 5000, plannerTimeoutMs: 2000, settleGraceMs: 500 },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  const agent = { id: 'owner-settle', session: { header: { cwd: root } } }
  try {
    const rt = await engine.startTask({
      agent,
      goal: '验证收尾证明轮',
      description: 'settling proof',
      goals: ['拿到证据'],
      constraints: [],
      mode: 'objective',
      limits: { maxWorkers: 1, maxRounds: 5, debounceMs: 400, heartbeatMs: 500, settleGraceMs: 500, budgetMs: 150 },
    })
    const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
    assert.ok(task, 'settling-proof 任务超时')
    assert.equal(task.status, 'completed', `status=${task.status} detail=${task.finishDetail}`)
    assert.equal(task.finishDetail.includes('收尾证明轮'), true)
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
    console.log('OK settling-proof', { rounds: task.round, status: task.status })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function runAnalyst() {
  const root = await mkdtemp(join(tmpdir(), 'artex-analyst-'))
  const warnings = []
  const prompts = []
  let engine
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    async startActivation(spec) {
      const childId = `child-${++seq}`
      const prompt = spec.request.prompt[0].text
      prompts.push({ label: spec.label, prompt })
      const isAnalyst = spec.label.includes('analyst')
      const isPlanner = spec.label.includes('planner')
      const result = new Promise((resolve) => {
        setTimeout(() => {
          const r = engine.roles.get(childId)
          const task = engine.liveTask(r.taskId).task
          engine.handleSessionEvent(
            { header: { id: childId } },
            {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: 'step' }] }, usage: { inputTokens: 100, outputTokens: 50 } },
            },
          )
          if (isAnalyst) {
            engine.setAnalysis(task, '## 一致性检查\n- brief 与事实一致（fact#1）\n## 建议\n- 直接证明目标', [])
          } else if (isPlanner) {
            if (task.facts.length > 0 && task.goals[0].status !== 'met') {
              engine.proveGoal(task, task.goals[0].id, task.facts[0].id, '证据足够')
            } else if (task.intents.length === 0) {
              engine.addIntents(task, [{ summary: '采证', kind: 'pursue' }])
            }
          } else {
            engine.recordFacts(task, [{ summary: '证据', evidence: 'x', outcome: 'found' }], r.intentId)
          }
          resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
        }, 10)
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
      viewMode: 'hybrid', analystEveryRounds: 1, analystFactThreshold: 1, analystCooldownMs: 0, analystMaxRuns: 3, analystTimeoutMs: 2000,
      debounceMs: 10, heartbeatMs: 500, maxRounds: 4, maxWorkers: 1, workerTimeoutMs: 5000, plannerTimeoutMs: 2000, settleGraceMs: 100,
    },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  const agent = { id: 'owner-analyst', session: { header: { cwd: root } } }
  try {
    const rt = await engine.startTask({
      agent,
      goal: '验证 analyst 触发与分析注入',
      description: 'analyst',
      goals: ['拿到证据'],
      constraints: [],
      mode: 'objective',
      limits: { maxWorkers: 1, maxRounds: 4, debounceMs: 10, heartbeatMs: 500, settleGraceMs: 100 },
    })
    const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
    assert.ok(task, 'analyst 任务超时')
    assert.equal(task.status, 'completed', `status=${task.status} detail=${task.finishDetail}`)
    assert.ok(task.analysis?.text, 'analysis 未写入')
    assert.match(task.analysis.text, /一致性检查/)
    assert.ok((task.analysisRuns || 0) >= 1)
    assert.ok(task.usage.by_role?.analyst?.calls >= 1, 'analyst usage 未统计')
    assert.ok(prompts.some(p => p.label.includes('analyst')), 'analyst 子会话未启动')
    assert.ok(prompts.some(p => p.label.includes('planner') && p.prompt.includes('独立分析（analyst')), 'planner 未拿到分析')
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
    console.log('OK analyst', { runs: task.analysisRuns, calls: task.usage.by_role.analyst.calls })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

async function runAnalystDisabled() {
  const root = await mkdtemp(join(tmpdir(), 'artex-nohybrid-'))
  const warnings = []
  const prompts = []
  let engine
  let seq = 0
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true } }),
    async startActivation(spec) {
      const childId = `child-${++seq}`
      prompts.push(spec.label)
      const isPlanner = spec.label.includes('planner')
      const result = new Promise((resolve) => {
        setTimeout(() => {
          const r = engine.roles.get(childId)
          const task = engine.liveTask(r.taskId).task
          if (isPlanner) {
            if (task.facts.length > 0 && task.goals[0].status !== 'met') {
              engine.proveGoal(task, task.goals[0].id, task.facts[0].id, '证据足够')
            } else if (task.intents.length === 0) {
              engine.addIntents(task, [{ summary: '采证', kind: 'pursue' }])
            }
          } else {
            engine.recordFacts(task, [{ summary: '证据', evidence: 'x', outcome: 'found' }], r.intentId)
          }
          resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
        }, 10)
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
      enableHybrid: false,
      viewMode: 'hybrid',
      debounceMs: 10, heartbeatMs: 500, maxRounds: 4, maxWorkers: 1, workerTimeoutMs: 5000, plannerTimeoutMs: 2000, settleGraceMs: 100,
    },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  const agent = { id: 'owner-nohybrid', session: { header: { cwd: root } } }
  try {
    const rt = await engine.startTask({
      agent,
      goal: '验证 hybrid 总开关',
      description: 'no hybrid',
      goals: ['拿到证据'],
      constraints: [],
      mode: 'objective',
      limits: { maxWorkers: 1, maxRounds: 4, debounceMs: 10, heartbeatMs: 500, settleGraceMs: 100 },
    })
    const task = await Promise.race([rt.done, sleep(8000).then(() => null)])
    assert.ok(task, '禁用 hybrid 任务超时')
    assert.equal(task.status, 'completed')
    assert.equal(task.viewMode, 'planner')
    assert.equal(task.analysis, undefined)
    assert.equal(prompts.some(label => label.includes('analyst')), false, '总开关关闭后不应启动 analyst')
    assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`)
    console.log('OK no-hybrid', { viewMode: task.viewMode })
  } finally {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

await runObjective()
await runAudit()
await runFinalProof()
await runSettlingProof()
await runAnalyst()
await runAnalystDisabled()
console.log('OK modes')
