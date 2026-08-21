/**
 * Client half of the restore-archived panel. Registers one footer action
 * above Settings: a trigger row, a modal list of archived sessions, and a
 * restore button per row. The selected restore call goes through the
 * workspace runtime face, which the host repo added alongside archiveSession.
 */

import * as React from 'react'
import { IconArchiveOutline20, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { deriveRows, timeLabel } from './rows.mjs'
import { PANEL_CSS, STYLE_ID } from './style.mjs'

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

export const name = 'restore-archived'
export const inject = ['slots', 'locale', 'workspaces']

export function apply(ctx) {
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
