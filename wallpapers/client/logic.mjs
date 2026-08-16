// wallpapers client 纯逻辑（无 DOM 引用，可单测）：
// 清单条目规范化 + 选择持久化（localStorage 键约定）+ 展示模式。

/** localStorage 键：当前选中的壁纸 item id。 */
export const SELECTED_KEY = 'wallpapers:selected'
/** localStorage 键：展示模式。 */
export const MODE_KEY = 'wallpapers:mode'

/** 特殊选择值：不显示壁纸。 */
export const NONE_ID = '__none__'
/** 特殊选择值：随机切换。 */
export const RANDOM_ID = '__random__'

/** 展示模式：chat=作为聊天背景（半透明遮罩），fullscreen=全屏铺开。 */
export const MODES = Object.freeze({ chat: 'chat', fullscreen: 'fullscreen' })

/**
 * 规范化 catalog 返回的条目为 client 可消费形态。
 * 保留可播放项：video（文件）与 scene（一张屏幕截图背景图 + 可选音频列表）。
 * 入参 { ok, root, items } → 出参 { playable: [...], unsupportedCount: number }。
 */
export function normalizeCatalog(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : []
  const playable = []
  let unsupportedCount = 0
  for (const it of items) {
    if (!it || typeof it !== 'object') continue // 跳过 null/畸形条目
    if (it.kind === 'video') {
      playable.push({
        id: String(it.id),
        title: String(it.title ?? it.id),
        kind: it.kind,
        file: String(it.file ?? ''),
        preview: String(it.preview ?? ''),
      })
    } else if (it.kind === 'scene') {
      playable.push({
        id: String(it.id),
        title: String(it.title ?? it.id),
        kind: it.kind,
        file: '',
        preview: String(it.preview ?? ''),
        image: String(it.image ?? ''),
        audios: Array.isArray(it.audios) ? it.audios.filter((s) => typeof s === 'string' && s !== '').map(String) : [],
      })
    } else {
      unsupportedCount++
    }
  }
  return { playable, unsupportedCount, root: catalog?.root ?? '' }
}

/**
 * 解析当前选择：'__random__' → 从 playable 里随机挑一个 id；
 * 其他 → 原样返回（可能是合法 id 或 '__none__'）。
 */
export function resolveSelection(selected, playable) {
  if (selected === RANDOM_ID) {
    if (playable.length === 0) return NONE_ID
    return playable[Math.floor(Math.random() * playable.length)].id
  }
  return selected
}

/** 在 playable 里按 id 查找条目。 */
export function findItem(playable, id) {
  return playable.find((it) => it.id === id) || null
}

/** 判断一个选择值是否属于「无壁纸 / 随机」这类非具体 id。 */
export function isMetaSelection(sel) {
  return sel === NONE_ID || sel === RANDOM_ID
}