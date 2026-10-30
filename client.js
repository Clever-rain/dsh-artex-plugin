/**
 * @local/dsh-artex — 浏览器半侧：会话级 ARTEX 开关与调用标识。
 *
 * 两个挂载点：
 * - conversation.input.left      输入框左侧的 🧭 开关 chip：显示本会话 ARTEX 启用态，
 *                                点击切换（POST /api/artex setEnabled）；与 /artex 命令共用一份状态。
 * - sidebar.session.row.leading  会话列表行头徽章：该会话有 ARTEX 任务时显示 🧭，
 *                                title 里给任务数与运行中数。
 *
 * 数据只经 POST /api/artex（Host 半侧 index.js）。纯 JS（无构建、无 JSX）；
 * 不读宿主 DOM、不写 document.body；定时器随订阅清空。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-artex',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;

    /** 本插件 client 半边的 locale 命名空间（区别于 dsh-artex-view 的 'artex'）。 */
    const NS = 'artex-switch';

    const zh = {
      'chip.label': 'ARTEX',
      'chip.on': '开',
      'chip.off': '关',
      'chip.title.on': '本会话已启用 ARTEX 编排（artex_* 工具可用）。点击停用；停用只拦新调用，运行中的任务不受影响。',
      'chip.title.off': '本会话已停用 ARTEX 编排（本会话的 artex_* 调用会被拦截）。点击启用。',
      'chip.title.error': 'ARTEX 状态读取失败，点击重试。',
      'chip.live': ' 个运行中',
      'badge.title': '本会话有 ARTEX 任务',
      'badge.live': '个运行中',
    };
    const en = {
      'chip.label': 'ARTEX',
      'chip.on': 'on',
      'chip.off': 'off',
      'chip.title.on': 'ARTEX orchestration is enabled for this session (artex_* tools available). Click to disable; running tasks are unaffected.',
      'chip.title.off': 'ARTEX orchestration is disabled for this session (new artex_* calls are denied). Click to enable.',
      'chip.title.error': 'Failed to read ARTEX state. Click to retry.',
      'chip.live': ' running',
      'badge.title': 'This session has ARTEX tasks',
      'badge.live': 'running',
    };

    let boundT = null;
    function tr_(key) {
      if (typeof boundT === 'function') {
        try {
          const text = boundT(key);
          if (typeof text === 'string' && text !== '') return text;
        } catch (error) { /* 回落 zh */ }
      }
      return Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
    }

    /** Client sessions 服务（拿会话 cwd，补全局索引漏掉的旧任务）。 */
    let sessionsService = null;
    function cwdOf(sessionId) {
      if (!sessionsService || typeof sessionsService.list?.getSnapshot !== 'function') return '';
      try {
        const snapshot = sessionsService.list.getSnapshot();
        const row = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null;
        return row && typeof row.cwd === 'string' ? row.cwd : '';
      } catch (error) {
        return '';
      }
    }

    // ========================================================================
    // 会话状态共享存储：每个 sessionId 一个轮询（4s，页面隐藏时暂停），
    // chip 与徽章订阅同一份，避免双倍请求。
    // ========================================================================

    const POLL_MS = 4000;
    const entries = new Map(); // sessionId -> { data, listeners:Set, timer, seq }

    async function post(body) {
      const response = await fetch('/api/artex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (!data || data.ok !== true) {
        throw new Error(data && typeof data.error === 'string' && data.error !== '' ? data.error : 'request failed');
      }
      return data;
    }

    function notify(entry) {
      for (const listener of entry.listeners) {
        try { listener(entry.data); } catch (error) { /* 单个监听者失败不拖垮轮询 */ }
      }
    }

    async function refresh(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.seq += 1;
      const seq = entry.seq;
      try {
        const data = await post({ op: 'state', sessionId, cwd: cwdOf(sessionId) || undefined });
        const current = entries.get(sessionId);
        if (!current || current.seq !== seq) return;
        current.data = { enabled: data.enabled !== false, tasks: Array.isArray(data.tasks) ? data.tasks : [], error: false };
      } catch (error) {
        const current = entries.get(sessionId);
        if (!current || current.seq !== seq) return;
        current.data = { ...current.data, error: true };
      }
      notify(entries.get(sessionId) || entry);
    }

    async function switchEnabled(sessionId, enabled) {
      await post({ op: 'setEnabled', sessionId, enabled });
      await refresh(sessionId);
    }

    function subscribe(sessionId, listener) {
      let entry = entries.get(sessionId);
      if (!entry) {
        entry = { data: { enabled: true, tasks: [], error: false }, listeners: new Set(), timer: null, seq: 0 };
        entries.set(sessionId, entry);
        void refresh(sessionId);
        entry.timer = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) void refresh(sessionId);
        }, POLL_MS);
      }
      entry.listeners.add(listener);
      listener(entry.data);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) {
          if (entry.timer) clearInterval(entry.timer);
          entries.delete(sessionId);
        }
      };
    }

    /** 组件通用：订阅本会话状态。 */
    function useArtexState(sessionId) {
      const [state, setState] = useState({ enabled: true, tasks: [], error: false });
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        return subscribe(sessionId, setState);
      }, [sessionId]);
      return state;
    }

    // ========================================================================
    // composer 开关 chip（conversation.input.left）
    // ========================================================================

    function Chip(props) {
      const tr = typeof props.t === 'function' ? props.t : tr_;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const state = useArtexState(sessionId);
      const enabled = state.enabled !== false;
      const liveCount = useMemo(
        () => state.tasks.filter((task) => task && task.live === true).length,
        [state.tasks],
      );
      if (sessionId === '') return null;

      const title = state.error ? tr('chip.title.error') : (enabled ? tr('chip.title.on') : tr('chip.title.off'));
      return h('button', {
        type: 'button',
        className: 'artex-sw-chip',
        'aria-pressed': enabled,
        title,
        onClick: () => {
          if (state.error) { void refresh(sessionId); return; }
          void switchEnabled(sessionId, !enabled).catch(() => void refresh(sessionId));
        },
        style: {
          appearance: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '24px',
          padding: '0 8px',
          border: '1px solid ' + (enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
          borderRadius: '999px',
          background: enabled ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-bg-layer-2)',
          color: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)',
          fontSize: '12px',
          lineHeight: '22px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          opacity: state.error ? 0.6 : 1,
        },
      },
        h('span', { 'aria-hidden': true, style: { fontSize: '12px', lineHeight: '22px' } }, '🧭'),
        h('span', null, tr('chip.label')),
        h('span', {
          style: {
            fontSize: '11px',
            fontVariantNumeric: 'tabular-nums',
            color: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-caption)',
          },
        }, enabled ? tr('chip.on') : tr('chip.off')),
        liveCount > 0
          ? h('span', {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 5px',
                borderRadius: '999px',
                background: 'var(--dsw-alias-state-success-primary)',
                color: 'var(--dsw-alias-bg-layer-1)',
                fontSize: '10px',
                lineHeight: '14px',
              },
              title: String(liveCount) + tr('chip.live'),
            }, String(liveCount))
          : null,
      );
    }

    // ========================================================================
    // 会话列表行头徽章（sidebar.session.row.leading，16px 小格）
    // ========================================================================

    function RowBadge(props) {
      const tr = typeof props.t === 'function' ? props.t : tr_;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const state = useArtexState(sessionId);
      const total = state.tasks.length;
      if (sessionId === '' || total === 0) return null;
      const liveCount = state.tasks.filter((task) => task && task.live === true).length;
      const title = tr('badge.title') + '（' + String(total) + '）'
        + (liveCount > 0 ? ' · ' + String(liveCount) + ' ' + tr('badge.live') : '');
      return h('span', {
        className: 'artex-sw-rowbadge',
        role: 'img',
        'aria-label': title,
        title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '16px',
          height: '16px',
          fontSize: '11px',
          lineHeight: '16px',
          opacity: liveCount > 0 ? 1 : 0.55,
        },
      }, '🧭');
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'artex-switch: dictionaries');
        boundT = ctx.locale.bind(NS);
        try { sessionsService = ctx.sessions || null; } catch (error) { sessionsService = null; }
        // 走 slots.inject：owner 声明 collapse/restore 时注册随之下线/重装。
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'artex-switch',
          order: 5,
          locale: NS,
          label: () => tr_('chip.label'),
        }, Chip));
        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
          name: 'sidebar.session.row.leading',
          id: 'artex-mark',
          order: 20,
          locale: NS,
          label: () => tr_('chip.label'),
        }, RowBadge));
      },
    };
  },
});
