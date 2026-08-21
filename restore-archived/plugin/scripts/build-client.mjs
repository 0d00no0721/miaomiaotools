// 生成器：client/index.mjs（含本地 ESM 依赖）→ client.js（bundle 产物，随插件分发）。
// 契约：--check 模式在内存生成后与已提交 client.js 逐字节比对，不一致非零退出（手改生成物禁止）。
// 不用 esbuild（其内部 spawn 原生二进制在 sandbox 下 EPERM）；采用极简内联打包：
//   1) 相对 import 递归内联；
//   2) 裸导入映射为平台种子 require（react / ui-primitives）；
//   3) 去模块级 export；
//   4) 包 window.__ModuleLoader__.load(...)。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = join(ROOT, 'client/index.mjs')
const OUTPUT = join(ROOT, 'client.js')
const PLUGIN_ID = 'restore-archived'

// dotAll（s）使 `.*?` 跨行，匹配单行与多行 import。
const IMPORT_RE = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gms
const NAMESPACE_RE = /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm
const NAMED_RE = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gms

/** 递归内联：相对 import 内联；裸导入转 require；去掉模块级 export 关键字。 */
function inline(file, seen = new Set()) {
  const abs = resolve(file)
  if (seen.has(abs)) throw new Error(`循环 import 检出：${abs}`)
  seen.add(abs)
  let src = readFileSync(abs, 'utf8')
  src = src.replace(IMPORT_RE, (match, spec) => {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(abs), spec)
      return inline(target, seen)
    }
    let mapped = NAMESPACE_RE.exec(match)
    if (mapped !== null) return `const ${mapped[1]} = require(${JSON.stringify(spec)});`
    mapped = NAMED_RE.exec(match)
    if (mapped !== null) {
      const members = mapped[1].split(',').map(entry => entry.trim()).filter(Boolean)
      const destructured = members.map(entry => {
        const parts = entry.split(/\s+as\s+/, 2)
        return parts.length === 2 ? `${parts[0].trim()}: ${parts[1].trim()}` : parts[0].trim()
      }).join(', ')
      return `const { ${destructured} } = require(${JSON.stringify(spec)});`
    }
    throw new Error(`不支持的 import 形态：${match}（${file}）`)
  })
  // 去掉模块级 export 关键字（tautology: deskpet 同构，global 覆盖全部）。
  src = src.replace(/\bexport\s+(const|function|let|class|var)\b/g, '$1')
  return src
}

export function generate({ check = false } = {}) {
  let body
  try {
    body = inline(ENTRY)
  } catch (e) {
    return { ok: false, errors: [`内联失败：${e.message}`] }
  }
  const preamble = ''
  const code = Buffer.from(
    `window.__ModuleLoader__.load({\n`
    + `\tid: ${JSON.stringify(PLUGIN_ID)},\n`
    + `\tfactory: (require) => {\n`
    + `\t\tvar module = { exports: {} };\n`
    + `\t\tvar exports = module.exports;\n`
    + preamble
    + body.replace(/\n$/, '')
    + `\n\t\tmodule.exports = { name, inject, apply };\n`
    + `\t\treturn module.exports;\n`
    + `\t}\n`
    + `});\n`,
  )
  const text = code.toString()
  const RESIDUAL = /^\s*(import|export)\b/gm
  const lines = text.split('\n').map((line, index) => RESIDUAL.test(line) ? `#${index + 1}: ${line.trim()}` : null).filter(Boolean)
  RESIDUAL.lastIndex = 0
  if (lines.length > 0) {
    return { ok: false, errors: [`产物残留 ESM import/export：\n  ${lines.join('\n  ')}`] }
  }
  // 编译期语法自检：心法同 deskpet 的 `new Function` 校验，只编译不执行。
  try {
    // oxlint: 需要在生成器里动态编译产物，浏览器侧经典 <script> 编译失败会不认识插件。
    // eslint-disable-next-line no-new-func
    new Function('window', text)
  } catch (error) {
    return { ok: false, errors: [`client.js 产物存在语法错误：${error && error.message ? error.message : String(error)}`] }
  }
  if (!check) writeFileSync(OUTPUT, code)
  if (check) {
    let committed = null
    try { committed = readFileSync(OUTPUT) } catch { return { ok: false, errors: [`${OUTPUT} 不存在：运行 node scripts/build-client.mjs 生成`] } }
    if (Buffer.compare(committed, code) !== 0) return { ok: false, errors: ['client.js 与生成器输出不一致：请重新运行 node scripts/build-client.mjs'] }
  }
  return { ok: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check')
  const result = generate({ check })
  if (!result.ok) {
    for (const e of result.errors ?? []) console.error(`[build-client] ${e}`)
    process.exit(1)
  }
  console.log(check ? '[build-client] client.js 新鲜（--check OK）' : '[build-client] client.js 已生成')
}
