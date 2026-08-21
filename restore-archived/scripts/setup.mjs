// 轻量安装器：给一个 deepseek-harness 仓库路径，自动做 patch 预检与应用，
// 并打印后续构建/安装命令。不做 pnpm install / build（避免误改仓库）。
// 用法：node scripts/setup.mjs <dsh-repo-path>
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const releaseRoot = resolve(scriptDir, '..')
const patch = resolve(releaseRoot, 'host-patch.diff')
const upstreamMd = readFileSync(resolve(releaseRoot, 'UPSTREAM.md'), 'utf8')
const baseMatch = /base_commit:\s*([0-9a-f]{40})/.exec(upstreamMd)
const baseCommit = baseMatch?.[1]

const repo = process.argv[2]
if (repo === undefined) {
  console.error('用法：node scripts/setup.mjs <dsh-repo-path>')
  process.exit(1)
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return { code: result.status === null ? 1 : result.status, out: (result.stdout || '') + (result.stderr || '') }
}

const check = run('git', ['-C', repo, 'status', '--short'], process.cwd())
if (check.code !== 0) {
  console.error(`无法访问 git 仓库：${repo}`)
  process.exit(1)
}
if (check.out.trim() !== '') {
  console.error('目标仓库存在未提交改动，请先保存/处理再安装：')
  console.error(check.out)
  process.exit(1)
}

if (baseCommit !== undefined) {
  const head = run('git', ['-C', repo, 'rev-parse', 'HEAD'], process.cwd())
  const current = head.out.trim()
  if (current !== baseCommit) {
    console.error(`目标仓库当前 commit 不是发布锚点：${current}`)
    console.error(`预期：${baseCommit}`)
    console.error(`请先切换：git -C "${repo}" checkout ${baseCommit}`)
    process.exit(1)
  }
}

const dry = run('git', ['-C', repo, 'apply', '--check', patchPath()], process.cwd())
if (dry.code !== 0) {
  console.error('补丁预检失败（可能基线不符或已有补丁）：')
  console.error(dry.out)
  process.exit(1)
}

const apply = run('git', ['-C', repo, 'apply', patchPath()], process.cwd())
if (apply.code !== 0) {
  console.error('应用补丁失败：')
  console.error(apply.out)
  process.exit(1)
}
console.log('补丁已应用。')

console.log('接下来请执行：')
console.log(`  cd /d "${repo}"`)
console.log('  pnpm install')
console.log('  pnpm run build:lib')
console.log(`  dsh plugin --profile web add "${resolve(releaseRoot, 'plugin')}"`)

function patchPath() { return patch }
