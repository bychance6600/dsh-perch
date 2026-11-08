/**
 * pet/index.js —— 桌宠这一层：把她的会话接到身体上
 *
 * 2026-11-08（m09369）。三条硬规矩：
 *   1. 宠物默认关：不 spawn、不注册工具、不连网，连日志都不写。
 *   2. 只订阅她那条会话（talkSessionId）；拿不到就不挂，也不刷日志。
 *   3. 身体只是身体：这里不改她的话、不替她编台词；聊天框原样递给 sayToHer。
 *
 * 协议唯一来源：https://github.com/bychance6600/dsh-roost-pet/blob/main/docs/protocol.md
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { dirname } from 'node:path'
import { createBridge } from './bridge.js'
import { createMirror, sayText } from './mirror.js'
import { awakeChange, initialState, labelOf, reducePetState, stateAt } from './state.js'
import { talkSessionId } from '../home.js'
import { classifyMessage } from '../turns.js'
import { sayToHer } from '../say.js'
import { looksLikeRewriting } from '../guard.js'
import { readEvents } from '../store.js'
import { loadConfig } from '../settings.js'
import { deriveStatus } from '../status.js'

const RETRY_MAX = 3
// 施工单 §3.1：退避 1 / 5 / 15 秒。第三次直接置 dead，不再排 15 秒。
const RETRY_WAITS = [1000, 5000, 15000]
const AWAKE_EVERY_MS = 15_000

/** 当前这一个实例（模块级：/pet/status 只读它）。 */
let runtime = null

export function petStatus() {
  if (!runtime) {
    return {
      enabled: false,
      connected: false,
      state: '等',
      why: '等：桌宠没开',
      pet: '',
      lastError: '',
      dead: false,
    }
  }
  const now = Date.now()
  const st = stateAt(runtime.state, now)
  return {
    enabled: true,
    connected: runtime.bridge?.connected === true,
    state: labelOf(st.state),
    why: st.why,
    pet: runtime.petName,
    lastError: runtime.lastError,
    dead: runtime.dead === true,
  }
}

/** 给 index.js 判断要不要把 pet_act 加进 extra。 */
export function petEnabled(cfg) {
  return cfg?.pet?.enabled === true && String(cfg?.pet?.path ?? '').trim() !== ''
}

/** 工具侧的动作入口：没起来/没连上都返回 false，不抛。 */
export function petSendAct(action, why = '') {
  try {
    return runtime?.sendAct?.(action, why) === true
  } catch {
    return false
  }
}

/**
 * @param {object} ctx
 * @param {{root:string, cfg?:object, log?:Function, spawn?:Function}} deps
 */
export async function startPet(ctx, deps = {}) {
  const cfg = deps.cfg ?? {}
  const root = String(deps.root ?? '')
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : nodeSpawn

  if (cfg?.pet?.enabled !== true) return { off() {}, status: petStatus() }

  const petPath = String(cfg?.pet?.path ?? '').trim()
  const petArgs = Array.isArray(cfg?.pet?.args) ? cfg.pet.args.map(String) : []
  const base = {
    enabled: true,
    connected: false,
    state: { ...initialState(Date.now()), why: '等：桌宠还没连上' },
    petName: '',
    lastError: '',
    dead: false,
    stopped: false,
    failures: 0,
    retryTimer: null,
    tickTimer: null,
    awakeTimer: null,
    bridge: null,
    child: null,
    mirror: null,
    sessionId: '',
    sawHuman: false,
    pendingHuman: false,
  }
  runtime = base

  if (!petPath) {
    base.lastError = '没填宠物包的路径'
    base.state = { ...base.state, why: '等：还没填宠物包的路径' }
    return { off() { if (runtime === base) runtime = null }, status: petStatus() }
  }

  // 只订阅她那条会话。拿不到就不挂：这里不写日志，免得每次启动都刷一行。
  let sessionId = ''
  try {
    sessionId = await talkSessionId(ctx, { root })
  } catch { sessionId = '' }
  if (!sessionId) {
    base.lastError = '屋子还没接上'
    base.state = { ...base.state, why: '等：屋子还没接上' }
    return { off() { if (runtime === base) runtime = null }, status: petStatus() }
  }
  base.sessionId = sessionId

  const mirror = createMirror({
    send: (msg) => (base.bridge ? base.bridge.send(msg) : false),
    log: (...a) => log('[dsh-roost] 桌宠', ...a),
  })
  base.mirror = mirror

  function sendState(force = false) {
    if (!base.bridge || !base.bridge.connected) return
    const st = stateAt(base.state, Date.now())
    const prev = base.state
    base.state = st
    if (!force && prev.state === st.state && prev.why === st.why) return
    base.bridge.send({ t: 'state', state: st.state, why: st.why })
  }

  function sendAct(action, why = '') {
    if (!base.bridge || !base.bridge.connected) return false
    return base.bridge.send({ t: 'act', action, why: String(why ?? '').slice(0, 120) })
  }
  base.sendAct = sendAct

  // ---- 生 命 周 期：起来 → 握手 → 挂了退避重试；三次起不来就置 dead ----
  function stopChild(graceMs = 0) {
    base.closing = true
    try { base.bridge?.close('停用') } catch { /* ignore */ }
    base.closing = false
    base.bridge = null
    const child = base.child
    base.child = null
    if (child) {
      // 退出插件时先让 body 自己看到 bye，再动手；崩溃/握手失败不必等。
      if (graceMs > 0) {
        const t = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, graceMs)
        t.unref?.()
      } else {
        try { child.kill() } catch { /* ignore */ }
        const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 1000)
        t.unref?.()
      }
    }
  }

  function failOnce(why) {
    if (base.stopped) return
    base.lastError = String(why ?? '').slice(0, 200)
    stopChild()
    base.failures += 1
    if (base.failures >= RETRY_MAX) {
      if (!base.dead) {
        base.dead = true
        log(`[dsh-roost] 桌宠：连续 ${RETRY_MAX} 次没起来，先不动它了（${base.lastError}）`)
      }
      return
    }
    const wait = RETRY_WAITS[Math.min(base.failures - 1, RETRY_WAITS.length - 1)]
    base.retryTimer = setTimeout(spawnOnce, wait)
    base.retryTimer.unref?.()
  }

  function spawnOnce() {
    if (base.stopped || base.dead) return
    let child
    let failed = false
    const onceFail = (why) => {
      if (failed) return
      failed = true
      failOnce(why)
    }
    try {
      // 施工单 §3.1：cwd 是宠物包所在的目录，不是她的数据目录。
      child = spawnFn(petPath, petArgs, { cwd: dirname(petPath), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      onceFail(err?.message ?? err)
      return
    }
    base.child = child
    base.cleanExit = false
    child.on?.('error', (err) => onceFail(err?.message ?? err))
    child.on?.('exit', (code, signal) => {
      if (base.stopped) return
      onceFail(`桌宠退出了（${signal || code}）`)
    })
    child.stderr?.on?.('data', (chunk) => {
      const text = String(chunk ?? '').trim()
      if (text) log('[dsh-roost] 桌宠 stderr', text.slice(0, 500))
    })
    if (!child.stdout || !child.stdin) {
      failOnce('桌宠进程没有 stdin / stdout')
      return
    }
    base.bridge = createBridge({
      readable: child.stdout,
      writable: child.stdin,
      roost: '0.1.0',
      log: (...a) => log('[dsh-roost] 桌宠协议', ...a),
      onHello: (info) => {
        base.failures = 0
        base.dead = false
        base.lastError = ''
        base.petName = String(info?.pet ?? '').slice(0, 80)
        base.state = { ...initialState(Date.now()), why: '等：她醒着，没在做事' }
        sendState(true)
        log(`[dsh-roost] 桌宠已连上${base.petName ? `：${base.petName}` : ''}`)
      },
      onInput: (m) => {
        if (m.poke) {
          // 点击只给动作，台词她给：这里只说「有人戳了一下」，不替她说话。
          base.state = reducePetState(base.state, { type: 'pet/poke' }, { now: Date.now() })
          return
        }
        const text = String(m.text ?? '')
        if (!text.trim()) return
        if (looksLikeRewriting(text).hit) return
        // 原样进原样出；回不回、说什么都由她决定。
        void sayToHer(ctx, text, { root }).catch(() => {})
      },
      onAck: (m) => { base.mirror?.ack(m.id) },
      onLog: (m) => { if (m.level === 'warn' || m.level === 'error') log(`[dsh-roost] 桌宠 ${m.level}：${m.msg}`) },
      // body 主动走 = 干净退出，不重试；它自己会再起来。
      onBye: () => { base.cleanExit = true },
      onClose: () => {
        if (base.stopped || base.closing || base.cleanExit) return
        failOnce('桌宠那边把连接关了')
      },
    })
  }

  spawnOnce()

  // ---- 档位：到点把 done/error 收回 waiting ----
  base.tickTimer = setInterval(() => {
    if (base.stopped) return
    const before = base.state
    const after = stateAt(base.state, Date.now())
    if (after.state !== before.state) {
      base.state = after
      sendState(true)
    }
  }, 1000)
  base.tickTimer.unref?.()

  // ---- 睡 / 醒：她不在就睡；回来跟着起。默认只有这一条是开的。 ----
  async function checkAwake() {
    if (base.stopped) return
    let awake = true
    try {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      awake = deriveStatus({ events, config, now: new Date() }).awake === true
    } catch { awake = true }
    const ch = awakeChange(base.state, awake, Date.now())
    base.state = { ...base.state, asleep: ch.asleep }
    if (ch.act) {
      sendAct(ch.act, ch.why)
      base.bridge?.send({ t: 'state', state: 'waiting', why: ch.why })
    }
  }
  void checkAwake()
  base.awakeTimer = setInterval(() => { void checkAwake() }, AWAKE_EVERY_MS)
  base.awakeTimer.unref?.()

  // ---- 她这条会话的事件 → 档位 + 气泡 ----
  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      if (base.stopped) return
      const sid = String(session?.header?.id ?? session?.id ?? '')
      if (!sid || sid !== base.sessionId) return
      const type = String(event?.type ?? '')
      const now = Date.now()
      if (type === 'user/message') {
        if (classifyMessage(event?.data) === 'human') base.pendingHuman = true
      } else if (type === 'turn/start') {
        base.sawHuman = base.pendingHuman
        base.pendingHuman = false
      }
      const human = type === 'user/message' && classifyMessage(event?.data) === 'human'
      const before = base.state
      base.state = reducePetState(base.state, event, { now, human })
      if (base.state.state !== before.state || base.state.why !== before.why) sendState(true)
      if (type === 'assistant/message') {
        const text = sayText(event?.data, { wakeTurn: !base.sawHuman })
        const id = String(event?.data?.message?.id ?? `turn-${now}`)
        if (text) base.mirror?.push(text, { id })
      }
      if (type === 'turn/end') {
        base.sawHuman = false
        base.pendingHuman = false
      }
    } catch { /* 桌宠永不把宿主的事件处理带崩 */ }
  })

  return {
    off() {
      base.stopped = true
      try { offEvent?.() } catch { /* ignore */ }
      if (base.retryTimer) clearTimeout(base.retryTimer)
      if (base.tickTimer) clearInterval(base.tickTimer)
      if (base.awakeTimer) clearInterval(base.awakeTimer)
      base.mirror?.clear()
      try { base.bridge?.send({ t: 'bye' }) } catch { /* ignore */ }
      // 协议：bye 之后 3 秒内退干净。这里留 2 秒，别一按停就砍。
      stopChild(2000)
      if (runtime === base) runtime = null
    },
    status: petStatus,
    sendAct,
  }
}
