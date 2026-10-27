/**
 * 最终报告渲染：把任务快照渲染成模型/人可读的 Markdown。
 */

const fmtTokens = (n) => String(Number(n) || 0)

export function formatReport(task) {
  const elapsed = task.endedAt ? Math.round((task.endedAt - task.createdAt) / 1000) : 0
  const stateCount = {}
  for (const i of task.intents) stateCount[i.state] = (stateCount[i.state] || 0) + 1
  const usage = task.usage || { input_tokens: 0, output_tokens: 0, calls: 0 }
  const usageTotal = (usage.input_tokens || 0) + (usage.output_tokens || 0)
  const usageLine = usage.calls > 0
    ? `\n- 用量：输入 ${fmtTokens(usage.input_tokens)} / 输出 ${fmtTokens(usage.output_tokens)} tokens（合计 ${fmtTokens(usageTotal)}，${usage.calls} 次模型调用）`
    : ''
  // 成本分解：按角色 + 按意图 + 按工具调用计数（活动窗口代理）。
  const usageSections = []
  if (usage.calls > 0 && usage.by_role) {
    const rows = Object.entries(usage.by_role)
      .filter(([, slot]) => (slot.calls || 0) > 0)
      .map(([role, slot]) => `- ${role}: ${fmtTokens((slot.input_tokens || 0) + (slot.output_tokens || 0))}（${slot.calls} 次）`)
    if (rows.length > 0) usageSections.push(`### 按角色\n${rows.join('\n')}`)
  }
  if (usage.calls > 0 && usage.by_intent) {
    const rows = Object.entries(usage.by_intent)
      .map(([key, slot]) => ({ key, total: (slot.input_tokens || 0) + (slot.output_tokens || 0), calls: slot.calls || 0 }))
      .filter(x => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 15)
      .map((x) => {
        const intent = x.key.startsWith('#') ? task.intents.find(i => `#${i.id}` === x.key) : undefined
        return `- ${x.key}: ${fmtTokens(x.total)}（${x.calls} 次${intent ? ` · ${String(intent.summary).slice(0, 60)}` : ''}）`
      })
    if (rows.length > 0) usageSections.push(`### 按意图（top 15）\n${rows.join('\n')}`)
  }
  const stepCounts = new Map()
  for (const act of Array.isArray(task.activities) ? task.activities : []) {
    if (act.kind !== 'step' || !act.tool) continue
    stepCounts.set(act.tool, (stepCounts.get(act.tool) || 0) + 1)
  }
  if (stepCounts.size > 0) {
    const top = [...stepCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    usageSections.push(`### 按工具（活动窗口内调用计数）\n${top.map(([name, n]) => `- ${name}: ${n}`).join('\n')}`)
  }
  const usageBlock = usageSections.length > 0 ? `\n\n## 成本分解\n\n${usageSections.join('\n\n')}` : ''
  // 发现状态分组与证据冲突。
  const findingStatus = { open: 0, verified: 0, rejected: 0, needs_retest: 0 }
  for (const f of task.findings) findingStatus[f.status || 'open'] = (findingStatus[f.status || 'open'] || 0) + 1
  const findingStatusNote = task.stats.findings > 0
    ? `（verified ${findingStatus.verified} / open ${findingStatus.open} / rejected ${findingStatus.rejected} / needs_retest ${findingStatus.needs_retest}）`
    : ''
  const conflictsTotal = Array.isArray(task.conflicts) ? task.conflicts.length : 0
  const conflictLines = conflictsTotal > 0
    ? `\n\n## 证据冲突\n${task.conflicts.map(c => `- [conflict#${c.id}] #${c.a} ↔ #${c.b}（${c.kind}）${c.note ? `：${String(c.note).slice(0, 120)}` : ''}`).join('\n')}`
    : ''
  const cov = task.report?.coverage
  const coverageBlock = task.mode === 'audit' && cov
    ? `\n\n## 覆盖矩阵\n覆盖 ${cov.covered}/${cov.total} 条目标${cov.gaps.length > 0 ? `；**仍有缺口 goal ${cov.gaps.map(id => `#${id}`).join(' ')}**（如刻意接受，请在会话说明）` : '；无缺口'}`
    : ''
  const goalLines = task.goals
    .map(g => `- ${g.status === 'met' ? '✔' : '☐'} [goal#${g.id}] ${g.text}${g.evidence ? `（证据 #${g.evidence}${g.evidenceOutcome ? `/${g.evidenceOutcome}` : ''}）` : ''}${g.reason ? ` — ${g.reason}` : ''}`)
    .join('\n')
  const capped = (lines, limit) => lines.length > limit
    ? [...lines.slice(0, limit), `- …另 ${lines.length - limit} 条（见任务快照）`]
    : lines
  const findingLines = task.findings.length > 0
    ? capped(task.findings.map(f => `- [finding#${f.id}] ${f.title}（severity=${f.severity}, intent#${f.intentId ?? '-'}）`), 30).join('\n')
    : '- （无）'
  const intentLine = (i) => `- [intent#${i.id}] ${i.state}${i.kind ? `/${i.kind}` : ''}${i.reason ? `（${i.reason}）` : ''} · writes(facts=${i.writes.facts},findings=${i.writes.findings}) · ${i.summary}`
  const intentLines = task.intents.length > 0
    ? capped(task.intents.map(intentLine), 25).join('\n')
    : '- （无）'
  const stopped = task.intents.filter(i => i.state === 'stopped' || i.state === 'failed')
  const stoppedLines = stopped.length > 0
    ? capped(stopped.map(i => `- [intent#${i.id}] ${i.state}（${i.reason || '-'}）${i.output ? `：${String(i.output).slice(0, 300)}` : ''}`), 8).join('\n')
    : '- （无）'
  const blueprints = task.intents.filter(i => i.state === 'blueprint')
  const blueprintLines = blueprints.length > 0
    ? capped(blueprints.map(i => `- [blueprint#${i.id}] ${i.summary}`), 8).join('\n')
    : '- （无）'
  const brief = task.brief?.text?.trim()
  const analysis = task.analysis?.text?.trim()
  return `# ARTEX 任务 ${task.id} 结束：${task.status}（${task.mode || 'objective'} 模式）

- 目标：${task.goal}
- 描述：${task.description}
- 用时：${elapsed}s · 规划轮次：${task.round} · 意图状态：${JSON.stringify(stateCount)}
- 事实 ${task.stats.facts} 条（内存保留 ${task.facts.length}） · 发现 ${task.stats.findings} 个${findingStatusNote} · 资源 ${task.stats.resources} 个 · 过程步骤 ${task.stats.activities} 条${usageLine}${usageBlock}${coverageBlock}${conflictLines}

## 全局认知（planner brief）
${brief ? '```markdown\n' + brief + '\n```' : '（未建立）'}

${analysis ? `## 独立分析（analyst）\n\`\`\`markdown\n${analysis}\n\`\`\`\n` : ''}

## 目标
${goalLines}

## 发现
${findingLines}

## 路径 / 意图
${intentLines}

## 被中止或判死的路径（含现场）
${stoppedLines}

## 未派发的蓝图
${blueprintLines}

快照：${task.outDir || ''}`
}
