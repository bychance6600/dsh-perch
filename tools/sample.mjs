#!/usr/bin/env node
/**
 * 样本她：把**同一条真账本**截成第 N 天的几张切片，用仓库里真的 `deriveSelf` 重放。
 *
 * 为什么不是「30 / 90 / 180 天」：她只活过十天出头，造 90 天等于编账。这个脚本只做
 * 「同一条账本在第 1 / 7 / 9 天的样子」——每一张都跑真代码，数字与判断可复查。
 *
 * 输出只有她说过的话与派生结果；他的原话、长数字、链接、@ 都会被抹掉。
 * 抹完仍然要人过目：脚本不认识「这句能不能公开」，只负责把不该出现的字符拿掉。
 *
 * 用法：
 *   node tools/sample.mjs                 # 干跑：只打印每天会产出多少行
 *   node tools/sample.mjs --write         # 写 samples/day-<N>.json 与 samples/审阅.md
 *   node tools/sample.mjs --root <目录> --days 1,7,9 --write
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readEvents } from '../lib/store.js'
import { deriveSelf } from '../lib/derive.js'

const DEFAULT_ROOT = path.join(os.homedir(), '.dsh-perch-samples')
const OUT_DIR = 'samples'
const TEXT_MAX = 120
const TODAY_MAX = 6
const KEEP_BELIEFS = 8
const DAY_MS = 24 * 60 * 60 * 1000
/** 只留她自己写的事件类型；`heard` 是他的话，一行都不该进样片。 */
const HER_TYPES = new Set(['utterance', 'revise', 'reunion', 'narration', 'refusal'])

/**
 * 重建之前（旧项目 river）留下的话不进样片：主人 2026-11-13 明确要求。
 * 判据只认字面标记，不做语义判断——漏掉比误删好，人还要再看一遍。
 */
const RIVER_MARK = /dsh-fish-river|大笨鱼|本鱼|图纸|重构|\briver\b/iu
const isPerchEra = (text) => !RIVER_MARK.test(String(text ?? ''))

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, days: [1, 7, 9, 14, 30], write: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--write') out.write = true
    else if (a === '--json') out.json = true
    else if (a === '--root') out.root = path.resolve(argv[++i] ?? out.root)
    else if (a === '--days') out.days = String(argv[++i] ?? '').split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0)
  }
  out.days = [...new Set(out.days)].sort((a, b) => a - b)
  return out
}

/**
 * 抹掉不该出现在公开样片里的东西：长数字（电话/QQ/订单号）、链接、@、邮箱。
 * 只做字符级处理，不做「这句该不该公开」的判断——那需要人看。
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gu, '[链接]')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gu, '[邮箱]')
    .replace(/@[^\s，。！？、,.!?]{1,20}/gu, '@某人')
    .replace(/\d{5,}/gu, '▪')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 太长的话截断；截断点尽量落在句号后面，不要切半个词。 */
export function clip(text, max = TEXT_MAX) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  return (cut > max * 0.5 ? head.slice(0, cut + 1) : head) + '…'
}

export function seedTimeOf(events) {
  const seed = events.find((e) => e?.type === 'seed')
  const t = Date.parse(seed?.ts ?? '')
  return Number.isFinite(t) ? t : Date.parse(events[0]?.ts ?? '') || Date.now()
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 改口链：旧句 → 新句。两句都是她自己说的，按事件 id 连起来。 */
function reviseChains(events, cutMs) {
  const byId = new Map(events.map((e) => [String(e.id), e]))
  const out = []
  for (const e of events) {
    if (e?.type !== 'revise') continue
    const at = Date.parse(e?.ts ?? '')
    if (Number.isFinite(at) && at > cutMs) continue
    const refs = Array.isArray(e.refs) ? e.refs.map(String) : []
    for (const id of refs) {
      const old = byId.get(id)
      if (!old || !HER_TYPES.has(old.type)) continue
      if (!isPerchEra(old.text) || !isPerchEra(e.text)) continue
      out.push({ before: clip(redact(old.text)), after: clip(redact(e.text)), date: dayKey(at) })
    }
  }
  return out
}

export function sampleDay(events, day, seedMs) {
  const cutoff = seedMs + day * DAY_MS
  const cut = events.filter((e) => {
    const t = Date.parse(e?.ts ?? '')
    return !Number.isFinite(t) || t <= cutoff
  })
  const model = deriveSelf(cut, { now: cutoff })
  // 只留她自己写的事件派生出来的判断：`heard` 是他的话，不该出现在样片里。
  const herIds = new Set(cut.filter((e) => HER_TYPES.has(e.type)).map((e) => String(e.id)))
  const seen = new Set()
  const beliefs = (model.ranked ?? [])
    .filter((b) => herIds.has(String(b.id)))
    .filter((b) => isPerchEra(b.text))
    .filter((b) => {
      const k = String(b.text ?? '')
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, KEEP_BELIEFS)
    .map((b) => ({
      text: clip(redact(b.text), 200),
      mentions: b.mentions ?? 0,
      verified: b.verified ?? 0,
      solid: Boolean(b.solid),
      evidence: [String(b.id).slice(-8)],
    }))
  const todayCut = cut.filter((e) => {
    const t = Date.parse(e?.ts ?? '')
    return e?.type === 'utterance' && Number.isFinite(t) && t > cutoff - DAY_MS && isPerchEra(e.text)
  })
  const today = todayCut.slice(-TODAY_MAX).map((e) => clip(redact(e.text), 240))
  const utterances = cut.filter((e) => e?.type === 'utterance').length
  return {
    day,
    date: dayKey(cutoff),
    stage: { name: model.stageName, index: model.stage, day: model.day },
    counts: { events: cut.length, judgments: model.beliefCount ?? beliefs.length, utterances },
    today,
    beliefs,
    revised: reviseChains(cut, cutoff),
    meta: {
      takenAt: new Date(cutoff).toISOString(),
      solid: (model.solid ?? []).length,
      scars: model.scarCount ?? 0,
      tensions: (model.tensions ?? []).length,
      name: model.name ?? null,
      herEvents: cut.filter((e) => HER_TYPES.has(e.type)).length,
    },
  }
}

/** 人看的审阅表：编号 → 句子，方便逐条说「这条不要」。 */
export function reviewSheet(days) {
  const lines = ['# 样本她 · 审阅表', '', '逐条过：说「第几行不要」就行；没说的默认留。', '']
  let n = 0
  for (const d of days) {
    for (const b of d.beliefs) lines.push(`${(n += 1)}. [第 ${d.day} 天·判断] 「${b.text}」`)
    for (const r of d.revised) lines.push(`${(n += 1)}. [第 ${d.day} 天·改口] 「${r.before}」→「${r.after}」`)
  }
  return lines.join('\n') + '\n'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { events } = await readEvents(args.root)
  if (!events.length) {
    console.error(`账本读出来是空的：${args.root}`)
    process.exit(1)
  }
  const seedMs = seedTimeOf(events)
  const lastMs = events.reduce((m, e) => Math.max(m, Date.parse(e?.ts ?? '') || 0), seedMs)
  // 账本活到第几天：超过这一天的切片没有新数据，硬切只会让「阶段」被时间推着走，
  // 看起来像她第 30 天长成了整合期——其实那天什么都没发生。所以只切到活到的那天。
  const spanDays = Math.max(1, deriveSelf(events, { now: lastMs + 1 }).day || 1)
  const wanted = args.days.filter((d) => d <= spanDays)
  const dayList = [...new Set([...wanted, spanDays])].sort((a, b) => a - b)
  const days = dayList.map((d) => sampleDay(events, d, seedMs))
  if (args.json) {
    console.log(JSON.stringify({ root: args.root, spanDays, days }, null, 2))
    return
  }
  for (const d of days) {
    console.log(
      `第 ${String(d.day).padStart(3)} 天 · ${d.counts.events} 条 · 阶段 ${d.stage.index} ${d.stage.name} · 判断 ${d.counts.judgments}（固化 ${d.meta.solid}）· 疤 ${d.meta.scars} · 改口 ${d.revised.length}`,
    )
  }
  const total = days.reduce((n, d) => n + d.beliefs.length + d.revised.length, 0)
  console.log(`账本活到第 ${spanDays} 天；共 ${total} 行待过目。`)
  if (!args.write) {
    console.log('干跑：加 --write 才会写 samples/。')
    return
  }
  const outDir = path.resolve(OUT_DIR)
  fs.mkdirSync(outDir, { recursive: true })
  for (const f of fs.readdirSync(outDir)) {
    if (/^day-\d+\.json$/.test(f) && !dayList.some((d) => f === `day-${d}.json`)) {
      fs.unlinkSync(path.join(outDir, f)) // 上次跑出来的旧天切片，留着会跟这次对不上
    }
  }
  for (const d of days) {
    fs.writeFileSync(path.join(outDir, `day-${d.day}.json`), JSON.stringify(d, null, 2) + '\n')
  }
  fs.writeFileSync(path.join(outDir, '审阅.md'), reviewSheet(days))
  console.log(`已写 ${outDir}（day-*.json 与 审阅.md）。`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
