/**
 * 耳朵：把一段音频交给宿主的语音转文字服务。
 *
 * 2026-11-14（主人定）：只做本地，不接云端；拿不到服务就明说没装，绝不猜内容。
 * 宿主服务是实验性包 `@deepseek-ai/dsh-experimental-speech-to-text` 暴露的
 * `ctx.speechToText`：`resolve({ audio, language })` → `transcribe(spec, signal)` → `{ text }`。
 * 这个契约只出现在本文件里——它改名/改签名，只改这一个文件。
 */

/** 取服务：拿不到就是 null，不抛。 */
function serviceOf(ctx) {
  try {
    const svc =
      (typeof ctx?.get === 'function' ? ctx.get('speechToText') : null) ??
      ctx?.speechToText ??
      null
    if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') return null
    return svc
  } catch {
    return null
  }
}

/**
 * 造一个耳朵。
 * @param {object} ctx 宿主上下文（cordis）
 * @param {{ timeoutMs?: number, language?: string }} [opts]
 */
export function createEar(ctx, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000
  const language = String(opts.language ?? 'zh')

  return {
    /** 服务在不在（设置页要显示这个）。 */
    available() {
      return serviceOf(ctx) !== null
    },

    /**
     * 听一段 WAV。
     * @param {Buffer|Uint8Array} wav 16 kHz 单声道 PCM16 的 WAV 字节
     * @returns {Promise<{ok:true,text:string}|{ok:false,why:string,error?:string}>}
     */
    async hear(wav) {
      const svc = serviceOf(ctx)
      if (!svc) return { ok: false, why: 'no-service' }
      if (!wav || !wav.length) return { ok: false, why: 'empty-audio' }

      // 模型第一次用要先准备（下载 ≈239MB）。这一步可能比转写本身长得多，
      // 所以**不能**套用转写的 60 秒超时——它有自己的等待上限（PREPARE_WAIT_MS）。
      const ready = await ensureReady(svc)
      if (!ready.ok) return ready

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error('转写超时')), timeoutMs)
      try {
        const spec = svc.resolve({ audio: wav, language })
        const res = await svc.transcribe(spec, ac.signal)
        const text = String(res?.text ?? '').replace(/\s+/g, ' ').trim()
        return text ? { ok: true, text } : { ok: false, why: 'empty-text' }
      } catch (error) {
        return { ok: false, why: 'failed', error: String(error?.message ?? error) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * 宿主的转写服务在「模型没准备好」时会直接拒（真机上见过
 * `Prepare the local speech provider before recording`）。准备是宿主那边的活儿：
 * 调 `prepare(id)` 开始下载/加载，`snapshot()` 看进度。这里只做「等它好」。
 */
const PREPARE_WAIT_MS = 15 * 60 * 1000

function providerIdOf(svc) {
  try {
    const id = svc?.snapshot?.()?.selection?.providerId
    if (typeof id === 'string' && id) return id
  } catch {
    // 快照拿不到就用默认
  }
  return 'sensevoice-local'
}

function preparationOf(svc, id) {
  try {
    const list = svc?.snapshot?.()?.providers
    if (!Array.isArray(list)) return null
    const hit = list.find((p) => p && p.id === id)
    return hit?.preparation ?? null
  } catch {
    return null
  }
}

function failedReason(prep) {
  const steps = Array.isArray(prep?.steps) ? prep.steps : []
  const bad = steps.find((x) => x && x.status === 'failed')
  const msg = bad?.error?.message ?? bad?.message ?? prep?.error?.message
  return typeof msg === 'string' && msg ? msg : '准备失败'
}

/**
 * 等模型准备好。已经好就立刻返回；没开始就让宿主开始，然后轮询。
 * @returns {Promise<{ok:true}|{ok:false,why:string,error?:string}>}
 */
export async function ensureReady(svc, signal) {
  if (!svc) return { ok: false, why: 'no-service' }
  const id = providerIdOf(svc)
  let prep = preparationOf(svc, id)
  const phase = String(prep?.phase ?? 'ready')
  if (phase === 'ready' || phase === 'standby') return { ok: true }
  if (phase === 'failed') return { ok: false, why: 'failed', error: failedReason(prep) }
  try {
    svc.prepare?.(id)
  } catch (error) {
    return { ok: false, why: 'failed', error: String(error?.message ?? error) }
  }
  const started = Date.now()
  while (Date.now() - started < PREPARE_WAIT_MS) {
    if (signal?.aborted) return { ok: false, why: 'failed', error: '准备超时' }
    await new Promise((r) => setTimeout(r, 500))
    prep = preparationOf(svc, id)
    const now = String(prep?.phase ?? 'ready')
    if (now === 'ready' || now === 'standby') return { ok: true }
    if (now === 'failed') return { ok: false, why: 'failed', error: failedReason(prep) }
  }
  return { ok: false, why: 'failed', error: '准备超时' }
}

/** 降级文案：让她知道"有声音但没听清"，而不是当成没有这条。 */
export function unheardNote(seconds, why = 'no-service') {
  const n = Math.max(0, Math.round(Number(seconds) || 0))
  // 两档：真没装耳朵 vs 装了但这次没听成（下载/转码/空转写/调用失败）。
  // 把「服务坏了」说成「没装」会让人误以为装一下就好。
  const tail = String(why) === 'no-service' ? '这台机器没装耳朵' : '没听清'
  return n > 0 ? `[语音 ${n} 秒：${tail}]` : `[语音：${tail}]`
}

/** 听清了：把内容与时长一起写进她听到的话。 */
export function heardNote(text, seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0))
  const tail = n > 0 ? `（语音 ${n} 秒）` : ''
  return `[语音] ${text}${tail}`
}
