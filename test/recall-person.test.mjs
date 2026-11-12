/**
 * recall-person.test.mjs —— 按人 / 按时间翻旧事（P4）
 *
 * 只测两件事：收窄是否真的把「她自己的话」和「听来的话」一起带上、
 * 认不出人时是否退回词面。排序公式不在这里重测（那是 recall-factors / bm25 的事）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPeople } from '../lib/people.js'
import { registerRecall, searchEvents } from '../lib/recall.js'

const NOW = Date.parse('2026-11-12T00:00:00.000Z')
const T0 = Date.parse('2026-10-01T00:00:00.000Z')
const T1 = Date.parse('2026-10-02T00:00:00.000Z')
const T2 = Date.parse('2026-10-03T00:00:00.000Z')

function ev(id, text, extra = {}) {
  return {
    v: 1,
    id,
    type: 'utterance',
    source: 'system',
    text,
    ts: new Date(T0).toISOString(),
    ...extra,
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-recall-person-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

async function saveEvents(root, events) {
  await writeFile(join(root, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

function captureSpec(root) {
  let spec = null
  registerRecall({ tools: { register: (s) => { spec = s } } }, { root })
  return spec
}

test('按人翻：同会话里听到的与她自己的话都在，不串到别人', () => {
  const events = [
    ev('ev_A1', '云今天很薄', { type: 'heard', person: 'u_a', sessionId: 's_a' }),
    ev('ev_A2', '云的边像纸', { sessionId: 's_a' }),
    ev('ev_B1', '云今天很薄', { type: 'heard', person: 'u_b', sessionId: 's_b' }),
    ev('ev_B2', '云的边像纸', { sessionId: 's_b' }),
  ]
  const rows = searchEvents(events, '云', { now: NOW, personIds: ['u_a'] }).rows
  assert.deepEqual(rows.map((r) => r.id).sort(), ['ev_A1', 'ev_A2'])
})

test('群会话是共用的：按人翻只补她自己的话，不把别人的话带进来', () => {
  const events = [
    ev('ev_G1', '云今天很薄', { type: 'heard', person: 'u_a', sessionId: 's_group' }),
    ev('ev_G2', '云今天很厚', { type: 'heard', person: 'u_b', sessionId: 's_group' }),
    ev('ev_S1', '云的边像纸', { type: 'utterance', sessionId: 's_group' }),
    ev('ev_S2', '我改口了，云是厚的', { type: 'revise', sessionId: 's_group' }),
  ]
  const rows = searchEvents(events, '云', { now: NOW, personIds: ['u_a'] }).rows
  assert.deepEqual(rows.map((r) => r.id).sort(), ['ev_G1', 'ev_S1', 'ev_S2'])
  assert.ok(!rows.some((r) => r.id === 'ev_G2'), '同群里别人说的话不该被算进「按他翻」')
})

test('一个人都没命中时等于没传，不清空结果', () => {
  const events = [
    ev('ev_A1', '云今天很薄', { person: 'u_a', sessionId: 's_a' }),
    ev('ev_B1', '云今天很薄', { person: 'u_b', sessionId: 's_b' }),
  ]
  const all = searchEvents(events, '云', { now: NOW }).rows
  const none = searchEvents(events, '云', { now: NOW, personIds: ['u_nobody'] }).rows
  assert.deepEqual(none, all)
})

test('from / to 是闭区间：边界那两条都在，毫秒与 ISO 两种写法一致', () => {
  const events = [
    ev('ev_D1', '边界那天', { ts: new Date(T1 - 1).toISOString() }),
    ev('ev_D2', '边界那天', { ts: new Date(T1).toISOString() }),
    ev('ev_D3', '边界那天', { ts: new Date(T2).toISOString() }),
    ev('ev_D4', '边界那天', { ts: new Date(T2 + 1).toISOString() }),
  ]
  const numeric = searchEvents(events, '边界', { now: NOW, from: T1, to: T2 }).rows
  const iso = searchEvents(events, '边界', {
    now: NOW,
    from: new Date(T1).toISOString(),
    to: new Date(T2).toISOString(),
  }).rows
  assert.deepEqual(numeric.map((r) => r.id).sort(), ['ev_D2', 'ev_D3'])
  assert.deepEqual(iso, numeric)

  const bad = searchEvents(events, '边界', { now: NOW, from: '不是时间', to: '' }).rows
  assert.deepEqual(bad.map((r) => r.id).sort(), ['ev_D1', 'ev_D2', 'ev_D3', 'ev_D4'])
})

test('person 与 query 同时给：先收窄再排序，别的人再相关也不进来', () => {
  const events = [
    ev('ev_A', '今天云雀叫了', { person: 'u_a', sessionId: 's_a' }),
    ev('ev_B', '云雀云雀云雀云雀云雀云雀', { person: 'u_b', sessionId: 's_b' }),
  ]
  const all = searchEvents(events, '云雀', { now: NOW, mode: 'ranked', weigh: false }).rows
  assert.equal(all[0].id, 'ev_B', '不按人收窄时，重复得多的那条相关性更高')
  const only = searchEvents(events, '云雀', {
    now: NOW,
    mode: 'ranked',
    weigh: false,
    personIds: ['u_a'],
  }).rows
  assert.deepEqual(only.map((r) => r.id), ['ev_A'])
})

test('工具按名字能解析出多个人，按 id 精确优先', () => withRoot(async (root) => {
  const people = createPeople(root)
  await people.upsert('u_1', { name: '小满' })
  await people.upsert('u_2', { name: '小满二号' })
  await people.upsert('u_3', { name: '阿泽' })
  const events = [
    ev('ev_P1', '云雀在窗边', { type: 'heard', person: 'u_1', sessionId: 's_1', ts: new Date(T0).toISOString() }),
    ev('ev_P2', '云雀在窗边', { type: 'heard', person: 'u_2', sessionId: 's_2', ts: new Date(T1).toISOString() }),
    ev('ev_P3', '云雀在窗边', { type: 'heard', person: 'u_3', sessionId: 's_3', ts: new Date(T2).toISOString() }),
  ]
  await saveEvents(root, events)
  const spec = captureSpec(root)
  assert.ok(spec.parameters.properties.person)
  assert.ok(spec.parameters.properties.from)
  assert.ok(spec.parameters.properties.to)

  const byName = await spec.execute({ query: '云雀', person: '小满' })
  assert.equal(byName.found, true)
  assert.match(byName.text, /ev_P1/)
  assert.match(byName.text, /ev_P2/)
  assert.ok(!byName.text.includes('ev_P3'), '名字没命中的第三个人不该串进来')

  const byId = await spec.execute({ query: '云雀', person: 'u_3' })
  assert.match(byId.text, /ev_P3/)
  assert.ok(!byId.text.includes('ev_P1'))
}))

test('认不出人时退回词面；工具也把 from / to 交给检索', () => withRoot(async (root) => {
  const events = [
    ev('ev_P1', '云雀在窗边', { type: 'heard', person: 'u_1', ts: new Date(T0).toISOString() }),
    ev('ev_P2', '云雀在窗边', { type: 'heard', person: 'u_2', ts: new Date(T1).toISOString() }),
    ev('ev_P3', '云雀在窗边', { type: 'heard', person: 'u_3', ts: new Date(T2).toISOString() }),
  ]
  await saveEvents(root, events)
  const spec = captureSpec(root)

  const fallback = await spec.execute({ query: '云雀', person: '查无此人' })
  assert.equal(fallback.found, true)
  for (const id of ['ev_P1', 'ev_P2', 'ev_P3']) assert.match(fallback.text, new RegExp(id))

  const windowed = await spec.execute({
    query: '云雀',
    from: '2026-10-02T00:00:00.000Z',
    to: '2026-10-02T23:59:59.999Z',
  })
  assert.match(windowed.text, /ev_P2/)
  assert.ok(!windowed.text.includes('ev_P1'))
  assert.ok(!windowed.text.includes('ev_P3'))
}))
