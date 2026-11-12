/**
 * presence.js —— 「他在不在」按人算（2026-11-12）
 *
 * 为什么单独成一个文件：
 *   原来判断「他来过」只有一个依据——`meta seen:<ISO>`。它由 capture.js 在她写字时写，
 *   语义是「有人跟她说过话」，**不记是谁**。一个人用的时候两者等价；一旦开了社会层
 *   （群友、陌生人也能跟她说话），群里有人 @ 她一句就会写成 seen，于是「他回来了」被
 *   算到别人头上。账本一旦记脏，回不了头。
 *
 * 现在的口径（两条并存，取最晚）：
 *   1. `heard` 事件里 `origin === 'owner'` 的那些——那是他真说过的话。
 *      这是主依据：知道是谁，也和他自己说的话绑在一起。
 *   2. 旧账本里的 `meta seen:<ISO>`——继续算数，不然升级前的一切都成了「从没来过」。
 *      它分不出人，所以只在没有更准的依据时才起作用（取 max 天然如此）。
 *
 * 只读、纯函数、不碰磁盘。谁想知道「他多久没来」，都从这里取。
 */

/** 事件时间（毫秒）。取不到返回 0。 */
export function tsMs(x) {
  const raw = x?.ts
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const t = Date.parse(String(raw ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** 他最近一次真的说话（heard 且 origin=owner）的时刻。没有返回 0。 */
export function lastOwnerSpokeMs(events) {
  let best = 0
  for (const e of events ?? []) {
    if (e?.type !== 'heard') continue
    if (String(e.origin ?? '') !== 'owner') continue
    const t = tsMs(e)
    if (t > best) best = t
  }
  return best
}

/** 旧标记 `meta seen:<ISO>` 的最晚一条。没有返回 0。 */
export function lastSeenMarkMs(events) {
  let best = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('seen:')) continue
    const v = Date.parse(t.slice(5).trim())
    if (Number.isFinite(v) && v > best) best = v
  }
  return best
}

/** 他在场的最晚证据：他说过的话优先，旧 seen 标记兜底。 */
export function lastPresenceMs(events) {
  return Math.max(lastOwnerSpokeMs(events), lastSeenMarkMs(events))
}
