/**
 * acceptance-0.2.0.test.mjs —— 0.2.0 六项机制的验收边界（本地、合成、不碰真账本）
 *
 * 这里只钉「边界」与「性质」：真账本的矩阵与旧版本对照在 tools/acceptance-0.2.0.mjs。
 * 合成事件全在临时账本里，不写 ~/.dsh-perch。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveSelf,
  recentCountsOf,
  recencyOf,
  similarity,
  RECENT_REPLY_MS,
  RECENT_WINDOW_DAYS,
} from '../lib/derive.js'
import {
  FORGET_LINE,
  FORGET_MATCH_MIN,
  forgetLine,
  personaLine,
  recencyLine,
} from '../lib/persona.js'
import { searchEvents } from '../lib/recall.js'
import { newId } from '../lib/schema.js'

const T0 = Date.parse('2026-11-10T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function ev(at, body) {
  return { id: newId(at), ts: new Date(at).toISOString(), influence: 'constitution', ...body }
}

function said(at, text) {
  return ev(at, { type: 'utterance', text })
}

/**
 * 两条等长（101 字）文本，只共享开头 k+1 个字，即恰好共享 k 个二元组。
 * Dice = 2k/(100+100) = k/100，所以 k=44/45/46 就是 0.44/0.45/0.46。
 */
function longPair(k) {
  const chars = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i))
  const base = chars.slice(0, k + 1).join('')
  const tail = 100 - k
  return [base + chars.slice(200, 200 + tail).join(''), base + chars.slice(300, 300 + tail).join('')]
}

test('近况 unanswered：30 分钟窗口卡在 29:59 / 30:00 / 30:01', () => {
  const heard = (before) => [
    ev(T0 - before, { type: 'heard', origin: 'owner', text: '在吗' }),
  ]
  assert.equal(recentCountsOf(heard(30 * MIN - 1000), T0).unanswered, 0)
  assert.equal(recentCountsOf(heard(30 * MIN), T0).unanswered, 1)
  assert.equal(recentCountsOf(heard(30 * MIN + 1000), T0).unanswered, 1)
})

test('近况 unanswered：29:59 内她接上了，就不算', () => {
  const t = T0 - 31 * MIN
  const events = [
    ev(t, { type: 'heard', origin: 'owner', text: '在吗' }),
    said(t + 29 * MIN + 59_000, '在'),
  ]
  assert.equal(recentCountsOf(events, T0).unanswered, 0)
})

test('近况 7 天窗口卡在第 6 天 23:59 / 第 7 天 00:00 / 00:01', () => {
  const caseAt = (before) => {
    const events = [ev(T0 - before, { type: 'heard', origin: 'owner', text: '在吗' })]
    return recentCountsOf(events, T0)
  }
  assert.equal(caseAt(6 * DAY + 23 * HOUR + 59 * MIN).unanswered, 1)
  assert.equal(caseAt(7 * DAY).unanswered, 1) // 实现取闭区间：正好 7 天仍算在窗内
  assert.equal(caseAt(7 * DAY + MIN).unanswered, 0)
  assert.equal(RECENT_WINDOW_DAYS, 7)
  assert.equal(RECENT_REPLY_MS, 30 * MIN)
})

test('近况四项全 0：整句不出现，提示词里没有「最近七天」', () => {
  const model = deriveSelf([], { now: T0 })
  assert.deepEqual(recencyOf(model), { unanswered: 0, refusals: 0, corrected: 0, wakes: 0 })
  assert.equal(recencyLine(model), '')
  const text = personaLine(model, { now: T0 })
  assert.equal(text.includes('最近七天'), false)
})

test('近况只写陈述句：不含因果词与建议词', () => {
  const events = [
    ev(T0 - 2 * DAY, { type: 'heard', origin: 'owner', text: '早点睡' }),
    ev(T0 - 3 * DAY, { type: 'refusal', text: '我不想说' }),
    ev(T0 - 4 * DAY, { type: 'revise', text: '我改口了', verdict: 'refuted', refs: [] }),
    ev(T0 - HOUR, { type: 'meta', text: 'wake:2026-11-10T11:00:00.000Z' }),
  ]
  const line = recencyLine(deriveSelf(events, { now: T0 }))
  assert.equal(line, '最近七天：他说的有 1 次我没接；我说了 1 次不；被纠正过 1 次；醒过 1 次。')
  for (const word of ['所以', '因此', '应该', '你需要', '别']) {
    assert.equal(line.includes(word), false, line + ' 不该含「' + word + '」')
  }
})

test('遗忘阈值：Dice 0.44 不命中，0.45 与 0.46 命中', () => {
  for (const k of [44, 45, 46]) {
    const [topicA, topicB] = longPair(k)
    assert.equal(Number(similarity(topicA, topicB).toFixed(2)), k / 100, String(k))
    const old = ev(T0 - 10 * DAY, { type: 'heard', origin: 'owner', text: topicA })
    const model = deriveSelf([
      said(T0 - 3 * DAY, '今天风很大'),
      said(T0 - 2 * DAY, '楼下有只猫'),
      ev(T0 - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
      old,
    ], { now: T0 })
    const got = forgetLine(model, topicB)
    if (k === 44) assert.equal(got, '', '0.44 必须不命中')
    else assert.equal(got, FORGET_LINE, String(k))
  }
  assert.equal(FORGET_MATCH_MIN, 0.45)
})

test('遗忘命中只回一句：不列条数、不列清单、不复读旧话', () => {
  const [topicA, topicB] = longPair(46)
  const old = ev(T0 - 10 * DAY, { type: 'heard', origin: 'owner', text: topicA })
  const model = deriveSelf([
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    ev(T0 - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
    old,
  ], { now: T0 })
  const line = forgetLine(model, topicB)
  assert.equal(line, FORGET_LINE)
  assert.equal(line.split('。').filter(Boolean).length, 1)
  assert.equal(line.includes(topicA), false)
  assert.equal(/[0-9０-９一二三四五六七八九十]+\s*条/.test(line), false)
  assert.equal(line.includes('\n'), false)
})

test('遗忘不命中返回空串', () => {
  const [topicA] = longPair(46)
  const old = ev(T0 - 10 * DAY, { type: 'heard', origin: 'owner', text: topicA })
  const model = deriveSelf([
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    ev(T0 - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
    old,
  ], { now: T0 })
  assert.equal(forgetLine(model, '完全不相干的一句话'), '')
  assert.equal(forgetLine(model, ''), '')
})

test('遗忘的 refTexts 超过 200 字时被截断', () => {
  const chars = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i))
  const longText = chars.slice(0, 300).join('')
  const old = ev(T0 - 10 * DAY, { type: 'heard', origin: 'owner', text: longText })
  const model = deriveSelf([
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    ev(T0 - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
    old,
  ], { now: T0 })
  const b = (model.beliefs ?? []).find((x) => Array.isArray(x.refTexts) && x.refTexts.length)
  assert.ok(b, '应有带 refTexts 的判断')
  assert.equal(b.refTexts[0].length, 200)
  assert.equal(b.refTexts[0], longText.slice(0, 200))
})

test('遗忘纯函数：同样账本 + 同样的话，两次结果完全相同', () => {
  const [topicA, topicB] = longPair(45)
  const old = ev(T0 - 10 * DAY, { type: 'heard', origin: 'owner', text: topicA })
  const events = [
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    ev(T0 - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
    old,
  ]
  const a = deriveSelf(events, { now: T0 })
  const b = deriveSelf(events, { now: T0 })
  assert.equal(forgetLine(a, topicB), FORGET_LINE)
  assert.equal(forgetLine(a, topicB), forgetLine(b, topicB))
  assert.equal(personaLine(a, { now: T0, message: topicB }), personaLine(b, { now: T0, message: topicB }))
})

test('时间区间是闭区间：正好等于事件时刻命中，差 1 毫秒不命中', () => {
  const e = ev(T0, { type: 'utterance', text: '边界词' })
  const run = (o) => searchEvents([e], '边界词', { mode: 'literal', now: T0, limit: 8, ...o })
  assert.equal(run({ from: T0, to: T0 }).rows.length, 1)
  assert.equal(run({ from: T0, to: new Date(T0).toISOString() }).rows.length, 1)
  assert.equal(run({ from: T0 + 1, to: T0 + 2 }).rows.length, 0)
  assert.equal(run({ from: T0 - 2, to: T0 - 1 }).rows.length, 0)
})

test('ranked 关掉 links 时不带邻居；打开时链接把不匹配的邻居带出来', () => {
  const a = said(T0 - 2 * DAY, '我想学会不逃开')
  // b 不含 query 词，只能靠 a 的显式 refs 边被带出来。
  const b = ev(T0 - DAY, { type: 'test', text: '今天风很大', refs: [a.id] })
  const q = '逃开'
  const off = searchEvents([a, b], q, { mode: 'ranked', links: false, now: T0 }).rows
  assert.deepEqual(off.map((r) => r.id), [a.id])
  const on = searchEvents([a, b], q, { mode: 'ranked', links: true, now: T0 }).rows
  assert.deepEqual(on.map((r) => r.id), [a.id, b.id])
})
