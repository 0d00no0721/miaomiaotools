/**
 * Pure row derivation for the restore-archived panel. No DOM: rows are plain data.
 */

export const RELATIVE_UNDER_MS = 15 * 60 * 1000

export function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * Absolute fallback keeps one layout for both locales: YYYY-MM-DD HH:mm
 * @param timestamp - updatedAt epoch (ms)
 */
export function absoluteTimeLabel(timestamp) {
  const d = new Date(timestamp)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * Relative label while the session was touched less than RELATIVE_UNDER_MS
 * ago; absolute otherwise. labels carries the translated shapes.
 */
export function timeLabel(updatedAt, now, labels) {
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
export function workspaceTitleOf(workspaces, sessionId, ungrouped) {
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
export function deriveRows(byId, workspaces, archivedOrder, options) {
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
