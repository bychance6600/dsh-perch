/**
 * qq-voice.test.mjs —— QQ 入站语音：把语音转成她听到的话（2026-11-14）。
 *
 * 全程不碰真网络、不跑真 ffmpeg：音频下载与转码都用注入的假实现
 * （create() 的 fetchAudio / transcode），耳朵用假 ear；只有 lib/audio.js
 * 的两个函数拿假 fetch / 不存在的 ffmpeg 单测。
 *
 * 核心断言：没装耳朵、下载失败、转码失败、转写为空——四种都只记「没听清」，
 * 绝不允许把猜测写进她听到的话（任务与 AGENTS §9）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { create } from '../lib/channels/qq.js'
import { decodeToWav, downloadAudio } from '../lib/audio.js'

const T0 = 1700000000000
const SELF = 10001

/** 假 WebSocket：只需要 open / push / close（语音测试不发消息）。 */
class FakeWS {
  static all = []

  static reset() {
    FakeWS.all = []
  }

  static get last() {
    return FakeWS.all[FakeWS.all.length - 1]
  }

  constructor(url) {
    this.url = url
    this.frames = []
    FakeWS.all.push(this)
  }

  send(payload) {
    this.frames.push(JSON.parse(payload))
  }

  close() {
    this.onclose?.({ code: 1000 })
  }

  open() {
    this.readyState = 1
    this.onopen?.({})
  }

  push(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

/** 假时钟：把适配器自己的 setTimeout 收上来，用例结束 stop() 时清掉。 */
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
    tick(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms <= ms) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    size() {
      return timers.size
    },
  }
}

function setup(extra = {}) {
  FakeWS.reset()
  const clock = fakeClock()
  const messages = []
  const logs = []
  const adapter = create({
    log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    config: { wsUrl: 'ws://127.0.0.1:3001', token: '' },
    WebSocketImpl: FakeWS,
    now: () => T0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  })
  adapter.onMessage((m) => messages.push(m))
  return { adapter, clock, messages, logs }
}

async function started(extra = {}) {
  const ctx = setup(extra)
  const res = await ctx.adapter.start()
  assert.equal(res.ok, true)
  const ws = FakeWS.last
  ws.open()
  return { ...ctx, ws }
}

/** 等异步转写链跑完（假时钟只管适配器定时器，这里用真 setImmediate 轮询）。 */
async function waitFor(fn, why = '条件') {
  for (let i = 0; i < 400; i += 1) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${why}`)
}

let mid = 5000

function group(over = {}) {
  return { post_type: 'message', time: 1700000000, self_id: SELF, message_type: 'group', message_id: ++mid, group_id: 30003, user_id: 20002, ...over }
}

/** 假耳朵：可安排可用性、每次转写的返回文本。 */
function fakeEar({ available = true, texts = ['明天下午三点见'], result = null } = {}) {
  const calls = { available: 0, heard: [] }
  let i = 0
  return {
    calls,
    available() {
      calls.available += 1
      return available
    },
    async hear(wav) {
      calls.heard.push(wav)
      if (result !== null) return result
      const text = texts[Math.min(i, texts.length - 1)]
      i += 1
      return { ok: true, text }
    },
  }
}

/** 假下载：记下地址，返回临时路径 + cleanup 回调（记下清理了谁）。 */
function fakeAudioFetch({ paths = ['/tmp/fake-voice.amr'], fail = null } = {}) {
  const calls = []
  const cleaned = []
  let i = 0
  return {
    calls,
    cleaned,
    async fetchAudio(url) {
      calls.push(url)
      if (fail !== null) return { ok: false, why: fail }
      const path = paths[Math.min(i, paths.length - 1)]
      i += 1
      return { ok: true, path, bytes: 2048, cleanup: async () => { cleaned.push(path) } }
    },
  }
}

/** 假转码：记下输入路径，返回一段「WAV」。 */
function fakeTranscode({ fail = null } = {}) {
  const calls = []
  return {
    calls,
    async transcode(path) {
      calls.push(path)
      if (fail !== null) throw new Error(fail)
      return Buffer.from('RIFF....WAVEfmt ', 'latin1')
    },
  }
}

/** 语音段消息：默认 12 秒、10MB 内。 */
function voiceMessage(over = {}) {
  return group({
    message: [{ type: 'record', data: { url: 'https://example.com/voice.amr', file_size: 2048, duration: 12 } }],
    ...over,
  })
}

const UNHEARD_12 = '[语音 12 秒：这台机器没装耳朵]'
const UNHEARD_FAIL_12 = '[语音 12 秒：没听清]'

// ---- 1. 耳朵可用：转写追加进 heard 文本 ----

test('有语音、耳朵可用：转写内容追加到 text 末尾，不带机器码/地址，临时文件删掉', async () => {
  const ear = fakeEar({ texts: ['明天下午三点见'] })
  const audio = fakeAudioFetch({ paths: ['/tmp/qq-voice-1.amr'] })
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(voiceMessage({
      message: [
        { type: 'text', data: { text: '听一下' } },
        { type: 'record', data: { url: 'https://example.com/voice.amr', file_size: 2048, duration: 12 } },
      ],
    }))
    await waitFor(() => messages.length === 1, '语音转写')

    const m = messages[0]
    assert.equal(m.text, '听一下\n[语音] 明天下午三点见（语音 12 秒）')
    assert.equal(m.text.includes('[CQ:'), false, '机器码不许进她听到的话')
    assert.equal(m.text.includes('http'), false)
    assert.equal(m.text.includes('.amr'), false)
    assert.equal('records' in m, false, '语音地址是临时料，不进消息/账本')
    assert.deepEqual(audio.calls, ['https://example.com/voice.amr'])
    assert.deepEqual(tr.calls, ['/tmp/qq-voice-1.amr'])
    assert.equal(ear.calls.heard.length, 1)
    assert.ok(Buffer.isBuffer(ear.calls.heard[0]), '耳朵收到的是转码后的 WAV')
    assert.deepEqual(audio.cleaned, ['/tmp/qq-voice-1.amr'], '下载的临时文件必须删')
    // 附件元数据仍按契约保留（类型 + 字节数），只是正文换成转写。
    assert.deepEqual(m.attachment, { type: 'record', size: 2048 })
  } finally {
    adapter.stop()
  }
})

// ---- 2. 耳朵不可用：说没听清，不猜 ----

test('耳朵不可用：只追加「没听清」，不下载、不转码、不转写', async () => {
  const ear = fakeEar({ available: false })
  const audio = fakeAudioFetch()
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(voiceMessage())
    await waitFor(() => messages.length === 1, '语音降级')

    const m = messages[0]
    assert.equal(m.text, UNHEARD_12)
    assert.equal(m.text.includes('明天'), false, '不许编内容')
    assert.equal(m.text.includes('三点'), false)
    assert.equal(ear.calls.available > 0, true, '先问耳朵在不在')
    assert.deepEqual(audio.calls, [], '耳朵不在就别浪费下载')
    assert.deepEqual(tr.calls, [], '耳朵不在就别转码')
    assert.equal(ear.calls.heard.length, 0)
  } finally {
    adapter.stop()
  }
})

// ---- 3. 下载失败 ----

test('下载失败：只追加「没听清」，不转码、不转写，日志留原因', async () => {
  const ear = fakeEar()
  const audio = fakeAudioFetch({ fail: 'HTTP 404' })
  const tr = fakeTranscode()
  const { adapter, messages, logs, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(voiceMessage())
    await waitFor(() => messages.length === 1, '下载失败降级')

    assert.equal(messages[0].text, UNHEARD_FAIL_12)
    assert.equal(messages[0].text.includes('三点'), false)
    assert.deepEqual(tr.calls, [], '没下到就不转码')
    assert.equal(ear.calls.heard.length, 0)
    assert.equal(logs.join('\n').includes('语音下载失败'), true)
  } finally {
    adapter.stop()
  }
})

// ---- 4. 转码失败（典型：silk 解不了）----

test('转码失败：只追加「没听清」，临时文件照样清理，不转写', async () => {
  const ear = fakeEar()
  const audio = fakeAudioFetch({ paths: ['/tmp/qq-voice-silk.amr'] })
  const tr = fakeTranscode({ fail: 'silk 解不了' })
  const { adapter, messages, logs, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(voiceMessage())
    await waitFor(() => messages.length === 1, '转码失败降级')

    assert.equal(messages[0].text, UNHEARD_FAIL_12)
    assert.equal(ear.calls.heard.length, 0)
    assert.deepEqual(audio.cleaned, ['/tmp/qq-voice-silk.amr'], '转码失败也不能留临时文件')
    assert.equal(logs.join('\n').includes('语音转码失败'), true)
  } finally {
    adapter.stop()
  }
})

// ---- 5. 转写为空 / 服务失败 ----

test('转写为空或失败：只追加「没听清」，不把空格/失败当内容', async () => {
  const emptyEar = fakeEar({ result: { ok: true, text: '   \n  ' } })
  const failedEar = fakeEar({ result: { ok: false, why: 'failed' } })
  const audio = fakeAudioFetch()
  const tr = fakeTranscode()

  for (const [ear, label] of [[emptyEar, '空文本'], [failedEar, '服务失败']]) {
    const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
    try {
      ws.push(voiceMessage())
      await waitFor(() => messages.length === 1, label)
      assert.equal(messages[0].text, UNHEARD_FAIL_12, label)
      assert.equal(messages[0].text.includes('三点'), false)
    } finally {
      adapter.stop()
    }
  }
})

// ---- 6. 多条语音按消息里的顺序 ----

test('一条消息里多条语音：按顺序各占一行', async () => {
  const ear = fakeEar({ texts: ['第一段', '第二段'] })
  const audio = fakeAudioFetch({ paths: ['/tmp/v1.amr', '/tmp/v2.amr'] })
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(voiceMessage({
      message: [
        { type: 'text', data: { text: '两段语音' } },
        { type: 'record', data: { url: 'https://example.com/1.amr', duration: 3 } },
        { type: 'record', data: { url: 'https://example.com/2.amr', duration: 7 } },
      ],
    }))
    await waitFor(() => messages.length === 1, '多条语音')

    assert.equal(messages[0].text, '两段语音\n[语音] 第一段（语音 3 秒）\n[语音] 第二段（语音 7 秒）')
    assert.deepEqual(audio.calls, ['https://example.com/1.amr', 'https://example.com/2.amr'])
    assert.deepEqual(tr.calls, ['/tmp/v1.amr', '/tmp/v2.amr'])
    assert.deepEqual(audio.cleaned, ['/tmp/v1.amr', '/tmp/v2.amr'])
  } finally {
    adapter.stop()
  }
})

// ---- 7. 非语音消息不受影响（回归）----

test('非语音消息：仍同步送达，text 原样，不碰耳朵/下载/转码', async () => {
  const ear = fakeEar()
  const audio = fakeAudioFetch()
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(group({ message: [{ type: 'text', data: { text: '  就一句文字  ' } }] }))
    // 没有语音/图片：保持同步交付（旧行为，单测与线上顺序都依赖它）。
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, '就一句文字')
    assert.equal('records' in messages[0], false)
    assert.equal(ear.calls.available, 0)
    assert.deepEqual(audio.calls, [])
    assert.deepEqual(tr.calls, [])
  } finally {
    adapter.stop()
  }
})

// ---- 8. post_format=string（CQ 码）里的语音 ----

test('CQ 码字符串里的 [CQ:record]：解析地址与时长，机器码不进正文', async () => {
  const ear = fakeEar({ texts: ['这是语音'] })
  const audio = fakeAudioFetch({ paths: ['/tmp/cq.amr'] })
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(group({
      message: '[CQ:record,file=a.amr,url=https://example.com/b.amr,file_size=4096,duration=5]',
    }))
    await waitFor(() => messages.length === 1, 'CQ 语音')

    const m = messages[0]
    assert.equal(m.text, '[语音] 这是语音（语音 5 秒）')
    assert.equal(m.text.includes('[CQ:'), false)
    assert.deepEqual(audio.calls, ['https://example.com/b.amr'])
    assert.deepEqual(m.attachment, { type: 'record', size: 4096 })
  } finally {
    adapter.stop()
  }
})

// ---- 9. 语音条数上限 ----

test('一条消息超过 4 条语音：只转写前 4 条，附件元数据仍全算', async () => {
  const ear = fakeEar({ texts: ['一', '二', '三', '四', '五'] })
  const audio = fakeAudioFetch({ paths: ['/tmp/a.amr', '/tmp/b.amr', '/tmp/c.amr', '/tmp/d.amr', '/tmp/e.amr'] })
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    const message = Array.from({ length: 5 }, (_v, i) => ({
      type: 'record',
      data: { url: `https://example.com/${i + 1}.amr`, file_size: 100, duration: 1 },
    }))
    ws.push(group({ message }))
    await waitFor(() => messages.length === 1, '语音上限')

    assert.equal(audio.calls.length, 4)
    assert.equal(ear.calls.heard.length, 4)
    assert.equal(messages[0].text, '[语音] 一（语音 1 秒）\n[语音] 二（语音 1 秒）\n[语音] 三（语音 1 秒）\n[语音] 四（语音 1 秒）')
    assert.deepEqual(messages[0].attachment, { type: 'record', size: 500 })
  } finally {
    adapter.stop()
  }
})

// ---- 10. 语音段没有地址 / 耳朵自身出错 ----

test('语音段拿不到地址：记「没听清」，不去下载', async () => {
  const ear = fakeEar()
  const audio = fakeAudioFetch()
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    ws.push(group({ message: [{ type: 'record', data: { file_size: 1024 } }] }))
    await waitFor(() => messages.length === 1, '无地址语音')
    assert.equal(messages[0].text, '[语音：没听清]')
    assert.deepEqual(audio.calls, [])
  } finally {
    adapter.stop()
  }
})

test('耳朵 available() 自己抛错：适配器不抛，退化成「没听清」', async () => {
  const ear = {
    available() { throw new Error('ctx 坏了') },
    async hear() { throw new Error('不该走到这里') },
  }
  const audio = fakeAudioFetch()
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({ ear, fetchAudio: audio.fetchAudio, transcode: tr.transcode })
  try {
    assert.doesNotThrow(() => ws.push(voiceMessage()))
    await waitFor(() => messages.length === 1, '耳朵抛错降级')
    assert.equal(messages[0].text, UNHEARD_FAIL_12)
    assert.deepEqual(audio.calls, [])
    assert.deepEqual(tr.calls, [])
  } finally {
    adapter.stop()
  }
})

// ---- 11. 图片与语音混在同一条消息：先图片后语音，顺序不乱 ----

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

test('图片 + 语音同一条：先追加图片路径，再追加语音转写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qq-voice-mix-'))
  const ear = fakeEar({ texts: ['我看到了' ] })
  const audio = fakeAudioFetch({ paths: ['/tmp/mix.amr'] })
  const tr = fakeTranscode()
  const { adapter, messages, ws } = await started({
    root,
    ear,
    fetchAudio: audio.fetchAudio,
    transcode: tr.transcode,
    fetchImpl: async () => new Response(PNG_BYTES, { status: 200 }),
  })
  try {
    ws.push(group({
      message: [
        { type: 'text', data: { text: '你看' } },
        { type: 'image', data: { url: 'https://example.com/pic.png', file_size: 16 } },
        { type: 'record', data: { url: 'https://example.com/mix.amr', duration: 4 } },
      ],
    }))
    await waitFor(() => messages.length === 1, '图片+语音')

    const name = `${createHash('sha1').update(PNG_BYTES).digest('hex').slice(0, 16)}.png`
    assert.equal(messages[0].text, `你看\n[图片：media/qq/${name}]\n[语音] 我看到了（语音 4 秒）`)
    assert.equal(existsSync(join(root, 'media', 'qq', name)), true)
  } finally {
    adapter.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- 12. lib/audio.js 自己的两个函数（不依赖真 ffmpeg）----

test('downloadAudio：下载到 0600 临时文件，cleanup 删掉；超上限直接失败', async () => {
  const bytes = Uint8Array.from([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a])
  const res = await downloadAudio('https://example.com/a.amr', {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
    maxBytes: 1024,
    timeoutMs: 5000,
  })
  assert.equal(res.ok, true)
  try {
    assert.equal(existsSync(res.path), true)
    assert.equal(statSync(res.path).mode & 0o777, 0o600)
    assert.deepEqual(readFileSync(res.path), Buffer.from(bytes))
  } finally {
    await res.cleanup()
  }
  assert.equal(existsSync(res.path), false, 'cleanup 之后临时文件不许留下')

  const tooBig = await downloadAudio('https://example.com/big.amr', {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
    maxBytes: 2,
    timeoutMs: 5000,
  })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.why, /太大/)
})

test('decodeToWav：没有 ffmpeg 时抛错（不是静默返回空 Buffer）', async () => {
  await assert.rejects(
    () => decodeToWav('/tmp/whatever.amr', { ffmpegPath: '/nonexistent/ffmpeg-xyz', timeoutMs: 5000 }),
    (error) => /ffmpeg/.test(String(error?.message ?? '')),
  )
  await assert.rejects(
    () => decodeToWav('', { ffmpegPath: 'ffmpeg' }),
    (error) => /没有音频文件/.test(String(error?.message ?? '')),
  )
})
