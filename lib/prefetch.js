/**
 * prefetch.js —— 聊天轮里先把「可能相关的旧事」摆到她手边（0.5.0 M1，issue #20）
 *
 * 2026-11-27 真机：被问「那你愿意叫姐姐吗」先答「现在还没有」，被指出后才 her_recall。
 * 她不是没记忆，也不是检索坏了——是开口前没先看一眼。
 *
 * 三条边界（规格 docs/记忆-落地-规格.md §3 M1）：只在四种「要用到过去」的轮次预取；
 * 纸条优先（纸上有相关的就带纸，不翻账本）；只给线索——≤3 条、≤300 tokens、每条带 id、
 * 最多标一条「可能相关」。不落账本、不改配置、零依赖；检索复用 recall.js 的 searchEvents。
 */

import { createPeople } from './people.js'
import { readNotes } from './notes.js'
import { readEventsCached, searchEvents } from './recall.js'

export const PREFETCH_MAX = 3
export const PREFETCH_TOKENS = 300
export const PREFETCH_CHARS = 400
export const PREFETCH_LIMIT = 9
export const PREFETCH_QUERY_MAX = 80

/**
 * 参与预取的类型：她说过/听过的、日记、她答过的、改口。
 * 比规格 §3 多带 refusal / reunion / narration——触发 4 要「她自己的判断与承诺」；
 * meta 不是经历，永远不进来。
 */
const PREFETCH_TYPES = new Set(['utterance', 'heard', 'diary', 'answer', 'revise', 'refusal', 'reunion', 'narration'])
const HER_OWN_TYPES = new Set(['utterance', 'revise', 'refusal', 'reunion', 'narration'])

const QUESTION_RE = /[?？]|(吗|呢|么|嘛)\s*$/
const PAST_RE = /(记得|那次|之前|上次|以前|曾经|当时|那时候|那天|为什么)/
const TIME_RE = /(昨天|前天|上周|上个月|去年|那年|小时候|\d{1,2}月\d{1,2}|\d{4}年|\d+号)/
const QUOTE_RE = /[「」“”"]/
const CORRECTION_RE = /(你不是|你上次说|你之前说|你明明|你忘了|你说过|你答应过)/
const GROWTH_RE = /(答应|愿意|拒绝|保证|承诺|决定|选择|要不要|会不会|能不能|你觉得自己|你是什么样|认错|道歉)/
// 「今天」不算：今天天气不错不是问过去。只认真正指向过去的时间词。

const HEADER = '## 可能相关的旧事（只是线索，不是结论）'
const FOOTER = '线索已经在上面，够用就别说没找到。'

/** 去掉 @ 段与多余空白：群里「@3774660329 你还记得吗」按「你还记得吗」检索。 */
function cleanHeard(text) {
  return String(text ?? '').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim()
}

function shorten(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function monthDay(at) {
  const d = new Date(Number(at) || 0)
  if (!Number.isFinite(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 这一轮要不要预取、因为哪条触发。纯函数，测试直接调。 */
export function prefetchTriggers(heard, o = {}) {
  const text = cleanHeard(heard)
  if (!text) return []
  const hit = []
  if (QUESTION_RE.test(text) && PAST_RE.test(text)) hit.push('past')
  const names = Array.isArray(o.names) ? o.names : []
  const named = names.some((n) => {
    const k = String(n ?? '').trim()
    return k.length >= 2 && text.includes(k)
  })
  if (TIME_RE.test(text) || QUOTE_RE.test(text) || named) hit.push('entity')
  if (CORRECTION_RE.test(text)) hit.push('correction')
  if (GROWTH_RE.test(text)) hit.push('growth')
  return hit
}

/** 粗估 token：CJK 一字 ≈1，ASCII 4 字符 ≈1，其余标点/全角 ≈2 字符 1。只为预算。 */
export function estimateTokens(text) {
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else if (code < 128) ascii += 1
    else other += 1
  }
  return Math.ceil(cjk + ascii / 4 + other / 2)
}

/** 汉字二元组：只判断纸条和这句话有没有共同词，不做分词。 */
function bigrams(text) {
  const chars = [...String(text ?? '')].filter((ch) => /[\u3400-\u9fff]/.test(ch))
  const set = new Set()
  for (let i = 0; i + 1 < chars.length; i += 1) set.add(chars[i] + chars[i + 1])
  return set
}

/**
 * 纸条和这句话至少有两个汉字二元组重合，才算「纸上写着这件事」。
 * 2026-11-27 真机（issue #20 回放）：她说「我们说的那句『看了才算数』」，纸条里一条
 * 「他说的」只跟这句话共一个「说的」，就被当成相关、于是没翻账本——真正那晚的记录
 * 没递到她手边，她只好自己 her_recall。常见的两个字重合不算写着这件事。
 */
function relatedNotes(notes, heard) {
  const grams = bigrams(heard)
  if (!grams.size) return []
  const out = []
  for (const n of notes ?? []) {
    let hits = 0
    for (const g of bigrams(n.text)) if (grams.has(g)) hits += 1
    if (hits >= 2) out.push(n)
  }
  return out
}

/** 拼成她读的那一段。超预算就从最后一条开始丢——宁可少带，不许带不完。 */
function assemble(lines, items, source, maxTokens) {
  const keptLines = [...lines]
  const keptItems = [...items]
  const fit = () => {
    const text = [HEADER, ...keptLines, FOOTER].join('\n')
    return { text, tokens: estimateTokens(text) }
  }
  let out = fit()
  while (keptLines.length && (out.tokens > maxTokens || out.text.length > PREFETCH_CHARS)) {
    keptLines.pop()
    keptItems.pop()
    out = fit()
  }
  if (!keptLines.length) return null
  return { text: out.text, count: keptLines.length, tokens: out.tokens, chars: out.text.length, source, items: keptItems }
}

function speakerOf(type) {
  return ({
    heard: '他说', diary: '她那天写', answer: '她答过', revise: '她改口',
    refusal: '她拒绝过', reunion: '重逢时她说过', narration: '她自述过',
  })[type] ?? '她说过'
}

/** 纸条优先：纸上有相关项就直接带纸，不查账本。新的优先，最多两条。 */
async function fromNotes(root, heard, maxTokens) {
  const notes = await readNotes(root).catch(() => [])
  const related = relatedNotes(notes, heard).slice(-2).reverse()
  if (!related.length) return null
  const lines = related.map((n) => {
    const when = n.at ? `${monthDay(n.at)} ` : ''
    const id = n.id ? `（${n.id}）` : ''
    return `- ${when}纸上记着：${shorten(n.text, 60)}${id}`
  })
  return assemble(lines, related.map((n, i) => ({ id: n.id, at: n.at, line: lines[i] })), 'notes', maxTokens)
}

/** 账本检索。参数固定（ranked / 固定 limit / 同一 now），同一 query 结果稳定。 */
async function fromLedger(root, heard, o) {
  const query = cleanHeard(heard).slice(0, PREFETCH_QUERY_MAX)
  if (!query) return null
  const { events } = await readEventsCached(root)
  const { rows } = searchEvents(events, query, { limit: PREFETCH_LIMIT, mode: 'ranked', now: o.now })
  let picked = (rows ?? []).filter((r) => r?.id && PREFETCH_TYPES.has(String(r.type ?? '')) && String(r.text ?? '').trim() !== query)
  if (!picked.length) return null
  // 触发 4：她要做与成长有关的判断，先摆她自己的判断与承诺。
  if (o.triggers?.includes('growth')) {
    picked = [...picked.filter((r) => HER_OWN_TYPES.has(String(r.type ?? ''))), ...picked.filter((r) => !HER_OWN_TYPES.has(String(r.type ?? '')))]
  }
  picked = picked.slice(0, PREFETCH_MAX)
  const lines = picked.map((r, i) => `- ${r.date.slice(5)}${i === 0 ? '（可能相关）' : ''} ${speakerOf(r.type)}：${shorten(r.text, 52)}（${r.id}）`)
  const items = picked.map((r, i) => {
    const at = Date.parse(`${r.date}T00:00:00`)
    return { id: r.id, at: Number.isFinite(at) ? at : 0, line: lines[i] }
  })
  return assemble(lines, items, 'ledger', o.maxTokens)
}

/**
 * 这一轮要不要预取；要就返回渲染好的一段，不要就 null。永不抛：
 * 预取失败只是少一段线索，不能耽误她回话。
 */
export async function prefetchFor(root, heard, o = {}) {
  try {
    const maxTokens = Number(o.maxTokens) > 0 ? Number(o.maxTokens) : PREFETCH_TOKENS
    const text = cleanHeard(heard)
    if (!text) return null
    let names = Array.isArray(o.names) ? o.names : null
    if (!names) names = (await createPeople(root).list().catch(() => [])).map((p) => p?.name).filter(Boolean)
    const triggers = prefetchTriggers(text, { names })
    if (!triggers.length) return null
    const now = Number(o.now) || Date.now()
    return (await fromNotes(root, text, maxTokens)) ?? (await fromLedger(root, text, { now, maxTokens, triggers }))
  } catch {
    return null
  }
}
