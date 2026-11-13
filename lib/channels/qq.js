/**
 * qq.js —— QQ 渠道适配器：OneBot 11 正向 WebSocket（默认 ws://127.0.0.1:3001）。
 *
 * 职责与边界（以 channels/README.md 为准，改之前先读那份契约）：
 *  - 只做两件事：把外面的话搬进来（onMessage 回调规范化消息），把她的话送出去（send）。
 *  - 不认人、不建会话、不判断"该不该回"——那些是 router.js / gate.js 的事。
 *  - 断线重连自己管；token 只出现在 WS 的 URL 里，不进日志、不进 status()。
 *
 * 只写 OneBot 11 标准子集（2026-11-06，见 新项目-设计讨论.md 渠道节）：
 * `message` / `notice` 事件与 `send_msg` 等标准动作。不用任何桥的扩展动作——
 * 换 SnowLuma / NapCat 不用改这里。notice 一律不递：撤回、系统消息不记账。
 *
 * 为什么是"接桥"而不是内置 QQ 协议：AGENTS.md 第 7 条把协议、登录、收发都划给独立桥
 * （SnowLuma / NapCat / Lagrange / go-cqhttp…），本插件只当 OneBot 客户端。这也是零依赖
 * 唯一走得通的路——Node 22+ 自带 globalThis.WebSocket，不用引 ws 包。
 *
 * 踩过的坑（细节写在对应代码旁边）：
 *  - 自己发的消息也会以 post_type=message 回推（self_id === user_id），不挡掉她会看见
 *    "自己说的话"被当成别人说的，然后开始自问自答；
 *  - 桥重连后可能补推一段历史，按 message_id 去重是"同一句话被喂两遍"的唯一防线；
 *  - post_format 可能是 array 也可能是 string（CQ 码），两种都得认，否则 @ 会漏成
 *    `[CQ:at,qq=123]` 原文进上下文；
 *  - 只有图/表情的消息 text 是空串，但**不能丢**——她得知道有人发了图；
 *  - 发送不能重试：超时后桥可能其实已经发出去了，重试就是让对方收两遍。
 *
 * 图片（2026-11-14）：
 *  - 入站图只落盘、不把 base64 写进账本：存到 `<root>/media/qq/<sha1 前 16 位>.<ext>`，
 *    再把「[图片：media/qq/x.jpg]」追加到 heard 文本末尾——她的会话有 read_image，自己看；
 *  - 出站只有**独占一行**的 `[图片]<相对路径>` 才变 image 段；realpath 后必须落在
 *    `<root>/media/` 之内，越界整行拒（日志 image-block）、不存在整行丢（image-missing），
 *    同一句里其余的字照发。
 *
 * 节奏（2026-11-06，照 dsh-lanxi-qq 的观察重写）：
 *  - 一次回复按句切气泡；超过 3 条时按 900ms 间隔发（一次说完像刷屏，分开发像说话）；
 *  - 单条最多 4000 字，超了才硬切；
 *  - 30s 心跳 `get_status`，退避 2/5/10/30/60s；
 *  - 群里"回复她"与"@她"同等算被点名（gate 用 replyToSelf）。
 */

import { sanitizeForeign } from '../guard.js'
import { sniffMime, IMAGE_MIME } from '../media.js'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_WS_URL = 'ws://127.0.0.1:3001'
/** 阶梯退避（2026-11-06 对齐设计文档）：最后一档 60s 一直重试，桥重启通常一分钟内回来。 */
const RECONNECT_STEPS_MS = [2000, 5000, 10_000, 30_000, 60_000]
const CALL_TIMEOUT_MS = 15_000
/** 心跳：OneBot 连接空闲太久有的桥会掐断；30s 问一次 `get_status` 最省事。 */
const HEARTBEAT_MS = 30_000
/** 单条消息上限。QQ 的实际上限约 4500 字节，4000 个字符留出余量。 */
const SEND_MAX = 4000
/** 一次回复最多几个气泡（被动回复的软上限；内容超了宁可多一条也不丢字）。 */
const MAX_BUBBLES = 4
/** 超过 3 个气泡才停顿：一两条连着发才像说话。 */
const BUBBLE_GAP_MS = 900
/** 去重窗口：500 条足够覆盖"断线几秒后补推"的量，又不至于把内存当账本。 */
const SEEN_MAX = 500
const IMAGE_MAX = 4
/** 入站图片落盘：单张 10MB、下载超时 15s（设计 §「她要看得到」）。 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 15_000
/** 图片存在 `<root>/media/qq/`；文本里给她的是相对 root 的路径（read_image 用）。 */
const MEDIA_REL = 'media/qq'
/** 出站图片标记：**独占一行**的 `[图片]<相对路径>`，不是整行就当普通文字。 */
const IMAGE_LINE = /^\[图片\][ \t]*(.+?)[ \t]*$/
/** 标记后面得像个路径（有分隔符或图片后缀）；否则「[图片]三个字」会被误当成图。 */
const IMAGE_PATH_HINT = /\.(?:png|jpe?g|webp|gif)$/i
/** 只认这几种图：read_image 能打开的格式；判不出来按魔数再判一次。 */
const IMAGE_EXT_BY_SUFFIX = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.webp': 'webp', '.gif': 'gif' }
/** 记住自己发出去的消息 id，用来认"这条是在回复我"。 */
const SENT_ID_MAX = 200
/**
 * 入站 WAL / 出站 outbox 的上限（2026-11-06，设计 §渠道内部默认）：
 * 只保留没做完的；超过这个行数就重写一遍，把 done/drop 的行清掉。
 * 400 行约等于 200 条消息，重连补推的窗口远小于这个量。
 */
const LEDGER_MAX_RECORDS = 400

/**
 * @param {object} opts
 * @param {(...a: any[]) => void} [opts.log]
 * @param {{enabled?: boolean, wsUrl?: string, token?: string, accessToken?: string}} [opts.config]
 * @param {typeof WebSocket} [opts.WebSocketImpl] 测试注入；缺省 globalThis.WebSocket
 * @param {() => number} [opts.now]
 * @param {(fn: Function, ms: number) => any} [opts.setTimeout] 测试注入（快进超时/退避/心跳）
 * @param {(handle: any) => void} [opts.clearTimeout]
 */
export function create(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const config = opts.config !== null && typeof opts.config === 'object' ? opts.config : {}
  const WSImpl = opts.WebSocketImpl ?? globalThis.WebSocket
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  // 定时器可注入：单测要把 15s 超时 / 退避 / 心跳"快进"，否则一条用例得真等半分钟。
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (handle) => clearTimeout(handle)
  // 入站图片要下载：生产用内置 fetch，测试注入假的（零依赖，不引包）。
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch

  let socket = null // 当前连接；null = 没有连接
  let connected = false // onopen 之后才为 true（构造出 WebSocket 不等于连上）
  let stopped = true // 出生就是停的：没调 start() 之前绝不碰网络
  let attempt = 0 // 连续失败次数，决定退避档位；连上就归零
  let reconnectTimer = null
  let heartbeatTimer = null
  let since = 0
  let lastError = ''
  // 断线错误要留得住：onopen 会清 lastError，但设置页要能看到上一次到底为什么断。
  let lastErrorText = ''
  let lastErrorAt = 0
  let selfId = '' // 桥那边登录的 QQ 号；判断"这条是不是我自己发的"靠它
  let nickname = ''
  let sent = 0
  let received = 0
  let seq = 0
  // 断线账（2026-11-06，设计 §三「断线记得住」）：只记事实，不判断"健康"。
  // lastInAt/lastOutAt = 最近一次真收到/真发出去的本地时间；断开时记下 gapStart，
  // 重连上再算出断了多久——下一轮对话里由 router 决定要不要念给她听。
  let lastInAt = 0
  let lastOutAt = 0
  let gapStart = 0
  let lastGapAt = 0
  let lastGapMs = 0

  const listeners = new Set()
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map()
  /** message_id → true，Map 保持插入序，超窗口时删最老的 */
  const seen = new Map()
  // 群号 → 群名。多数桥在 message 事件里带 group_name，偶尔不带；
  // 不带的时候用最近一次见过的名字，而不是把发送者的群名片当成群名
  // （2026-11-07 真机：她把群名念成了发言人的群名片——群名和人的名字是两回事）。
  const groupNames = new Map()
  /** 自己发出去的消息 id：群友"回复"她时靠它认出来（reply 段里的 id 就是它）。 */
  const sentIds = new Set()

  // ---- 入站 WAL / 出站 outbox（2026-11-06）----
  // 为什么要有：桥推来一句话、进程在这时候没了，那句话就永远没进她的记忆；
  // 她说完一句、进程在回执前没了，对方可能收到、也可能没收到，至少不能重复发。
  // 做法是最小号的 append-only 账本：先记下再干活，干完补一行 done/drop；
  // 重启时把没 done 的重放一次。代价是崩溃窗口里可能重复一次——比丢话好。
  const root = typeof opts.root === 'string' && opts.root !== '' ? opts.root : ''
  const mediaDir = root === '' ? '' : join(root, MEDIA_REL)
  const walPath = root === '' ? '' : join(root, 'qq-wal.jsonl')
  const outboxPath = root === '' ? '' : join(root, 'qq-outbox.jsonl')
  let walSeq = 0
  let outSeq = 0
  let dirReady = false
  // 入站图片处理是异步的（下载/读盘），但消息必须先来先递：
  // 一次图片落盘没做完时，后面的消息排在它后面，不抢顺序（见 enqueueInbound）。
  let inboundChain = Promise.resolve()
  let inboundQueued = 0

  function ensureDir() {
    if (dirReady) return
    dirReady = true
    try { mkdirSync(root, { recursive: true }) } catch { dirReady = false }
  }

  function readJsonl(file) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return [] }
    const out = []
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (s === '') continue
      try {
        const rec = JSON.parse(s)
        if (rec !== null && typeof rec === 'object') out.push(rec)
      } catch { /* 坏行跳过：账本不能因为一行烂了就整本读不出来 */ }
    }
    return out
  }

  function appendJsonl(file, rec) {
    ensureDir()
    appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8')
  }

  /** 原子重写：先写 .tmp 再 rename，半截文件不会顶替旧账本。 */
  function rewriteJsonl(file, records) {
    ensureDir()
    const tmp = `${file}.tmp`
    const text = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  }

  /** 只留没 done 的 in 行；force=false 时行数没超上限就不动。 */
  function compactWal(force = false) {
    if (walPath === '') return
    const recs = readJsonl(walPath)
    if (!force && recs.length <= LEDGER_MAX_RECORDS) return
    const done = new Set(recs.filter((r) => r.t === 'done').map((r) => String(r.id)))
    const kept = []
    const seenIds = new Set()
    for (const r of recs) {
      if (r.t !== 'in' || done.has(String(r.id)) || seenIds.has(String(r.id))) continue
      seenIds.add(String(r.id))
      kept.push(r)
    }
    rewriteJsonl(walPath, kept)
  }

  function compactOutbox(force = false) {
    if (outboxPath === '') return
    const recs = readJsonl(outboxPath)
    if (!force && recs.length <= LEDGER_MAX_RECORDS) return
    const closed = new Set(recs.filter((r) => r.t === 'done' || r.t === 'drop').map((r) => String(r.id)))
    const kept = []
    const seenIds = new Set()
    for (const r of recs) {
      if (r.t !== 'out' || closed.has(String(r.id)) || seenIds.has(String(r.id))) continue
      seenIds.add(String(r.id))
      kept.push(r)
    }
    rewriteJsonl(outboxPath, kept)
  }

  function rememberSeen(messageId) {
    const value = String(messageId ?? '')
    if (value === '') return
    seen.set(value, true)
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value)
  }

  function itemId(item) {
    const raw = String(item?.raw?.message_id ?? '')
    if (raw !== '') return raw
    // 没有 message_id 的桥（少见）：用时间 + 序号造一个，只用于 WAL 内部配对。
    walSeq += 1
    return `w-${item?.channelId ?? 'qq'}-${item?.personId ?? '?'}-${item?.at ?? now()}-${walSeq}`
  }

  function deliver(item, replayed = false) {
    if (!replayed) {
      received += 1
      lastInAt = now()
    }
    // 回调里出错不能把整条连接带崩，也不能让后面的人收不到这条消息。
    for (const fn of [...listeners]) {
      try { fn(item) } catch (error) { warn(`onMessage 回调出错：${errorText(error)}`) }
    }
  }

  /** 先落盘，再交给 listeners，最后补 done。落盘失败也照常递——丢记忆比丢消息轻。 */
  function recordAndDeliver(item) {
    const id = itemId(item)
    if (walPath !== '') {
      try { appendJsonl(walPath, { t: 'in', id, item, at: now() }) } catch (error) { warn(`入站账本写不进去：${errorText(error)}`) }
    }
    deliver(item)
    if (walPath !== '') {
      try { appendJsonl(walPath, { t: 'done', id }) } catch { /* 下一轮 compact 会清掉它 */ }
      try { compactWal() } catch { /* 清账失败不影响收消息 */ }
    }
  }

  /**
   * 平时同步落盘+递，保持消息原来的先后；重放在 start() 里、连网之前做完，
   * 所以不会和线上消息抢顺序。
   */
  function acceptInbound(item) {
    try { recordAndDeliver(item) } catch (error) { warn(`入站处理出错：${errorText(error)}`) }
  }

  /**
   * 入站图片：先落盘，再把「[图片：media/qq/x.jpg]」追加到 heard 文本末尾。
   *
   * 为什么走文本而不是 image 段：她的会话是一个普通 DSH 会话，有 read_image；
   * 把路径写在话里她自己会读（与 lib/media.js 的抽帧同一思路）。事件流里
   * 绝不写 base64——那会把账本撑爆，也不是她「看见」的东西。
   *
   * 顺序：有图的消息要等下载完才递；没有图的消息照旧同步递（跑得快、顺序不乱）。
   * 下载失败只写日志，原话一个字不少。
   */
  function enqueueInbound(item) {
    const images = Array.isArray(item.images) ? item.images : []
    const needsMedia = mediaDir !== '' && images.length > 0
    // 没有图、也没有排队的图：保持原来的同步交付（单测与线上顺序都依赖它）。
    if (!needsMedia && inboundQueued === 0) { acceptInbound(item); return }
    inboundQueued += 1
    inboundChain = inboundChain
      .then(() => (needsMedia ? saveInboundImages(item) : undefined))
      .catch((error) => warn(`入站图片处理出错：${errorText(error)}`))
      .then(() => acceptInbound(item))
      .finally(() => { inboundQueued -= 1 })
  }

  /** 把一条消息里的图逐张存下来；全部失败也返回（不许因此丢消息）。 */
  async function saveInboundImages(item) {
    const lines = []
    for (const raw of item.images) {
      const rel = await saveInboundImage(String(raw ?? ''))
      if (rel !== '') lines.push(`[图片：${rel}]`)
    }
    if (lines.length === 0) return
    const head = String(item.text ?? '').trim()
    item.text = head === '' ? lines.join('\n') : `${head}\n${lines.join('\n')}`
  }

  /**
   * 存一张：`<root>/media/qq/<sha1 前 16 位>.<ext>`，目录 0700、文件 0600。
   * 同一张图重复发（同字节）落到同一个文件名，天然去重。
   * @returns {Promise<string>} 相对 root 的路径；失败返回 ''（只写日志）
   */
  async function saveInboundImage(raw) {
    const source = imageSource(raw)
    if (source === null) return '' // base64:// 之类：不是她看得见的文件，也不进正文
    let bytes
    try {
      bytes = source.kind === 'url' ? await fetchImageBytes(source.value) : readLocalImage(source.value)
    } catch (error) {
      warn(source.kind === 'url' ? `图片下载失败：${errorText(error)}` : `本地图片读取失败：${errorText(error)}`)
      return ''
    }
    if (bytes === null || bytes.byteLength === 0) return ''
    try {
      const ext = imageExtOf(bytes, source.value)
      const name = `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${ext}`
      ensureMediaDir()
      const abs = join(mediaDir, name)
      if (!existsSync(abs)) {
        // 先写临时文件再改名：半截图不会被 read_image 读到。
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
        writeFileSync(tmp, bytes, { mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, abs)
      }
      return `${MEDIA_REL}/${name}`
    } catch (error) {
      warn(`图片落盘失败：${errorText(error)}`)
      return ''
    }
  }

  /** 只接受 http(s) 与本地绝对路径；其它（base64://、相对路径、空）一律忽略。 */
  function imageSource(raw) {
    const s = String(raw ?? '').trim()
    if (s === '') return null
    if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s }
    if (/^file:\/\//i.test(s)) {
      try {
        const u = new URL(s)
        if (u.protocol === 'file:') return { kind: 'file', value: fileURLToPath(u) }
      } catch { /* 坏 file:// 当没给 */ }
      return null
    }
    return isAbsolute(s) ? { kind: 'file', value: s } : null
  }

  /** 下载：超时 15s，边下边量，超 10MB 直接放弃（不把内存当垃圾桶）。 */
  async function fetchImageBytes(url) {
    if (typeof fetchImpl !== 'function') throw new Error('没有可用的 fetch')
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(IMAGE_TIMEOUT_MS)
      : undefined
    const res = await fetchImpl(url, signal === undefined ? {} : { signal })
    if (res === null || typeof res !== 'object' || res.ok !== true) {
      throw new Error(`HTTP ${res?.status ?? '?'}`)
    }
    const declared = Number(res.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) throw new Error('too-large')
    if (res.body !== null && res.body !== undefined && typeof res.body[Symbol.asyncIterator] === 'function') {
      const chunks = []
      let total = 0
      for await (const chunk of res.body) {
        const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        total += buf.byteLength
        if (total > IMAGE_MAX_BYTES) throw new Error('too-large')
        chunks.push(buf)
      }
      const out = new Uint8Array(total)
      let at = 0
      for (const c of chunks) { out.set(c, at); at += c.byteLength }
      return out
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > IMAGE_MAX_BYTES) throw new Error('too-large')
    return buf
  }

  function readLocalImage(file) {
    // 桥有时把 CQ 码里的 file 写成 base64:// 或一个文件名：都不是「本地绝对路径」，已经在
    // imageSource 里筛掉了。这里只读她真要看的那个文件，大小有上限（同下载）。
    const st = statSync(file)
    if (!st.isFile()) throw new Error('not-a-file')
    if (st.size > IMAGE_MAX_BYTES) throw new Error('too-large')
    return readFileSync(file)
  }

  /** 按魔数判扩展名（不信桥给的 mime）；判不出来再看 URL/路径后缀。 */
  function imageExtOf(bytes, hint) {
    const mime = sniffMime(bytes)
    if (mime !== null && IMAGE_MIME[mime] !== undefined) return IMAGE_MIME[mime]
    const clean = String(hint ?? '').split('?')[0].split('#')[0]
    const dot = clean.lastIndexOf('.')
    const suffix = dot >= 0 ? clean.slice(dot).toLowerCase() : ''
    return IMAGE_EXT_BY_SUFFIX[suffix] ?? 'img'
  }

  /** `<root>/media/qq` 只建一次；0700 硬性 chmod，别指望 umask。 */
  function ensureMediaDir() {
    if (mediaDir === '') return
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
    try { chmodSync(mediaDir, 0o700) } catch { /* Windows 上 chmod 不一定买账 */ }
  }

  /** 重启后把上次没 done 的入站消息再递一遍；每条只递一次。 */
  function replayInbound() {
    if (walPath === '') return
    const recs = readJsonl(walPath)
    const done = new Set(recs.filter((r) => r.t === 'done').map((r) => String(r.id)))
    const delivered = new Set()
    for (const r of recs) {
      const id = String(r.id)
      if (r.t !== 'in' || done.has(id) || delivered.has(id)) continue
      delivered.add(id)
      rememberSeen(r.item?.raw?.message_id)
      deliver(r.item, true)
      try { appendJsonl(walPath, { t: 'done', id }) } catch { /* 重放完就行，账慢慢清 */ }
    }
    compactWal(true)
  }

  /**
   * 出站补发：只补一次。崩溃/断线前写了 out、没等到回执的那几条，
   * 重连后原样再发一遍；不论成败都落 done/drop，不会反复补。
   */
  async function replayOutbox() {
    if (outboxPath === '') return
    const recs = readJsonl(outboxPath)
    const closed = new Set(recs.filter((r) => r.t === 'done' || r.t === 'drop').map((r) => String(r.id)))
    for (const r of recs) {
      const id = String(r.id)
      if (r.t !== 'out' || closed.has(id)) continue
      try {
        await call(r.action, r.params ?? {})
        sent += 1
        lastOutAt = now()
        appendJsonl(outboxPath, { t: 'done', id })
      } catch (error) {
        appendJsonl(outboxPath, { t: 'drop', id, why: errorText(error) })
      }
    }
    compactOutbox(true)
  }

  function token() {
    const value = config.token ?? config.accessToken
    return value === undefined || value === null ? '' : String(value)
  }

  /** 任何进日志/返回值的文本都过这里：token 绝不出门（README 规则 3）。 */
  function scrub(text) {
    const secret = token()
    const s = String(text ?? '')
    return secret === '' ? s : s.split(secret).join('***')
  }

  function errorText(error) {
    if (error && typeof error === 'object' && typeof error.why === 'string') return scrub(error.why)
    if (error instanceof Error) return scrub(error.message)
    return scrub(String(error ?? 'unknown'))
  }

  function info(message) {
    try { log('info', scrub(`[qq] ${message}`)) } catch { /* 日志坏了不能连带渠道挂掉 */ }
  }

  function warn(message) {
    try { log('warn', scrub(`[qq] ${message}`)) } catch { /* 同上 */ }
  }

  // 当前错误与「上次错误」一起写：onopen 清 lastError，但 lastErrorText/lastErrorAt 留着。
  // 空串不覆盖持久值，所以重连成功不会把上一次的原因抹掉。
  function rememberError(message) {
    const text = scrub(String(message ?? '').trim())
    if (text === '') return ''
    lastError = text
    lastErrorText = text
    lastErrorAt = now()
    return text
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const handle = setT(resolve, ms)
      handle?.unref?.()
    })
  }

  function buildUrl() {
    let raw = String(config.wsUrl ?? '').trim() || DEFAULT_WS_URL
    // 允许只填 `127.0.0.1:3001`（设置页里很常见），补个 ws:// 再解析。
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `ws://${raw}`
    const url = new URL(raw)
    const secret = token()
    // OneBot 11 正向 WS 的鉴权就是这一条 query 参数；放 header 很多实现不认。
    if (secret !== '') url.searchParams.set('access_token', secret)
    return url.toString()
  }

  function closeSocket() {
    const ws = socket
    socket = null
    connected = false
    if (heartbeatTimer !== null) {
      clearT(heartbeatTimer)
      heartbeatTimer = null
    }
    for (const p of pending.values()) {
      clearT(p.timer)
      // 用普通对象而不是 Error：上层只关心"能不能发"，一个 Error 只会被 String() 成废话。
      p.reject({ ok: false, why: 'closed' })
    }
    pending.clear()
    if (ws !== null) {
      try { ws.close() } catch { /* 已经关了 */ }
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return
    const delay = RECONNECT_STEPS_MS[Math.min(attempt, RECONNECT_STEPS_MS.length - 1)]
    attempt += 1
    reconnectTimer = setT(() => {
      reconnectTimer = null
      connect()
    }, delay)
    // unref：进程要退出时别被这个定时器吊着（插件卸载后尤其明显）。
    reconnectTimer?.unref?.()
  }

  /** 30s 一次的心跳：等价于"我还在这条连接上"，也让挂死的桥有机会被 close。 */
  function scheduleHeartbeat() {
    if (stopped || heartbeatTimer !== null) return
    heartbeatTimer = setT(() => {
      heartbeatTimer = null
      if (stopped || !connected) return
      // 失败不用管：call 的超时/close 会走 onclose，重连逻辑自己接上。
      call('get_status').catch(() => {})
      scheduleHeartbeat()
    }, HEARTBEAT_MS)
    heartbeatTimer?.unref?.()
  }

  function connect() {
    if (stopped) return
    if (typeof WSImpl !== 'function') {
      warn(rememberError('没有可用的 WebSocket（需要 Node 22+，或注入 WebSocketImpl）'))
      return
    }
    let ws
    try {
      ws = new WSImpl(buildUrl())
    } catch (error) {
      // 构造就抛基本只有一种原因：wsUrl 写错了（协议不支持 / 不是合法 URL）。
      // 这种情况重连一万次也没用，所以不排定时器，把原因留在 status().lastError 里。
      warn(rememberError(`wsUrl 无法连接：${errorText(error)}`))
      return
    }
    socket = ws

    ws.onopen = () => {
      if (socket !== ws) return
      connected = true
      attempt = 0
      lastError = ''
      // 上一次是断着回来的：把断了多久记下来，重连本身不算"没断过"。
      if (gapStart !== 0) {
        lastGapAt = now()
        lastGapMs = Math.max(0, lastGapAt - gapStart)
        gapStart = 0
      }
      since = now()
      info('已连上 OneBot，正在确认登录信息')
      // 不 await：start() 不等握手完成，连上后该干嘛是后台的事。
      void afterOpen().catch((error) => warn(`连上后的初始化出错：${errorText(error)}`))
      scheduleHeartbeat()
    }

    ws.onmessage = (ev) => {
      if (socket !== ws) return
      const data = ev?.data
      let text = ''
      if (typeof data === 'string') text = data
      else if (data instanceof Uint8Array) text = new TextDecoder().decode(data)
      else return // 心跳二进制包之类，本渠道不认
      handleFrame(text)
    }

    ws.onerror = (ev) => {
      if (socket !== ws) return
      const detail = ev?.message ?? ev?.error?.message ?? ''
      rememberError(detail === '' ? '连接出错（桥没开 / 端口不对 / token 不对）' : `连接出错：${detail}`)
    }

    ws.onclose = (ev) => handleClose(ws, ev)
  }

  function handleClose(ws, ev) {
    if (socket !== ws) return
    const wasConnected = connected
    closeSocket()
    const code = ev?.code
    if (code === 1008 || code === 4001 || code === 403) {
      rememberError('访问令牌被拒绝（检查 config.channels.qq.token）')
    } else if (lastError === '') {
      rememberError(`连接断开（${code ?? '?'}）`)
    }
    if (wasConnected) {
      // 只把"本来连着、现在断了"算进断线账；启动时就连不上的不算。
      if (gapStart === 0) gapStart = now()
      warn(`和 OneBot 的连接断开（${code ?? '?'}），按阶梯重连`)
    }
    scheduleReconnect()
  }

  async function afterOpen() {
    try {
      const data = await call('get_login_info')
      if (data !== null && typeof data === 'object') {
        selfId = String(data.user_id ?? selfId)
        nickname = String(data.nickname ?? '')
      }
      info(`已确认在线：${nickname || '?'} / ${selfId || '?'}`)
    } catch (error) {
      // 桥能连上但 get_login_info 失败：有些实现要等登录完成才认这个 action。
      // 只记一笔、不断开——断开反而丢掉已经连上的事件流。
      warn(`get_login_info 失败：${errorText(error)}`)
    }
    // 出站补发要等网络回执，可能慢；不挡收消息，失败了只是这轮没补上。
    void replayOutbox().catch((error) => warn(`出站补发失败：${errorText(error)}`))
  }

  function handleFrame(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return } // 非 JSON 的噪声直接丢
    if (msg === null || typeof msg !== 'object') return

    if (msg.echo !== undefined) {
      const key = String(msg.echo)
      const p = pending.get(key)
      if (p === undefined) return // 超时之后才回来的响应，没人等了
      pending.delete(key)
      clearT(p.timer)
      // OneBot 11 各实现的成功标志不统一：有的 status==='ok'，有的只给 retcode===0。
      if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data ?? null)
      else {
        const why = msg.wording || msg.message || msg.msg || 'onebot_error'
        p.reject({ ok: false, why: scrub(String(why)).slice(0, 120), retcode: msg.retcode ?? null })
      }
      return
    }

    if (msg.post_type === 'meta_event') {
      // 有的实现先推 meta_event 再回 get_login_info；先记下 self_id，@ 判断不用等。
      if (selfId === '' && msg.self_id !== undefined) selfId = String(msg.self_id)
      return
    }

    // notice（撤回、群文件、管理操作…）与 request 都不归渠道管：
    // 撤回与系统消息不进她的记忆（设计文档「入站分叉」第 6 条）。
    if (msg.post_type !== 'message') return
    const item = normalizeMessage(msg)
    if (item === null) return

    // 先落盘、再递（见 acceptInbound）：进程在这之后没掉，这话就丢不了。
    enqueueInbound(item)
  }

  function normalizeMessage(msg) {
    const kind = msg.message_type === 'group' ? 'group' : msg.message_type === 'private' ? 'dm' : null
    if (kind === null) return null // 频道 / 临时会话等，本渠道不管

    const self = String(msg.self_id ?? selfId ?? '')
    const userId = String(msg.user_id ?? msg.sender?.user_id ?? '')
    if (userId === '') return null
    // 自己发的消息也会以 message 事件回推；不挡掉她会看见"自己说的话"被当成别人说的。
    if (self !== '' && userId === self) return null

    const messageId = String(msg.message_id ?? '')
    if (messageId !== '' && seen.has(messageId)) return null // 重连后桥补推的历史

    const groupId = kind === 'group' ? String(msg.group_id ?? '') : ''
    if (kind === 'group' && groupId === '') return null
    const groupNameNow = kind === 'group' ? String(msg.group_name ?? '').trim() : ''
    if (groupId !== '' && groupNameNow !== '') {
      groupNames.set(groupId, groupNameNow)
      if (groupNames.size > 200) groupNames.delete(groupNames.keys().next().value)
    }

    const sender = msg.sender !== null && typeof msg.sender === 'object' ? msg.sender : {}
    // 群名片才是群里"这个人"的名字；私聊没有名片，用昵称。
    const card = String(sender.card ?? '').trim()
    const nick = String(sender.nickname ?? msg.nickname ?? '').trim()
    const personName = kind === 'group' ? card || nick : nick || card

    const body = readBody(msg, self)

    if (messageId !== '') {
      seen.set(messageId, true)
      // Map 保持插入序 = 最早的那条先走，不用自己维护链表。
      if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value)
    }

    const seconds = Number(msg.time)
    return {
      channelId: 'qq',
      kind,
      conversationId: kind === 'group' ? groupId : userId,
      // 群名是群的名字，不是发言的人的名字（channels/README.md 的形状）。
      conversationName: kind === 'group' ? groupNameNow || groupNames.get(groupId) || '' : nick,
      personId: `u_${userId}`,
      personName,
      text: body.text,
      images: body.images,
      // 附件只留一条元数据（类型 + 字节数），正文留空：设计文档要求的形状。
      attachment: body.attachment,
      mentionedSelf: body.mentionedSelf === true,
      // 群友点了"回复"她的某条消息：与 @ 同等算被点名，gate 靠它放行。
      replyToSelf: body.replyToSelf === true,
      // 群主 / 管理员开的群车不该被"冷却"卡住（gate 的 isAdmin 豁免）。
      isAdmin: kind === 'group' && (sender.role === 'owner' || sender.role === 'admin'),
      at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now(),
      raw: msg, // 只给排查用，不许进提示词（README 的规范化消息注释）
    }
  }

  function readBody(msg, self) {
    const parts = []
    const images = []
    // 2026-11-03：群里只在她被 @ 时开口（见 gate.js 的 mentionOnly）。
    // @ 她的段既不进正文（模型不需要看到「@鱼」），又要留下「叫过她」这件事。
    const flags = { mentionedSelf: false, replyToSelf: false }
    const attach = { type: '', size: 0 }
    const segments = msg.message

    if (Array.isArray(segments)) {
      for (const seg of segments) {
        if (seg === null || typeof seg !== 'object') continue
        const data = seg.data !== null && typeof seg.data === 'object' ? seg.data : {}
        if (seg.type === 'text') {
          parts.push(String(data.text ?? ''))
        } else if (seg.type === 'at') {
          const qq = String(data.qq ?? '')
          // @她本人：正文里不出现（模型不需要看到"@鱼"）；@别人保留成 @名字，免得
          // "你们俩"这种话失去指代。self 为空（还没拿到登录信息）时保守地按别人处理。
          if (self !== '' && qq === self) { flags.mentionedSelf = true; continue }
          if (qq === 'all') parts.push('@全体成员 ')
          else if (qq !== '') parts.push(`@${String(data.name ?? '').trim() || qq} `)
        } else if (seg.type === 'image') {
          // 只有图/表情的消息 text 会是空串，但这条消息仍然要上报（见文件头）。
          const url = data.url || data.file
          if (url) images.push(String(url))
          noteAttachment(attach, 'image', data.file_size ?? data.size)
        } else if (seg.type === 'file') {
          noteAttachment(attach, 'file', data.file_size ?? data.size)
        } else if (seg.type === 'record') {
          noteAttachment(attach, 'record', data.file_size ?? data.size)
        } else if (seg.type === 'video') {
          noteAttachment(attach, 'video', data.file_size ?? data.size)
        } else if (seg.type === 'face' || seg.type === 'mface') {
          noteAttachment(attach, 'emoji', 0)
        } else if (seg.type === 'reply') {
          // 这条是在回复谁：只认"回复的是她自己发出去的那条"。
          const id = String(data.id ?? '')
          if (id !== '' && sentIds.has(id)) flags.replyToSelf = true
        }
        // 其它段（forward / json / markdown…）这里不展开：
        // 渠道只保证"话和图"到场，措辞是 router 的事。
      }
    } else if (typeof segments === 'string' && segments !== '') {
      // post_format=string：整条是 CQ 码字符串。
      parts.push(readCqString(segments, self, images, flags, attach))
    } else if (typeof msg.raw_message === 'string' && msg.raw_message !== '') {
      // 极少数实现只给 raw_message。
      parts.push(readCqString(msg.raw_message, self, images, flags, attach))
    }

    // 兜底：有的桥不推 at 段，而是把 @ 展开成正文里的「@昵称」，或者只在 raw_message
    // 里留 CQ 码。这两种都算点名，并且把正文里那个 @ 前缀剥掉——不然她会把「@鱼欣」
    // 当成对方对她说的话的一部分。
    if (flags.mentionedSelf !== true && self !== '') {
      const rawMsg = typeof msg.raw_message === 'string' ? msg.raw_message : ''
      if (rawMsg !== '' && rawMsg.includes(`[CQ:at,qq=${self}]`)) flags.mentionedSelf = true
    }
    let text = parts.join('')
    if (flags.mentionedSelf !== true) {
      // 正文开头的「@某某 」：桥把 @ 展开成文本时就是这种形状。群里有人手打
      // 「@鱼欣」也是在对她说，按点名算不算错；剥掉前缀，别让它进她听到的话。
      const atHead = /^@(\S{1,24})[\s\u2005\u00a0]+/.exec(text)
      if (atHead !== null) {
        flags.mentionedSelf = true
        text = text.slice(atHead[0].length)
      }
    }
    if (nickname !== '' && text.includes(`@${nickname}`)) {
      text = text.split(`@${nickname}`).join('')
      text = text.replace(/^[\s\u2005\u00a0]+/, '')
    }

    return {
      text: finalizeText(text),
      images: images.slice(0, IMAGE_MAX),
      attachment: attach.type === '' ? null : { type: attach.type, size: attach.size },
      mentionedSelf: flags.mentionedSelf === true,
      replyToSelf: flags.replyToSelf === true,
    }
  }

  function noteAttachment(attach, type, size) {
    // 只记一条：一条消息里同时有图和表情，也还是"一条附件"，不让记忆里冒出四个条目。
    if (attach.type === '') attach.type = type
    const n = Number(size)
    if (Number.isFinite(n) && n > 0) attach.size += Math.floor(n)
  }

  function readCqString(raw, self, images, flags = {}, attach = { type: '', size: 0 }) {
    let out = String(raw)
    out = out.replace(/\[CQ:at,([^\]]*)\]/g, (_whole, params) => {
      const p = parseCqParams(params)
      const qq = String(p.qq ?? '')
      if (qq === 'all') return '@全体成员 '
      if (self !== '' && qq === self) { flags.mentionedSelf = true; return '' }
      return qq === '' ? '' : `@${qq} `
    })
    out = out.replace(/\[CQ:reply,([^\]]*)\]/g, (_whole, params) => {
      const p = parseCqParams(params)
      const id = String(p.id ?? '')
      if (id !== '' && sentIds.has(id)) flags.replyToSelf = true
      return ''
    })
    out = out.replace(/\[CQ:image,([^\]]*)\]/g, (_whole, params) => {
      const p = parseCqParams(params)
      const url = p.url || p.file
      if (url) images.push(String(url))
      noteAttachment(attach, 'image', p.file_size ?? p.size)
      return ''
    })
    out = out.replace(/\[CQ:file,([^\]]*)\]/g, (_whole, params) => {
      const p = parseCqParams(params)
      noteAttachment(attach, 'file', p.file_size ?? p.size)
      return ''
    })
    out = out.replace(/\[CQ:(face|mface),([^\]]*)\]/g, () => {
      noteAttachment(attach, 'emoji', 0)
      return ''
    })
    // 剩下的 CQ 码（record / video / forward…）在纯文本模式下没有可读形态，
    // 整段删掉，免得把 `[CQ:record,file=...]` 这种机器码递进上下文。
    out = out.replace(/\[CQ:[^\]]*\]/g, '')
    return unescapeCq(out)
  }

  function parseCqParams(raw) {
    const out = {}
    for (const pair of String(raw ?? '').split(',')) {
      const at = pair.indexOf('=')
      if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1)
    }
    return out
  }

  function unescapeCq(text) {
    return String(text)
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',')
      .replace(/&amp;/g, '&')
  }

  function finalizeText(raw) {
    // 外来文本必须过 guard：她是"根本没看见"那句试图改她人格的话，而不是看见了被劝住。
    const { text } = sanitizeForeign(raw)
    return String(text ?? '').trim()
  }

  function call(action, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = socket
      if (ws === null || !connected) { reject({ ok: false, why: 'offline' }); return }
      const echo = `qq-${now().toString(36)}-${++seq}`
      const timer = setT(() => {
        pending.delete(echo)
        // 超时不是"没发出去"：桥可能已经在发，只是没来得及回话。所以只报超时，
        // 调用方（send）不许重试——重试就是让对方收两遍。
        reject({ ok: false, why: 'timeout' })
      }, timeoutMs)
      timer?.unref?.()
      pending.set(echo, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearT(timer)
        pending.delete(echo)
        reject({ ok: false, why: `发送失败：${errorText(error)}` })
      }
    })
  }

  /** 按字符切，不劈 emoji；只在单句超过上限时用。 */
  function hardSplit(text) {
    const chars = Array.from(String(text))
    const out = []
    for (let i = 0; i < chars.length; i += SEND_MAX) {
      out.push(chars.slice(i, i + SEND_MAX).join(''))
    }
    return out.length ? out : ['']
  }

  /**
   * 一句话分成几个气泡（设计文档「合批」节）。
   * 按句号/问号/感叹号/省略号/分号切；切完超过 4 段时把后面的并进最后一条，
   * 宁可最后一条长一点，也不要为了一句话连发七八条。
   */
  // 引号/括号里的句号不是「一句话说完了」：她把他说过的「！」原样引回来时，
  // 按标点硬切会切成「这个「！」/是高兴…/」我不太会接。」三条——读者看到的是碎句子。
  const QUOTE_OPEN = '「『“"（(【['
  const QUOTE_CLOSE = '」』”"）)】]'

  function splitBubbles(text) {
    const raw = String(text ?? '').trim()
    if (raw === '') return []
    const pieces = []
    let depth = 0
    let buf = ''
    const flush = () => {
      const piece = buf.trim()
      buf = ''
      if (piece === '') return
      for (const chunk of hardSplit(piece)) {
        if (chunk.trim() !== '') pieces.push(chunk)
      }
    }
    for (const ch of Array.from(raw)) {
      buf += ch
      if (QUOTE_OPEN.includes(ch)) depth++
      else if (QUOTE_CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
      else if (depth === 0 && '。！？!?…；;'.includes(ch)) flush()
    }
    flush()
    if (pieces.length <= MAX_BUBBLES) return pieces
    const head = pieces.slice(0, MAX_BUBBLES - 1)
    let tail = pieces.slice(MAX_BUBBLES - 1).join('')
    // 并完还超 4000 字就硬切；这时会超过 4 条，但不丢字优先。
    while (Array.from(tail).length > SEND_MAX) {
      const chars = Array.from(tail)
      head.push(chars.slice(0, SEND_MAX).join(''))
      tail = chars.slice(SEND_MAX).join('')
    }
    if (tail !== '') head.push(tail)
    return head
  }

  function asNumericId(id) {
    // OneBot 的 group_id/user_id 是数字；但有的桥传字符串。纯数字才转，
    // 免得 Number('abc') 变 NaN，被 JSON 序列化成 null 发出去。
    return /^\d{1,15}$/.test(id) ? Number(id) : id
  }

  function rememberSentId(id) {
    const value = String(id ?? '')
    if (value === '') return
    sentIds.add(value)
    if (sentIds.size > SENT_ID_MAX) sentIds.delete(sentIds.values().next().value)
  }

  /**
   * 出站图片：只有 **独占一行** 的 `[图片]<相对路径>` 才是图（例如 `[图片]media/qq/a.jpg`）。
   * 路径必须落在 `<root>/media/` 之内（realpath 后比前缀），否则整行拒绝、写日志
   * `image-block: 越界路径`——绝不发本地任意文件；文件不存在写 `image-missing`。
   * 两种情况都只丢那一行，同一句里其余的字照发。
   */
  function resolveImageSegment(rawPath) {
    const rel = String(rawPath ?? '').trim()
    if (rel === '') return null
    if (root === '') { warn(`image-block: 越界路径（没有数据目录）${rel}`); return null }
    let realRoot = ''
    try { realRoot = realpathSync(root) } catch { warn(`image-missing: ${rel}`); return null }
    // media 目录可能还不存在（她还没收到过图）；先按前缀算，realpath 文件时再判一次。
    let realMedia = join(realRoot, 'media')
    try { realMedia = realpathSync(realMedia) } catch { /* 没有这个目录 */ }
    // 先做词法校验：`../../` 这种根本进不了门，连 stat 都不用做。
    const candidate = resolve(realRoot, rel)
    if (!(candidate === realMedia || candidate.startsWith(realMedia + sep))) {
      warn(`image-block: 越界路径 ${rel}`)
      return null
    }
    let realFile = ''
    try { realFile = realpathSync(candidate) } catch { warn(`image-missing: ${rel}`); return null }
    // 再校验一次：media 里的软链接指到外面，也不能跟出去。
    if (!(realFile === realMedia || realFile.startsWith(realMedia + sep))) {
      warn(`image-block: 越界路径 ${rel}`)
      return null
    }
    try {
      if (!statSync(realFile).isFile()) { warn(`image-missing: ${rel}`); return null }
    } catch {
      warn(`image-missing: ${rel}`)
      return null
    }
    // OneBot 11 标准 image 段的本地文件写法就是 file://；换桥也认。
    return { type: 'image', data: { file: pathToFileURL(realFile).href } }
  }

  /** 标记后面得像个路径：要么带分隔符，要么是图片后缀；否则整行仍是文字。 */
  function looksLikeImagePath(rest) {
    const p = String(rest ?? '').trim()
    if (p === '' || /\s/.test(p)) return false
    return p.includes('/') || p.includes('\\') || IMAGE_PATH_HINT.test(p)
  }

  /**
   * 把回复正文排成气泡（每条气泡 = 一组消息段）：
   * 图片行按原文位置插入，其余文字仍走原来的按句切气泡，顺序不变。
   */
  function planBubbles(body) {
    const text = String(body ?? '')
    if (!text.includes('[图片]')) return splitBubbles(text).map((t) => [{ type: 'text', data: { text: t } }])
    const out = []
    const buf = []
    const flushText = () => {
      const chunk = buf.join('\n')
      buf.length = 0
      if (chunk.trim() === '') return
      for (const piece of splitBubbles(chunk)) out.push([{ type: 'text', data: { text: piece } }])
    }
    for (const line of text.split('\n')) {
      const m = IMAGE_LINE.exec(line)
      if (m === null || !looksLikeImagePath(m[1])) { buf.push(line); continue }
      flushText()
      const seg = resolveImageSegment(m[1])
      if (seg !== null) out.push([seg])
    }
    flushText()
    return out
  }

  async function send({ conversation, text } = {}) {
    try {
      const kind = conversation?.kind === 'group' ? 'group' : conversation?.kind === 'dm' ? 'dm' : null
      if (kind === null) return { ok: false, why: 'bad_target' }
      const target = String(conversation?.id ?? '').trim()
      if (target === '') return { ok: false, why: 'bad_target' }
      const body = String(text ?? '').trim()
      // 空消息 OneBot 本身会拒，不如直接说清楚；这也防止 router 误把空串交下来。
      if (body === '') return { ok: false, why: 'empty' }
      if (!connected) return { ok: false, why: 'offline' }

      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const targetField = kind === 'group' ? 'group_id' : 'user_id'
      const targetId = asNumericId(target)
      const bubbles = planBubbles(body)
      // 正文只有一行越界的 `[图片]`：图被拒、字也被删空，就是一条空消息，不发。
      if (bubbles.length === 0) return { ok: false, why: 'empty' }
      const gap = bubbles.length > 3 ? BUBBLE_GAP_MS : 0
      let lastId = ''

      for (let i = 0; i < bubbles.length; i += 1) {
        // 气泡之间隔一下：连发四条一眼就是机器；留 900ms 像人打字。
        if (i > 0 && gap > 0) await sleep(gap)
        // 逐条串行发：并发发对方观感是乱的，失败时也说不清发到第几段。
        // 用消息段数组而不是裸字符串：NapCat/Lagrange/SnowLuma 都按 array 走，
        // 字符串模式的老实现也认 array（OneBot 11 两种都允许）。
        const params = {
          [targetField]: targetId,
          message: bubbles[i],
        }
        // 先记意图再发：崩溃在回执前时，下次启动能看出"这句可能没送到"。
        const oid = outboxPath === ''
          ? ''
          : (() => { outSeq += 1; return `out-${now().toString(36)}-${outSeq}` })()
        // appendJsonl 是同步的（appendFileSync）：不要 await，否则报文会被推迟一个微任务，
        // 调用方紧接着 send() 去看桥收到什么就看不到（2026-11-06 修）。
        if (oid !== '') {
          try { appendJsonl(outboxPath, { t: 'out', id: oid, action, params, at: now() }) } catch { /* 记账失败不挡发送 */ }
        }
        let data
        try {
          data = await call(action, params)
        } catch (error) {
          if (oid !== '') {
            // 超时 / 桥报错都只补一笔记账，不在这里重试：重试=对方可能收两遍。
            try { appendJsonl(outboxPath, { t: 'drop', id: oid, why: errorText(error) }) } catch { /* ignore */ }
          }
          throw error
        }
        if (oid !== '') {
          try { appendJsonl(outboxPath, { t: 'done', id: oid }) } catch { /* ignore */ }
        }
        lastId = String(data?.message_id ?? lastId)
        rememberSentId(lastId)
      }
      try { compactOutbox() } catch { /* 清账失败不影响发送 */ }

      sent += 1
      lastOutAt = now()
      return { ok: true, id: lastId }
    } catch (error) {
      // 超时 / 被禁言 / 桥报错在 call 里已经归一成 {ok:false, why}，这里只保证不抛。
      const out = { ok: false, why: errorText(error) || 'send_failed' }
      if (error && typeof error === 'object' && error.retcode !== undefined) out.retcode = error.retcode
      return out
    }
  }

  function onMessage(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  function start() {
    try {
      // 配置里明确关掉的渠道不连：调用方就算一刀切 start() 也不会偷偷上线。
      if (config.enabled === false) return { ok: false, why: 'disabled' }
      // 已经在跑（或正在等重连）不建第二条连接，否则一条消息会被上报两遍。
      if (socket !== null || reconnectTimer !== null) return { ok: true }
      stopped = false
      attempt = 0
      // 连网之前先把上次没递完的入站消息补上：此刻还没有线上消息，顺序不会乱。
      try { replayInbound() } catch (error) { warn(`入站补账失败：${errorText(error)}`) }
      connect()
      if (socket !== null) return { ok: true }
      return { ok: false, why: lastError || 'connect_failed' }
    } catch (error) {
      warn(rememberError(`启动失败：${errorText(error)}`))
      return { ok: false, why: lastError }
    }
  }

  function stop() {
    try {
      stopped = true // 先立旗：onclose 里就不会再排重连
      if (reconnectTimer !== null) {
        clearT(reconnectTimer)
        reconnectTimer = null
      }
      closeSocket()
    } catch { /* 关不掉也不能抛给调用方 */ }
  }

  function status() {
    // 这里一个配置值都不能带出去：README 规则 3 盯的就是这个（token 就在 config 里）。
    return {
      ok: connected,
      connected,
      since: since || 0,
      lastError,
      lastErrorText,
      lastErrorAt,
      queued: pending.size,
      sent,
      received,
      // 断线账（2026-11-06）：时间用本地 ms；0 表示还没有过。
      // downSince 非 0 = 现在正断着（还在按阶梯重连），这时 lastGapAt 保持上一次的值。
      lastInAt,
      lastOutAt,
      lastGapAt,
      lastGapMs,
      downSince: gapStart,
    }
  }

  return { name: 'qq', start, stop, send, onMessage, status, splitBubbles }
}
