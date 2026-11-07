/**
 * dsh-roost-douyin —— 抖音材料层（可选子包）
 *
 * 它不是渠道：没有 send、没有 onMessage、不收私信。主包只用它开一个独立浏览器，
 * 读推荐流、翻详情/评论、让 douyin_look 借这个登录态。
 *
 * 为什么单开一个包：主包承诺「零依赖、装完就能跑」。抖音做不到——
 * 它要一个**真的** Chromium、要一个能扫码登录的桌面窗口、要这台机器上
 * 装着 Edge 或 Chrome。把这种东西塞进主包，等于让「只想在 DSH 里陪她」
 * 的人也为它付安装代价。
 *
 * 已知的脆点（写在这里，免得下次有人以为它和 QQ 一样稳）：
 *   1. 抖音的 DOM 会变。推荐流结构集中在 FEED_SELECTORS，一处改、全局生效；
 *   2. 它是「浏览器自动化」，不是官方协议。账号有被风控的真实可能；
 *   3. 只在有图形会话的 Windows / macOS 上工作（Linux 服务器要自己接 Xvfb）。
 *
 * 纪律：
 *   · 永不抛（launch/navigate/evaluate/close 全部 catch，失败用 {ok:false,why} 说话）；
 *   · 凭据不进 status、不进日志（这个包根本不读 cookie，它靠用户在这个浏览器里登录）；
 *   · 模块加载不连网、不启动进程（只有 launch() 才拉浏览器）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULTS = {
  debugPort: 9333,
}

/** 小睡。单拆出来，测试可以注入自己的 sleeper；`browseFeed` 不传时就用它。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

/** 常见安装位置。找不到就让人在设置里填 browserPath。 */
export function browserCandidates(platform = process.platform) {
  if (platform === 'win32') {
    const base = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    return base
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

export async function findBrowser(explicit = '', platform = process.platform) {
  if (explicit) {
    try {
      await fs.access(explicit)
      return explicit
    } catch {
      return ''
    }
  }
  for (const p of browserCandidates(platform)) {
    try {
      await fs.access(p)
      return p
    } catch { /* 下一个 */ }
  }
  return ''
}

/** 按码点切段，避免把 emoji 劈成两半。 */
export const FEED_URL = 'https://www.douyin.com/'

/** 推荐页的卡片与字段。同样没有在真机校准过：第一次接通时改这里，别改逻辑。 */
export const FEED_SELECTORS = {
  item: '[data-e2e="feed-item"], li[data-e2e="scroll-item"], div[class*="video-card"]',
  title: '[data-e2e="video-desc"], [class*="desc"], [class*="title"]',
  author: '[data-e2e="video-author"], [class*="author"], [class*="nickname"]',
  like: '[data-e2e="video-like"], [class*="like"]',
}

/** 从当前页面里抠出推荐流：标题、作者、点赞、链接。返回 JSON 字符串。 */
export function feedScript(limit = 8) {
  return `(() => {
    const S = ${JSON.stringify(FEED_SELECTORS)}
    const lim = ${JSON.stringify(Math.max(1, Math.min(20, Number(limit) || 8)))}
    const q = (root, sel) => { try { return root.querySelector(sel) } catch { return null } }
    const nodes = Array.from(document.querySelectorAll(S.item)).slice(0, lim)
    const items = []
    for (const el of nodes) {
      const a = el.querySelector('a[href*="/video/"]') || (el.closest && el.closest('a[href*="/video/"]'))
      const href = a ? String(a.getAttribute('href') || '') : ''
      const m = href.match(/\\/video\\/(\\d+)/)
      if (!m) continue
      const title = (q(el, S.title)?.textContent || '').trim()
      const author = (q(el, S.author)?.textContent || '').trim()
      const like = (q(el, S.like)?.textContent || '').trim()
      items.push({ id: m[1], href: href.startsWith('http') ? href : 'https://www.douyin.com' + href, title: title.slice(0, 120), author: author.slice(0, 40), like })
    }
    return JSON.stringify({ items })
  })()`
}

/**
 * 拉一批推荐视频。永不抛：拿不到就是 `{ ok:false, why }`，让她照常醒。
 * @param {{transport:object, limit?:number, waitMs?:number, sleep?:Function}} o
 */
export async function browseFeed({ transport, limit = 6, waitMs = 1800, sleep: sleeper } = {}) {
  const nap = typeof sleeper === 'function' ? sleeper : sleep
  if (!transport || typeof transport.evaluate !== 'function') return { ok: false, why: 'no-transport', items: [] }
  try {
    if (typeof transport.navigate === 'function') await transport.navigate(FEED_URL)
    await nap(waitMs)
    const r = await transport.evaluate(feedScript(limit))
    if (!r?.ok) return { ok: false, why: r?.why ?? 'eval-failed', items: [] }
    let parsed = r.value
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { return { ok: false, why: 'bad-json', items: [] } }
    }
    const items = Array.isArray(parsed?.items) ? parsed.items.slice(0, limit) : []
    return { ok: true, items }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err), items: [] }
  }
}


/** 网络请求 URL 里能当「当前在播」的 id：group_id / aweme_id / item_id，至少 15 位。 */
export const CURRENT_ID_MARKS = ['group_id=', 'aweme_id=', 'item_id=']

export function idFromUrl(url = '') {
  let s = String(url ?? '')
  try { s = decodeURIComponent(s) } catch { /* 原样找 */ }
  for (const mark of CURRENT_ID_MARKS) {
    const p = s.indexOf(mark)
    if (p < 0) continue
    const m = /^\d{15,25}/.exec(s.slice(p + mark.length))
    if (m) return { id: m[0], mark }
  }
  return { id: '', mark: '' }
}

/** 从网络日志倒着找：最后一条带 id 的请求最接近此刻在播的那条。 */
export function currentIdFromLog(entries = []) {
  const list = Array.isArray(entries) ? entries : []
  for (let i = list.length - 1; i >= 0; i--) {
    const got = idFromUrl(list[i]?.url ?? list[i] ?? '')
    if (got.id) return got
  }
  return { id: '', mark: '' }
}

/**
 * 页面里那一小段：这个 id 在 DOM 里出现几次、正在播的 video 和它是不是同一块。
 * 只在页面里数数，不点任何东西。
 */
export function currentPageScript(id = '') {
  const want = JSON.stringify(String(id ?? ''))
  return `(() => {
    const id = ${want}
    const html = document.documentElement.innerHTML
    let hits = 0, i = 0
    while ((i = html.indexOf(id, i)) >= 0) { hits += 1; i += id.length }
    const vids = Array.from(document.querySelectorAll('video'))
    const v = vids.find((x) => !x.paused) || vids[0] || null
    let sameItem = false
    if (v) {
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'))
      for (const a of links) {
        const href = String(a.getAttribute('href') || '')
        if (!href.includes(id)) continue
        let el = a
        for (let d = 0; d < 8 && el; d += 1, el = el.parentElement) {
          if (el.contains(v)) { sameItem = true; break }
        }
        if (sameItem) break
      }
    }
    const descEl = document.querySelector('[data-e2e="video-desc"], .video-info-detail, .xg-video-container h1')
    return JSON.stringify({
      hits,
      playing: v ? !v.paused : false,
      sameItem,
      title: document.title || '',
      desc: descEl ? String(descEl.innerText || '').trim().slice(0, 200) : '',
    })
  })()`
}

/** 没有 id 时也能说清楚页面在不在播、标题是什么。 */
export function pageStateScript() {
  return `(() => {
    const vids = Array.from(document.querySelectorAll('video'))
    const v = vids.find((x) => !x.paused) || vids[0] || null
    const descEl = document.querySelector('[data-e2e="video-desc"], .video-info-detail, .xg-video-container h1')
    return JSON.stringify({
      playing: v ? !v.paused : false,
      title: document.title || '',
      desc: descEl ? String(descEl.innerText || '').trim().slice(0, 200) : '',
    })
  })()`
}

function parsePageValue(v) {
  let x = v
  if (typeof x === 'string') {
    try { x = JSON.parse(x) } catch { return null }
  }
  return x && typeof x === 'object' ? x : null
}

async function readPage(transport, expression) {
  try {
    const r = await transport.evaluate(expression)
    if (!r?.ok) return { ok: false, why: r?.why ?? '页面没回话' }
    const page = parsePageValue(r.value)
    return page ? { ok: true, page } : { ok: false, why: '页面回的不是可读的状态' }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }
}

/**
 * 此刻正在播的那条视频的 aweme_id。
 *
 * 先看网络日志里最后一条带 group_id/aweme_id 的请求，再回页面里数这个 id：
 *   · 页面里没有这个 id       → 疑似（可能拿到的是上一条，别当准）；
 *   · 页面里有，但对不上正在播的 video → 也标成疑似；
 *   · 都对得上                 → verified。
 * 永不抛；拿不到就照实说拿不到。
 */
export async function currentId({ transport } = {}) {
  if (!transport || typeof transport.evaluate !== 'function') {
    return { ok: false, id: '', verified: false, why: '没有可用的浏览器通道' }
  }
  try {
    if (typeof transport.enableNetwork === 'function') await transport.enableNetwork()
  } catch { /* 网络日志拿不到就退到页面状态 */ }

  let log = []
  try {
    if (typeof transport.networkLog === 'function') log = await transport.networkLog()
  } catch { /* 同上 */ }
  const hit = currentIdFromLog(log)
  if (!hit.id) {
    const st = await readPage(transport, pageStateScript())
    return {
      ok: false,
      id: '',
      verified: false,
      why: '网络日志里还没有换片请求',
      playing: st.ok ? Boolean(st.page.playing) : false,
      title: st.ok ? String(st.page.title ?? '') : '',
      desc: st.ok ? String(st.page.desc ?? '') : '',
    }
  }

  const checked = await readPage(transport, currentPageScript(hit.id))
  if (!checked.ok) {
    return { ok: true, id: hit.id, source: hit.mark, verified: false, hits: -1, why: checked.why }
  }
  const page = checked.page
  const hits = Number(page.hits ?? 0) || 0
  const playing = Boolean(page.playing)
  const sameItem = Boolean(page.sameItem)
  const verified = hits > 0 && (!playing || sameItem)
  let why = ''
  if (hits <= 0) why = '页面上没找到这个 id'
  else if (playing && !sameItem) why = '页面上有这个 id，但没对上正在播的那一块'
  return {
    ok: true,
    id: hit.id,
    source: hit.mark,
    verified,
    hits,
    playing,
    sameItem,
    title: String(page.title ?? ''),
    desc: String(page.desc ?? ''),
    why,
  }
}

/** 把 currentId 的结果说成两句人话；不确定就说不确定。 */
export function renderCurrentId(got = {}) {
  const title = got.title ? `\n页面标题：${got.title}` : ''
  const desc = got.desc ? `\n文案：${got.desc}` : ''
  if (!got.ok) {
    return `没拿到当前在播的号（${got.why ?? '网络日志里还没有换片请求'}）。${title}${desc}\n滑一条再试；这一下先别当准。`
  }
  if (got.verified) {
    const times = Number(got.hits ?? 0) > 0 ? `，页面上出现 ${got.hits} 次` : ''
    return `当前在播的号：${got.id}（来源 ${got.source}${times}）${title}${desc}`
  }
  return `疑似当前在播的号：${got.id}（来源 ${got.source}；${got.why || '没能和画面对上'}）${title}${desc}\n可能拿到的是上一条；滑一下再试，先别拿它当准。`
}

/**
 * CDP 传输层。单拆出来是为了测试时可以整个换掉——
 * 渠道逻辑（去重、切段、退避）不该依赖「这台机器上有没有浏览器」。
 */
export function createCdpTransport(opts = {}) {
  let child = null
  let ws = null
  let nextId = 1
  const pending = new Map()
  let targetUrl = ''
  let networkOn = false
  const networkUrls = []
  const eventHandlers = new Set()

  const port = Number(opts.debugPort ?? DEFAULTS.debugPort)
  const profileDir = opts.profileDir || path.join(os.tmpdir(), 'dsh-roost-douyin-profile')

  async function waitForDevtools(timeoutMs = 15000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (r.ok) return true
      } catch { /* 还没起来 */ }
      await sleep(300)
    }
    return false
  }

  async function pageTarget() {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      return page ?? null
    } catch {
      return null
    }
  }

  function connect(url) {
    return new Promise((resolve, reject) => {
      let sock
      try {
        sock = new WebSocket(url)
      } catch (err) {
        reject(err)
        return
      }
      sock.addEventListener('open', () => {
        ws = sock
        resolve(true)
      })
      sock.addEventListener('error', () => reject(new Error('cdp-connect-failed')))
      sock.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(String(ev.data)) } catch { return }
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? 'cdp-error'))
          else p.resolve(msg.result)
          return
        }
        if (msg.method) {
          if (msg.method === 'Network.requestWillBeSent') {
            const url = String(msg.params?.request?.url ?? '')
            if (url) {
              networkUrls.push({ url, at: Date.now(), type: String(msg.params?.type ?? '') })
              if (networkUrls.length > 120) networkUrls.shift()
            }
          }
          for (const fn of eventHandlers) {
            try { fn(msg) } catch { /* 监听器自己的错不影响传输 */ }
          }
        }
      })
      sock.addEventListener('close', () => {
        ws = null
        for (const [, p] of pending) p.reject(new Error('cdp-closed'))
        pending.clear()
      })
    })
  }

  function send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!ws) return reject(new Error('cdp-not-connected'))
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('cdp-timeout'))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  return {
    async launch() {
      const exe = await findBrowser(opts.browserPath, opts.platform)
      if (!exe) return { ok: false, why: '没找到 Edge 或 Chrome；请在插件设置里填 browserPath' }
      try {
        await fs.mkdir(profileDir, { recursive: true })
        child = spawn(exe, [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ], { detached: false, stdio: 'ignore', windowsHide: false })
        child.unref?.()
      } catch (err) {
        return { ok: false, why: `拉不起来浏览器：${String(err?.message ?? err).slice(0, 120)}` }
      }
      const up = await waitForDevtools()
      if (!up) return { ok: false, why: '浏览器起来了，但调试端口没开（可能被别的实例占用）' }
      const page = await pageTarget()
      if (!page) return { ok: false, why: '没有可用的页面目标' }
      targetUrl = page.webSocketDebuggerUrl
      try {
        await connect(targetUrl)
        await send('Page.enable')
        await send('Runtime.enable')
      } catch (err) {
        return { ok: false, why: `连不上调试通道：${String(err?.message ?? err).slice(0, 120)}` }
      }
      return { ok: true }
    },

    // 2026-11-02：主包 `lib/douyinbrowse.js` 调的是 `transport.start()`，
    // 而这里原来只导出 `launch()`——第一次真机跑抖音就死在 `cdp-not-connected` 上
    // （`start` 不存在 → 浏览器根本没被拉起来 → 第一条 CDP 命令就没连接）。
    // 两个名字都留着：`launch` 是内部语义，`start` 是对外的统一接口。
    async start() {
      return this.launch()
    },

    async navigate(url) {
      try {
        await send('Page.navigate', { url })
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 在页面里跑一段表达式。awaitPromise 默认关，读 fetch 结果时显式打开。 */
    async evaluate(expression, opts = {}) {
      try {
        const r = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: Boolean(opts?.awaitPromise),
        })
        if (r?.exceptionDetails) return { ok: false, why: 'page-script-error', raw: r }
        return { ok: true, value: r?.result?.value }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 开网络事件。只记请求 URL，不读响应体，也不碰凭据。 */
    async enableNetwork() {
      if (networkOn) return { ok: true }
      try {
        await send('Network.enable', { maxTotalBufferSize: 50000000 })
        networkOn = true
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    /** 最近的请求 URL（最多 120 条），给「当前在播」反查用。 */
    networkLog() {
      return networkUrls.slice()
    },

    /** 监听 CDP 事件；返回取消监听的函数。 */
    onEvent(fn) {
      if (typeof fn !== 'function') return () => {}
      eventHandlers.add(fn)
      return () => eventHandlers.delete(fn)
    },

    /**
     * 把窗口提到前台（2026-11-02 真机）。
     *
     * 复用一个已经在跑的 Edge profile 时，新开的窗口经常在后台，
     * `document.visibilityState` 是 `hidden`——抖音的会话列表这时全是 0×0 的盒子，
     * 点哪都点不到。点之前先 bringToFront，一切才正常。
     */
    async bringToFront() {
      try {
        await send('Page.bringToFront')
        return { ok: true }
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err) }
      }
    },

    async close() {
      try { ws?.close() } catch { /* ignore */ }
      try { child?.kill() } catch { /* ignore */ }
      ws = null
      child = null
    },
  }
}

export default { createCdpTransport, browseFeed, feedScript, currentId, renderCurrentId }
