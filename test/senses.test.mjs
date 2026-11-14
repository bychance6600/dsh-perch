import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEar, heardNote, unheardNote } from '../lib/senses.js'

const wav = Buffer.from('RIFF....fake-wav-bytes')

function stubService({ text = '他说明天回来', fail = null } = {}) {
  const calls = []
  return {
    calls,
    get(name) {
      if (name !== 'speechToText') return null
      return {
        resolve(req) {
          calls.push(['resolve', req])
          return { provider: 'sensevoice-local', audio: req.audio, language: req.language }
        },
        async transcribe(spec) {
          calls.push(['transcribe', spec])
          if (fail) throw new Error(fail)
          return { text }
        },
      }
    },
  }
}

test('没有服务：明说没装，不抛', async () => {
  const ear = createEar({ get: () => null })
  assert.equal(ear.available(), false)
  const r = await ear.hear(wav)
  assert.deepEqual(r, { ok: false, why: 'no-service' })
})

test('有服务：把 WAV 与语言交过去，返回去空白后的文字', async () => {
  const ctx = stubService({ text: '  他说明天\n回来。 ' })
  const ear = createEar(ctx)
  assert.equal(ear.available(), true)
  const r = await ear.hear(wav)
  assert.equal(r.ok, true)
  assert.equal(r.text, '他说明天 回来。')
  assert.equal(ctx.calls[0][1].language, 'zh')
  assert.equal(ctx.calls[0][1].audio, wav)
})

test('空音频：直接拒绝，不去打扰服务', async () => {
  const ctx = stubService()
  const ear = createEar(ctx)
  const r = await ear.hear(Buffer.alloc(0))
  assert.deepEqual(r, { ok: false, why: 'empty-audio' })
  assert.equal(ctx.calls.length, 0)
})

test('转写失败：包成 failed，不抛', async () => {
  const ear = createEar(stubService({ fail: '模型没准备好' }))
  const r = await ear.hear(wav)
  assert.equal(r.ok, false)
  assert.equal(r.why, 'failed')
  assert.match(r.error, /模型没准备好/)
})

test('转写回来是空白：算 empty-text，不写一句空话', async () => {
  const ear = createEar(stubService({ text: '   ' }))
  const r = await ear.hear(wav)
  assert.deepEqual(r, { ok: false, why: 'empty-text' })
})

test('降级文案与听清文案的写法', () => {
  assert.equal(unheardNote(12), '[语音 12 秒：这台机器没装耳朵]')
  assert.equal(unheardNote(0), '[语音：这台机器没装耳朵]')
  assert.equal(heardNote('他说明天回来', 12), '[语音] 他说明天回来（语音 12 秒）')
  assert.equal(heardNote('他说明天回来', 0), '[语音] 他说明天回来')
})

test('准备模型：未准备时先让宿主 prepare，好了再转写', async () => {
  let prepared = 0
  let phase = 'unprepared'
  const svc = {
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', preparation: { phase, steps: [] } }],
      selection: { providerId: 'sensevoice-local' },
    }),
    prepare: (id) => {
      prepared += 1
      if (id !== 'sensevoice-local') throw new Error('错的 provider')
      phase = 'downloading'
      setTimeout(() => { phase = 'ready' }, 20)
    },
    resolve: () => ({}),
    transcribe: async () => ({ text: '准备好了' }),
  }
  const ctx = { get: (k) => (k === 'speechToText' ? svc : null) }
  const ear = createEar(ctx, { timeoutMs: 5000 })
  const r = await ear.hear(Buffer.from([1, 2, 3]))
  assert.equal(r.ok, true)
  assert.equal(r.text, '准备好了')
  assert.equal(prepared, 1)
})

test('准备失败：把失败原因带回来，不假装听清了', async () => {
  const svc = {
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', preparation: { phase: 'failed', steps: [{ status: 'failed', message: '下载没成功' }] } }],
      selection: { providerId: 'sensevoice-local' },
    }),
    prepare: () => { throw new Error('不该走到这里') },
    resolve: () => ({}),
    transcribe: async () => ({ text: '' }),
  }
  const ctx = { get: (k) => (k === 'speechToText' ? svc : null) }
  const ear = createEar(ctx, { timeoutMs: 2000 })
  const r = await ear.hear(Buffer.from([1]))
  assert.equal(r.ok, false)
  assert.equal(r.why, 'failed')
  assert.match(String(r.error), /下载没成功/)
})
