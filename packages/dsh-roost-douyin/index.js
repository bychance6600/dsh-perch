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

export default { createCdpTransport, browseFeed, feedScript }
