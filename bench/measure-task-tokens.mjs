/**
 * 从 DSH session 日志聚合一次 ARTEX 任务的子会话 token 用量。
 * 用法：node bench/measure-task-tokens.mjs <taskId> <parentSessionLog> <sessionsDir>
 * 依赖 PATH 中的 zstd（支持 multi-frame）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [taskId, parentLog, sessionsDir] = process.argv.slice(2)
if (!taskId || !parentLog || !sessionsDir) {
  console.error('usage: measure-task-tokens.mjs <taskId> <parentSessionLog> <sessionsDir>')
  process.exit(1)
}
const taskDir = join(process.cwd(), '.artex', 'tasks', taskId)
const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'))
const start = Number(task.createdAt) - 500
const end = Number(task.endedAt || Date.now()) + 500

const temp = mkdtempSync(join(tmpdir(), 'artex-token-'))
const unzstd = (src, name) => {
  const out = join(temp, name)
  execFileSync('zstd', ['-d', '-f', '-q', src, '-o', out], { stdio: 'ignore' })
  return readFileSync(out, 'utf8')
}
try {
  const parent = unzstd(parentLog, 'parent.jsonl')
  const children = []
  for (const line of parent.split('\n')) {
    if (!line.includes('subagent/catalog')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const data = event.data || {}
    const at = Number(data.childCreatedAt || event.time)
    if (at >= start && at <= end && /^ARTEX /.test(data.label || '')) {
      children.push({ childId: data.childId, label: data.label, at })
    }
  }
  const seen = new Set()
  const byLabel = {}
  let input = 0
  let output = 0
  let calls = 0
  for (const child of children) {
    if (seen.has(child.childId)) continue
    seen.add(child.childId)
    const log = join(sessionsDir, child.childId, 'session.v4.jsonl.zstd')
    let text
    try { text = unzstd(log, `${child.childId}.jsonl`) } catch { continue }
    let childInput = 0
    let childOutput = 0
    let childCalls = 0
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      const usage = event.data?.usage
      if (!usage) continue
      childInput += Number(usage.inputTokens) || 0
      childOutput += Number(usage.outputTokens) || 0
      childCalls += 1
    }
    input += childInput
    output += childOutput
    calls += childCalls
    const role = child.label.includes('planner') ? 'planner' : child.label.includes('analyst') ? 'analyst' : 'worker'
    byLabel[role] = byLabel[role] || { calls: 0, input: 0, output: 0 }
    byLabel[role].calls += childCalls
    byLabel[role].input += childInput
    byLabel[role].output += childOutput
  }
  console.log(JSON.stringify({
    taskId,
    status: task.status,
    taskUsage: task.usage || null,
    measured: { calls, input, output, total: input + output, children: seen.size },
    byRole: byLabel,
    children: children.map(c => c.childId),
  }, null, 2))
} finally {
  rmSync(temp, { recursive: true, force: true })
}
