/** Single-process assertions: no spawn (sandbox-safe). */
import { timeLabel, absoluteTimeLabel, workspaceTitleOf, deriveRows } from '../client/rows.mjs'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let passed = 0
const failures = []

function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`) } catch (error) { failures.push(name + ': ' + error.message); console.error(`FAIL - ${name}: ${error.message}`) }
}

const labels = { now: 'now', secondsAgo: s => `s${s}`, minutesAgo: m => `m${m}` }

check('timeLabel keeps under-15-min relative', () => {
  const now = 1_700_000_000_000
  if (timeLabel(now - 60000, now, labels) !== 'm1') throw new Error('1 minute should be relative m1')
  if (timeLabel(now - 45_000, now, labels) !== 's45') throw new Error('45 seconds should be relative s45')
  if (timeLabel(now - 10, now, labels) !== 'now') throw new Error('sub-second should use now label')
  if (timeLabel(now - 14 * 60000, now, labels) !== 'm14') throw new Error('should be relative at the boundary')
})

check('timeLabel switches absolute from 15 minutes onward', () => {
  const now = new Date('2085-01-02T03:04:05Z').getTime()
  const at = now - 15 * 60000
  const out = timeLabel(at, now, labels)
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(out)) throw new Error('bad absolute layout: ' + out)
})

check('absoluteTimeLabel pads components', () => {
  if (absoluteTimeLabel(new Date(2025, 8, 7, 5, 9).getTime()) !== '2025-09-07 05:09') throw new Error('pads day/hour/minute')
})

check('workspaceTitleOf falls back for absent ownership', () => {
  const ws = [{ sessionIds: ['s1'], title: 'A' }]
  if (workspaceTitleOf(ws, 's1', 'none') !== 'A') throw new Error('owner title expected')
  if (workspaceTitleOf(ws, 's2', 'none') !== 'none') throw new Error('fallback expected')
  if (workspaceTitleOf([], 's1', 'none') !== 'none') throw new Error('empty fallback expected')
})

check('deriveRows reverses order and shows newest archived first', () => {
  const byId = {
    s1: { displayTitle: 'one', updatedAt: 1 },
    s2: { displayTitle: 'two', updatedAt: 2 },
    s3: { displayTitle: 'three', updatedAt: 3 },
  }
  const rows = deriveRows(byId, [{ sessionIds: ['s2'], title: 'W2' }], ['s1', 's2', 's3'], {
    ungrouped: 'none', time: () => 't',
  })
  const expectedIds = ['s3', 's2', 's1']
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].sessionId !== expectedIds[i]) throw new Error(`index ${i} expected ${expectedIds[i]}, got ${rows[i].sessionId}`)
  }
  if (rows[1].workspaceTitle !== 'W2') throw new Error('workspaceTitle should read the owner workspace')
})

check('deriveRows skips blank rows, subagents, and unknown ids', () => {
  const byId = {
    blankOne: { displayTitle: 'blank', blank: true, updatedAt: 10 },
    child: { displayTitle: 'sub', parentId: 'parent', updatedAt: 11 },
    subagent: { displayTitle: 'subagent', origin: 'subagent', updatedAt: 12 },
    valid: { displayTitle: 'valid', updatedAt: 13 },
  }
  const rows = deriveRows(byId, [], ['valid', 'unknown', 'blankOne', 'child', 'subagent'], {
    ungrouped: 'none', time: () => 't',
  })
  if (rows[0].sessionId !== 'valid' || rows.length !== 1) {
    throw new Error('filtered rows expected one valid: ' + JSON.stringify(rows))
  }
})

check('deriveRows skips invalid archive ids with empty state', () => {
  const rows = deriveRows({}, [], ['ghost'])
  if (rows.some(r => r.sessionId === 'ghost')) throw new Error('ghost id should be skipped')
})

check('client.js registers under ModuleLoader and exposes module shape', () => {
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const registrations = []
  const context = {
    window: {
      __ModuleLoader__: {
        load(entry) { registrations.push(entry) },
      },
    },
  }
  runInNewContext(code, context)
  if (registrations.length !== 1) throw new Error('one registration expected; got ' + registrations.length)
  const entry = registrations[0]
  if (entry.id !== 'restore-archived') throw new Error('bad id: ' + entry.id)
  const factory = entry.factory
  if (factory === undefined) throw new Error('no factory')
  const exports = factory((spec) => {
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { IconArchiveOutline20: {} }
    if (spec === 'react') return {}
    return {}
  })
  if (exports.name !== 'restore-archived') throw new Error('name export mismatch')
  if (!Array.isArray(exports.inject)) throw new Error('inject export missing')
  if (typeof exports.apply !== 'function') throw new Error('apply export missing')
})



if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n` + failures.join('\n'))
  process.exit(1)
}
console.log(`all ${passed} passed`)


