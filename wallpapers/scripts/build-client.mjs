// 生成器：client/index.mjs（含本地 ESM 依赖）→ client.js（bundle 产物，随插件分发）。
// 契约：--check 模式在内存生成后与已提交 client.js 逐字节比对，不一致非零退出（手改生成物禁止）。
// 不用 esbuild（其内部 spawn 原生二进制在 sandbox 下 EPERM）；改为极简内联打包：
//   1) 解析 client/index.mjs 的相对 import，递归内联被导入文件的「去 import/export」正文；
//   2) 去除 export 关键字（模块名导出 name/apply 用模块级 export 语法）。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = join(ROOT, 'client/index.mjs')
const OUTPUT = join(ROOT, 'client.js')
const PLUGIN_ID = 'wallpapers'

// dotAll（s）使 .*? 跨行，匹配单行与多行 import。
const IMPORT_RE = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gms

/** 递归内联：读文件，替换相对 import 为其内容（去 import/export），返回纯函数体。 */
function inline(file, seen = new Set()) {
  const abs = resolve(file)
  if (seen.has(abs)) throw new Error(`循环 import 检出：${abs}`)
  seen.add(abs)
  let src = readFileSync(abs, 'utf8')
  src = src.replace(IMPORT_RE, (m, spec) => {
    if (!spec.startsWith('.')) throw new Error(`非相对 import 不支持内联：${spec}（${file}）`)
    const target = resolve(dirname(abs), spec)
    return inline(target, seen)
  })
  src = src.replace(/\bexport\s+(function|const|let|var|class)\b/g, '$1')
  return src
}

export function generate({ check = false } = {}) {
  let body
  try {
    body = inline(ENTRY)
  } catch (e) {
    return { ok: false, errors: [`内联失败：${e.message}`] }
  }
  const code = Buffer.from(
    `window.__ModuleLoader__.load({\n`
    + `\tid: ${JSON.stringify(PLUGIN_ID)},\n`
    + `\tfactory: (require) => {\n`
    + `\t\tvar module = { exports: {} };\n`
    + `\t\tvar exports = module.exports;\n`
    + body.replace(/\n$/, '')
    + `\n\t\tmodule.exports = { name: name, apply: apply };\n`
    + `\t\treturn module.exports;\n`
    + `\t}\n`
    + `});\n`,
  )
  const RESIDUAL = /^\s*(import|export)\b/gm
  if (RESIDUAL.test(code.toString())) {
    const lines = code.toString().split('\n')
      .map((l, i) => RESIDUAL.test(l) ? `#${i + 1}: ${l.trim()}` : null)
      .filter(Boolean)
    RESIDUAL.lastIndex = 0
    return { ok: false, errors: [`产物残留 ESM import/export（内联器漏处理）：\n  ${lines.join('\n  ')}`] }
  }
// 通用语法校验：`new Function` 只编译不执行，能拦住「悬空 else / 花括号错配」这类
    // 非 import/export 的语法错误（见 BUGREPORT-20260815-scene-branch-breaks-client-bundle 第7节）。
    // 产物顶层引用 window.__ModuleLoader__；传入 window 形参仅为让编译通过，不实际执行。
    try {
      // eslint-disable-next-line no-new-func
      new Function('window', code.toString())
    } catch (e) {
      return { ok: false, errors: [`client.js 产物存在语法错误：${e.message || e}`] }
    }
  if (!check) {
    writeFileSync(OUTPUT, code)
    return { ok: true }
  }
  let committed = null
  try {
    committed = readFileSync(OUTPUT)
  } catch {
    return { ok: false, errors: [`${OUTPUT} 不存在：运行 node scripts/build-client.mjs 生成`] }
  }
  if (Buffer.compare(committed, code) !== 0) {
    return { ok: false, errors: ['client.js 与生成器输出不一致：运行 node scripts/build-client.mjs 重新生成'] }
  }
  return { ok: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check')
  const result = generate({ check })
  if (result.skipped !== undefined) {
    console.log(`[build-client] SKIP：${result.skipped}`)
    process.exit(0)
  }
  if (!result.ok) {
    for (const e of result.errors ?? []) console.error(`[build-client] ${e}`)
    process.exit(1)
  }
  console.log(check ? '[build-client] client.js 新鲜（--check OK）' : '[build-client] client.js 已生成')
}
