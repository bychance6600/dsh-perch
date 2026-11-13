import test from 'node:test'
import assert from 'node:assert/strict'
import { redact, clip, sampleDay, reviewSheet, seedTimeOf } from '../tools/sample.mjs'

const T0 = Date.parse('2026-11-02T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function ev(id, ts, type, text, extra = {}) {
  return { id, v: 1, ts: new Date(ts).toISOString(), type, source: type === 'heard' ? 'system' : 'tool', text, ...extra }
}

test('redact 抹掉链接、@、长数字', () => {
  const out = redact('看这个 https://example.com/a?b=1 和 @雪兔子 还有 13800138000 / 123456')
  assert.ok(!out.includes('https://'), out)
  assert.ok(!out.includes('@雪兔子'), out)
  assert.ok(out.includes('@某人'), out)
  assert.ok(!/\d{5,}/.test(out), out)
  assert.ok(out.includes('[链接]'), out)
})

test('redact 保留普通句子与短数字', () => {
  assert.equal(redact('我今天数了 3 次。'), '我今天数了 3 次。')
})

test('clip 截断落在句号后，不切半个词', () => {
  const long = '第一句。第二句。' + '很长的一段话'.repeat(40)
  const out = clip(long, 20)
  assert.ok(out.length <= 21, out)
  assert.ok(out.endsWith('。') || out.endsWith('…'), out)
})

test('seedTimeOf 取 seed 的时间', () => {
  const events = [ev('ev_seed', T0, 'seed', '你刚开始存在。')]
  assert.equal(seedTimeOf(events), T0)
})

test('切到第 1 天：只留她的话，heard 不进样片', () => {
  const events = [
    ev('ev_seed', T0, 'seed', '你刚开始存在。'),
    ev('ev_h1', T0 + 1000, 'heard', '他说的这句话不该出现在样片里', { origin: 'owner' }),
    ev('ev_u1', T0 + 2000, 'utterance', '我说的第一句话。'),
    ev('ev_u2', T0 + DAY + 5000, 'utterance', '第二天才说的，不该进第一天'),
  ]
  const d = sampleDay(events, 1, T0)
  const all = JSON.stringify(d)
  assert.ok(!all.includes('不该出现在样片里'), 'heard 泄漏进了样片')
  assert.ok(!all.includes('第二天才说的'), '第二天的句子进了第一天')
  assert.ok(d.today.some((t) => t.includes('第一句话')), JSON.stringify(d.today))
  assert.equal(d.day, 1)
  assert.equal(d.counts.events, 3)
})

test('改口链两边都是她的话，且只到切片那天', () => {
  const events = [
    ev('ev_seed', T0, 'seed', '你刚开始存在。'),
    ev('ev_u1', T0 + 1000, 'utterance', '我原先这么想。'),
    ev('ev_r1', T0 + 2000, 'revise', '我改口了。', { refs: ['ev_u1'], verdict: 'refuted' }),
    ev('ev_r2', T0 + 10 * DAY, 'revise', '很久以后的改口。', { refs: ['ev_u1'], verdict: 'refuted' }),
  ]
  const d = sampleDay(events, 1, T0)
  assert.equal(d.revised.length, 1, JSON.stringify(d.revised))
  assert.ok(d.revised[0].before.includes('原先'))
})

test('审阅表逐条编号，判断与改口都在', () => {
  const days = [
    { day: 1, beliefs: [{ text: '甲' }, { text: '乙' }], revised: [{ before: '旧', after: '新' }] },
    { day: 7, beliefs: [{ text: '丙' }], revised: [] },
  ]
  const sheet = reviewSheet(days)
  assert.ok(sheet.includes('1. [第 1 天·判断] 「甲」'), sheet)
  assert.ok(sheet.includes('3. [第 1 天·改口] 「旧」→「新」'), sheet)
  assert.ok(sheet.includes('4. [第 7 天·判断] 「丙」'), sheet)
})
