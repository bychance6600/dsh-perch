/**
 * revise-chain.test.mjs —— M2 改口链（2026-11-12）
 *
 * 锁三件事：
 *   1. refuted / refined 才建指针；confirmed 只是确认，不能画成改口。
 *   2. 被取代的判断默认不进检索，审计查询显式 includeSuperseded 才放回。
 *   3. 指针是派生的：同一份事件重放两次必须全等。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, beliefStatesOf } from '../lib/derive.js'
import { searchEvents } from '../lib/recall.js'
import { MEMORY_PAGE } from '../lib/memory-page.js'

const NOW = Date.parse('2026-11-12T12:00:00+08:00')

function ev(id, type, day, text, extra = {}) {
  return {
    id,
    type,
    day,
    ts: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    text,
    refs: [],
    flags: [],
    ...extra,
  }
}

function chain() {
  const u1 = ev('ev_u1', 'utterance', 1, '我不喜欢猫。')
  const r1 = ev('ev_r1', 'revise', 2, '我其实不讨厌猫。', { refs: [u1.id], verdict: 'refuted' })
  const r2 = ev('ev_r2', 'revise', 3, '猫挺可爱的。', { refs: [r1.id], verdict: 'refined' })
  return [u1, r1, r2]
}

test('refuted 一次：旧句带 supersededBy，新句带 supersedes，status 仍是三值', () => {
  const [u1, r1] = chain()
  const model = deriveSelf([u1, r1], { now: NOW })
  const states = beliefStatesOf(model)
  const old = states.find((b) => b.id === u1.id)
  const fresh = states.find((b) => b.id === r1.id)
  assert.equal(old.status, 'refuted')
  assert.equal(old.supersededBy, r1.id)
  assert.equal(fresh.status, 'active')
  assert.deepEqual(fresh.supersedes, [u1.id])
  assert.equal(model.facts.revises, 0, 'refuted 不是改口，不涨 refines 计数')
})

test('链式改口：U1→R1→R2 指针齐，默认只回 R2，审计才回三条', () => {
  const events = chain()
  const model = deriveSelf(events, { now: NOW })
  const states = beliefStatesOf(model)
  const [u1, r1, r2] = events

  assert.equal(states.find((b) => b.id === u1.id).status, 'refuted')
  assert.equal(states.find((b) => b.id === u1.id).supersededBy, r1.id)
  assert.equal(states.find((b) => b.id === r1.id).status, 'refined')
  assert.equal(states.find((b) => b.id === r1.id).supersededBy, r2.id)
  assert.equal(states.find((b) => b.id === r2.id).status, 'active')
  assert.deepEqual(states.find((b) => b.id === r2.id).supersedes, [r1.id])

  const live = searchEvents(events, '猫', { now: NOW })
  assert.deepEqual(live.rows.map((r) => r.id), [r2.id], '活跃检索只剩现话')

  const audit = searchEvents(events, '猫', { now: NOW, includeSuperseded: true })
  assert.deepEqual(audit.rows.map((r) => r.id).sort(), [u1.id, r1.id, r2.id].sort())
})

test('confirmed 不是改口：旧句仍 active、无指针，refined 计数不变', () => {
  const u = ev('ev_u2', 'utterance', 4, '猫会自己找地方晒太阳。')
  const c = ev('ev_c1', 'revise', 5, '猫会自己找地方晒太阳，这句我确认。', { refs: [u.id], verdict: 'confirmed' })
  const model = deriveSelf([u, c], { now: NOW })
  const states = beliefStatesOf(model)
  const old = states.find((b) => b.id === u.id)
  const fresh = states.find((b) => b.id === c.id)
  assert.equal(old.status, 'active')
  assert.equal(old.supersededBy, undefined)
  assert.equal(fresh.supersedes, undefined)
  assert.equal(model.facts.revises, 0)
})

test('指针只派生：同一份事件重放两次全等', () => {
  const events = chain()
  assert.deepStrictEqual(deriveSelf(events, { now: NOW }), deriveSelf(events, { now: NOW }))
})

test('记忆页认识 revise 边与「原话 → 改口 → 现话」文案', () => {
  assert.match(MEMORY_PAGE, /e\.kind==="revise"/)
  assert.match(MEMORY_PAGE, /原话 → 改口 → 现话/)
  assert.match(MEMORY_PAGE, /isRevise/)
})
