/**
 * newspaper.test.mjs —— A24 报纸层的两本账
 *
 * 守的是两件最容易「看起来没事」的事：
 *   1. 判重表读坏了，不能当成没记录过 → 这一轮必须停下，不能重推。
 *   2. 每轮都要留下执行记录，失败也留；成功的账本里要有
 *      为什么值得 / 依据来源 / 无字幕跳过 N。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSeen, appendSeen, appendRun, SEEN_FILE, RUNS_FILE } from '../lib/newspaper.js'
import { gather } from '../lib/browse.js'
import { normalizeConfig } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-a24-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const v = (over = {}) => ({
  bvid: 'BVnew1', aid: 1001, title: '一个普通的视频', up: '某UP', mid: 42,
  duration: 600, view: 100000, like: 5000, danmaku: 200, ...over,
})

function fakeClient(over = {}) {
  const base = {
    popular: async () => ({ ok: true, data: [v()] }),
    ranking: async () => ({ ok: true, data: [] }),
    precious: async () => ({ ok: true, data: [] }),
    search: async () => ({ ok: true, data: [] }),
    view: async () => ({ ok: true, data: { desc: '简介一句', pubdate: 1700000000, cid: 555, aid: 1001, title: '标题', up: '某UP' } }),
    tags: async () => ({ ok: true, data: ['日常', '生活'] }),
    replies: async () => ({ ok: true, data: [{ text: '热评一', like: 99 }] }),
    danmaku: async () => ({ ok: true, data: [{ t: 12, text: '这句是弹幕' }] }),
  }
  return { ...base, ...over }
}

test('判重表：没有文件 = 空表；写了一行能读回来', async () => {
  await withRoot(async (root) => {
    const empty = await readSeen(root)
    assert.equal(empty.ok, true)
    assert.equal(empty.ids.size, 0)

    const w = await appendSeen(root, [{ id: 'BVnew1', action: 'push', why: '热门第 3' }], { now: Date.parse('2026-11-07T03:00:00Z') })
    assert.equal(w.ok, true)
    const got = await readSeen(root, { days: 7, now: Date.parse('2026-11-07T04:00:00Z') })
    assert.equal(got.ok, true)
    assert.equal(got.ids.has('BVnew1'), true)
    assert.equal(got.rows[0].action, 'push')
    assert.equal(got.rows[0].why, '热门第 3')
    const text = await readFile(join(root, SEEN_FILE), 'utf8')
    assert.match(text, /^# 判重表/)
  })
})

test('判重表：过窗口的只留历史，不再挡；窗口为 0 时全算', async () => {
  await withRoot(async (root) => {
    await appendSeen(root, [{ id: 'BVold1', at: '2026-10-01T03:00:00.000Z', action: 'push', why: '老账' }])
    const now = Date.parse('2026-11-07T03:00:00Z')
    const win = await readSeen(root, { days: 7, now })
    assert.equal(win.ok, true)
    assert.equal(win.ids.has('BVold1'), false)
    assert.equal(win.rows.length, 1) // 行没删，只是不挡了
    const all = await readSeen(root, { days: 0, now })
    assert.equal(all.ids.has('BVold1'), true)
  })
})

test('判重表：坏行 = ok:false，不静默当成空表', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, SEEN_FILE), '# 判重表\n\n这不是一行\n', 'utf8')
    const r = await readSeen(root)
    assert.equal(r.ok, false)
    assert.equal(r.malformed, 1)
    assert.match(r.error, /行读不出来/)
  })
})

test('gather：判重表读坏了这一轮不推，也不调平台，runs 里留一行失败', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, SEEN_FILE), '# 判重表\n\n坏掉的一行\n', 'utf8')
    const c = fakeClient()
    const r = await gather(c, { day: 2, stage: 2 }, normalizeConfig({ browse: { topN: 1 } }), {
      root, dk: '2026-11-07', trigger: 'wake', now: Date.parse('2026-11-07T03:00:00Z'),
    })
    assert.equal(r.ok, false)
    assert.match(r.note, /判重表/)
    assert.match(r.note, /不推/)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => String(e.text ?? '').startsWith('looked:')).length, 0)
    const runs = await readFile(join(root, RUNS_FILE), 'utf8')
    assert.match(runs, /判重表读不出来/)
    assert.match(runs, /这一轮不推/)
  })
})

test('gather：成功一轮写两本账（为什么值得 / 依据来源 / 无字幕 0）', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-11-07T03:00:00Z')
    const cfg = normalizeConfig({ browse: { topN: 1, deepRead: 1, danmaku: 1 } })
    const r = await gather(fakeClient(), { day: 2, stage: 2 }, cfg, {
      root, dk: '2026-11-07', trigger: 'manual', now,
    })
    assert.equal(r.ok, true)
    assert.equal(r.picks[0].bvid, 'BVnew1')

    const seen = await readFile(join(root, SEEN_FILE), 'utf8')
    assert.match(seen, /- BVnew1 \| .* \| push \| 10分00秒/)

    const runs = await readFile(join(root, RUNS_FILE), 'utf8')
    assert.match(runs, /手动/)
    assert.match(runs, /成功/)
    assert.match(runs, /扫描 1/)
    assert.match(runs, /收取 1/)
    assert.match(runs, /无字幕 0/)
    assert.match(runs, /为什么值得：10分00秒/)
    assert.match(runs, /依据来源：简介、标签、热评 1 条、弹幕 1 条/)
    assert.match(runs, /无字幕跳过 0 条/)
  })
})

test('gather：事件流为空也靠 seen.md 挡住上一条（重启不重推）', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-11-07T03:00:00Z')
    const cfg = normalizeConfig({ browse: { topN: 1, deepRead: 1, danmaku: 1 } })
    await gather(fakeClient(), { day: 2, stage: 2 }, cfg, { root, dk: '2026-11-07', now })
    const again = await gather(fakeClient(), { day: 2, stage: 2 }, cfg, {
      root, dk: '2026-11-07', events: [], now: now + 1000,
    })
    assert.equal(again.ok, false)
    assert.match(again.note, /看过了/)
    const runs = await readFile(join(root, RUNS_FILE), 'utf8')
    assert.match(runs, /都看过了/)
    assert.match(runs, /跳过 1/)
  })
})
