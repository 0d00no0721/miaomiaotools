// 路由前缀单一来源：client bundle（内联）与 Node half 共用。
// 改前缀只改这里；任何文件不得手写 '/wallpapers/...' 字面量。
export const ROUTE_PREFIX = '/wallpapers'
export const CATALOG_PATH = `${ROUTE_PREFIX}/catalog`
export const MEDIA_PATH   = `${ROUTE_PREFIX}/media`
export const ITEM_PATH    = `${ROUTE_PREFIX}/item`
export const SCENE_PATH   = `${ROUTE_PREFIX}/scene`
