// 极简断言跑测（node --test 会 spawn 子进程，sandbox 下 EPERM；用单进程直跑）。
import {
  SELECTED_KEY, MODE_KEY, NONE_ID, RANDOM_ID, MODES,
  normalizeCatalog, resolveSelection, findItem, isMetaSelection,
} from '../client/logic.mjs'
import { parseScene } from '../src/scene.mjs'
import { isSafeRel, UNPACKED_DIR_NAME } from '../src/catalog.mjs'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ok  ', label) }
  else { fail++; console.log('  FAIL', label, '\n     got:', a, '\n   want:', e) }
}
function ok(v, label) { if (v) { pass++; console.log('  ok  ', label) } else { fail++; console.log('  FAIL', label) } }

// ---- normalizeCatalog ----
{
  const cat = {
    ok: true, root: 'E:\\x',
    items: [
      { id: '1', title: 'A', kind: 'video', file: 'a.mp4', preview: 'p.jpg' },
      { id: '2', title: 'B', kind: 'web', file: 'index.html', preview: '' },
      { id: '3', title: 'C', kind: 'unsupported', file: '', preview: '' },
      { id: '4', title: 'D', kind: 'unsupported' },
      null,
    ],
  }
  const n = normalizeCatalog(cat)
  eq(n.playable.length, 1, '规范化只保留可播放项')
  eq(n.playable[0].id, '1', 'video 项保留')
  eq(n.unsupportedCount, 3, 'web/unsupported 计数')
}
eq(normalizeCatalog(null).playable.length, 0, '空 catalog 安全')
{
  const n = normalizeCatalog({ items: [{ id: 7, title: null, kind: 'video', file: '', preview: null }] })
  eq(n.playable[0].title, '7', 'null title 回退 id')
  eq(n.playable[0].preview, '', 'null preview 回退空串')
}

// ---- resolveSelection ----
const playable = [{ id: '1' }, { id: '2' }, { id: '3' }]
eq(resolveSelection('2', playable), '2', '具体 id 原样返回')
eq(resolveSelection(NONE_ID, playable), NONE_ID, 'none 原样返回')
eq(resolveSelection(RANDOM_ID, []), NONE_ID, '随机但无列表回退 none')
{
  const got = resolveSelection(RANDOM_ID, playable)
  ok(['1', '2', '3'].includes(got), '随机从列表挑选')
}

// ---- findItem ----
eq(findItem(playable, '2')?.id, '2', 'findItem 命中')
eq(findItem(playable, '999'), null, 'findItem 缺失返回 null')

// ---- isMetaSelection ----
ok(isMetaSelection(NONE_ID), 'none 是元选择')
ok(isMetaSelection(RANDOM_ID), 'random 是元选择')
ok(!isMetaSelection('1'), '具体 id 不是元选择')

// ---- normalizeCatalog 含 scene（低成本复刻，进 playable）----
{
    const n = normalizeCatalog({ items: [{ id: '9', title: 'S', kind: 'scene', file: '', preview: 'p.jpg', image: '屏幕截图.png', audios: ['a.mp3', null, 'b.flac'] }] })
    eq(n.playable.length, 1, 'scene 项进入 playable')
    eq(n.playable[0].kind, 'scene', 'scene kind 保留')
    eq(n.playable[0].image, '屏幕截图.png', 'scene 背景图透传')
    eq(n.playable[0].audios, ['a.mp3', 'b.flac'], 'scene 音频列表过滤 null 并转字符串')
    eq(n.unsupportedCount, 0, 'scene 不计入 unsupported')
  }
{
    const n = normalizeCatalog({ items: [{ id: '10', title: 'T', kind: 'scene', image: '', audios: undefined }] })
    eq(n.playable[0].image, '', 'scene image 空串兜底')
    eq(n.playable[0].audios, [], 'scene audios 缺失兜底空数组')
  }

  // ---- isSafeRel：允许 output/<id> 这类多段相对路径（供 /media 访问 scene 素材） ----
  ok(isSafeRel('output/1216660981'), '多段相对路径安全')
  ok(!isSafeRel('output/../1216660981'), '目录穿越被拒')
  ok(!isSafeRel('/etc/passwd'), '绝对路径被拒')
  ok(UNPACKED_DIR_NAME === 'output', '解包目录名常量')

  // ---- parseScene：缺 scene.json 安全返回 ----
  eq(parseScene('/nonexistent/dir/xyz')?.ok, false, '缺 scene.json 返回 fail')
// ---- 常量存在性 ----
ok(SELECTED_KEY.length > 0 && MODE_KEY.length > 0, 'localStorage 键常量存在')
ok(NONE_ID.length > 0 && RANDOM_ID.length > 0, '元选择常量存在')
ok(MODES.chat === 'chat' && MODES.fullscreen === 'fullscreen', '模式常量存在')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
