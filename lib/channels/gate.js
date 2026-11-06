/**
 * gate.js —— 该不该接这句话
 *
 * 渠道层唯一一个**做判断**的地方，其余都在搬运。
 * 判断分两类，混在一起就会出事：
 *
 *   1. **环境类**（用户可配 + 内部默认）：这个群在不在白名单、一天回几句、隔多久回一句。
 *      这些改了不会让她变成另一个人，只改变她出现在哪、多久出现一次。
 *   2. **成长类**（不可配，写死在代码里）：她到第几阶段才搭理陌生人。
 *      这不是"反应速度"，是"她敢不敢跟不认识的人说话"——前两个阶段她连自己是谁
 *      都还没弄清楚，一个陌生群友 @ 她，她凭什么接。
 *
 * 所以第一类从 `config.channels.*` 读，第二类只能读阶段，且**没有配置键**。
 * 用户想让她早点搭理陌生人，办法是陪她走完前两个阶段，不是改一个数字。
 *
 * 2026-11-06（照 dsh-lanxi-qq 的闸门顺序重写，见 新项目-设计讨论.md 渠道节）：
 * 内部默认全部不上面板，丢了都写 reason——
 *   · 群冷却 120s（被 @ / 被回复 / 管理员豁免）；
 *   · 每分钟最多 30 条（整条渠道）；
 *   · 每群每天最多 20 条；
 *   · 夜间 23:00–08:00、工作日峰时 9–12 / 14–18，群里只回点名她的；
 *   · 私聊冷却仍 8s（主人私聊豁免）。
 * 不抄 lanxi 的「冷却先占位再判配额」：配额丢掉的那条不该白耗一次冷却。
 *
 * 这里只回答"要不要问她"，不回答"她会不会回"。后者是她的自由：
 * 我们把她叫醒，她可以一句话不说（见 router.js 的空回合处理）。
 */

/** 她到第几阶段才搭理陌生人。三 = 自主。 */
export const STRANGER_STAGE = 3

/** 私聊里两条回复之间的最小间隔（毫秒）。防刷屏，也是防她自己被风控。 */
export const REPLY_COOLDOWN_MS = 8000
/** 群里默认冷却：@ 与管理员豁免——被点名了还压着不回，就不是"防刷屏"了。 */
export const GROUP_COOLDOWN_MS = 120_000
/** 整条渠道每分钟最多发几条。 */
export const RATE_LIMIT_PER_MIN = 30
/** 一个群一天最多回几条。 */
export const GROUP_DAILY_MAX = 20

const QUIET_FROM_HOUR = 23
const QUIET_TO_HOUR = 8
/** 工作日峰时：这两段里群里只回点名她的（她还要过自己的生活）。 */
const PEAK_HOURS = [[9, 12], [14, 18]]

/** 渠道默认配置。`enabled` 默认全关——装完不配，她哪儿也不去。 */
export const CHANNEL_DEFAULTS = Object.freeze({
  enabled: false,
  replyInGroup: false,
  /** 群号白名单。空数组 = 一个群都不回。私聊不受它管。 */
  groups: [],
  /** 群里只在她被 @ 时开口。2026-11-03 用户要求：192 人的群，主人一说话她就回，太吵。 */
  mentionOnly: true,
})

/**
 * 这个渠道的配置，补上缺省值。
 * @param {object} config 全量配置
 * @param {string} channel
 */
export function channelConfig(config, channel) {
  const raw = config?.channels?.[channel]
  const base = raw && typeof raw === 'object' ? raw : {}
  return {
    ...CHANNEL_DEFAULTS,
    ...base,
    groups: Array.isArray(base.groups) ? base.groups.map((g) => String(g).trim()).filter(Boolean) : [],
    enabled: base.enabled === true,
    replyInGroup: base.replyInGroup === true,
    mentionOnly: base.mentionOnly !== false,
  }
}

function hourOf(now) {
  return new Date(now).getHours()
}

function weekdayOf(now) {
  return new Date(now).getDay() // 0 = 周日，6 = 周六
}

/** 夜间 23:00–08:00：群里不点名就不开口。 */
export function isQuietHour(now) {
  const h = hourOf(now)
  return h >= QUIET_FROM_HOUR || h < QUIET_TO_HOUR
}

/** 工作日峰时 9–12、14–18：同样只回点名她的。 */
export function isPeakHour(now) {
  const day = weekdayOf(now)
  if (day === 0 || day === 6) return false
  const h = hourOf(now)
  return PEAK_HOURS.some(([from, to]) => h >= from && h < to)
}

function sameLocalDay(a, b) {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

/**
 * 要不要把这句话递给她。
 *
 * @param {object} p
 * @param {string} p.channel    'qq' | 'bili' | 'douyin'
 * @param {'dm'|'group'} p.kind
 * @param {string} p.conversationId
 * @param {boolean} p.isOwner   这个人是不是他本人
 * @param {boolean} [p.isAdmin] 这个人在群里是不是管理员（群主/管理）
 * @param {boolean} [p.mentioned] 群里这条有没有 @ 她
 * @param {boolean} [p.replyToSelf] 群里这条是不是在回复她发过的消息
 * @param {number} p.stage      她现在第几阶段
 * @param {object} p.config     全量配置
 * @param {number} [p.lastReplyAt] 这个会话上一条回复的时间
 * @param {Array<{at:number, kind?:string, conversationId?:string}>} [p.recentReplies] 渠道最近的回复（配额用）
 * @param {number} [p.now]
 * @returns {{ok:boolean, why:string}}
 */
export function canReply({
  channel,
  kind,
  conversationId,
  isOwner,
  isAdmin = false,
  stage,
  config,
  mentioned = false,
  replyToSelf = false,
  lastReplyAt = 0,
  recentReplies = [],
  now = Date.now(),
}) {
  const c = channelConfig(config, channel)
  if (!c.enabled) return { ok: false, why: 'channel-off' }
  // 被 @ 和"回复她"都算点名：群友点她名字，她该能应。
  const addressed = mentioned === true || replyToSelf === true
  if (kind === 'group') {
    if (!c.replyInGroup) return { ok: false, why: 'group-reply-off' }
    if (!c.groups.includes(String(conversationId))) return { ok: false, why: 'group-not-allowed' }
    // 群聊默认只在被 @ 时开口：群里几十号人聊天，她不该每条都接。
    if (c.mentionOnly && !addressed) return { ok: false, why: 'group-not-mentioned' }
  }
  // 陌生人：阶段不够就不叫醒她。她不是客服，没有义务接每一个人的话。
  if (!isOwner && Number(stage) < STRANGER_STAGE) return { ok: false, why: 'stage-too-early' }

  if (kind === 'group' && !addressed) {
    if (isQuietHour(now)) return { ok: false, why: 'quiet-hours' }
    if (isPeakHour(now)) return { ok: false, why: 'peak-hours' }
  }

  // 冷却只防刷屏：群里连着几十条要压住；被她点名、被管理员叫到不算刷屏；
  // 主人自己在私聊里连说三句，也不该被当成刷屏。
  if (kind === 'group') {
    if (!addressed && !isAdmin && lastReplyAt && now - lastReplyAt < GROUP_COOLDOWN_MS) {
      return { ok: false, why: 'cooldown' }
    }
  } else if (!isOwner && lastReplyAt && now - lastReplyAt < REPLY_COOLDOWN_MS) {
    return { ok: false, why: 'cooldown' }
  }

  const recent = Array.isArray(recentReplies) ? recentReplies : []
  const perMinute = recent.filter((r) => now - Number(r?.at ?? 0) < 60_000).length
  if (perMinute >= RATE_LIMIT_PER_MIN) return { ok: false, why: 'rate-limited' }
  if (kind === 'group') {
    const today = recent.filter(
      (r) => r?.kind === 'group' && String(r?.conversationId ?? '') === String(conversationId) && sameLocalDay(Number(r.at), now),
    ).length
    if (today >= GROUP_DAILY_MAX) return { ok: false, why: 'daily-limit' }
  }
  return { ok: true, why: '' }
}

/**
 * 给观测台看的一句话解释。用户最常问的是"为什么她不回我"，
 * 答案就是其中一个，不该让他去翻日志。
 */
export function explain(why) {
  switch (why) {
    case 'channel-off':
      return '这个渠道还没开'
    case 'group-reply-off':
      return '开了渠道，但没允许在群里说话'
    case 'group-not-allowed':
      return '这个群不在白名单里'
    case 'group-not-mentioned':
      return '群里没点她的名（要 @ 她，或者回复她）'
    case 'stage-too-early':
      return `她还没到能搭理陌生人的阶段（要到第 ${STRANGER_STAGE} 阶段）`
    case 'quiet-hours':
      return '夜里她只接点名的话'
    case 'peak-hours':
      return '工作日的忙时她只接点名的话'
    case 'cooldown':
      return '刚回过一句，等一下'
    case 'rate-limited':
      return '这一分钟她说得太多了'
    case 'daily-limit':
      return '这个群今天已经说够了'
    case 'busy':
      return '她正在回别人'
    case 'auto-silent':
      return '她说过晚安了，这时候不叫她'
    default:
      return ''
  }
}
