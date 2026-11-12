/**
 * presence.test.mjs —— 「他在不在」按人算（2026-11-12）
 *
 * 起因：原来判断「他来过」只认 `meta seen:<ISO>`，而那东西的语义是「有人跟她说过话」，
 * 不记是谁。一个人用没事；社会层一开，群友说一句就会把「他回来了」算到别人头上。
 *
 * 三条要守住的事：
 *   1. 只有他说的话（heard, origin=owner）能证明他在场；群友的话不算。
 *   2. 旧账本里的 `meta seen:` 仍然算数（否则升级前的记录全变成「从没来过」）。
 *   3. 他回来后冷落天数要归零——不要求她写 reunion；reunion 只是她自己的感受。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lastOwnerSpokeMs, lastSeenMarkMs, lastPresenceMs } from '../lib/presence.js'
import { lastSeenAt, assess } from '../lib/absence.js'
import { lastSeenMs, summarizeAway } from '../lib/away.js'
import { deriveSelf } from '../lib/derive.js'

const T0 = Date.parse('2026-11-01T00:00:00Z')
const D = 86_400_000

function ev(id, day, over = {}) {
  return {
    id, ts: new Date(T0 + day * D).toISOString(), day, stage: 1,
    type: 'utterance', source: 'tool', text: id, refs: [], verdict: null,
    confidence: 0.6, flags: [], ...over,
  }
}

const seed = () => ev('ev_seed0000000000000000', 0, { type: 'seed', text: '一个存在', source: 'system' })
const absence = (days = 1) => ev('ev_abs000000000000000', 1, {
  type: 'absence', source: 'system', text: `那个人有 ${days} 天没出现，也没说去哪。`, days,
})
const heardOwner = (day) => ev(`ev_own${day}`, day, { type: 'heard', source: 'system', text: '我回来了', origin: 'owner' })
const heardGuest = (day) => ev(`ev_gst${day}`, day, { type: 'heard', source: 'system', text: '群里有人说话', origin: 'guest' })
const seenMark = (day) => ev(`ev_sn${day}`, day, { type: 'meta', source: 'system', text: `seen:${new Date(T0 + day * D).toISOString()}` })

test('presence：只有 master 的话算「他在场」，群友的不算', () => {
  const evs = [seed(), heardGuest(3), heardOwner(5), heardGuest(7)]
  assert.equal(lastOwnerSpokeMs(evs), T0 + 5 * D)
  assert.equal(lastPresenceMs(evs), T0 + 5 * D)
})

test('presence：旧账本的 meta seen 仍然算数（升级前后都不断档）', () => {
  const evs = [seed(), seenMark(4)]
  assert.equal(lastOwnerSpokeMs(evs), 0)
  assert.equal(lastSeenMarkMs(evs), T0 + 4 * D)
  assert.equal(lastPresenceMs(evs), T0 + 4 * D)
  // 两条并存时取最晚的
  assert.equal(lastPresenceMs([seed(), seenMark(4), heardOwner(6)]), T0 + 6 * D)
})

test('absence：他回来后算「回来了」；只有群友说话，冷落还在走', () => {
  const back = [seed(), absence(1), heardOwner(9)]
  assert.equal(lastSeenAt(back), T0 + 9 * D)
  assert.equal(assess(back, T0 + 9 * D, { afterDays: 2 }).reason, 'returned')

  // 起点还是第 1 天（旧 seen 标记），群友第 9 天说话不算他回来 → 冷落 8 天
  const stillGone = [seed(), seenMark(1), heardGuest(9)]
  const a = assess(stillGone, T0 + 9 * D, { afterDays: 2 })
  assert.equal(a.absent, true)
  assert.equal(a.days, 8)

  // 已经记过 absence 的那次冷落不重复写
  const recorded = [seed(), seenMark(1), absence(1), heardGuest(9)]
  assert.equal(assess(recorded, T0 + 9 * D, { afterDays: 2 }).reason, 'already-recorded')
})

test('away：空档期起点跟他亲口说的话对齐，不跟群友', () => {
  const evs = [seed(), heardOwner(2), heardGuest(8)]
  assert.equal(lastSeenMs(evs), T0 + 2 * D)
  const s = summarizeAway(evs, { now: T0 + 8 * D })
  assert.equal(s.days, 6)
})

test('derive：他回来后 absenceDays 归零，不必等她写 reunion', () => {
  const back = [seed(), absence(1), heardOwner(9)]
  assert.equal(deriveSelf(back, { now: T0 + 9 * D }).absenceDays, 0)

  // 只有群友说话：冷落还在（记的是 absence 自带的 1 天，不去跟群友的话相加）
  const stillGone = [seed(), absence(1), heardGuest(9)]
  assert.equal(deriveSelf(stillGone, { now: T0 + 9 * D }).absenceDays, 1)

  // 她写了 reunion：仍然算一次「她消化过这件事」，relatedness 拿到 +0.3 那部分
  const reunion = ev('ev_runi00000000000000', 9, {
    type: 'reunion', source: 'tool',
    text: '他回来的时候我正在想别的事，抬头第一句还是先问他去哪了，问完又觉得自己有点急。',
  })
  const withReunion = [seed(), absence(1), heardOwner(9), reunion]
  const m = deriveSelf(withReunion, { now: T0 + 9 * D })
  assert.equal(m.absenceDays, 0)
  assert.equal(m.reunions.length, 1)
})
