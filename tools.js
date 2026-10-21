/**
 * 模型可见的 ARTEX 工具集：按域组合 control / read / planner / worker / analysis。
 * 角色边界由各工具 execute 内的身份校验 + 子会话 toolFilter 双重保证。
 */

import { controlTools } from './tools/control.js'
import { readTools } from './tools/read.js'
import { plannerTools } from './tools/planner.js'
import { workerTools } from './tools/worker.js'
import { analysisTools } from './tools/analysis.js'

export function createTools({ engine, config }) {
  return [
    ...controlTools({ engine, config }),
    ...readTools({ engine, config }),
    ...plannerTools({ engine, config }),
    ...workerTools({ engine, config }),
    ...analysisTools({ engine, config }),
  ]
}
