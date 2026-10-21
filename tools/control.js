/**
 * control 工具组。
 */

import { artifact, callerOf, describe, strings, isOwner, resolve, requireOwner, requireRead, pickLimits, RUN_PARAMETERS } from '../tools-shared.js'

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
          signal: exec.signal,
        })
        return `ARTEX 任务已在后台启动：${rt.task.id}（${rt.task.mode} 模式 / 视野 ${rt.task.viewMode || 'planner'}）
目标：${rt.task.goal}
验收目标：${rt.task.goals.map(g => `\n  - [goal#${g.id}] ${g.text}`).join('')}
并发 worker：${rt.task.limits.maxWorkers} · 轮次上限：${rt.task.limits.maxRounds}${rt.task.limits.budgetMs ? ` · 预算：${Math.round(rt.task.limits.budgetMs / 1000)}s` : ''}
快照目录：${rt.task.outDir}

下一步：artex_task_status(task_id="${rt.task.id}") 查看进度；artex_add_hint 注入提示；artex_stop_task 停止。`
      },
    }),
    artifact({
      name: 'artex_task_status',
      description: '查看 ARTEX 任务状态：状态/轮次/目标达成情况/意图计数/事实与发现/待办/上限。不传 task_id 时列出本会话内存里的所有任务（以及当前工作区磁盘上的历史任务 id）。',
      parameters: {
        type: 'object',
        properties: { task_id: describe('可选：任务 id；省略则列出任务') },
        additionalProperties: false,
      },
      concurrent: true,
      async execute(args, exec) {
        const { agent, role } = callerOf(engine, exec)
        if (args.task_id) {
          const task = await engine.resolveTask(String(args.task_id))
          requireRead(agent, role, task, config)
          const snapshot = await engine.status(String(task.id))
          return `${snapshot.task_id} [${snapshot.status}] (${snapshot.mode}/${snapshot.view_mode}) ${snapshot.goal}
轮次 ${snapshot.rounds} · 意图 ${JSON.stringify(snapshot.intents.by_state)} · 事实 ${snapshot.facts} · 发现 ${snapshot.findings_total ?? snapshot.findings.length} · 资源 ${snapshot.resources}${snapshot.brief_round ? ` · brief@r${snapshot.brief_round}` : ''}
用时 ${Math.round(snapshot.elapsed_ms / 1000)}s${snapshot.finish_detail ? ` · ${snapshot.finish_detail}` : ''}

${JSON.stringify(snapshot)}`
        }
        const all = await engine.status(undefined, { ownerSession: agent.id, taskIds: role ? [role.taskId] : [] })
        const live = all.filter(s => String(s.owner_session) === String(agent.id) || (role && String(s.task_id) === String(role.taskId)))
        const cwd = await engine.cwdFor(agent, exec.signal)
        const onDisk = await engine.storeFor(cwd).tasks.ids()
        const liveIds = new Set(all.map(t => t.task_id))
        const listing = live.length > 0
          ? live.map(t => `- ${t.task_id} [${t.status}] rounds=${t.rounds} facts=${t.facts} findings=${t.findings.length} · ${t.goal}`).join('\n')
          : '- （本进程内没有活动任务）'
        const history = []
        for (const id of onDisk.slice(0, 50)) {
          if (liveIds.has(id)) continue
          try {
            const task = await engine.loadTask(id)
            if (!task) continue
            if (String(task.ownerSession) === String(agent.id) || (role && String(role.taskId) === String(id))) history.push(id)
          } catch { /* 跳过损坏或不可读的快照 */ }
          if (history.length >= 10) break
        }
        return `## 本进程任务
${listing}
${history.length > 0 ? `\n## 磁盘上其它任务\n${history.map(id => `- ${id}`).join('\n')}` : ''}`
      },
    }),
    artifact({
      name: 'artex_stop_task',
      description: '停止一个正在运行的 ARTEX 任务：中断所有在跑 worker 与 planner，任务状态记为 stopped。省略 task_id 时停止本会话启动的活动任务。',
      parameters: {
        type: 'object',
        properties: {
          task_id: describe('可选：任务 id'),
          reason: describe('停止原因（记录到任务快照）'),
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
        const ok = await engine.stopTask(task.id, args.reason || '主 agent 停止')
        if (!ok) throw new Error(`任务 ${task.id} 不在运行中`)
        return `已请求停止 ${task.id}；在跑的子会话被中断，状态将在下一拍落盘。`
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
  ]
}
