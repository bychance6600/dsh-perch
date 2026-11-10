// 一次性账本搬迁：冷复制 + 逐行校验 + deriveSelf 比对。可重跑；源目录只读。
// 用法：ROOST_SRC=<旧数据目录> [ROOST_DST=<新数据目录>] node tools/migrate-ledger.mjs [--write]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveSelf } from '../lib/derive.js'

const SRC = process.env.ROOST_SRC || ''
const DST = process.env.ROOST_DST || path.join(os.homedir(), '.dsh-perch')
const WRITE = process.argv.includes('--write')
if (!SRC) {
  console.error('先设 ROOST_SRC：它指向旧数据目录（例如 D:\\backup\\river-data），不是默认去猜。')
  process.exit(2)
}
const FILES = ['events.jsonl', 'people.json', 'journal.json', 'config.json', 'owner.json',
  'worldbook.json', 'home.json', 'talk-recent.json', 'inbox.md', '说明.md']
const DIRS = ['home', 'diary']

const bad = []
const ok = (cond, msg) => { if (!cond) bad.push(msg) }

function readEvents(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const events = []
  lines.forEach((line, i) => {
    if (!line.trim()) return
    try { events.push(JSON.parse(line)) } catch { bad.push(`第 ${i + 1} 行不是 JSON`) }
  })
  return { events, lines: lines.filter((l) => l.trim()).length }
}

const srcEvents = readEvents(path.join(SRC, 'events.jsonl'))
const ids = new Set(srcEvents.events.map((e) => e.id))
ok(srcEvents.events.length > 0, '事件流是空的')
ok(ids.size === srcEvents.events.length, `事件 id 有重复：${srcEvents.events.length - ids.size} 条`)
ok(srcEvents.events[0]?.type === 'seed', `第一条不是 seed，是 ${srcEvents.events[0]?.type}`)
for (const f of ['people.json', 'journal.json', 'config.json', 'owner.json', 'worldbook.json']) {
  const p = path.join(SRC, f)
  if (!fs.existsSync(p)) { bad.push(`缺 ${f}`); continue }
  try { JSON.parse(fs.readFileSync(p, 'utf8')) } catch { bad.push(`${f} 不是 JSON`) }
}

const before = deriveSelf(srcEvents.events, { stageSpanDays: 30 })
const summary = (d) => JSON.stringify({
  day: d.day, stage: d.stage, beliefs: d.beliefs?.length, refusals: d.facts?.refused ?? d.refused,
  scars: d.scars?.length, stances: d.stances?.length,
})
console.log('源账本：', srcEvents.lines, '条 /', srcEvents.events.length, '事件')
console.log('源派生：', summary(before))

if (WRITE) {
  fs.mkdirSync(DST, { recursive: true })
  for (const f of FILES) {
    const p = path.join(SRC, f)
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(DST, f))
  }
  for (const d of DIRS) {
    const p = path.join(SRC, d)
    if (fs.existsSync(p)) fs.cpSync(p, path.join(DST, d), { recursive: true })
  }
  // home.json 是宿主会话指针，旧 id 在新安装里无效：搬完删掉，加载时重建。
  const hp = path.join(DST, 'home.json')
  if (fs.existsSync(hp)) fs.rmSync(hp)
  const dstEvents = readEvents(path.join(DST, 'events.jsonl'))
  const after = deriveSelf(dstEvents.events, { stageSpanDays: 30 })
  console.log('目标账本：', dstEvents.lines, '条')
  console.log('目标派生：', summary(after))
  ok(dstEvents.lines === srcEvents.lines, '两边行数不一致')
  ok(summary(after) === summary(before), '两边派生结果不一致')
}

if (bad.length) {
  console.error('校验失败：\n- ' + bad.join('\n- '))
  process.exit(1)
}
console.log(WRITE ? '搬迁完成，校验通过。' : '只读校验通过（加 --write 才复制）。')
