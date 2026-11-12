/**
 * data-stats.test.mjs —— 数据页的三个数字（2026-11-12）
 *
 * 守两条：
 *   1. `/data` 真的返回账本条数、上次重放毫秒、目录字节数，且都是数字；
 *   2. 目录占用有 60 秒缓存——刚写过文件也不会立刻重新翻全树，测试要能强制重算。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerObserve, dirSize } from '../lib/observe.js'
import { appendEvent } from '../lib/store.js'
import { lastReplayAt, resetReplayStat } from '../lib/replaystat.js'

async function tempRoot(prefix) {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** 极简假 ctx：只提供 observe 注册与信任栅栏需要的东西。 */
function fakeCtx(root) {
  const routes = []
  const cfg = { connection: { requestRejection: () => null } }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
    root,
  }
}

function callRoute(route) {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(code) { this.code = code },
      end(body) { resolve({ code: this.code, body: JSON.parse(body) }) },
    }
    Promise.resolve(route.handler({ method: 'GET', url: '/dsh-perch/data', headers: {} }, res)).catch(reject)
  })
}

test('/data 返回账本条数、上次重放毫秒、目录字节数', async () => {
  const root = await tempRoot('fish-data-')
  try {
    resetReplayStat()
    const ctx = fakeCtx(root)
    registerObserve(ctx, { root })
    for (const text of ['一', '二', '三']) {
      await appendEvent({ type: 'utterance', text }, { source: 'system' }, root)
    }
    const route = ctx.routes.find((r) => String(r.path || '').endsWith('/data'))
    assert.ok(route, '必须有 /data 路由')
    const { code, body } = await callRoute(route)
    assert.equal(code, 200)
    assert.equal(body.events, 3, '三行事件就是三条')
    assert.ok(Number.isInteger(body.replayMs) && body.replayMs >= 0, '重放耗时应是非负整数')
    assert.ok(lastReplayAt() > 0, '/data 先于 /state 打开时也要补一次重放，不能永远显示「—」')
    assert.ok(body.bytes > 0, '目录里有文件，占用不应是 0')
    // 只读：POST 要被挡掉
    const bad = await new Promise((resolve) => {
      let status = 0
      const res = { writeHead(code) { status = code }, end() { resolve(status) } }
      route.handler({ method: 'POST', url: '/dsh-perch/data', headers: {} }, res)
    })
    assert.equal(bad, 405)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('dirSize 默认缓存 60 秒，ttl=0 时才重算', async () => {
  const root = await tempRoot('fish-size-')
  try {
    await writeFile(join(root, 'a.bin'), Buffer.alloc(1000))
    const first = await dirSize(root)
    assert.equal(first, 1000)
    await writeFile(join(root, 'b.bin'), Buffer.alloc(5000))
    assert.equal(await dirSize(root), first, '缓存期内不该重算')
    const fresh = await dirSize(root, { ttlMs: 0 })
    assert.equal(fresh, 6000, '强制重算要看见新文件')
    // 子目录里的文件也算
    await mkdir(join(root, 'diary'))
    await writeFile(join(root, 'diary', 'day.md'), Buffer.alloc(123))
    assert.equal(await dirSize(root, { ttlMs: 0 }), 6123)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
