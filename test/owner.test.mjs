/**
 * owner.test.mjs —— 2026-10-23 加的第三批：隐私红线 / 艾特主人 / cookie 设置
 *
 * 守四件事：
 *   1. **红线是代码级的**：路径、状态库文件名、凭据、账号数字、手机号、邮箱
 *      一律不进公开评论。不是"提示词里嘱咐过"。
 *   2. **cookie 只上行不下行**：接口和界面都拿不到原文，只拿得到"有没有"。
 *   3. **只存 B 站要的几个键**：别把整段浏览器 cookies 搬进来。
 *   4. **@ 只在有昵称时才加**：空的 @ 只是一串没人认领的字符。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { looksLikeLeak, screenOutgoing } from '../lib/guard.js'
import {
  parseCookieInput, publicOwner, saveOwner, saveAccount,
  OWNER_CHANNELS, splitOwnerIds, channelOwnerIds, loadChannelOwnerIds, saveChannelOwner,
} from '../lib/owner.js'
import { readOwner } from '../lib/store.js'
import { registerObserve } from '../lib/observe.js'

test('隐私红线：本机路径与状态库文件名一律拦下', () => {
  for (const s of [
    '我把东西放在 D:\\work\\my-project 里',
    'C:/Users/someone/.dsh-perch/home',
    '你看 ~/.dsh-perch/events.jsonl',
    '我住在 /Users/someone/Desktop',
    '我的 AGENTS.md 里写了',
    'config.json 里有',
    '\\\\nas\\share\\x',
  ]) {
    assert.equal(looksLikeLeak(s).hit, true, `应拦下：${s}`)
  }
})

test('隐私红线：凭据、账号数字、手机、邮箱一律拦下', () => {
  for (const s of [
    'SESSDATA=abc123',
    'cookie 是 xxx',
    'uid: 12345678',
    '我的手机 13812345678',
    '给我发邮件 a.b@c.com',
    '我们私聊说',
    '我跟你说的那些',
  ]) {
    assert.equal(looksLikeLeak(s).hit, true, `应拦下：${s}`)
  }
})

test('隐私红线不误杀正常说话', () => {
  for (const s of [
    '这个视频里的二舅让我想了很久。',
    '他们都说这条路走不通，可我觉得不一定是。',
    '今天看了四个视频，三个都在讲以前的事。',
    '我不太确定。等我哪天被讲出来的时候，会不会也是别人的版本。',
    '2026 年了我还是没想明白。',
  ]) {
    assert.equal(looksLikeLeak(s).hit, false, `不该拦：${s}`)
  }
})

test('screenOutgoing 把隐私命中单独标成 leak（与凭据区分）', () => {
  assert.equal(screenOutgoing('C:\\Users\\someone\\x.txt').why, 'leak')
  assert.equal(screenOutgoing('SESSDATA=abc').why, 'secret')
  assert.equal(screenOutgoing('今天风很大。').ok, true)
})

test('parseCookieInput 认得三种粘贴形态，且只留 B 站要的键', () => {
  const a = parseCookieInput('SESSDATA=s1; bili_jct=j1; _ga=GA1.2.3; buvid3=b1')
  assert.equal(a.cookie, 'SESSDATA=s1; bili_jct=j1; buvid3=b1')
  assert.equal(a.cookie.includes('_ga'), false)
  assert.deepEqual(a.missing, [])

  const b = parseCookieInput('Cookie: SESSDATA=s2; bili_jct=j2; theme=dark')
  assert.equal(b.cookie, 'SESSDATA=s2; bili_jct=j2')

  const c = parseCookieInput(
    ['# Netscape HTTP Cookie File', '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ts3', '.bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tj3'].join('\n'),
  )
  assert.equal(c.cookie, 'SESSDATA=s3; bili_jct=j3')
})

test('缺了 bili_jct 要说出来——少了它就看不了也发不了', () => {
  const r = parseCookieInput('SESSDATA=only')
  assert.deepEqual(r.missing, ['bili_jct'])
})


test('publicOwner 永远不含 cookie 原文，只说有没有', () => {
  const p = publicOwner({ mid: '42', nickname: '我', cookie: 'SESSDATA=s1; bili_jct=j1' })
  assert.equal(p.mid, '42')
  assert.equal(p.name, '我')
  assert.equal(p.hasCookie, true)
  assert.equal(p.hasCsrf, true)
  assert.equal(JSON.stringify(p).includes('SESSDATA'), false)
})

test('saveOwner 落盘 0600，且只存白名单里的键', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-'))
  try {
    const r = await saveOwner({ mid: '42', nickname: '我', cookie: 'SESSDATA=s1; bili_jct=j1; _ga=x' }, root)
    assert.equal(r.ok, true)
    const ow = await readOwner(root)
    assert.equal(ow.cookie, 'SESSDATA=s1; bili_jct=j1')
    const st = await stat(join(root, 'owner.json'))
    // Windows 上 chmod 只影响只读位，允许 0o600 或 0o666 两种结果，但绝不能是 0o644 之外的"谁都能读"语义
    assert.ok((st.mode & 0o777) === 0o600 || (st.mode & 0o777) === 0o666, `mode=${(st.mode & 0o777).toString(8)}`)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('saveOwner 认不出 cookie 时也把 mid / 昵称存下（用户 m00802 反馈 2）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow3-'))
  try {
    const r = await saveOwner({ mid: '42', nickname: '大号', cookie: '{"cookies":[1,2]}' }, root)
    assert.equal(r.ok, false)
    assert.match(r.note, /没认出/)
    const ow = await readOwner(root)
    // 关键：不能因为 cookie 解析失败就把整单丢回旧值，否则界面刷新后两格"被顶掉"。
    assert.equal(ow.mid, '42')
    assert.equal(ow.nickname, '大号')
    assert.equal(ow.cookie, undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('只粘 cookie 保存时，不清空已填的 uid 与昵称（A10，0.9.1）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow6-'))
  try {
    await saveOwner({ mid: '42', nickname: '大肥鱼' }, root)
    const r = await saveOwner({ cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    assert.equal(r.ok, true, r.note)
    const ow = await readOwner(root)
    assert.equal(ow.mid, '42', '只粘 cookie 时 uid 要留着')
    assert.equal(ow.nickname, '大肥鱼', '只粘 cookie 时昵称要留着')
    assert.equal(ow.cookie, 'SESSDATA=s1; bili_jct=j1')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('saveOwner 传空 cookie 是「清除」，不是「没传」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow2-'))
  try {
    await saveOwner({ cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    const r = await saveOwner({ cookie: '' }, root)
    assert.equal(r.ok, true)
    const ow = await readOwner(root)
    assert.equal(ow.cookie, undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** 极简假 ctx：只提供 observe 需要的服务 */
function fakeCtx() {
  const routes = []
  const cfg = { connection: null }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
  }
}

function callRoute(routes, path, method, body) {
  const full = '/dsh-perch' + path
  const def = routes.find((d) => d.path === full)
    ?? routes.filter((d) => full.startsWith(d.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]
  if (!def) throw new Error(`没注册这条路由：${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  // readBody 走 EventEmitter（req.on('data'/'end')），所以用 Readable 当请求体
  const req = Readable.from(chunks)
  req.method = method
  req.url = '/dsh-perch' + path
  req.headers = { 'content-type': 'application/json' }
  let out = null
  const res = {
    statusCode: 0,
    ended: false,
    setHeader() {},
    writeHead(n) { this.statusCode = n },
    end(t) { this.ended = true; try { out = JSON.parse(String(t)) } catch { out = String(t) } },
  }
  return def.handler(req, res).then(() => ({ status: res.statusCode, body: out }))
}

test('/owner 路由：GET 只回「有没有 cookie」+ 引导文案，不回原文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow3-'))
  try {
    const ctx = fakeCtx()
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    await saveOwner({ mid: '42', nickname: '我', cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    const r = await callRoute(ctx.routes, '/owner', 'GET')
    assert.equal(r.status, 200)
    assert.equal(r.body.hasCookie, true)
    assert.equal(r.body.mid, '42')
    assert.ok(String(r.body.hint).includes('F12'), '要给出怎么拿 cookie')
    assert.equal(JSON.stringify(r.body).includes('s1'), false, 'cookie 原文不许出现在响应里')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('/owner 路由：POST 能存 uid 与昵称', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow4-'))
  try {
    const ctx = fakeCtx()
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const r = await callRoute(ctx.routes, '/owner', 'POST', { mid: '777', nickname: '主人' })
    assert.equal(r.status, 200)
    const ow = await readOwner(root)
    assert.equal(ow.mid, '777')
    assert.equal(ow.nickname, '主人')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- 2026-10-27：领养人与 cookie 账号拆开（owner.mid 是大号，account 是登录的小号） ----

test('publicOwner 带只读登录账号，且仍不含 cookie', () => {
  const p = publicOwner({ mid: '42', nickname: '大号', account: { mid: '9', name: '小号' }, cookie: 'SESSDATA=s1; bili_jct=j1' })
  assert.equal(p.mid, '42')
  assert.deepEqual(p.account, { mid: '9', name: '小号' })
  assert.equal(JSON.stringify(p).includes('SESSDATA'), false)
})

test('publicOwner 没有 account 时给空账号，不报错', () => {
  assert.deepEqual(publicOwner({ mid: '42' }).account, { mid: '', name: '' })
})

test('saveAccount 只记登录账号，不覆盖领养人', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow5-'))
  try {
    await saveOwner({ mid: '42', nickname: '大号', cookie: 'SESSDATA=s1; bili_jct=j1' }, root)
    const p = await saveAccount({ mid: 777, uname: '小号' }, root)
    assert.deepEqual(p.account, { mid: '777', name: '小号' })
    const ow = await readOwner(root)
    assert.equal(ow.mid, '42', '领养人 uid 不许被登录账号冲掉')
    assert.equal(ow.nickname, '大号', '领养人昵称不许被登录账号冲掉')
    assert.equal(ow.account.mid, '777')
    assert.equal(ow.account.name, '小号')
    assert.ok(ow.account.savedAt)
    // 反向：改领养人也不动登录账号
    await saveOwner({ nickname: '改个名' }, root)
    assert.equal((await readOwner(root)).account.mid, '777')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})


// ---- 2026-11-07（A29）：主人 id 按渠道记在 owner.json，不混进 config ----

test('splitOwnerIds：逗号、顿号、分号、空白都算分隔，去重且保序', () => {
  assert.deepEqual(splitOwnerIds('10001, 10002、10003;10002 10004'), ['10001', '10002', '10003', '10004'])
  assert.deepEqual(splitOwnerIds([' 1 ', '2', '1']), ['1', '2'])
  assert.deepEqual(splitOwnerIds(''), [])
  assert.deepEqual(splitOwnerIds(null), [])
})

test('saveChannelOwner：QQ / B 站 / 抖音各存各的，互不覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-ch-'))
  try {
    assert.deepEqual(OWNER_CHANNELS, ['qq', 'bili', 'douyin'])
    const a = await saveChannelOwner('qq', '10001, 10002', root)
    assert.equal(a.ok, true)
    assert.deepEqual(a.channels.qq, ['10001', '10002'])
    await saveChannelOwner('bili', '20002', root)
    await saveChannelOwner('douyin', '30003', root)

    const ow = await readOwner(root)
    assert.deepEqual(ow.channels, { qq: ['10001', '10002'], bili: ['20002'], douyin: ['30003'] })
    // 数字不串门：QQ 号不会被当成 B 站 uid
    assert.deepEqual(channelOwnerIds(ow).bili, ['20002'])
    assert.equal(JSON.stringify(publicOwner(ow)).includes('SESSDATA'), false)
    assert.deepEqual(publicOwner(ow).channels.qq, ['10001', '10002'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('saveChannelOwner：空串是「清掉」，留下空数组，老配置不能把它复活', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-clear-'))
  try {
    await saveChannelOwner('qq', '10001', root)
    const r = await saveChannelOwner('qq', '', root)
    assert.equal(r.ok, true)
    assert.match(r.note, /清掉/)
    const ow = await readOwner(root)
    assert.deepEqual(ow.channels.qq, [])
    // 老 config 里还有 ownerId，但 owner.json 已经有这个渠道的键——以空为准。
    assert.deepEqual(channelOwnerIds(ow, { qq: { ownerId: '99999' } }).qq, [])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('channelOwnerIds：没有这个渠道的键时才回落老配置的 ownerId', () => {
  const legacy = { qq: { ownerId: '10001' }, douyin: { ownerId: '30003' } }
  const fresh = channelOwnerIds({}, legacy)
  assert.deepEqual(fresh.qq, ['10001'])
  assert.deepEqual(fresh.douyin, ['30003'])
  assert.deepEqual(fresh.bili, [])
  // 只迁移了一半：qq 已写进 owner.json，douyin 还没。
  const half = channelOwnerIds({ channels: { qq: ['20002'] } }, legacy)
  assert.deepEqual(half.qq, ['20002'])
  assert.deepEqual(half.douyin, ['30003'])
})

test('loadChannelOwnerIds：读的是 owner.json，不是 config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-load-'))
  try {
    await saveChannelOwner('bili', '20002', root)
    const ids = await loadChannelOwnerIds(root, { bili: { ownerId: '99999' } })
    assert.deepEqual(ids.bili, ['20002'])
    // 没写过的渠道才回落
    assert.deepEqual(ids.qq, [])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('saveChannelOwner：不认识的渠道不落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-bad-'))
  try {
    const r = await saveChannelOwner('telegram', '123', root)
    assert.equal(r.ok, false)
    const ow = await readOwner(root).catch(() => null)
    assert.equal(ow?.channels?.telegram, undefined)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('/channels/owner 路由：按渠道存主人 id，GET /channels 能读到', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ow-route-'))
  try {
    const ctx = fakeCtx()
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const r = await callRoute(ctx.routes, '/channels/owner', 'POST', { channel: 'qq', id: '10001, 10002' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(r.body.channels.qq, ['10001', '10002'])
    const ow = await readOwner(root)
    assert.deepEqual(ow.channels.qq, ['10001', '10002'])

    const g = await callRoute(ctx.routes, '/channels', 'GET')
    assert.equal(g.status, 200)
    assert.deepEqual(g.body.owners.qq, ['10001', '10002'])

    const bad = await callRoute(ctx.routes, '/channels/owner', 'POST', { channel: 'nope', id: '1' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
