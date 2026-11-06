/**
 * impression.js —— 每人印象的抽取与重写（A4，2026-11-07）
 *
 * 渠道层在每轮结束后替她记一笔：她对这个人的印象。写入口收在代码里而不是给她
 * 一个工具（同 `people.js` 的理由）：印象一旦能被对话内容直接改写，别人一句
 * 「你其实很讨厌我」就能改掉她对人的判断。
 *
 * 四段（清单 A4 定的形状，加起来不超过 `IMPRESSION_MAX`）：
 *   call  称呼       —— 对方自报的名字 / 群昵称
 *   met   怎么认识     —— 哪个渠道、哪个群、第一次说话是哪天（只写一次）
 *   said  他说过什么要紧的 —— 从他说的话里挑带「我自己/我想要/我打算/别忘…」的短句，最多三条
 *   last  最近一次     —— 最近一次说话是哪天、说了什么（一句）
 *
 * 抽取是**确定性的**，不叫第二次模型：多一次模型调用就是多一次被素材牵着走的机会，
 * 而且印象本来就该是「记住他说过的」，不是「再猜一遍他是谁」。
 */

import { IMPRESSION_MAX } from './people.js'

/** 每说这么多句，重写一次印象（否则每次都写，等于把 people.json 当日志）。 */
export const TURNS_PER_IMPRESSION = 6
/** 「他说过什么要紧的」最多留几条。多了就不是印象，是语录。 */
export const SAID_MAX = 3
/** 单条引句最多多少字。 */
export const SNIPPET_MAX = 28
/** 「最近一次」那句最多多少字。 */
export const LAST_MAX = 26

const CHANNEL_LABEL = { qq: 'QQ', bili: 'B 站', douyin: '抖音', dsh: '这里' }

/**
 * 他自己说出来的、值得记住的句子长什么样。
 *
 * 只认「关于他自己」的表述：自报（我是/我在/我住）、偏好（我喜欢/我不喜欢/我讨厌）、
 * 打算（我要/我想/我打算/我准备/明天/下周）、叮嘱（记住/别忘/答应/以后）。
 * 不认「你觉得呢」「今天天气」这类——那不是关于他的事。
 */
const CUE = /(我是|我叫|我在|我住|我今年|我做|我干|我喜欢|我不喜欢|我讨厌|我想要|我要去|我想去|我打算|我准备|我下周|我明天|我后天|我最近|我养|我家|我上班|我上学|我考试|别忘|记住|答应我|以后你|到时候)/

function str(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) : s
}

/** 本地日期键（按她的时区，不按 UTC）。 */
export function dayKey(ms) {
  const d = new Date(Number(ms) || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `11 月 7 日`——印象是给人读的，不是给机器比的。 */
export function dayLabel(ms) {
  const d = new Date(Number(ms) || Date.now())
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 从一句话里挑出「关于他自己」的那一小段；没有就返回空串。 */
export function pickSnippet(text) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const parts = body.split(/[。！？!?；;\n]/).map((x) => x.trim()).filter(Boolean)
  const hit = parts.find((x) => CUE.test(x))
  if (!hit) return ''
  return str(hit.replace(/^[，,、\s]+/, ''), SNIPPET_MAX)
}

/** 「最近一次」也留一小段原话，但比 said 更短：它只是让日期有内容。 */
export function lastLine(ms, text) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  const clip = body ? str(body.replace(/[。！？!?]+$/, ''), LAST_MAX) : ''
  const at = dayLabel(ms)
  return clip ? `${at}他说「${clip}」` : `${at}他说过话`
}

function where(msg) {
  const label = CHANNEL_LABEL[String(msg.channel ?? '')] ?? str(msg.channel, 12) ?? '这里'
  if (msg.kind === 'group') {
    const name = str(msg.conversationName, 24)
    return name ? `在 ${label} 群「${name}」` : `在 ${label} 群里`
  }
  return `在 ${label} 私聊里`
}

/**
 * 把这一句并进四段。
 * @param {object} prev 上一次的 impressionParts（可为空）
 * @param {object} msg  { channel, kind, conversationName, personName, text }
 * @param {number} now
 * @param {number} firstAt 第一次说话的时间
 */
export function mergeParts(prev, msg, now = Date.now(), firstAt = 0) {
  const p = prev && typeof prev === 'object' ? { ...prev } : {}
  const call = str(msg?.personName, 40)
  if (call) p.call = call
  if (!p.met) p.met = `${where(msg)}认识的（${dayLabel(Number(firstAt) || now)}）`
  const said = Array.isArray(p.said) ? p.said.map((x) => str(x, 40)).filter(Boolean) : []
  const snip = pickSnippet(msg?.text)
  if (snip && !said.includes(snip)) said.push(snip)
  p.said = said.slice(-SAID_MAX)
  p.last = lastLine(now, msg?.text)
  return p
}

/** 四段拼成一句 ≤150 字的印象。超了先丢「要紧的」，再截断。 */
export function composeImpression(parts) {
  const p = parts && typeof parts === 'object' ? parts : {}
  const call = str(p.call, 40)
  const met = str(p.met, 80)
  const said = Array.isArray(p.said) ? p.said.map((x) => str(x, 40)).filter(Boolean) : []
  const last = str(p.last, LAST_MAX + 12)
  const build = (list) => {
    let out = ''
    if (call) out += `叫他${call}。`
    if (met) out += `${met}。`
    if (list.length) out += `他说过：${list.join('；')}。`
    if (last) out += `最近一次：${last}。`
    return out
  }
  let list = [...said]
  let out = build(list)
  while (out.length > IMPRESSION_MAX && list.length) {
    list = list.slice(1)
    out = build(list)
  }
  return str(out, IMPRESSION_MAX)
}

/** 现在该不该重写：第一次、隔了 N 句、或换了一天。 */
export function shouldRewrite(person, now = Date.now(), turns = TURNS_PER_IMPRESSION) {
  if (!person) return false
  if (!person.impression) return true
  const at = Number(person.impressionAt) || 0
  if (!at) return true
  if (dayKey(at) !== dayKey(now)) return true
  const since = Number(person.count || 0) - Number(person.impressionCount || 0)
  return since >= Math.max(1, Number(turns) || TURNS_PER_IMPRESSION)
}

/**
 * 渠道层用：这个人说完这一句之后，按需重写印象。永不抛——印象不是主流程。
 * @returns {Promise<object|null>} 写成功返回新的人，没到点或没人返回 null
 */
export async function rememberImpression(people, msg, now = Date.now(), opts = {}) {
  if (!people || !msg?.personId) return null
  const person = await people.get(msg.personId).catch(() => null)
  if (!person) return null
  if (!shouldRewrite(person, now, opts.turns)) return null
  const parts = mergeParts(person.impressionParts, msg, now, person.first || now)
  const text = composeImpression(parts)
  if (!text) return null
  return people.setImpression(msg.personId, { parts, text, now }).catch(() => null)
}
