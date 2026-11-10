/**
 * pet/index.js —— 桌宠这一层：把她的会话接到身体上
 *
 * 2026-11-08（m09369）。三条硬规矩：
 *   1. 宠物默认关：不 spawn、不注册工具、不连网，连日志都不写。
 *   2. 只订阅她那条会话（talkSessionId）；拿不到就不挂，也不刷日志。
 *   3. 身体只是身体：这里不改她的话、不替她编台词；聊天框原样递给 sayToHer。
 *
 * 协议唯一来源：https://github.com/bychance6600/roost-pet/blob/main/docs/protocol.md
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createBridge } from './bridge.js'
import { createMirror, sayText } from './mirror.js'
import { awakeByActivity, awakeChange, IDLE_SLEEP_MIN_DEFAULT, initialState, labelOf, reducePetState, stateAt } from './state.js'
import { talkSessionId } from '../home.js'
import { classifyMessage } from '../turns.js'
import { sayToHer } from '../say.js'
import { looksLikeRewriting } from '../guard.js'
import { appendEvent, ensureHer } from '../store.js'
import {
  childEnv,
  classifyExit,
  entrySpec,
  HELLO_TIMEOUT_MS,
  MAX_ATTEMPTS,
  petIdOf,
  petPathOf,
  RETRY_WAITS,
} from './entry.js'

const AWAKE_EVERY_MS = 15_000

/** 多久没动静算睡着（分钟）：默认 5，范围 1–60。 */
function idleMinutes(value) {
  const n = Number(value)
  return Number.isFinite(n)
    ? Math.min(60, Math.max(1, Math.round(n)))
    : IDLE_SLEEP_MIN_DEFAULT
}

/** 当前这一个实例（模块级：/pet/status 只读它）。 */
let runtime = null

/** 多久算「两次戳之间隔够了」（毫秒）：默认 60 秒，范围 5–600 秒。 */
function pokeGapMs(value) {
  const n = Number(value)
  return Number.isFinite(n)
    ? Math.min(600_000, Math.max(5_000, Math.round(n)))
    : 60_000
}

/** 戳一下该怎么办：距上次隔够了才起一轮；间隔内的点击忽略。 */
export function pokeKind(lastPokeAt, now = Date.now(), minGapMs = 60_000) {
  const gap = pokeGapMs(minGapMs)
  const since = Number(lastPokeAt) || 0
  return now - since >= gap ? 'turn' : 'ignore'
}

/**
 * 桌宠状态。cfg/root 传进来时，即使身体还没起来，也能算出装没装、会从哪起。
 * 不传就只看当前实例（/pet/status 会传）。
 */
export function petStatus(cfg = null, root = '') {
  const p = cfg?.pet && typeof cfg.pet === 'object' ? cfg.pet : null
  const configuredPath = p ? petPathOf(p, root) : ''
  const fallback = p
    ? {
        enabled: p.enabled === true,
        installed: configuredPath ? existsSync(configuredPath) : false,
        path: configuredPath,
        pack: petIdOf(p),
      }
    : { enabled: false, installed: false, path: '', pack: 'default' }
  if (!runtime) {
    const enabled = fallback.enabled
    return {
      enabled,
      installed: fallback.installed,
      path: fallback.path,
      pack: fallback.pack,
      connected: false,
      state: '等',
      why: !enabled ? '等：桌宠没开' : (fallback.installed ? '等：还没连上' : '等：还没装身体'),
      pet: '',
      lastError: '',
      dead: false,
    }
  }
  const now = Date.now()
  const st = stateAt(runtime.state, now)
  return {
    enabled: true,
    installed: runtime.installed === true,
    path: runtime.path,
    pack: runtime.pack,
    connected: runtime.bridge?.connected === true,
    state: labelOf(st.state),
    why: st.why,
    pet: runtime.petName,
    lastError: runtime.lastError,
    dead: runtime.dead === true,
  }
}

/** 给 index.js 判断要不要把 pet_act 加进 extra。路径空着也算开：会去默认位置找身体。 */
export function petEnabled(cfg) {
  return cfg?.pet?.enabled === true
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
 * 设置页保存后热更：不重启，下一次检查立刻按新的 idleSleepMin 重判。
 * 2026-11-08 16:53 协调板：主人把 1 分钟试了没睡，因为启动时只读了一次。
 */
export function petApplyConfig(cfg) {
  try {
    if (!runtime) return false
    runtime.idleSleepMin = idleMinutes(cfg?.pet?.idleSleepMin)
    runtime.pokeMinGapMs = pokeGapMs(cfg?.pet?.pokeMinGapMs)
    runtime.checkAwake?.()
    return true
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

  if (cfg?.pet?.enabled !== true) return { off() {}, status: petStatus(cfg, root) }

  // 17:44 协调板：路径空着不再算错，默认去 <root>/pet/dsh-roost-pet.exe 找。
  // 没装就是 installed:false，不 spawn、不刷错误日志。
  const petPath = petPathOf(cfg.pet ?? {}, root)
  const installed = existsSync(petPath)
  const base = {
    enabled: true,
    installed,
    path: petPath,
    pack: petIdOf(cfg.pet),
    connected: false,
    state: { ...initialState(Date.now()), why: '等：桌宠还没连上' },
    petName: '',
    lastError: '',
    dead: false,
    stopped: false,
    failures: 0,
    retryTimer: null,
    closeTimer: null,
    byeTimer: null,
    tickTimer: null,
    awakeTimer: null,
    bridge: null,
    child: null,
    mirror: null,
    sessionId: '',
    sawHuman: false,
    pendingHuman: false,
    // 睡 / 醒（2026-11-08 16:00）：回合进行中，或者距最后一次动静不到 idleSleepMin。
    // 余额、通知、日历、到点都不算；它们真把她叫起来时会走 turn/start。
    turnActive: false,
    lastActivityAt: Date.now(),
    idleSleepMin: idleMinutes(cfg?.pet?.idleSleepMin),
    // 17:47 协调板：戳一下。隔够了就记 meta 并排一轮；回合中也不早退（mode:'queue' 会等）。
    lastPokeAt: 0,
    pokeMinGapMs: pokeGapMs(cfg?.pet?.pokeMinGapMs),
  }
  runtime = base

  if (!installed) {
    base.state = { ...base.state, why: '等：还没装身体（把 zip 解压到 ~/.dsh-roost/pet/）' }
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

  // ---- 戳一下（17:47 协调板）：只写 meta，不进 heard、不算记忆 ----
  // 距上次 ≥ pokeMinGapMs 就记一笔并排一轮；回合中也不早退，mode:'queue' 会等她这一轮结束。
  // 2026-11-08 23:20 协调板：之前回合里只记 meta、不排回合，meta 不进上下文，她永远看不见。
  function notePoke(iso) {
    return appendEvent(
      { type: 'meta', text: `poke:${iso}`, sessionId: base.sessionId },
      { source: 'system' },
      root,
    ).catch(() => null)
  }

  async function pokeTurn() {
    // 每次现取，不用 base.sessionId：她换过屋子之后旧 id 会把这一轮送到没人看的会话里（2026-11-08 23:30）。
    const sid = await talkSessionId(ctx, { root }).catch(() => '')
    if (!sid) return
    const sc = ctx.sessionController
    if (!sc?.prompt) return
    try { await sc.create({ sessionId: sid, cwd: await ensureHer(root) }) } catch { /* 已有就用旧的 */ }
    // prompt 的第二个参数是 signal：传 undefined 时宿主会在 throwIfAborted 上炸（2026-11-08 23:40 真机）。
    const ac = new AbortController()
    await sc.prompt(
      {
        requestId: `poke-${Date.now()}`,
        sessionId: sid,
        mode: 'queue',
        content: [{ type: 'text', text: '## 这次\n\n他伸手戳了你一下。回不回应、怎么回应，你自己定。' }],
      },
      ac.signal,
    )
  }

  // ---- 生 命 周 期：起来 → 握手 → 挂了退避重试；三次起不来就置 dead ----
  // 入口约定（路径、参数、超时、退出码）在 body 仓库 docs/launch.md；
  // 可执行版本在 lib/pet/entry.js。改约定先改文档，再改那边。
  function stopChild(graceMs = 0) {
    base.closing = true
    if (base.closeTimer) { clearTimeout(base.closeTimer); base.closeTimer = null }
    if (base.byeTimer) { clearTimeout(base.byeTimer); base.byeTimer = null }
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
    if (base.failures >= MAX_ATTEMPTS) {
      if (!base.dead) {
        base.dead = true
        log(`[dsh-roost] 桌宠：连续 ${MAX_ATTEMPTS} 次没起来，先不动它了（${base.lastError}）`)
      }
      return
    }
    const wait = RETRY_WAITS[Math.min(base.failures - 1, RETRY_WAITS.length - 1)] ?? 1000
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
      // 入口约定在 docs/launch.md：打包产物 cwd 是它所在目录，
      // 开发态 electron.exe 的 cwd 是 body 仓库根；参数由 entry.js 生成。
      // ELECTRON_RUN_AS_NODE 必须删掉，否则 Electron 会当 node 跑，主进程不启动。
      const spec = entrySpec({ ...(cfg.pet ?? {}), path: petPath })
      child = spawnFn(spec.path, spec.args, {
        cwd: spec.cwd,
        env: childEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      onceFail(err?.message ?? err)
      return
    }
    base.child = child
    base.cleanExit = false
    child.on?.('error', (err) => {
      if (base.child !== child) return
      onceFail(err?.message ?? err)
    })
    child.on?.('exit', (code, signal) => {
      // stopChild 已经把 base.child 清空：这是被我们停掉的旧进程，别再算一次。
      if (base.child !== child) return
      base.child = null
      if (base.closeTimer) { clearTimeout(base.closeTimer); base.closeTimer = null }
      if (base.byeTimer) { clearTimeout(base.byeTimer); base.byeTimer = null }
      if (base.stopped) return
      const kind = classifyExit(code, signal, { clean: base.cleanExit })
      if (kind === 'clean') {
        base.cleanExit = true
        try { base.bridge?.close('桌宠退出了') } catch { /* ignore */ }
        base.bridge = null
        base.state = { ...base.state, why: '等：桌宠关掉了' }
        log(`[dsh-roost] 桌宠自己关掉了（exit ${code ?? signal ?? 0}），这次不重拉`)
        return
      }
      if (kind === 'dead') {
        base.dead = true
        base.lastError = `桌宠起不来（exit ${code}）`
        try { base.bridge?.close('桌宠起不来') } catch { /* ignore */ }
        base.bridge = null
        log(`[dsh-roost] 桌宠：exit ${code}，这个错重试也不会好，先不动它了`)
        return
      }
      onceFail(`桌宠退出了（${signal || code}）`)
    })
    child.stderr?.on?.('data', (chunk) => {
      if (base.child !== child) return
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
      helloTimeoutMs: HELLO_TIMEOUT_MS,
      log: (...a) => log('[dsh-roost] 桌宠协议', ...a),
      onHello: (info) => {
        base.failures = 0
        base.installed = true
        base.dead = false
        base.cleanExit = false
        base.lastError = ''
        base.petName = String(info?.pet ?? '').slice(0, 80)
        base.state = { ...initialState(Date.now()), why: '等：回合已结束，等下一次动静' }
        sendState(true)
        log(`[dsh-roost] 桌宠已连上${base.petName ? `：${base.petName}` : ''}`)
      },
      onInput: (m) => {
        if (m.poke) {
          // 点击只给动作，台词她给：这里只说「有人戳了一下」，不替她说话。
          const now = Date.now()
          const iso = new Date(now).toISOString()
          const kind = pokeKind(base.lastPokeAt, now, base.pokeMinGapMs)
          if (kind === 'turn') {
            base.lastPokeAt = now
            void notePoke(iso)
            void pokeTurn().catch((e) => log(`[dsh-roost] 戳一下没排上：${e?.message ?? e}`))
          } else {
            // 间隔内的点击不写 meta、不排回合；留一行日志，方便真机上分辨。
            log(`[dsh-roost] 桌宠 poke 间隔不到（${base.pokeMinGapMs}ms），忽略`)
          }
          base.state = reducePetState(base.state, { type: 'pet/poke' }, { now })
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
      // body 主动走 = 干净退出，不重试。约定是 3 秒内退干净；不退就替它收。
      onBye: () => {
        base.cleanExit = true
        log('[dsh-roost] 桌宠说了 bye，等它自己退')
        if (base.byeTimer) clearTimeout(base.byeTimer)
        base.byeTimer = setTimeout(() => {
          if (base.child !== child) return
          log('[dsh-roost] 桌宠说了 bye 但 3 秒没退，替它收')
          try { child.kill() } catch { /* ignore */ }
        }, 3000)
        base.byeTimer.unref?.()
      },
      onClose: (why) => {
        if (base.stopped || base.closing || base.cleanExit) return
        // 握手超时是明确的失败，不用等退出码。
        if (why === '没握手') {
          onceFail('桌宠没在 10 秒内握手')
          return
        }
        // stdout 关了不等于进程退了：先等 exit 的退出码（0 是正常关窗，非 0 是崩）。
        // 500ms 还没退，才当成断线处理。
        if (base.closeTimer) clearTimeout(base.closeTimer)
        base.closeTimer = setTimeout(() => {
          if (base.stopped || base.cleanExit || base.child !== child) return
          onceFail('桌宠那边把连接关了')
        }, 500)
        base.closeTimer.unref?.()
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

  // ---- 睡 / 醒：按「在不在做事」判，不看 sleep 标记、不看时段 ----
  // 回合进行中一律算醒：五分钟只在回合结束之后起算。
  // 睡着之后只有 turn/start、tool/call、assistant/message 能叫醒；
  // 余额、通知、日历、到点本身都不算，到点真起一轮才会先来 turn/start。
  function checkAwake() {
    if (base.stopped) return false
    const now = Date.now()
    const awake = awakeByActivity(base.turnActive, base.lastActivityAt, now, base.idleSleepMin)
    const ch = awakeChange(base.state, awake, now)
    base.state = { ...base.state, asleep: ch.asleep }
    if (!ch.act) return false
    if (ch.act === 'sleep') base.state = { ...base.state, why: ch.why }
    sendAct(ch.act, ch.why)
    sendState(true)
    return true
  }
  base.checkAwake = checkAwake
  checkAwake()
  base.awakeTimer = setInterval(checkAwake, AWAKE_EVERY_MS)
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
      // 她的动静：回合开始、工具调用、她说话。回合结束只停表，不算「叫醒」。
      const wokeByHer = type === 'turn/start' || type === 'tool/call' || type === 'assistant/message'
      if (type === 'turn/start') {
        base.turnActive = true
        base.lastActivityAt = now
      } else if (type === 'turn/end' || type === 'prompt-failed') {
        base.turnActive = false
        base.lastActivityAt = now
      } else if (type === 'tool/call' || type === 'assistant/message') {
        base.lastActivityAt = now
      }
      const human = type === 'user/message' && classifyMessage(event?.data) === 'human'
      const before = base.state
      base.state = reducePetState(base.state, event, { now, human })
      const stateChanged = base.state.state !== before.state || base.state.why !== before.why
      if (wokeByHer) {
        const flipped = checkAwake()
        if (!flipped && stateChanged) sendState(true)
      } else if (stateChanged) {
        sendState(true)
      }
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
