window.__ModuleLoader__.load({
	id: "restore-archived",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
/**
 * Client half of the restore-archived panel. Registers one footer action
 * above Settings: a trigger row, a modal list of archived sessions, and a
 * restore button per row. The selected restore call goes through the
 * workspace runtime face, which the host repo added alongside archiveSession.
 */

const React = require("react");
const { IconArchiveOutline20, IconCloseOutline16 } = require("@deepseek-ai/dsh-client-ui-primitives");
/**
 * Pure row derivation for the restore-archived panel. No DOM: rows are plain data.
 */

const RELATIVE_UNDER_MS = 15 * 60 * 1000

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * Absolute fallback keeps one layout for both locales: YYYY-MM-DD HH:mm
 * @param timestamp - updatedAt epoch (ms)
 */
function absoluteTimeLabel(timestamp) {
  const d = new Date(timestamp)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * Relative label while the session was touched less than RELATIVE_UNDER_MS
 * ago; absolute otherwise. labels carries the translated shapes.
 */
function timeLabel(updatedAt, now, labels) {
  const diff = Math.max(0, now - updatedAt)
  if (diff < RELATIVE_UNDER_MS) {
    if (diff < 1000) return labels.now
    if (diff < 60000) return labels.secondsAgo(Math.max(1, Math.round(diff / 1000)))
    const minutes = Math.round(diff / 60000)
    return labels.minutesAgo(Math.min(minutes, 14))
  }
  return absoluteTimeLabel(updatedAt)
}

/**
 * Title of the workspace accounting the session; fallback covers
 * cold/unaccounted rows without carrying label knowledge.
 */
function workspaceTitleOf(workspaces, sessionId, ungrouped) {
  const own = workspaces && workspaces.find(ws => (
    Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)
  ))
  return own ? own.title : ungrouped
}

/**
 * Excludes unknown, blank, and subagent-origin rows so only top-level
 * archived sessions show. Order: archive append order is old-first, so the
 * renderer reverses it and puts the most recently archived row on top.
 */
function deriveRows(byId, workspaces, archivedOrder, options) {
  const source = byId || {}
  const order = archivedOrder || []
  const rows = []
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]
    const session = source[id]
    if (session === undefined || session.blank === true) continue
    if (session.parentId !== undefined || session.origin === 'subagent') continue
    const sessionTitle = session.displayTitle || session.title || id
    rows.push({
      sessionId: id,
      sessionTitle: sessionTitle,
      workspaceTitle: workspaceTitleOf(workspaces, id, options.ungrouped),
      timeText: options.time(session.updatedAt || 0),
    })
  }
  return rows
}

/** Panel stylesheet: mirror of the Settings shell tokens (ui-settings-general SettingsRoot.module.css). */

const PANEL_CSS = [
  /* Trigger row copies Settings.trigger (34px compact / 36px rail circle). */
  '.ra-trigger{flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px 4px;padding:6px 2px 6px 10px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}',
  '.ra-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ra-trigger.ra-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%}',
  '.ra-trigger.ra-rail .ra-trigger-label{display:none}',
  '.ra-trigger-label{overflow:hidden;white-space:nowrap}',
  /* Full-viewport mask + centered panel, same tokens as Settings. */
  '.ra-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}',
  '.ra-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
  '.ra-panel{position:relative;z-index:1;display:flex;flex-direction:column;width:800px;height:min(640px,calc(100vh - 48px));max-width:calc(100vw - 48px);border-radius:24px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}',
  '.ra-header{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;height:54px;padding:20px 14px 8px 10px;box-sizing:border-box}',
  '.ra-header-title{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.ra-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:28px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary)}',
  '.ra-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ra-close-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  '.ra-error{color:var(--dsw-alias-label-danger, #c62828);font-size:12px;padding:0 24px}',
  '.ra-empty{padding:32px 12px;color:var(--dsw-alias-label-secondary);text-align:center}',
  /* Options area scrolls like Settings .options. */
  '.ra-options{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}',
  '.ra-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
  '.ra-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.15));border-radius:8px}',
  '.ra-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.ra-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.ra-row-meta{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center}',
  '.ra-time{margin-left:auto}',
  '.ra-restore{background:transparent;border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.15));border-radius:6px;padding:4px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px}',
  '.ra-restore:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ra-restore:disabled{opacity:.6;cursor:default}',
].join('\n')

const STYLE_ID = 'ra-panel-style'

const NS = 'restore-archived'

const ZH = {
  'trigger.label': '恢复归档的对话',
  'panel.title': '恢复归档的对话',
  'group.ungrouped': '未分组',
  'group.all': '全部',
  'empty.title': '暂无归档',
  'empty.markdown': '没有已归档的会话。',
  'empty.label': '暂无归档',
  'action.restore': '恢复',
  'action.close': '关闭',
  'action.failed': '恢复失败：{reason}',
  'time.now': '刚刚',
  'time.secondsAgo': '{seconds} 秒前',
  'time.minutesAgo': '{minutes} 分钟前',
}

const EN = {
  'trigger.label': 'Restore archived chats',
  'panel.title': 'Restore archived chats',
  'group.ungrouped': 'Ungrouped',
  'group.all': 'All',
  'empty.title': 'No archived sessions',
  'empty.markdown': 'No archived sessions yet.',
  'empty.label': 'No archived sessions',
  'action.restore': 'Restore',
  'action.close': 'Close',
  'action.failed': 'Restore failed: {reason}',
  'time.now': 'just now',
  'time.secondsAgo': '{seconds}s ago',
  'time.minutesAgo': '{minutes}m ago',
}

const h = React.createElement

const name = 'restore-archived'
const inject = ['slots', 'locale', 'workspaces']

function apply(ctx) {
  ctx.effect(() => {
    ctx.locale.register(NS, { zh: ZH, en: EN })
  }, 'restore-archived: locale dictionaries')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'restore-archived-panel',
    order: 100,
    locale: NS,
    inject: () => {
      // The registration re-builds the face when the slot epoch advances; the
      // call itself stays closured over the workspace runtime.
      const onRestore = function onRestore(sessionId) {
        // Silent on the host side for ids not present in the archive set.
        return ctx.workspaces.unarchiveSession(sessionId)
      }
      return { onRestore }
    },
  }, RestoreArchivedPanel))
}

function TriggerRow(props) {
  const { wide, t, onOpen } = props
  return h('button', {
    type: 'button',
    className: wide ? 'ra-trigger' : 'ra-trigger ra-rail',
    'data-wide': wide ? 'true' : 'false',
    'aria-haspopup': 'dialog',
    title: t('panel.title'),
    onClick: onOpen,
  }, h(IconArchiveOutline20, null), h('span', { className: 'ra-trigger-label' }, t('trigger.label')))
}

function RowItem(props) {
  const { row, t, busy, onRestore } = props
  const restoring = busy === row.sessionId
  return h('li', { className: 'ra-row', key: row.sessionId },
    h('div', { className: 'ra-row-main' },
      h('div', { className: 'ra-row-title', title: row.sessionTitle },
        row.sessionTitle,
        h('div', { className: 'ra-row-meta' },
          h('span', null, row.workspaceTitle),
          h('span', { className: 'ra-time' }, row.timeText))),
    ),
    h('button', {
      type: 'button',
      className: 'ra-restore',
      disabled: restoring,
      onClick: () => onRestore(row.sessionId),
    }, t('action.restore')),
  )
}

function RestoreArchivedPanel(props) {
  const { useSessions, useWorkspaces, wide, t, onRestore } = props
  const byId = useSessions(s => s.byId)
  const workspaces = useWorkspaces(s => s.items)
  const archivedIds = useWorkspaces(s => s.archivedSessionIds)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(null)
  const [message, setMessage] = React.useState(null)
  const closeRef = React.useRef(null)
    const titleId = React.useId()

  React.useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = PANEL_CSS
    document.head.appendChild(style)
  }, [])

  React.useEffect(() => {
    if (!open) return
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    closeRef.current && closeRef.current.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const rows = React.useMemo(() => deriveRows(byId, workspaces, archivedIds, {
    ungrouped: t('group.ungrouped'),
    time: updatedAt => timeLabel(updatedAt, Date.now(), {
      now: t('time.now'),
      secondsAgo: seconds => t('time.secondsAgo', { seconds }),
      minutesAgo: minutes => t('time.minutesAgo', { minutes }),
    }),
  }), [byId, workspaces, archivedIds, t])

  async function restore(sessionId) {
    setBusy(sessionId)
    setMessage(null)
    try {
      await onRestore(sessionId)
    } catch (reason) {
      setMessage(t('action.failed', { reason: String(reason && reason.message ? reason.message : reason) }))
    } finally {
      setBusy(current => current === sessionId ? null : current)
    }
  }

  return h(React.Fragment, null,
    h(TriggerRow, { wide, t, onOpen: () => setOpen(true) }),
    open ? h('div', { className: 'ra-overlay', role: 'presentation' },
      h('div', { className: 'ra-mask', 'aria-hidden': 'true', onClick: () => setOpen(false) }),
      h('section', { className: 'ra-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('header', { className: 'ra-header' },
          h('h2', { className: 'ra-header-title', id: titleId }, t('panel.title')),
          h('button', { type: 'button', ref: closeRef, className: 'ra-close', onClick: () => setOpen(false) },
            h(IconCloseOutline16, { size: 14 }),
            h('span', { className: 'ra-close-label' }, t('action.close')),
          ),
        ),
        message !== null ? h('p', { className: 'ra-error' }, message) : null,
        h('div', { className: 'ra-options' },
          rows.length === 0
            ? h('p', { className: 'ra-empty' }, t('empty.label'))
            : h('ul', { className: 'ra-list' },
              rows.map(row => h(RowItem, { key: row.sessionId, row, t, busy, onRestore: restore }))),
        ),
      ),
    ) : null,
  )
}
		module.exports = { name, inject, apply };
		return module.exports;
	}
});
