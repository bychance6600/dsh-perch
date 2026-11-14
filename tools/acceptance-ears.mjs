#!/usr/bin/env node
/**
 * acceptance-ears.mjs —— 「耳朵」验收工装（A–E，零依赖，node 直接跑）
 *
 * 验的是**渠道适配器递给 router 的规范化消息**：router 收到 onMessage 时会把
 * `msg.text` 原样写进 `heard.text`（lib/channels/router.js 的 recordHeard），
 * 所以这里断言 `msg.text`，不启动 router、不碰真实账本、不联网、不碰真 ffmpeg。
 *
 * 对着规格写，不依赖实现细节：
 *   A 正常路径：1 个 record 段 + 假 ear 返回 {ok:true,text:'今天好累'} → 正文含转写、无机器码；
 *   B 失败矩阵：耳朵不可用 / 下载失败 / 转码失败 / 转写为空 → 四种都写「没听清」且不编内容；
 *   C 顺序：2 个 record 段 → 两条转写都在，先后与段顺序一致；
 *   D 上限：实现里有「最大下载字节 / 最长文本」常量时，超限走失败路径而不是抛错；
 *   E 不污染：纯文本 / 图片消息走原来路径，同一份输入跑两次，除时间戳外逐字段一致。
 *
 * 契约假设（实现合并后若有出入，先改这里再改用例）：
 *   1. `lib/channels/qq.js` 导出 `createQQAdapter(opts)` 或 `create(opts)`——两个名字都认；
 *   2. 创建参数可注入：
 *        ear:        { available(): boolean, hear(wav): Promise<{ok:true,text} | {ok:false,why}> }
 *        fetchAudio: (urlOrFile) => Promise<Buffer|Uint8Array>
 *        transcode:  (audioBytes) => Promise<Buffer|Uint8Array>   // 输出 16k 单声道 PCM16 WAV
 *      其余沿用现有 opts：log / config / root / WebSocketImpl / fetchImpl / now / setTimeout / clearTimeout；
 *   3. 入站 record 段形状按 OneBot 11：`{ type:'record', data:{ file, url, file_size } }`；
 *   4. 转写结果写在规范化消息的 `text` 里（即 router 写 heard 时的那段正文）；
 *   5. 失败降级文案接受 senses.js 的写法（`unheardNote` =「[语音 N 秒：这台机器没装耳朵]」）
 *      与「没听清 / 听不清 / 没听到」这一类说明——规格要求的是「让听的人知道这句没听清」。
 *
 * 实现还没合并时：A/B/C 会红（预期），工具整体退出码 1；`--allow-missing` 把
 * 「等实现」的失败转成 SKIP（退出码 0），只为让合并前的 CI 能跑。默认严格。
 *
 * 用法：
 *   node tools/acceptance-ears.mjs
 *   node tools/acceptance-ears.mjs --allow-missing
 *   node tools/acceptance-ears.mjs --help
 *
 * 这个文件只读仓库；临时目录全部在 os.tmpdir() 下，跑完删掉。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QQ_PATH = join(REPO, 'lib', 'channels', 'qq.js')
const AUDIO_PATH = join(REPO, 'lib', 'audio.js')

const T0 = 1700000000000
const SELF = 10001
/** 喂给假耳朵的转写内容：四个失败场景里它一条都不许出现在账本里。 */
const FABRICATED = '今天好累'
/**
 * 失败降级文案的宽松匹配。除规格里点名的「没听清 / 听不清 / 没听到」之外，
 * 也接受 lib/senses.js 契约里的「这台机器没装耳朵」——同一类说明，只是措辞不同。
 */
const UNHEARD_RE = /没听清|听不清|没听到|没听明白|没听出来|没装耳朵|听不了|听不见/
/** 等一下异步转写递消息的上限；假件全部即时完成，正常应远小于它。 */
const DELIVERY_TIMEOUT_MS = 4000
/** 递到之后再多等一会儿：防「先递空文本、稍后原地改写」这种实现（见文件头假设 4）。 */
const SETTLE_MS = 120

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------------------
// 假件：WebSocket / 时钟 / 音频三段管线
// ---------------------------------------------------------------------------

/** 假 WebSocket：记录发出去的报文，能手动 open / push / close。 */
class FakeWS {
  static all = []

  constructor(url) {
    this.url = url
    this.frames = []
    this.closed = false
    this.readyState = 0
    FakeWS.all.push(this)
  }

  send(payload) {
    try { this.frames.push(JSON.parse(payload)) } catch { /* 不是 JSON 就不记 */ }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }

  open() {
    this.readyState = 1
    this.onopen?.({})
  }

  push(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  find(action) {
    return this.frames.find((f) => f.action === action)
  }
}

/** 假时钟：句柄做成可 unref 的对象，测试进程不会被 30s 心跳 / 15s 超时吊着。 */
function fakeClock() {
  let seq = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { fn, ms })
      return { id, unref() { return this } }
    },
    clearTimeout(handle) {
      if (handle !== null && typeof handle === 'object') timers.delete(handle.id)
    },
    size() { return timers.size },
  }
}

/** 造一段合法的 44 字节头 WAV（16k / 单声道 / PCM16），耳朵拿到的是这个。 */
function makeWav(payload = Buffer.alloc(0)) {
  const bytes = Buffer.from(payload)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // 单声道
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes.length, 40)
  return Buffer.concat([header, bytes])
}

// 注入的是**普通函数**（契约就是 `fetchAudio(url)` / `transcode(bytes)` / `ear.hear(wav)`），
// 实现可能把方法拆出来单独调用——所以假件一律用闭包，不依赖 `this`。

/** 假耳朵：默认听清；可以指定 available=false / 指定返回 / 指定抛错。 */
function fakeEar({ available = true, result = { ok: true, text: FABRICATED }, fail = null } = {}) {
  const calls = []
  let availableCalls = 0
  return {
    calls,
    get availableCalls() { return availableCalls },
    available: () => {
      availableCalls += 1
      return available
    },
    hear: async (wav) => {
      calls.push(wav)
      if (fail) throw fail
      return result
    },
  }
}

/** 假下载：默认返回一段 WAV；可以指定抛错。记录每次拿到的入参（url / file / data）。 */
function fakeFetchAudio({ bytes = makeWav(Buffer.from('downloaded')), fail = null } = {}) {
  const calls = []
  return {
    calls,
    fetchAudio: async (src) => {
      calls.push(src)
      if (fail) throw fail
      return Buffer.from(bytes)
    },
  }
}

/** 假转码：默认原样返回；可以返回指定 WAV，或抛错。 */
function fakeTranscode({ bytes = null, fail = null } = {}) {
  const calls = []
  return {
    calls,
    transcode: async (audio) => {
      calls.push(audio)
      if (fail) throw fail
      if (bytes === null) return Buffer.from(audio)
      return Buffer.from(bytes)
    },
  }
}

// ---------------------------------------------------------------------------
// 实现检测：工厂、注入点、上限常量
// ---------------------------------------------------------------------------

/** 从 `const X = 10 * 1024 * 1024` 这类声明里取出数值（只认十进制乘法）。 */
function evaluateNumber(expr) {
  const cleaned = String(expr).replace(/_/g, '').replace(/\s+/g, '')
  if (!/^[0-9]+(?:\*[0-9]+)*$/.test(cleaned)) return null
  const value = cleaned.split('*').reduce((acc, part) => acc * Number(part), 1)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 扫源码找上限常量。实现怎么命名不确定，所以按语义找人话能对上的名字：
 *   字节类：名字里同时有 音频类词 + MAX/LIMIT/CAP + BYTES/SIZE
 *   文本类：名字里同时有 音频类词 + MAX/LIMIT/CAP + CHAR/LEN/TEXT/WORD
 * 找不到就是没暴露可判的常量 → D 记 SKIP（规格允许）。
 */
function findLimitConstants(sources) {
  const AUDIOISH = /(AUDIO|VOICE|RECORD|EAR|SPEECH|WAV|TRANSCRIBE|TRANSCODE|TRANSCRIPT|DOWNLOAD|FETCH)/i
  const BYTESISH = /(BYTES?|SIZE)/i
  const CHARSISH = /(CHARS?|LEN|TEXT|WORDS?)/i
  const LIMITISH = /(MAX|LIMIT|CAP)/i
  const SKIP_ISH = /(TIMEOUT|_MS\b|SECONDS?|DURATION|RETRY|COUNT|DAYS?|HOURS?|MINUTES?)/i
  const bytes = new Map()
  const chars = new Map()
  const decl = /(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*([0-9][0-9_*\s]*?)(?=[\n;]|\s*\/\/)/g
  for (const source of sources) {
    if (typeof source !== 'string' || source === '') continue
    for (const match of source.matchAll(decl)) {
      const [, name, expr] = match
      if (!AUDIOISH.test(name) || !LIMITISH.test(name) || SKIP_ISH.test(name)) continue
      const value = evaluateNumber(expr)
      if (value === null) continue
      if (BYTESISH.test(name)) bytes.set(name, value)
      else if (CHARSISH.test(name)) chars.set(name, value)
    }
  }
  return {
    bytes: [...bytes].map(([name, value]) => ({ name, value })),
    chars: [...chars].map(([name, value]) => ({ name, value })),
  }
}

/** 只读检测：不 import、不执行实现，node:test 的壳也用它决定 skip。 */
export function detectImplementation() {
  let qqSource = ''
  let qqError = ''
  try {
    qqSource = readFileSync(QQ_PATH, 'utf8')
  } catch (error) {
    qqError = String(error?.message ?? error)
  }
  let audioSource = ''
  const audioFile = existsSync(AUDIO_PATH)
  if (audioFile) {
    try { audioSource = readFileSync(AUDIO_PATH, 'utf8') } catch { /* 读不到就当没有 */ }
  }
  // 管线标记：qq.js 里直接出现注入点，或音频逻辑单独在 lib/audio.js。
  const markers = ['createQQAdapter', 'fetchAudio', 'transcode', 'createEar', 'heardNote', 'unheardNote']
    .filter((name) => qqSource.includes(name))
  return {
    repo: REPO,
    qqPath: QQ_PATH,
    qqSourcePresent: qqSource !== '',
    qqError,
    audioPath: AUDIO_PATH,
    audioFile,
    markers,
    hasAudioPipeline: audioFile || markers.includes('fetchAudio') || markers.includes('transcode'),
    limits: findLimitConstants([qqSource, audioSource]),
  }
}

// ---------------------------------------------------------------------------
// 驱动适配器
// ---------------------------------------------------------------------------

function factoryOf(mod) {
  const f = mod?.createQQAdapter ?? mod?.create
  return typeof f === 'function' ? f : null
}

function errText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  const name = error.name ? `${error.name}: ` : ''
  return `${name}${error.message ?? String(error)}`.trim()
}

/** 收集测试期间漏出来的异步异常：失败路径必须降级，不许把异常扔给事件循环。 */
function trackAsyncErrors() {
  const errors = []
  const onError = (error) => { errors.push(error) }
  process.on('unhandledRejection', onError)
  process.on('uncaughtException', onError)
  return {
    take() {
      const out = errors.slice()
      errors.length = 0
      return out
    },
    clear() { errors.length = 0 },
    stop() {
      process.off('unhandledRejection', onError)
      process.off('uncaughtException', onError)
    },
  }
}

function drainAsyncErrors(tracker, label) {
  const errors = tracker.take()
  if (errors.length === 0) return
  throw new Error(`${label}：实现抛了未捕获的异步异常（失败路径必须降级，不许抛）：${errors.map(errText).join(' / ')}`)
}

/**
 * 起一个适配器，连上假 WebSocket，把 onMessage 的**递出瞬间**记下来。
 * 记快照而不是引用：router 在 onMessage 里就 `{ ...msg }` 拷走 text，
 * 递出之后再原地改 item.text，真实账本收不到——这里与生产同口径。
 */
async function withAdapter(ctx, spec, fn) {
  const clock = fakeClock()
  const logs = []
  const messages = []
  const root = spec.root === '' ? '' : mkdtempSync(join(tmpdir(), 'ears-accept-'))
  let adapter = null
  let ws = null
  try {
    const opts = {
      log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
      config: { wsUrl: 'ws://127.0.0.1:3001', token: '' },
      WebSocketImpl: FakeWS,
      now: () => T0,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      root,
      ear: spec.ear,
      fetchAudio: spec.fetchAudio?.fetchAudio,
      transcode: spec.transcode?.transcode,
    }
    adapter = ctx.factory(opts)
    if (adapter === null || typeof adapter !== 'object') throw new Error('适配器工厂没有返回对象')
    if (typeof adapter.onMessage !== 'function') throw new Error('适配器没有 onMessage()')
    adapter.onMessage((msg) => {
      messages.push({ text: String(msg?.text ?? ''), msg: { ...msg } })
    })
    const started = await adapter.start()
    if (!started || started.ok !== true) {
      throw new Error(`adapter.start() 没成功：${JSON.stringify(started)}`)
    }
    ws = FakeWS.all[FakeWS.all.length - 1]
    ws.open()
    const hello = ws.find('get_login_info')
    if (hello) {
      ws.push({ status: 'ok', retcode: 0, data: { user_id: SELF, nickname: '验收' }, echo: hello.echo })
    }
    await delay(0)
    return await fn({
      adapter,
      ws,
      logs,
      messages,
      root,
      push: (msg) => ws.push(msg),
    })
  } finally {
    try { await adapter?.stop?.() } catch { /* 收尾不许再抛 */ }
    try { ws?.close?.() } catch { /* ignore */ }
    if (root !== '') {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

/** 等消息递出来，并再多等一小段确认没有「稍后补一条」。 */
async function waitForMessages(rig, count, label, tracker) {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS
  while (rig.messages.length < count && Date.now() < deadline) await delay(10)
  let quietUntil = Date.now() + SETTLE_MS
  let lastSeen = rig.messages.length
  while (Date.now() < quietUntil) {
    await delay(10)
    if (rig.messages.length !== lastSeen) {
      lastSeen = rig.messages.length
      quietUntil = Date.now() + SETTLE_MS
    }
  }
  drainAsyncErrors(tracker, label)
  if (rig.messages.length < count) {
    throw new Error(
      `${label}：等 ${count} 条消息超时（实际 ${rig.messages.length} 条）——实现可能把这条丢在异步链里没递出来`,
    )
  }
  return rig.messages
}

const joinedText = (rig) => rig.messages.map((m) => m.text).join('\n').trim()

// ---------------------------------------------------------------------------
// 断言：正文干净 / 没听清
// ---------------------------------------------------------------------------

function assertCleanText(text, label) {
  assert.ok(!/\[CQ:record/i.test(text), `${label}：正文里出现了 CQ 机器码「[CQ:record…」`)
  assert.ok(!/base64:\/\//i.test(text), `${label}：正文里出现了 base64 地址`)
  assert.ok(!/[A-Za-z0-9+/]{160,}={0,2}/.test(text), `${label}：正文里有长 base64 块（音频字节不许进账本）`)
  assert.ok(!text.includes('\u0000'), `${label}：正文里混进了二进制 NUL 字节`)
}

function assertUnheard(text, label) {
  assert.ok(
    UNHEARD_RE.test(text),
    `${label}：没写「没听清」类说明；实际 text=${JSON.stringify(text)}`,
  )
  assert.ok(
    !text.includes(FABRICATED),
    `${label}：账本里出现了我们喂的假转写「${FABRICATED}」——失败路径不许编内容`,
  )
  assertCleanText(text, label)
}

// ---------------------------------------------------------------------------
// 消息夹具
// ---------------------------------------------------------------------------

let messageSeq = 7000
const nextMessageId = () => ++messageSeq

function dm(over = {}) {
  return {
    post_type: 'message',
    time: Math.floor(T0 / 1000),
    self_id: SELF,
    message_type: 'private',
    message_id: nextMessageId(),
    user_id: 20002,
    sender: { nickname: '阿明' },
    ...over,
  }
}

/** OneBot 11 record 段：url 指向本机临时端口，万一实现没走注入的下载也不会去外网。 */
function recordSeg({ file = 'voice-one.amr', url = 'http://127.0.0.1:1/voice-one.amr', size = 2048 } = {}) {
  return { type: 'record', data: { file, url, file_size: size } }
}

// ---------------------------------------------------------------------------
// 场景 A：正常路径
// ---------------------------------------------------------------------------

async function scenarioA(ctx) {
  const ear = fakeEar({ available: true, result: { ok: true, text: FABRICATED } })
  const fetchAudio = fakeFetchAudio({ bytes: makeWav(Buffer.from('voice-a')) })
  const transcode = fakeTranscode({ bytes: makeWav(Buffer.from('voice-a')) })
  return withAdapter(ctx, { ear, fetchAudio, transcode }, async (rig) => {
    rig.push(dm({ message: [recordSeg()] }))
    await waitForMessages(rig, 1, 'A', ctx.tracker)
    const text = joinedText(rig)
    assert.ok(text.includes(FABRICATED), `A：heard 正文里没有转写内容；实际 text=${JSON.stringify(text)}`)
    assertCleanText(text, 'A')
    assert.ok(ear.calls.length >= 1, 'A：假 ear 一次都没被调用——转写不是从注入的耳朵来的')
    return `text=${JSON.stringify(text)} · available×${ear.availableCalls} hear×${ear.calls.length} fetch×${fetchAudio.calls.length} transcode×${transcode.calls.length}`
  })
}

// ---------------------------------------------------------------------------
// 场景 B：失败矩阵（4 种）
// ---------------------------------------------------------------------------

/** 失败路径的公共断言：消息要递出来、要有「没听清」、不许编内容。 */
async function runFailureCase(ctx, label, parts) {
  return withAdapter(ctx, parts, async (rig) => {
    rig.push(dm({ message: [recordSeg()] }))
    await waitForMessages(rig, 1, label, ctx.tracker)
    const text = joinedText(rig)
    assert.ok(text !== '', `${label}：消息递出来了但正文是空的——失败路径也要写一句「没听清」`)
    assertUnheard(text, label)
    parts.onDelivered?.({ text, ...parts })
    return `text=${JSON.stringify(text)} · available×${parts.ear.availableCalls} hear×${parts.ear.calls.length} fetch×${parts.fetchAudio.calls.length} transcode×${parts.transcode.calls.length}`
  })
}

async function scenarioB1(ctx) {
  // 耳朵不可用：available() 返回 false。hear() 仍会返回成功——实现若无视 available
  // 直接调用，就会把「今天好累」写进账本，被「不许编内容」逮住。
  const ear = fakeEar({ available: false, result: { ok: true, text: FABRICATED } })
  return runFailureCase(ctx, 'B1', {
    ear,
    fetchAudio: fakeFetchAudio(),
    transcode: fakeTranscode(),
  })
}

async function scenarioB2(ctx) {
  const fetchAudio = fakeFetchAudio({ fail: new Error('下载失败（验收注入）') })
  return runFailureCase(ctx, 'B2', {
    ear: fakeEar({ available: true, result: { ok: true, text: FABRICATED } }),
    fetchAudio,
    transcode: fakeTranscode(),
    onDelivered: () => {
      assert.ok(
        fetchAudio.calls.length >= 1,
        'B2：注入的 fetchAudio 一次都没被调用——下载没走注入点，这个失败场景没验到',
      )
    },
  })
}

async function scenarioB3(ctx) {
  const transcode = fakeTranscode({ fail: new Error('转码失败（验收注入）') })
  return runFailureCase(ctx, 'B3', {
    ear: fakeEar({ available: true, result: { ok: true, text: FABRICATED } }),
    fetchAudio: fakeFetchAudio(),
    transcode,
    onDelivered: () => {
      assert.ok(
        transcode.calls.length >= 1,
        'B3：注入的 transcode 一次都没被调用——转码没走注入点，这个失败场景没验到',
      )
    },
  })
}

async function scenarioB4(ctx) {
  const ear = fakeEar({ available: true, result: { ok: false, why: 'empty-text' } })
  return runFailureCase(ctx, 'B4', {
    ear,
    fetchAudio: fakeFetchAudio(),
    transcode: fakeTranscode(),
    onDelivered: () => {
      assert.ok(ear.calls.length >= 1, 'B4：假 ear 没被调用，empty-text 不是从耳朵来的')
    },
  })
}

// ---------------------------------------------------------------------------
// 场景 C：两条语音的顺序
// ---------------------------------------------------------------------------

async function scenarioC(ctx) {
  // 用音频字节里带的标记（voice-one / voice-two）认是哪一段；transcode 原样透传。
  // 这样即使实现并发转写，也能验证「正文顺序 = 段顺序」。
  const transcode = fakeTranscode()
  const earCalls = []
  let earAvailableCalls = 0
  const ear = {
    calls: earCalls,
    get availableCalls() { return earAvailableCalls },
    available: () => { earAvailableCalls += 1; return true },
    hear: async (wav) => {
      earCalls.push(wav)
      let marker = ''
      try { marker = Buffer.from(wav).toString('utf8') } catch { /* ignore */ }
      if (marker.includes('voice-two')) return { ok: true, text: '第二句转写' }
      if (marker.includes('voice-one')) return { ok: true, text: '第一句转写' }
      // 兜底：实现若把字节重编码过，按调用先后给（仍应保持段顺序）。
      return { ok: true, text: earCalls.length === 1 ? '第一句转写' : '第二句转写' }
    },
  }
  // fetchAudio 的返回值由段地址决定：别用固定 bytes，按入参造带标记的 WAV。
  const fetchCalls = []
  const fetchBySrc = {
    calls: fetchCalls,
    fetchAudio: async (src) => {
      fetchCalls.push(src)
      const text = String(src ?? '')
      const tag = text.includes('two') ? 'voice-two' : text.includes('one') ? 'voice-one' : 'voice-unknown'
      return makeWav(Buffer.from(tag))
    },
  }
  return withAdapter(ctx, { ear, fetchAudio: fetchBySrc, transcode }, async (rig) => {
    rig.push(dm({
      message: [
        recordSeg({ file: 'voice-one.amr', url: 'http://127.0.0.1:1/voice-one.amr' }),
        recordSeg({ file: 'voice-two.amr', url: 'http://127.0.0.1:1/voice-two.amr' }),
      ],
    }))
    await waitForMessages(rig, 1, 'C', ctx.tracker)
    const text = joinedText(rig)
    const first = text.indexOf('第一句转写')
    const second = text.indexOf('第二句转写')
    assert.ok(first >= 0 && second >= 0, `C：两条转写没有都进正文；实际 text=${JSON.stringify(text)}`)
    assert.ok(
      first < second,
      `C：正文顺序与段顺序不一致（第一句 @${first}，第二句 @${second}）；实际 text=${JSON.stringify(text)}`,
    )
    assertCleanText(text, 'C')
    return `text=${JSON.stringify(text)} · hear×${ear.calls.length} fetch×${fetchBySrc.calls.length}`
  })
}

// ---------------------------------------------------------------------------
// 场景 D：上限（找到常量才验，找不到记 SKIP）
// ---------------------------------------------------------------------------

async function scenarioD(ctx, kind) {
  const limit = kind === 'bytes' ? ctx.impl.limits.bytes[0] : ctx.impl.limits.chars[0]
  if (!limit) throw new Error('没有可验的上限常量')
  if (kind === 'bytes') {
    const fetchAudio = fakeFetchAudio({ bytes: Buffer.alloc(limit.value + 1, 0x41) })
    const transcode = fakeTranscode() // 原样透传：超限归超限，别被「转码成小 WAV」盖住
    return withAdapter(ctx, {
      ear: fakeEar({ available: true, result: { ok: true, text: FABRICATED } }),
      fetchAudio,
      transcode,
    }, async (rig) => {
      // 两处都给超限信号：段元数据 file_size 与真实下载字节，谁先被检查都能触发。
      rig.push(dm({ message: [recordSeg({ size: limit.value + 1 })] }))
      await waitForMessages(rig, 1, 'D', ctx.tracker)
      const text = joinedText(rig)
      assertUnheard(text, 'D')
      return `${limit.name}=${limit.value}，喂 ${limit.value + 1} 字节 → text=${JSON.stringify(text)}`
    })
  }
  // 文本上限：耳朵返回超长文本，超限应走失败路径而不是把长文写进账本。
  const tooLong = '啊'.repeat(limit.value + 1)
  return withAdapter(ctx, {
    ear: fakeEar({ available: true, result: { ok: true, text: tooLong } }),
    fetchAudio: fakeFetchAudio(),
    transcode: fakeTranscode({ bytes: makeWav() }),
  }, async (rig) => {
    rig.push(dm({ message: [recordSeg()] }))
    await waitForMessages(rig, 1, 'D', ctx.tracker)
    const text = joinedText(rig)
    assertUnheard(text, 'D')
    assert.ok(!text.includes(tooLong), `D：超长文本被整段写进账本（${limit.name} 没生效）`)
    return `${limit.name}=${limit.value}，喂 ${limit.value + 1} 字 → text=${JSON.stringify(text.slice(0, 80))}…`
  })
}

// ---------------------------------------------------------------------------
// 场景 E：非语音消息不被污染
// ---------------------------------------------------------------------------

/** 同一份非语音输入：1 条纯文本 + 1 条只有图片。不用 root：不落盘、不下载、不联网。 */
function pollutionInput() {
  return [
    dm({
      message_id: nextMessageId(),
      message: [{ type: 'text', data: { text: '  你好呀  ' } }],
      raw_message: '  你好呀  ',
    }),
    dm({
      message_id: nextMessageId(),
      message: [{ type: 'image', data: { url: 'https://example.com/p.png', file_size: 2048 } }],
    }),
  ]
}

async function runPollutionOnce(ctx, input) {
  const ear = fakeEar({ available: true, result: { ok: true, text: FABRICATED } })
  const fetchAudio = fakeFetchAudio()
  const transcode = fakeTranscode()
  const got = await withAdapter(ctx, { root: '', ear, fetchAudio, transcode }, async (rig) => {
    for (const msg of input) rig.push(msg)
    await waitForMessages(rig, input.length, 'E', ctx.tracker)
    return { messages: rig.messages, ear, fetchAudio, transcode }
  })
  return got
}

async function scenarioE(ctx) {
  const input = pollutionInput()
  const first = await runPollutionOnce(ctx, input)
  const second = await runPollutionOnce(ctx, input)

  // 除时间戳外逐字段一致（at 是唯一允许随跑而变的字段）。
  const comparable = (m) => {
    const { at, ...rest } = m.msg
    return rest
  }
  assert.ok(
    isDeepStrictEqual(first.messages.map(comparable), second.messages.map(comparable)),
    'E：同一份输入跑两次，规范化结果不一致（除时间戳外）',
  )

  const [textMsg, imageMsg] = first.messages
  assert.equal(textMsg.msg.text, '你好呀', 'E：纯文本消息的正文和改动前不一致')
  assert.equal(textMsg.msg.kind, 'dm')
  assert.equal(textMsg.msg.personId, 'u_20002')
  assert.equal(textMsg.msg.personName, '阿明')
  assert.equal(textMsg.msg.attachment, null, 'E：纯文本消息不该凭空多出附件')
  assert.deepEqual(textMsg.msg.images, [], 'E：纯文本消息不该有图')
  assert.equal(textMsg.msg.mentionedSelf, false)

  assert.equal(imageMsg.msg.text, '', 'E：只有图片的消息 text 应为空串（不许编一句话）')
  assert.deepEqual(imageMsg.msg.images, ['https://example.com/p.png'])
  assert.deepEqual(imageMsg.msg.attachment, { type: 'image', size: 2048 })

  const audioTouches = first.ear.calls.length + first.fetchAudio.calls.length + first.transcode.calls.length
  assert.equal(audioTouches, 0, 'E：非语音消息触发了音频管线（ear/fetchAudio/transcode 不该被调用）')
  return `纯文本 text=${JSON.stringify(textMsg.msg.text)}、图片 text=${JSON.stringify(imageMsg.msg.text)}，两跑一致；音频管线 0 次`
}

// ---------------------------------------------------------------------------
// 验收主流程
// ---------------------------------------------------------------------------

export async function runAcceptance(options = {}) {
  const beganAt = Date.now()
  const impl = detectImplementation()
  const tracker = trackAsyncErrors()
  const checks = []
  const push = (group, id, title, status, detail = '') => {
    checks.push({ group, id, title, status, detail: String(detail ?? '') })
  }

  let factory = null
  let importError = null
  try {
    const mod = await import(pathToFileURL(QQ_PATH).href)
    factory = factoryOf(mod)
    if (factory === null) importError = new Error('模块能导入，但没导出 createQQAdapter() 或 create() 工厂函数')
  } catch (error) {
    importError = error
  }

  // 前置：先报告「工装现在能验到哪」，再让 A–E 逐项给结果。
  push('0', 'P1', 'lib/channels/qq.js 可以导入', importError ? 'FAIL' : 'PASS', importError ? errText(importError) : '')
  push(
    '0', 'P2',
    '适配器工厂可创建（createQQAdapter / create）',
    factory ? 'PASS' : 'FAIL',
    factory ? `导出：${factory.name || '匿名函数'}` : errText(importError),
  )
  push(
    '0', 'P3',
    '音频注入点存在（ear / fetchAudio / transcode 或 lib/audio.js）',
    impl.hasAudioPipeline ? 'PASS' : 'FAIL',
    impl.hasAudioPipeline
      ? `标记：${impl.markers.join('、') || 'lib/audio.js'}`
      : '等实现：qq.js 里还没有 fetchAudio/transcode 注入点，lib/audio.js 也不存在',
  )

  const ctx = { factory, impl, tracker }

  const scenarios = [
    { group: 'A', id: 'A1', title: '1 个 record 段 → 正文含转写，无 CQ 机器码 / base64', run: () => scenarioA(ctx) },
    { group: 'B', id: 'B1', title: '失败矩阵① 耳朵不可用（available()=false）', run: () => scenarioB1(ctx) },
    { group: 'B', id: 'B2', title: '失败矩阵② 下载失败（fetchAudio 抛错）', run: () => scenarioB2(ctx) },
    { group: 'B', id: 'B3', title: '失败矩阵③ 转码失败（transcode 抛错）', run: () => scenarioB3(ctx) },
    { group: 'B', id: 'B4', title: '失败矩阵④ 转写为空（hear → {ok:false,why:"empty-text"}）', run: () => scenarioB4(ctx) },
    { group: 'C', id: 'C1', title: '2 个 record 段 → 两条转写都在，顺序与段顺序一致', run: () => scenarioC(ctx) },
    { group: 'E', id: 'E1', title: '纯文本 / 图片两次跑一致，音频注入不被触碰', run: () => scenarioE(ctx) },
  ]

  if (factory === null) {
    for (const s of scenarios) {
      push(s.group, s.id, s.title, 'FAIL', '等实现：找不到适配器工厂，无法驱动入站消息')
    }
  } else {
    for (const s of scenarios) {
      tracker.clear()
      let status = 'PASS'
      let detail = ''
      try {
        detail = (await s.run()) ?? ''
      } catch (error) {
        status = 'FAIL'
        detail = errText(error)
      }
      // 场景自己 drain 过；这里再兜一次：PASS 之后漏出来的异步异常也算红。
      await delay(20)
      const leftovers = tracker.take()
      if (leftovers.length > 0) {
        const line = `出现未捕获的异步异常：${leftovers.map(errText).join(' / ')}`
        if (status === 'PASS') {
          status = 'FAIL'
          detail = line
        } else {
          detail += `；另外${line}`
        }
      }
      push(s.group, s.id, s.title, status, detail)
    }
  }

  // D：只有找到上限常量才验；找不到按规格跳过并说明。
  const { bytes, chars } = impl.limits
  if (factory === null) {
    push('D', 'D1', '上限：超限走失败路径而不是抛错', 'SKIP', '等实现：找不到适配器工厂，且实现里也没有上限常量')
  } else if (bytes.length === 0 && chars.length === 0) {
    push(
      'D', 'D1',
      '上限：超限走失败路径而不是抛错',
      'SKIP',
      '实现里没找到「最大下载字节 / 最长文本」常量（已扫 lib/channels/qq.js 与 lib/audio.js）；等实现合并后复跑',
    )
  } else {
    const cases = []
    if (bytes.length > 0) cases.push({ id: 'D1', kind: 'bytes', limit: bytes[0] })
    if (chars.length > 0) cases.push({ id: bytes.length > 0 ? 'D2' : 'D1', kind: 'chars', limit: chars[0] })
    for (const item of cases) {
      tracker.clear()
      const title = item.kind === 'bytes'
        ? `上限：${item.limit.name}=${item.limit.value} 字节，超 1 字节走失败路径`
        : `上限：${item.limit.name}=${item.limit.value} 字，超 1 字走失败路径`
      try {
        const detail = await scenarioD(ctx, item.kind)
        push('D', item.id, title, 'PASS', detail)
      } catch (error) {
        push('D', item.id, title, 'FAIL', errText(error))
      }
      tracker.clear()
    }
  }

  tracker.stop()

  // 实现没合并 / 工厂缺失时的红，标成「等实现」；--allow-missing 时转 SKIP。
  const implementationMissing = !impl.hasAudioPipeline || factory === null
  let pending = 0
  for (const check of checks) {
    if (check.status !== 'FAIL' || !implementationMissing) continue
    check.pending = true
    pending += 1
  }
  if (options.allowMissing === true) {
    for (const check of checks) {
      if (!check.pending) continue
      check.status = 'SKIP'
      check.detail = `等实现合并后复跑：${check.detail}`
    }
    pending = 0
  }

  const counts = { pass: 0, fail: 0, skip: 0 }
  for (const check of checks) {
    if (check.status === 'PASS') counts.pass += 1
    else if (check.status === 'FAIL') counts.fail += 1
    else counts.skip += 1
  }

  return {
    checks,
    counts,
    pending,
    implementation: impl,
    factoryName: factory ? (factory.name || '匿名函数') : '',
    elapsedMs: Date.now() - beganAt,
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function oneLine(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function limitSummary(limits) {
  const parts = []
  for (const item of limits.bytes) parts.push(`${item.name}=${item.value}（字节）`)
  for (const item of limits.chars) parts.push(`${item.name}=${item.value}（字）`)
  return parts.length > 0 ? parts.join('、') : '没找到'
}

const GROUP_TITLES = {
  0: '前置',
  A: 'A 正常路径',
  B: 'B 失败矩阵（4 种逐个验）',
  C: 'C 顺序',
  D: 'D 上限',
  E: 'E 不污染',
  '?': '补充项',
}

export function formatReport(result) {
  const lines = []
  const impl = result.implementation
  lines.push('云雀 · 耳朵验收工装（A–E）')
  lines.push(`仓库：${impl.repo}`)
  lines.push('')
  lines.push('实现检测：')
  lines.push(`  lib/audio.js        ${impl.audioFile ? '有' : '没有'}`)
  lines.push(`  qq.js 注入点标记    ${impl.markers.length > 0 ? impl.markers.join('、') : '（无）'}`)
  if (!impl.qqSourcePresent) lines.push(`  qq.js 读取失败      ${impl.qqError || '未知'}`)
  lines.push(`  适配器工厂          ${result.factoryName || '找不到'}`)
  lines.push(`  上限常量            ${limitSummary(impl.limits)}`)
  lines.push(
    `  结论                ${impl.hasAudioPipeline
      ? '音频管线已就位，可以验收'
      : '等实现合并（A / B / C 现在红是预期，合并后复跑）'}`,
  )
  lines.push('')
  for (const key of ['0', 'A', 'B', 'C', 'D', 'E', '?']) {
    const rows = result.checks.filter((check) => check.group === key)
    if (rows.length === 0) continue
    lines.push(`[${key}] ${GROUP_TITLES[key]}`)
    for (const check of rows) {
      const detail = check.detail === '' ? '' : `  ${oneLine(check.detail, 200)}`
      lines.push(`  ${check.status.padEnd(4)} ${check.id.padEnd(3)} ${check.title}${detail}`)
    }
    lines.push('')
  }
  lines.push(
    `统计：PASS ${result.counts.pass} / FAIL ${result.counts.fail} / SKIP ${result.counts.skip}`
    + (result.pending > 0 ? `（其中 ${result.pending} 条属于「等实现」，实现合并后复跑）` : ''),
  )
  lines.push(`耗时：${result.elapsedMs}ms`)
  lines.push(`退出码：${result.counts.fail > 0 ? 1 : 0}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `用法：
  node tools/acceptance-ears.mjs                 严格验收（有 FAIL 就退出码 1）
  node tools/acceptance-ears.mjs --allow-missing 实现未合并时把「等实现」的失败记成 SKIP、退出码 0
  node tools/acceptance-ears.mjs --help          看这行

验的是 lib/channels/qq.js 递给 router 的规范化消息（item.text 即 heard 正文主体）。
零依赖；不联网、不碰真 ffmpeg、不写真实账本。`

function isMain() {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const unknown = argv.filter((arg) => arg !== '--allow-missing')
  if (unknown.length > 0) {
    console.error(`不认识的参数：${unknown.join(' ')}（--help 看用法）`)
    process.exitCode = 2
    return
  }
  const result = await runAcceptance({ allowMissing: argv.includes('--allow-missing') })
  console.log(formatReport(result))
  process.exitCode = result.counts.fail > 0 ? 1 : 0
}

if (isMain()) {
  main().catch((error) => {
    console.error('验收工装自身出错：', error)
    process.exitCode = 2
  })
}
