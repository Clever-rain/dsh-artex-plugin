/**
 * Phantom 启发路线图回归（P0 防线 / P1 审计 / P2 能力 / P3 运营）：
 * scope 匹配与提取、目标审查、证据脱敏、交战校验、gitignore 防护、
 * 审批门、深挖档、证据绑定、技能包、战役聚合、意图级 token 门禁。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { normalizeScopeEntry, matchScopeEntry, parseScope, extractTargets, scopeCheck, isPrivateTarget, lintGoalTexts, redactText } from '../guard.js'
import { validateEngagement, ensureArtexGitignored } from '../engagement.js'
import { bindArtifacts, bindSteps } from '../evidence.js'
import { loadSkillPacks } from '../skills.js'
import { createTask, addIntents, requestApproval, resolveApproval, addViolation, TaskIndex } from '../graph.js'
import { selectNextIntent } from '../scheduler.js'
import { ArtexEngine, DEFAULTS } from '../engine.js'
import { workerPrompt, violationNudgePrompt, tokenCapSettlePrompt } from '../prompts.js'

/* ------------------------------------------------------------------ P0-1 scope */

assert.equal(normalizeScopeEntry('https://Api.Example.com:8443/x').value, 'api.example.com', 'scheme/端口/路径应剥掉')
assert.equal(normalizeScopeEntry('*.example.com').kind, 'suffix')
assert.equal(normalizeScopeEntry('10.0.0.0/8').kind, 'cidr')
assert.equal(normalizeScopeEntry('10.0.0.0/33'), undefined, '非法 CIDR 拒绝')

const scopeList = ['example.com', '*.corp.internal', '10.0.0.0/8', '45.227.254.43']
const scope = parseScope(scopeList)
assert.equal(matchScopeEntry(scope, 'example.com'), true)
assert.equal(matchScopeEntry(scope, 'www.example.com'), false, '精确主机不含子域')
assert.equal(matchScopeEntry(scope, 'a.b.corp.internal'), true, '后缀多层匹配')
assert.equal(matchScopeEntry(scope, 'corp.internal'), true, '后缀含根域')
assert.equal(matchScopeEntry(scope, '10.20.30.40'), true, 'CIDR 命中')
assert.equal(matchScopeEntry(scope, '11.0.0.1'), false, 'CIDR 外')
assert.equal(matchScopeEntry(scope, '45.227.254.43'), true)
assert.equal(matchScopeEntry(scope, '45.227.254.44'), false)

// 提取：URL 主机、裸 IP、裸域名；内网与回环不算越界。
const cmd = 'nmap -sV https://api.evil-corp.com:8443/login 8.8.8.8 && curl 192.168.1.1 && ping sub.target.org'
const extracted = extractTargets(cmd)
assert.ok(extracted.includes('api.evil-corp.com'))
assert.ok(extracted.includes('8.8.8.8'))
assert.ok(extracted.includes('sub.target.org'))
assert.equal(isPrivateTarget('192.168.1.1'), true)
assert.equal(isPrivateTarget('127.0.0.1'), true)
assert.equal(isPrivateTarget('8.8.8.8'), false)

const v1 = scopeCheck(scopeList, 'curl https://example.com/ok')
assert.equal(v1.enabled, true, '非空 scope 应启用')
assert.equal(v1.ok, true, '白名单内目标放行')
const v2 = scopeCheck(scopeList, 'curl https://evil-corp.com/ && ping 8.8.8.8')
assert.equal(v2.ok, false)
assert.deepEqual(v2.misses.sort(), ['8.8.8.8', 'evil-corp.com'].sort())
const v3 = scopeCheck([], 'curl https://anything.com')
assert.equal(v3.enabled, false, '空 scope = 未启用')
const v4 = scopeCheck(scopeList, 'ssh 10.1.2.3 && curl 127.0.0.1')
assert.equal(v4.ok, true, 'CIDR 内 + 回环不算越界')

/* ------------------------------------------------------------------ P0-2 目标审查 */

assert.ok(lintGoalTexts(['对授权靶场做渗透测试，枚举 Web 漏洞']).length === 0, '正常红队语言不应误报')
const hits = lintGoalTexts(['制作勒索软件加密器', '测试 wiper 破坏性 payload'])
assert.ok(hits.some(h => h.category === 'payload'), '勒索软件应命中')
assert.ok(hits.some(h => h.category === 'destruction'), 'wiper 应命中')
assert.equal(hits.filter(h => h.category === 'payload').length, 1, '同 category 去重')

/* ------------------------------------------------------------------ P0-3 脱敏与 gitignore */

const leaked = 'user=admin password=Sup3rSecret! Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 token=abcd1234efgh AKIAIOSFODNN7EXAMPLE'
const redacted = redactText(leaked)
assert.ok(!redacted.includes('Sup3rSecret!'), 'password 值应打码')
assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9'), 'Bearer 值应打码')
assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key 应打码')
assert.ok(redacted.includes('user=admin'), '非敏感字段保留')
assert.ok(redacted.includes('[已脱敏'), '打码留痕')
assert.equal(redactText('nothing sensitive'), 'nothing sensitive')

const tmpGit = await mkdtemp(join(tmpdir(), 'artex-git-'))
await mkdir(join(tmpGit, '.git'))
const guard1 = await ensureArtexGitignored(tmpGit)
assert.equal(guard1.changed, true, '首次应补 .gitignore')
assert.ok((await readFile(join(tmpGit, '.gitignore'), 'utf8')).includes('.artex/'))
const guard2 = await ensureArtexGitignored(tmpGit)
assert.equal(guard2.changed, false, '幂等：已覆盖不再追加')
const guard3 = await ensureArtexGitignored(await mkdtemp(join(tmpdir(), 'artex-nogit-')))
assert.equal(guard3.repo, false, '非 git 仓库跳过')

/* ------------------------------------------------------------------ 交战校验 */

const goodEng = {
  id: 'eng-1',
  authorization: 'ACME 安全部授权书 #2026-017',
  targets: ['*.example.com', '10.0.0.0/8'],
  window: { not_before: '2026-01-01T00:00:00Z', not_after: '2099-01-01T00:00:00Z' },
}
assert.deepEqual(validateEngagement(goodEng, { allowedTargets: ['api.example.com'] }), [], '子集 scope 应通过')
assert.ok(validateEngagement(goodEng, { allowedTargets: ['other-corp.com'] }).some(p => p.includes('超出')), 'scope 超授权集应报')
assert.ok(validateEngagement({ ...goodEng, window: { not_after: '2020-01-01T00:00:00Z' } }, {}).some(p => p.includes('过期')), '过期交战应报')
assert.ok(validateEngagement({ ...goodEng, authorization: '' }, {}).some(p => p.includes('authorization')), '缺授权说明应报')
assert.ok(validateEngagement({ ...goodEng, window: {} }, {}).some(p => p.includes('not_after')), '缺结束时间应报')

/* ------------------------------------------------------------------ P1-2 审批门 */

const task = createTask({
  id: 't-road-1', description: '路线图回归', goal: '验证审批门', goals: ['g'], constraints: [],
  ownerSession: 'owner', cwd: '/tmp', outDir: '/tmp/.artex/tasks/t-road-1', limits: {},
})
const [r1] = addIntents(task, [{ summary: '修改目标系统配置', requires_approval: true }])
const intent = task.intents.find(i => i.id === r1.id)
assert.equal(intent.approval.pending, true, 'requires_approval 应挂起')
assert.equal(selectNextIntent(task), undefined, '待审批意图不可领取')
requestApproval(task, intent.id, { reason: 'worker 也请求', action: 'test', by: 'worker' })
const resolved = resolveApproval(task, intent.id, 'approve', '授权范围内，放行')
assert.equal(resolved.decision, 'approved')
assert.equal(selectNextIntent(task).id, intent.id, '批准后可领取')
const [r2] = addIntents(task, [{ summary: '擦除验证数据', requires_approval: true }])
const intent2 = task.intents.find(i => i.id === r2.id)
resolveApproval(task, intent2.id, 'reject', '不允许')
assert.equal(intent2.state, 'stopped')
assert.equal(intent2.reason, 'approval_rejected')
assert.equal(selectNextIntent(task).id, intent.id, '被拒意图不再出现')
// 越界事件落库
addViolation(task, { tool: 'pwsh', intentId: intent.id, targets: ['8.8.8.8'], misses: ['8.8.8.8'], enforcement: 'warn' })
assert.equal(task.violations.length, 1)

/* ------------------------------------------------------------------ P2-1 深挖档 */

const objTask = createTask({
  id: 't-road-2', description: 'depth', goal: 'g', goals: ['g'], constraints: [],
  ownerSession: 'o', cwd: '/tmp', outDir: '/tmp/x', limits: {},
})
const [rp1] = addIntents(objTask, [{ summary: '主路径深挖', kind: 'pursue', depth: 2 }])
const p1 = objTask.intents.find(i => i.id === rp1.id)
assert.equal(p1.depth, 2, 'objective pursue 保留 depth')
const auditTask = createTask({
  id: 't-road-3', description: 'depth-audit', goal: 'g', goals: ['g'], constraints: [],
  ownerSession: 'o', cwd: '/tmp', outDir: '/tmp/y', limits: {}, mode: 'audit',
})
const [re1] = addIntents(auditTask, [{ summary: '逐项验证', depth: 3 }])
assert.equal(auditTask.intents.find(i => i.id === re1.id).depth, 1, 'audit 强制 depth=1')
const [rpBad] = addIntents(objTask, [{ summary: 'depth 越界', kind: 'pursue', depth: 9 }])
assert.equal(objTask.intents.find(i => i.id === rpBad.id).depth, 3, 'depth 上限截断到 3')
// 深挖段进 worker 提示词
const deepPrompt = workerPrompt({ task: objTask, intent: p1, view: {}, skillPacks: [] })
assert.ok(deepPrompt.includes('深挖档'), 'depth>1 应注入链式推进段')
const shallowPrompt = workerPrompt({ task: objTask, intent: { ...p1, depth: 1, id: 99, approval: undefined }, view: {}, skillPacks: [] })
assert.ok(!shallowPrompt.includes('深挖档'), 'depth=1 不注入')

/* ------------------------------------------------------------------ P1-1 证据绑定 */

const tmpEv = await mkdtemp(join(tmpdir(), 'artex-ev-'))
const payload = Buffer.from('proof-of-concept output')
await writeFile(join(tmpEv, 'poc.txt'), payload)
const artifacts = await bindArtifacts(tmpEv, [{ path: 'poc.txt', note: 'PoC 输出' }])
assert.equal(artifacts[0].sha256, createHash('sha256').update(payload).digest('hex'), '工件 sha256 正确')
await assert.rejects(() => bindArtifacts(tmpEv, [{ path: 'missing.bin' }]), /不存在/, '缺失工件拒收')
await assert.rejects(() => bindArtifacts(tmpEv, [{ path: '../outside.txt' }]), /工作区内/, '越出工作区拒收')
const stepTask = createTask({
  id: 't-road-4', description: 'steps', goal: 'g', goals: ['g'], constraints: [],
  ownerSession: 'o', cwd: '/tmp', outDir: '/tmp/z', limits: {},
})
stepTask.activities.push({ id: 7, kind: 'step' })
assert.deepEqual(bindSteps(stepTask, [7, 7]), [7], '步骤 id 归一化')
assert.throws(() => bindSteps(stepTask, [99]), /不存在/, '不存在的步骤拒收')

/* ------------------------------------------------------------------ P2-2 技能包 */

const packs = await loadSkillPacks('/tmp', ['recon', 'web-audit'])
assert.equal(packs.length, 2)
assert.ok(packs[0].prompt.includes('技能包'), '内置包有打法段')
const tmpSkill = await mkdtemp(join(tmpdir(), 'artex-skill-'))
await mkdir(join(tmpSkill, '.artex', 'skills'), { recursive: true })
await writeFile(join(tmpSkill, '.artex', 'skills', 'custom-x.json'), JSON.stringify({ prompt: '## 技能包：custom-x\n自定义打法', tools: ['pwsh'] }))
const custom = await loadSkillPacks(tmpSkill, ['custom-x'])
assert.equal(custom[0].name, 'custom-x')
assert.deepEqual(custom[0].tools, ['pwsh'])
await assert.rejects(() => loadSkillPacks('/tmp', ['not-exist-pack']), /不存在/, '未知包启动即失败')
const packPrompt = workerPrompt({ task: objTask, intent: p1, view: {}, skillPacks: packs })
assert.ok(packPrompt.includes('技能包：recon'), '技能包注入 worker 提示词')

/* ------------------------------------------------------------------ P3-1 战役索引 */

const tmpIndex = join(await mkdtemp(join(tmpdir(), 'artex-idx-')), 'index.json')
const index = new TaskIndex(tmpIndex)
await index.register({ id: 'taaa111', cwd: '/tmp/a', ownerSession: 'o1', campaign: 'op-north' })
await index.register({ id: 'tbbb222', cwd: '/tmp/b', ownerSession: 'o1', campaign: 'op-north' })
await index.register({ id: 'tccc333', cwd: '/tmp/c', ownerSession: 'o1' })
const rows = await index.byCampaign('op-north')
assert.equal(rows.length, 2, '战役聚合只含同战役任务')
assert.deepEqual((await index.campaigns()).sort(), ['op-north'])

/* ------------------------------------------------------------------ P3-2 成本门禁 */

const engineProto = ArtexEngine.prototype
const fakeEngine = {
  config: { maxTokensPerIntent: 0 },
  activities: [],
  addActivity(_rt, a) { this.activities.push(a); return a },
  nudges: [],
  async nudge(_rt, _c, text) { this.nudges.push(text) },
  interrupts: [],
  interruptChild(_rt, c) { this.interrupts.push(c) },
  persist() {},
  logger: { warn() {} },
}
const rtCost = {
  task: {
    usage: { input_tokens: 100, output_tokens: 50, calls: 3 },
    round: 2,
    limits: { maxTokens: 1000 },
    policy: {},
  },
  costMark: undefined,
}
const cost1 = engineProto.costView.call(fakeEngine, rtCost)
assert.equal(cost1.total_tokens, 150)
assert.equal(cost1.since_last_round, 150)
assert.equal(cost1.per_round_avg, 75)
assert.equal(cost1.remaining_tokens, 850)
assert.equal(cost1.est_rounds_left, 11)
const cost2 = engineProto.costView.call(fakeEngine, rtCost)
assert.equal(cost2.since_last_round, 0, '无新增时燃烧率为 0')

const rtCap = {
  finished: false,
  tokenCapNudged: new Set(),
  children: new Map([['intent-1', 'child-1']]),
  running: new Map([[1, Promise.resolve()]]),
  task: {
    policy: { maxTokensPerIntent: 100 },
    limits: { settleGraceMs: 0 },
    usage: { by_intent: { '#1': { input_tokens: 80, output_tokens: 50 } } },
    intents: [],
  },
}
assert.equal(engineProto.checkIntentTokenBudget.call(fakeEngine, rtCap, { intentId: 1 }), true, '超 cap 触发门禁')
assert.ok(fakeEngine.nudges.some(t => t.includes('token 预算超限')), '触发后 nudge 收尾')
assert.equal(engineProto.checkIntentTokenBudget.call(fakeEngine, rtCap, { intentId: 1 }), false, '同意图只触发一次')
assert.ok(tokenCapSettlePrompt({ intentId: 1, used: 130, cap: 100 }).includes('#1'))
assert.ok(violationNudgePrompt({ tool: 'pwsh', misses: ['8.8.8.8'], enforcement: 'warn' }).includes('8.8.8.8'))

/* ------------------------------------------------------- 引擎级联防线（startTask 集成） */

const intRoot = await mkdtemp(join(tmpdir(), 'artex-roadmap-'))
await mkdir(join(intRoot, '.artex', 'engagements'), { recursive: true })
await writeFile(join(intRoot, '.artex', 'engagements', 'op-x.json'), JSON.stringify({
  id: 'op-x',
  authorization: 'ACME 授权书 #017',
  targets: ['*.example.com'],
  window: { not_after: '2099-01-01T00:00:00Z' },
}))
const intSubagents = {
  list: () => ['spawn'],
  getProvider: () => ({ capabilities: { agentOptions: true } }),
  async startActivation(spec) {
    const childId = `int-child-${Math.random().toString(36).slice(2, 8)}`
    return { childId, result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), dispose: async () => undefined }
  },
  async sendMessage() {},
  interrupt() {},
}
const intEngine = new ArtexEngine({
  ctx: { subagents: intSubagents, get: () => undefined, logger: { warn() {} } },
  config: { ...DEFAULTS, indexPath: join(intRoot, 'index.json'), viewMode: 'planner', enableHybrid: false, maxWorkers: 0, maxRounds: 1, heartbeatMs: 60000 },
})
const ownerAgent = { id: 'owner-int', session: { header: { cwd: intRoot } } }
const quietLimits = { maxWorkers: 0, maxRounds: 1, heartbeatMs: 60000 }

// 目标审查：命中高风险词且无 confirm → 启动即拒
await assert.rejects(
  () => intEngine.startTask({ agent: ownerAgent, goal: '复现勒索软件加密器行为（靶场研究）', limits: quietLimits, signal: new AbortController().signal }),
  /目标审查命中高风险信号/,
)
// 精确 confirm → 放行，确认留痕
const rtRisk = await intEngine.startTask({
  agent: ownerAgent,
  goal: '复现勒索软件加密器行为（靶场研究）',
  confirm: '复现勒索软件加密器行为（靶场研究）',
  limits: quietLimits,
  signal: new AbortController().signal,
})
assert.ok(rtRisk.task.riskConfirm?.hits?.length > 0, 'confirm 后留痕命中词')
await intEngine.stopTask(rtRisk.task.id, 'test done')
await rtRisk.done

// 交战绑定：scope 默认继承交战目标集；超集声明被拒
const rtEng = await intEngine.startTask({ agent: ownerAgent, goal: '授权侦察', limits: quietLimits, policy: { engagement: 'op-x' }, signal: new AbortController().signal })
assert.deepEqual(rtEng.task.policy.allowedTargets, ['*.example.com'], '交战目标集成为默认 scope')
assert.equal(rtEng.task.engagement.id, 'op-x')
await intEngine.stopTask(rtEng.task.id, 'test done')
await rtEng.done
await assert.rejects(
  () => intEngine.startTask({ agent: ownerAgent, goal: '越权测试', limits: quietLimits, policy: { engagement: 'op-x', allowed_targets: ['other-corp.com'] }, signal: new AbortController().signal }),
  /超出交战授权目标集/,
)
await assert.rejects(
  () => intEngine.startTask({ agent: ownerAgent, goal: '无交战文件', limits: quietLimits, policy: { engagement: 'op-missing' }, signal: new AbortController().signal }),
  /不存在/,
)

// scope 越界：worker 工具调用事件触发引擎处置（warn 记录 / stop 停任务）
const rtScope = await intEngine.startTask({ agent: ownerAgent, goal: 'scope 测试', limits: quietLimits, policy: { allowedTargets: ['example.com'], scopeEnforcement: 'warn' }, campaign: 'op-test', signal: new AbortController().signal })
const [ri] = addIntents(rtScope.task, [{ summary: '探测 example.com' }])
intEngine.roles.set('fake-worker-1', { taskId: rtScope.task.id, intentId: ri.id, role: 'worker', pending: new Map(), writes: { facts: 0, findings: 0, resources: 0 } })
intEngine.handleSessionEvent(
  { header: { id: 'fake-worker-1' } },
  { type: 'tool/call', data: { callId: 'vx1', name: 'pwsh', arguments: 'curl https://out-of-scope-corp.com/' } },
)
assert.equal(rtScope.task.violations.length, 1, '越界事件落库')
assert.equal(rtScope.task.violations[0].misses[0], 'out-of-scope-corp.com')
await intEngine.stopTask(rtScope.task.id, 'test done')
await rtScope.done

const rtStop = await intEngine.startTask({ agent: ownerAgent, goal: 'scope stop 档', limits: quietLimits, policy: { allowedTargets: ['example.com'], scopeEnforcement: 'stop' }, signal: new AbortController().signal })
const [ri2] = addIntents(rtStop.task, [{ summary: '探测' }])
intEngine.roles.set('fake-worker-2', { taskId: rtStop.task.id, intentId: ri2.id, role: 'worker', pending: new Map(), writes: { facts: 0, findings: 0, resources: 0 } })
intEngine.handleSessionEvent(
  { header: { id: 'fake-worker-2' } },
  { type: 'tool/call', data: { callId: 'vx2', name: 'pwsh', arguments: 'curl https://evil-out.com/' } },
)
await rtStop.done
assert.equal(rtStop.task.status, 'stopped', 'stop 档越界应停任务')
assert.ok(String(rtStop.task.finishDetail).includes('scope 越界'), '停止原因点名越界')

// campaign 聚合视图：引擎级
const camp = await intEngine.campaignStatus('op-test')
assert.equal(camp.tasks.length, 1)
assert.equal(camp.totals.violations, 1)
assert.ok((await intEngine.campaignList()).includes('op-test'))

// 审批流转：引擎级（worker 挂起 → owner 放行）
const rtAppr = await intEngine.startTask({ agent: ownerAgent, goal: '审批流转', limits: quietLimits, signal: new AbortController().signal })
const [ra] = addIntents(rtAppr.task, [{ summary: '高风险动作' }])
intEngine.requestApproval(rtAppr.task, ra.id, { reason: '将修改目标配置', action: 'pwsh set-x', by: 'worker' })
assert.equal(selectNextIntent(rtAppr.task), undefined, '挂起后不可领取')
const verdict = intEngine.resolveApproval(rtAppr.task, ra.id, 'approve', '已核对授权范围')
assert.equal(verdict.decision, 'approved')
assert.equal(selectNextIntent(rtAppr.task).id, ra.id)
assert.ok(rtAppr.task.activities.some(a => a.kind === 'approval'), '审批留痕过程库')
await intEngine.stopTask(rtAppr.task.id, 'test done')
await rtAppr.done
await intEngine.dispose()

console.log('OK roadmap', {
  scope: 'match/extract/check',
  goalLint: hits.length,
  redact: 'masked',
  engagement: 'validate',
  approval: 'gate+resolve',
  depth: '1-3 objective-only',
  evidenceRefs: 'sha256+steps',
  skillPacks: packs.map(p => p.name).join('+') + '+custom-x',
  campaign: rows.length,
  costGate: 'burn+cap',
  integration: 'lint+engagement+violation+approval',
})
