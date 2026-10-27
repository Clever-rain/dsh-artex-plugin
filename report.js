/**
 * 最终报告渲染：把任务快照渲染成模型/人可读的 Markdown。
 */

export function formatReport(task) {
  const elapsed = task.endedAt ? Math.round((task.endedAt - task.createdAt) / 1000) : 0
  const stateCount = {}
  for (const i of task.intents) stateCount[i.state] = (stateCount[i.state] || 0) + 1
  const usage = task.usage || { input_tokens: 0, output_tokens: 0, calls: 0 }
  const usageLine = usage.calls > 0
    ? `\n- 用量：输入 ${usage.input_tokens} / 输出 ${usage.output_tokens} tokens（${usage.calls} 次模型调用）`
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
- 事实 ${task.stats.facts} 条（内存保留 ${task.facts.length}） · 发现 ${task.stats.findings} 个 · 资源 ${task.stats.resources} 个 · 过程步骤 ${task.stats.activities} 条${usageLine}

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
