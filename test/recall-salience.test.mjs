import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RECALL_TYPE_BONUS,
  relativeTimeOf,
  renderRecall,
  searchEvents,
} from '../lib/recall.js'

const BASE = Date.parse('2026-10-01T12:00:00Z')
const NOW = Date.parse('2026-11-12T00:00:00Z')
const EMPTY = { solid: new Set(), scars: new Set(), singles: new Set() }

function ev(id, type, text, extra = {}) {
  return {
    v: 1,
    id,
    type,
    source: 'system',
    text,
    ts: new Date(BASE).toISOString(),
    ...extra,
  }
}

test('类型加成：refusal 不是 solid、BM25 也不高，仍凭 3 分进前列', () => {
  assert.deepEqual(RECALL_TYPE_BONUS, { refusal: 3, absence: 2, reunion: 2 })
  // 两个词都在同一份账本里，BM25 被文档数压得很低；refusal 的 3 分足以翻上来。
  const refusal = ev('ev_SAL1R', 'refusal', '云雀。' + '那件事 '.repeat(30))
  const plain = ev('ev_SAL1U', 'utterance', '云雀 云雀 云雀')
  const rows = searchEvents([refusal, plain], '云雀', {
    now: NOW,
    mode: 'ranked',
    factors: EMPTY,
  }).rows
  assert.equal(rows[0].id, refusal.id)
  assert.equal(rows[0].type, 'refusal')
})

test('类型加成取 max 不相加：既 solid 又 refusal，和只有 refusal 同分', () => {
  // 六条同文、同时间，BM25 与新鲜度完全一样，只剩重要度 / 类型在排序。
  const a = ev('ev_SAL2A', 'refusal', '云雀', {})
  const b = ev('ev_SAL2B', 'refusal', '云雀', {})
  const c = ev('ev_SAL2C', 'utterance', '云雀', {})
  const d = ev('ev_SAL2D', 'utterance', '云雀', {})
  const e = ev('ev_SAL2E', 'utterance', '云雀', {})
  const f = ev('ev_SAL2F', 'utterance', '云雀', {})
  const factors = {
    solid: new Set([a.id, c.id, d.id, f.id]),
    scars: new Set([d.id]),
    singles: new Set([c.id]),
  }
  const rows = searchEvents([a, b, c, d, e, f], '云雀', {
    now: NOW,
    mode: 'ranked',
    factors,
  }).rows
  // d = solid+疤 5；c = solid+单候选 4；a/b/f 都应是 3（a 若把类型再叠上去会变 6）。
  assert.deepEqual(rows.map((r) => r.id), [d.id, c.id, a.id, b.id, f.id, e.id])
})

test('字面模式完全不受类型加成影响：仍按原来的字面分与时间排', () => {
  const olderRefusal = ev('ev_SAL3R', 'refusal', '云雀')
  const newerPlain = ev('ev_SAL3U', 'utterance', '云雀 云雀', {
    ts: new Date(BASE + 60_000).toISOString(),
  })
  const rows = searchEvents([olderRefusal, newerPlain], '云雀', {
    now: NOW,
    mode: 'literal',
  }).rows
  // 两条字面分相同，字面模式只按时间新→旧；类型加成若漏进来，旧 refusal 会翻到前面。
  assert.deepEqual(rows.map((r) => r.id), [newerPlain.id, olderRefusal.id])
})

test('时间短语：今天 / 昨天 / N 天前 / N 周前 / N 个月前 五档', () => {
  assert.equal(relativeTimeOf(0), '今天')
  assert.equal(relativeTimeOf(1), '昨天')
  assert.equal(relativeTimeOf(3), '3 天前')
  assert.equal(relativeTimeOf(21), '3 周前')
  assert.equal(relativeTimeOf(60), '2 个月前')
  // 折算边界：7 天起按周，30 天起按月。
  assert.equal(relativeTimeOf(7), '1 周前')
  assert.equal(relativeTimeOf(29), '4 周前')
  assert.equal(relativeTimeOf(30), '1 个月前')

  const rows = [0, 1, 3, 21, 60].map((ago) => ({
    id: '',
    date: '2026-11-12',
    ago,
    type: 'utterance',
    text: '这一句',
  }))
  const text = renderRecall(rows)
  for (const phrase of ['今天', '昨天', '3 天前', '3 周前', '2 个月前']) {
    assert.ok(text.includes(`（${phrase}）`), `行文案里应带「（${phrase}）」：\n${text}`)
  }
})
