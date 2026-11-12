import test from 'node:test'
import assert from 'node:assert/strict'

import { searchEvents, supersededIdsOf } from '../lib/recall.js'
import { buildIndex, indexKey, scoreQuery, tokenize } from '../lib/search-index.js'
import { SYNONYMS, expandToken } from '../lib/synonyms.js'

const BASE = Date.parse('2026-10-01T00:00:00Z')
const idOf = (n) => `ev_TEST${String(n).padStart(4, '0')}`

function utt(n, text, extra = {}) {
  return {
    v: 1,
    id: idOf(n),
    type: 'utterance',
    source: 'system',
    text,
    ts: new Date(BASE + n * 60_000).toISOString(),
    ...extra,
  }
}

/** 60 条合成账本：只有第 7 条含「难过」，别的句子避开同义词表。 */
function fixture() {
  const events = []
  for (let n = 1; n <= 60; n++) {
    events.push(utt(n, n === 7 ? '今天有点难过，说不清为什么。' : `第 ${n} 条：今天走了走，晚上吃了饭。`))
  }
  return events
}

test('同义词表只做归并，关键几条按约定归一', () => {
  assert.ok(SYNONYMS.size >= 55 && SYNONYMS.size <= 70, `同义词表应有 60 条左右，实际 ${SYNONYMS.size}`)
  assert.equal(expandToken('不开心'), '难过')
  assert.equal(expandToken('高兴'), '开心')
  assert.equal(expandToken('火大'), '生气')
  assert.equal(expandToken('累'), '疲惫')
  assert.equal(expandToken('钱'), '工资')
  assert.equal(expandToken('害怕'), '慌')
  assert.equal(expandToken('睡不着'), '失眠')
  assert.equal(expandToken('没有收录的词'), '没有收录的词')
})

test('tokenize 出中文二字组与英文词，并去掉单字停用词', () => {
  const toks = tokenize('我 在 家看 NBA')
  assert.ok(toks.includes('家看'))
  assert.ok(toks.includes('nba'))
  assert.ok(!toks.includes('我'))
  assert.ok(!toks.includes('在'))
})

test('P3 验收：literal 翻不到「难过」，「不开心」ranked 能翻到', () => {
  const events = fixture()
  const now = Date.parse('2026-11-12T00:00:00Z')

  const literal = searchEvents(events, '不开心', { now, mode: 'literal' })
  assert.equal(literal.rows.length, 0)

  const ranked = searchEvents(events, '不开心', { now, mode: 'ranked' })
  assert.ok(ranked.rows.length > 0)
  assert.equal(ranked.rows[0].id, idOf(7))
  assert.match(ranked.rows[0].text, /难过/)

  // 不传 mode 时读 settings.recall.mode；陌生值回落到 literal。
  const fromSettings = searchEvents(events, '不开心', { now, settings: { recall: { mode: 'ranked' } } })
  assert.equal(fromSettings.rows[0].id, idOf(7))
  const bogus = searchEvents(events, '不开心', { now, settings: { recall: { mode: 'bm25' } } })
  assert.deepEqual(bogus.rows, literal.rows)
})

test('literal 仍是原来的字面计分：显式 literal 与不传模式逐字节相同', () => {
  const events = fixture()
  const now = Date.parse('2026-11-12T00:00:00Z')
  const a = searchEvents(events, '难过', { now })
  const b = searchEvents(events, '难过', { now, mode: 'literal' })
  assert.deepEqual(a, b)
  assert.equal(a.rows[0].id, idOf(7))
})

test('索引缓存键按「条数:最后一条 id」，追加一条后重建并含新事件', () => {
  const events = fixture()
  const idx1 = buildIndex(events)
  const idx2 = buildIndex(events)
  assert.equal(idx1, idx2, '同一份账本应复用同一个索引对象')
  assert.equal(idx1.key, indexKey(events))
  assert.equal(idx1.N, 60)

  const added = [...events, utt(61, '今天又想到难过的事。')]
  const idx3 = buildIndex(added)
  assert.notEqual(idx3, idx1)
  assert.notEqual(idx3.key, idx1.key)
  assert.equal(idx3.key, indexKey(added))
  const scores = scoreQuery(idx3, '难过')
  assert.ok(scores.has(idOf(61)))
})

test('ranked 仍过滤被改口推翻的旧句', () => {
  const u1 = utt(1, '我有点难过。')
  const u2 = utt(2, '今天还是难过。')
  const rev = {
    v: 1,
    id: 'ev_TEST0003',
    type: 'revise',
    source: 'system',
    text: '其实还好，不算什么。',
    verdict: 'refuted',
    refs: [u1.id],
    ts: new Date(BASE + 3 * 60_000).toISOString(),
  }
  const events = [u1, u2, rev]
  assert.deepEqual([...supersededIdsOf(events)], [u1.id])

  const ranked = searchEvents(events, '难过', { mode: 'ranked' })
  assert.deepEqual(ranked.rows.map((r) => r.id), [u2.id])

  const all = searchEvents(events, '难过', { mode: 'ranked', includeSuperseded: true })
  assert.deepEqual(new Set(all.rows.map((r) => r.id)), new Set([u1.id, u2.id]))
})
