#!/usr/bin/env node
/**
 * fake-bridge.mjs —— 假桥：一个只会说话的 OneBot 11 服务端。
 *
 * 为什么需要它（2026-11-14）：真桥只有 Windows/Linux 版（NapCat、SnowLuma 都要 hook
 * NTQQ 进程），Mac 上装不了；但我们的插件只认 OneBot 11 的 WebSocket，它根本分不出
 * 对面是真 QQ 还是假的。所以「她收到一条语音」这件事，可以用假桥完整地演一遍。
 *
 * 它做的事：
 *  - 起一个 OneBot 11 正向 WebSocket（默认 ws://127.0.0.1:3001）；
 *  - 认 `?access_token=` 或 `Authorization: Bearer`，两个都支持（不同桥不一样）；
 *  - 应答 `get_login_info` / `get_status` / `get_version_info`；
 *  - 把插件发出来的 `send_private_msg` / `send_group_msg` / `send_msg` 打印出来
 *    （这样能看见「她说了什么」），并回一个假的 message_id；
 *  - `--text "…"` 发一条文字消息，`--voice <文件>` 发一条语音消息；
 *  - 语音通过同一个 HTTP 端口的 `/media/<文件名>` 提供下载，插件会自己来取。
 *
 * 它不做的事：不登录 QQ、不处理群、不回推历史、不实现 CQ 码。够用就行。
 *
 * 用法：
 *   node tools/fake-bridge.mjs --token abc --text "在吗"
 *   node tools/fake-bridge.mjs --token abc --voice ./sample.wav --duration 6
 *   node tools/fake-bridge.mjs --port 3001 --exit-after 15000
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function parseArgs(argv) {
  const out = {
    port: 3001,
    token: '',
    text: '',
    voice: '',
    duration: 0,
    user: 10000001,
    selfId: 10001,
    nick: '假桥',
    delay: 800,
    exitAfter: 0,
    quiet: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--port') out.port = Number(next())
    else if (a === '--token') out.token = String(next() ?? '')
    else if (a === '--text') out.text = String(next() ?? '')
    else if (a === '--voice') out.voice = String(next() ?? '')
    else if (a === '--duration') out.duration = Number(next())
    else if (a === '--user') out.user = Number(next())
    else if (a === '--self') out.selfId = Number(next())
    else if (a === '--nick') out.nick = String(next() ?? '')
    else if (a === '--delay') out.delay = Number(next())
    else if (a === '--exit-after') out.exitAfter = Number(next())
    else if (a === '--quiet') out.quiet = true
    else if (a === '--help' || a === '-h') out.help = true
    else {
      console.error(`不认识的参数：${a}`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv)
if (args.help) {
  console.log(`用法：node tools/fake-bridge.mjs [选项]

  --port <n>          监听端口，默认 3001
  --token <s>         需要的令牌（插件填同一个），默认不校验
  --text <s>          连上后发一条文字消息
  --voice <文件>      连上后发一条语音消息（文件经 /media 下载）
  --duration <n>      语音秒数，默认按文件时长估计
  --user <n>          发消息的人（默认 10000001）
  --self <n>          机器人自己的号（默认 10001）
  --nick <s>          发言人的昵称
  --delay <ms>        连上后多久发，默认 800
  --exit-after <ms>   这么久后自动退出（压测/自动化用）
  --quiet             不打印收发日志
`)
  process.exit(0)
}

const media = new Map() // 文件名 → 绝对路径

function log(...a) {
  if (!args.quiet) console.log('[假桥]', ...a)
}

/* ---------- WebSocket 帧 ---------- */

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let head
  if (len < 126) {
    head = Buffer.alloc(2)
    head[1] = len
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  head[0] = 0x80 | opcode
  return Buffer.concat([head, data])
}

/** 从缓冲区里尽量多地切出完整帧；返回 { frames, rest } */
function decodeFrames(buf) {
  const frames = []
  let off = 0
  while (off + 2 <= buf.length) {
    const b0 = buf[off]
    const b1 = buf[off + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    let mask = null
    if (masked) {
      if (p + 4 > buf.length) break
      mask = buf.subarray(p, p + 4)
      p += 4
    }
    if (p + len > buf.length) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    frames.push({ opcode, payload })
    off = p + len
  }
  return { frames, rest: buf.subarray(off) }
}

/* ---------- 消息体 ---------- */

function textMessage(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: Math.floor(Math.random() * 1e9),
    user_id: args.user,
    self_id: args.selfId,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: args.user, nickname: args.nick || '主人' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    font: 0,
  }
}

function voiceMessage(url, seconds) {
  const name = basename(new URL(url).pathname)
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: Math.floor(Math.random() * 1e9),
    user_id: args.user,
    self_id: args.selfId,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: args.user, nickname: args.nick || '主人' },
    message: [{ type: 'record', data: { file: name, url, duration: seconds } }],
    raw_message: `[CQ:record,file=${name},url=${url}]`,
    font: 0,
  }
}

function voiceSeconds() {
  if (args.duration > 0) return args.duration
  if (!args.voice) return 0
  // 常见 wav：44 字节头 + 16bit 单声道 16k
  try {
    const size = statSync(args.voice).size
    if (extname(args.voice).toLowerCase() === '.wav') {
      const dataBytes = Math.max(0, size - 44)
      return Math.max(1, Math.round(dataBytes / (16000 * 2)))
    }
    return 6
  } catch {
    return 6
  }
}

/* ---------- 服务 ---------- */

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname.startsWith('/media/')) {
    const name = decodeURIComponent(url.pathname.slice('/media/'.length))
    const file = media.get(name)
    if (!file || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size })
    createReadStream(file).pipe(res)
    return
  }
  res.writeHead(404).end('fake-bridge：这里只有 /media/ 和 WebSocket')
})

let socket = null
let buffer = Buffer.alloc(0)
let nextMessageId = 1

function send(obj) {
  if (!socket) return
  socket.write(encodeFrame(0x1, JSON.stringify(obj)))
}

function reply(echo, data, retcode = 0, status = 'ok') {
  send({ status, retcode, data, echo })
}

function handleAction(msg) {
  const { action, params = {}, echo } = msg
  if (action === 'get_login_info') {
    reply(echo, { user_id: args.selfId, nickname: '假桥' })
    return
  }
  if (action === 'get_status') {
    reply(echo, { online: true, good: true })
    return
  }
  if (action === 'get_version_info') {
    reply(echo, { app_name: 'fake-bridge', app_version: '0.0.1', protocol_version: 'v11' })
    return
  }
  if (action === 'send_private_msg' || action === 'send_group_msg' || action === 'send_msg') {
    const text = params.message ?? params.raw_message ?? ''
    const flat = Array.isArray(text)
      ? text.map((s) => (s.type === 'text' ? s.data?.text : `[${s.type}]`)).join('')
      : String(text)
    log(`她发出 → ${flat}`)
    reply(echo, { message_id: nextMessageId++ })
    return
  }
  log(`未实现的动作：${action}（已回 ok，避免插件卡住）`)
  reply(echo, {})
}

function scheduleSend() {
  const delay = Math.max(0, args.delay)
  const voice = args.voice ? resolve(args.voice) : ''
  if (voice && !existsSync(voice)) {
    console.error(`语音文件不存在：${voice}`)
    process.exit(2)
  }
  if (voice) {
    const name = `${randomUUID().slice(0, 8)}-${basename(voice)}`
    media.set(name, voice)
    log(`语音挂到 /media/${name}（${voiceSeconds()} 秒）`)
  }
  setTimeout(() => {
    if (args.text) {
      log(`发文字：${args.text}`)
      send(textMessage(args.text))
    }
    if (voice) {
      const name = [...media.keys()].pop()
      const url = `http://127.0.0.1:${args.port}/media/${encodeURIComponent(name)}`
      log(`发语音：${url}`)
      send(voiceMessage(url, voiceSeconds()))
    }
  }, delay)
}

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const headerToken = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const token = url.searchParams.get('access_token') ?? headerToken
  if (args.token && token !== args.token) {
    log('令牌不对，拒绝连接')
    sock.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    sock.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    sock.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
    sock.destroy()
    return
  }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(String(key))}\r\n` +
      '\r\n',
  )
  socket = sock
  buffer = Buffer.alloc(0)
  log('插件连上了')

  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const { frames, rest } = decodeFrames(buffer)
    buffer = rest
    for (const f of frames) {
      if (f.opcode === 0x8) {
        log('插件断开')
        sock.destroy()
        socket = null
        return
      }
      if (f.opcode === 0x9) {
        sock.write(encodeFrame(0xa, f.payload))
        continue
      }
      if (f.opcode !== 0x1) continue
      let msg
      try {
        msg = JSON.parse(f.payload.toString('utf8'))
      } catch {
        continue
      }
      handleAction(msg)
    }
  })

  sock.on('close', () => {
    log('连接关了')
    socket = null
  })
  sock.on('error', (e) => log('socket 出错', e?.message ?? e))

  scheduleSend()
})

server.listen(args.port, '127.0.0.1', () => {
  log(`在 ws://127.0.0.1:${args.port} 上听着（令牌：${args.token ? '要' : '不校验'}）`)
  if (args.exitAfter > 0) {
    setTimeout(() => {
      log('到点了，退出')
      process.exit(0)
    }, args.exitAfter)
  }
})
