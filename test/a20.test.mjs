/**
 * a20.test.mjs —— 父项 0.9.1「直接取」表里那几件小事（A20）
 *
 * 一条一条都很小，但每一条都在真机上出过事：判断没有日期、翻旧事一次给一整段、
 * 事件数把记账也算进去、readJson 被 BOM 噎住、会话列表取到了最旧那条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deriveSelf } from '../lib/derive.js'
import { beliefOrigin } from '../lib/persona.js'
import { searchEvents, renderBrief, registerRecall } from '../lib/recall.js'
import { countEvents } from '../lib/eventcount.js'
import { readJson } from '../lib/store.js'
import { createSessionWithRetry, ensureTalkSession } from '../lib/home.js'
import { saveAvatar } from '../lib/avatar.js'

function ev(over = {}) {
  const t = Date.now()
  return {
    id: 'ev_x', ts: new Date(t).toISOString(), day: 1, stage: 1,
    type: 'utterance', source: 'tool', text: '', refs: [], verdict: null,
    confidence: 0.5, flags: [], ...over,
  }
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-a20-'))
  try { return await fn(root) } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('拒绝词表：新词算拒绝，但「我不同意他」这种第三人称不算（A20）', () => {
  const refused = (text) => deriveSelf([ev({ text })], { now: Date.now() }).facts.refused
  assert.equal(refused('我不同意。'), 1)
  assert.equal(refused('我反对这个做法。'), 1)
  assert.equal(refused('我否决。'), 1)
  assert.equal(refused('我不同意他说的。'), 0, '说的是别人，不是她自己拒绝')
  assert.equal(refused('我反对你的安排。'), 0)
  assert.equal(refused('我拒绝。'), 1, '旧词仍然算')
})

test('判断后面带日期与来路：改的口 / 推翻的 / 普通（A20）', () => {
  const since = new Date(2026, 9, 1, 12, 0, 0).toISOString()
  assert.equal(beliefOrigin({ since }), '（10-01）')
  assert.equal(beliefOrigin({ since, verdict: 'refined' }), '（10-01 改的口）')
  assert.equal(beliefOrigin({ since, verdict: 'refuted' }), '（10-01 推翻了以前那句）')
  assert.equal(beliefOrigin({ since: '不是日期' }), '')
})

test('her_recall 的 brief 档：只给条数与短片段，不列 id（A20）', () => {
  const rows = [
    { id: 'ev_long', date: '2026-11-07', type: 'utterance', text: '这一句特别长长长长长长长长长长长长长长长长长长长长长长长长长长长长' },
    { id: 'ev_short', date: '2026-11-06', type: 'heard', text: '听见一句' },
  ]
  const text = renderBrief(rows)
  assert.match(text, /^你翻到 2 条：/)
  assert.ok(!text.includes('ev_long'), 'brief 不列 id，免得长 id 被当正文背下来')
  assert.match(text, /2026-11-07｜utterance｜/)
  assert.match(text, /…/)
  assert.match(text, /听见一句/)

  let spec = null
  registerRecall({ tools: { register: (s) => { spec = s } } }, { root: tmpdir() })
  assert.ok(spec.parameters.properties.brief, '工具参数里要有 brief')
})

test('翻旧事时日期按本地日算，不按 UTC 的日期切（A20）', () => {
  const ts = new Date(2026, 10, 7, 1, 0, 0).toISOString() // 本地 11-07 凌晨 1 点
  const { rows } = searchEvents([ev({ id: 'ev_d', ts, day: '2026-11-07', text: '凌晨说的一句话' })], '凌晨')
  assert.equal(rows[0].date, '2026-11-07')
})

test('事件计数分三类：真实经历 / 记账 / 噪声（A20）', () => {
  const c = countEvents([
    ev({ type: 'utterance' }), ev({ type: 'heard' }),
    ev({ type: 'meta' }), ev({ type: 'seed' }), ev({ type: 'grant' }), ev({ type: 'test' }),
    ev({ type: 'dream' }), ev({ type: 'future_type' }),
  ])
  assert.deepEqual(c, { real: 3, meta: 4, noise: 1, total: 8 }, '不认识的类型算真实经历，不藏掉')
})

test('readJson 先剥 BOM：Windows 记事本存出来的 JSON 也能读（A20）', async () => withRoot(async (root) => {
  const file = join(root, 'bom.json')
  writeFileSync(file, '\uFEFF{"a":1}', 'utf8')
  assert.deepEqual(await readJson(file, null), { a: 1 })
}))

test('建会话碰到 EPERM：只在 win32 重试，三次后还不行才抛（A20）', async () => {
  const logs = []
  let calls = 0
  const sc = { async create() { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return { sessionId: 's3' } } }
  const out = await createSessionWithRetry(sc, { workspaceId: 'w' }, (m) => logs.push(m), { platform: 'win32' })
  assert.deepEqual(out, { sessionId: 's3' })
  assert.equal(calls, 3)
  assert.equal(logs.length, 2)
  assert.match(logs[0], /EPERM/)

  calls = 0
  await assert.rejects(() => createSessionWithRetry(sc, {}, () => {}, { platform: 'linux' }), /busy/)
  assert.equal(calls, 1, '别的平台真失败就是真失败，别拖三倍时间')
})

test('同屋另有一条活会话时认最近那条（sessionIds 头一条），不认最旧（A20）', async () => withRoot(async (root) => {
  writeFileSync(join(root, 'home.json'), JSON.stringify({ wsId: 'ws1', sessionId: 'ses-old', title: '跟她说话', preset: 'standard' }))
  const ws = { id: 'ws1', path: join(root, 'home'), title: '', sessionIds: ['ses-new', 'ses-old'] }
  const reg = { get: () => ws, list: () => [ws], archivedSessionIds: ['ses-old'] }
  const ctx = {
    sessionController: { async create() { return { sessionId: 'ses-x' } }, async rename() {} },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get: (k) => (k === 'workspaceRegistry' ? reg : null),
  }
  const r = await ensureTalkSession(ctx, { root, wsId: 'ws1' })
  assert.equal(r.ok, true, r.why)
  assert.equal(r.sessionId, 'ses-new')
  assert.equal(r.adopted, true)
}))

test('头像临时名带随机后缀：写完不留 .tmp，并发也不会撞名（A20）', () => withRoot(async (root) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const r = saveAvatar(root, { mime: 'image/png', data: png })
  assert.equal(r.ok, true, r.why)
  const names = readdirSync(root)
  assert.ok(!names.some((n) => n.endsWith('.tmp')), '临时文件要清干净')
  assert.ok(readFileSync(join(root, 'avatar.png')).length > 0)
}))

test('主动回合投递前先看忙闲，不往正在说话的会话里塞第二句（A20）', () => {
  const src = readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.ok(src.includes("if (isBusy(sessionId)) {"), '投递前要问一句她忙不忙')
  assert.ok(src.includes('她还在上一轮里'), '跳过的理由要写清楚')
})
