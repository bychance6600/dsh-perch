import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveSelf, recentCountsOf, recencyOf } from '../lib/derive.js'
import { personaLine, recencyLine, forgetLine, FORGET_LINE } from '../lib/persona.js'
import { buildPrompt } from '../lib/channels/router.js'
import { newId } from '../lib/schema.js'

const T0 = Date.parse('2026-11-10T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 造一条最小事件：id 的时间戳与 ts 对齐，derive 的排序/窗口都认它。 */
function ev(at, body) {
  return { id: newId(at), ts: new Date(at).toISOString(), influence: 'constitution', ...body }
}

function said(at, text) {
  return ev(at, { type: 'utterance', text })
}

/** 两条等长（51 字）文本，只共享开头 k+1 个字，即恰好共享 k 个二元组。 */
function pair(k) {
  const chars = Array.from({ length: 220 }, (_, i) => String.fromCodePoint(0x4e00 + i))
  const base = chars.slice(0, k + 1).join('')
  const tailA = chars.slice(100, 100 + 50 - k).join('')
  const tailB = chars.slice(150, 150 + 50 - k).join('')
  return [base + tailA, base + tailB]
}

test('近况四计数：各造最小账本，数字对', () => {
  const events = [
    // 两天前他说了一句，她一直没接 → 1
    ev(T0 - 2 * DAY, { type: 'heard', origin: 'owner', text: '今天早点睡' }),
    // 一天前他说了一句，十分钟后她开口了 → 不算
    ev(T0 - DAY, { type: 'heard', origin: 'owner', text: '你在吗' }),
    said(T0 - DAY + 10 * MIN, '在'),
    // 五分钟前他说了一句，30 分钟还没走完 → 还不能算
    ev(T0 - 5 * MIN, { type: 'heard', origin: 'owner', text: '刚到家' }),
    // 两次说不
    ev(T0 - 3 * DAY, { type: 'refusal', text: '我不想说这个' }),
    ev(T0 - 3 * DAY + MIN, { type: 'refusal', text: '这个我不做' }),
    // 被纠正一次（refuted）；refined 不算
    ev(T0 - 4 * DAY, { type: 'revise', text: '我改口了', verdict: 'refuted', refs: [] }),
    ev(T0 - 4 * DAY + MIN, { type: 'revise', text: '我说得更准一点', verdict: 'refined', refs: [] }),
    // 醒三次（wake:）；sched: 只是当天计划的落点，不算醒
    ev(T0 - 2 * DAY, { type: 'meta', text: 'wake:2026-11-08T08:00:00.000Z' }),
    ev(T0 - DAY, { type: 'meta', text: 'wake:2026-11-09T08:00:00.000Z' }),
    ev(T0 - HOUR, { type: 'meta', text: 'wake:2026-11-10T11:00:00.000Z' }),
    ev(T0 - DAY, { type: 'meta', text: 'sched:2026-11-09' }),
  ]
  assert.deepEqual(recentCountsOf(events, T0), { unanswered: 1, refusals: 2, corrected: 1, wakes: 3 })

  const model = deriveSelf(events, { now: T0 })
  assert.deepEqual(recencyOf(model), { unanswered: 1, refusals: 2, corrected: 1, wakes: 3 })
})

test('只有 sched 没有 wake 时，不算醒过', () => {
  const events = [ev(T0 - DAY, { type: 'meta', text: 'sched:2026-11-09' })]
  assert.equal(recentCountsOf(events, T0).wakes, 0)
})

test('四项全 0 时整句不出现', () => {
  const model = deriveSelf([], { now: T0 })
  assert.equal(recencyLine(model), '')
  assert.equal(personaLine(model, { now: T0 }).includes('最近七天'), false)
})

test('有数字时是陈述句，不带因果词和建议词', () => {
  const events = [
    ev(T0 - 2 * DAY, { type: 'heard', origin: 'owner', text: '今天早点睡' }),
    ev(T0 - 3 * DAY, { type: 'refusal', text: '我不想说这个' }),
    ev(T0 - 4 * DAY, { type: 'revise', text: '我改口了', verdict: 'refuted', refs: [] }),
    ev(T0 - DAY, { type: 'meta', text: 'wake:2026-11-09T08:00:00.000Z' }),
  ]
  const model = deriveSelf(events, { now: T0 })
  const line = recencyLine(model)
  assert.equal(line, '最近七天：他说的有 1 次我没接；我说了 1 次不；被纠正过 1 次；醒过 1 次。')
  for (const word of ['所以', '有点', '因此', '显得', '应该', '你需要']) {
    assert.equal(line.includes(word), false, `近况句不该含「${word}」`)
  }
  assert.equal(personaLine(model, { now: T0 }).includes(line), true)
})

test('折叠话题 Dice 恰在 0.44 不出现、0.46 出现', () => {
  const [topicA, topicB] = pair(22)
  const [topicC] = pair(23)
  // 原话（heard）不是 belief，只在 refs 里被指向：命中必须走 refTexts。
  const old = ev(T0 - 10 * DAY, { type: 'heard', origin: 'owner', text: topicA })
  const events = [
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    ev(T0 - DAY, { type: 'revise', text: '我后来换了说法', verdict: 'refuted', refs: [old.id] }),
    old,
  ]
  const model = deriveSelf(events, { now: T0 })
  assert.equal(forgetLine(model, topicB), '')
  assert.equal(forgetLine(model, topicC), FORGET_LINE)
})

test('折叠话题不命中时那句不出现，belief.text 也能当话题', () => {
  const [topicA, topicB] = pair(23)
  const events = [
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    said(T0 - DAY, topicA),
  ]
  const model = deriveSelf(events, { now: T0 })
  assert.equal(forgetLine(model, topicB), FORGET_LINE)
  assert.equal(forgetLine(model, '完全不相干的一句话'), '')
})

test('纯函数：同样账本 + 同样的话，两次结果完全相同', () => {
  const [topicA, topicB] = pair(23)
  const events = [
    said(T0 - 3 * DAY, '今天风很大'),
    said(T0 - 2 * DAY, '楼下有只猫'),
    said(T0 - DAY, topicA),
  ]
  const a = deriveSelf(events, { now: T0 })
  const b = deriveSelf(events, { now: T0 })
  assert.deepEqual(personaLine(a, { now: T0, message: topicB }), personaLine(b, { now: T0, message: topicB }))
  assert.equal(forgetLine(a, topicB), forgetLine(b, topicB))
})

test('buildPrompt 只在带 forget 时多出那一句', () => {
  const msg = { channel: 'qq', kind: 'private', personName: '他', text: '在吗' }
  const without = buildPrompt(msg, [], { isOwner: true })
  const withLine = buildPrompt(msg, [], { isOwner: true, forget: FORGET_LINE })
  assert.equal(without.includes(FORGET_LINE), false)
  assert.equal(withLine.includes(FORGET_LINE), true)
  // 落在最后一句正前方（在「回不回」之前），离她最近。
  assert.equal(withLine.indexOf(FORGET_LINE) < withLine.indexOf('（回不回'), true)
})
