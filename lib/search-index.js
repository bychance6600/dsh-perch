/**
 * search-index.js —— 召回用的 BM25 索引（P3）
 *
 * 账本是唯一真相；这里只是从账本临时算出来的一份索引，不落盘、不读盘。
 * 索引的缓存键是「事件条数:最后一条事件 id」：账本一追加，键就变，下一次
 * 调用自然重建。不按时间失效——时间过了但账本没变，重建没有意义。
 *
 * 中文没有空格：文档按连续汉字段切二字组，英文按单词切。同义词在查询和
 * 文档两侧都展开（见 synonyms.js），所以「不开心」既能翻到「难过」，
 * 「难过」也能翻到「不开心」。
 */

import { SYNONYM_KEYS, SYNONYMS } from './synonyms.js'
import { stripPromptEcho, stripScaffold } from './guard.js'

/** BM25 参数：k1 控制词频饱和，b 控制文档长度归一。 */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

/** 只去这些单字；二字组不按字拆开过滤，避免「我在家」整段消失。 */
const STOP = new Set(['的', '了', '是', '在', '我', '有', '你', '他', '她', '它', '们', '和', '就', '都'])

/** 从一段文本里抽可索引的词；返回值可重复，供 tf 统计。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  if (!s) return []
  const out = []
  for (const m of s.matchAll(/[\u3400-\u9fff]+|[a-z0-9]+/g)) {
    const run = m[0]
    if (/^[a-z0-9]+$/.test(run)) {
      out.push(run)
      continue
    }
    if (run.length === 1) {
      if (!STOP.has(run)) out.push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const gram = run.slice(i, i + 2)
      if (!STOP.has(gram)) out.push(gram)
    }
  }
  return out
}

/**
 * 同义词展开：在中文段上做最长匹配，命中后把归一后的词（及其二字组）
 * 加进词集，并跳过整个命中的说法。查询与文档共用这一份。
 */
export function synonymTerms(text) {
  const s = String(text ?? '').toLowerCase()
  if (!s) return []
  const out = new Set()
  for (const m of s.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = m[0]
    for (let i = 0; i < run.length;) {
      let hit = ''
      for (const key of SYNONYM_KEYS) {
        if (run.startsWith(key, i)) { hit = key; break }
      }
      if (!hit) { i += 1; continue }
      const canonical = SYNONYMS.get(hit)
      if (canonical) {
        out.add(canonical)
        for (const t of tokenize(canonical)) out.add(t)
      }
      i += hit.length
    }
  }
  return [...out]
}

/** 查询词：普通切词 + 同义词展开，去重。 */
export function queryTerms(query) {
  const out = new Set(tokenize(query))
  for (const t of synonymTerms(query)) out.add(t)
  return [...out]
}

/** 缓存键只认账本本身：条数与最后一条 id。 */
export function indexKey(events = []) {
  const list = Array.isArray(events) ? events : []
  const last = list.length ? String(list[list.length - 1]?.id ?? '') : ''
  return `${list.length}:${last}`
}

let cache = { key: null, index: null }

/**
 * 从事件流建索引。跳过 meta、空文本、重复 id。
 * 同一份账本重复调用返回同一个对象；账本追加一条后返回新对象。
 */
export function buildIndex(events = []) {
  const list = Array.isArray(events) ? events : []
  const key = indexKey(list)
  if (cache.key === key && cache.index) return cache.index

  const postings = new Map()
  const lengths = new Map()
  const df = new Map()
  const seen = new Set()
  let docs = 0
  let totalLength = 0

  for (const ev of list) {
    if (!ev || ev.type === 'meta') continue
    const id = String(ev.id ?? '')
    if (!id || seen.has(id)) continue
    const text = stripScaffold(stripPromptEcho(ev.text))
    if (!text) continue
    const terms = [...tokenize(text), ...synonymTerms(text)]
    if (!terms.length) continue

    const tf = new Map()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)

    seen.add(id)
    lengths.set(id, terms.length)
    docs += 1
    totalLength += terms.length
    for (const [t, n] of tf) {
      if (!postings.has(t)) {
        postings.set(t, [])
        df.set(t, 0)
      }
      postings.get(t).push({ id, tf: n })
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }

  const index = {
    key,
    postings,
    lengths,
    df,
    avgdl: docs ? totalLength / docs : 0,
    N: docs,
    k1: BM25_K1,
    b: BM25_B,
  }
  cache = { key, index }
  return index
}

/**
 * 查询打分：返回 Map<事件 id, BM25 分>。空查询、没有命中的词返回空 Map。
 * 只算相关性；solid / refs 的显著性加权留在 recall.js，避免两处各算一套。
 */
export function scoreQuery(index, query) {
  const scores = new Map()
  if (!index || !(index.postings instanceof Map)) return scores
  const N = Number(index.N) || 0
  if (!N) return scores
  const avgdl = Number(index.avgdl) || 0
  const k1 = Number(index.k1) || BM25_K1
  const b = Number(index.b) || BM25_B
  const terms = queryTerms(query)

  for (const term of terms) {
    const df = Number(index.df.get(term) ?? 0)
    if (!df) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const { id, tf } of index.postings.get(term) ?? []) {
      const dl = Number(index.lengths.get(id) ?? 0)
      const norm = avgdl ? dl / avgdl : 0
      const denom = tf + k1 * (1 - b + b * norm)
      if (!(denom > 0)) continue
      const add = idf * (tf * (k1 + 1)) / denom
      scores.set(id, (scores.get(id) ?? 0) + add)
    }
  }
  return scores
}
