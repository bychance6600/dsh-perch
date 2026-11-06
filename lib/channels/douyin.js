/**
 * 抖音材料适配器（2026-11-06，只留报纸）
 *
 * 抖音不是住处，是**材料**：推荐流、一条视频的详情、热榜与搜索。
 * 私信、群、点开某个会话都不在这里了——那些随 0.1.0 的渠道收窄一起删掉。
 *
 * 它借一台**她自己的**浏览器（登录态留在 `<root>/douyin-profile`），
 * 在页面里用 `fetch` 读几个网页版只读接口：cookie 带得上，也不用签名。
 * 页面地址只用来当同源起点，真正的内容一律走站内路径。
 *
 * 真正的浏览器实现在可选子包 `dsh-roost-douyin` 里；没装时整条路消失，
 * 不报错、不建文件（`lib/channels/sub.js` 负责两条找法）。
 * 测试用 `opts.transport` 换掉整个传输层，不依赖这台机器上有没有 Edge/Chrome。
 */

import path from 'node:path'
import { loadSubModule } from './sub.js'

const FEED_HOME = 'https://www.douyin.com/'

/**
 * @param {object} opts
 * @param {string} opts.root           数据目录（`~/.dsh-roost`）
 * @param {object} opts.config         整份配置
 * @param {(m: string) => void} [opts.log]
 * @param {object|Function} [opts.transport] 测试注入：传输层对象或返回它的工厂
 */
export function create(opts = {}) {
  const { root = '', config = {}, log = () => {}, transport: injected = null } = opts
  const cfg = config?.channels?.douyin ?? {}
  const browse = config?.browse?.douyin ?? {}

  let transport = null
  let running = false
  let since = 0
  let lastError = ''

  const browserPath = String(cfg.browserPath || browse.browserPath || '').trim()
  // 落哪一页只影响同源起点。私信入口早就不用了，跟着首页走最省事；
  // 想停在推荐流的人可以自己填 homeUrl。
  const homeUrl = String(cfg.homeUrl ?? '').trim() || FEED_HOME

  async function makeTransport() {
    if (transport) return transport
    // 登录态必须留在她自己的数据目录：子包默认的临时目录每轮都换，
    // 扫码一次下一轮就丢（2026-11-02 真机踩过）。
    const transportOpts = { browserPath, profileDir: path.join(root, 'douyin-profile') }
    if (typeof injected === 'function') {
      transport = await injected(transportOpts)
    } else if (injected) {
      transport = injected
    } else {
      const mod = await loadSubModule()
      const factory = mod?.createCdpTransport
      if (typeof factory !== 'function') return null
      transport = factory(transportOpts)
    }
    return transport
  }

  /** 借她的浏览器读一个网页版只读接口。只要站内路径，不要整条 URL。 */
  async function api(p) {
    if (!transport) return { ok: false, why: '抖音没开：先去设置里打开' }
    const target = String(p ?? '')
    if (!target.startsWith('/')) return { ok: false, why: '只接受站内路径' }
    try {
      const r = await transport.evaluate(
        `fetch(${JSON.stringify(target)}, { credentials: 'include' }).then((r) => r.text()).then((t) => t.slice(0, 400000)).catch((e) => 'ERR:' + e.message)`,
        // 必须等 Promise：不然拿回来的是 Promise 对象的字符串化结果 "{}"，
        // 看起来像「返回的不是 JSON」（2026-11-03 真机踩过）。
        { awaitPromise: true },
      )
      if (!r?.ok) return { ok: false, why: r?.why ?? 'eval-failed' }
      const text = String(r.value ?? '')
      if (!text || text.startsWith('ERR:')) return { ok: false, why: (text || '空响应').slice(0, 120) }
      try { return { ok: true, data: JSON.parse(text) } } catch { return { ok: false, why: '返回的不是 JSON' } }
    } catch (err) {
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
  }

  return {
    name: 'douyin',
    /** 只读材料层：路由器不该指望它有 `onMessage` 或 `send`。 */
    kind: 'reader',

    async start() {
      if (running) return { ok: true, why: '' }
      try {
        const t = await makeTransport()
        if (!t) return { ok: false, why: '没装抖音子包 dsh-roost-douyin' }
        const launched = await (t.launch ?? t.start)?.()
        if (launched && launched.ok === false) {
          lastError = String(launched.why ?? 'douyin-start-failed').slice(0, 160)
          // 浏览器没起来：下次还能再试，别把半截连接一直挂着。
          transport = null
          return { ok: false, why: lastError }
        }
        // fetch 的 cookie 只对抖音的源生效；先在抖音站内停一页，再读接口。
        if (typeof t.navigate === 'function') {
          try { await t.navigate(homeUrl) } catch (err) {
            log(`douyin navigate failed: ${String(err?.message ?? err).slice(0, 120)}`)
          }
        }
        running = true
        since = since || Date.now()
        lastError = ''
        return { ok: true, why: '' }
      } catch (err) {
        lastError = String(err?.message ?? err).slice(0, 160)
        transport = null
        return { ok: false, why: lastError }
      }
    },

    async stop() {
      try { await transport?.close?.() } catch { /* 停的时候不许抛 */ }
      transport = null
      running = false
      since = 0
    },

    api,

    /**
     * 推荐流：`tab/feed` 带 cookie 就能读，不用签名、不用截屏（2026-11-03 真机验过）。
     * 只回她自己刷站要用的字段，别把整个 aweme 塞进上下文。
     */
    async feed({ count = 6 } = {}) {
      const n = Math.max(1, Math.min(20, Number(count) || 6))
      const r = await api(
        `/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=${n}&refresh_index=1`,
      )
      if (!r.ok) return { ok: false, why: r.why }
      const list = Array.isArray(r.data?.aweme_list) ? r.data.aweme_list : []
      const items = list
        .map((d) => ({
          id: String(d?.aweme_id ?? ''),
          title: String(d?.desc ?? '').trim(),
          author: String(d?.author?.nickname ?? '').trim(),
          like: Number(d?.statistics?.digg_count ?? 0),
        }))
        .filter((x) => x.id && x.title)
      if (!items.length) return { ok: false, why: '推荐流这会儿是空的' }
      return { ok: true, items }
    },

    status() {
      const connected = Boolean(transport) && running
      return {
        ok: connected,
        connected,
        since,
        lastError,
        // 保留旧字段的形状：观测台还在读它们；只读层没有收发。
        queued: 0,
        sent: 0,
        received: 0,
      }
    },
  }
}

export default { create }
