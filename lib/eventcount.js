/**
 * eventcount.js —— 事件流按「真实经历 / 记账 / 噪声」分三类（A20）
 *
 * 为什么分开：界面上的「事件 N 条」原来把 meta、seed、test、dream 全算进去，
 * 看起来她经历了很多，其实大半是系统记账。用户要能一眼看出她真正过过多少天。
 *
 * 口径只按类型分，不看内容——同一类型里再按文本猜，就成了评价她哪句算数。
 * 不认识的类型一律算真实经历（宁可多算，不把新事件悄悄藏掉）。
 */

/** 系统记账：不是她经历的事，只是为了以后能查。 */
const META_TYPES = new Set(['meta', 'grant', 'grant_offer', 'seed', 'test'])
/** 噪声：梦这类已经删掉、只留在旧事件流里的类型。 */
const NOISE_TYPES = new Set(['dream'])

export function countEvents(events = []) {
  let meta = 0
  let noise = 0
  for (const e of Array.isArray(events) ? events : []) {
    const t = String(e?.type ?? '')
    if (META_TYPES.has(t)) meta += 1
    else if (NOISE_TYPES.has(t)) noise += 1
  }
  const total = Array.isArray(events) ? events.length : 0
  return { real: total - meta - noise, meta, noise, total }
}
