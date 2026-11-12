/**
 * router.js —— 渠道消息的另一半：从「收到一句」到「她回了一句」
 *
 * 这条链路上有五步，每一步都可能出错，所以每一步都只做一件事：
 *
 *   收（适配器） → 记（事件流 + 流水） → 判（gate） → 问（叫醒她） → 发（适配器）
 *
 * 三个设计上必须守住的点：
 *
 * 1. **一次只问她一句。** 群里可能同时三个人说话。并发叫醒她，她会在同一个会话里
 *    同时开好几轮，回复互相串台，而且宿主的会话队列本来也是串行的。
 *    所以这里有一条进程内的队列：满了就丢新的（丢的那条已经在事件流里，她以后翻得到），
 *    不排队等——等下去只会越积越旧。
 *
 * 2. **空回合是合法的。** 她可以一句话不说。这不是失败，是她拒绝。
 *    调用方（观测台）看到的是 `{ sent:false, why:'silent' }`，不是错误。
 *
 * 3. **出门三道闸，顺序不能反。**
 *    先 `screenOutgoing`（凭据/路径/手机号），再 `looksLikePrivateLeak`（别人的私事），
 *    最后才交给渠道。反过来的话，被拦下的句子已经在对方手机上了。
 */

import { appendEvent, readEvents } from '../store.js'
import { sanitizeForeign, looksLikeRewriting, screenOutgoing, stripPromptEcho, stripScaffold } from '../guard.js'
import { buildIndex, looksLikePrivateLeak } from '../leakcheck.js'
import { knowledgeBlock } from '../worldbook.js'
import { bumpTurns, homeStatus, rotateTalkSession } from '../home.js'
import { refreshSelfDoc } from '../selfdoc.js'
import { beginExternalTurn, endExternalTurn } from '../extturn.js'
import { describeAweme, findDouyinLinks, lookDouyin } from '../dylink.js'
import { lookedLine } from '../browse.js'
import { canReply, explain } from './gate.js'
import { isOwnerMessage } from './auth.js'
import { tsMs } from '../schema.js'
import { rememberImpression } from '../impression.js'
import { logLine } from '../log.js'

/** 队列上限：超过就丢新的。已经在事件流里的东西，她以后翻得到。 */
export const QUEUE_MAX = 5
/** 等她一轮最多等多久。超时不发，也不重试——重试等于让她把同一句话说两遍。 */
export const TURN_TIMEOUT_MS = 120000
/** 拼进提示词的流水句数。 */
export const CONTEXT_LINES = 8
/** 社会层开闸后，最多带几条「外面见过的做法」进提示词。多了就成清单了。 */
export const SOCIAL_LINES = 5
/**
 * 一轮只吐出模型标记时的再问一句。
 * 2026-11-07 真机：她在 her_note 成功之后，第二步只吐了
 * `</｜｜DSML｜｜ invoke>` 与 `</｜｜DSML｜｜ calls>`，没有一个字的正文。
 * guard 按设计把它清成空，渠道层于是当成「她选择不说话」——那头就再也等不到回音。
 * 这不是沉默，是话没说出来；只再问一次，第二次还是空就按沉默算。
 */
const SCAFFOLD_RETRY_TEXT = '（刚才那一步只输出了模型标记，没有话。把刚才想说的直接说出来，不要输出任何标记。）'
/**
 * 合批窗口（2026-11-06，设计文档渠道节）：同一会话里连着的几句先攒 10 秒。
 * 群里三个人先后说了三句，她不该被叫醒三次、回三遍。
 */
export const BATCH_WINDOW_MS = 10_000
/** 每个群在内存里留多少条「没被叫到」的背景。只在她被叫醒时用，重启即空。 */
export const BACKGROUND_PER_GROUP = 20
/** 背景里一句话最多留多少字。太长会把她的一轮上下文吃掉。 */
export const BACKGROUND_TEXT_MAX = 300
/** 配额计数留多少条。够判断「一分钟 30 条」「一天 20 条」就行。 */
export const RECENT_REPLIES_MAX = 200

/** 自动静默的出场点：第二天早上 08:00（本地时间）。 */
const MORNING_HOUR = 8

/**
 * 她说的是不是「要去睡了」——只认第一人称（2026-11-06，设计 §渠道内部默认）。
 * 不做语义理解：晚安 / 我睡了 / 我去睡了 / 我先睡啦 / 我要睡觉。
 * 「你睡吧」「该睡了」是催别人，不算。
 */
export function isGoodnight(text) {
  const s = String(text ?? '')
  if (/晚安/.test(s)) return true
  return /我(先|去|要|该)?睡(了|啦|觉)/.test(s)
}

/** 从这一刻起，下一个早上 08:00 是哪一刻（本地时区）。 */
export function nextMorning(ms) {
  const d = new Date(ms)
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), MORNING_HOUR, 0, 0, 0)
  if (out.getTime() <= ms) out.setDate(out.getDate() + 1)
  return out.getTime()
}

/**
 * 她现在是不是「说过晚安、还没到出场点」。只看最后一条 utterance：
 *   · 最后一条是她说的晚安 → 静默到次日 08:00；
 *   · 之后她主动说过任何一句（her_say 会写 utterance）→ 静默自动解除；
 *   · 过了 08:00 → 解除。
 * 返回 0 表示没在静默。
 */
export function silentUntil(events, nowMs) {
  let last = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'utterance') { last = events[i]; break }
  }
  if (!last || !isGoodnight(last.text)) return 0
  const at = tsMs(last)
  if (!at) return 0
  const until = nextMorning(at)
  return until > nowMs ? until : 0
}


const CHANNEL_LABEL = { qq: 'QQ', bili: 'B站', douyin: '抖音', dsh: '这边' }

/**
 * 从宿主的 `assistant/message` 里取她说出口的话。
 * 与 `turns.js` 的 `assistantText` 同源，但这里只留一段最薄的实现——
 * 两个模块各自演化时不会因为改一处而互相踩。
 */
function saidText(data) {
  const blocks = data?.message?.content ?? data?.content
  let raw = ''
  if (typeof blocks === 'string') raw = blocks
  else if (Array.isArray(blocks)) {
    raw = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
      .map((b) => b.text.trim())
      .join('\n')
  } else if (typeof data?.text === 'string') raw = data.text
  const text = stripScaffold(stripPromptEcho(raw))
  return { text, scaffoldOnly: Boolean(String(raw ?? '').trim()) && !text }
}

/**
 * 拼她看到的那段话。
 *
 * 原则：只给**处境**，不给台词。
 *   ✅ 「QQ 群「XX」里，Lily 在说：……」
 *   ❌ 「你是一个 QQ 群里的猫娘，请回复……」
 * 前者是事实，后者是角色扮演——后者一出现，这个项目就变回普通的聊天机器人了。
 *
 * @param {object} msg 规范化后的消息
 * @param {Array<{role:string,text:string}>} lines 这个会话最近的流水
 * @param {{isOwner:boolean, impression?:string}} opts
 * @returns {string}
 */
export function buildPrompt(msg, lines = [], opts = {}) {
  const label = CHANNEL_LABEL[msg.channel] ?? msg.channel
  const where =
    msg.kind === 'group'
      ? `${label} 的群「${msg.conversationName || msg.conversationId}」`
      : `${label} 上，跟一个人单独说话`
  const who = String(msg.personName || '').trim() || '一个没写名字的人'
  const out = []

  out.push(
    opts.isOwner
      ? `（${where}。是他本人。）`
      : `（${where}。说话的是 ${who}。${opts.impression ? `你对他有印象：${opts.impression}` : '你对他没什么印象。'}）`,
  )

  // 场合（2026-11-04，用户 m11031）：跟别人说话时，她老把自己的心理话摊在台面上，出戏。
  // 对主人可以，对陌生人不必——群里更不必。只说眼前这件事。
  // 2026-11-04 用户 m11046 真机打回：群里主人 @ 她，她照样把心里话摊开——
  // 判据看错了，用的"跟谁说话"，该看的是"在什么地方说话"。群里就是有人旁听。
  // 私下（2026-11-04，用户 m11113）：0.1.50 那句「别把想法摊开」被她推到了私聊里，人也跟着变干。
  // 私下该有想法：怎么想就怎么说，只是仍然不交代推理过程。
  if (opts.isOwner && msg.kind !== 'group') {
    out.push('（私下说话：你怎么看就怎么说。直接说，不用交代你怎么处理这件事。）')
  }
  if (!opts.isOwner || msg.kind === 'group') {
    out.push('（这里不是只有你和他：只回答问的那件事，说眼前这件事就行，不用交代你怎么想、为什么这么说。）')
  }

  const tail = lines.slice(-CONTEXT_LINES)
  if (tail.length) {
    out.push('')
    out.push('（前面几句：')
    for (const l of tail) out.push(`${l.role === 'her' ? '你' : who}：${l.text}`)
    out.push('）')
  }

  // 背景（2026-11-06，设计文档渠道节）：群里没点她的名的话只活在内存里，
  // 她被叫醒时作为「刚才旁边有人在说这些」给她看。这些不是对她说的，
  // 她可以不理——不写「你应该接哪句」，那是替她决定。
  const background = Array.isArray(opts.background) ? opts.background : []
  if (background.length && msg.kind === 'group') {
    out.push('')
    out.push('（群里刚才还有人说话：')
    for (const b of background.slice(-BACKGROUND_PER_GROUP)) {
      const name = String(b?.name ?? '').trim() || '一个人'
      const text = String(b?.text ?? '').trim()
      if (text) out.push(`${name}：${text}`)
    }
    out.push('这些不是对你说的。）')
  }

  // 世界书（2026-11-02）：只加事实，不加要求。
  // 这一节来自 worldbook.json，是「你知道的事」，不是「你是谁」——后者只能长出来。
  const knowledge = knowledgeBlock(opts.knowledge)
  if (knowledge) out.push(knowledge)

  // 社会层（2026-11-02）：开闸之后，她在外面见过的做法也会出现在这里。
  // 写的是「见过的做法」，不是「你应该」——这一层永远不是命令，也不是身份。
  const social = Array.isArray(opts.social) ? opts.social.slice(-SOCIAL_LINES) : []
  if (social.length) {
    out.push('')
    out.push(`（在外面见过的做法：${social.map((b) => String(b?.text ?? b)).join('；')}）`)
  }

  // 她点开看过的东西（2026-11-03）：抖音链接解析出来的真实文案与数据。
  // 只写事实，不写「你应该评价一下」——评价不评价是她的事。
  const video = String(opts.video ?? '').trim()
  if (video) {
    out.push('')
    out.push(video)
  }

  // 断线账（2026-11-06，设计 §三）：放在最后一句正前方，离她最近。
  // 2026-11-07 真机：这句原来在提示词最上面，她收到了「断了 47 秒」却没接——
  // 前面隔着历史与设定，被淹了。仍然只是事实，不写成"你要先说这个"。
  if (opts.offline) out.push(`（${opts.offline}。）`)

  out.push('')
  out.push(`${who}：${msg.text || (msg.images?.length ? '（只发了图，没写字）' : '（没有文字）')}`)
  out.push('')
  // 说的是「这里可以不说话」，不是「你要温柔一点」——前者是处境，后者是人格。
  out.push('（回不回、说几句，你自己定。不想接就什么都不用说。）')
  return out.join('\n')
}

/**
 * 建一个渠道路由器。
 *
 * @param {object} deps
 * @param {object} deps.ctx            宿主 ctx（要有 on 与 sessionController）
 * @param {string} deps.root           数据目录
 * @param {(...a:any[])=>void} [deps.log]
 * @param {object} deps.journal        createJournal 的返回值
 * @param {object} deps.people         createPeople 的返回值
 * @param {Map<string,object>} deps.adapters 渠道名 → 适配器
 * @param {()=>Promise<object>} deps.getConfig 现读配置（别缓存：用户改完要立刻生效）
 * @param {()=>Promise<{sessionId:string, stage:number}>} deps.getState 她住哪、第几阶段
 * @param {()=>Promise<Array<{text:string}>>} [deps.socialBeliefs] 社会层开闸后她在外面学到的做法
 */
export function createRouter(deps = {}) {
  const { ctx, root, journal, people, adapters, worldbook, socialBeliefs } = deps
  /**
   * 每个渠道上「他本人」的账号 id。渠道适配器只给原始 id，认不认得主人是这里的事。
   * 可以给对象（测试里固定一份），也可以给函数（宿主每来一条现读配置，
   * 用户在设置页填完就生效，不用重启）。
   */
  const ownerIdsOf = typeof deps.ownerIds === 'function'
    ? deps.ownerIds
    : async () => deps.ownerIds ?? {}
  const log = deps.log ?? (() => {})
  const getConfig = deps.getConfig ?? (async () => ({}))
  const getState = deps.getState ?? (async () => ({ sessionId: '', stage: 1 }))
  const now = deps.now ?? (() => Date.now())

  const queue = []
  let busy = false
  let stopped = false
  let offBus = null
  /** 正在等她的那一轮：{ sessionId, texts:[], sayIds:Set, done:Promise } */
  let pending = null
  /** 每个会话上一条回复的时间（冷却用）。 */
  const lastReplyAt = new Map()
  /** 渠道最近的回复（配额用）：{at, kind, conversationId}。 */
  const recentReplies = []
  /** 合批缓冲：会话 key → { msgs, timer }。 */
  const batches = new Map()
  /** 背景环：群号 → [{name, text}]，只存内存。 */
  const background = new Map()
  /** 每个渠道最近一次念过的断线时间：同一段断线只念一次（2026-11-06）。 */
  const gapSeen = new Map()

  /**
   * 这个渠道刚断过、还没跟她说过吗？说是事实，不带安慰也不带要求。
   * 只念一次：同一次断线，她下一句知道就够了，不用每句都提。
   */
  function offlineNote(channel) {
    const adapter = typeof adapters?.get === 'function' ? adapters.get(channel) : null
    let st = null
    try { st = adapter?.status?.() ?? null } catch { return '' }
    const at = Number(st?.lastGapAt ?? 0)
    const ms = Number(st?.lastGapMs ?? 0)
    if (!(at > 0) || at <= (gapSeen.get(channel) ?? 0)) return ''
    gapSeen.set(channel, at)
    if (!(ms > 0)) return '刚才这边断了一下'
    return `刚才这边断了一下，断了 ${Math.max(1, Math.round(ms / 1000))} 秒`
  }
  const setTimer = deps.setTimeout ?? setTimeout
  const clearTimer = deps.clearTimeout ?? clearTimeout
  // 0 表示不合批。测试里传 0 或自己 tick。
  const batchWindowMs = Math.max(0, Number(deps.batchWindowMs ?? BATCH_WINDOW_MS) || 0)
  /** 私聊指纹索引：只在事件流变了之后重建一次。 */
  let leakIndex = null
  let leakIndexAt = 0

  async function stateOf() {
    try {
      const s = await getState()
      return { sessionId: String(s?.sessionId ?? ''), stage: Number(s?.stage) || 1 }
    } catch {
      return { sessionId: '', stage: 1 }
    }
  }

  async function indexOf(events) {
    // 事件流是追加式的：只要长度没变，索引就还能用。
    if (leakIndex && leakIndexAt === events.length) return leakIndex
    leakIndex = buildIndex(events)
    leakIndexAt = events.length
    return leakIndex
  }

  /** 记一条「她听见了」。这是系统侧写的，她自己写不出来。 */
  /**
   * 他的话里带了抖音链接？替她去看一眼。
   * 返回能拼进提示词的那一行；没链接、或没打开，返回空串。
   * 拿不到就照实写「没拉到」，绝不替那四个字编内容。
   */
  async function lookAtLinks(msg, text, isOwner) {
    const links = findDouyinLinks(text)
    if (!links.length) return ''
    // 借哪个浏览器：登录态在抖音那个渠道里，跟消息从哪个渠道来无关——
    // QQ 群里递来的抖音链接，也得用抖音那个已登录的浏览器去看。
    const pick = (n) => (typeof adapters?.get === 'function' ? adapters.get(n) : null)
    const adapter = typeof pick('douyin')?.api === 'function' ? pick('douyin') : pick(msg.channel)
    const api = typeof adapter?.api === 'function' ? (p) => adapter.api(p) : undefined
    const out = []
    for (const l of links) {
      const r = await lookDouyin(l.url, { api, root }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))
      if (!r?.ok) {
        log(`router · 抖音链接没打开（${l.url}）：${r?.why ?? '未知'}`)
        // 打不开也要让她知道「他递了一样东西过来，但我没打开」——
        // 装没看见，比说「打不开」更糟。
        out.push('（他递给你一条抖音链接，但这边的浏览器没打开它。别猜里面是什么。）')
        continue
      }
      // 画面抽到了也只是**存成一张图**，这一轮对话里没有图片通道——不能写「你看了三帧」，
      // 那是句假话，她说完就会被问「画面里是什么」，只能说不知道（2026-11-03 真机踩过：
      // 她以为没看到，还去拿 bili_watch 试了一次）。
      // 但图是存在的，她手上有 read_image：把路径给她，让她自己决定看不看、看完说什么。
      out.push(
        `（他递给你一条抖音：${describeAweme(r.item)}${r.frames?.ok
          ? `；画面截了三帧，存在 ${r.frames.path}——想看就自己用 read_image 读它，不想看也可以不看`
          : '；画面没拉到，只看到文字'}）`,
      )
      // 画面没拉到要留一行日志：她自己只会说「画面没进来」，运维得知道是没 ffmpeg、
      // 视频太大，还是 CDN 拒了（2026-11-03 真机就是不带 Referer 被 403）。
      if (!r.frames?.ok) log(`router · 抖音画面没拉到（${r.id}）：${r.frames?.why ?? '未知'}`)
      try {
        const { events } = await readEvents(root)
        const last = events[events.length - 1]
        await appendEvent(
          // 这条是**他从外面递进来**的，不是平台推的：from:hand（A7）。
          { type: 'meta', text: lookedLine(`dy_${r.id}`, 'hand') },
          { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
          root,
        )
      } catch { /* 记账失败不影响这一轮 */ }
    }
    return out.join('\n')
  }

  async function recordHeard(msg, text, isOwner = false) {
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      await appendEvent(
        {
          type: 'heard',
          text: `${msg.personName || msg.personId}：${text}`,
          person: msg.personId,
          visibility: msg.kind === 'group' ? 'public' : 'private',
          channel: msg.channel,
          origin: isOwner ? 'owner' : 'guest',
          // 陌生人说的话一开始只能算「社会层」：它教她怎么处世，不定义她是谁。
          // 主人说的话是立宪层——同一个人在私信里说同一句话，分量不该看渠道。
          influence: isOwner ? 'constitution' : 'social',
        },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch (err) {
      log('router · 记 heard 失败', err?.message ?? err)
    }
  }

  /** 记一条她自己说出去的。 */
  async function recordSaid(msg, text, isOwner) {
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      await appendEvent(
        {
          type: 'utterance',
          text,
          person: msg.personId,
          visibility: msg.kind === 'group' ? 'public' : 'private',
          channel: msg.channel,
          origin: 'self',
          influence: isOwner ? 'constitution' : 'social',
        },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch (err) {
      log('router · 记 utterance 失败', err?.message ?? err)
    }
  }

  /**
   * 结账一轮（2026-11-03，真机撞上下文上限之后补的）。
   *
   * 渠道这边每回完一句就 bumpTurns；到 `chat.rotateAfter` 就换一间会话。
   * 为什么必须有：宿主那条会话是**共享**的——GUI 里说的、QQ 里说的、B 站私信里说的
   * 都堆在同一条上下文里，而宿主只在「新会话」时才清。以前只有 GUI 那条路结账，
   * 渠道一侧永远不涨 turns，于是一条会话可以攒到 47k token、把本地模型的 32k 撑爆。
   *
   * 边界：读配置失败、换会话失败都只记一行，不影响这句已经发出去的话。
   * @returns {Promise<{rotated:boolean, turns:number, after:number}>} 永不抛。
   */
  async function turnOver() {
    const cfg = await getConfig().catch(() => null)
    const after = Number(cfg?.config?.chat?.rotateAfter ?? cfg?.chat?.rotateAfter ?? 0) || 0
    const turns = await bumpTurns(root).catch(() => 0)
    if (!after || turns < after) return { rotated: false, turns, after }
    const st = await homeStatus(root).catch(() => null)
    const wsId = String(st?.wsId ?? '').trim()
    if (!wsId) return { rotated: false, turns, after }
    const r = await rotateTalkSession(ctx, { root, wsId, log }).catch(() => ({ ok: false }))
    if (!r?.ok) {
      log(`轮换没成（第 ${turns} 轮）：${r?.why ?? '未知'}`)
      return { rotated: false, turns, after, why: r?.why ?? '' }
    }
    try {
      const { events } = await readEvents(root)
      const last = events[events.length - 1]
      await appendEvent(
        { type: 'meta', text: `rotate:${new Date().toISOString()} ${r.sessionId}` },
        { day: Number(last?.day ?? 1) || 1, stage: Number(last?.stage ?? 1) || 1, source: 'system' },
        root,
      )
    } catch {
      /* 记账失败不影响换会话这件事本身 */
    }
    await refreshSelfDoc(root).catch(() => {})
    log(`会话攒到 ${turns} 轮，换了一间（${r.sessionId}）`)
    return { rotated: true, turns, after, sessionId: r.sessionId }
  }

  /**
   * 叫醒她，等她把这一轮说完。
   * @returns {Promise<{ok:boolean, text:string, why:string}>}
   */
  async function askHer(sessionId, prompt) {
    const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
    if (!sc?.prompt) return { ok: false, text: '', why: 'no-session-controller' }

    const reached = { sessionId, texts: [], sayIds: new Set(), scaffoldOnly: false }
    pending = reached
    const done = new Promise((resolve) => {
      reached.resolve = resolve
      reached.timer = setTimeout(() => resolve('timeout'), TURN_TIMEOUT_MS)
      reached.timer.unref?.()
    })
    try {
      // signal 必须给：宿主 `prompt()` 第一句就 `signal.throwIfAborted()`（issue #1）。
      await sc
        .prompt(
          {
            requestId: `chan-${now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: prompt }],
          },
          new AbortController().signal,
        )
        .catch((err) => {
          log('router · 叫醒失败', err?.message ?? err)
          reached.resolve('error')
        })
      const why = await done
      const text = reached.texts.join('\n').trim()
      if (why === 'timeout') return { ok: false, text, why: 'timeout' }
      if (why === 'error') return { ok: false, text, why: 'prompt-failed' }
      if (!text && reached.scaffoldOnly) return { ok: true, text: '', why: 'scaffold' }
      return { ok: true, text, why: '' }
    } finally {
      clearTimeout(reached.timer)
      if (pending === reached) pending = null
    }
  }

  /** 背景环：群里没点她的话，只活在内存里。重启即空——那本来就不是她的记忆。 */
  function pushBackground(msg, text) {
    const id = String(msg.conversationId ?? '')
    if (id === '') return
    const list = background.get(id) ?? []
    list.push({
      name: String(msg.personName || msg.personId || '').trim(),
      text: String(text ?? '').slice(0, BACKGROUND_TEXT_MAX),
    })
    if (list.length > BACKGROUND_PER_GROUP) list.splice(0, list.length - BACKGROUND_PER_GROUP)
    background.set(id, list)
  }

  /** 把同一个人连着说的几句合成一条。 */
  function mergeParts(parts) {
    const last = parts[parts.length - 1]
    const texts = parts.map((p) => String(p.text ?? '').trim()).filter(Boolean)
    const images = parts.flatMap((p) => (Array.isArray(p.images) ? p.images : [])).slice(0, 4)
    const attachment = [...parts].reverse().map((p) => p.attachment).find((a) => a && a.type)
    const merged = {
      ...last,
      text: texts.join('\n'),
      images,
      mentionedSelf: parts.some((p) => p.mentionedSelf === true),
      replyToSelf: parts.some((p) => p.replyToSelf === true),
      parts,
    }
    if (attachment) merged.attachment = attachment
    return merged
  }

  /** 窗口到了：按发送者切连续段，每段合成一条，排进队列。 */
  function flushBatch(key) {
    const b = batches.get(key)
    if (!b) return 0
    batches.delete(key)
    if (b.timer) clearTimer(b.timer)
    const merged = []
    let seg = []
    for (const m of b.msgs) {
      if (seg.length && String(m.personId ?? '') !== String(seg[0].personId ?? '')) {
        merged.push(mergeParts(seg))
        seg = []
      }
      seg.push(m)
    }
    if (seg.length) merged.push(mergeParts(seg))
    let n = 0
    for (const m of merged) {
      if (queue.length >= QUEUE_MAX) break
      queue.push(m)
      n++
    }
    if (n) void drain()
    return n
  }

  /** 测试与 stop 用：立刻把所有缓冲倒进队列。 */
  function flushBatches() {
    for (const key of [...batches.keys()]) flushBatch(key)
  }

  /** 处理一条进来的消息。 */
  async function handleOne(msg) {
    const raw = String(msg.text ?? '').trim()
    const images = Array.isArray(msg.images) ? msg.images.slice(0, 4) : []
    if (!raw && !images.length) return { sent: false, why: 'empty' }

    // 想改她的人：这句话她**根本没见过**。不是劝她别听，是不递。
    if (raw && looksLikeRewriting(raw).hit) {
      log(`router · 拦下一条重塑尝试（${msg.channel}/${msg.personId}）`)
      return { sent: false, why: 'rewrite-blocked' }
    }
    const clean = raw ? sanitizeForeign(raw).text : ''

    const config = await getConfig().catch(() => ({}))
    const owners = await ownerIdsOf().catch(() => ({}))
    const isOwner = isOwnerMessage(msg, owners)
    const st = await stateOf()
    const key = `${msg.channel}:${msg.kind}:${msg.conversationId}`
    const verdict = canReply({
      channel: msg.channel,
      kind: msg.kind,
      conversationId: msg.conversationId,
      mentioned: msg.mentionedSelf === true,
      replyToSelf: msg.replyToSelf === true,
      isAdmin: msg.isAdmin === true,
      isOwner,
      stage: st.stage,
      config,
      lastReplyAt: lastReplyAt.get(key) ?? 0,
      recentReplies,
      now: now(),
    })

    // 名单外的群：她把这句话留在**流水**里（回头能看见那一带在说什么），但不记成「听见」。
    // 没听见的事不能长到她身上——这就是白名单挡的是「长」，不只是「说」。
    if (verdict.why === 'group-not-allowed' || verdict.why === 'channel-off') {
      await journal
        ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
        .catch(() => {})
      log(`router · 没听（${msg.channel}/${msg.personId}）：${explain(verdict.why) || verdict.why}`)
      return { sent: false, why: verdict.why }
    }

    // 群里没点她的话（没 @、没回复她）：不进 heard，不建「认得的人」，
    // 只放在内存背景环里。她被叫醒时能看到「刚才旁边有人在说这些」，
    // 但那不是对她的，不能长成她的经历（设计文档渠道节 ②③）。
    if (msg.kind === 'group' && msg.mentionedSelf !== true && msg.replyToSelf !== true) {
      pushBackground(msg, clean)
      await journal
        ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
        .catch(() => {})
      log(`router · 只留背景（${msg.channel}/${msg.personId}）：${explain(verdict.why) || '没有点名'}`)
      return { sent: false, why: 'background' }
    }

    // 自动静默（2026-11-06，设计 §渠道内部默认）：她说过晚安之后，群里不再插话，
    // 直到次日 08:00 或她自己又开口（her_say 会写一条 utterance，这里就解除了）。
    // 私聊不静默：主人还能把她叫起来。没听见的话不记 heard——睡着就是睡着。
    if (verdict.ok && msg.kind === 'group') {
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const until = silentUntil(events, now())
      if (until > 0) {
        await journal
          ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
          .catch(() => {})
        log(`router · 她说过晚安，先不叫（到 ${new Date(until).toLocaleString()}，或她自己开口）`)
        return { sent: false, why: 'auto-silent' }
      }
    }

    // 先记账：不管回不回，她「听见了」这件事都发生过。
    await recordHeard(msg, clean || '（图）', isOwner)
    await journal
      ?.append({ role: 'me', text: clean || '（图）', at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
      .catch(() => {})
    await people
      ?.upsert(msg.personId, { name: msg.personName, channel: msg.channel, now: now() })
      .catch(() => {})

    if (!verdict.ok) {
      log(`router · 不接（${msg.channel}/${msg.personId}）：${explain(verdict.why) || verdict.why}`)
      return { sent: false, why: verdict.why }
    }
    // A4（2026-11-07）：她接了这个人的话，才重写对他的印象（每 N 句或换一天一次）。
    // 被 gate 挡下的、群里没点她的，都不塑造印象——那些不算「跟她说过话」。
    // 永不抛：印象丢了只是下次重算，不能把这一轮回复拖垮。
    await rememberImpression(people, { ...msg, text: clean || '（图）' }, now()).catch(() => {})
    if (!st.sessionId) return { sent: false, why: 'no-session' }

    // 一条抖音链接递过来时，替她真去看一眼：解析短链 → 问详情 → 能下到视频就抽三帧。
    // 拿不到就照实说拿不到——「分享图文」那四个字不许被补全成想象出来的内容。
    const video = await lookAtLinks(msg, clean, isOwner)

    const lines = (await journal?.recent({ channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId }, CONTEXT_LINES + 1).catch(() => [])) ?? []
    // 最后一行就是刚记进去的这句，别在提示词里说两遍。
    if (lines.length && lines.at(-1).role === 'me' && lines.at(-1).text === (clean || '（图）')) lines.pop()
    const person = await people?.get(msg.personId).catch(() => null)
    // 她手上那本册子里有没有跟这段话对得上的设定：有就带着，没有就不提。
    const knowledge = worldbook
      ? await worldbook.match(`${clean} ${msg.conversationName ?? ''}`).catch(() => [])
      : []
    // 社会层（2026-11-02）：开闸之后，她在外面见过的做法也进提示词。
    // 没开闸时 provider 返回空数组——那时她连"外面的人怎么处世"这件事都不该知道。
    const social = socialBeliefs ? await socialBeliefs().catch(() => []) : []
    const prompt = buildPrompt(
      { ...msg, text: clean },
      lines,
      {
        isOwner,
        impression: person?.impression ?? '',
        knowledge,
        social,
        video,
        background: msg.kind === 'group' ? (background.get(String(msg.conversationId)) ?? []) : [],
        offline: offlineNote(msg.channel),
      },
    )
    // 每轮注入的规模（2026-11-12）：只记字符数与流水条数，正文一个字都不进日志。
    // 走 logLine 而不是 host logger：进日志文件、不上屏，也不进她的事件流。
    logLine('info', [`prompt chars=${prompt.length} lines=${lines.length}`], root)

    // 这一轮是渠道在问她：叫醒轮那套记账要让开，否则同一句话会被记两次
    // （一次 channel: dsh、一次 channel: qq/bili/douyin），判断重复进 beliefs。
    let reply
    beginExternalTurn()
    try {
      reply = await askHer(st.sessionId, prompt)
      // 2026-11-07 真机：她记完 her_note 之后只吐了 DSML 的关闭标记，没有一个字的正文。
      // 那不是「她不想说」，是话没出来；只再问一次，第二次还是空就按沉默算。
      if (reply.ok && !reply.text && reply.why === 'scaffold') {
        log(`router · 这一轮只吐了脚手架，再问一次（${msg.channel}/${msg.personId}）`)
        const again = await askHer(st.sessionId, SCAFFOLD_RETRY_TEXT)
        if (again.text) reply = again
        else {
          log(`router · 再问一次还是只有脚手架（${msg.channel}/${msg.personId}）`)
          reply = { ...again, why: 'scaffold' }
        }
      }
    } finally {
      endExternalTurn()
    }
    if (!reply.ok && !reply.text) {
      log(`router · 这一轮没拿到话（${reply.why}）`)
      return { sent: false, why: reply.why || 'silent' }
    }
    const text = reply.text
    // 她一句话没说：这是拒绝，不是错误。
    if (!text) return { sent: false, why: reply.why || 'silent' }

    // 先剪掉复述的提示词与模型标记，再过凭据/私事闸：她的话里不能夹着稿纸，
    // 也不能把稿纸里别人的私事带出去（2026-11-08 真机）。
    const cleaned = stripScaffold(stripPromptEcho(text))
    if (!cleaned) {
      log(`router · 拦下一条只有脚手架的话（${msg.channel}）`)
      return { sent: false, why: 'scaffold' }
    }
    const screen = screenOutgoing(cleaned)
    if (!screen.ok) {
      // 2026-11-10：把命中的规则也记下来。只说「leak」的话，出问题时没法判是
      // 真泄露还是词面误伤（TZ 那边就是因为这条日志太粗，查了一晚上）。
      log(`router · 拦下一条出门的话（${screen.why}${screen.rule ? `：${screen.rule}` : ''}）`)
      return { sent: false, why: screen.why }
    }
    const outgoing = screen.text
    const { events } = await readEvents(root).catch(() => ({ events: [] }))
    const idx = await indexOf(events)
    // 主人可能同时在 B 站和抖音说话：两边的 id 算同一个人，不然「跟主人复述主人自己说过的话」会被误拦。
  const sameAs = isOwner ? Object.values(owners ?? {}).flat().map((x) => String(x)).filter(Boolean) : []
  const leak = looksLikePrivateLeak(outgoing, idx, { person: msg.personId, sameAs })
    if (leak.hit) {
      log(`router · 拦下一条私聊内容（来自 ${leak.from}，命中 ${leak.matched} 格）`)
      return { sent: false, why: 'private-leak' }
    }

    const adapter = adapters?.get(msg.channel)
    if (!adapter) return { sent: false, why: 'no-adapter' }
    // 只读的材料适配器（抖音）没有 send：别把它当成「发失败了」。
    if (typeof adapter.send !== 'function') return { sent: false, why: 'read-only-channel' }
    const r = await adapter.send({
      conversation: { kind: msg.kind, id: msg.conversationId, name: msg.conversationName ?? '' },
      text: outgoing,
    })
    if (!r?.ok) {
      log(`router · 发出失败（${msg.channel}）：${r?.why ?? 'unknown'}`)
      return { sent: false, why: 'send-failed' }
    }

    lastReplyAt.set(key, now())
    recentReplies.push({ at: now(), kind: msg.kind, conversationId: msg.conversationId })
    if (recentReplies.length > RECENT_REPLIES_MAX) recentReplies.splice(0, recentReplies.length - RECENT_REPLIES_MAX)
    await journal
      ?.append({ role: 'her', text: outgoing, at: now(), channel: msg.channel, kind: msg.kind, conversationId: msg.conversationId, name: msg.personName })
      .catch(() => {})
    await recordSaid(msg, outgoing, isOwner)
    // 2026-11-03（真机：会话攒到 47k，撞上游上下文上限）：渠道这边也要结账轮数。
    // 以前只有 her 那条会话（turns.js）与 /say 会 bumpTurns，渠道消息永远不涨 turns，
    // 于是 chat.rotateAfter 对渠道对话等于不存在——她的会话可以无限长下去。
    await turnOver().catch(() => {})
    return { sent: true, why: '', text: outgoing }
  }

  /**
   * 代发（2026-11-02）：她不说的时候，主人以自己的名义回一句。
   *
   * 三条边界，改之前先看 `AGENTS.md` §9：
   *   · 不经过她、不过 gate、不过出站筛——这是主人的话，不是她的话；
   *   · **不写事件流**：她的记忆里不该多出一句她没说过的话；
   *   · 只写一行 journal 流水（role:'owner'），面板上看得见"这句是谁说的"。
   *
   * @returns {Promise<{ok:boolean, why:string}>} 永不抛。
   */
  async function sendAs({ channel, kind, conversationId, conversationName = '', text }) {
    const body = String(text ?? '').replace(/\s+$/, '')
    if (!body.trim()) return { ok: false, why: 'empty' }
    if (body.length > 1000) return { ok: false, why: 'too-long' }
    const adapter = adapters.get(channel)
    if (!adapter) return { ok: false, why: 'no-adapter' }
    if (typeof adapter.send !== 'function') return { ok: false, why: 'read-only-channel' }
    const k = kind === 'group' ? 'group' : 'private'
    try {
      const r = await adapter.send({ conversation: { kind: k, id: conversationId, name: conversationName }, text: body })
      if (r && r.ok === false) return { ok: false, why: r.why || 'send-failed' }
    } catch (err) {
      log('router · 代发失败', err?.message ?? err)
      return { ok: false, why: 'send-failed' }
    }
    try {
      await journal?.append({ role: 'owner', text: body, at: now(), channel, kind: k, conversationId, name: conversationName })
    } catch { /* 发都发出去了，记不上流水不该让她背锅 */ }
    log(`router · 代发（${channel}/${conversationId}）：${body.slice(0, 40)}`)
    return { ok: true, why: '' }
  }

  async function drain() {
    if (busy || stopped) return
    busy = true
    try {
      while (queue.length && !stopped) {
        const msg = queue.shift()
        try {
          await handleOne(msg)
        } catch (err) {
          log('router · 处理失败', err?.message ?? err)
        }
      }
    } finally {
      busy = false
    }
  }

  return {
    /** 适配器接上来的入口。同一个 msg 只处理一次，不做去重（去重是适配器的活）。 */
    accept(msg) {
      if (stopped || !msg) return { queued: false, why: 'stopped' }
      // 合批（2026-11-06）：同一个会话里连着的几句先攒着，窗口到了再一起问她。
      // 群里一句话被拆成三四条发，她不该回三四遍。
      if (batchWindowMs > 0) {
        const key = `${msg.channel}:${msg.kind}:${msg.conversationId}`
        let b = batches.get(key)
        if (!b) {
          b = { msgs: [], timer: null }
          batches.set(key, b)
        }
        if (b.msgs.length >= QUEUE_MAX * 4) b.msgs.shift()
        b.msgs.push(msg)
        if (!b.timer) {
          b.timer = setTimer(() => {
            b.timer = null
            flushBatch(key)
          }, batchWindowMs)
          if (typeof b.timer?.unref === 'function') b.timer.unref()
        }
        return { queued: true, batched: true }
      }
      if (queue.length >= QUEUE_MAX) {
        log(`router · 队列满了，丢掉一条（${msg.channel}/${msg.personId}）`)
        return { queued: false, why: 'queue-full' }
      }
      queue.push(msg)
      void drain()
      return { queued: true, why: '' }
    },

    /** 直接处理一条（测试与「补发」用，不进队列）。 */
    handle: handleOne,

    /** 测试与关停用：把合批缓冲立刻倒进队列。 */
    flushBatches,

    /** 代发：主人以自己的名义说一句。见上面 `sendAs` 的三条边界。 */
    sendAs,

    async start() {
      stopped = false
      if (typeof ctx?.on === 'function') {
        offBus = ctx.on('session/event', (session, event) => {
          if (!pending) return
          const sessionId = String(session?.header?.id ?? session?.id ?? '')
          if (sessionId !== pending.sessionId) return
          const type = String(event?.type ?? '')
          if (type === 'assistant/message') {
            const mid = String(event?.data?.message?.id ?? '')
            if (mid && pending.sayIds.has(mid)) return
            if (mid) pending.sayIds.add(mid)
            const said = saidText(event?.data)
            if (said.text) pending.texts.push(said.text)
            else if (said.scaffoldOnly) pending.scaffoldOnly = true
          } else if (type === 'turn/end') {
            pending.resolve?.('end')
          }
        })
      }
      const results = []
      for (const [name, a] of adapters ?? []) {
        try {
          const off = a.onMessage?.((msg) => this.accept({ ...msg, channel: msg.channel || name }))
          if (typeof off === 'function') a.__off = off
          const r = await a.start?.()
          results.push({ name, ok: r?.ok !== false, why: r?.why ?? '' })
        } catch (err) {
          results.push({ name, ok: false, why: String(err?.message ?? err).slice(0, 120) })
        }
      }
      return results
    },

    async stop() {
      stopped = true
      queue.length = 0
      for (const [, b] of batches) {
        if (b.timer) clearTimer(b.timer)
      }
      batches.clear()
      pending?.resolve?.('stop')
      try {
        if (typeof offBus === 'function') offBus()
      } catch { /* ignore */ }
      for (const [, a] of adapters ?? []) {
        try { a.__off?.() } catch { /* ignore */ }
        try { await a.stop?.() } catch { /* ignore */ }
      }
    },

    /** 观测台：四个渠道各自活着没有，队列里还有几条（含合批缓冲）。 */
    status() {
      let buffered = 0
      for (const [, b] of batches) buffered += b.msgs.length
      const out = { busy, queued: queue.length + buffered, batching: batches.size, channels: {} }
      for (const [name, a] of adapters ?? []) {
        try {
          out.channels[name] = a.status?.() ?? { ok: false, why: 'no status' }
        } catch {
          out.channels[name] = { ok: false, why: 'status failed' }
        }
      }
      return out
    },
  }
}
