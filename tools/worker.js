/**
 * worker 工具组。
 */

import { artifact, describe, integer, boolean, strings, resolve, requireOwner, requireRole, requireRead, liveRuntime, pickLimits, RUN_PARAMETERS } from '../tools-shared.js'

export function workerTools({ engine, config }) {
  return [
    artifact({
      name: 'artex_record_fact',
      description: `执行者写回：把本意图得到的**结论/观察/判断**写进探索图（不是资源，也不是已验证成果）。
纪律：多个观察汇总成**一条**事实（summary 一句话 + detail 展开），默认就写一条；只写增量；只写真实看到的——给 evidence，标 confidence。
outcome 用于覆盖/路径判定：found=发现/验证成功；none=按方法测过但未命中（负结果，算覆盖）；inconclusive=无法判定；blueprint=其它可行路径的蓝图（不执行）。
task 所有者与 worker 可调用。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intent_id: integer('来源意图 id；worker 省略时自动挂到自己领到的意图'),
          summary: describe('一句话结论（默认单条）'),
          detail: describe('对 summary 的展开：观察到的细节、过程、推理'),
          evidence: describe('一行证据：命令/操作 + 关键输出'),
          confidence: { type: 'string', enum: ['observed', 'inferred'], description: 'observed=直接看到；inferred=据现象推断（默认 observed）' },
          outcome: { type: 'string', enum: ['found', 'none', 'inconclusive', 'blueprint'], description: 'found=命中；none=测过未命中（算覆盖）；inconclusive=无法判定；blueprint=备选路径蓝图' },
          resource_ids: { type: 'array', items: { type: 'integer' }, description: '这条结论锚定的资源 id' },
          facts: {
            type: 'array',
            description: '（极少数例外）只在确有彼此完全独立、无法归并的结论时才用数组分条',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string', required: true },
                detail: describe('展开'),
                evidence: describe('证据'),
                confidence: { type: 'string', enum: ['observed', 'inferred'] },
                outcome: { type: 'string', enum: ['found', 'none', 'inconclusive', 'blueprint'] },
              },
              required: ['summary'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker'])
        liveRuntime(engine, task)
        const intentId = args.intent_id ?? role?.intentId ?? undefined
        const entries = Array.isArray(args.facts) && args.facts.length > 0
          ? args.facts.map(f => ({
            ...f,
            intentId,
            resourceIds: f.resource_ids ?? args.resource_ids,
          }))
          : [{
            summary: args.summary,
            detail: args.detail,
            evidence: args.evidence,
            confidence: args.confidence,
            outcome: args.outcome,
            intentId,
            resourceIds: args.resource_ids,
          }]
        if (!entries[0].summary) throw new Error('summary 不能为空')
        const facts = engine.recordFacts(task, entries, intentId)
        return `已写回 ${facts.length} 条事实：${facts.map(f => `#${f.id}`).join(' ')}（confidence=${facts.map(f => f.confidence).join(',')}${facts.some(f => f.outcome) ? `, outcome=${facts.map(f => f.outcome || '-').join(',')}` : ''}）`
      },
    }),
    artifact({
      name: 'artex_report_finding',
      description: `执行者写回：登记一个**已验证的成果/发现**（有可复现证据）。只有本次真实复现或验证过、能给出可复现步骤或证据才用；"看起来像/版本匹配/推断可行"一律改为 artex_record_fact（confidence=inferred）。
登记后会立即唤醒规划者（不必等本 worker 结束），并进入任务发现列表。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intent_id: integer('来源意图 id；worker 省略时自动挂到自己领到的意图'),
          title: { type: 'string', required: true, description: '一句话成果标题' },
          detail: describe('详细说明：是什么、影响、复现步骤'),
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info', 'unknown'], description: '严重度/重要性（默认 unknown）' },
          evidence: describe('可复现证据：命令/请求 + 关键输出，或复现步骤'),
          resource_ids: { type: 'array', items: { type: 'integer' }, description: '关联资源 id' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker'])
        liveRuntime(engine, task)
        if (!String(args.title || '').trim()) throw new Error('title 不能为空')
        const finding = engine.recordFinding(task, {
          title: args.title,
          detail: args.detail,
          severity: args.severity,
          evidence: args.evidence,
          resourceIds: args.resource_ids,
          intentId: args.intent_id ?? role?.intentId ?? undefined,
        })
        return `已登记发现 #${finding.id}：${finding.title}（severity=${finding.severity}）。规划者已被唤醒。`
      },
    }),
    artifact({
      name: 'artex_add_resource',
      description: `登记本任务发现、以后要反复引用的对象（文件/接口/主机/服务/数据表/模块/凭据/依赖……）：只登记对象本身，判断与结论用 artex_record_fact。资源图跨任务共享，按 (type,key||name) 去重，重复登记返回已有 id。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          resources: {
            type: 'array',
            description: '资源数组（优先用这个批量登记）',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', required: true, description: '资源类型，如 file/api/host/service/dataset/module/credential' },
                name: { type: 'string', required: true, description: '可识别的名字（路径/URL/主机名/表名…）' },
                key: describe('可选：去重键（缺省用 name）'),
                attrs: { type: 'object', additionalProperties: true, description: '可选：结构化属性' },
              },
              required: ['type', 'name'],
              additionalProperties: false,
            },
          },
          type: describe('[单条] 资源类型'),
          name: describe('[单条] 资源名'),
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireRole(agent, role, task, ['worker', 'planner'])
        liveRuntime(engine, task)
        const items = Array.isArray(args.resources) && args.resources.length > 0
          ? args.resources
          : args.name ? [{ type: args.type || 'resource', name: args.name }] : []
        if (items.length === 0) throw new Error('resources 或 name 至少给一个')
        const results = await engine.addResources(task, items, role)
        return `已登记 ${results.length} 个资源：${results.map(r => `#${r.id} ${r.name}${r.created ? '' : '(已存在)'}`).join('；')}`
      },
    }),
  ]
}
