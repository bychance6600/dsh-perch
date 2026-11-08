/**
 * pet/bridge.js —— 跟桌宠说协议（一行一个 JSON）
 *
 * 2026-11-08（m09369）：测试不 spawn 进程。这里只认注入的 { readable, writable }，
 * 测试用 PassThrough 对儿；真进程由 pet/index.js 起。
 *
 * 协议唯一来源：https://github.com/bychance6600/dsh-roost-pet/blob/main/docs/protocol.md
 * 只实现 v1：hello / say / state / act / bye，收 hello / input / poke / ack / log / bye。
 */

export const PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 16 * 1024

function byteLength(s) {
  return Buffer.byteLength(String(s), 'utf8')
}

/**
 * @param {object} o
 * @param {NodeJS.ReadableStream} o.readable body 的 stdout
 * @param {NodeJS.WritableStream} o.writable body 的 stdin
 * @param {Function} [o.log]
 * @param {number} [o.helloTimeoutMs] 多久没握手就算失败（协议说 10 秒）
 * @param {Function} [o.onHello]
 * @param {Function} [o.onInput]
 * @param {Function} [o.onAck]
 * @param {Function} [o.onLog]
 * @param {Function} [o.onBye]
 * @param {Function} [o.onClose]
 */
export function createBridge(o = {}) {
  const readable = o.readable
  const writable = o.writable
  const log = typeof o.log === 'function' ? o.log : () => {}
  const helloTimeoutMs = Number(o.helloTimeoutMs ?? 10_000)
  const onHello = typeof o.onHello === 'function' ? o.onHello : () => {}
  const onInput = typeof o.onInput === 'function' ? o.onInput : () => {}
  const onAck = typeof o.onAck === 'function' ? o.onAck : () => {}
  const onLog = typeof o.onLog === 'function' ? o.onLog : () => {}
  const onBye = typeof o.onBye === 'function' ? o.onBye : () => {}
  const onClose = typeof o.onClose === 'function' ? o.onClose : () => {}

  if (!readable || typeof readable.on !== 'function' || !writable || typeof writable.write !== 'function') {
    throw new Error('bridge 需要 readable / writable')
  }

  let buf = ''
  let closed = false
  let connected = false
  let lastError = ''
  let helloInfo = null
  let timer = null
  const acks = new Set()

  function setError(why) {
    lastError = String(why ?? '').slice(0, 200)
  }

  function close(why = '') {
    if (closed) return
    closed = true
    connected = false
    if (timer) { clearTimeout(timer); timer = null }
    if (why) setError(why)
    try { onClose(why) } catch { /* 回调不许把桥带崩 */ }
  }

  function send(obj) {
    if (closed) return false
    let line
    try {
      line = JSON.stringify(obj)
    } catch {
      return false
    }
    if (byteLength(line) > MAX_LINE_BYTES) {
      setError('一条消息超过 16KB')
      log('桌宠：要发的一条超过 16KB，没发')
      return false
    }
    try {
      writable.write(line + '\n')
      return true
    } catch (err) {
      setError(err?.message ?? err)
      close(String(err?.message ?? err))
      return false
    }
  }

  function handle(line) {
    const text = line.trim()
    if (!text) return
    if (byteLength(text) > MAX_LINE_BYTES) {
      log('桌宠：收到一行超过 16KB，丢掉')
      return
    }
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      log('桌宠：收到坏 JSON，丢掉')
      return
    }
    if (!msg || typeof msg !== 'object') {
      log('桌宠：收到不是对象的消息，丢掉')
      return
    }
    const t = String(msg.t ?? '')
    if (!t) {
      log('桌宠：收到的消息没有 t，丢掉')
      return
    }
    if (t === 'hello') {
      if (Number(msg.v) !== PROTOCOL_VERSION) log(`桌宠：协议版本 ${msg.v}，按 v1 继续`)
      connected = true
      if (timer) { clearTimeout(timer); timer = null }
      helloInfo = { body: String(msg.body ?? ''), pet: String(msg.pet ?? '') }
      try { onHello(helloInfo) } catch { /* ignore */ }
      return
    }
    if (!connected) {
      log('桌宠：还没握手就收到消息，先记下但不当成已连上')
    }
    if (t === 'input') {
      const id = String(msg.id ?? '')
      const value = String(msg.text ?? '')
      if (id) acks.add(id)
      try { onInput({ id, text: value }) } catch { /* ignore */ }
      // input 也要 ack（施工单 §3.5：原文到达就算收到，不拿返回值当气泡）。
      if (id) send({ t: 'ack', id })
      return
    }
    if (t === 'poke') {
      try { onInput({ id: '', text: '', poke: { x: Number(msg.x) || 0, y: Number(msg.y) || 0 } }) } catch { /* ignore */ }
      return
    }
    if (t === 'ack') {
      try { onAck({ id: String(msg.id ?? '') }) } catch { /* ignore */ }
      return
    }
    if (t === 'log') {
      const level = ['debug', 'info', 'warn', 'error'].includes(String(msg.level)) ? String(msg.level) : 'info'
      try { onLog({ level, msg: String(msg.msg ?? '') }) } catch { /* ignore */ }
      return
    }
    if (t === 'bye') {
      try { onBye() } catch { /* ignore */ }
      close('body 说了 bye')
      return
    }
    log(`桌宠：不认识的消息类型 ${t}，丢掉`)
  }

  readable.on('data', (chunk) => {
    if (closed) return
    buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    while (true) {
      const i = buf.indexOf('\n')
      if (i < 0) break
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      handle(line)
      if (closed) return
    }
    if (byteLength(buf) > MAX_LINE_BYTES) {
      log('桌宠：一行超过 16KB 还没换行，丢掉')
      buf = ''
    }
  })
  readable.on('error', (err) => close(err?.message ?? '读 body 出错'))
  readable.on('end', () => close('body 关了'))

  if (helloTimeoutMs > 0) {
    timer = setTimeout(() => {
      if (connected || closed) return
      setError('桌宠没在 10 秒内握手')
      log('桌宠：10 秒内没握手，关掉这条连接')
      close('没握手')
    }, helloTimeoutMs)
    timer.unref?.()
  }

  // 先伸手：hello 一发出去，body 才知道对面是谁。
  send({ t: 'hello', v: PROTOCOL_VERSION, roost: String(o.roost ?? '0.1.0') })

  return {
    send,
    close,
    get connected() { return connected },
    get closed() { return closed },
    get lastError() { return lastError },
    get hello() { return helloInfo },
    /** 给测试：收到但没处理的 id。 */
    acked(id) { return acks.has(String(id)) },
  }
}
