/**
 * 主包的抖音**材料**适配器（2026-11-06）
 *
 * 只测「主包有没有把子包的传输层接对」：起停、同源起点、只读接口、推荐流。
 * 私信那套（会话、去重、WS 帧）已经不在这里了——删掉的东西用「没有 send /
 * 没有 onMessage」两条断言钉住，防止以后又被接回来。
 *
 * 子包本身（浏览器、CDP）不在这里测——它有自己的测试。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { create } from '../lib/channels/douyin.js'

function fakeTransport(record = {}) {
  return {
    async launch() { record.launched = (record.launched ?? 0) + 1; return { ok: true } },
    async navigate(url) { record.navigated = url },
    async evaluate(expr, opts) {
      record.expr = expr
      record.awaitPromise = opts?.awaitPromise
      return { ok: true, value: record.payload ?? '{"status_code":0}' }
    },
    async close() { record.closed = true },
  }
}

function factory(record, payload) {
  return async (opts) => {
    record.opts = opts
    if (payload !== undefined) record.payload = payload
    return fakeTransport(record)
  }
}

test('抖音材料层：配置翻成传输层要的形状，profile 落在数据目录里', async () => {
  const record = {}
  const a = create({
    root: 'C:/data',
    config: { channels: { douyin: { browserPath: 'C:/Edge/msedge.exe' } } },
    transport: factory(record),
  })
  const started = await a.start()
  assert.equal(started.ok, true)
  assert.equal(record.opts.browserPath, 'C:/Edge/msedge.exe')
  assert.match(record.opts.profileDir, /douyin-profile$/)
  assert.equal(record.launched, 1)
})

test('抖音材料层：浏览器路径也可以从「刷抖音」那边读', async () => {
  const record = {}
  const a = create({
    root: 'C:/data',
    config: { browse: { douyin: { browserPath: 'D:/Chrome/chrome.exe' } } },
    transport: factory(record),
  })
  await a.start()
  assert.equal(record.opts.browserPath, 'D:/Chrome/chrome.exe')
})

test('抖音材料层：首页地址去掉空格再打开；没填就停在抖音首页', async () => {
  const record = {}
  const a = create({
    root: 'C:/data',
    config: { channels: { douyin: { homeUrl: '  https://www.douyin.com/?recommend=1  ' } } },
    transport: factory(record),
  })
  await a.start()
  assert.equal(record.navigated, 'https://www.douyin.com/?recommend=1')

  const record2 = {}
  const b = create({ root: 'C:/data', config: {}, transport: factory(record2) })
  await b.start()
  assert.match(record2.navigated, /^https:\/\/www\.douyin\.com\//)
})

test('抖音材料层：只有一块浏览器，不接消息、不发消息（私信已删）', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, transport: factory(record) })
  await a.start()
  assert.equal(a.send, undefined, '材料层不该有 send：这里没有会话')
  assert.equal(a.onMessage, undefined, '材料层不该订阅入站消息：私信已删')
})

test('抖音材料层：重复 start 不重复拉浏览器', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, transport: factory(record) })
  await a.start()
  await a.start()
  assert.equal(record.launched, 1)
})

test('抖音材料层：没装子包时安静地失败，不抛异常', async () => {
  const a = create({ root: 'C:/data', config: {}, transport: async () => null })
  const started = await a.start()
  assert.equal(started.ok, false)
  assert.match(String(started.why), /子包|douyin/i)
})

test('抖音材料层：浏览器没拉起来就如实说，下次还能再试', async () => {
  let n = 0
  const a = create({
    root: 'C:/data',
    config: {},
    transport: async () => ({
      async launch() { n += 1; return { ok: false, why: '没找到 Edge 或 Chrome' } },
      async close() {},
    }),
  })
  const first = await a.start()
  assert.equal(first.ok, false)
  assert.match(first.why, /Edge/)
  assert.equal(a.status().connected, false)
  assert.equal(a.status().lastError, first.why)
  await a.start()
  assert.equal(n, 2, '失败之后 transport 要丢掉，下一次重新试')
})

test('抖音材料层：读只读接口要等 Promise，不然拿回的是 "{}"', async () => {
  const record = { payload: '{"status_code":0}' }
  const a = create({ root: 'C:/data', config: {}, transport: factory(record) })
  await a.start()
  const r = await a.api('/aweme/v1/web/aweme/detail/?aweme_id=1')
  assert.equal(record.awaitPromise, true)
  assert.equal(r.ok, true)
  assert.equal(r.data.status_code, 0)
})

test('抖音材料层：只收站内路径，整条 URL 不接', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, transport: factory(record) })
  await a.start()
  const r = await a.api('https://www.douyin.com/aweme/v1/x')
  assert.equal(r.ok, false)
  assert.match(String(r.why), /站内/)
})

test('抖音材料层：没起来的时候 api 直接说没开，不假装成功', async () => {
  const a = create({ root: 'C:/data', config: {}, transport: async () => null })
  const r = await a.api('/aweme/v1/web/aweme/detail/?aweme_id=1')
  assert.equal(r.ok, false)
  assert.match(String(r.why), /没开|子包|douyin/i)
})

test('抖音材料层：推荐流走 tab/feed，带 cookie、等 Promise，只回她用得上的字段', async () => {
  const record = {
    payload: JSON.stringify({ aweme_list: [
      { aweme_id: '701', desc: '一条讲徒步的视频', author: { nickname: '行者' }, statistics: { digg_count: 12 } },
      { aweme_id: '702', desc: '' },
    ] }),
  }
  const a = create({ root: 'C:/data', config: {}, transport: factory(record) })
  await a.start()
  const r = await a.feed({ count: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].id, '701')
  assert.equal(r.items[0].author, '行者')
  assert.match(record.expr, /aweme\/v1\/web\/tab\/feed\/\?.*count=5/)
  assert.equal(record.awaitPromise, true)
})

test('抖音材料层：推荐流是空的就说空的，不编', async () => {
  const a = create({ root: 'C:/data', config: {}, transport: factory({ payload: '{"aweme_list":[]}' }) })
  await a.start()
  const r = await a.feed()
  assert.equal(r.ok, false)
  assert.match(r.why, /空/)
})

test('抖音材料层：stop 关掉浏览器，状态回到未连接', async () => {
  const record = {}
  const a = create({ root: 'C:/data', config: {}, transport: factory(record) })
  await a.start()
  assert.equal(a.status().connected, true)
  await a.stop()
  assert.equal(record.closed, true)
  assert.equal(a.status().connected, false)
})
