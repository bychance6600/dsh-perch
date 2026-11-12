/**
 * router-forget-cache.test.mjs —— 路由 60 秒遗忘缓存的性质断言
 *
 * 只有带 --experimental-test-module-mocks 时才跑：要给 deriveSelf 打桩计数，
 * 普通全量测试里 mock.module 不存在，整条 skip（不增红）。
 *
 * 运行：
 *   node --test --test-isolation=none --experimental-test-module-mocks test/router-forget-cache.test.mjs
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const canMock = process.env.DSH_ACCEPTANCE_MODULE_MOCKS === '1' && typeof mock.module === 'function'

test('同一账本一分钟内连发两条消息，deriveSelf 只被调用一次', { skip: canMock ? false : '需 --experimental-test-module-mocks 与 DSH_ACCEPTANCE_MODULE_MOCKS=1' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fish-forget-cache-'))
  const actual = await import('../lib/derive.js')
  let calls = 0
  const namedExports = { ...actual }
  namedExports.deriveSelf = (...args) => {
    calls++
    return actual.deriveSelf(...args)
  }
  mock.module('../lib/derive.js', { namedExports })

  const { createRouter } = await import('../lib/channels/router.js')
  const { createJournal } = await import('../lib/journal.js')
  const { createPeople } = await import('../lib/people.js')

  const handlers = []
  const sc = {
    async prompt(req) {
      setImmediate(() => {
        for (const h of handlers) {
          if (h.name !== 'session/event') continue
          const session = { header: { id: req.sessionId } }
          h.fn(session, {
            type: 'assistant/message',
            data: { message: { id: 'm1', content: [{ type: 'text', text: '嗯。' }] } },
          })
          h.fn(session, { type: 'turn/end', data: {} })
        }
      })
    },
  }
  const ctx = {
    on: (name, fn) => {
      handlers.push({ name, fn })
      return () => {}
    },
    get: () => sc,
  }
  const sent = []
  const adapter = {
    name: 'qq',
    onMessage: () => () => {},
    async start() { return { ok: true } },
    async stop() {},
    async send(m) { sent.push(m); return { ok: true } },
    status: () => ({ ok: true, connected: true }),
  }
  const router = createRouter({
    ctx,
    root,
    journal: createJournal(root),
    people: createPeople(root),
    ownerIds: { qq: '42' },
    adapters: new Map([['qq', adapter]]),
    getConfig: async () => ({ channels: { qq: { enabled: true, replyInGroup: true } } }),
    getState: async () => ({ sessionId: 's1', stage: 3 }),
    now: () => Date.parse('2026-11-10T12:00:00.000Z'),
  })
  await router.start()
  const msg = {
    channel: 'qq', kind: 'dm', conversationId: 'c1',
    personId: '42', personName: '他', text: '在吗', images: [],
    at: Date.parse('2026-11-10T12:00:00.000Z'),
  }
  const first = await router.handle(msg)
  const second = await router.handle({ ...msg, text: '还在吗', at: msg.at + 1000 })
  assert.equal(first.sent, true)
  assert.equal(second.sent, true)
  assert.equal(sent.length, 2)
  assert.equal(calls, 1, '第二条应命中 60 秒缓存，deriveSelf 不应再跑')
  await fs.rm(root, { recursive: true, force: true })
})
