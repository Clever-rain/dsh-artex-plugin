/**
 * 上下文治理回归：`artex_task_status` / `artex_graph_overview` 的摘要化输出契约。
 *
 * 黑盒测试：只通过 createTools({engine, config: DEFAULTS}) 调用，不 import tools/*。
 * 契约见 ARTEX 工作区 `.work/spec-context-governance.md` 第 1、2、3 节。
 *
 * 单任务 status 用构造 snapshot（假 engine.status）验证「摘要 + 落盘指针 + 硬上限」；
 * graph_overview 用真 createTask + recordFact 造 task 验证 facts_limit / sections / 超限包装。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createTask, recordFact, reportFinding } from '../graph.js'
import { createTools } from '../tools.js'
import { DEFAULTS } from '../engine.js'

const OWNER = 'owner-session'
const TASK_ID = 't-status-1'
const root = mkdtempSync(join(tmpdir(), 'artex-status-'))
const ownerExec = { agent: { id: OWNER }, signal: new AbortController().signal }

try {
  const outDir = join(root, '.artex', 'tasks', TASK_ID)
  mkdirSync(outDir, { recursive: true })

  // ---------------------------------------------------------------- fixture
  // 60 条 finding：默认 findings_limit=10 时只应显示 id 60..51（新→旧）。
  const findings = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    title: `Finding title ${i + 1}`,
    severity: i % 2 === 0 ? 'high' : 'medium',
    status: 'open',
    intent_id: null,
  }))
  const briefText = `BRIEF-SECRET-MARKER ${'brief-body '.repeat(80)}`
  const snapshot = {
    task_id: TASK_ID,
    owner_session: OWNER,
    status: 'running',
    live: true,
    mode: 'objective',
    view_mode: 'planner',
    description: `DESCRIPTION-SECRET-MARKER ${'desc '.repeat(60)}`,
    goal: `TOP-GOAL-SECRET-MARKER ${'goal '.repeat(60)}`,
    brief: briefText,
    brief_round: 3,
    analysis: `ANALYSIS-SECRET-MARKER ${'analysis '.repeat(60)}`,
    analysis_round: 2,
    rounds: 7,
    limits: {},
    pending_approvals: [{
      id: 9001,
      summary: 'APPROVAL-SUMMARY-MARKER 高危动作待裁决',
      request: { reason: 'APPROVAL-REQUEST-MARKER' },
    }],
    goals: [
      { id: 1, text: 'goal met one', status: 'met', evidence: 2 },
      { id: 2, text: 'GOAL-OPEN-MARKER 未达成目标文本', status: 'open' },
    ],
    intents: { total: 2, open: 1, running: 1, by_state: { open: 1, running: 1 } },
    facts: 12,
    facts_kept: 12,
    digest: {
      facts: {
        total: 12,
        kept: 12,
        by_outcome: { found: 5, none: 3, inconclusive: 2, blueprint: 1, unset: 1 },
      },
    },
    findings,
    findings_total: 60,
    findings_kept: 60,
    findings_by_status: { open: 59, verified: 1, rejected: 0, needs_retest: 0 },
    resources: 4,
    usage: {
      input_tokens: 1234,
      output_tokens: 567,
      calls: 8,
      by_role: {},
      by_intent: { 'USAGE-BY-INTENT-MARKER': 3 },
    },
    hints: ['hint text one', 'hint text two'],
    todos: [{ id: 1, content: 'todo one', status: 'pending' }],
    elapsed_ms: 65000,
    finish_detail: 'FINISH-REASON-MARKER 收尾原因正文',
    out_dir: outDir,
  }

  const taskStub = { id: TASK_ID, ownerSession: OWNER, outDir }
  const statusEngine = {
    roleOf: () => undefined,
    resolveTask: async (id) => {
      if (String(id) !== TASK_ID) throw new Error(`ARTEX 任务 ${id} 不存在`)
      return taskStub
    },
    liveTask: () => undefined,
    status: async (taskId) => {
      if (!taskId) return []
      return snapshot
    },
    cwdFor: async () => root,
    storeFor: () => ({ tasks: { ids: async () => [] } }),
    index: { ownerOf: async () => undefined },
  }

  const statusTool = createTools({ engine: statusEngine, config: DEFAULTS })
    .find(tool => tool.name === 'artex_task_status')
  assert.ok(statusTool, '应注册 artex_task_status')

  // §1.1：新增参数必须出现在 schema 里（否则模型无法传递）。
  for (const key of ['detail', 'findings_limit', 'sections', 'max_chars']) {
    assert.ok(statusTool.parameters?.properties?.[key], `artex_task_status 应支持参数 ${key}`)
  }

  const statusFile = join(outDir, 'status_latest.json')

  // ------------------------------------------------- 1. 默认摘要：有界 + 关键字段
  const summaryResult = await statusTool.execute({ task_id: TASK_ID }, ownerExec)
  const text = summaryResult.text
  assert.ok(text.length <= 4000, `默认输出字符数应 ≤ 4000，实际 ${text.length}`)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 4096, `默认输出字节数应 ≤ 4096，实际 ${Buffer.byteLength(text, 'utf8')}`)

  assert.ok(text.includes(TASK_ID), '摘要应含 task_id')
  assert.ok(text.includes('[running]'), '摘要应含状态')
  // §1.2.1 头部格式：<task_id> [<status>] (<mode>/<view_mode>) + live 标记。
  assert.match(text.split('\n')[0], new RegExp(`^${TASK_ID} \\[running\\] \\(objective/planner\\) · live`), '头部格式不符契约')
  assert.ok(text.includes('轮次 7'), '摘要应含轮次')
  assert.ok(text.includes('goals 1/2'), '摘要应含 goals 达成/总数')
  assert.ok(text.includes('发现 60'), '摘要应含发现总数')
  assert.ok(text.includes('（verified 1）'), '有 verified 时应给 verified 计数')
  assert.ok(text.includes('pending_approvals 1'), '运行行应含 pending_approvals 计数')
  assert.ok(text.includes('#9001'), '待审批条目必须可见（含 id）')
  assert.ok(text.includes('结束原因：') && text.includes('FINISH-REASON-MARKER'), 'finish_detail 结尾原因应可见')
  assert.ok(text.includes('· live'), 'live 任务头部应带 live 标记')

  // 最新 10 条 finding 标题，倒序（第一个是最大 id）。
  const findingLines = text.split('\n').filter(line => /^- #\d+ \[/.test(line))
  assert.equal(findingLines.length, 10, `默认应只列 10 条 finding 标题，实际 ${findingLines.length}`)
  assert.match(findingLines[0], /^- #60 \[/, '第一条应为最大 id=60')
  assert.deepEqual(
    findingLines.map(line => Number(line.match(/^- #(\d+) \[/)[1])),
    [60, 59, 58, 57, 56, 55, 54, 53, 52, 51],
    'finding 标题应按新→旧倒序排列',
  )
  assert.ok(text.includes('Finding title 60'), '应含最新 finding 标题')
  assert.equal(text.includes('Finding title 50'), false, '不应含第 10 条以外的旧 finding 标题')

  // 未达成 goal 行可见（默认 sections 含 goals）。
  assert.ok(text.includes('[goal#2]'), '默认应列未达成 goal 行')
  assert.ok(text.includes('GOAL-OPEN-MARKER'), '未达成 goal 文本应可见')

  // 落盘指针可见。
  assert.ok(text.includes(outDir), '摘要应含 out_dir')
  assert.ok(text.includes('status_latest.json'), '摘要应含 status_latest.json 指针')

  // 禁区：goal/description/brief/analysis 全文、usage.by_intent 不得进会话。
  assert.equal(text.includes('BRIEF-SECRET-MARKER'), false, '不应含 brief 全文')
  assert.equal(text.includes('DESCRIPTION-SECRET-MARKER'), false, '不应含 description 全文')
  assert.equal(text.includes('TOP-GOAL-SECRET-MARKER'), false, '不应含任务 goal 全文')
  assert.equal(text.includes('ANALYSIS-SECRET-MARKER'), false, '不应含 analysis 全文')
  assert.equal(text.includes('USAGE-BY-INTENT-MARKER'), false, '不应含 usage.by_intent')
  assert.equal(text.includes('tokens 入'), false, '默认 sections 不含 usage 块')
  assert.equal(text.includes('已截断'), false, '默认摘要未超限，不应出现截断提示')

  // ------------------------------------------- 2. 全量落盘 + detail:"full"
  assert.ok(existsSync(statusFile), '单任务 summary 模式也应落盘 status_latest.json')
  const fileText = readFileSync(statusFile, 'utf8')
  const onDisk = JSON.parse(fileText)
  assert.equal(onDisk.findings.length, 60, 'status_latest.json 的 findings 应为构造的 60 条')
  assert.equal(onDisk.brief, briefText, 'status_latest.json 应保存完整 brief')
  assert.equal(onDisk.goal, snapshot.goal, 'status_latest.json 应保存完整 goal')
  assert.equal(onDisk.description, snapshot.description, 'status_latest.json 应保存完整 description')
  assert.equal(onDisk.task_id, TASK_ID)

  const fullResult = await statusTool.execute({ task_id: TASK_ID, detail: 'full' }, ownerExec)
  assert.ok(fullResult.text.includes('完整快照已写入'), 'detail:"full" 应提示完整快照已写入')
  const fullBytes = Buffer.byteLength(readFileSync(statusFile, 'utf8'), 'utf8')
  assert.ok(fullResult.text.includes(`${fullBytes} 字节`), `full 输出应给准确字节数 ${fullBytes}`)
  assert.ok(fullResult.text.length <= 4000, 'full 模式返回的摘要同样受默认上限约束')

  // ------------------------------------------------------- 3. max_chars 截断
  const truncated = await statusTool.execute({ task_id: TASK_ID, max_chars: 300 }, ownerExec)
  assert.ok(truncated.text.length <= 300, `max_chars:300 时长度应 ≤ 300，实际 ${truncated.text.length}`)
  assert.ok(truncated.text.includes('已截断'), '截断输出应含"已截断"提示')

  // ------------------------------------------------------- 4. sections 过滤
  const usageOnly = await statusTool.execute({ task_id: TASK_ID, sections: ['usage'] }, ownerExec)
  const usageText = usageOnly.text
  assert.ok(usageText.includes(TASK_ID), 'sections 过滤后 header 仍在')
  assert.ok(usageText.includes('goals 1/2') && usageText.includes('发现 60'), 'sections 过滤后 header 计数仍在')
  assert.ok(usageText.includes('tokens 入 1234'), '应输出 usage 的 input_tokens')
  assert.ok(usageText.includes('/ 出 567'), '应输出 usage 的 output_tokens')
  assert.ok(usageText.includes('/ 调用 8'), '应输出 usage 的 calls')
  assert.equal(/^- #\d+ \[/m.test(usageText), false, 'sections:["usage"] 不应出现 finding 标题行')
  assert.equal(/^- \[goal#/m.test(usageText), false, 'sections:["usage"] 不应出现未达成 goal 行')
  assert.equal(usageText.includes('USAGE-BY-INTENT-MARKER'), false, '不应含 usage.by_intent')

  // -------------------------------------------------- 5. findings_limit 生效
  const limited = await statusTool.execute({ task_id: TASK_ID, findings_limit: 3 }, ownerExec)
  const limitedLines = limited.text.split('\n').filter(line => /^- #\d+ \[/.test(line))
  assert.equal(limitedLines.length, 3, `findings_limit:3 应只列 3 条标题，实际 ${limitedLines.length}`)
  assert.match(limitedLines[0], /^- #60 \[/, 'findings_limit 截取的是最新条目')
  assert.ok(limited.text.includes('…还有 57 条'), '应给未显示条数总计')
  assert.ok(limited.text.includes('发现 60'), '总计计数不因清单裁剪而丢失')

  // --------------------------------------- 6. graph_overview 摘要 / 落盘包装
  const overviewTask = createTask({
    id: 't-overview-1',
    description: 'overview output contract',
    goal: '验证 graph_overview 摘要化',
    goals: ['goal one', 'goal two'],
    constraints: [],
    ownerSession: OWNER,
    cwd: root,
    outDir: join(root, '.artex', 'tasks', 't-overview-1'),
    limits: {},
  })
  mkdirSync(overviewTask.outDir, { recursive: true })
  for (let i = 1; i <= 20; i += 1) recordFact(overviewTask, { summary: `fact-${i}`, outcome: 'found' })

  const overviewEngine = {
    roleOf: () => undefined,
    resolveTask: async (id) => {
      if (String(id) !== overviewTask.id) throw new Error(`ARTEX 任务 ${id} 不存在`)
      return overviewTask
    },
    liveTask: () => undefined,
    status: async () => null,
    cwdFor: async () => root,
    storeFor: () => ({ tasks: { ids: async () => [] } }),
    index: { ownerOf: async () => undefined },
  }
  const overviewTool = createTools({ engine: overviewEngine, config: DEFAULTS })
    .find(tool => tool.name === 'artex_graph_overview')
  assert.ok(overviewTool, '应注册 artex_graph_overview')
  for (const key of ['facts_limit', 'sections', 'max_chars']) {
    assert.ok(overviewTool.parameters?.properties?.[key], `artex_graph_overview 应支持参数 ${key}`)
  }

  const defaultOverview = JSON.parse((await overviewTool.execute({ task_id: overviewTask.id }, ownerExec)).text)
  assert.equal(defaultOverview.facts.recent.length, 10, 'facts_limit 默认应为 10')
  assert.equal(defaultOverview.facts.total, 20, 'facts.total 应为真实累计数')
  assert.equal(defaultOverview.facts.recent[0].summary, 'fact-20', 'facts.recent 应新→旧')

  const goalsOnly = JSON.parse((await overviewTool.execute({ task_id: overviewTask.id, sections: ['goals'] }, ownerExec)).text)
  assert.ok(goalsOnly.task && goalsOnly.task.id === overviewTask.id, 'sections 过滤后 task 永远保留')
  assert.equal(Array.isArray(goalsOnly.goals), true, 'sections:["goals"] 应保留 goals')
  assert.equal(goalsOnly.goals.length, 2)
  for (const key of ['facts', 'intents', 'findings', 'hints', 'todos', 'constraints', 'scope_violations']) {
    assert.equal(key in goalsOnly, false, `sections:["goals"] 不应包含 ${key}`)
  }
  for (const key of Object.keys(goalsOnly)) {
    assert.ok(['task', 'goals', 'stats', 'pending_approvals'].includes(key), `sections:["goals"] 出现了意外顶层键 ${key}`)
  }

  const tinyResult = await overviewTool.execute({ task_id: overviewTask.id, max_chars: 600 }, ownerExec)
  assert.ok(tinyResult.text.length <= 600, `overview max_chars:600 时长度应 ≤ 600，实际 ${tinyResult.text.length}`)
  const wrapper = JSON.parse(tinyResult.text)
  assert.equal(wrapper.truncated, true, '超限时应返回 truncated:true 的可解析包装')
  assert.equal(typeof wrapper.bytes, 'number', '包装应含 full 字节数')
  assert.ok(wrapper.bytes > 0)
  assert.ok(typeof wrapper.file === 'string' && wrapper.file.length > 0, '包装应含落盘路径')
  assert.equal(basename(wrapper.file), 'overview_latest.json', '落盘文件应为 overview_latest.json')
  assert.ok(existsSync(wrapper.file), '包装里的 file 必须真实存在')
  assert.ok(typeof wrapper.preview === 'string' && wrapper.preview.length > 0, '包装应含 preview')

  const savedOverview = JSON.parse(readFileSync(wrapper.file, 'utf8'))
  assert.equal(savedOverview.task.id, overviewTask.id, '落盘文件应是完整 view（未按 sections 过滤）')
  assert.equal(savedOverview.facts.recent.length, 10, '落盘 view 保留 overview 的 facts_limit 语义')
  assert.equal(savedOverview.facts.total, 20, '落盘 view 含完整事实计数')
  for (const key of ['facts', 'intents', 'findings', 'hints', 'todos', 'stats']) {
    assert.ok(key in savedOverview, `落盘 view 不应被 sections 过滤（缺 ${key}）`)
  }

  // ------------------------------------------------- 7. 无参列表模式仍可用
  const listStatuses = Array.from({ length: 5 }, (_, i) => ({
    task_id: `t-list-${i + 1}`,
    owner_session: OWNER,
    status: 'running',
    rounds: i,
    facts: i,
    findings: [],
    goal: `LONG-GOAL-MARKER-${i + 1}-${'g'.repeat(200)}`,
  }))
  const listingEngine = {
    roleOf: () => undefined,
    resolveTask: async (id) => { throw new Error(`列表模式不应 resolveTask(${id})`) },
    liveTask: () => undefined,
    status: async (taskId) => (taskId ? null : listStatuses),
    cwdFor: async () => root,
    storeFor: () => ({ tasks: { ids: async () => [] } }),
    index: { ownerOf: async () => undefined },
  }
  const listingTool = createTools({ engine: listingEngine, config: DEFAULTS })
    .find(tool => tool.name === 'artex_task_status')
  const listing = await listingTool.execute({ max_chars: 256 }, ownerExec)
  assert.ok(listing.text.length <= 256, `列表模式 max_chars:256 时长度应 ≤ 256，实际 ${listing.text.length}`)
  assert.ok(listing.text.includes('## 本进程任务'), '无参列表模式应保持原有输出格式')
  assert.ok(listing.text.includes('t-list-1'), '列表应含活动任务')
  assert.equal(listing.text.includes('t-list-5'), false, '超长列表应被 max_chars 截断而不是原样返回')
  assert.ok(listing.text.includes('已截断'), '列表模式截断应有提示')

  /* =====================================================================
   * 追加用例（代码评审建议，7 组）：落盘失败降级 / findings_limit:0 /
   * campaign 截断 / emoji 码点裁剪 / 超长 outDir 包装降级 / sections 字符串 /
   * findings 伴随键。
   * ===================================================================== */

  // 公共 helper：构造返回指定 snapshot 的 fake engine 并取 status 工具。
  const makeEngine = (snap, extra = {}) => ({
    roleOf: () => undefined,
    resolveTask: async (id) => ({ id: String(id), ownerSession: OWNER, outDir: snap?.out_dir }),
    liveTask: () => undefined,
    status: async (taskId) => (taskId ? snap : []),
    cwdFor: async () => root,
    storeFor: () => ({ tasks: { ids: async () => [] } }),
    index: { ownerOf: async () => undefined },
    ...extra,
  })
  const statusToolFor = (engine) => {
    const tool = createTools({ engine, config: DEFAULTS }).find(t => t.name === 'artex_task_status')
    assert.ok(tool, '应注册 artex_task_status')
    return tool
  }

  // A. out_dir 不可写：summary 不抛错且给降级提示；detail:"full" 必须抛可读错误。
  //    把 out_dir 指到一个"已存在文件"的子路径，mkdir 必然失败（ENOTDIR/EEXIST）。
  const blocker = join(root, 'blocked-by-file')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const badOutDir = join(blocker, 'nested', 't-status-bad')
  const badSnapshot = { ...snapshot, task_id: 't-status-bad', out_dir: badOutDir }
  const badTool = statusToolFor(makeEngine(badSnapshot))
  const badSummary = await badTool.execute({ task_id: 't-status-bad' }, ownerExec)
  assert.ok(badSummary.text.includes('快照落盘失败'), 'summary 落盘失败应降级提示而不是抛错')
  assert.equal(badSummary.text.includes('完整快照：'), false, '落盘失败时不应给出伪造的落盘指针')
  await assert.rejects(
    () => badTool.execute({ task_id: 't-status-bad', detail: 'full' }, ownerExec),
    /完整快照落盘失败/,
    'detail:"full" 落盘失败必须抛错',
  )

  // B. findings_limit: 0 → 无标题行、无"…还有"、header 计数仍在。
  const noTitles = await statusTool.execute({ task_id: TASK_ID, findings_limit: 0 }, ownerExec)
  assert.equal(/^- #\d+ \[/m.test(noTitles.text), false, 'findings_limit:0 不应出现标题行')
  assert.equal(noTitles.text.includes('Finding title'), false, 'findings_limit:0 不应出现任何标题文本')
  assert.ok(noTitles.text.includes('发现 60'), 'findings_limit:0 仍应给发现总数')
  assert.equal(noTitles.text.includes('…还有'), false, 'findings_limit:0 不应给"还有 N 条"提示')

  // C. campaign 模式：max_chars 硬上限 + 截断提示（引导看单任务全量）。
  const campaignView = {
    campaign: 'camp-x',
    tasks: Array.from({ length: 5 }, (_, i) => ({
      id: `t-camp-${i + 1}`,
      status: 'running',
      live: i === 0,
      goals_met: 1,
      goals_total: 2,
      facts: 3,
      findings_total: 4,
      findings_verified: 1,
      tokens: 100,
      violations: i,
      description: `CAMPAIGN-DESC-${i + 1}-${'d'.repeat(60)}`,
    })),
    totals: {
      tasks: 5, running: 1, goals_met: 5, goals_total: 10, facts: 15,
      findings_total: 20, findings_verified: 5, tokens: 500, violations: 3,
    },
  }
  const campaignTool = statusToolFor(makeEngine(snapshot, { campaignStatus: async () => campaignView }))
  const campaignText = (await campaignTool.execute({ campaign: 'camp-x', max_chars: 300 }, ownerExec)).text
  assert.ok(campaignText.length <= 300, `campaign 模式 max_chars:300 时长度应 ≤ 300，实际 ${campaignText.length}`)
  assert.ok(campaignText.includes('## 战役 camp-x'), 'campaign 模式应保留既有格式头部')
  assert.ok(campaignText.includes('已截断'), 'campaign 模式截断应有提示')
  assert.ok(campaignText.includes('单任务全量用'), 'campaign 截断提示应引导用 task_id 看单任务全量')

  // D. Unicode：标题按码点裁剪，输出不得出现孤代理（lone surrogate）。
  const hasLoneSurrogate = (value) => {
    const chars = String(value ?? '')
    for (let i = 0; i < chars.length; i += 1) {
      const code = chars.charCodeAt(i)
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = chars.charCodeAt(i + 1)
        if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
        i += 1
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        return true
      }
    }
    return false
  }
  const emojiTitle = '🔥 严重漏洞 '.repeat(20) // > 100 码点，必触发裁剪
  const emojiSnapshot = {
    ...snapshot,
    task_id: 't-status-emoji',
    pending_approvals: [],
    findings: [{ id: 1, title: emojiTitle, severity: 'high', status: 'open', intent_id: null }],
    findings_total: 1,
    findings_by_status: { open: 1, verified: 0, rejected: 0, needs_retest: 0 },
  }
  const emojiText = (await statusToolFor(makeEngine(emojiSnapshot))
    .execute({ task_id: 't-status-emoji' }, ownerExec)).text
  assert.equal(hasLoneSurrogate(emojiText), false, '输出不得含孤代理字符（emoji 被切成半个）')
  assert.ok(emojiText.includes('🔥 严重漏洞'), 'emoji finding 标题应可见')
  assert.match(emojiText, /^- #1 \[high\] .*…$/m, '超长 emoji 标题应按码点裁剪并以 … 结尾')

  // E. overview 超长 outDir：包装逐级降级后仍 ≤ max_chars 且可 JSON.parse。
  const longOutDir = join(
    root,
    ...Array.from({ length: 5 }, (_, i) => `long-layer-${i + 1}-${'x'.repeat(15)}`),
    't-overview-long',
  )
  const longTask = createTask({
    id: 't-overview-long',
    description: 'long out_dir wrapper',
    goal: 'g',
    goals: ['goal one'],
    constraints: [],
    ownerSession: OWNER,
    cwd: root,
    outDir: longOutDir,
    limits: {},
  })
  for (let i = 1; i <= 20; i += 1) recordFact(longTask, { summary: `longfact-${i}` })
  const longEngine = {
    roleOf: () => undefined,
    resolveTask: async () => longTask,
    liveTask: () => undefined,
    status: async () => null,
    cwdFor: async () => root,
    storeFor: () => ({ tasks: { ids: async () => [] } }),
    index: { ownerOf: async () => undefined },
  }
  const longTool = createTools({ engine: longEngine, config: DEFAULTS })
    .find(t => t.name === 'artex_graph_overview')
  const longWrapperText = (await longTool.execute({ task_id: longTask.id, max_chars: 256 }, ownerExec)).text
  assert.ok(longWrapperText.length <= 256, `超长 outDir 包装应 ≤ 256 字符，实际 ${longWrapperText.length}`)
  const longWrapper = JSON.parse(longWrapperText) // 逐级降级后必须仍是合法 JSON
  assert.equal(longWrapper.truncated, true, '超长 outDir 包装仍应标记 truncated')
  assert.equal(typeof longWrapper.bytes, 'number', '超长 outDir 包装仍应带 bytes')

  // F. sections 传字符串 'usage' 与 ['usage'] 等价（含 tokens 行）。
  const stringUsage = await statusTool.execute({ task_id: TASK_ID, sections: 'usage' }, ownerExec)
  assert.equal(stringUsage.text, usageText, "sections: 'usage' 应与 sections: ['usage'] 输出一致")
  assert.ok(stringUsage.text.includes('tokens 入 1234'), 'sections 字符串形态仍应输出 usage 行')

  // G. sections:['findings'] 必须带伴随键 findings_total（总量在顶层而非块内）。
  for (let i = 1; i <= 3; i += 1) reportFinding(overviewTask, { title: `finding-${i}`, severity: 'high' })
  const findingsOnly = JSON.parse((await overviewTool.execute(
    { task_id: overviewTask.id, sections: ['findings'] },
    ownerExec,
  )).text)
  assert.ok(Array.isArray(findingsOnly.findings), 'sections:["findings"] 应保留 findings 块')
  assert.equal(findingsOnly.findings.length, 3)
  assert.ok('findings_total' in findingsOnly, 'sections:["findings"] 应保留 findings_total 伴随键')
  assert.equal(findingsOnly.findings_total, 3, 'findings_total 应与真实发现数一致')
  assert.equal('facts' in findingsOnly, false, 'sections:["findings"] 不应包含 facts')

  console.log('OK status-output', {
    defaultBytes: Buffer.byteLength(text, 'utf8'),
    defaultChars: text.length,
    findingTitles: findingLines.length,
    findingsOnDisk: onDisk.findings.length,
    truncatedChars: truncated.text.length,
    usageSection: 'ok',
    findingsLimit: limitedLines.length,
    overviewFacts: defaultOverview.facts.recent.length,
    overviewWrapperBytes: wrapper.bytes,
    listingChars: listing.text.length,
    extraCases: 7,
    degradedWrite: 'summary-degrades/full-throws',
    findingsLimitZero: 'no-title-lines',
    campaignChars: campaignText.length,
    unicodeSafe: !hasLoneSurrogate(emojiText),
    longOutDirWrapperChars: longWrapperText.length,
    sectionsString: 'equals-array',
    findingsCompanions: findingsOnly.findings_total,
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
