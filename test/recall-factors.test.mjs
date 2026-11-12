import test from 'node:test'
import assert from 'node:assert/strict'

import { recallFactorsOf } from '../lib/derive.js'
import { RECALL_FRESH_DAYS, RECALL_FRESH_MAX, searchEvents } from '../lib/recall.js'

const BASE = Date.parse('2026-10-01T12:00:00Z')
const NOW = Date.parse('2026-11-12T00:00:00Z')
const DAY = 86_400_000
const idOf = (n) => `ev_TEST${String(n).padStart(4, '0')}`

function utt(n, text, ts = BASE + n * 60_000, extra = {}) {
  return {
    v: 1,
    id: idOf(n),
    type: 'utterance',
    source: 'system',
    text,
    ts: new Date(ts).toISOString(),
    ...extra,
  }
}

test('recallFactorsOf 只从 deriveSelf 结果取三档，不改判定', () => {
  const model = {
    solid: [{ id: 'ev_A' }, { id: '' }],
    scars: [{ id: 'ev_B' }],
    beliefs: [{ id: 'ev_C', mentions: 1 }, { id: 'ev_D', mentions: 2 }, { id: 'ev_E', mentions: 1 }],
  }
  const f = recallFactorsOf(model)
  assert.deepEqual([...f.solid], ['ev_A'])
  assert.deepEqual([...f.scars], ['ev_B'])
  assert.deepEqual([...f.singles].sort(), ['ev_C', 'ev_E'])
})

test('ranked 三档重要度：solid > 疤 > 单候选 > 普通，相关性相同时按此排序', () => {
  const events = [1, 2, 3, 4].map((n) => utt(n, '云雀这个名字我收下了。', BASE))
  const factors = {
    solid: new Set([idOf(1)]),
    scars: new Set([idOf(2)]),
    singles: new Set([idOf(3)]),
  }
  const rows = searchEvents(events, '云雀', { now: NOW, mode: 'ranked', factors }).rows
  assert.deepEqual(rows.map((r) => r.id), [idOf(1), idOf(2), idOf(3), idOf(4)])
})

test('ranked 新鲜度：相关性相同时，今天的排在 60 天前的前面', () => {
  const events = [
    utt(1, '云雀这个名字我收下了。', NOW - 60 * DAY),
    utt(2, '云雀这个名字我收下了。', NOW),
  ]
  const factors = { solid: new Set(), scars: new Set(), singles: new Set() }
  const rows = searchEvents(events, '云雀', { now: NOW, mode: 'ranked', factors }).rows
  assert.deepEqual(rows.map((r) => r.id), [idOf(2), idOf(1)])
  assert.equal(RECALL_FRESH_MAX, 2)
  assert.equal(RECALL_FRESH_DAYS, 30)
})

test('literal 行为冻结：同一 fixture 与主线快照逐字节相同', () => {
  const texts = [
    '我收下这个名字，因为它不别扭。',
    '云雀这个名字是曲子的名字。',
    '煎饼：云雀和雀雀，你希望我叫哪个？',
    '名字是代号，但云雀是我认下的。',
    '今天走了走。',
    '晚上吃了饭。',
  ]
  const events = texts.map((text, i) => utt(i + 1, text, BASE + (i + 1) * 60_000))
  const rows = searchEvents(events, '云雀 名字', { now: NOW, mode: 'literal' }).rows
  assert.deepEqual(rows, [
    { id: 'ev_TEST0004', date: '2026-10-01', ago: 41, type: 'utterance', text: '名字是代号，但云雀是我认下的。' },
    { id: 'ev_TEST0002', date: '2026-10-01', ago: 41, type: 'utterance', text: '云雀这个名字是曲子的名字。' },
    { id: 'ev_TEST0003', date: '2026-10-01', ago: 41, type: 'utterance', text: '煎饼：云雀和雀雀，你希望我叫哪个？' },
    { id: 'ev_TEST0001', date: '2026-10-01', ago: 41, type: 'utterance', text: '我收下这个名字，因为它不别扭。' },
  ])
})

test('ranked 仍过滤被改口推翻的旧句', () => {
  const u1 = utt(1, '我有点难过。')
  const u2 = utt(2, '今天还是难过。')
  const rev = {
    v: 1,
    id: idOf(3),
    type: 'revise',
    source: 'system',
    text: '其实还好，不算什么。',
    verdict: 'refuted',
    refs: [u1.id],
    ts: new Date(BASE + 3 * 60_000).toISOString(),
  }
  const rows = searchEvents([u1, u2, rev], '难过', { mode: 'ranked' }).rows
  assert.deepEqual(rows.map((r) => r.id), [u2.id])
})

test('不传 factors 时 ranked 仍能自己算三档（不依赖测试注入）', () => {
  const events = [utt(1, '云雀这个名字我收下了。')]
  const rows = searchEvents(events, '云雀', { now: NOW, mode: 'ranked' }).rows
  assert.equal(rows[0].id, 'ev_TEST0001')
})
