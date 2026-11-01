/**
 * 交战（engagement）绑定与 .artex 目录防护。
 *
 * 授权一等公民化的落地：
 * - engagement 文件声明"授权什么、时间窗、授权人"，任务启动时校验；
 * - 时间窗过期 / 授权说明缺失 / scope 超出交战目标集 → 启动即拒；
 * - .artex/ 落进 git 追踪 = Phantom 式证据裸奔，启动时自动补 .gitignore。
 */

import { mkdir, readFile, stat, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GRAPH_DIR } from './store.js'
import { parseScope, matchScopeEntry } from './guard.js'

/**
 * 读取交战文件：${cwd}/.artex/engagements/<id>.json
 * 形状：{ id, authorization, targets: [], window: { not_before, not_after }, note }
 * @returns {Promise<object>} 解析后的交战对象（含来源路径）
 */
export async function loadEngagement(cwd, id) {
  const name = String(id ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`engagement id 非法：${name || '(空)'}（只允许字母数字与 -_，1-64 位）`)
  }
  const path = join(cwd, GRAPH_DIR, 'engagements', `${name}.json`)
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`交战 ${name} 不存在：请先在 ${path} 建立交战文件（authorization / targets / window）`)
    }
    throw new Error(`交战 ${name} 读取失败：${error?.message || error}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`交战 ${name} 文件损坏`)
  return { ...raw, id: String(raw.id || name), _path: path }
}

/**
 * 启动校验：时间窗 / 授权说明 / scope 覆盖。
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function validateEngagement(engagement, { now = Date.now(), allowedTargets = [] } = {}) {
  const problems = []
  if (!String(engagement.authorization ?? '').trim()) {
    problems.push('缺少 authorization 授权说明（谁授权、授权范围、有效依据）')
  }
  const targets = Array.isArray(engagement.targets) ? engagement.targets.filter(Boolean) : []
  if (targets.length === 0) {
    problems.push('targets 为空：交战必须声明授权目标集（域名/IP/CIDR）')
  }
  const window = engagement.window && typeof engagement.window === 'object' ? engagement.window : {}
  const notBefore = Date.parse(window.not_before ?? window.notBefore ?? '')
  const notAfter = Date.parse(window.not_after ?? window.notAfter ?? '')
  if (Number.isFinite(notBefore) && now < notBefore) {
    problems.push(`交战尚未生效（not_before=${new Date(notBefore).toISOString()}）`)
  }
  if (Number.isFinite(notAfter) && now > notAfter) {
    problems.push(`交战已过期（not_after=${new Date(notAfter).toISOString()}）`)
  }
  if (!Number.isFinite(notAfter)) {
    problems.push('window.not_after 缺失或无法解析：交战必须有明确的结束时间')
  }
  // 任务声明的 allowed_targets 必须是交战目标集的子集——scope 不能比授权更宽。
  if (allowedTargets.length > 0 && targets.length > 0) {
    const entries = parseScope(targets)
    const uncovered = allowedTargets.filter((t) => {
      const normalized = String(t).trim().toLowerCase()
      // 任务的 CIDR/精确条目必须整体被交战某条目覆盖；后缀/主机条目做匹配判定。
      if (normalized.includes('/')) {
        // 保守处理：交战侧存在完全相同的 CIDR 写法才算覆盖。
        return !targets.some(x => String(x).trim().toLowerCase() === normalized)
      }
      const host = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].replace(/:\d+$/, '').replace(/^\*\./, '')
      return !matchScopeEntry(entries, host)
    })
    if (uncovered.length > 0) {
      problems.push(`allowed_targets 超出交战授权目标集：${uncovered.join(', ')}（交战 targets：${targets.join(', ')}）`)
    }
  }
  return problems
}

/**
 * .artex/ 防裸奔：cwd 是 git 仓库时，确保 .gitignore 忽略 .artex/。
 * @returns {Promise<{repo:boolean, changed:boolean, note:string}>}
 */
export async function ensureArtexGitignored(cwd) {
  const gitDir = join(cwd, '.git')
  const isRepo = await stat(gitDir).then(s => s.isDirectory() || s.isFile()).catch(() => false)
  if (!isRepo) return { repo: false, changed: false, note: '非 git 仓库，跳过' }
  const ignorePath = join(cwd, '.gitignore')
  let body = ''
  try {
    body = await readFile(ignorePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  const covered = lines.some(l => /^\.?\/?\.artex\/?$/.test(l) || l === '**/.artex' || l === '**/.artex/')
  if (covered) return { repo: true, changed: false, note: '.gitignore 已覆盖 .artex/' }
  const addition = `${body.endsWith('\n') || body.length === 0 ? '' : '\n'}# ARTEX 任务证据目录（含目标/凭据片段，禁止提交）\n.artex/\n`
  if (body.length === 0) {
    await writeFile(ignorePath, addition, 'utf8')
  } else {
    await appendFile(ignorePath, addition, 'utf8')
  }
  return { repo: true, changed: true, note: '已向 .gitignore 追加 .artex/' }
}
