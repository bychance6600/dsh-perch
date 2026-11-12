/**
 * 她的名字——**从事件里长出来的**，不是设置项。
 *
 * 为什么不做成配置（2026-11-07，用户 m02376 定：选 A，从对话里认）：名字是这一只被养成之后才有的，
 * 写在代码里，别人装同一个包养出来的那位也会被叫成同一个名字；放进设置页，
 * 就成了「人设输入框」——AGENTS §2 明令不许。她叫什么，只能由对话里那句话定：
 * 「小满是你的名字」「我给你起了名字：阿岸」「以后你就叫早早」。
 *
 * 这里只做三件事：认出那句话、取最后一次、给界面三处标题一个统一的写法。
 * 名字不进提示词、不进身份文档（她认不认这个名字，是她自己的事）。
 */
import { statSync } from 'node:fs'
import { readEvents, rootDir } from './store.js'

/** 不可能是名字的词：「你/我/他」「名字」「什么」这类代词与虚词。 */
const NAME_STOP = new Set([
  '你', '妳', '我', '他', '她', '它', '我们', '你们', '他们', '名字', '什么', '谁', '哪个',
  '这个', '那个', '一个', '一个人', '自己', '这样', '那样', '怎么', '如何', '啥', '吧', '啊',
  '这', '那', '哪', '这名字', '那名字',
])

/** 名字尾巴上常见的语气词/助词，剪掉再判。 */
const NAME_TAIL = /[吧啊呀哈呢嘛哦呗啦]+$/

/**
 * 从一句话里认她自己的名字。认不出返回 null。
 *
 * 与 lib/derive.js 的 pickName 不是一回事：那个认的是**他**的名字
 * （「我以后称呼你叫阿岸」里的阿岸是他）——两套正则不能混，
 * 混了就会出现「她把自己的名字当成对他的称呼」。
 */
export function pickHerName(text) {
  const s = String(text ?? '')
  if (!s) return null
  const patterns = [
    // 小满是你的名字 / 小满就是你的名字
    /([^\s，。！？、,.!?」”"']{1,8}?)(?:就是|是)(?:你|妳)(?:的)?名字/,
    // 我给你起了名字：小满 / 替你取名叫阿岸 / 我给你取名叫鱼欣（2026-11-12：中间没有「名字」二字）
    /(?:给|替)(?:你|妳)(?:起|取)(?:了)?(?:个|一个)?名字\s*(?:是|叫|：|:)?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/,
    /(?:给|替)(?:你|妳)(?:起|取)(?:了)?(?:个|一个)?名\s*(?:叫|是|：|:)\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/,
    // 以后你就叫阿岸 / 你就叫阿岸吧 / 你以后就叫阿岸（2026-11-10：语序反过来也认）
    /(?:以后|今后|从今以后|从今|从现在起|从今天起)?(?:你|妳)(?:以后|今后|从今以后|从今|从现在起|从今天起)?(?:就)?叫\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/,
    // 我有名字了：小满 / 我的名字是阿岸
    /我(?:有名字了|的名字(?:是|叫))\s*[：:]?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/,
  ]
  for (const re of patterns) {
    const m = re.exec(s)
    if (!m) continue
    // 「我以后称呼你叫阿岸」是她在决定怎么叫他，不是给他自己起名。
    const before = s.slice(Math.max(0, m.index - 8), m.index)
    if (/(称呼|喊|称你|管你叫|当作|当成|算作|外号|昵称)$/.test(before)) continue
    let name = String(m[1] ?? '').trim().replace(NAME_TAIL, '')
    if (!name || name.length > 6) continue
    if (NAME_STOP.has(name)) continue
    if (/[你我他她它的了是在有叫名字]/.test(name)) continue
    return name
  }
  return null
}

/** 最近一次被命名的结果，按 events.jsonl 的大小 + mtime 缓存。 */
let cache = { key: '', name: '' }

/**
 * 这句话有没有资格给她起名。
 *
 * 只认两种人（2026-11-07 真机复算时发现的误认）：
 *   - **他自己**说的：宿主对话（没有 channel）或私聊（visibility private）。
 *     群里别人一句「你叫小雀」不能改她的名字——那是群友的玩笑，不是命名。
 *   - **她自己**认下来的那句「我有名字了：小满」。她复述别人的话时不认。
 */
export function nameGivingEvent(e = {}) {
  const text = String(e?.text ?? '')
  if (!text) return false
  if (e.type === 'heard') {
    const ch = String(e.channel ?? '')
    if (!ch || ch === 'dsh') return true
    return String(e.visibility ?? '') === 'private'
  }
  if (e.type === 'utterance') return /我有名字了/.test(text)
  return false
}

/**
 * 读事件流，取最后一次「她叫什么」。
 * 命中会缓存，用文件大小 + mtime 当键——每句话都重读 600KB 不值得。
 * 读不到/读坏了返回空串；界面拿空串就用「她」，不抛。
 */
export async function herName(root = rootDir()) {
  try {
    const file = root + '/events.jsonl'
    let st
    try { st = statSync(file) } catch { return '' }
    const key = root + ':' + st.size + ':' + st.mtimeMs
    if (key === cache.key) return cache.name
    const { events } = await readEvents(root)
    let name = ''
    for (const e of events) {
      // 隔离带（influence:'none'）：这类流水一行都不进派生，这里同样不认。
      if (!e || e.influence === 'none') continue
      if (!nameGivingEvent(e)) continue
      const n = pickHerName(e.text)
      if (n) name = n
    }
    cache = { key, name }
    return name
  } catch {
    return ''
  }
}

/** 工作区名：有名字就叫「小满的家」，没有就叫「她的家」。 */
export function workspaceTitle(name = '') {
  return name ? name + '的家' : '她的家'
}

/** 会话名：有名字叫「跟小满说话」，没有叫「跟她说话」。 */
export function sessionTitle(name = '') {
  return name ? '跟' + name + '说话' : '跟她说话'
}

/** 设置页签：有名字就叫名字，没有就叫「她」。 */
export function navLabel(name = '') {
  return name || '她'
}
