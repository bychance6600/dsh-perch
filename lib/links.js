/**
 * links.js —— 记忆链接（P5）
 *
 * 边只从账本里的显式 refs 来：revise / test / answer 引用过谁，就和谁双向相连。
 * 不做「同一会话里相邻两条」这种近似——那不是证据，只是猜测。
 *
 * 缓存是进程内的单槽：键 = 账本路径或 id + 末事件 id。只按这个键整体重建，
 * 没有增量、命中计数、TTL 或淘汰逻辑（设计口径 3.4）。账本分叉时末事件 id
 * 可能相同，所以键里必须有账本身份。
 */

/** 每条事件携带的类型；只有这些类型的 refs 算「引用」。 */
export const LINK_REF_TYPES = new Set(['test', 'answer', 'revise'])

/** 扩散常数：不存进边里，只在算分时乘一次。 */
export const LINK_WEIGHT = 0.5

/** 一条链接来源的分数 → 邻居的分数。 */
export function spreadRank(rank) {
  return Number(rank) * LINK_WEIGHT
}

/**
 * 从事件流建双向边。纯函数，不读盘、不缓存。
 * @param {object[]} events
 * @returns {Map<string, Set<string>>}
 */
export function buildLinks(events = []) {
  const links = new Map()
  const add = (a, b) => {
    if (!links.has(a)) links.set(a, new Set())
    links.get(a).add(b)
    if (!links.has(b)) links.set(b, new Set())
    links.get(b).add(a)
  }
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || !LINK_REF_TYPES.has(ev.type)) continue
    const from = String(ev.id ?? '')
    if (!from) continue
    for (const raw of Array.isArray(ev.refs) ? ev.refs : []) {
      const to = String(raw ?? '')
      if (!to || to === from) continue
      add(from, to)
    }
  }
  return links
}

let cache = { key: null, links: null }

/**
 * 带账本键的边缓存。键变了整体重建；同一键返回同一个 Map。
 * @param {object[]} events 完整账本，不是按人/时间收窄后的子集
 * @param {string} ledgerId 账本路径或 id
 */
export function eventLinks(events = [], ledgerId = '') {
  const list = Array.isArray(events) ? events : []
  const last = list.length ? String(list[list.length - 1]?.id ?? '') : ''
  const key = `${String(ledgerId ?? '')}|${last}`
  if (cache.key === key && cache.links) return cache.links
  const links = buildLinks(list)
  cache = { key, links }
  return links
}
