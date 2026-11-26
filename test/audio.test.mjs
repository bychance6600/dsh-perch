import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalWav } from '../lib/audio.js'

/** 造一个带额外块的 WAV（fmt + LIST + data），模拟 ffmpeg 的输出。 */
function wavWithList(payload = Buffer.from([1, 2, 3, 4])) {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0) // PCM
  fmt.writeUInt16LE(1, 2) // 单声道
  fmt.writeUInt32LE(16000, 4)
  fmt.writeUInt32LE(32000, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const list = Buffer.from('INFOISFT\x04\x00\x00\x00test', 'latin1')
  const chunks = [Buffer.from('fmt ', 'latin1'), len(16), fmt, Buffer.from('LIST', 'latin1'), len(list.length), list, Buffer.from('data', 'latin1'), len(payload.length), payload]
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WAVE', 8, 'latin1')
  return Buffer.concat([head, body])
}

function len(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

test('canonicalWav：丢掉 LIST 等额外块，只留 fmt + data', () => {
  const out = canonicalWav(wavWithList())
  assert.equal(out.length, 44 + 4)
  assert.equal(out.subarray(0, 4).toString(), 'RIFF')
  assert.equal(out.subarray(12, 16).toString(), 'fmt ')
  assert.equal(out.subarray(36, 40).toString(), 'data')
  assert.equal(out.readUInt32LE(4), 36 + 4)
  assert.equal(out.readUInt32LE(40), 4)
  // 没有 LIST 残留
  assert.equal(out.includes(Buffer.from('LIST')), false)
})

test('canonicalWav：本来就只有 fmt + data 的保持等价', () => {
  const plain = canonicalWav(wavWithList(Buffer.alloc(8)))
  const again = canonicalWav(plain)
  assert.deepEqual(again, plain)
})

test('canonicalWav：不是 RIFF/WAVE 就报错', () => {
  assert.throws(() => canonicalWav(Buffer.alloc(64)), /不是 RIFF\/WAVE|WAV 太短/)
})
