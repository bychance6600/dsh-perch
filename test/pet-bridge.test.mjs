/**
 * pet-bridge.test.mjs —— v1 协议（2026-11-08，m09369）
 *
 * 不 spawn：用一对 PassThrough 假装 body 的 stdout/stdin。
 * 协议唯一来源：https://github.com/bychance6600/dsh-roost-pet/blob/main/docs/protocol.md
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_LINE_BYTES, PROTOCOL_VERSION, createBridge } from '../lib/pet/bridge.js'
import { fakeBody } from './fixtures/fake-body.mjs'

function connect(o = {}) {
  const body = fakeBody({ pet: '假桌宠' })
  const events = { hello: [], input: [], ack: [], log: [], selfLog: [], bye: 0, close: [] }
  const bridge = createBridge({
    readable: body.readable,
    writable: body.writable,
    helloTimeoutMs: 0,
    ...o,
    log: (x) => { events.selfLog.push(x); o.log?.(x) },
    onHello: (x) => { events.hello.push(x); o.onHello?.(x) },
    onInput: (x) => { events.input.push(x); o.onInput?.(x) },
    onAck: (x) => { events.ack.push(x); o.onAck?.(x) },
    onLog: (x) => { events.log.push(x); o.onLog?.(x) },
    onBye: () => { events.bye += 1; o.onBye?.() },
    onClose: (why) => { events.close.push(why); o.onClose?.(why) },
  })
  return { body, bridge, events }
}

test('一建桥就先发 hello；body 回 hello 后算连上', () => {
  const { body, bridge, events } = connect()
  const first = body.read()
  assert.deepEqual(first, { t: 'hello', v: PROTOCOL_VERSION, roost: '0.1.0' })
  assert.equal(bridge.connected, false)
  body.hello()
  assert.equal(bridge.connected, true)
  assert.deepEqual(events.hello, [{ body: '0.0.0', pet: '假桌宠' }])
  assert.equal(bridge.hello.pet, '假桌宠')
})

test('input 原文不 trim，先回调再立刻 ack', () => {
  const { body, bridge, events } = connect()
  body.hello()
  body.read()
  body.input('i1', '  你好  ')
  assert.deepEqual(events.input, [{ id: 'i1', text: '  你好  ' }])
  assert.deepEqual(body.read(), { t: 'ack', id: 'i1' })
  assert.equal(bridge.acked('i1'), true)
})

test('poke 只给坐标；ack / log / bye 分开回调', () => {
  const { body, bridge, events } = connect()
  body.hello()
  body.read()
  body.poke(12.5, 3)
  assert.deepEqual(events.input.at(-1), { id: '', text: '', poke: { x: 12.5, y: 3 } })

  body.ack('m1')
  assert.deepEqual(events.ack, [{ id: 'm1' }])
  body.say('m1', '在。')
  // say 在 v1 里只由 roost 发；body 发过来不算，桥照旧只当未知消息。
  assert.equal(events.close.length, 0)
  assert.equal(bridge.connected, true)
})

test('坏 JSON、没 t、不认识的 t 都丢掉，桥不崩', () => {
  const { body, bridge, events } = connect()
  body.hello()
  body.read()
  body.readable.write('{不是 json}\n')
  body.readable.write(JSON.stringify({ x: 1 }) + '\n')
  body.readable.write(JSON.stringify({ t: 'nope' }) + '\n')
  body.input('i2', '还在')
  assert.deepEqual(events.input.at(-1), { id: 'i2', text: '还在' })
  assert.equal(events.close.length, 0)
  assert.equal(bridge.connected, true)
  assert.ok(events.selfLog.some((x) => /坏 JSON/.test(x)))
  assert.ok(events.selfLog.some((x) => /没有 t/.test(x)))
  assert.ok(events.selfLog.some((x) => /不认识/.test(x)))
})

test('一行超过 16KB 丢掉，不会把下一行吃掉', () => {
  const { body, bridge, events } = connect()
  body.hello()
  body.read()
  body.readable.write('x'.repeat(MAX_LINE_BYTES + 1) + '\n')
  body.input('i3', '下一行还在')
  assert.deepEqual(events.input.at(-1), { id: 'i3', text: '下一行还在' })
  assert.ok(events.selfLog.some((x) => /超过 16KB/.test(x)))
  assert.equal(bridge.connected, true)
})

test('一行分两次到也能拼起来；bye 之后关闭', () => {
  const { body, bridge, events } = connect()
  body.hello()
  body.read()
  const line = JSON.stringify({ t: 'input', id: 'i4', text: '分片' })
  body.readable.write(line.slice(0, 5))
  body.readable.write(line.slice(5) + '\n')
  assert.deepEqual(events.input.at(-1), { id: 'i4', text: '分片' })
  body.bye()
  assert.equal(events.bye, 1)
  assert.equal(bridge.closed, true)
  assert.equal(bridge.send({ t: 'state', state: 'waiting' }), false)
})

test('10 秒没握手就关；关掉后不再写', async () => {
  const body = fakeBody()
  const closes = []
  const bridge = createBridge({ readable: body.readable, writable: body.writable, helloTimeoutMs: 20, onClose: (w) => closes.push(w) })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(bridge.closed, true)
  assert.equal(bridge.connected, false)
  assert.equal(closes.length, 1)
  assert.match(closes[0], /没握手/)
  assert.equal(bridge.send({ t: 'state', state: 'waiting' }), false)
})
