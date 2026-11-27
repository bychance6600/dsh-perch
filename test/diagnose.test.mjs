/**
 * diagnose.test.mjs —— 一键诊断包（本地版，2026-11-27，公开仓 issue #12）
 *
 * 要钉住的性质（都是「悄悄坏掉会出事」的）：
 *   1. **不出事件正文**：诊断包是发到群里的，事件流只允许出类型计数。
 *   2. **不出凭证**：配置只出开关与数量，cookie / key / 群号 / 人名一律不出现。
 *   3. **日志只抄 warn/error**：info 行（可能带她说的话）不进包；日志里的值要再洗一遍。
 *   4. **落盘与限额**：写进 out/diag/，只留最近 N 份，单包 < 2MB。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DIAG_KEEP,
  DIAG_MAX_BYTES,
  buildDiagnose,
  configSummary,
  diagDir,
  diagName,
  diagStamp,
  eventTypeCounts,
  saveDiagnose,
} from '../lib/diagnose.js'
import { logLine } from '../lib/log.js'

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'fish-diag-'))
}

async function seedEvents(root, lines) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

test('事件流只出类型计数，不出正文', async () => {
  const root = await tempRoot()
  await seedEvents(root, [
    { type: 'utterance', at: '2026-11-27T00:00:00Z', text: 'SECRET-她说过的一句秘密话' },
    { type: 'utterance', at: '2026-11-27T00:01:00Z', text: 'SECRET-第二句' },
    { type: 'heard', at: '2026-11-27T00:02:00Z', text: 'SECRET-别人说的' },
    { type: 'meta', at: '2026-11-27T00:03:00Z', key: 'looked:dy_1', text: 'SECRET-元信息' },
  ])
  const { text, summary } = buildDiagnose(root, { version: '0.5.0-dev' })
  assert.ok(text.includes('utterance=2'), '类型计数要有 utterance=2')
  assert.ok(text.includes('heard=1'))
  assert.ok(text.includes('meta=1'))
  assert.ok(text.includes('采样 4 条'))
  assert.ok(!text.includes('SECRET'), '事件正文不能出现在诊断包里')
  assert.ok(!summary.includes('SECRET'), '摘要也不能带正文')
  assert.ok(summary.includes('0.5.0-dev'))
})

test('配置只出开关与数量，不出凭证/群号/人名', async () => {
  const cfg = {
    channels: {
      qq: {
        enabled: true,
        groups: ['111111', '222222'],
        rooms: ['333333'],
        mentionOnly: true,
        ownerId: 'SECRET-OWNER-ID',
        token: 'SECRET-BRIDGE-TOKEN',
      },
    },
    bili: { enabled: true, cookie: 'SECRET-BILI-COOKIE' },
    browse: { enabled: true, douyin: { enabled: false } },
    pet: { enabled: false },
    diary: { enabled: true },
    tools: { restrict: true, allow: ['web_fetch', 'web_search'] },
  }
  const lines = configSummary(cfg)
  const all = lines.join('\n')
  assert.ok(all.includes('群 2 个'))
  assert.ok(all.includes('客厅 1 个'))
  assert.ok(all.includes('白名单 2 个'))
  assert.ok(all.includes('抖音: 关'))
  assert.ok(!all.includes('111111'), '群号不能出现')
  assert.ok(!all.includes('SECRET'), '凭证与人名不能出现')

  const root = await tempRoot()
  await seedEvents(root, [{ type: 'seed' }])
  const { text } = buildDiagnose(root, { version: 'x', config: cfg })
  assert.ok(!text.includes('SECRET'))
  assert.ok(!text.includes('111111'))
})

test('日志只抄 warn/error，且抄前再洗一遍', async () => {
  const root = await tempRoot()
  await mkdir(root, { recursive: true })
  logLine('info', ['SECRET-INFO-她说的话'], root)
  logLine('error', ['桥断了 E_BRIDGE_WS cookie=SECRET-COOKIE-VALUE'], root)
  logLine('warn', ['磁盘快满了'], root)
  const { text, summary } = buildDiagnose(root, { version: 'x' })
  assert.ok(text.includes('E_BRIDGE_WS'))
  assert.ok(text.includes('磁盘快满了'))
  assert.ok(!text.includes('SECRET-INFO'), 'info 行不进诊断包')
  assert.ok(!text.includes('SECRET-COOKIE-VALUE'), '日志里的 cookie 值要洗掉')
  assert.ok(text.includes('E_BRIDGE_WS×1'), '错误码要计数')
  assert.ok(summary.includes('warn/error 2 行'))
})

test('自检只抄坏项；summary 报坏项数', async () => {
  const root = await tempRoot()
  await seedEvents(root, [{ type: 'seed' }])
  const checks = {
    summary: '2 项坏',
    items: [
      { ok: true, label: 'Node 版本', detail: 'v24' },
      { ok: false, label: '数据目录可写', detail: 'EACCES', fix: '换个可写目录' },
      { ok: false, label: '桥端口', detail: '连不上', fix: '看 NapCat' },
    ],
  }
  const { text, summary } = buildDiagnose(root, { version: 'x', checks })
  assert.ok(text.includes('BAD 数据目录可写'))
  assert.ok(text.includes('BAD 桥端口'))
  assert.ok(!text.includes('Node 版本'), '正常项不抄')
  assert.ok(summary.includes('2 项坏'))
})

test('落盘到 out/diag，只留最近 N 份，字节数对得上', async () => {
  const root = await tempRoot()
  const dir = diagDir(root)
  await mkdir(dir, { recursive: true })
  // 先塞满 25 个旧包（名字格式与正式一致，时间更早）。
  for (let i = 0; i < DIAG_KEEP + 5; i += 1) {
    const d = new Date(2026, 10, 1, 0, 0, i) // 2026-11-01，秒递增
    await writeFile(join(dir, diagName(d)), 'old', 'utf8')
  }
  const text = 'hello 诊断\n'
  const saved = saveDiagnose(root, text, { keep: DIAG_KEEP })
  assert.ok(saved.path.startsWith(dir))
  assert.equal(saved.bytes, Buffer.byteLength(text, 'utf8'))
  assert.equal(await readFile(saved.path, 'utf8'), text)
  const left = (await readdir(dir)).filter((f) => f.startsWith('dsh-perch-诊断-'))
  assert.equal(left.length, DIAG_KEEP)
})

test('单包不超过 2MB：超了截断但保留头尾', async () => {
  const root = await tempRoot()
  await seedEvents(root, [{ type: 'seed' }])
  const big = 'x'.repeat(4000)
  const checks = {
    summary: '很多坏项',
    items: Array.from({ length: 1200 }, (_, i) => ({ ok: false, label: `第 ${i} 项`, detail: big })),
  }
  const { text } = buildDiagnose(root, { version: 'x', checks })
  assert.ok(Buffer.byteLength(text, 'utf8') <= DIAG_MAX_BYTES)
  assert.ok(text.includes('包太大，中间省略'))
  assert.ok(text.includes('=== 结束'), '尾要留')
})

test('diagStamp 稳定可读、没有坏字符', () => {
  const s = diagStamp(new Date(2026, 10, 27, 9, 3, 5))
  assert.equal(s, '20261127-090305')
  assert.ok(diagName(new Date(2026, 10, 27, 9, 3, 5)).startsWith('dsh-perch-诊断-20261127-090305'))
})

test('没有事件流时也不炸', async () => {
  const root = await tempRoot()
  const counts = eventTypeCounts(root)
  assert.equal(counts.exists, false)
  const { text } = buildDiagnose(root, { version: 'x' })
  assert.ok(text.includes('还没有 events.jsonl'))
})
