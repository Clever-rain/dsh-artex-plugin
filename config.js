/**
 * 插件配置：单一默认值 + 归一化。
 * 不导出 Config schema（bundle 无外部依赖），但未知键、非法枚举、非数字值都会被显式告警。
 */

export const DEFAULTS = {
  /** ctx.subagents provider；默认 in-process spawn。 */
  provider: 'spawn',
  /** 任务内 worker 并发（ARTEX 默认 3）。 */
  maxWorkers: 3,
  /** 规划轮次上限（安全阀，ARTEX 本身不限轮）。 */
  maxRounds: 24,
  /** 连续「规划后仍然无任何可执行方向」的次数上限。 */
  maxStalls: 2,
  /** 图变动合并窗口（ARTEX 800ms）。 */
  debounceMs: 800,
  /** 无变动时的巡检间隔（ARTEX ≥600s）。 */
  heartbeatMs: 600000,
  /** 单个 worker 的墙钟预算（ARTEX agents.run_seconds 默认 1200s）。 */
  workerTimeoutMs: 1200000,
  /** 单轮 planner 的墙钟预算。 */
  plannerTimeoutMs: 900000,
  /** 默认任务模式：objective=达成目的；audit=覆盖评估。 */
  mode: 'objective',
  /** 预算耗尽后的收尾宽限（ARTEX settleDrainGrace 90s）。 */
  settleGraceMs: 90000,
  /** 突破后等待兄弟路径写回现场的宽限。 */
  breakthroughGraceMs: 30000,
  /** 任务级预算；0 = 不限。 */
  budgetMs: 0,
  /** hybrid 总开关。 */
  enableHybrid: true,
  /** 全局视野策略。 */
  viewMode: 'hybrid',
  /** 最多触发多少次独立分析。 */
  analystMaxRuns: 4,
  /** 至少间隔多少轮触发一次（audit）。 */
  analystEveryRounds: 3,
  /** 新增事实达到该数量时触发。 */
  analystFactThreshold: 8,
  /** 两次分析之间的最小间隔（毫秒）。 */
  analystCooldownMs: 30000,
  /** 单次分析的墙钟预算。 */
  analystTimeoutMs: 180000,
  /** 子会话是否使用任务目录下的独立 cwd。 */
  isolateWorkdir: false,
  /** 快照合并写延迟（毫秒）。 */
  saveDebounceMs: 200,
  /** 是否允许非 owner/角色会话按 task_id 读取任务。 */
  allowCrossTaskRead: false,
  /** 全局任务索引路径；undefined = ~/.dsh/artex-index.json。 */
  indexPath: undefined,
}

const ENUMS = {
  mode: ['objective', 'audit'],
  viewMode: ['planner', 'hybrid', 'analyst'],
}

/**
 * 把外部配置归一化到 DEFAULTS 的形状。
 * @returns {{config: Record<string, unknown>, warnings: string[]}}
 */
export function normalizeConfig(raw = {}, logger) {
  const config = { ...DEFAULTS }
  const warnings = []
  for (const [key, value] of Object.entries(raw || {})) {
    if (!(key in DEFAULTS)) {
      warnings.push(`未知配置键 "${key}"，已忽略`)
      continue
    }
    if (value === undefined || value === null) continue
    if (key in ENUMS) {
      if (ENUMS[key].includes(value)) config[key] = value
      else warnings.push(`配置 ${key} 的值 "${value}" 非法，允许：${ENUMS[key].join(' | ')}；使用默认 ${DEFAULTS[key]}`)
      continue
    }
    const fallback = DEFAULTS[key]
    if (typeof fallback === 'boolean') {
      config[key] = value === true || value === 'true'
      continue
    }
    if (typeof fallback === 'number') {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) config[key] = numeric
      else warnings.push(`配置 ${key} 需要数字，收到 "${value}"；使用默认 ${fallback}`)
      continue
    }
    if (key === 'provider' || key === 'indexPath') {
      config[key] = String(value)
      continue
    }
    config[key] = value
  }
  for (const warning of warnings) logger?.warn?.(`[artex] config: ${warning}`)
  return { config, warnings }
}
