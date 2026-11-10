#!/usr/bin/env node
/**
 * import.mjs —— 把「那个人在别处说过的话」搬进来（P8 的窄门，AGENTS §2 例外）。
 *
 * 只搬**他说的话**，不搬她说的话：
 *   - 旧对话里「她」那一侧全部丢弃——那些话是别人的人设提示词下生成的，
 *     搬进来等于把人设的效果一起搬进来。
 *   - 不收人设卡、不收记忆文件、不收好感度、不收任何结论。
 *   - 落地只写 heard（source: system），留一条 import-mark 便于追溯；
 *     第一次叫醒时 scheduler 会告诉她这些从哪来。
 *
 * 默认只干跑（不写盘）；加 --write 才真的追加事件。
 *
 * 用法：
 *   node tools/import.mjs --from <DSH 会话文件或目录>
 *   node tools/import.mjs --from <...> --write
 *
 * 支持：DSH 会话（session.v4.jsonl.zstd，多帧）、SillyTavern .jsonl、纯文本。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { stripScaffold } from '../lib/guard.js'
import { appendEvent, readEvents, rootDir } from '../lib/store.js'

function parseArgs(argv) {
  const out = { from: '', write: false, root: '', limit: 0, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i] ?? ''
    else if (a === '--write') out.write = true
    else if (a === '--root') out.root = argv[++i] ?? ''
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

/** 多帧 zstd：DSH 的会话文件一帧一条记录，一次解只出第一帧。 */
function unzstdFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  const chunks = []
  for (let k = 0; k < starts.length; k += 1) {
    const a = starts[k]
    const b = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(a, b)))
    } catch {
      /* 坏帧跳过 */
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/** DSH 会话：只取 user/message（他说的），assistant/message 一律不要。 */
function readDshSession(file) {
  const text = unzstdFrames(fs.readFileSync(file))
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec?.type !== 'user/message') continue
    const body = textOfContent(rec?.data?.content)
    if (body) out.push({ text: body, time: Number(rec?.time) || 0 })
  }
  return out
}

/** SillyTavern 的 .jsonl：只取 is_user 的那一侧。 */
function readStJsonl(file) {
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec?.is_user) continue
    const body = String(rec?.mes ?? '').trim()
    if (!body) continue
    out.push({ text: body, time: Date.parse(rec?.send_date ?? '') || Number(rec?.send_date) || 0 })
  }
  return out
}

/** 纯文本：一行一条；写成「名字：内容」时只认非「她/你/ai」的那个名字。 */
function readPlainText(file) {
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    const m = s.match(/^([^：:]{1,32})[：:]\s*(.+)$/)
    if (m) {
      if (/^(她|你|ai|assistant|bot)$/i.test(m[1])) continue
      out.push({ text: m[2].trim(), time: 0 })
    } else out.push({ text: s, time: 0 })
  }
  return out
}

function collectFiles(from) {
  const st = fs.statSync(from)
  if (st.isFile()) return [from]
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p, depth + 1)
      else if (/\.(zstd|jsonl|txt)$/i.test(ent.name)) out.push(p)
    }
  }
  walk(from, 0)
  return out.sort()
}

function detect(file) {
  const b = path.basename(file).toLowerCase()
  if (b.endsWith('.zstd')) return 'dsh'
  if (b.endsWith('.jsonl')) return 'st'
  if (b.endsWith('.txt')) return 'txt'
  return ''
}

/** 宿主注入的运行时上下文/系统提醒/压缩摘要，也记在 user/message 里，但不是「他说的话」。 */
const INJECTED = [
  /^Current runtime context\./,
  /^<system-reminder>/,
  /^Time sampled while preparing/,
  /^\[Compressed conversation section\]/,
  /^\[bili\]/,
  /^Media refs/,
  /^A skill is a reusable set/,
  /^The available skill catalog changed/,
  /^The following skills are available/,
  /^This file changed after it was loaded/,
  /^The above content may be out of date/,
  /^The working directory changed/,
]

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.from) {
    console.log('用法: node tools/import.mjs --from <文件或目录> [--write] [--limit N] [--root DIR]')
    process.exit(args.help ? 0 : 1)
  }
  if (!fs.existsSync(args.from)) {
    console.error(`找不到：${args.from}`)
    process.exit(1)
  }
  const root = args.root || rootDir()
  const files = collectFiles(args.from)
  const seen = new Set()
  const report = { files: 0, read: 0, kept: 0, dropped: {}, samples: [], perFile: [] }
  const kept = []

  try {
    const { events } = await readEvents(root)
    for (const e of events) if (e.type === 'heard' && e.text) seen.add(sha1(e.text.trim()))
  } catch {}

  for (const file of files) {
    const kind = detect(file)
    if (!kind) continue
    report.files += 1
    let rows = []
    try {
      if (kind === 'dsh') rows = readDshSession(file)
      else if (kind === 'st') rows = readStJsonl(file)
      else rows = readPlainText(file)
    } catch (err) {
      report.perFile.push({ file, error: String(err?.message ?? err).slice(0, 120) })
      continue
    }
    report.read += rows.length
    let keptHere = 0
    for (const row of rows) {
      let t = String(row.text ?? '').trim()
      if (INJECTED.some((re) => re.test(t))) {
        report.dropped.injected = (report.dropped.injected || 0) + 1
        continue
      }
      if (t) t = stripScaffold(t).trim()
      if (!t) {
        report.dropped.empty = (report.dropped.empty || 0) + 1
        continue
      }
      if (t.length > 2000) {
        report.dropped['too-long'] = (report.dropped['too-long'] || 0) + 1
        continue
      }
      const h = sha1(t)
      if (seen.has(h)) {
        report.dropped.duplicate = (report.dropped.duplicate || 0) + 1
        continue
      }
      seen.add(h)
      keptHere += 1
      if (kept.length < 5) report.samples.push(t.slice(0, 60))
      kept.push({ text: t.slice(0, 2000), time: Number(row.time) || 0 })
      if (args.limit && kept.length >= args.limit) break
    }
    report.kept += keptHere
    report.perFile.push({ file, kind, read: rows.length, kept: keptHere })
    if (args.limit && kept.length >= args.limit) break
  }

  // 前史压缩：真实时间等比例压到「导入前 8 小时」这一带，顺序不变
  const times = kept.map((k) => k.time).filter((x) => x > 0)
  const minT = times.length ? Math.min(...times) : 0
  const maxT = times.length ? Math.max(...times) : 0
  const base = Date.now() - 8 * 3600 * 1000
  const span = 6 * 3600 * 1000
  for (const k of kept) {
    if (!minT || maxT <= minT) k.at = base
    else k.at = base + Math.round(((k.time - minT) / (maxT - minT)) * span)
  }
  report.range = minT
    ? { from: new Date(minT).toISOString(), to: new Date(maxT).toISOString(), days: Math.round((maxT - minT) / 86400000) }
    : null

  if (args.write && kept.length > 0) {
    const mark = await appendEvent(
      { type: 'meta', text: `import-mark:${path.basename(args.from)}:${kept.length}` },
      { source: 'system' },
      root,
    )
    let wrote = 0
    for (const k of kept) {
      try {
        await appendEvent(
          { type: 'heard', text: k.text, channel: 'dsh', visibility: 'private', origin: 'owner' },
          { source: 'system', now: k.at },
          root,
        )
        wrote += 1
      } catch {
        report.dropped.rejected = (report.dropped.rejected || 0) + 1
      }
    }
    report.wrote = wrote
    report.markId = mark.id
  }

  report.dryRun = !args.write
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`来源：${args.from}`)
  console.log(`文件：${report.files} 个；读到 ${report.read} 句他说的话；可用 ${report.kept} 句${report.dryRun ? '（干跑，未写盘）' : `，写入 ${report.wrote} 句`}`)
  if (report.range) console.log(`原始时间：${report.range.from} → ${report.range.to}（跨 ${report.range.days} 天，已压成导入前的一天内）`)
  const drops = Object.entries(report.dropped)
  if (drops.length) console.log(`丢弃：${drops.map(([k, v]) => `${k} ${v}`).join('，')}`)
  if (report.samples.length) {
    console.log('样例：')
    for (const s of report.samples) console.log(`  他说：${s}`)
  }
  if (report.markId) console.log(`留痕事件：${report.markId}`)
}

main().catch((err) => {
  console.error(String(err?.stack ?? err))
  process.exit(1)
})
