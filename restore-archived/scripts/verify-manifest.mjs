// 校验发布包文件完整性：读取上层的 manifest.json，重算 sha256 并逐项比对。
// 用法：node scripts/verify-manifest.mjs
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const releaseRoot = resolve(scriptDir, '..')
const manifestPath = join(releaseRoot, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const failures = []
const seen = new Set()

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

for (const entry of manifest) {
  const file = join(releaseRoot, ...entry.path.split('/'))
  if (seen.has(entry.path)) { failures.push(`重复条目：${entry.path}`); continue }
  seen.add(entry.path)
  let actual
  try { actual = sha(file) } catch { failures.push(`缺失：${entry.path}`); continue }
  if (actual !== entry.sha256) failures.push(`校验失败：${entry.path}`)
}

if (failures.length > 0) {
  console.error('manifest 验证失败：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('manifest OK')
