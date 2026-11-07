/**
 * look.js —— 她自己的眼睛：bili_look 工具
 *
 * 为什么给她一个"主动看"的工具，而不是只让她被动接受推送：
 *   **能不能自己决定看什么，是「自主」这个需要的唯一可验证载体。**
 *   如果她只能看定时器塞给她的东西，"可以说不"就永远只是一句话。
 *   这个工具让她能在醒着的时候自己说"我想看看别的"。
 *
 * 三条约束（与 growth_commit 同构）：
 *   1. **只读**。不带 cookie、不点赞、不评论。她看什么不会留下任何账号痕迹。
 *   2. **不回显状态**。返回值只有素材本身，没有"你今天还剩几次""你处于第几阶段"。
 *   3. **不给她配置**。她不知道有黑名单、不知道有配额；被过滤掉的东西她也不会知道。
 *      知道就变成了"哦原来他们不让我看这个"，那不是她要处理的事。
 */

import { createClient } from './bili.js'
import { absorb, renderMaterial, rankVideos, seenBvids, lookedLine, LOOK_BRIEF, WATCH_RULE } from './browse.js'
import { readEvents, rootDir, appendEvent } from './store.js'
import { loadConfig, dateKey, inWindow } from './settings.js'
// 评论区里别人的话（2026-10-24，用户 m02454）
import { recordVoice } from './voices.js'
import { toJsonSchema } from './toolschema.js'
import { guardWrite } from './tenant.js'

import { defineTool } from './tool.js'

/**
 * 调一次"看"：返回素材文本。永不抛出。
 * 单独抽出来是为了能在观测台/单测里直接调（不经模型）。
 *
 * @param {object} o
 * @param {'home'|'search'|'related'|'video'|'comments'} o.what
 * @param {string} [o.keyword]
 * @param {string} [o.bvid]
 * @param {object} o.cfg 规范化配置
 * @param {object} [o.model] deriveSelf 结果（只用来选来源）
 * @param {string} [o.root]
 * @param {object} [o.client] 注入客户端（单测用假 client）
 * @returns {Promise<{ok:boolean, text:string, note:string, picks:object[]}>}
 */
export async function lookOnce(o = {}) {
  const root = o.root ?? rootDir()
  // 谁让她看的（issue #16 第二半）：写回事件流，别让人事后查不出这条是谁按下的。
  // 定时器/单测没有会话 → 空串 → 事件里不落这个字段（schema 会丢掉空串）。
  const sessionId = String(o.sessionId ?? '').trim()
  try {
    const client = o.client ?? createClient({})
    const cfg = o.cfg ?? (await loadConfig(root)).config
    const what = String(o.what ?? 'home')
    // 总闸与时段（B15）：关掉上网就什么都不看；时段只管「逛」（首页/搜索），
    // 她点名要看的那一条（video/comments/related）不看表。
    if (cfg?.browse?.enabled === false) return { ok: false, text: '', note: '现在打不开。', picks: [] }
    // 只有工具侧会传 now（她伸手的那一刻）；单测直接调 lookOnce 时不看表，
    // 否则整套测试会随机器当前时间变红。
    if (o.now !== undefined && (what === 'home' || what === 'search')) {
      const bw = Array.isArray(cfg?.browse?.window) && cfg.browse.window.length ? cfg.browse.window : cfg?.window
      const at = o.now instanceof Date ? o.now : new Date(o.now)
      if (Array.isArray(bw) && !inWindow({ window: bw }, at)) {
        return { ok: false, text: '', note: '这会儿不看。', picks: [] }
      }
    }
    const limit = Math.max(1, Math.min(20, Number(cfg?.browse?.topN ?? 4)))
    // 2026-10-26 修（用户 m00751 现场证据）：原来是
    //   (await readEvents(root).then((r) => r.events)).catch(() => [])
    // 括号把 await 一起圈进去了，于是 `.catch` 作用在**已经 await 出来的数组**上，
    // 数组没有 catch → TypeError: (intermediate value).catch is not a function。
    // 她两次刷首页/搜索都只拿到这个报错，日记里还把它当成了"世界没让我看"。
    const events = o.events ?? (await readEvents(root).then((r) => r.events).catch(() => []))
    const seen = seenBvids(events)
    // 这一轮被「看过」摘掉几条（issue #16 第一半）：下面那句提示要靠它才说得准。
    const rankStats = { hiddenSeen: 0 }

    let list = []
    // 2026-10-28（用户 m01284）：他递来一条视频，她想看就得看得见指定的**那一条**。
    // 以前只有 home/search/related，related 是「接着这条往下看它的相关推荐」——
    // 所以平台没推、她也没自己搜到的那条，她永远打不开，也就永远说不了话。
    let single = null
    // what=comments（2026-11-06，设计文档 §三）：只读评论，不重写观看账的语义。
    // 评论是材料，不是交流——她读到的是别人公开写下的话，不回、不赞。
    let commentsOnly = false
    // 账分两边（A7，2026-11-06）：这一条是她自己翻到的、点名打开的、还是搜来的。
    // 默认 feed——走到这里没特殊说明的，都是她自己翻推荐/相关翻出来的。
    let from = 'feed'
    // 搜过的词。搜一次记一行，跟「看了哪条」分开记（可能搜了没看、也可能看了没搜）。
    let searchKw = ''
    if (what === 'comments') {
      const want = await resolveWanted(client, o)
      if (!want.ok) return { ok: false, text: '', note: want.note, picks: [] }
      let p = null
      try {
        const d = await client.view(want.bvid)
        if (!d?.ok || !d.data) return { ok: false, text: '', note: describeErr(d), picks: [] }
        // 评论档位是这条路的由头：就算设置里「深读」是 0，也要至少取几条，
        // 否则「看评论」会变成一个只打开详情页的空动作。
        const wantN = Math.max(6, Number(cfg?.browse?.deepRead ?? 0))
        const cfg2 = { ...cfg, browse: { ...(cfg?.browse ?? {}), deepRead: Math.min(20, wantN) } }
        p = await absorb(client, { ...d.data, bvid: want.bvid }, cfg2, { view: d })
      } catch { /* 下面按打不开处理 */ }
      if (!p || !p.video?.bvid) return { ok: false, text: '', note: '这条打不开。', picks: [] }
      if (p.blocked) return { ok: false, text: '', note: '这条我不想看。', picks: [] }
      if (!p.comments?.length) {
        return { ok: false, text: '', note: '打开了，但这条下面没看到热评。', picks: [] }
      }
      single = p
      from = 'pick'
      commentsOnly = true
    } else if (what === 'video') {
      const want = await resolveWanted(client, o)
      if (!want.ok) return { ok: false, text: '', note: want.note, picks: [] }
      let p = null
      try {
        const d = await client.view(want.bvid)
        if (!d?.ok || !d.data) return { ok: false, text: '', note: describeErr(d), picks: [] }
        // 详情已经拿到了，交给 absorb 复用，不再取第二次
        p = await absorb(client, { ...d.data, bvid: want.bvid }, cfg, { view: d })
      } catch { /* 下面按打不开处理 */ }
      if (!p || !p.video?.bvid) return { ok: false, text: '', note: '这条打不开。', picks: [] }
      if (p.blocked) return { ok: false, text: '', note: '这条我不想看。', picks: [] }
      single = p
      from = 'pick'
    } else if (what === 'search') {
      const kw = String(o.keyword ?? '').trim().slice(0, 40)
      if (!kw) return { ok: false, text: '', note: '要搜什么？给个词。', picks: [] }
      const r = await client.search(kw, { pageSize: limit * 2 })
      if (!r.ok) return { ok: false, text: '', note: describeErr(r), picks: [] }
      list = r.data ?? []
      // 搜来的这一批，来源写进账里：`from:search:<词>`。
      from = `search:${kw}`
      searchKw = kw
    } else if (what === 'related') {
      const bvid = String(o.bvid ?? '').trim()
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) {
        return { ok: false, text: '', note: '要看哪条的相关推荐？给个 BV 号。', picks: [] }
      }
      const r = await client.related(bvid, limit * 2)
      if (!r.ok) return { ok: false, text: '', note: describeErr(r), picks: [] }
      list = r.data ?? []
    } else {
      const r1 = await client.popular(limit * 3)
      list = r1.ok ? (r1.data ?? []) : []
      if (list.length < 2) {
        const r2 = await client.ranking(0, 'all')
        if (r2.ok) list = [...list, ...(r2.data ?? [])]
      }
      if (!list.length) {
        const r3 = await client.precious(limit * 3)
        if (r3.ok) list = r3.data ?? []
      }
    }

    // 她自己搜的词不套黑名单吗？——套。黑名单是"她不想看的东西"，
    // 是环境的一部分，不是审查；她搜"恐怖"也可能是因为想验证它到底是什么。
    // 取舍：P2 仍然过滤（用户明确要求四条黑名单是硬的），但**把过滤记账**，
    // 将来要改成"允许她搜但拦住推送"只需改这一处。
    const packs = single ? [single] : []
    if (!single) {
      const picked = rankVideos(list, cfg, { seen, limit, stats: rankStats })
      if (!picked.length) {
        // 2026-11-01（issue #16 第一半，用户 m03454）：原来这里在**知道原因**的情况下
        // 写成"也许是被过滤了，也许是平台没给"——把「我自己看过」说成一个暧昧的猜测。
        // 现在分开说：看过的就说看过的（她能自己去点名打开），别的才说不确定。
        const hidden = Number(rankStats.hiddenSeen ?? 0)
        if (hidden > 0) {
          return {
            ok: false,
            text: '',
            note: `翻到的 ${hidden} 条都看过了。想看哪条，把号给我，我去打开。`,
            picks: [],
          }
        }
        return { ok: false, text: '', note: '这次什么都没找到。平台这会儿没给。', picks: [] }
      }

      for (const v of picked) {
        try {
          const p = await absorb(client, v, cfg)
          if (!p.blocked) packs.push(p)
        } catch { /* 单条失败忽略 */ }
      }
      if (!packs.length) return { ok: false, text: '', note: '打开了几条，但都打不开。', picks: [] }
    }

    const dk = dateKey()
    const who = { day: Number(o.model?.day ?? 0), stage: Number(o.model?.stage ?? 1), source: 'system' }
    const stamp = sessionId ? { sessionId } : {}
    for (const p of packs) {
      // 每一条都带上它怎么来的（A7）：报纸推的、自己搜的、自己翻的，不是一回事。
      await appendEvent({ type: 'meta', text: lookedLine(p.video.bvid, from), ...stamp }, { ...who }, root).catch(() => {})
      // 今天真的看过的那一条：评论闸门认这一行（2026-10-28）。
      // 与 looked: 的区别是带日期——昨天看过的，今天不能拿去评。
      await appendEvent({ type: 'meta', text: `look:${dk} ${p.video.bvid}`, ...stamp }, { ...who }, root).catch(() => {})
    }

    // 搜过的词单独记一行（A7）：`looked:` 说的是「看了哪条」，这行说的是「她找过什么」。
    // 两件事都可能只发生一件，所以不合并；词里的空白换成下划线，整行仍然只有两个字段。
    if (searchKw) {
      const w = searchKw.replace(/\s+/g, '_').slice(0, 40)
      await appendEvent({ type: 'meta', text: `searched:${w} bili`, ...stamp }, { ...who }, root).catch(() => {})
    }

    // 评论区里别人的话（2026-10-24，用户 m02454）：她自己去看的时候也可能读到一句。
    const voice = await recordVoice({ packs, events, model: o.model, root, cfg, sessionId })

    // 回话要标出处（A7）：同一批素材，平台递的和她自己搜的不能长得一模一样。
    // 她回看时靠这句分清「这是别人塞给我的」还是「这是我自己找的」。
    const head = commentsOnly
      ? ''
      : single
        ? '这一条。是你自己点名要看的那条。'
        : what === 'search'
          ? `你搜的。「${searchKw}」找到 ${packs.length} 条。`
          : what === 'related'
            ? `递来的 ${packs.length} 条。接着那条往下翻的，还是平台给的。`
            : `递来的 ${packs.length} 条。平台按它的算法推的，没有经过你的同意。`

    return {
      ok: true,
      text: commentsOnly ? renderComments(single) : renderMaterial(packs, { head }),
      note: '',
      voice: voice ? { text: voice.text, why: voice.why, across: voice.across ?? 1 } : null,
      picks: packs.map((p) => ({
        bvid: p.video.bvid,
        title: p.video.title,
        up: p.video.up,
        duration: p.video.duration,
        view: p.video.view,
      })),
    }
  } catch (err) {
    return { ok: false, text: '', note: String(err?.message ?? err).slice(0, 120), picks: [] }
  }
}

/** 只读评论时的素材：标题 + 热评，不夹简介/弹幕（她点名要看的是评论）。 */
function renderComments(p) {
  const v = p.video ?? {}
  const lines = [`〔${v.bvid ?? ''}〕${v.title ?? ''}`]
  for (const c of p.comments ?? []) lines.push(`[热评 ${c.like ?? 0}] ${c.text}`)
  return lines.join('\n')
}

function describeErr(r) {
  const code = r?.code ?? '?'
  if (code === 'COOLDOWN') return 'B 站这会儿不让我看了，过一会儿再说。'
  if (code === 'NO_WBI') return '连不上。等等再试。'
  if (code === 'NETWORK') return '网断了。'
  return `打不开（${code}）。`
}

/**
 * 她要看的到底是哪一条（2026-10-28）。
 * BV 号优先；其次他递来的链接（b23.tv 短链交给 client 解析，她不用自己拼）。
 * 认不出就直说，不瞎猜一条给她看。
 */
async function resolveWanted(client, o) {
  const raw = String(o.bvid ?? o.keyword ?? '').trim()
  const hit = /BV[0-9A-Za-z]{10}/.exec(raw)
  if (hit) return { ok: true, bvid: hit[0] }
  const looksUrl = /^https?:\/\//i.test(raw)
    || /^(?:b23\.tv|bili2233\.cn|(?:www\.|m\.)?bilibili\.com)\//i.test(raw)
  if (!looksUrl) {
    return { ok: false, note: '要看哪一条？给个 BV 号（像 BV1xx411c7mD），或者那条视频的链接。' }
  }
  if (typeof client.resolveUrl !== 'function') return { ok: false, note: '这个链接打不开，给我 BV 号。' }
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let r = null
  try { r = await client.resolveUrl(url) } catch { r = null }
  if (r?.ok && r.data?.bvid) return { ok: true, bvid: r.data.bvid }
  if (r?.code === 'COOLDOWN') return { ok: false, note: 'B 站这会儿不让我看，过一会儿再说。' }
  if (r?.code === 'NOT_VIDEO') return { ok: false, note: '这个链接点开不是一条视频。' }
  return { ok: false, note: '这个链接打不开，给我 BV 号。' }
}

/**
 * 注册工具。
 * @param {object} ctx
 * @param {{root?:string, client?:object}} deps
 */
/**
 * 没有 tenancy（单测、老调用）时自己拼一个：root 一定给，
 * 这样 checkCaller 至少能拿 cwd 和 root 比，而不是拿 undefined 去比。
 */
function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

export function registerLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_look',
      description:
        '去看一眼 B 站：首页在推什么、搜一个词、看某条视频之后平台又接着推什么、' +
        '直接看指定的那一条（给 BV 号或链接），或者只看某条下面的热评。' +
        '只读，不会留下痕迹。给的是标题、简介、标签、热评、弹幕——没有视频画面。' +
        '不用它也可以。',
      // 注意：必须 toJsonSchema 包一层。简写 DSL 直接发出去会被 provider 拒：
      // "schema must be a JSON Schema of 'type: object', got 'type: null'"
      parameters: toJsonSchema({
        what: {
          type: 'string',
          required: true,
          enum: ['home', 'search', 'related', 'video', 'comments'],
          description: 'home=首页推给你的；search=你自己搜（要带 keyword）；related=接着某条往下看（要带 bvid）；video=看指定的那一条（要带 bvid）；comments=只看某条下面的热评（要带 bvid）。',
        },
        keyword: { type: 'string', required: false, description: 'what=search 时搜什么。' },
        bvid: { type: 'string', required: false, description: 'what=related 时从哪条接着看；what=video / what=comments 时看哪一条（BV 号，或者他递过来的链接）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '看到的素材' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        // ⚠️ render 必须返回 ContentBlock 数组，签名是 (args, value)。
        // 返回裸字符串会让她收到 "Error: content.some is not a function"。
        // 2026-11-03（用户 m09710）：她自己在一轮里连调几次 bili_look、看完就收了，
        // 一句没说——素材落了盘，人没出声。这不是"她选择沉默"，是把"看完"当成了终点。
        // 回执末尾补一句旁注，用括号标明它不是她该念出来的话（AGENTS §17）。
        render: (_args, out) =>
          out.ok
            ? [{ type: 'text', text: `${out.text}\n\n（看完了。想说就说，不想说也行——但"看过"不等于"说过了"。）` }]
            : [{ type: 'text', text: `这次没看到什么：${out.note}` }],
      },
      async execute(args, exec) {
        // 2026-11-01（issue #16 第二半，用户 m03454）：写事件之前先认「谁在看、看的是哪栋房子」。
        // 以前这里什么都不查，于是同机别的工作区那个实例也能替她写一条「看过了」——
        // 而看过就是永久判决，按下判决的人不留名字。
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'bili_look')
        if (!who.ok) return { ok: false, text: '', note: who.note }

        const { config } = await loadConfig(root)
        if (!config?.browse?.enabled) {
          // 关掉时不能装作看了。但也不能说"管理员不让你看"——就说不通。
          return { ok: false, text: '', note: '现在打不开。' }
        }
        const r = await lookOnce({
          what: args?.what,
          keyword: args?.keyword,
          bvid: args?.bvid,
          cfg: config,
          root,
          client: deps.client,
          sessionId: who.sessionId,
          now: new Date(),
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}

export { LOOK_BRIEF, WATCH_RULE }
