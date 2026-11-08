/**
 * pet/mirror.js —— 她说过的话，变成桌宠的气泡
 *
 * 只镜像、不改写：标点原样，不合并、不润色。一条消息一次推送，
 * 同 id + seq 只推一次；不推工具回显、界面状态行，也不推叫醒轮里
 * 那句很短的自言自语（turns.js 的 WAKE_SAY_MIN 口径）。
 */

import { assistantText } from '../turns.js'

export const SAY_MAX = 200
/** 叫醒轮里短于这个字的句子不冒泡（与 turns.js 的 WAKE_SAY_MIN 对齐）。 */
export const WAKE_SAY_MIN = 10
export const QUEUE_MAX = 20

const SPLIT_RE = /[^。！？!?；;\n]+[。！？!?；;]?|[。！？!?；;]/g

/**
 * 按句号/问号/叹号/分号/换行切；每块不超过 max 字。
 * 超长时优先在逗号、顿号处再切；仍超长才硬切。标点不改。
 */
export function splitSay(text, max = SAY_MAX) {
  const s = String(text ?? '')
  if (!s.trim()) return []
  const out = []
  for (const raw of s.match(SPLIT_RE) ?? []) {
    let rest = raw
    while (rest.length > max) {
      const window = rest.slice(0, max)
      const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(','))
      const take = cut > 0 ? cut + 1 : max
      out.push(rest.slice(0, take))
      rest = rest.slice(take)
    }
    if (rest) out.push(rest)
  }
  return out.filter((x) => x.trim())
}

/**
 * 背压队列：一条没 ack 前不发下一条；8 秒没 ack 就丢掉，不重发。
 *
 * @param {{send:(msg:object)=>boolean|void, log?:Function, ackTimeoutMs?:number, now?:Function}} deps
 */
export function createMirror(deps = {}) {
  const send = typeof deps.send === 'function' ? deps.send : () => false
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const ackTimeoutMs = Number(deps.ackTimeoutMs ?? 8000)
  const now = typeof deps.now === 'function' ? deps.now : Date.now

  const seen = new Set()
  const queue = []
  let inflight = null
  let timer = null

  function clearTimer() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  function pump() {
    if (inflight || !queue.length) return
    const item = queue.shift()
    inflight = item
    clearTimer()
    timer = setTimeout(() => {
      log(`桌宠：气泡 ${item.id} 没等到 ack，丢掉`)
      inflight = null
      timer = null
      pump()
    }, ackTimeoutMs)
    timer.unref?.()
    const ok = send({ t: 'say', id: item.id, seq: item.seq, text: item.text, final: item.final })
    if (ok === false) {
      clearTimer()
      inflight = null
      log(`桌宠：气泡 ${item.id} 没送出去（连接不在）`)
    }
  }

  return {
    /** 推一条她的话。返回真正进队的气泡数。 */
    push(text, opts = {}) {
      const clean = String(text ?? '')
      if (!clean.trim()) return 0
      const id = String(opts.id ?? '')
      if (!id) return 0
      const chunks = splitSay(clean)
      let pushed = 0
      for (let seq = 0; seq < chunks.length; seq += 1) {
        const key = `${id}:${seq}`
        if (seen.has(key)) continue
        // 先看容量再记账：丢掉的这条不能算「推过」，否则队列腾空后
        // 同一个 id 再推也补不上。
        if (queue.length >= QUEUE_MAX) {
          log('桌宠：气泡队列满了，丢掉最新一条')
          break
        }
        seen.add(key)
        queue.push({ id, seq, text: chunks[seq], final: seq === chunks.length - 1 })
        pushed += 1
      }
      pump()
      return pushed
    },
    /** body 确认收到了。 */
    ack(id, seq) {
      if (!inflight) return false
      const sameId = String(inflight.id) === String(id)
      // 协议里 ack 只带 id；同 id 的后续分条靠顺序，这里按第一条算。
      if (!sameId) return false
      if (seq !== undefined && Number(seq) !== Number(inflight.seq)) return false
      clearTimer()
      inflight = null
      pump()
      return true
    },
    /** 只用于测试/停用：清空队列，不重发。 */
    clear() {
      clearTimer()
      inflight = null
      queue.length = 0
    },
    stats() {
      return { queued: queue.length, inflight: inflight ? inflight.id : '', seen: seen.size, now: now() }
    },
  }
}

/** 从 assistant/message 里取要冒泡的正文；叫醒轮的短句返回空串。 */
export function sayText(data, { wakeTurn = false } = {}) {
  const text = assistantText(data)
  if (!text.trim()) return ''
  if (wakeTurn && text.trim().length < WAKE_SAY_MIN) return ''
  return text
}
