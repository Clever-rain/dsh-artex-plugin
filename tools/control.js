/**
 * control 工具组。
 */

import { artifact, callerOf, describe, integer, strings, isOwner, resolve, requireOwner, requireRead, pickLimits, liveRuntime, RUN_PARAMETERS } from '../tools-shared.js'
import { STATUS_MAX_CHARS, capText, clampInt, formatStatusSummary, writeJsonAtomic } from './status-format.js'

/** run/start 共用：把参数收拢成 startTask 的 policy 形状（防线字段一并透传）。 */
function policyFromArgs(args) {
  return {
    allowedTools: args.allowed_tools,
    readOnly: args.read_only,
    allowedPaths: args.allowed_paths,
    allowedTargets: args.allowed_targets,
    scopeEnforcement: args.scope_enforcement,
    engagement: args.engagement,
    redactEvidence: args.redact_evidence,
    maxTokensPerIntent: args.max_tokens_per_intent,
    skillPacks: args.skill_packs,
  }
}

/**
 * 单任务状态：摘要 + 全量快照落盘指针。
 *
 * 默认（detail=summary）只把有界摘要返回会话，完整 snapshot 尽力写到
 * `<out_dir>/status_latest.json`；写盘失败降级为一行提示，不拖垮监控。
 * detail=full 要求必须写成功（显式要全量却没盘可读，直接报错更诚实）。
 */
async function taskStatusReply(snapshot, args, maxChars) {
  const detail = args.detail === 'full' ? 'full' : 'summary'
  const summary = formatStatusSummary(snapshot, {
    findingsLimit: clampInt(args.findings_limit, 10, 0, 50),
    sections: args.sections,
  })
  const outDir = typeof snapshot?.out_dir === 'string' ? snapshot.out_dir : ''
  let file
  let failure
  if (outDir) {
    try {
      file = await writeJsonAtomic(outDir, 'status_latest.json', snapshot)
    } catch (error) {
      failure = String(error?.message || error)
    }
  }
  if (detail === 'full' && !file) {
    throw new Error(`完整快照落盘失败${outDir ? `（${outDir}）` : '（任务快照缺少 out_dir）'}：${failure || '未知原因'}`)
  }
  const lines = [summary]
  if (file) {
    lines.push(`${detail === 'full' ? '完整快照已写入' : '完整快照'}：${file.path}（${file.bytes} 字节；read/grep 按需取）`)
  } else if (failure) {
    lines.push(`（快照落盘失败：${String(failure).slice(0, 80)}）`)
  }
  const note = file
    ? `…（输出已截断至 ${maxChars} 字符；完整快照：${file.path}）`
    : `…（输出已截断至 ${maxChars} 字符）`
  return capText(lines.join('\n'), maxChars, note).text
}

export function controlTools({ engine, config }) {
  const engineNote = config.isolateWorkdir
    ? '子会话在任务目录下的独立工作目录里工作'
    : '子会话继承当前工作区目录'
  return [
    artifact({
      name: 'artex_run_task',
      description: `用 ARTEX 多 agent 编排跑一个**长程、可分解、需要多方向并行推进**的目标：规划者(planner)按图态势派意图，多个执行者(worker)并发领取意图干活并写回事实，图一变就唤醒规划者，直到所有验收目标被证据证明。适合"需要多轮探索/多方并行/结论要沉淀成事实库"的任务；单步任务直接用普通工具，不要用它。

行为：**阻塞**直到任务结束（完成/超时/停止/无新方向），返回结构化报告。内部会为每一轮规划、每条意图各开一个子会话（真实 subagent，${engineNote}），因此会产生多次模型调用。过程中可以用 artex_task_status 另开任务查看进度，但本调用本身不返回中间状态。

写回模型：worker 通过 artex_record_fact（结论，带 evidence/confidence/outcome）、artex_report_finding（已验证成果）、artex_add_resource（新实体）把产出写进任务图谱；规划者只维护 brief、派意图、证明目标。
mode：objective（默认，首个充分突破即收官，可并行 pursue）或 audit（覆盖最大化，enumerate 逐项验证，正负结果都算覆盖）。`,
      parameters: { type: 'object', properties: RUN_PARAMETERS, required: ['goal'], additionalProperties: false },
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        if (role) throw new Error('ARTEX 子会话不能启动新任务（只允许所有者会话）')
        const rt = await engine.startTask({
          agent,
          goal: args.goal,
          description: args.description || args.goal,
          goals: args.goals,
          constraints: args.constraints,
          mode: args.mode,
          viewMode: args.view_mode,
          analyst: args.analyst,
          limits: pickLimits(args),
          policy: policyFromArgs(args),
          confirm: args.confirm,
          campaign: args.campaign,
          signal: exec.signal,
        })
        const stop = () => { void engine.stopTask(rt.task.id, '调用方中断') }
        exec.signal?.addEventListener?.('abort', stop, { once: true })
        try {
          const task = await rt.done
          return engine.report(task)
        } finally {
          exec.signal?.removeEventListener?.('abort', stop)
        }
      },
    }),
    artifact({
      name: 'artex_start_task',
      description: '后台启动一个 ARTEX 编排任务，立即返回 task_id，不阻塞当前轮。之后用 artex_task_status 查看进度、artex_stop_task 停止、artex_add_hint 注入战略提示。注意：后台任务结束时**不会**自动唤醒本会话，需要你（或用户）主动轮询状态。',
      parameters: { type: 'object', properties: RUN_PARAMETERS, required: ['goal'], additionalProperties: false },
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        if (role) throw new Error('ARTEX 子会话不能启动新任务（只允许所有者会话）')
        const rt = await engine.startTask({
          agent,
          goal: args.goal,
          description: args.description || args.goal,
          goals: args.goals,
          constraints: args.constraints,
          mode: args.mode,
          viewMode: args.view_mode,
          analyst: args.analyst,
          limits: pickLimits(args),
          policy: policyFromArgs(args),
          confirm: args.confirm,
          campaign: args.campaign,
          signal: exec.signal,
        })
        const scopeLine = rt.task.policy.allowedTargets.length > 0
          ? `\nscope：${rt.task.policy.allowedTargets.join(', ')}（越界处置：${engine.scopeEnforcement(rt.task)}）`
          : ''
        const engagementLine = rt.task.engagement ? `\n交战绑定：${rt.task.engagement.id}` : ''
        const campaignLine = rt.task.campaign ? `\n战役：${rt.task.campaign}` : ''
        return `ARTEX 任务已在后台启动：${rt.task.id}（${rt.task.mode} 模式 / 视野 ${rt.task.viewMode || 'planner'}）
目标：${rt.task.goal}
验收目标：${rt.task.goals.map(g => `\n  - [goal#${g.id}] ${g.text}`).join('')}
并发 worker：${rt.task.limits.maxWorkers} · 轮次上限：${rt.task.limits.maxRounds}${rt.task.limits.budgetMs ? ` · 预算：${Math.round(rt.task.limits.budgetMs / 1000)}s` : ''}${scopeLine}${engagementLine}${campaignLine}
快照目录：${rt.task.outDir}

下一步：artex_task_status(task_id="${rt.task.id}") 查看进度；artex_add_hint 注入提示；artex_stop_task 停止。`
      },
    }),
    artifact({
      name: 'artex_task_status',
      description: `查看 ARTEX 任务状态。**默认只回有界摘要**（状态/轮次/goals/意图计数/事实/发现标题/pending_approvals/结束原因），完整 snapshot 落盘到 \`<out_dir>/status_latest.json\`，会话里只留路径指针——长任务反复轮询也不会把运行态灌进上下文。需要细节时用 read/grep 读落盘文件，或 artex_node_detail 按 id 取节点；不要靠反复轮询拿全量。
不传 task_id 时列出本会话内存里的所有任务（以及当前工作区磁盘上的历史任务 id）。传 campaign 时给出该战役的跨任务聚合视图；list_campaigns=true 列出索引知悉的全部战役。
detail:"full" 强制写 status_latest.json（失败即报错）并返回路径+字节数；summary 模式落盘失败只降级提示。sections 可只要其中几块；findings_limit 控制标题清单条数；max_chars 是单次返回硬上限（默认 4000）。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id；省略则列出任务'),
          campaign: describe('可选：战役 id——聚合该战役下全部任务（P3-1）'),
          list_campaigns: { type: 'boolean', description: '可选：true=列出索引知悉的全部战役名' },
          detail: { type: 'string', enum: ['summary', 'full'], description: 'summary=只回摘要（默认，尽力落盘）；full=强制写 <out_dir>/status_latest.json 并返回路径+字节数' },
          findings_limit: integer('发现标题清单条数（默认 10，0=不列标题，仅保留计数）'),
          sections: {
            type: 'array',
            items: { type: 'string', enum: ['goals', 'intents', 'facts', 'findings', 'usage', 'hints', 'todos', 'scope'] },
            description: '可选：只输出这些摘要块（缺省=goals+findings；header/审批/结束原因/落盘指针始终保留）',
          },
          max_chars: integer('单次返回字符硬上限（默认 4000，clamp 256..200000）'),
        },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        const maxChars = clampInt(args.max_chars, STATUS_MAX_CHARS, 256, 200000)
        if (args.list_campaigns === true) {
          const names = await engine.campaignList()
          const text = names.length > 0 ? `索引知悉的战役：\n${names.map(n => `- ${n}`).join('\n')}` : '索引里还没有任何战役。'
          return capText(text, maxChars, '…（输出已截断）').text
        }
        if (args.campaign) {
          const view = await engine.campaignStatus(String(args.campaign))
          const lines = view.tasks.map(t => `- ${t.id} [${t.status}${t.live ? '/live' : ''}] goals ${t.goals_met}/${t.goals_total} · facts ${t.facts} · findings ${t.findings_total}（verified ${t.findings_verified}）· tokens ${t.tokens}${t.violations > 0 ? ` · ⚠越界 ${t.violations}` : ''} · ${t.description}`)
          const text = `## 战役 ${view.campaign}（${view.totals.tasks} 个任务，${view.totals.running} 个在跑）
目标达成：${view.totals.goals_met}/${view.totals.goals_total} · 事实 ${view.totals.facts} · 发现 ${view.totals.findings_total}（verified ${view.totals.findings_verified}）· tokens ${view.totals.tokens} · 越界 ${view.totals.violations}

${lines.length > 0 ? lines.join('\n') : '（索引里没有该战役的任务）'}`
          return capText(text, maxChars, `…（输出已截断至 ${maxChars} 字符；单任务全量用 artex_task_status(task_id=...)）`).text
        }
        if (args.task_id) {
          const task = await engine.resolveTask(String(args.task_id))
          requireRead(agent, role, task, config)
          const snapshot = await engine.status(String(task.id))
          return taskStatusReply(snapshot, args, maxChars)
        }
        const all = await engine.status(undefined, { ownerSession: agent.id, taskIds: role ? [role.taskId] : [] })
        const live = all.filter(s => String(s.owner_session) === String(agent.id) || (role && String(s.task_id) === String(role.taskId)))
        const cwd = await engine.cwdFor(agent, exec.signal)
        const onDisk = await engine.storeFor(cwd).tasks.ids()
        const liveIds = new Set(all.map(t => t.task_id))
        const listing = live.length > 0
          ? live.map(t => `- ${t.task_id} [${t.status}] rounds=${t.rounds} facts=${t.facts} findings=${t.findings.length} · ${String(t.goal ?? '').slice(0, 100)}`).join('\n')
          : '- （本进程内没有活动任务）'
        const history = []
        for (const id of onDisk.slice(0, 50)) {
          if (history.length >= 10) break
          if (liveIds.has(id)) continue
          try {
            const owner = await engine.index.ownerOf(id)
            if (owner) {
              if (String(owner) === String(agent.id) || (role && String(role.taskId) === String(id))) history.push(id)
              continue
            }
            // 旧索引条目没有 ownerSession：回退加载一次快照。
            const task = await engine.loadTask(id)
            if (!task) continue
            if (String(task.ownerSession) === String(agent.id) || (role && String(role.taskId) === String(id))) history.push(id)
          } catch { /* 跳过损坏或不可读的快照 */ }
          if (history.length >= 10) break
        }
        const text = `## 本进程任务
${listing}
${history.length > 0 ? `\n## 磁盘上其它任务\n${history.map(id => `- ${id}`).join('\n')}` : ''}`
        return capText(text, maxChars, '…（输出已截断）').text
      },
    }),
    artifact({
      name: 'artex_stop_task',
      description: '停止一个正在运行的 ARTEX 任务。mode=stop（默认）= 终止：状态记 stopped；mode=pause = 暂停保留现场（事实/发现/意图/brief 落盘，状态 paused），之后用 artex_resume_task 重挂续跑。省略 task_id 时作用于本会话启动的活动任务。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          reason: describe('停止原因（记录到任务快照）'),
          mode: { type: 'string', enum: ['stop', 'pause'], description: 'stop=终止（默认）；pause=暂停，所有现场保留可查，需后续 resume' },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        let taskId = args.task_id || role?.taskId
        if (!taskId) {
          const own = [...engine.tasks.values()].find(rt => !rt.finished && isOwner(agent, rt.task))
          taskId = own?.task.id
        }
        if (!taskId) throw new Error('找不到要停止的任务：请显式传 task_id')
        const task = await engine.resolveTask(taskId)
        requireOwner(agent, task)
        if (args.mode === 'pause') {
          const ok = await engine.pauseTask(task.id, args.reason || '主 agent 暂停')
          if (!ok) throw new Error(`任务 ${task.id} 不在运行中`)
          return `已请求暂停 ${task.id}；现场按 paused 落盘，artex_resume_task 可重挂续跑（需重新给预算）。`
        }
        const ok = await engine.stopTask(task.id, args.reason || '主 agent 停止')
        if (!ok) throw new Error(`任务 ${task.id} 不在运行中`)
        return `已请求停止 ${task.id}；在跑的子会话被中断，状态将在下一拍落盘。`
      },
    }),
    artifact({
      name: 'artex_resume_task',
      description: '恢复一个 paused/stopped/timeout/max_rounds 的 ARTEX 任务：从任务目录重新挂载现场（facts/findings/意图/brief/usage 全部保留，跑中意图回炉重领）。**必须显式给新预算**（budget_ms），避免旧任务无界续跑。已完成的任务不可恢复。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', required: true, description: '要恢复的任务 id' },
          budget_ms: { type: 'integer', required: true, description: '本次恢复窗口的时间预算（毫秒，必填，>0）' },
          max_rounds: integer('可选：覆盖调度轮数上限（其它 limits 通过名字透传，名字与 start 同名）'),
          max_workers: integer('可选：覆盖 worker 并发数'),
          max_tokens: integer('可选：覆盖 token 预算'),
        },
        required: ['task_id', 'budget_ms'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        if (role) throw new Error('ARTEX 子会话不能恢复任务（只允许所有者会话）')
        const limits = pickLimits(args)
        const rt = await engine.resumeTask({
          agent,
          taskId: args.task_id,
          budgetMs: args.budget_ms,
          limits,
          signal: exec.signal,
        })
        return `任务 ${rt.task.id} 已重挂续跑：状态 ${rt.task.status}，预算窗口 ${Math.round(args.budget_ms / 1000)}s，round=${rt.task.round}，facts=${rt.task.stats.facts}，findings=${rt.task.stats.findings}。`
      },
    }),
    artifact({
      name: 'artex_add_hint',
      description: '给运行中的 ARTEX 任务注入战略提示（会立刻唤醒规划者写入本轮态势，并在后续每轮的 hints 里可见）。用于人在环路纠偏：换重点、排除某方向、提醒某条已知线索。可一次给多条。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id；省略时用调用者所属任务'),
          hints: strings('要注入的提示（优先用数组批量提交）'),
          text: describe('[单条] 提示内容'),
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, role, task } = await resolve(engine, exec, args.task_id)
        requireOwner(agent, task)
        liveRuntime(engine, task)
        const texts = Array.isArray(args.hints) && args.hints.length > 0
          ? args.hints
          : args.text ? [args.text] : []
        if (texts.length === 0) throw new Error('hints 或 text 至少给一个')
        const added = engine.addHint(task, texts.map(String))
        void role
        return `已注入 ${added.length} 条提示：${added.map(h => `#${h.id}`).join(' ')}。规划者已被唤醒。`
      },
    }),
    artifact({
      name: 'artex_resolve_approval',
      description: `裁决一个待审批意图（P1-2 审批门，owner-only）：worker/planner 把高风险动作挂起后（意图 approval.pending，状态查询的 pending_approvals 可见），approve=放行（意图恢复派发，批示会随提示词传给 worker）；reject=终止该意图。所有裁决都会落过程库审计轨迹。`,
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          intent_id: { type: 'integer', required: true, description: '待审批的意图 id' },
          decision: { type: 'string', enum: ['approve', 'reject'], required: true, description: 'approve=批准放行；reject=拒绝并终止意图' },
          note: describe('可选：批示（批准时会随提示词传给重新派发的 worker；拒绝时作为终止理由）'),
        },
        required: ['intent_id', 'decision'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const { agent, task } = await resolve(engine, exec, args.task_id)
        requireOwner(agent, task)
        liveRuntime(engine, task)
        const { intent, decision } = engine.resolveApproval(task, args.intent_id, args.decision, args.note || '')
        return decision === 'approved'
          ? `意图 #${intent.id} 已批准放行：${intent.summary}\n调度器将在下一拍重新派发；批示已随提示词下发。`
          : `意图 #${intent.id} 已被拒绝并终止（state=stopped, reason=approval_rejected）：${intent.summary}`
      },
    }),
  ]
}
