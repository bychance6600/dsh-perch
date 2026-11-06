/**
 * douyinlook.js —— 她自己的眼睛（抖音）：douyin_look 工具
 *
 * 为什么单独一个工具，而不是靠叫醒时端上来：
 *   她说过「没有能翻抖音的东西」——那句话是对的。叫醒时端上来的是**别人替她选的**，
 *   她想看的时候看不了。B 站那边有 bili_look，抖音这边也得有同一件事。
 *
 * 与 bili_look 的区别（也是这一版唯一的取巧处）：
 *   抖音网页版的推荐流在 DOM 里抓不到（标题画在 canvas 里），但站内只读接口
 *   `/aweme/v1/web/tab/feed/` 带着登录态就能读。所以这里借她自己的浏览器页面发一次
 *   fetch，拿 `desc` / 作者 / 时长 / 点赞。
 *   **只读**：不点赞、不评论、不关注；关浏览器时一并关掉。
 *
 * 三条与 bili_look 一致的约束：
 *   1. 只读，不留痕迹；
 *   2. 不回显状态（不说还剩几次、不说是第几阶段）；
 *   3. 不给她讲配置（不说"你被限制了"）。
 */

import path from 'node:path'
import { readEvents, rootDir, appendEvent } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { loadDouyin } from './douyinbrowse.js'
import { lookedLine } from './browse.js'
import { awemeIdFromUrl, fetchAweme, framesOf } from './dylink.js'
import { toJsonSchema } from './toolschema.js'
import { guardWrite } from './tenant.js'
import { defineTool } from './tool.js'

/** 站内只读推荐流（网页版 webapp 那一套参数；不带签名也能读，只要带 cookie）。 */
export const FEED_PATH = '/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count='

export const FEED_MIN = 1
export const FEED_MAX = 8
export const FEED_HOME = 'https://www.douyin.com/?recommend=1'

/** 热榜接口（2026-11-06，A9）：网页版热榜，不登录也能读，字段里有词、热度、名次。 */
export const HOT_PATH = '/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1'
export const HOT_URL = 'https://www.douyin.com' + HOT_PATH
/** 备用口：老版 billboard，字段更少，但同样不用登录。 */
export const HOT_BILLBOARD = 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/'
/** 热榜每天只上一次（设计文档 §三）。它不占报纸配额，但自己也有个上限。 */
export const HOT_PER_DAY = 1
export const HOT_MAX = 20

/**
 * 热榜返回的那坨 JSON → 一行一个词。认不出就返回空数组，不瞎猜。
 * 两个口子形状不同：网页版在 data.word_list，老版在 word_list。
 * @param {string|object} raw
 */
export function normalizeHot(raw) {
  let data = raw
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return [] }
  }
  const list = data?.data?.word_list ?? data?.word_list ?? data?.trending_list
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const it of list) {
    const word = String(it?.word ?? '').replace(/\s+/g, ' ').trim()
    if (!word || seen.has(word)) continue
    seen.add(word)
    out.push({ word, hot: Number(it?.hot_value ?? 0) || 0, rank: Number(it?.position ?? 0) || out.length + 1 })
  }
  return out
}

/** 读一次热榜。永不抛：两个口子都不通就说没读到。 */
export async function fetchHot({ fetchImpl = globalThis.fetch, limit = 10 } = {}) {
  const n = Math.max(1, Math.min(HOT_MAX, Number(limit) || 10))
  if (typeof fetchImpl !== 'function') return { ok: false, items: [], why: '没有可用的 fetch' }
  const headers = {
    referer: 'https://www.douyin.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  }
  for (const url of [HOT_URL, HOT_BILLBOARD]) {
    try {
      const res = await fetchImpl(url, { headers })
      if (!res || res.ok === false || Number(res.status ?? 200) >= 400) continue
      const text = typeof res.text === 'function' ? await res.text() : res
      const items = normalizeHot(text).slice(0, n)
      if (items.length) return { ok: true, items, why: '' }
    } catch { /* 换下一个口 */ }
  }
  return { ok: false, items: [], why: '热榜这会儿没读到' }
}

/** 热榜的几行。写「大家都在搜」，不写「你应该注意」。 */
export function renderHot(items = []) {
  return (Array.isArray(items) ? items : []).map((it, i) => {
    const hot = it.hot ? ` · ${it.hot >= 10000 ? `${Number((it.hot / 10000).toFixed(1))} 万` : it.hot}` : ''
    return `${i + 1}. ${it.word}${hot}`
  }).join('\n')
}

/**
 * 热榜的账（A9）：`looked:hot <日期> 词 词…`。
 * 与 `looked:<id> from:…` 分开：热榜上是一串词，不是她看过的哪条视频；
 * 混在一起，seenBvids 就会把 hot 当成一个 id。
 */
export function hotLine(dk, words = []) {
  const body = (Array.isArray(words) ? words : []).slice(0, 10)
    .map((w) => String(w ?? '').replace(/\s+/g, '_').slice(0, 40)).filter(Boolean).join(' ')
  return `looked:hot ${dk}${body ? ` ${body}` : ''}`
}

/** 今天热榜看过几次。 */
export function hotCountToday(events, dk = dateKey()) {
  const want = `looked:hot ${dk}`
  let n = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e?.text ?? '')
    if (t === want || t.startsWith(`${want} `)) n += 1
  }
  return n
}

/** 评论页里跑的那一小段：只读前几条的文字与作者，不点赞不回复。 */
export function commentScript(count = 10) {
  const n = Math.max(1, Math.min(20, Number(count) || 10))
  return `JSON.stringify([...document.querySelectorAll('[data-e2e="comment-item"]')].slice(0,${n}).map(function(e){var c=e.querySelector('[data-e2e="comment-content"]');var u=e.querySelector('a[href*="/user/"]');return {txt:((c&&c.innerText)||e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,200),user:u?(u.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20):''}}))`
}

/** 评论页读回来的东西 → 几行。认不出就当没读到。 */
export function normalizeComments(raw) {
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const it of list) {
    const txt = String(it?.txt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (!txt) continue
    out.push({ user: String(it?.user ?? '').replace(/\s+/g, ' ').trim().slice(0, 20), txt })
  }
  return out
}

/** 评论的几行。原样递过去，不加评语。 */
export function renderComments(items = []) {
  return (Array.isArray(items) ? items : []).map((it, i) => `${i + 1}. ${it.user ? `${it.user}：` : ''}${it.txt}`).join('\n')
}

/** 详情接口不给的时候，退一步：打开那一条的页面，从 DOM 里读文案/作者/视频地址。 */
export function itemScript() {
  return `JSON.stringify((function(){var q=function(s){var e=document.querySelector(s);return e?(e.innerText||'').trim():''};var v=document.querySelector('video');var m=document.querySelector('meta[property="og:description"]');return {desc:(q('[data-e2e="video-desc"]')||q('h1')||(m&&m.content)||'').replace(/\\s+/g,' ').slice(0,200),author:q('[data-e2e="video-author-name"]')||q('[data-e2e="user-info"]'),src:(v&&v.currentSrc)||'',dur:(v&&Math.round(v.duration||0))||0}}))()`
}

/** 站内搜索页（按词找）。搜索接口要签名，搜索页不用——结果就是真的链接。 */
export const SEARCH_HOME = 'https://www.douyin.com/search/'

export function searchUrl(keyword = '') {
  const kw = String(keyword ?? '').trim().slice(0, 30)
  return `${SEARCH_HOME}${encodeURIComponent(kw)}?type=video`
}

/** 页面里跑的那一小段：读文本回来，不在页面里解析（解析留给 Node 侧，好测）。 */
export function feedScript(count = 6) {
  const n = Math.max(FEED_MIN, Math.min(24, Number(count) || 6))
  return `fetch('${FEED_PATH}${n}&refresh_index=1',{credentials:'include'}).then(function(r){return r.text()})`
}

/** 搜索页那一小段：把结果里的真实链接连文字一起抠出来。 */
export function searchScript(limit = 8) {
  const n = Math.max(FEED_MIN, Math.min(20, Number(limit) || 8))
  return `JSON.stringify([...document.querySelectorAll('a[href*="/video/"]')].slice(0,${n}).map(function(a){` +
    `return {href:a.getAttribute('href'),txt:(a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,160)}}))`
}

/**
 * 搜索页的结果：`href` 里抠 id，文字当文案（前面常带「合集 03:27 4.2万」这类前缀，剥掉）。
 * @param {string|object} raw
 */
export function normalizeSearch(raw) {
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const it of list) {
    const href = String(it?.href ?? '')
    const m = /\/(?:video|note)\/(\d{6,25})/.exec(href)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    const desc = String(it?.txt ?? '')
      .replace(/^合集\s*/, '')
      .replace(/^\d{1,2}:\d{2}\s*/, '')
      .replace(/^[\d.]+\s*万?\s*/, '')
      .trim()
    out.push({ id: m[1], desc: desc || '（没有文案）', author: '', duration: 0, likes: 0 })
  }
  return out
}

/**
 * 把接口返回的那坨 JSON 变成她看得懂的几行。认不出就返回空数组，不瞎猜。
 * @param {string|object} raw
 * @returns {Array<{id:string,pick:string,desc:string,author:string,duration:number,likes:number}>}
 */
export function normalizeFeed(raw) {
  let data = raw
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return [] }
  }
  const list = data?.aweme_list
  if (!Array.isArray(list)) return []
  const out = []
  for (const a of list) {
    const id = String(a?.aweme_id ?? '').trim()
    if (!/^\d{6,25}$/.test(id)) continue
    const desc = String(a?.desc ?? '').replace(/\s+/g, ' ').trim()
    const author = String(a?.author?.nickname ?? '').trim()
    const duration = Math.round(Number(a?.video?.duration ?? 0) / 1000) || 0
    const likes = Number(a?.statistics?.digg_count ?? 0) || 0
    out.push({ id, desc: desc || '（没有文案）', author, duration, likes })
  }
  return out
}

/** 真打开一条：先问详情接口，拿不到就打开页面从 DOM 里读。永不抛。 */
async function openItem({ transport, api, id, root, log }) {
  const det = await fetchAweme(id, { api }).catch(() => null)
  if (det?.ok && det.item) {
    const shot = await framesOf(det.item, { root }).catch(() => null)
    return { id, desc: det.item.desc, shot, src: 'api' }
  }
  const why = det?.why ?? '详情没拿到'
  await transport?.navigate?.(`https://www.douyin.com/video/${id}`).catch(() => {})
  await new Promise((r) => setTimeout(r, 3500))
  const got = await transport?.evaluate?.(itemScript(), { awaitPromise: true }).catch(() => null)
  let page = null
  try { page = JSON.parse(typeof got === 'string' ? got : (got?.value ?? '')) } catch { page = null }
  if (!page?.src) return { id, desc: page?.desc || '', shot: { ok: false, why: `${why}；页面里也没有视频地址` }, src: 'dom' }
  const item = { id, desc: page.desc || '（没有文案）', author: page.author || '', duration: page.dur || 0, playUrl: page.src }
  const shot = await framesOf(item, { root }).catch(() => null)
  return { id, desc: item.desc, shot, src: 'dom' }
}

/** 几行素材，不带任何"你应该…"的口气。 */
export function renderFeed(items = []) {
  return items.map((it, i) => {
    const bits = [it.desc]
    if (it.author) bits.push(`作者 ${it.author}`)
    if (it.duration) bits.push(`${it.duration} 秒`)
    if (it.likes) bits.push(`${it.likes >= 10000 ? `${(it.likes / 10000).toFixed(1)} 万` : it.likes} 赞`)
    return `${i + 1}. ${bits.join(' · ')}`
  }).join('\n')
}

/** 今天已经翻到过的 id（同一天不重复端上来）。 */
export function seenToday(events, dk = dateKey()) {
  const set = new Set()
  for (const e of events ?? []) {
    const t = String(e?.text ?? '')
    if (e?.type !== 'meta' || !t.startsWith(`dyfeed:${dk}`)) continue
    for (const id of t.split(/\s+/).slice(1)) if (/^\d{6,25}$/.test(id)) set.add(id)
  }
  return set
}

/**
 * 热榜（A9）：一天一次，不登录、不开浏览器。
 * 热榜上是一串词，不是平台上推给她的视频——所以它既不占报纸配额（dy-browse:），
 * 也不写 dyfeed:，只记自己的那一行 looked:hot。
 */
export async function lookHotOnce(o = {}) {
  const root = o.root ?? rootDir()
  try {
    const cfg = o.cfg ?? (await loadConfig(root).catch(() => ({ config: {} }))).config
    if (!cfg?.channels?.douyin?.enabled && !cfg?.browse?.douyin?.enabled) {
      return { ok: false, text: '', note: '抖音这边没开。', picks: [] }
    }
    const events = o.events ?? (await readEvents(root).then((r) => r.events).catch(() => []))
    const dk = dateKey()
    if (!o.force && hotCountToday(events, dk) >= HOT_PER_DAY) {
      return { ok: false, text: '', note: '热榜今天看过了，明天才换新的。', picks: [] }
    }
    const limit = Math.max(1, Math.min(10, Number(o.limit ?? 10) || 10))
    const got = await fetchHot({ fetchImpl: o.fetchImpl, limit })
    if (!got.items.length) return { ok: false, text: '', note: got.why || '热榜这会儿没读到', picks: [] }
    const day = Number(o.model?.day ?? 0)
    const stage = Number(o.model?.stage ?? 1)
    await appendEvent(
      { type: 'meta', text: hotLine(dk, got.items.map((it) => it.word)) },
      { day, stage, source: 'system' },
      root,
    ).catch(() => {})
    return {
      ok: true,
      text: `热榜上现在这些（大家都在搜的，不是平台挑给你的）：\n${renderHot(got.items)}`,
      note: '',
      picks: [],
    }
  } catch (err) {
    return { ok: false, text: '', note: String(err?.message ?? err).slice(0, 120), picks: [] }
  }
}
/**
 * 翻一次。永不抛。
 * @param {object} o
 * @param {string} [o.root]
 * @param {object} [o.cfg]
 * @param {number} [o.limit]
 * @param {object} [o.transport] 测试注入
 * @param {number} [o.waitMs] 页面起来后等多久（测试传 0）
 * @returns {Promise<{ok:boolean,text:string,note:string,picks:object[]}>}
 */
export async function lookFeedOnce(o = {}) {
  const root = o.root ?? rootDir()
  let transport = o.transport ?? null
  try {
    const cfg = o.cfg ?? (await loadConfig(root)).config
    const want = Math.max(FEED_MIN, Math.min(FEED_MAX, Number(o.limit ?? cfg?.browse?.douyin?.topN ?? 6)))
    const browserPath = cfg?.browse?.douyin?.browserPath || cfg?.channels?.douyin?.browserPath || ''

    if (!cfg?.channels?.douyin?.enabled && !cfg?.browse?.douyin?.enabled) {
      return { ok: false, text: '', note: '抖音这边没开。', picks: [] }
    }

    // what=hot：热榜不登录、也不开浏览器，走主包的 fetch（A9）。
    const what = String(o.what ?? '').trim()
    if (what === 'hot') return await lookHotOnce({ ...o, root, cfg })

    if (!transport) {
      const mod = await loadDouyin()
      if (!mod?.createCdpTransport) {
        return { ok: false, text: '', note: '抖音那边没装。', picks: [] }
      }
      transport = await mod.createCdpTransport({
        browserPath,
        // 登录态在数据目录里那一个 profile 上（和刷抖音的报纸共用）
        profileDir: o.profileDir || path.join(root, 'douyin-profile'),
      })
    }

    const started = await transport?.start?.()
    if (started && started.ok === false) {
      return { ok: false, text: '', note: started.why ?? '浏览器没起来。', picks: [] }
    }

    if (what === 'comments') {
      const rawId = String(o.id ?? '').trim()
      const id = awemeIdFromUrl(rawId || String(o.keyword ?? '')) || (/^\d{6,25}$/.test(rawId) ? rawId : '')
      if (!id) return { ok: false, text: '', note: '要看哪条下面的评论？给我那条的号或链接。', picks: [] }
      await transport.bringToFront?.().catch?.(() => {})
      await transport.navigate?.(`https://www.douyin.com/video/${id}`)
      const wait = Number(o.waitMs ?? 3500)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      const got = await transport.evaluate?.(commentScript(Math.max(6, Number(o.limit ?? 10))), { awaitPromise: true })
      const list = normalizeComments(typeof got === 'string' ? got : (got?.value ?? ''))
      if (!list.length) return { ok: false, text: '', note: '打开了，但这条下面没看到评论。', picks: [] }
      const cday = Number(o.model?.day ?? 0)
      const cstage = Number(o.model?.stage ?? 1)
      // 她自己点名打开的那一条：和 bili_look 的 comments 一个口径，记 from:pick。
      await appendEvent({ type: 'meta', text: lookedLine(`dy_${id}`, 'pick') }, { day: cday, stage: cstage, source: 'system' }, root).catch(() => {})
      return { ok: true, text: renderComments(list), note: '', picks: [] }
    }

    const kw = String(o.keyword ?? '').trim().slice(0, 30)
    // what=search 而不给词：别悄悄退回推荐流，那会让她以为搜了。
    if (what === 'search' && !kw) return { ok: false, text: '', note: '要搜什么？给个词。', picks: [] }
    // 页面里发一次站内请求（借她的登录态）。只给 dylink 用，不对外。
    const api = async (p) => {
      const got = await transport.evaluate?.(
        `fetch(${JSON.stringify(p)},{credentials:'include'}).then(function(x){return x.text()})`,
        { awaitPromise: true },
      )
      if (!got || got.ok === false) return { ok: false, why: '页面没回话' }
      try { return { ok: true, data: JSON.parse(got.value ?? got) } } catch { return { ok: false, why: '返回的不是 JSON' } }
    }

    let raw = ''
    let opened = null
    try {
      // 按词找走搜索页（搜索接口要签名，页面不用）；不按词就翻推荐流。
      // 先把这个窗口提到前面：机器上常有一个后台的 Edge 还占着同一个 profile，
      // 后台窗口里页面不渲染，懒加载的搜索结果一条都不出来（2026-11-04 实测）。
      await transport.bringToFront?.().catch?.(() => {})
      await transport.navigate?.(kw ? searchUrl(kw) : (cfg?.channels?.douyin?.homeUrl || FEED_HOME))
      const wait = Number(o.waitMs ?? (kw ? 2600 : 1500))
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      const got = await transport.evaluate?.(kw ? searchScript(want) : feedScript(want), { awaitPromise: true })
      if (got && got.ok === false) {
        return { ok: false, text: '', note: '抖音那边没回话。', picks: [] }
      }
      raw = typeof got === 'string' ? got : (got?.value ?? '')
      // 搜索页是懒加载的：机器上实测 3 秒时还是一条都没有，6 秒才出来。
      // 所以给一次机会：等一会儿再看一眼，还空就认。
      if (kw && !normalizeSearch(raw).length) {
        await new Promise((r) => setTimeout(r, Number(o.retryMs ?? 3000)))
        const again = await transport.evaluate?.(searchScript(want), { awaitPromise: true })
        if (again && again.ok !== false) raw = typeof again === 'string' ? again : (again?.value ?? raw)
      }

      // 「一句话，把那个东西本身拿回来」（2026-11-04，她自己提的）：
      // 只给一串标题，她说的还是「报纸放在桌上」。所以按词找到之后，
      // 真去打开第一条：取文案 + 抽三帧，把图的路径递给她（她自己 read_image）。
      // 她要挑哪一条，就开哪一条——不是我替她定第一条。
      const at = Math.max(0, Math.min(Number(o.index ?? 0) || 0, 20))
      const head = (kw ? normalizeSearch(raw) : normalizeFeed(raw))[at]
      if (o.open && head?.id) {
        const got = await openItem({ transport, api, id: head.id, root })
        opened = {
          id: got.id,
          desc: String(got.desc || head.desc || '').slice(0, 200),
          path: got.shot?.ok ? String(got.shot.path ?? '') : '',
          why: got.shot?.ok ? '' : (got.shot?.why ?? '画面没截到'),
        }
      }
    } finally {
      await transport?.close?.().catch?.(() => {})
    }

    const items = kw ? normalizeSearch(raw) : normalizeFeed(raw)
    if (!items.length) {
      return { ok: false, text: '', note: kw ? `搜「${kw}」什么都没搜到。` : '平台这会儿没给。', picks: [] }
    }

    const events = o.events ?? (await readEvents(root).then((r) => r.events).catch(() => []))
    const dk = dateKey()
    const seen = seenToday(events, dk)
    const fresh = items.filter((it) => !seen.has(it.id)).slice(0, want)
    if (!fresh.length && !opened) {
      return { ok: false, text: '', note: '翻到的都看过了。想看哪条，把链接给我。', picks: [] }
    }

    const day = Number(o.model?.day ?? 0)
    const stage = Number(o.model?.stage ?? 1)
    if (fresh.length) {
      await appendEvent(
        { type: 'meta', text: `dyfeed:${dk} ${fresh.map((it) => it.id).join(' ')}` },
        { day, stage, source: 'system' },
        root,
      ).catch(() => {})
    }
    // 搜过的词单独一行（A7），跟 B 站那边一个口径：searched:<词> douyin。
    if (kw) {
      const w = kw.replace(/\s+/g, '_').slice(0, 40)
      await appendEvent({ type: 'meta', text: `searched:${w} douyin` }, { day, stage, source: 'system' }, root).catch(() => {})
    }
    if (opened?.id) {
      // 她自己挑出来打开的那一条：from:pick。翻推荐流本身不算「看过」，只有真的打开才算。
      await appendEvent({ type: 'meta', text: lookedLine(`dy_${opened.id}`, 'pick') }, { day, stage, source: 'system' }, root).catch(() => {})
    }

    let text = renderFeed(fresh.length ? fresh : items.slice(0, 1))
    if (opened) {
      text += `\n\n你打开的是第一条：${opened.desc}`
      text += opened.path
        ? `\n画面截了三帧，存在 ${opened.path}——想看就自己用 read_image 读它。`
        : `\n画面没截到（${opened.why}），你只看到上面这些字。`
    }

    return {
      ok: true,
      text,
      note: '',
      picks: fresh.map((it) => ({ bvid: `dy_${it.id}`, title: it.desc, up: it.author, duration: it.duration, view: it.likes })),
    }
  } catch (err) {
    return { ok: false, text: '', note: String(err?.message ?? err).slice(0, 120), picks: [] }
  }
}

function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

/**
 * 注册工具。
 * @param {object} ctx
 * @param {{root?:string, transport?:object, waitMs?:number, tenant?:object}} deps
 */
export function registerDouyinLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'douyin_look',
      description:
        '去抖音翻一眼：不给词就翻推荐流，给一个词就按这个词去找。给的是文案、作者、时长、点赞数。' +
        '想换一样东西看就带 what：热榜、某条下面的评论。' +
        '只读，不点赞不评论。给 open:true 就真打开一条、截三帧把路径给你，你自己 read_image 看；第几条由 index 定（默认第一条）。' +
        '不用它也可以。',
      parameters: toJsonSchema({
        keyword: { type: 'string', required: false, description: '要找什么，一个词就够；不给就翻推荐流。' },
        what: { type: 'string', required: false, description: 'hot=热榜；search=按词找；comments=某条下面的评论；不给就按 keyword 决定。' },
        id: { type: 'string', required: false, description: '看评论时用：那条的视频号或链接。' },
        limit: { type: 'number', required: false, description: '翻几条，默认 6。' },
        open: { type: 'boolean', required: false, description: 'true=真的打开一条，截三帧给你看（会慢十几秒）。' },
        index: { type: 'number', required: false, description: '打开第几条，从 0 数；默认 0（就是列表第一条）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '翻到的几条' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        render: (_args, out) =>
          out.ok
            ? [{ type: 'text', text: `${out.text}\n\n（翻完了。想说就说，不想说也行。）` }]
            : [{ type: 'text', text: `这次没翻到什么：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'douyin_look')
        if (!who.ok) return { ok: false, text: '', note: who.note }

        const { config } = await loadConfig(root)
        const r = await lookFeedOnce({
          root,
          cfg: config,
          limit: args?.limit,
          keyword: args?.keyword,
          what: args?.what,
          id: args?.id,
          open: args?.open === true,
          index: args?.index,
          transport: deps.transport,
          waitMs: deps.waitMs,
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}
