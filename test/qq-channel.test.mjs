/**
 * qq-channel.test.mjs —— lib/channels/qq.js 的契约测试。
 *
 * 全程不碰真网络：WebSocket 用假实现，定时器用假时钟（否则 15s 超时、30s 退避
 * 会把一条用例拖成半分钟）。断言的对象就是 channels/README.md 里那份规范化形状。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from '../lib/channels/qq.js'

const T0 = 1700000000000
const SELF = 10001

/** 假 WebSocket：记录发出去的报文，能手动 open / push / drop。 */
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
    this.closed = false
    this.readyState = 0 // 0 = CONNECTING
    FakeWS.all.push(this)
  }

  send(payload) {
    this.frames.push(JSON.parse(payload))
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

  /** 桥那边断线（不会走 close()，模拟网络掉线） */
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  push(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  lastFrame() {
    return this.frames[this.frames.length - 1]
  }

  find(action) {
    return this.frames.find((f) => f.action === action)
  }
}

/** 假时钟：把 setTimeout 的句柄做成可 unref 的对象，用例里手动快进。 */
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
    /** 触发所有到期定时器（快照遍历，回调里新排的不重复触发） */
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

function setup(extra = {}, configOverride = {}) {
  FakeWS.reset()
  const clock = fakeClock()
  const messages = []
  const logs = []
  const adapter = create({
    log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    config: { wsUrl: 'ws://127.0.0.1:3001', token: '', ...configOverride },
    WebSocketImpl: FakeWS,
    now: () => T0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  })
  adapter.onMessage((m) => messages.push(m))
  return { adapter, clock, messages, logs }
}

/** 让 await 链上的微任务跑完（call 的 resolve → afterOpen 的剩余部分） */
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

let mid = 100

function inbound(over = {}) {
  return { post_type: 'message', time: 1700000000, self_id: SELF, ...over }
}

function dm(over = {}) {
  return inbound({ message_type: 'private', message_id: ++mid, ...over })
}

function group(over = {}) {
  return inbound({ message_type: 'group', message_id: ++mid, group_id: 30003, ...over })
}

async function started(extra, configOverride) {
  const ctx = setup(extra, configOverride)
  const res = await ctx.adapter.start()
  assert.equal(res.ok, true)
  const ws = FakeWS.last
  ws.open()
  return { ...ctx, ws }
}

// ---- 连接 ----

test('create() 不碰网络；start() 之后先发 get_login_info', async () => {
  const ctx = setup()
  assert.equal(ctx.adapter.name, 'qq')
  assert.equal(FakeWS.all.length, 0, '模块加载 / create 阶段不许建连接')

  const res = await ctx.adapter.start()
  assert.equal(res.ok, true)
  assert.equal(FakeWS.all.length, 1)

  const ws = FakeWS.last
  ws.open()
  const hello = ws.find('get_login_info')
  assert.ok(hello, '连上后要问一次登录信息，确认桥那边是谁在线')
  assert.deepEqual(hello.params, {})

  ws.push({ status: 'ok', retcode: 0, data: { user_id: SELF, nickname: '小满' }, echo: hello.echo })
  await flush()

  const st = ctx.adapter.status()
  assert.equal(st.ok, true)
  assert.equal(st.connected, true)
  assert.equal(st.since, T0)
  assert.equal(st.lastError, '')
  ctx.adapter.stop()
})

test('每 30 秒发一次心跳 get_status；stop 之后定时器清空', async () => {
  const { adapter, clock, ws } = await started()
  assert.equal(ws.find('get_status'), undefined)
  clock.tick(30_000)
  assert.ok(ws.find('get_status'), '空闲 30s 要问一次桥还在不在')
  adapter.stop()
  assert.equal(clock.size(), 0)
})

// ---- 进站 ----

test('私聊消息规范化：personId 前缀 / personName / text', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(
    dm({
      message_id: 501,
      user_id: 20002,
      sender: { nickname: '阿明' },
      message: [{ type: 'text', data: { text: '  你好呀  ' } }],
      raw_message: '  你好呀  ',
    }),
  )

  assert.equal(messages.length, 1)
  const m = messages[0]
  assert.equal(m.channelId, 'qq')
  assert.equal(m.kind, 'dm')
  assert.equal(m.conversationId, '20002')
  assert.equal(m.conversationName, '阿明')
  assert.equal(m.personId, 'u_20002')
  assert.equal(m.personName, '阿明')
  assert.equal(m.text, '你好呀')
  assert.deepEqual(m.images, [])
  assert.equal(m.at, 1700000000 * 1000)
  assert.equal(m.raw.message_id, 501)
  adapter.stop()
})

test('群名用群的，不用发言人的名片；桥没给群名时退回上次见过的（2026-11-07 真机）', async () => {
  const { adapter, messages, ws } = await started()

  ws.push(group({
    message_id: 611,
    group_name: '测试群',
    user_id: 20002,
    sender: { card: '阿岚', nickname: '阿岸' },
    message: [{ type: 'text', data: { text: '一' } }],
  }))
  // 桥偶尔不带 group_name：这时不能把「回~忆」当成群名
  ws.push(group({
    message_id: 612,
    user_id: 20003,
    sender: { card: '回~忆', nickname: '回忆' },
    message: [{ type: 'text', data: { text: '二' } }],
  }))

  assert.equal(messages.length, 2)
  assert.equal(messages[0].conversationName, '测试群')
  assert.equal(messages[0].personName, '阿岚')
  assert.equal(messages[1].conversationName, '测试群', '没带群名时退回这个群上次的名字')
  assert.equal(messages[1].personName, '回~忆')
  adapter.stop()
})

test('群里 @ 她会被洗掉；只有图片时 text 为空但消息仍然上报', async () => {
  const { adapter, messages, ws } = await started()

  ws.push(
    group({
      message_id: 601,
      user_id: 20002,
      group_name: '测试群',
      sender: { card: '群里的阿明', nickname: '阿明' },
      message: [
        { type: 'at', data: { qq: String(SELF), name: '小满' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }),
  )
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, '在吗')
  assert.equal(messages[0].kind, 'group')
  assert.equal(messages[0].conversationId, '30003')
  assert.equal(messages[0].conversationName, '测试群')
  assert.equal(messages[0].personName, '群里的阿明')

  ws.push(
    group({
      message_id: 602,
      user_id: 20003,
      message: [{ type: 'image', data: { url: 'https://example.com/a.png' } }],
    }),
  )
  const pic = messages[1]
  assert.equal(pic.text, '', '只发图时 text 是空串，不许编一句话出来')
  assert.deepEqual(pic.images, ['https://example.com/a.png'])
  adapter.stop()
})

test('post_format=string（CQ 码）也认：@ 她去掉，图片能捞出来', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(
    group({
      message_id: 603,
      user_id: 20002,
      sender: { nickname: '阿明' },
      message: '[CQ:at,qq=10001] 你看 [CQ:image,url=https://example.com/b.png]',
    }),
  )
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, '你看')
  assert.deepEqual(messages[0].images, ['https://example.com/b.png'])
  adapter.stop()
})

test('@ 她被记成 mentionedSelf，且不进正文（群聊只认被点名的）', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(group({ message_id: 605, user_id: 20002, message: [{ type: 'text', data: { text: '在吗' } }] }))
  ws.push(group({ message_id: 606, user_id: 20002, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }] }))
  assert.equal(messages.length, 2)
  assert.equal(messages[0].mentionedSelf, false, '没点名的消息不许说被点了名')
  assert.equal(messages[1].mentionedSelf, true)
  assert.equal(messages[1].text, '在吗', '@ 她的段不进正文')
  adapter.stop()
})

test('CQ 码里的 @ 她同样记成 mentionedSelf', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(group({ message_id: 607, user_id: 20002, message: '[CQ:at,qq=10001] 在吗' }))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].mentionedSelf, true)
  assert.equal(messages[0].text, '在吗')
  adapter.stop()
})

test('图片最多收 4 张', async () => {
  const { adapter, messages, ws } = await started()
  const segs = Array.from({ length: 6 }, (_, i) => ({ type: 'image', data: { url: `https://example.com/${i}.png` } }))
  ws.push(group({ message_id: 604, user_id: 20002, message: segs }))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].images.length, 4)
  adapter.stop()
})

test('附件只记一条元数据：类型和字节数，正文留空', async () => {
  const { adapter, messages, ws } = await started()
  ws.push(
    group({
      message_id: 608,
      user_id: 20002,
      message: [{ type: 'image', data: { file: 'a.jpg', file_size: 2048 } }],
    }),
  )
  const m = messages[0]
  assert.equal(m.text, '')
  assert.deepEqual(m.attachment, { type: 'image', size: 2048 })
  adapter.stop()
})

test('群友「回复」她发过的那条，才算 replyToSelf；回复别人不算', async () => {
  const { adapter, messages, ws } = await started()

  const p = adapter.send({ conversation: { kind: 'group', id: '30003' }, text: '我先说一句。' })
  const f = ws.lastFrame()
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 700 }, echo: f.echo })
  await p

  ws.push(group({
    message_id: 609,
    user_id: 20002,
    message: [{ type: 'reply', data: { id: '700' } }, { type: 'text', data: { text: '这句是回你的' } }],
  }))
  assert.equal(messages[0].replyToSelf, true)
  assert.equal(messages[0].text, '这句是回你的')

  ws.push(group({
    message_id: 610,
    user_id: 20002,
    message: [{ type: 'reply', data: { id: '999999' } }, { type: 'text', data: { text: '这句是回别人的' } }],
  }))
  assert.equal(messages[1].replyToSelf, false)
  adapter.stop()
})

test('notice / 撤回 / 系统消息一律不递进来', async () => {
  const { adapter, messages, ws } = await started()
  ws.push({ post_type: 'notice', notice_type: 'group_recall', group_id: 30003, user_id: 20002, message_id: 1 })
  ws.push({ post_type: 'notice', notice_type: 'group_increase', group_id: 30003, user_id: 20003 })
  assert.equal(messages.length, 0)
  adapter.stop()
})

// ---- 出站 ----

test('send()：私聊发 send_private_msg，群聊发 send_group_msg，按 echo 对上响应', async () => {
  const { adapter, ws } = await started()

  const p1 = adapter.send({ conversation: { kind: 'dm', id: '20002', name: '阿明' }, text: '在的' })
  const f1 = ws.lastFrame()
  assert.equal(f1.action, 'send_private_msg')
  assert.equal(f1.params.user_id, 20002)
  assert.equal(f1.params.message[0].data.text, '在的')
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 777 }, echo: f1.echo })
  assert.deepEqual(await p1, { ok: true, id: '777' })

  const p2 = adapter.send({ conversation: { kind: 'group', id: '30003', name: '群' }, text: '大家好' })
  const f2 = ws.lastFrame()
  assert.equal(f2.action, 'send_group_msg')
  assert.equal(f2.params.group_id, 30003)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 778 }, echo: f2.echo })
  assert.deepEqual(await p2, { ok: true, id: '778' })

  // 桥回失败（被禁言之类）：resolve 成 {ok:false}，不是 reject
  const p3 = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '再说一句' })
  const f3 = ws.lastFrame()
  ws.push({ status: 'failed', retcode: 1200, wording: '不允许发送', echo: f3.echo })
  const r3 = await p3
  assert.equal(r3.ok, false)
  assert.equal(r3.why, '不允许发送')
  assert.equal(r3.retcode, 1200)

  assert.equal(adapter.status().sent, 2)
  adapter.stop()
})

test('按句切气泡：1600 字的一句话仍然只发一条', async () => {
  const { adapter, ws } = await started()
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: 'a'.repeat(1600) })

  const f1 = ws.lastFrame()
  assert.equal(f1.action, 'send_private_msg')
  assert.equal(f1.params.message[0].data.text.length, 1600)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 801 }, echo: f1.echo })

  assert.deepEqual(await p, { ok: true, id: '801' })
  adapter.stop()
})

test('单句超过 4000 字才硬切；分句不劈标点', async () => {
  const { adapter, ws } = await started()
  const long = 'x'.repeat(4500)
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: long })

  const f1 = ws.lastFrame()
  assert.equal(f1.params.message[0].data.text.length, 4000)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 801 }, echo: f1.echo })
  await flush()

  const f2 = ws.lastFrame()
  assert.equal(f2.params.message[0].data.text.length, 500)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 802 }, echo: f2.echo })
  assert.deepEqual(await p, { ok: true, id: '802' })
  adapter.stop()

  // 切分只发生在发送前；分句工具本身也按标点切。
  const { adapter: a2 } = setup()
  assert.deepEqual(a2.splitBubbles('嗯。好呀！'), ['嗯。', '好呀！'])
  a2.stop()
})

test('四条以上气泡之间停 900ms（否则像刷屏）', async () => {
  const { adapter, clock, ws } = await started()
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '一。二。三。四。' })

  const f1 = ws.lastFrame()
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 901 }, echo: f1.echo })
  await flush()
  assert.equal(ws.frames.filter((f) => f.action === 'send_private_msg').length, 1, '第二条要等')

  clock.tick(900)
  await flush()
  const f2 = ws.lastFrame()
  assert.notEqual(f2.echo, f1.echo)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 902 }, echo: f2.echo })
  await flush()

  clock.tick(900)
  await flush()
  const f3 = ws.lastFrame()
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 903 }, echo: f3.echo })
  await flush()

  clock.tick(900)
  await flush()
  const f4 = ws.lastFrame()
  ws.push({ status: 'ok', retcode: 0, data: { message_id: 904 }, echo: f4.echo })

  assert.deepEqual(await p, { ok: true, id: '904' })
  adapter.stop()
})

test('没连上时 send() 返回 {ok:false}，不抛异常', async () => {
  const { adapter } = setup()
  const res = await adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '嗨' })
  assert.equal(res.ok, false)
  assert.equal(res.why, 'offline')
  assert.equal(adapter.status().connected, false)
})

test('send() 15 秒没回音返回 {ok:false, why:"timeout"}', async () => {
  const { adapter, clock, ws } = await started()
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '在吗' })
  assert.ok(ws.find('send_private_msg'), '报文已经出去了')

  clock.tick(15_000)
  const res = await p
  assert.equal(res.ok, false)
  assert.equal(res.why, 'timeout')
  adapter.stop()
})

// ---- 重连 ----

test('断线后按阶梯自动重连；stop() 之后不再重连', async () => {
  const { adapter, clock, ws } = await started()
  assert.equal(adapter.status().connected, true)

  ws.drop(1006)
  assert.equal(FakeWS.all.length, 1, '断线当下不该立刻新建连接，要等退避')
  assert.equal(adapter.status().connected, false)
  assert.equal(adapter.status().ok, false)

  clock.tick(2000) // 第一档（设计文档：2/5/10/30/60s）
  assert.equal(FakeWS.all.length, 2)
  assert.equal(FakeWS.all[1].url, ws.url, '新连接用同一个地址（含 token）')

  FakeWS.last.open()
  assert.equal(adapter.status().connected, true)

  adapter.stop()
  clock.tick(30_000)
  assert.equal(FakeWS.all.length, 2, 'stop() 之后连定时器都不该再留')
  assert.equal(clock.size(), 0)
})

test('重复的 message_id 只上报一次；自己发的消息不算别人说的', async () => {
  const { adapter, messages, ws } = await started()

  const ev = dm({ message_id: 701, user_id: 20002, message: [{ type: 'text', data: { text: '只该看见一次' } }] })
  ws.push(ev)
  ws.push(ev) // 重连补齐时的重复
  assert.equal(messages.length, 1)

  ws.push(dm({ message_id: 702, user_id: SELF, message: [{ type: 'text', data: { text: '我自己' } }] }))
  assert.equal(messages.length, 1)
  assert.equal(adapter.status().received, 1)
  adapter.stop()
})

// ---- 断线账（2026-11-06，设计 §三）----

test('断线账：记最后一次收到/发出，以及重连后断了多久', async () => {
  let nowMs = T0
  const ctx = setup({ now: () => nowMs })
  const res = await ctx.adapter.start()
  assert.equal(res.ok, true)
  const ws = FakeWS.last
  ws.open()

  nowMs = T0 + 5_000
  ws.push(dm({ user_id: 20002, message: [{ type: 'text', data: { text: '在吗' } }] }))
  assert.equal(ctx.adapter.status().lastInAt, nowMs)

  nowMs = T0 + 6_000
  const p = ctx.adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '在' })
  ws.push({ status: 'ok', retcode: 0, data: { message_id: '88' }, echo: ws.lastFrame().echo })
  await flush()
  const sr = await p
  assert.equal(sr.ok, true)
  assert.equal(ctx.adapter.status().lastOutAt, nowMs)

  nowMs = T0 + 40_000
  ws.drop(1006)
  assert.equal(ctx.adapter.status().downSince, nowMs, '断着的时候要能看见从什么时候开始断')
  assert.equal(ctx.adapter.status().lastGapAt, 0, '还没重连，就没有「断了多久」')

  nowMs = T0 + 44_000
  ctx.clock.tick(2000)
  FakeWS.last.open()
  const st = ctx.adapter.status()
  assert.equal(st.downSince, 0)
  assert.equal(st.lastGapAt, nowMs)
  assert.equal(st.lastGapMs, 4_000)
  ctx.adapter.stop()
})

test('stop() 自己关掉的不算断线：不留 downSince、也不留 lastGapAt', async () => {
  const { adapter } = await started()
  adapter.stop()
  const st = adapter.status()
  assert.equal(st.downSince, 0)
  assert.equal(st.lastGapAt, 0)
})

// ---- 凭据 ----

test('token 拼进 wsUrl，但不许出现在 status() 和日志里', async () => {
  const TOKEN = 'tok-9f3c2b7a-secret-value'
  const { adapter, logs } = await started({}, { token: TOKEN })

  const url = FakeWS.last.url
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('access_token'), TOKEN)

  const st = JSON.stringify(adapter.status())
  assert.equal(st.includes(TOKEN), false)
  assert.equal(Object.keys(adapter.status()).some((k) => /token/i.test(k)), false, 'status 里连键名都不该有')
  assert.equal(logs.join('\n').includes(TOKEN), false)
  adapter.stop()
})

// ---- 入站 WAL / 出站 outbox（2026-11-06）----

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'qq-ledger-'))
}

function ledger(root, name) {
  try {
    return readFileSync(join(root, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('入站先落盘再递：listener 里已经能在 qq-wal.jsonl 看到这条', async () => {
  const root = tmpRoot()
  const { adapter, ws } = await started({ root })
  let sawOnDisk = false
  adapter.onMessage(() => {
    sawOnDisk = ledger(root, 'qq-wal.jsonl').some((r) => r.t === 'in' && r.id === '881')
  })
  ws.push(dm({ message_id: 881, user_id: 20002, message: [{ type: 'text', data: { text: '先记账' } }] }))

  assert.equal(sawOnDisk, true)
  const lines = ledger(root, 'qq-wal.jsonl')
  assert.ok(lines.some((r) => r.t === 'in' && r.id === '881'))
  assert.ok(lines.some((r) => r.t === 'done' && r.id === '881'))
  adapter.stop()
  rmSync(root, { recursive: true, force: true })
})

test('重启后把没 done 的入站消息补递一次，之后不再重复', async () => {
  const root = tmpRoot()
  const item = {
    channelId: 'qq', kind: 'dm', conversationId: '20002', personId: 'u_20002',
    personName: '阿九', text: '上次没来得及递', at: T0, raw: { message_id: 991 },
  }
  writeFileSync(join(root, 'qq-wal.jsonl'), `${JSON.stringify({ t: 'in', id: '991', item, at: T0 })}\n`)

  const ctx = setup({ root })
  await ctx.adapter.start()
  assert.equal(ctx.messages.length, 1)
  assert.equal(ctx.messages[0].raw.message_id, 991)
  // 重放完会 compactWal(true)，done 行当场合掉；要断言的是"账本里没有待补的 in 行"。
  assert.equal(
    ledger(root, 'qq-wal.jsonl').some((r) => r.t === 'in' && r.id === '991'),
    false,
    '补递过的不该再留在待补队列里',
  )

  // 再起一次（同一本账）：已经 done，不该再递
  ctx.adapter.stop()
  await ctx.adapter.start()
  assert.equal(ctx.messages.length, 1)
  ctx.adapter.stop()
  rmSync(root, { recursive: true, force: true })
})

test('出站 outbox：崩溃前没等到回执的，重连后补发一次', async () => {
  const root = tmpRoot()
  const params = { group_id: 30003, message: [{ type: 'text', data: { text: '补一句' } }] }
  writeFileSync(join(root, 'qq-outbox.jsonl'), `${JSON.stringify({ t: 'out', id: 'out-1', action: 'send_group_msg', params, at: T0 })}\n`)

  const ctx = setup({ root })
  await ctx.adapter.start()
  const ws = FakeWS.last
  ws.open()
  ws.push({ status: 'ok', retcode: 0, data: { user_id: SELF, nickname: '鱼' }, echo: ws.lastFrame().echo })
  await flush()
  await flush()

  const sent = ws.frames.filter((f) => f.action === 'send_group_msg')
  assert.equal(sent.length, 1, '补发只发一次')
  assert.deepEqual(sent[0].params, params)
  ws.push({ status: 'ok', retcode: 0, data: { message_id: '77' }, echo: sent[0].echo })
  await flush()
  // 补发完会 compactOutbox(true)，done 行当场合掉；断言"没有待补的 out 行"。
  assert.equal(
    ledger(root, 'qq-outbox.jsonl').some((r) => r.t === 'out' && r.id === 'out-1'),
    false,
    '补发过的不该再留在待发队列里',
  )

  // 重连不再补：out-1 已经 done
  ctx.adapter.stop()
  await ctx.adapter.start()
  const ws2 = FakeWS.last
  ws2.open()
  ws2.push({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: ws2.lastFrame().echo })
  await flush()
  await flush()
  assert.equal(ws2.frames.filter((f) => f.action === 'send_group_msg').length, 0)
  ctx.adapter.stop()
  rmSync(root, { recursive: true, force: true })
})

test('出站超时不补发：只记 drop，重连后也不再发', async () => {
  const root = tmpRoot()
  const { adapter, clock, ws } = await started({ root })
  const p = adapter.send({ conversation: { kind: 'dm', id: '20002' }, text: '在吗' })
  assert.ok(ws.find('send_private_msg'))
  clock.tick(15_000)
  const res = await p
  assert.equal(res.why, 'timeout')
  assert.ok(ledger(root, 'qq-outbox.jsonl').some((r) => r.t === 'drop' && r.id))

  adapter.stop()
  await adapter.start()
  const ws2 = FakeWS.last
  ws2.open()
  await flush()
  assert.equal(ws2.frames.filter((f) => f.action === 'send_private_msg').length, 0)
  adapter.stop()
  rmSync(root, { recursive: true, force: true })
})

test('入站账本有上限：启动时把已经 done 的行清掉', async () => {
  const root = tmpRoot()
  const lines = []
  for (let i = 0; i < 420; i += 1) {
    lines.push(JSON.stringify({ t: 'in', id: `m${i}`, item: { channelId: 'qq', raw: { message_id: `m${i}` } }, at: T0 }))
    lines.push(JSON.stringify({ t: 'done', id: `m${i}` }))
  }
  writeFileSync(join(root, 'qq-wal.jsonl'), `${lines.join('\n')}\n`)
  const ctx = setup({ root })
  await ctx.adapter.start()
  assert.ok(ledger(root, 'qq-wal.jsonl').length < 10)
  ctx.adapter.stop()
  rmSync(root, { recursive: true, force: true })
})
