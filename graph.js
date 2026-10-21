/**
 * 双图内核门面：领域模型 + 角色视图 + 持久化。
 * 外部模块继续从 graph.js 导入，拆分不改变调用方。
 */

export * from './model.js'
export * from './views.js'
export * from './store.js'
