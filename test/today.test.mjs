/**
 * A23：今天页的口径——只算「点开过」+「抽过帧」。
 *
 * 2026-11-07 之前 `/today` 把 `browse:` 也当成「翻到」放进时间线，
 * 于是她只扫了一眼标题，今天页就写着她看过。`browse:` 是账本，照记；
 * 但今天页只该出现她真的点开过的（`look:` / `looked:`）和真的抽过帧的（`watched:`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { appendEvent, readEvents } from '../lib/store.js'
import { dateKey } from '../lib/settings.js'
import { seenKindOfText } from '../lib/whatseen.js'
import { registerObserve } from '../lib/observe.js'

const B1 = 'BV1xx411c7mD'
const B2 = 'BV1yy411c7mD'
const B3 = 'BV1zz411c7mD'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-today-'))
  try {
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx(routes) {
  return {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') return { register(ex) { routes.set(ex.path, ex.handler); return () => {} } }
      if (name === 'agents') return { get: () => null, list: () => [] }
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
  }
}

async function getToday(root, dk) {
  const routes = new Map()
  registerObserve(fakeCtx(routes), { root })
  const handler = routes.get('/dsh-perch/today')
  assert.ok(handler, '/today 路由要注册上')
  const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} })
  let status = 0
  let text = ''
  const res = {
    writableEnded: false,
    writeHead(code) { status = code },
    end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
  }
  await handler(req, res)
  return { status, json: text ? JSON.parse(text) : null }
}

test('A23：seenKindOfText 只认点开与抽帧，browse/searched/热搜词都不算', () => {
  assert.equal(seenKindOfText('watched:2026-11-07 ' + B1), 'watched')
  assert.equal(seenKindOfText('look:2026-11-07 ' + B1), 'opened')
  assert.equal(seenKindOfText('looked:' + B1 + ' from:pick'), 'opened')
  assert.equal(seenKindOfText('looked:dy_123 from:pick'), 'opened')
  assert.equal(seenKindOfText('looked:hot 某某'), '')
  assert.equal(seenKindOfText('browse:2026-11-07 []'), '')
  assert.equal(seenKindOfText('searched:深海 bili'), '')
  assert.equal(seenKindOfText(''), '')
})

test('A23：今天页不显示只翻到的标题，点开过与抽过帧各留一条', async () => withRoot(async (root) => {
  const dk = dateKey(new Date())
  const ctx = { day: 1, stage: 1, source: 'system' }
  // 只翻到标题：账本照记，但不该出现在今天页
  await appendEvent({ type: 'meta', text: `browse:${dk} ${JSON.stringify([{ bvid: B1, title: '只翻到的标题' }])}` }, ctx, root)
  // 同一条视频：点开过，账本 + look 各一条
  await appendEvent({ type: 'meta', text: `looked:${B1} from:pick` }, ctx, root)
  await appendEvent({ type: 'meta', text: `look:${dk} ${B1}` }, ctx, root)
  // 另一条：真的抽过帧
  await appendEvent({ type: 'meta', text: `watched:${dk} ${B2} ${JSON.stringify({ title: '看过画面的' })}` }, ctx, root)
  // 只搜了个词、只看了个热搜词
  await appendEvent({ type: 'meta', text: 'searched:深海 bili' }, ctx, root)
  await appendEvent({ type: 'meta', text: 'looked:hot 某某热搜' }, ctx, root)

  const { status, json } = await getToday(root, dk)
  assert.equal(status, 200)
  const kinds = json.timeline.map((x) => x.kind)
  assert.equal(kinds.filter((k) => k === 'opened').length, 1, '同一条点开只留一次')
  assert.equal(kinds.filter((k) => k === 'watched').length, 1, '抽过帧留一条')
  assert.equal(kinds.length, 2)
  const all = json.timeline.map((x) => x.text).join('\n')
  assert.ok(!all.includes('只翻到的标题'), '只翻到的标题不许进今天页')
  assert.ok(!all.includes('browse:'), 'browse 记账不在今天页显示')
  assert.ok(!all.includes('searched:'), '搜过的词不算看到')
  assert.ok(!all.includes('热搜'), '热搜词不是在今天页看过的视频')
  // 账本本身没动
  const { events } = await readEvents(root)
  assert.ok(events.some((e) => String(e.text).startsWith(`browse:${dk}`)), 'browse: 照记')
}))

test('A23：同一条既点开又抽帧时只留抽帧那条（更强的凭证），顺序打乱也一样', async () => withRoot(async (root) => {
  const dk = dateKey(new Date())
  const ctx = { day: 1, stage: 1, source: 'system' }
  await appendEvent({ type: 'meta', text: `look:${dk} ${B3}` }, ctx, root)
  await appendEvent({ type: 'meta', text: `watched:${dk} ${B3}` }, ctx, root)
  const { json } = await getToday(root, dk)
  assert.deepEqual(json.timeline.map((x) => x.kind), ['watched'])
}))
