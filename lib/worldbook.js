/**
 * worldbook.js —— 「她知道的事」
 *
 * 一句话：这是**知识**，不是人格。
 *
 * 为什么单独一层：世界书（SillyTavern 的 World Info / Lorebook）里装的通常是
 * 「她住的城市叫临江」「公司三楼有个茶水间」这类**事实**。事实可以给，
 * 而「她是什么样的人」不能给——后者只能从事件里长出来（见 AGENTS.md §2）。
 *
 * 三条边界，写代码时别越：
 *   1. **只进提示词的「你知道的事」一节，不进身份文档的自我描述**。
 *      写进身份文档就等于写了「你是谁」，那是人格配置。
 *   2. **不改阶段、不进 beliefs、不算事件**。查一条设定不是一段经历。
 *   3. **匹配靠关键词，不靠模型**。这样她记得什么、为什么记得，都能解释。
 *
 * 0.2.2（2026-11-14，主人拍板）：降级成**可选事实卡**——一轮最多带 2 条、共 600 字，
 * 标题写「你知道的事（用不上就不用）」。一本大部头不能吃掉一轮上下文。
 * 导入时查重：同一份世界书连续导入两次，第二次不该多出一条（added = 0）。
 *
 * 存储：`<root>/worldbook.json`，0600，一次原子写。
 * 格式：{ version: 1, entries: [{ id, keys: string[], text: string, enabled: boolean, at: number }] }
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { writeAtomic, readJson } from './store.js'
// 二元组 Dice 复用 derive 的那一套：查重口径与「新话 / 跨情境一致」用同一个实现，
// 免得世界书里一套、判断里又一套。derive 不依赖 worldbook，不会成环。
import { similarity } from './derive.js'

export const WORLDBOOK_FILE = 'worldbook.json'
export const ENTRIES_MAX = 500
export const KEYS_MAX = 24
export const KEY_MAX = 64
export const TEXT_MAX = 2000
/**
 * 一次最多挑几条、共多少字——防止一本大部头把一轮上下文吃光。
 *
 * 0.2.2（2026-11-14）从 5 条 / 1200 字降到 2 条 / 600 字：世界书是「知道的事」，
 * 不是这一轮的必答题。用不上就不用，别让一本导入的设定集压过这一轮真正在说的话。
 */
export const MATCH_MAX = 2
export const MATCH_CHARS = 600

/**
 * 导入查重的门槛（2026-11-14）。
 *
 * 两条算「同一条事实」要同时满足：
 *   · keys 交集 / 并集 ≥ 0.8（触发词几乎是同一组）
 *   · 正文二元组 Dice ≥ 0.6（同一件事换了个说法；0.45 是「遗忘」的宽松档，这里要紧一点）
 * 正文归一化（去首尾、连续空白压成一个）完全相同则直接算重复，不看门槛。
 */
export const DUP_KEYS_OVERLAP = 0.8
export const DUP_TEXT_SIM = 0.6

/**
 * 作息归设置管，不归世界书管（2026-11-07，用户 m07965）。
 *
 * 世界书是一次性导入的静态文本；设置是活的。她原来在世界书里读到
 * 「晚上八点到十一点醒着，一天两次」，就把它当事实背，设置里的
 * 08:00–23:00 / 三次完全压不过它。这里把这类条目挡在两层之外：
 * 身份文档用 config 现算，对话里也不从世界书取。
 *
 * 只挡「作息/几点/睡/醒」这类明确的时间表条目；「她睡觉很轻」这种
 * 不带钟点/次数的性格事实仍然留着。
 */
const SETTING_KEYS = new Set(['作息', '几点', '睡觉', '睡眠', '起床', '醒来', '叫醒', '醒着', '时间表'])
const SETTING_TEXT = /(醒着|叫醒|作息|睡觉|起床|睡眠).{0,16}(点|次|小时|早|晚|上午|下午|晚上)/

export function isSettingOwned(entry) {
  const keys = Array.isArray(entry?.keys) ? entry.keys : []
  if (keys.some((k) => SETTING_KEYS.has(String(k).trim()))) return true
  return SETTING_TEXT.test(String(entry?.text ?? ''))
}

const fileOf = (root) => path.join(root, WORLDBOOK_FILE)

const str = (v) => (typeof v === 'string' ? v : '')
const clean = (s) => str(s).replace(/\r\n/g, '\n').trim()

let seq = 0
function newId() {
  seq = (seq + 1) % 1e6
  return `w${Date.now().toString(36)}${seq.toString(36)}`
}

/** 把一条外来条目收拾成内部形状；收拾不出来就返回 null。 */
function tidyEntry(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const keys = []
  const push = (k) => {
    const s = clean(k).slice(0, KEY_MAX)
    if (s && !keys.includes(s)) keys.push(s)
  }
  if (Array.isArray(raw.keys)) raw.keys.forEach(push)
  else if (Array.isArray(raw.key)) raw.key.forEach(push)
  else if (typeof raw.keys === 'string') raw.keys.split(/[,，、]/).forEach(push)
  else if (typeof raw.key === 'string') raw.key.split(/[,，、]/).forEach(push)

  const text = clean(raw.text ?? raw.content ?? '').slice(0, TEXT_MAX)
  if (!text) return null
  if (!keys.length) return null

  return {
    id: clean(raw.id).slice(0, 40) || newId(),
    keys: keys.slice(0, KEYS_MAX),
    text,
    enabled: raw.enabled === false || raw.disable === true ? false : true,
    at: Number(raw.at) > 0 ? Number(raw.at) : now,
  }
}

/** 查重用的正文归一化：去首尾，把连续空白压成一个空格。 */
const normText = (s) => str(s).replace(/\s+/g, ' ').trim()
/** 查重用的关键词归一化：同样去空白，并忽略大小写。 */
const normKey = (k) => normText(k).toLowerCase()

/** 两组 keys 的 Jaccard（交集 / 并集）。有一边为空就算 0。 */
function keysOverlap(a, b) {
  const A = new Set((Array.isArray(a) ? a : []).map(normKey).filter(Boolean))
  const B = new Set((Array.isArray(b) ? b : []).map(normKey).filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const k of A) if (B.has(k)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 两条算不算「同一条事实」：触发词高度重叠，正文说得也像。 */
function sameFact(a, b) {
  return keysOverlap(a?.keys, b?.keys) >= DUP_KEYS_OVERLAP
    && similarity(normText(a?.text), normText(b?.text)) >= DUP_TEXT_SIM
}

/**
 * 合并同一条事实：keys 取并集（保留已有那条的写法与先后），正文留更长的那条；
 * 其余字段（id / at / enabled）沿用已有的——她原来就知道的那条不该被导入改掉身份。
 */
function mergeEntries(cur, next) {
  const keys = []
  const push = (k) => {
    const s = normText(k)
    if (s && !keys.some((x) => normKey(x) === normKey(s))) keys.push(s)
  }
  for (const k of [...(cur.keys ?? []), ...(next.keys ?? [])]) push(k)
  const longer = str(next.text).length > str(cur.text).length ? next.text : cur.text
  return { ...cur, keys: keys.slice(0, KEYS_MAX), text: String(longer).slice(0, TEXT_MAX) }
}

/**
 * 把一条条目折进一本书里：正文归一化后完全相同 → skipped；
 * 同一条事实换个说法 → 并进旧条目；都不是 → 新增。
 * @returns {'added'|'skipped'|'merged'}
 */
function foldEntry(book, t) {
  const nt = normText(t.text)
  if (book.some((e) => normText(e.text) === nt)) return 'skipped'
  const i = book.findIndex((e) => sameFact(e, t))
  if (i >= 0) {
    book[i] = mergeEntries(book[i], t)
    return 'merged'
  }
  book.push(t)
  return 'added'
}

/**
 * 导入 SillyTavern 世界书（两种格式都认）：
 *   · 角色卡里那种 `{ entries: { "0": { key: [...], content, disable } } }`
 *   · 也可能是数组 `[{ key, content }]`
 * 认不出来的条目直接丢，不抛——导入失败不该让整个面板 500。
 *
 * 查重（2026-11-14，0.2.2）：可以传一本已有的册子进来（比如 `wb.list()`），
 * 同一份世界书连续导入两次时第二次 added 为 0：
 *   · 正文归一化（去首尾、连续空白压成一个）完全相同 → skipped
 *   · keys 交集/并集 ≥ 0.8 且正文二元组 Dice 相似 → 合并 keys、保留更长正文，merged++
 * 不传 existing 时就只在这一次导入的条目之间查重；写库时的查重由 createWorldbook().add 兜住。
 *
 * @param {any} raw
 * @param {Array} [existing] 已经在这本册子里的条目
 * @returns {{ ok: boolean, entries: Array, added: number, skipped: number, merged: number, dropped: number, why: string }}
 *   entries 是这次要写进去的（新增的 + 被合并升级的旧条目）；dropped 是认不出来的条数。
 */
export function importLorebook(raw, existing = []) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    const e = raw.entries ?? raw.Entries ?? raw.items
    if (Array.isArray(e)) list = e
    else if (e && typeof e === 'object') list = Object.values(e)
  }

  // 已有条目只当查重底册；只有被合并 / 新增的才需要写回，所以单独记 touched。
  const book = (Array.isArray(existing) ? existing : [])
    .filter((e) => e && typeof e === 'object' && Array.isArray(e.keys) && typeof e.text === 'string' && e.text)
    .map((e) => ({ ...e, keys: [...e.keys] }))
  const touched = new Set()
  let added = 0
  let skipped = 0
  let merged = 0
  let dropped = 0
  let parsed = 0

  for (const item of list) {
    const t = tidyEntry(item)
    if (!t) {
      dropped += 1
      continue
    }
    parsed += 1
    const at = book.findIndex((e) => normText(e.text) === normText(t.text))
    if (at >= 0) {
      skipped += 1
      continue
    }
    const near = book.findIndex((e) => sameFact(e, t))
    if (near >= 0) {
      book[near] = mergeEntries(book[near], t)
      touched.add(near)
      merged += 1
      continue
    }
    book.push(t)
    touched.add(book.length - 1)
    added += 1
    if (added >= ENTRIES_MAX) break
  }

  return {
    ok: parsed > 0,
    entries: [...touched].sort((a, b) => a - b).map((i) => book[i]),
    added,
    skipped,
    merged,
    dropped,
    why: parsed > 0 ? '' : '没读出一条带关键词和正文的设定',
  }
}

/** 把一段文本里命中的设定挑出来。纯函数，方便测试。 */
export function matchEntries(entries, text, { limit = MATCH_MAX, chars = MATCH_CHARS } = {}) {
  const hay = clean(text).toLowerCase()
  if (!hay) return []
  const hits = []
  for (const e of entries) {
    if (!e || e.enabled === false || isSettingOwned(e)) continue
    const key = e.keys.find((k) => k && hay.includes(String(k).toLowerCase()))
    if (!key) continue
    hits.push({ entry: e, key })
  }
  // 关键词越长越具体：先给「临江三中」这类，再给「学校」这类。
  hits.sort((a, b) => b.key.length - a.key.length || b.entry.at - a.entry.at)

  const out = []
  let used = 0
  for (const h of hits) {
    if (out.length >= limit) break
    const room = chars - used
    if (room <= 0) break
    const text2 = h.entry.text.length > room ? `${h.entry.text.slice(0, Math.max(0, room - 1))}…` : h.entry.text
    out.push({ id: h.entry.id, keys: h.entry.keys, text: text2, key: h.key })
    used += text2.length
  }
  return out
}

/**
 * 打开（或初始化）一本世界书。
 * 只读路径不建文件：没导入过就是空册子，不该在数据目录里留个空文件。
 */
export function createWorldbook(root) {
  let cache = null
  let cacheAt = -1

  async function load() {
    let st = null
    try {
      st = await fs.stat(fileOf(root))
    } catch {
      return { version: 1, entries: [] }
    }
    if (cache && cacheAt === st.mtimeMs) return cache
    const raw = await readJson(fileOf(root), { version: 1, entries: [] })
    const entries = Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e === 'object') : []
    cache = { version: 1, entries }
    cacheAt = st.mtimeMs
    return cache
  }

  async function save(entries) {
    const body = JSON.stringify({ version: 1, entries }, null, 2)
    await writeAtomic(fileOf(root), body, 0o600)
    cache = null
    cacheAt = -1
    return { ok: true, count: entries.length }
  }

  return {
    /** 全部条目（管理面板用）。 */
    async list() {
      const b = await load()
      return b.entries.map((e) => ({ ...e }))
    },

    /** 按一段话挑设定（回复用）。 */
    async match(text, opts) {
      const b = await load()
      return matchEntries(b.entries, text, opts)
    },

    /** 整本替换（导入用）。旧的全丢——导入是"这本册子现在是这样"。 */
    async replace(entries) {
      const book = []
      let added = 0
      let skipped = 0
      let merged = 0
      for (const e of Array.isArray(entries) ? entries : []) {
        const t = tidyEntry(e)
        if (!t) continue
        const r = foldEntry(book, t)
        if (r === 'added') {
          added += 1
          if (added >= ENTRIES_MAX) break
        } else if (r === 'skipped') skipped += 1
        else merged += 1
      }
      return { ...(await save(book)), added, skipped, merged }
    },

    /**
     * 追加（不全量覆盖，导入多本时可以叠加）。
     * 查重口径与 importLorebook 相同：正文归一化后一样 → skipped；同一条事实换个说法 →
     * 合并进旧条目；否则新增。同一份世界书连着导入两次，第二次 added 是 0。
     */
    async add(entries) {
      const b = await load()
      const book = b.entries.map((e) => ({ ...e, keys: [...(e.keys ?? [])] }))
      let added = 0
      let skipped = 0
      let merged = 0
      for (const e of Array.isArray(entries) ? entries : []) {
        const t = tidyEntry(e)
        if (!t) continue
        // 同一个 id 就是同一条（importLorebook 合并旧条目后会用原 id 写回）：换代，不重复加。
        const byId = book.findIndex((x) => x.id === t.id)
        if (byId >= 0) {
          book[byId] = t
          continue
        }
        if (book.length >= ENTRIES_MAX) break
        const r = foldEntry(book, t)
        if (r === 'added') added += 1
        else if (r === 'skipped') skipped += 1
        else merged += 1
      }
      return { ...(await save(book)), added, skipped, merged }
    },

    async remove(id) {
      const b = await load()
      const left = b.entries.filter((e) => e.id !== id)
      return save(left)
    },

    async clear() {
      return save([])
    },

    async stats() {
      const b = await load()
      return {
        count: b.entries.length,
        enabled: b.entries.filter((e) => e.enabled !== false).length,
        chars: b.entries.reduce((n, e) => n + str(e.text).length, 0),
      }
    },
  }
}

/**
 * 提示词里「你知道的事」那一节。
 *
 * 0.2.2（2026-11-14）：从「这些是事实，不是要求」改成「用不上就不用」——
 * 世界书降级成可选事实卡，不是这一轮必须提到的东西。
 * 只写事实，不写「你是一个……」；没有命中就什么都不加。
 */
export function knowledgeBlock(matches) {
  const list = (matches ?? []).filter((m) => m && m.text)
  if (!list.length) return ''
  const out = ['', '（你知道的事（用不上就不用）：']
  for (const m of list) out.push(`· ${m.text}`)
  out.push('这些只是你听过的事实，不是你要主动提的话题。）')
  return out.join('\n')
}
