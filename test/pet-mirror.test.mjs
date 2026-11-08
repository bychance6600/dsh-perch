/**
 * pet-mirror.test.mjs —— 她说过的话变成气泡（2026-11-08，m09369）
 *
 * 守四件事：
 *   1. 只按标点分条，不改字；
 *   2. 同 id + seq 只推一次，一条没 ack 不发下一条；
 *   3. 8 秒没 ack 丢掉，不重发；
 *   4. 叫醒轮里的短句不冒泡。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QUEUE_MAX, SAY_MAX, WAKE_SAY_MIN, createMirror, sayText, splitSay } from '../lib/pet/mirror.js'

const msg = (text) => ({ message: { id: 'm1', content: [{ type: 'text', text }] } })

test('splitSay：按句号问号换行切，标点不动，超长才再切', () => {
  assert.deepEqual(splitSay('在。你来了！'), ['在。', '你来了！'])
  assert.deepEqual(splitSay('第一行\n第二行'), ['第一行', '第二行'])
  assert.deepEqual(splitSay('   '), [])
  const long = '啊'.repeat(SAY_MAX + 10)
  const parts = splitSay(long)
  assert.equal(parts.length, 2)
  assert.equal(parts.join('').length, long.length)
  assert.ok(parts.every((p) => p.length <= SAY_MAX))
})

test('sayText：正文照抄；叫醒轮里短于门槛的不冒泡', () => {
  assert.equal(sayText(msg('我在。')), '我在。')
  assert.equal(sayText(msg('嗯。'), { wakeTurn: true }), '')
  const long = '醒一醒，现在有人叫你了。'
  assert.ok(long.length >= WAKE_SAY_MIN)
  assert.equal(sayText(msg(long), { wakeTurn: true }), long)
})

test('气泡一条一条发：没 ack 不动，同 id + seq 只推一次', () => {
  const sent = []
  const m = createMirror({ send: (x) => { sent.push(x); return true }, ackTimeoutMs: 0 })
  assert.equal(m.push('在。你来了！', { id: 'm1' }), 2)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { t: 'say', id: 'm1', seq: 0, text: '在。', final: false })
  assert.equal(m.stats().queued, 1)

  assert.equal(m.push('在。你来了！', { id: 'm1' }), 0)
  assert.equal(m.ack('m1'), true)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], { t: 'say', id: 'm1', seq: 1, text: '你来了！', final: true })
  assert.equal(m.ack('m1'), true)
  assert.equal(sent.length, 2)
  assert.equal(m.ack('m1'), false)
})

test('8 秒没 ack 就丢掉，接着发下一条（不重发）', async () => {
  const sent = []
  const logs = []
  const m = createMirror({ send: (x) => { sent.push(x); return true }, log: (x) => logs.push(x), ackTimeoutMs: 10 })
  m.push('一。二。', { id: 'm2' })
  assert.equal(sent.length, 1)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].text, '二。')
  assert.ok(logs.some((x) => /没等到 ack/.test(x)))
  m.clear()
})

test('队列满了丢最新的一条，不无限攒', () => {
  const sent = []
  const logs = []
  const m = createMirror({ send: (x) => { sent.push(x); return true }, log: (x) => logs.push(x), ackTimeoutMs: 0 })
  const text = Array.from({ length: QUEUE_MAX + 5 }, (_, i) => '第' + i + '句。').join('')
  m.push(text, { id: 'm3' })
  // 一条在途，QUEUE_MAX 条在队里；再来的都丢。
  // 20 条封顶：一条在途，19 条在队里。
  assert.equal(m.stats().queued, QUEUE_MAX - 1)
  assert.ok(m.stats().seen <= QUEUE_MAX)
  assert.ok(logs.some((x) => /队列满了/.test(x)))
  m.clear()
})
