import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  FEED_PATH,
  feedScript,
  normalizeFeed,
  normalizeSearch,
  renderFeed,
  seenToday,
  lookFeedOnce,
  normalizeHot,
  renderHot,
  hotLine,
  hotCountToday,
  lookHotOnce,
  normalizeComments,
  renderComments,
} from '../lib/douyinlook.js'

const FEED = {
  aweme_list: [
    { aweme_id: '7700000000000000001', desc: '原声版来了 美式真的很生气', author: { nickname: '小满' }, video: { duration: 18200 }, statistics: { digg_count: 28000 } },
    { aweme_id: '7700000000000000002', desc: '徒步第 300 天', author: { nickname: '卡尔' }, video: { duration: 60000 }, statistics: { digg_count: 800 } },
    { desc: '没有 id 的那条不该出现' },
  ],
}

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyfeed-'))
  return dir
}

function fakeTransport(payload, { startOk = true, evalFail = false } = {}) {
  return {
    state: { navigated: '', closed: false, calls: 0 },
    async start() { return startOk ? { ok: true } : { ok: false, why: '起不来' } },
    async navigate(url) { this.state.navigated = url; return { ok: true } },
    async evaluate(expr, opts) {
      this.state.calls += 1
      this.state.awaitPromise = opts?.awaitPromise
      if (evalFail) return { ok: false, why: '没回话' }
      return { ok: true, value: typeof payload === 'string' ? payload : JSON.stringify(payload) }
    },
    async close() { this.state.closed = true; return { ok: true } },
  }
}

const cfgOn = { channels: { douyin: { enabled: true, homeUrl: '' } }, browse: { douyin: { enabled: true, topN: 6 } } }
const cfgOff = { channels: { douyin: { enabled: false } }, browse: { douyin: { enabled: false } } }

test('normalizeFeed：只收有 id 的，字段齐全', () => {
  const items = normalizeFeed(FEED)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, '7700000000000000001')
  assert.equal(items[0].author, '小满')
  assert.equal(items[0].duration, 18)
  assert.equal(items[0].likes, 28000)
})

test('normalizeFeed：不是 JSON 就当没拿到', () => {
  assert.deepEqual(normalizeFeed('<html>login</html>'), [])
  assert.deepEqual(normalizeFeed(''), [])
  assert.deepEqual(normalizeFeed({}), [])
})

test('renderFeed：一条一行，带作者/时长/赞', () => {
  const text = renderFeed(normalizeFeed(FEED))
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /美式真的很生气/)
  assert.match(lines[0], /小满/)
  assert.match(lines[0], /18 秒/)
  assert.match(lines[0], /2\.8 万 赞/)
})

test('feedScript：带上条数与只读接口，且不拼签名', () => {
  const s = feedScript(4)
  assert.match(s, /tab\/feed/)
  assert.match(s, /count=4/)
  assert.match(s, /credentials:'include'/)
  assert.doesNotMatch(s, /X-Bogus|a_bogus/)
})

test('seenToday：只认当天的 dyfeed 记账', () => {
  const events = [
    { type: 'meta', text: 'dyfeed:2026-11-04 7700000000000000001' },
    { type: 'meta', text: 'dyfeed:2026-11-03 7700000000000000002' },
    { type: 'meta', text: 'looked:BV1xx411c7mD' },
  ]
  const got = seenToday(events, '2026-11-04')
  assert.equal(got.size, 1)
  assert.ok(got.has('7700000000000000001'))
})

test('开关都没开：不拉浏览器，直说没开', async () => {
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOff })
  assert.equal(r.ok, false)
  assert.match(r.note, /没开/)
})

test('翻到了：返回素材，并记住今天翻过哪几条', async () => {
  const root = tmpRoot()
  const t = fakeTransport(FEED)
  const r = await lookFeedOnce({ root, cfg: cfgOn, transport: t, waitMs: 0 })
  assert.equal(r.ok, true)
  assert.match(r.text, /徒步第 300 天/)
  assert.equal(t.state.navigated, 'https://www.douyin.com/?recommend=1')
  assert.equal(t.state.awaitPromise, true)
  assert.equal(t.state.closed, true)

  const lines = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n')
  const meta = lines.map((l) => JSON.parse(l)).find((e) => String(e.text).startsWith('dyfeed:'))
  assert.ok(meta, '应该记一条 dyfeed')
  assert.match(meta.text, /7700000000000000001/)
})

test('同一天再翻：翻到的都见过了，不重复端上来', async () => {
  const root = tmpRoot()
  await lookFeedOnce({ root, cfg: cfgOn, transport: fakeTransport(FEED), waitMs: 0 })
  const r = await lookFeedOnce({ root, cfg: cfgOn, transport: fakeTransport(FEED), waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.note, /看过/)
})

test('抖音没给数据：不瞎编，直说没给', async () => {
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport('<html></html>'), waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.note, /没给/)
})

test('浏览器起不来 / 页面不回话：各有各的说法', async () => {
  const a = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport(FEED, { startOk: false }), waitMs: 0 })
  assert.equal(a.ok, false)
  assert.match(a.note, /起不来/)

  const b = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport(FEED, { evalFail: true }), waitMs: 0 })
  assert.equal(b.ok, false)
  assert.match(b.note, /没回话/)
})

test('注册的工具名与说明', async () => {
  const { registerDouyinLook } = await import('../lib/douyinlook.js')
  const regs = []
  const ctx = { tools: { register: (t) => { regs.push(t); return t } } }
  registerDouyinLook(ctx, { root: tmpRoot() })
  assert.equal(regs.length, 1)
  assert.equal(regs[0].name, 'douyin_look')
  assert.match(regs[0].description, /推荐流/)
  assert.match(regs[0].description, /按这个词去找/)
  assert.match(regs[0].description, /截三帧/)
  assert.match(regs[0].description, /index/)
})

test('按词找：走搜索页，从真实链接里抠 id 与文案', () => {
  const raw = JSON.stringify([
    { href: '//www.douyin.com/video/7683459070586405787', txt: '合集 03:27 4.2万 新手徒步入门指南！小白必看' },
    { href: '//www.douyin.com/video/7703602183127797026', txt: '03:43 262.2万 世界首位徒步绕地球一圈的狠人' },
    { href: '//www.douyin.com/video/7683459070586405787', txt: '重复的那条' },
    { href: '//www.douyin.com/user/abc', txt: '不是视频' },
  ])
  const items = normalizeSearch(raw)
  assert.equal(items.length, 2)
  assert.equal(items[0].id, '7683459070586405787')
  assert.ok(items[0].desc.startsWith('新手徒步入门指南'))
  assert.ok(items[1].desc.startsWith('世界首位徒步绕地球一圈'))
})

test('按词找：走到搜索页，而不是推荐页', async () => {
  const t = fakeTransport(JSON.stringify([
    { href: '//www.douyin.com/video/7703602183127797026', txt: '03:43 262.2万 世界首位徒步绕地球一圈的狠人' },
  ]))
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: t, keyword: '徒步', waitMs: 0 })
  assert.equal(r.ok, true)
  assert.match(t.state.navigated, /\/search\/%E5%BE%92%E6%AD%A5/)
  assert.match(r.text, /徒步绕地球/)
})

test('按词找：搜不到就说搜不到，不说"平台没给"', async () => {
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport('[]'), keyword: '不存在的词', waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.note, /什么都没搜到/)
})

test('open：按词找到之后真去打开第一条，拿不到画面就说没拿到', async () => {
  const t = {
    state: { navigated: '' },
    async start() { return { ok: true } },
    async navigate(url) { this.state.navigated = url; return { ok: true } },
    async evaluate(expr) {
      if (String(expr).includes('/aweme/detail')) {
        return { ok: true, value: JSON.stringify({ aweme_detail: { aweme_id: '7703602183127797026', desc: '徒步第 300 天', author: { nickname: '卡尔' }, video: {} } }) }
      }
      if (String(expr).includes('/video/')) {
        return { ok: true, value: JSON.stringify([{ href: '//www.douyin.com/video/7703602183127797026', txt: '03:43 262.2万 徒步第 300 天' }]) }
      }
      return { ok: true, value: '{}' }
    },
    async close() { return { ok: true } },
  }
  const root = tmpRoot()
  const r = await lookFeedOnce({ root, cfg: cfgOn, transport: t, keyword: '徒步', open: true, waitMs: 0 })
  assert.equal(r.ok, true)
  assert.match(r.text, /你打开的是第一条/)
  assert.match(r.text, /画面没截到/)
  const lines = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  // 自己挑出来打开的那一条记 from:pick（A7）；搜过的词另记一行 searched。
  assert.ok(lines.some((e) => String(e.text) === 'looked:dy_7703602183127797026 from:pick'))
  assert.ok(lines.some((e) => String(e.text) === 'searched:徒步 douyin'))
})


// ── A9 热榜：不登录、每天一次、账与 dyfeed 分开 ──

const HOT_JSON = JSON.stringify({ data: { word_list: [
  { word: '立冬和饺子最配了', hot_value: 11049022, position: 1 },
  { word: '多地目击巨型火流星划过', hot_value: 10458002, position: 2 },
  { word: '立冬和饺子最配了', hot_value: 1, position: 3 },
  { word: '   ', hot_value: 1, position: 4 },
] } })

function hotFetch(payload = HOT_JSON) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => payload }
  }
  return { impl, calls }
}

test('normalizeHot：网页版 data.word_list 与老版 word_list 都认，去重、丢空词', () => {
  const a = normalizeHot(HOT_JSON)
  assert.equal(a.length, 2)
  assert.equal(a[0].word, '立冬和饺子最配了')
  assert.equal(a[0].hot, 11049022)
  assert.equal(a[1].rank, 2)
  const b = normalizeHot(JSON.stringify({ word_list: [{ word: '甲', hot_value: 5 }] }))
  assert.equal(b.length, 1)
  assert.equal(b[0].word, '甲')
  assert.deepEqual(normalizeHot('<html></html>'), [])
  assert.deepEqual(normalizeHot({}), [])
})

test('renderHot / hotLine / hotCountToday：一行一个词，账上有日期', () => {
  const text = renderHot(normalizeHot(HOT_JSON))
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^1\. 立冬和饺子最配了 · 1104\.9 万/)
  const line = hotLine('2026-11-06', ['立冬 和饺子', '火流星'])
  assert.equal(line, 'looked:hot 2026-11-06 立冬_和饺子 火流星')
  const events = [
    { type: 'meta', text: line },
    { type: 'meta', text: 'looked:hot 2026-11-05 昨天的' },
    { type: 'meta', text: 'looked:BV1xx411c7mD from:push' },
  ]
  assert.equal(hotCountToday(events, '2026-11-06'), 1)
})

test('热榜的账不当成视频号：parseLookedLine 认不出它', async () => {
  const { parseLookedLine } = await import('../lib/browse.js')
  assert.equal(parseLookedLine('looked:hot 2026-11-06 甲 乙'), null)
  assert.deepEqual(parseLookedLine('looked:BV1xx411c7mD from:hot'), { id: 'BV1xx411c7mD', from: 'hot' })
})

test('热榜：不用浏览器；记 looked:hot，不写 dyfeed，不占报纸配额', async () => {
  const root = tmpRoot()
  const { impl, calls } = hotFetch()
  const r = await lookHotOnce({ root, cfg: cfgOn, fetchImpl: impl, limit: 2 })
  assert.equal(r.ok, true)
  assert.match(r.text, /立冬和饺子最配了/)
  assert.match(r.text, /不是平台挑给你的/)
  assert.match(calls[0], /hot\/search\/list/)
  const lines = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((e) => String(e.text).startsWith('looked:hot ')))
  assert.ok(!lines.some((e) => String(e.text).startsWith('dyfeed:')))
  assert.ok(!lines.some((e) => String(e.text).startsWith('dy-browse:')))
})

test('热榜：一天只上一次，第二次直说看过了', async () => {
  const root = tmpRoot()
  const first = await lookHotOnce({ root, cfg: cfgOn, fetchImpl: hotFetch().impl })
  assert.equal(first.ok, true)
  const again = await lookHotOnce({ root, cfg: cfgOn, fetchImpl: hotFetch().impl })
  assert.equal(again.ok, false)
  assert.match(again.note, /看过了/)
  const forced = await lookHotOnce({ root, cfg: cfgOn, fetchImpl: hotFetch().impl, force: true })
  assert.equal(forced.ok, true)
})

test('热榜：第一个口子不通就换备用口；都不通就说没读到', async () => {
  const root = tmpRoot()
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    if (calls.length === 1) return { ok: false, status: 500, text: async () => '' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ word_list: [{ word: '备用口上的词', hot_value: 1 }] }) }
  }
  const r = await lookHotOnce({ root, cfg: cfgOn, fetchImpl: impl })
  assert.equal(r.ok, true)
  assert.match(r.text, /备用口上的词/)
  assert.equal(calls.length, 2)

  const bad = await lookHotOnce({ root: tmpRoot(), cfg: cfgOn, fetchImpl: async () => ({ ok: false, status: 502 }) })
  assert.equal(bad.ok, false)
  assert.match(bad.note, /没读到/)
})

test('热榜：抖音没开的时候不去读', async () => {
  const { impl, calls } = hotFetch()
  const r = await lookHotOnce({ root: tmpRoot(), cfg: cfgOff, fetchImpl: impl })
  assert.equal(r.ok, false)
  assert.match(r.note, /没开/)
  assert.equal(calls.length, 0)
})

const COMMENTS = [
  { user: '阿甲', txt: '这个我也想去' },
  { user: '', txt: '第三遍了' },
  { user: '空', txt: '   ' },
]

test('normalizeComments / renderComments：只留说了话的，作者可选', () => {
  const got = normalizeComments(JSON.stringify(COMMENTS))
  assert.equal(got.length, 2)
  const text = renderComments(got)
  assert.equal(text.split('\n')[0], '1. 阿甲：这个我也想去')
  assert.equal(text.split('\n')[1], '2. 第三遍了')
  assert.deepEqual(normalizeComments('<html>'), [])
})

test('what=comments：点名打开那条，读回几条别人的话，记 from:pick', async () => {
  const root = tmpRoot()
  const t = fakeTransport(JSON.stringify(COMMENTS))
  const r = await lookFeedOnce({ root, cfg: cfgOn, transport: t, what: 'comments', id: '7703602183127797026', waitMs: 0 })
  assert.equal(r.ok, true)
  assert.match(t.state.navigated, /\/video\/7703602183127797026/)
  assert.match(r.text, /这个我也想去/)
  const lines = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((e) => String(e.text) === 'looked:dy_7703602183127797026 from:pick'))
})

test('what=comments：没给号就说要哪一条；给的是链接也认', async () => {
  const none = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: fakeTransport('[]'), what: 'comments', waitMs: 0 })
  assert.equal(none.ok, false)
  assert.match(none.note, /哪条/)
  const t = fakeTransport(JSON.stringify(COMMENTS))
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: t, what: 'comments', id: 'https://www.douyin.com/video/7703602183127797026', waitMs: 0 })
  assert.equal(r.ok, true)
  assert.match(t.state.navigated, /7703602183127797026/)
})

test('what=search 不给词：别悄悄退回推荐流', async () => {
  const t = fakeTransport(FEED)
  const r = await lookFeedOnce({ root: tmpRoot(), cfg: cfgOn, transport: t, what: 'search', waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.note, /给个词/)
  assert.equal(t.state.calls, 0)
})
