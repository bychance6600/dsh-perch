/**
 * recall-links.test.mjs —— P5 记忆链接（1 跳扩散）
 *
 * 只测三件事：边只认显式 refs、扩散只发生在 ranked、缓存的键里有账本身份。
 * 不测 BM25 公式本身（那是 P3 的测试）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { searchEvents } from '../lib/recall.js'
import { LINK_WEIGHT, spreadRank } from '../lib/links.js'

const BASE = Date.parse('2026-10-01T12:00:00Z')
const NOW = Date.parse('2026-11-12T00:00:00Z')

/** 每组用独立前缀：BM25 的缓存键只认「条数:末条 id」，不能让测试互相喂旧索引。 */
function makeFixtures(tag) {
  const idOf = (n) => `ev_P5${tag}${String(n).padStart(4, '0')}`
  const ev = (n, type, text, extra = {}) => ({
    v: 1,
    id: idOf(n),
    type,
    source: 'system',
    text,
    ts: new Date(BASE + n * 60_000).toISOString(),
    ...extra,
  })
  /** 一条带显式 refs 的来源。refs 是唯一允许的边来源。 */
  const source = (n, refs, text = '云雀这个名字我收下了。') =>
    ev(n, 'revise', text, { refs, verdict: 'confirmed' })
  return { idOf, ev, source }
}

test('1 跳能带出 refs 指向的那条；字面完全不重合也算，且不再走第二跳', () => {
  const { idOf, ev, source } = makeFixtures('A')
  const first = source(1, [idOf(2)])
  const neighbor = ev(2, 'answer', '那天下午的光很软。', { refs: [idOf(3)] })
  const secondHop = ev(3, 'utterance', '再远一点的那句话。')
  const { rows } = searchEvents([first, neighbor, secondHop], '云雀', {
    now: NOW,
    settings: { recall: { mode: 'ranked' } },
    weigh: false,
    ledgerId: 'one-hop',
  })
  assert.deepEqual(rows.map((r) => r.id), [idOf(1), idOf(2)])
  assert.ok(!rows.some((r) => r.id === idOf(3)), '只扩散一跳，第二跳不跟')
})

test('邻居分数是来源的 0.5；两路命中同一条时取高分', () => {
  const { idOf, ev, source } = makeFixtures('B')
  assert.equal(LINK_WEIGHT, 0.5)
  assert.equal(spreadRank(10), 5)
  assert.equal(spreadRank(2.5), 1.25)

  const high = source(1, [idOf(3)])
  const low = source(2, [idOf(3), idOf(4)])
  const shared = ev(3, 'utterance', '完全无关的一句话。', { ts: new Date(BASE).toISOString() })
  const onlyLow = ev(4, 'utterance', '完全无关的另一句。', { ts: new Date(BASE + 10 * 60_000).toISOString() })
  const factors = { solid: new Set([idOf(1)]), scars: new Set(), singles: new Set() }
  const { rows } = searchEvents([high, low, shared, onlyLow], '云雀', {
    now: NOW,
    mode: 'ranked',
    weigh: true,
    factors,
    ledgerId: 'two-paths',
  })
  const ids = rows.map((r) => r.id)
  assert.ok(ids.includes(idOf(3)) && ids.includes(idOf(4)))
  assert.ok(ids.indexOf(idOf(3)) < ids.indexOf(idOf(4)), '共享邻居应拿到高分来源的 0.5，而不是被低分覆盖')
})

test('literal 完全不走链接', () => {
  const { idOf, ev, source } = makeFixtures('C')
  const first = source(1, [idOf(2)])
  const neighbor = ev(2, 'utterance', '那天下午的光很软。')
  const { rows } = searchEvents([first, neighbor], '云雀', {
    now: NOW,
    mode: 'literal',
    weigh: false,
  })
  assert.deepEqual(rows.map((r) => r.id), [idOf(1)])
})

test('关掉 links 后与没有链接功能的 ranked 逐字节一致', () => {
  const { idOf, ev, source } = makeFixtures('D')
  const first = source(1, [idOf(2)])
  const neighbor = ev(2, 'utterance', '那天下午的光很软。')
  const events = [first, neighbor]
  const noRefs = events.map((e) => ({ ...e, refs: [] }))
  const off = searchEvents(events, '云雀', {
    now: NOW,
    settings: { recall: { mode: 'ranked', links: false } },
    weigh: false,
    ledgerId: 'links-off',
  })
  const baseline = searchEvents(noRefs, '云雀', {
    now: NOW,
    mode: 'ranked',
    weigh: false,
    ledgerId: 'links-off-baseline',
  })
  assert.deepEqual(off, baseline)
  assert.deepEqual(off.rows.map((r) => r.id), [idOf(1)])
})

test('缓存键含账本 id：两个账本末事件 id 相同也不串', () => {
  const { idOf, ev, source } = makeFixtures('E')
  const a = [
    source(1, [idOf(2)]),
    ev(2, 'utterance', 'A 账本的邻居。'),
    ev(3, 'utterance', '两个账本共用的结尾。'),
  ]
  const b = [
    source(1, [idOf(3)]),
    ev(2, 'utterance', 'B 账本的无关句。'),
    ev(3, 'utterance', '两个账本共用的结尾，但 B 的链接指向这里。'),
  ]
  const opts = { now: NOW, mode: 'ranked', weigh: false }
  const a1 = searchEvents(a, '云雀', { ...opts, ledgerId: 'ledger-a' }).rows.map((r) => r.id)
  const b1 = searchEvents(b, '云雀', { ...opts, ledgerId: 'ledger-b' }).rows.map((r) => r.id)
  const a2 = searchEvents(a, '云雀', { ...opts, ledgerId: 'ledger-a' }).rows.map((r) => r.id)
  assert.deepEqual(a1, [idOf(1), idOf(2)])
  assert.deepEqual(b1, [idOf(1), idOf(3)])
  assert.deepEqual(a2, a1, '切到另一本账再切回来，不能拿到另一本的边')
})
