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

/** 降级文案：让她知道"有声音但没听清"，而不是当成没有这条。 */
export function unheardNote(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0))
  return n > 0 ? `[语音 ${n} 秒：这台机器没装耳朵]` : '[语音：这台机器没装耳朵]'
}

/** 听清了：把内容与时长一起写进她听到的话。 */
export function heardNote(text, seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0))
  const tail = n > 0 ? `（语音 ${n} 秒）` : ''
  return `[语音] ${text}${tail}`
}
