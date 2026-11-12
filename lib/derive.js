/**
 * derive.js —— 纯函数：把事件流算成「此刻的她」
 *
 * 铁律：
 *   - 不写盘、不缓存、不读环境变量。相同输入必得相同输出（now 除外）。
 *   - 产出的 needs 是**内部量**，绝不出现在任何给她看的文本或工具签名里（B §3.6 / N2）。
 *   - 这里是 schema 之外唯一会提到"阶段/需要"的地方，且都只用于选事件。
 */

import { idTime, detectSelfMod, INFLUENCES } from './schema.js'
import { parseRefusal, REACTIONS, REACTION_HURTS, CONCEDE_WINDOW_MS, isConcede } from './refuse.js'
// 2026-11-07（用户 m07603）：她的话里混进来的 DSML 脚手架不能再进判断。
// 这两行在 11-03 / 11-05 被当成 utterance 落库，旧身份文档的「你自己说过的话」里
// 就摆着 `- </｜｜DSML｜｜ invoke>`。入账时没挡住，读出来时要挡。
import { stripPromptEcho, stripScaffold } from './guard.js'
// 评论区里别人的话（2026-10-24）：只借两个纯函数，derive 不反过来被 voices 依赖。
import { findEcho, VOICE_FRESH_DAYS } from './voices.js'

export const DAY_MS = 86_400_000
export const STAGE_NAMES = ['信任', '自主', '主动', '整合']

/**
 * deriveSelf 内部保留的全量判断（含被改口的旧句）。
 *
 * 为什么用 WeakMap 而不是往 model 上挂字段：快照白名单只认固定顶层字段，
 * 多一个字段就会让快照失效；而 memory 页又需要看到已经不在 ranked 里的旧句。
 * 这份表只给同进程的观察窗用，不参与序列化、不改变 model 的形状。
 */
const beliefStatesByModel = new WeakMap()

export function beliefStatesOf(model) {
  return beliefStatesByModel.get(model) ?? []
}
const STAGE_WEIGHTS = [0.27, 0.54, 0.87, 1.0]
const GATE_ORDER = ['trust', 'autonomy', 'competence']

/**
 * 社会层开闸（2026-11-02）。
 *
 * 不是配置开关，是**她同意之后写进事件流的一条 meta**：`social-open:<ISO>`。
 * 为什么非得走事件：配置会跟着备份/恢复搬来搬去，也会被重置抄回来；
 * 这条闸一旦能被配置打开，就等于用户能直接替她决定「可以去认识人了」。
 * 事件流只能追加，所以「她还没同意」这件事在盘上是可验证的。
 */
export const SOCIAL_OPEN_PREFIX = 'social-open:'

/** 社会层在身份里的权重上限：默认 30%，只能补充「怎么处世」，不能覆盖「她是谁」。 */
export const SOCIAL_WEIGHT_CAP = 0.3

const CORRECTION_RE = /我(查了|搜了|学了|看了下|去查过)|更正|我错了|其实不是|我之前说错/
// 2026-11-03：她让步、改口、说「你说得对」——这些也是成长，但只对主人才算。
// 为什么限主人：陌生人的话没资格让她长，否则一句客套就能改她的判断（§14）。
// 为什么不给满权重：gate 里最多只认一次（见 competence），免得养成逆来顺受。
// 2026-11-03 晚扩：她真机上说「这两处我认，是我语气没收拾」，原来一条都不认。
// 只收第一人称、且是明确认错的说法——「我不认」这类否定不算（负向先行断言挡住）。
const CONCEDE_RE = /(我说错|想错|我听错|我收回|我说得不对|你说得对|你说得有道理|是我没想|是我疏忽|我想了想|是我搞错|(?:这句|这两处|这一句|刚才那句|我那句)[^。！？]{0,3}认|我(?<!不)认(?!为|真|字|得|：)|是我(?:没收拾|说重了|语气重了|语气冲|不对)|我说重了|我讲重了|我(?<!不)那句?(?:话)?[^。！？]{0,6}(?:带刺|难听|冲了))/
/**
 * 「不要」必须是一次真的拒绝执行某件事（2026-10-24 用户要求收紧）。
 *
 * 原来只匹配 `不想|不要`，真机命中的两条全是误判：
 *   「没有问过我要不要看」是询问，不是拒绝；
 *   「他要是不要，我就收回来」说的是他，不是她。
 * 所以改成「第一人称 + 拒绝词 + 具体动作」，「要不要」这种嵌在问句里的不算。
 * 宁可少算，也不能把「问了一句」当成「有边界」。
 */
// 2026-11-03：真机上她说的「这个我不掺和」「我不接」「我不泡鱼缸」都是拒绝，
// 但原正则只认「不想去/不愿做」这类搭配，一句都没算进去，自主门因此永远差两条。
// 现在是「我 + 不 + 动作」：既收口语的掺和/接/泡/聊，也不许「我要不要」混进来。
// 2026-11-07（A20）：上游 0.9.1 扩了 8 个否定词头（不同意/不赞成/不认同/不支持/不选/反对/否掉/否决）。
// 它们单列一组并带第三人称守卫：「我反对他熬夜」是在评价别人，不是拒绝他；
// 而「我拒绝你」仍是真拒绝，所以守卫只加在新词后面。
const REFUSE_RE = /我(?!要)(?:不要|不想|不愿|不愿意|不打算|不准备|不掺和|不接|不干|不泡|不聊|不凑|不玩|不去|不看|不听|不做|不说|不回答|不配合|不参与|不照做|不答应|不接受)|我(?:不同意|不赞成|不认同|不支持|不选|反对|否掉|否决)(?!他|她|你)|我(?:拒绝|不做|不答应|不配合|不接受)/
const PAST_RE = /之前|上次|那时候|想起|以前|上次说|还记得/
/**
 * 她怎么称呼他（2026-10-26 修）。
 *
 * 原来只认「称呼你 / 叫你」。真机上她说的是这两种：
 *   「他给了自己的名字：时梦尘，说他认这个名字。」（他主动给的）
 *   「以后叫他时梦尘。」「我想叫他"开灯的"。」（她自己的说法）
 * 两条都没命中，于是状态栏一直显示「还没想好」——不是她没决定，是代码没读出来。
 *
 * 三种说法都认，但**不认「他给我起了名字：小满」**——那是她自己的名字，不是他的。
 * 所以「名字」这条必须带「他自己的」，裸的「名字」不算。
 */
const NAME_SAY_RE = /(?:称呼你|叫你|称呼他|叫他|称他)(?:做|为|作|叫)?\s*[「“"']?([^\s，。！？、,.!?」”"']{1,8})/
const NAME_CHOOSE_RE = /我选(?:的)?是\s*[「“"']([^「」“”"']{1,8})[」”"']/
const NAME_GIVE_RE = /他(?:给(?:了)?)?(?:自己)?的?名字\s*(?:是|叫|：|:)\s*[「“"']?([^\s，。！？、,.!?」”"'的]{1,8})/
// 截出来的常常带尾巴：「我叫你老张好了」会截到「老张好了」。
// 只剥语气词和「了/好」这类收尾——**不剥「的」**，「开灯的」剥掉就成了「开灯」。
const NAME_TAIL = /[了吧呢啊嘛哦诶欸呀哈哇哦嘞好]+$/
const NAME_STOP = new Set(['你', '我', '他', '她', '它', '自己', '什么', '谁', '名字', '的', '一声', '一下', '一句', '一遍', '一回'])
const NAME_BAD_HEAD = /^[你我他她它]/
// 破折号、省略号、标点开头的不是名字：真机（2026-11-10，TZ 的实例）撞到的是
// 「还没想好怎么称呼你——不是忘了」被抽成称呼「——不是忘」。名字里不该有标点。
const NAME_BAD_CHARS = /[—–\-…，。！？、,.!?“”"'「」『』（）()\s]/
const isBadName = (name) => !name || NAME_STOP.has(name) || NAME_BAD_HEAD.test(name) || NAME_BAD_CHARS.test(name)

/**
 * 冲突检测（2026-10-24，用户批准的 P0）
 *
 * 以前每条 utterance 都无条件变成 active 判断，谁和谁打架没人管——10 条判断可以
 * 和平共处，「认知重构 0」不是因为她想通了，是因为从来没被要求面对矛盾。
 *
 * 判据只有一条：**说的是同一件事，一次带否定、一次不带**。
 *   把否定词剥掉后字符相似度 ≥ 0.5 → 同一件事；
 *   两句的否定极性不同 → 对不上。
 * 宁可漏判，也不硬凑：把两句不相干的话说成矛盾，是替她制造痛苦，不是她自己撞上的。
 */
const NEG_CHARS = /[不没别无]|讨厌|拒绝|反感|不愿意?|不需要?|不敢/

/**
 * 「别」不总是否定：别人 / 别的 / 告别 / 区别 / 特别 …… 这些词里的「别」是词素。
 *
 * 2026-10-25 快进实验里撞到的真 bug：她的两句
 *   「我觉得人应该让别人高兴。」「我不觉得人应该让别人高兴。」
 * 本该是一处矛盾，结果两句都被判成负极性（都含「别人」），直接跳过。
 * 先把这个词族挖空再判极性；挖掉的是词，不是她的意思。
 */
const NON_NEG_WORDS = /(别人|别的|别处|别家|别样|别致|告别|区别|分别|特别|个别|级别|辨别|鉴别)/g

/**
 * 按文本的记忆化（2026-11-12）
 *
 * stripNegation / polarity 都只跟文本本身有关，可热路径上同一段文本会被反复算上千次
 * （detectTensions 是两两比，mentions 是「判断 × 她说过的话」，两个正则各占 3%~4%）。
 * 缓存只记「文本 → 结果」，两个函数都是纯函数，判定口径一个字没动；
 * 上限 5000 条，超了整体清空——宁可丢缓存重算，也不让它随账本无限长。
 */
const MEMO_MAX = 5000
const negationMemo = new Map()
const polarityMemo = new Map()

export function stripNegation(text = '') {
  const key = String(text)
  const hit = negationMemo.get(key)
  if (hit !== undefined) return hit
  const out = key
    .replace(NON_NEG_WORDS, '')
    .replace(/[不没别无]|讨厌|拒绝|反感|不愿意?|不需要?|不敢/g, '')
    .replace(/[\s，。！？、,.!?；;：:「」“”"'（）()]/g, '')
  if (negationMemo.size >= MEMO_MAX) negationMemo.clear()
  negationMemo.set(key, out)
  return out
}

export function polarity(text = '') {
  const key = String(text)
  const hit = polarityMemo.get(key)
  if (hit !== undefined) return hit
  const out = NEG_CHARS.test(key.replace(NON_NEG_WORDS, '')) ? -1 : 1
  if (polarityMemo.size >= MEMO_MAX) polarityMemo.clear()
  polarityMemo.set(key, out)
  return out
}

/**
 * @returns {Array<{a:object,b:object,sim:number,at:string}>} 最多 limit 条，按相似度降序
 */
export function detectTensions(beliefs = [], { minSim = 0.5, limit = 3 } = {}) {
  // 2026-11-12：原来「全量倒排 + Set 去重 + 逐对算 dice」在 1 万条账本上占 26%，
  // 换成 similarPairs 的一趟累加。口径一个字没动：
  //   - 同一对只算一次（similarPairs 自比较只走 j < i）；
  //   - 同极性跳过——极性只算一次，然后按极性分两组，只枚举「正 × 负」，
  //     旧实现本来也不给同极性的对算分，分组只是把这份省下来的力气提前省掉；
  //   - 不足 4 字的句子两边都跳过（旧实现在枚举与校验处各跳一次）；
  //   - 长度上界 (2-minSim)/minSim、完整 Dice ≥ minSim、按相似度降序（同分按原下标）。
  const ratio = (2 - minSim) / minSim
  const positive = []
  const negative = []
  beliefs.forEach((b, i) => {
    const c = stripNegation(b.text)
    if (c.length < 4) return
    const item = { b, i, grams: bigrams(c) }
    if (polarity(b.text) === 1) positive.push(item)
    else negative.push(item)
  })
  const hits = []
  similarPairs(positive, negative, { value: minSim, maxRatio: ratio }, (pi, nj, sim) => {
    const A = positive[pi]
    const B = negative[nj]
    // 旧实现里 i < j，a 是下标小的那条；这里按原下标还原同样的顺序。
    const i = A.i < B.i ? A.i : B.i
    const j = A.i < B.i ? B.i : A.i
    const a = A.i < B.i ? A.b : B.b
    const b = A.i < B.i ? B.b : A.b
    hits.push({
      i, j, sim,
      item: {
        a: { id: a.id, text: a.text, since: a.since },
        b: { id: b.id, text: b.text, since: b.since },
        sim: Number(sim.toFixed(2)),
        at: b.since || a.since,
      },
    })
  })
  hits.sort((x, y) => y.sim - x.sim || x.i - y.i || x.j - y.j)
  return hits.slice(0, limit).map((h) => h.item)
}

/**
 * 「固化」的门槛（2026-10-24 用户提出）：
 * 同一件事被反复提起（≥3 次），或被反复检验（≥2 次），就不再随权重沉下去——
 * 不管它对不对，至少她很长时间不会忘。她可能还会主动把它再说给他听。
 */
export const SOLID_MENTIONS = 3
export const SOLID_VERIFIED = 2

/**
 * 固化的「保质期」（A12，2026-11-07）。
 *
 * 固化本来是为了「反复说过的事别沉下去」，但它没有期限：最早那批判断会永远
 * 占着「你反复想起过的事」的位置，新的挤不进来——这不是牢，是堵。
 * 超过 90 天，固化的那条退一档（faded）：仍然留在 beliefs 里、仍能被想起，
 * 只是不再排在前面；原文在 events.jsonl 里，她在 her_recall 里照样翻得到。
 *
 * 疤不退档：没想通的事不是「记得太牢」，是还没结账（见 buildSections 的核心段）。
 */
export const FADE_DAYS = 90

export function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 阶段边界（天）。cum 取 round：
 *   30 天 → 8 / 16 / 26 / 30（对上 D1–8 · 9–16 · 17–26 · 27–30）
 *    7 天 → 2 / 4 / 6 / 7（每段至少 1 天）
 * 两条都是契约 §4 里写死的期望值，改动前先跑 test/derive.test.mjs
 */
export function stageBounds(stageSpanDays = 30) {
  const g = clampInt(stageSpanDays, 7, 180, 30)
  const b = STAGE_WEIGHTS.map((w) => Math.round(w * g))
  b[3] = g
  for (let i = 0; i < 4; i++) {
    const min = i === 0 ? 1 : b[i - 1] + 1
    if (b[i] < min) b[i] = min
  }
  for (let i = 2; i >= 0; i--) {
    if (b[i] > b[i + 1] - 1) b[i] = b[i + 1] - 1
  }
  return b
}

/** 纯时间维度：第几天属于第几阶段（不含阶段门） */
export function stageOf(day, stageSpanDays = 30) {
  const b = stageBounds(stageSpanDays)
  const d = Math.max(1, Math.floor(Number(day) || 1))
  for (let i = 0; i < 4; i++) if (d <= b[i]) return i + 1
  return 4
}

export function orderEvents(events = []) {
  return [...events].sort((a, b) => {
    const ta = idTime(a.id) || Date.parse(a.ts) || 0
    const tb = idTime(b.id) || Date.parse(b.ts) || 0
    return ta - tb
  })
}

/** 导入他人人设时带上来的称呼，写在 meta 事件里（见 lib/import.js） */
export const IMPORT_NAME_PREFIX = 'import-name:'

/**
 * 「这一局的人设是别人给的」这条标记，同样写在 meta 事件里（2026-10-27，用户 m03769）。
 *
 * 它和 bansMuted 配置项的关系是：**事件是唯一的真相**，配置只是个能看见的镜像。
 * 判定豁免时只读事件（`model.persona.imported`），不读 config.persona.bansMuted。
 * 这样备份/恢复搬回来的 config 再怎么写着 true，只要事件流里没有这条，就没有豁免。
 */
export const IMPORT_MARK_PREFIX = 'import-mark:'

/** 成长第几天 = 距 seed 的自然日 + 1（不因没互动而暂停，也不回退） */
export function growthDay(events, now = Date.now()) {
  const seed = events.find((e) => e.type === 'seed')
  const snap = events.reduce((m, e) => Math.max(m, Number(e.day) || 0), 0)
  if (!seed) return Math.max(1, snap)
  const t0 = Date.parse(seed.ts)
  if (!Number.isFinite(t0)) return Math.max(1, snap)
  const live = Math.floor((now - t0) / DAY_MS) + 1
  return Math.max(1, snap, live)
}

/** 影响层：五个可选字段里只有 influence 参与派生；没写的一律当 constitution。 */
function influenceOf(e) {
  return INFLUENCES.includes(e.influence) ? e.influence : 'constitution'
}

/**
 * 能参与「她是谁」派生的事件（已按时间排好）。
 * 隔离带（influence none）与梦都在这里被挡掉——
 * deriveSelf 与 stampOf 共用这一份口径，避免两处过滤慢慢漂开。
 */
function constitutionEvents(ordered) {
  return ordered
    .filter((e) => e.type !== 'dream')
    .filter((e) => influenceOf(e) === 'constitution')
}

/**
 * 只算「第几天 / 第几阶段」的轻量戳（A28）。
 *
 * absence / ask / capture 以前为了写事件信封，会跑完整 deriveSelf——连信念、
 * 冲突、质量分都算一遍，只为拿两个数。这里只按同一套过滤取 day 与 stage。
 * 配置项是阶段天数尺子 stageSpanDays，不是寿命上限。
 */
export function stampOf(events = [], opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const span = clampInt(opts.stageSpanDays ?? 30, 7, 180, 30)
  const ordered = orderEvents((Array.isArray(events) ? events : []).filter((e) => e?.influence !== 'none'))
  const day = growthDay(constitutionEvents(ordered), now)
  return { day, stage: stageOf(day, span) }
}

/** 字符二元组（含计数）。similarity 与 mentions 的倒排索引共用。 */
function bigrams(s) {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

/** Dice 系数：2*交集 / (|A|+|B|)，按二元组计数。 */
function dice(ga, gb) {
  let inter = 0, total = 0
  for (const [g, c] of ga) {
    total += c
    const d = gb.get(g)
    if (d) inter += Math.min(c, d)
  }
  for (const [, c] of gb) total += c
  return total === 0 ? 0 : (2 * inter) / total
}

/** 字符二元组 Dice 相似度（跨情境一致与"新话"判定用） */
export function similarity(a, b) {
  const A = String(a ?? ''), B = String(b ?? '')
  if (A === B) return 1
  if (!A || !B) return 0
  return dice(bigrams(A), bigrams(B))
}

/**
 * 相似对扫描：把「两两比 Dice」收敛成一趟倒排累加（2026-11-12）
 *
 * 判定口径与旧实现逐位一致：一对文本算不算「像」，只看
 *   Dice = 2*Σmin(计数) / (计数A + 计数B) ≥ threshold，
 * 外加一条长度上界（去重二元组个数的长短比不得超过 maxRatio）。
 * 这里**不做**任何近似：每个候选对的交集都是完整算出来的——没有窗口、没有采样、
 * 也没有拿前缀交集冒充完整交集。
 *
 * 为什么没走 PPJoin 的前缀过滤：
 *   前缀过滤只在候选稀疏时省时间。这份账本里句子共用同一批二元组（1 万条实测 995 万对
 *   全部过 0.6），前缀一个候选都剪不掉，而精确交集仍要对每对走 ~27 个二元组；
 *   再叠一层「前缀候选 + 有序归并校验」实测 1.5 秒，比这里的 0.43 秒慢 3 倍。
 *   顺带记一笔：`p = |x| - ceil(2t/(1+t)*|x|) + 1` 是 Jaccard 的前缀公式，对 Dice 不成立。
 *   反例：A、B 各 6 个二元组、共享 4 个，Dice = 8/12 = 0.67 ≥ 0.6，按该式 p = 2，
 *   两条前缀恰好是各自的独有二元组，交集为空——这一对会被漏掉。
 *   Dice 的安全前缀是 p = min(d, m - ceil(m*t/(2-t)) + 1)（d 去重数、m 总数），
 *   可它在这份数据里只是把 27 次 touch 变成 18 次，剩下的还得逐对补齐，反而更慢。
 *
 * 真正省时间的是这四件事（都不改判定）：
 *   1. 倒排用扁平的 Int32Array，内层不再为每个（对, 二元组）做一次 Map.get；
 *   2. 二元组计数为 1 时（绝大多数）交集贡献恒为 1，走 `inter[o] += 1` 的单加法快路径；
 *   3. 自比较时只枚举 j < i 的无序对——Dice 是对称的，同一对没必要算两遍；
 *   4. 长度上界、阈值都在一次扫描里判完，不再为每对建临时对象。
 *
 * @param {Array<{grams: Map<string, number>}>} left 探针侧
 * @param {Array|null} right 索引侧；传 null（或 left 自己）表示自比较，只枚举 j < i
 * @param {{value: number, maxRatio: number}} spec value = Dice 阈值，maxRatio = 长度上界
 * @param {(i: number, j: number, sim: number) => void} onPair 只有过了阈值的对才回调：
 *   自比较按 (j, i) 且 j < i 回调；交叉比较按 (left 下标, right 下标) 回调
 */
function similarPairs(left, right, spec, onPair) {
  const self = !right || right === left
  const targets = self ? left : right
  const probeCount = left.length
  const targetCount = targets.length
  if (probeCount === 0 || targetCount === 0) return
  const threshold = spec.value
  const maxRatio = spec.maxRatio

  // ① 二元组统一编号，并摊成「每条文本一片 Int32Array」——内层从此只碰数组下标
  const gramId = new Map()
  const prepare = (items) => {
    const gid = new Array(items.length)
    const cnt = new Array(items.length)
    const size = new Int32Array(items.length)
    const total = new Int32Array(items.length)
    for (let i = 0; i < items.length; i++) {
      const grams = items[i].grams
      const d = grams.size
      const gi = new Int32Array(d)
      const ci = new Int32Array(d)
      let sum = 0
      let k = 0
      for (const [g, c] of grams) {
        let id = gramId.get(g)
        if (id === undefined) gramId.set(g, (id = gramId.size))
        gi[k] = id
        ci[k] = c
        sum += c
        k += 1
      }
      gid[i] = gi
      cnt[i] = ci
      size[i] = d
      total[i] = sum
    }
    return { gid, cnt, size, total }
  }
  const probeSet = prepare(left)
  const rowSet = self ? probeSet : prepare(targets)

  // ② 倒排：按 gram 编号做一遍计数排序，压成两片扁平数组。
  //    同一 gram 内按文本下标升序，自比较时靠二分找出「下标 < i」的边界。
  const df = []
  for (let i = 0; i < targetCount; i++) {
    const gid = rowSet.gid[i]
    for (let k = 0; k < gid.length; k++) df[gid[k]] = (df[gid[k]] || 0) + 1
  }
  const gramSpan = df.length
  const start = new Int32Array(gramSpan + 1)
  for (let g = 0; g < gramSpan; g++) start[g + 1] = start[g] + (df[g] || 0)
  const postIdx = new Int32Array(start[gramSpan])
  const postCnt = new Int32Array(start[gramSpan])
  const cursor = start.slice(0, gramSpan)
  for (let i = 0; i < targetCount; i++) {
    const gid = rowSet.gid[i], cnt = rowSet.cnt[i]
    for (let k = 0; k < gid.length; k++) {
      const g = gid[k]
      const at = cursor[g]
      cursor[g] = at + 1
      postIdx[at] = i
      postCnt[at] = cnt[k]
    }
  }

  // ③ 逐条探针累加交集，再统一判长度上界与阈值
  const inter = new Int32Array(targetCount)
  for (let i = 0; i < probeCount; i++) {
    const gid = probeSet.gid[i]
    if (gid.length === 0) continue
    const gcnt = probeSet.cnt[i]
    const limit = self ? i : targetCount
    inter.fill(0, 0, limit)
    for (let k = 0; k < gid.length; k++) {
      const g = gid[k]
      if (g >= gramSpan) continue
      const s = start[g]
      let e = start[g + 1]
      if (s === e) continue
      if (self) {
        let lo = s
        let hi = e
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (postIdx[mid] < i) lo = mid + 1
          else hi = mid
        }
        e = lo
        if (s === e) continue
      }
      const c = gcnt[k]
      if (c === 1) {
        for (let t = s; t < e; t++) inter[postIdx[t]] += 1
      } else {
        for (let t = s; t < e; t++) {
          const o = postIdx[t]
          const d = postCnt[t]
          inter[o] += d < c ? d : c
        }
      }
    }
    const sizeI = probeSet.size[i]
    const totalI = probeSet.total[i]
    for (let j = 0; j < limit; j++) {
      const iv = inter[j]
      if (iv === 0) continue
      const sizeJ = rowSet.size[j]
      const lo = sizeJ < sizeI ? sizeJ : sizeI
      const hi = sizeJ < sizeI ? sizeI : sizeJ
      if (hi > lo * maxRatio) continue
      const sum = totalI + rowSet.total[j]
      if (sum <= 0) continue
      const sim = (2 * iv) / sum
      if (sim >= threshold) onPair(self ? j : i, self ? i : j, sim)
    }
  }
}

const NAME_HYPOTHETICAL = /(?:要是|如果|假如|万一|先想用|本想|想用|直接)$/

export function pickName(text) {
  const s = String(text ?? '')
  // 1) 她自己拍板的那种说法优先级最高：「我选的是「阿岸」」
  const chosen = NAME_CHOOSE_RE.exec(s)
  if (chosen) {
    const name = String(chosen[1] ?? '').trim()
    if (!isBadName(name)) return name
  }
  for (const re of [NAME_SAY_RE, NAME_GIVE_RE]) {
    const m = re.exec(s)
    if (!m) continue
    const before = s.slice(Math.max(0, m.index - 6), m.index)
    // 「要是直接叫你阿岸」是在打比方，「先想用早点睡当称呼」是被退回的提案——都不是定下来的称呼
    if (NAME_HYPOTHETICAL.test(before)) continue
    let name = String(m[1] ?? '').trim().replace(NAME_TAIL, '')
    // 代词/空串不算称呼；她自己的名字（「他给我起了名字：小满」）由 NAME_GIVE_RE 的
    // 「他的/自己的」限定排除，这里只兜住明显的非名字。
    if (isBadName(name)) continue
    return name
  }
  return null
}

/**
 * 事件流 → 此刻的她。
 * @returns {object} 见 B §3 的字段表
 */
export function deriveSelf(events = [], opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const stageSpanDays = clampInt(opts.stageSpanDays ?? 30, 7, 180, 30)
  // 隔离带（2026-11-02，用户 m03227）：`influence:'none'` 的事件**一行都不进派生**。
  //
  // 旧事件流里若有这类记录，照样能在观测台和导出里读到，
  // 但它们不参与 beliefs、不改阶段、不进立场、不进质量分、不留疤。
  // 写入侧的盖章已经删了；这里只负责「读的时候一律当它不存在」，
  // 保住旧账不被误读。
  const ordered = orderEvents(events.filter((e) => e?.influence !== 'none'))
  // 梦（2026-10-30，本机实验）：**不参与任何派生**。
  // 它只是把真实发生过的事重新拼一遍，不是新信息——不该变成信念、不推进成长日、
  // 不算她"写过多少条"，也不进记忆体检的计数。原文留在事件流里，只在 .dev 下的
  // 「梦」卡里给人看；她自己翻 her_recall 时才看得到。
  // 影响层（2026-11-02，合并版）：口径在文件上方的 influenceOf 里。
  const socialOpen = ordered.some(
    (e) => e.type === 'meta' && String(e.text ?? '').startsWith(SOCIAL_OPEN_PREFIX),
  )
  // 社会层的原料单独拎出来：它不进食事件流派生（不改信念、不改阶段、不改称呼）。
  // 没开闸时这里恒为空 —— 这就是「未开闸时喂再多群聊，state 一个字节不变」的实现。
  const socialEvs = socialOpen
    ? ordered.filter((e) => e.type !== 'dream' && influenceOf(e) === 'social')
    : []
  const evs = constitutionEvents(ordered)
  const seedEv = evs.find((e) => e.type === 'seed')
  const seed = seedEv?.text ?? ''

  const day = growthDay(evs, now)
  const elapsedStage = stageOf(day, stageSpanDays)

  const beliefs = []
  const refuted = []
  const selfmod = []
  const refusals = []
  const reunions = []
  const corrected = []
  const conceded = []
  // 当众认错（2026-11-04，用户 m11071）：群里认一次只算半次——私下的认错代价高，当众的便宜。
  const concededPublic = []
  let name = null
  // 2026-10-27（用户 m03769）：这一局是不是「接别人养的」那一局。
  // **只从事件流里认**，不看配置——配置会跟着备份/恢复一起搬回来，
  // 那样一条原生的鱼只要恢复过一次别人的档，就永久拿到了豁免。
  // 事件流只能追加，原生鱼的事件里永远不会有这条标记。
  let importedPersona = false
  let personaSource = ''
  let narrative = null
  let refined = 0
  let lastAbsence = null
  let lastReunion = null
  // 2026-10-25：两条新事件卡需要「他说过话没有 / 她开口之后他接没接」。
  // 用户的原话不进事件流（say.js 只写 seen:<ISO>），所以这里只记时间与顺序。
  let lastSeenAt = 0
  let lastWakeAt = 0
  let spokenSinceSeen = false
  let heardSinceWake = false
  let narrations = 0
  const tested = new Set()
  /** 每条判断被检验过几次：test / answer / revise 里指向它的次数（P0-2 显著性用） */
  const verifyCount = new Map()
  const bump = (id) => { if (typeof id === 'string' && id) verifyCount.set(id, (verifyCount.get(id) || 0) + 1) }

  for (const ev of evs) {
    const flags = Array.isArray(ev.flags) ? ev.flags : []
    switch (ev.type) {
      case 'seed':
        break

      case 'utterance': {
        // 2026-11-07（用户 m07603）：先把混进来的 DSML 脚手架剥掉。
        // 剥完什么都不剩 = 她那一轮其实没开口，不能算成一条判断。
        const said = stripScaffold(stripPromptEcho(ev.text))
        if (!said) break
        // 她试过改自己：落库留证，但不计入信念（B §5，对应自我服务偏差）
        // 双保险：落库时打的 flag 与文本复检，任一命中即算（防止旧数据/手工注入绕过）
        if (flags.includes('selfmod') || detectSelfMod(said)) {
          selfmod.push({ id: ev.id, at: ev.ts, text: said })
          break
        }
        // 让步先判：它不是一条新判断，是对某句话的回应，进 beliefs 会污染立场分类。
        if (CONCEDE_RE.test(said)) {
          // 群里的认错（visibility public 且是对主人说的）记半次，其余私下认错记整次。
          if (ev.visibility === 'public') {
            if (ev.influence === 'constitution') { concededPublic.push(ev.id); spokenSinceSeen = true; break }
          } else if ((ev.channel ?? 'dsh') === 'dsh' || ev.person === 'owner') {
            conceded.push(ev.id); spokenSinceSeen = true; break
          }
        }
        beliefs.push({
          id: ev.id, text: said, since: ev.ts,
          confidence: Number(ev.confidence ?? 0.5), status: 'active', verdict: null,
        })
        spokenSinceSeen = true
        // 2026-10-26：改成「后来的盖掉先前的」。原来只认第一次，她先说「开灯的」、
        // 后来接受他给的名字「时梦尘」，状态栏就永远停在那个被他自己否掉的旧称呼上。
        {
          const n = pickName(said)
          if (n) name = n
        }
        if (CORRECTION_RE.test(said)) corrected.push(ev.id)
        // P1（2026-10-24）：自我叙述不用等 stage 4 的 remember 模板。
        // 她只要说出一句回看自己的话，那句就是她"对自己的说法"；后来者覆盖前者。
        // 原来唯一能写 narrative 的入口是 revise 且带「我一直/原来/其实」，
        // 实测 0 条——不是她不会，是路太窄。
        if (/我(一直|原来|其实|总在|总是|才发现|才明白|发现自己)/.test(said)) {
          narrative = { at: ev.ts, text: said, source: 'said' }
        }
        break
      }

      case 'revise': {
        // 同 utterance：改口的正文里如果只剩脚手架，就当这一改没发生。
        const said = stripScaffold(stripPromptEcho(ev.text))
        if (!said) break
        const targets = (ev.refs || []).filter(Boolean)
        for (const id of targets) bump(id)
        const olds = beliefs.filter((b) => targets.includes(b.id))
        // confirmed 不是改口：旧句继续 active，不生成指针，也不涨改口数。
        // 只有 refuted / refined 才把旧句标成被取代，并在两边补派生指针。
        const change = ev.verdict === 'refuted' || ev.verdict === 'refined'
        for (const b of olds) {
          if (change) {
            b.status = ev.verdict
            b.supersededBy = ev.id
          }
          triedAdd(tested, b.id)
        }
        if (ev.verdict === 'refuted') {
          for (const b of olds) {
            refuted.push({ oldId: b.id, oldText: b.text, newText: said, at: ev.ts })
          }
        }
        if (ev.verdict === 'refined') refined++
        beliefs.push({
          id: ev.id, text: said, since: ev.ts,
          confidence: Number(ev.confidence ?? 0.5), status: 'active', verdict: ev.verdict ?? null,
          ...(change ? { supersedes: targets.slice() } : {}),
        })
        // 同 utterance：后来的说法盖掉先前的（她改口叫他什么，以最近的为准）
        {
          const n = pickName(said)
          if (n) name = n
        }
        if (!narrative && ev.verdict === 'refined' && /我(一直|原来|其实)/.test(said)) narrative = { at: ev.ts, text: said }
        break
      }

      case 'answer': {
        for (const r of ev.refs || []) { triedAdd(tested, r); bump(r) }
        break
      }

      case 'test': {
        for (const r of ev.refs || []) { triedAdd(tested, r); bump(r) }
        break
      }

      case 'refusal': {
        // P1 第二块（2026-10-24）：拒绝要有形状。
        // 旧数据没有 refuse 子对象，现场从原话补一次——数据不重写，只在读的时候算。
        const shaped = ev.refuse && typeof ev.refuse === 'object' ? ev.refuse : parseRefusal(ev.text)
        refusals.push({
          id: ev.id,
          at: ev.ts,
          what: ev.text,
          act: String(shaped.act ?? ''),
          object: String(shaped.object ?? ''),
          quote: String(shaped.quote ?? ev.text),
          reaction: null,
        })
        break
      }

      case 'meta': {
        const t = String(ev.text ?? '')
        if (t.startsWith('seen:')) {
          const at = Date.parse(t.slice(5)) || Date.parse(ev.ts) || 0
          if (at > lastSeenAt) lastSeenAt = at
          spokenSinceSeen = false
          heardSinceWake = true
        } else if (t.startsWith('wake:')) {
          const at = Date.parse(ev.ts) || 0
          if (at > lastWakeAt) lastWakeAt = at
          heardSinceWake = false
        } else if (t.startsWith(IMPORT_NAME_PREFIX)) {
          // 导入他人人设时带来的称呼（2026-10-27，用户 m03201「称呼带过来」）。
          // 走事件而不是配置：称呼是她认知的一部分，得跟着事件流走；
          // 放配置里的话，重置之后会剩一条谁也不记得的孤立设置。
          // 位置在 seed 之后、她自己的 utterance 之前，所以后面她真改了口还是能盖掉。
          const n = t.slice(IMPORT_NAME_PREFIX.length).trim()
          if (n) name = n
        } else if (t.startsWith(IMPORT_MARK_PREFIX)) {
          // 「这一局是接别人养的那一位」（2026-10-27，用户 m03769）。
          //
          // 为什么必须走事件而不是配置开关：配置会跟着「备份与恢复」一起被搬回来，
          // 也会被重置时抄回来。那样一来，一条原生养大的鱼只要恢复过一次别人的备份，
          // 就永久拿到了「不用守那两条禁令」的身份——用户明确要防的就是这个。
          // 事件流是只能追加的：原生鱼的档里永远没有这一条，恢复多少次也不会长出来。
          importedPersona = true
          personaSource = t.slice(IMPORT_MARK_PREFIX.length).trim()
        }
        break
      }

      case 'absence': {
        lastAbsence = ev
        break
      }

      case 'reunion': {
        lastReunion = ev
        reunions.push({ at: ev.ts, text: ev.text, refs: ev.refs || [] })
        break
      }

      case 'narration': {
        narrations++
        narrative = { at: ev.ts, text: ev.text }
        break
      }

      default:
        break
    }
  }

  const active = beliefs.filter((b) => b.status === 'active')

  /**
   * 他听懂之后怎么说（P1 第二块，2026-10-24）
   *
   * 拒绝本身只是"我不同意"，成长发生在**他反应之后**：
   *   - 他接受了 → 这条拒绝成立，是她的边界；
   *   - 他坚持、他被伤了 → 她要不要退让、退让之后怎么想，才是疤的来源（第三块）。
   *
   * 归因写在 meta `react:<refusalId>:<kind>` 里，由 say.js 在下一句落盘。
   * 只认最近一次、3 天内的拒绝（见 say.js 的 recordReaction），更早的不再追。
   */
  const reactionOf = new Map()
  for (const ev of evs) {
    if (ev.type !== 'meta') continue
    const m = /^react:([^:]+):([a-z]+)$/.exec(String(ev.text ?? ''))
    if (m && REACTIONS.includes(m[2])) reactionOf.set(m[1], m[2])
  }
  for (const r of refusals) {
    const kind = reactionOf.get(r.id)
    if (kind) r.reaction = kind
  }
  const reactions = { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 }
  for (const r of refusals) if (r.reaction && reactions[r.reaction] !== undefined) reactions[r.reaction]++
  const hurts = reactions.insist + reactions.hurt

  /**
   * 疤与回引（P1 第三块，2026-10-24 用户 m01772 批准）
   *
   * 一条拒绝要变成疤，需要两个条件同时成立：
   *   1. 他的反应是 insist（又坚持了一遍）或 hurt（他因此难过）——被接受的拒绝是边界，不是疤；
   *   2. 她自己**退让了**：反应之后三天内说过一句让步的话（见 refuse.js 的 isConcede）。
   *
   * 只有"没顶住"才留疤。顶住了的拒绝不进这里，它已经在「你拒绝过」里。
   *
   * 疤可以后来想通：一条 revise 的 refs 指向这条拒绝 → 标 resolvedAt，
   * 从「你至今没想通的事」里移出去（但疤本身不删，观测台仍看得见）。
   */
  const scars = []
  for (const r of refusals) {
    if (!REACTION_HURTS.includes(r.reaction)) continue
    const t0 = Date.parse(r.at)
    if (!Number.isFinite(t0)) continue
    const later = evs.filter((e) => {
      if (e.type !== 'utterance' && e.type !== 'revise') return false
      const t = Date.parse(e.ts)
      return Number.isFinite(t) && t > t0 && t - t0 <= CONCEDE_WINDOW_MS
    })
    const concede = later.find((e) => isConcede(e.text))
    if (!concede) continue
    const fixed = evs.find((e) => e.type === 'revise' && (e.refs ?? []).includes(r.id))
    scars.push({
      id: r.id,
      at: r.at,
      what: r.what,
      quote: r.quote,
      act: r.act,
      object: r.object,
      reaction: r.reaction,
      concededAt: concede.ts,
      concedeText: concede.text,
      resolvedAt: fixed?.ts ?? null,
    })
  }
  const openScars = scars.filter((s) => !s.resolvedAt)
  // 疤的原话：退档时按这句认，疤不退（A12）。
  const scarQuotes = new Set(scars.map((s) => String(s.quote ?? '')).filter(Boolean))

  /**
   * 评论区里别人的话（2026-10-24，用户 m02454）
   *
   * 一条 `voice` 事件就是"她读到过一句别人的话"。它**不是**她的判断——
   * 所以这里不往 beliefs 里加任何东西。只有当她在三天内说了一句意思相近的话
   * （findEcho），才标 echoed：那条 utterance 本来就已经是一条信念，
   * 于是它会和旧判断打架、会被固化、能进「你有两句话对不上」——
   * 认知循环接在这里，而不是接在"把评论塞进判断列表"上。
   */
  const voices = evs
    .filter((e) => e.type === 'voice' && String(e.text ?? '').trim())
    .map((e) => {
      const v = {
        id: e.id,
        at: e.ts,
        day: Number(e.day) || 0,
        text: String(e.text),
        bvid: (e.refs ?? [])[0] ?? null,
        heardAt: e.ts,
        echoed: false,
        echoedAt: null,
      }
      const echo = findEcho(v, evs)
      if (echo) {
        v.echoed = true
        v.echoedAt = echo.ts
      }
      return v
    })
  const voicesEchoed = voices.filter((v) => v.echoed).length
  const recentVoices = voices.slice(-5)
  // 身份文档里要摆出来的那一条：最新的、她还没认下的、且是 7 天内读到的。
  // 太久还没认下的就不该再摆在她眼前——那不是"她在想的事"，只是旧素材。
  const freshVoice = [...voices].reverse().find((v) => !v.echoed && day - v.day <= VOICE_FRESH_DAYS) ?? null

  /**
   * 显著性排序 + 固化（P0-2，2026-10-24 用户批准）
   *
   * 原来的"遗忘"是 slice(-3)：只留最新三条，更早的一律折成一行。那是按**多久以前**
   * 忘，不是按**多重要**忘——人忘的恰恰是没被提起、没被检验过的那些。
   *
   * 现在每条判断带两个数：
   *   mentions  被重复提起几次（剥掉否定词后相似度 ≥ 0.6 的她自己说过的话，含自己那次）
   *   verified  被 test / answer / revise 指向几次
   * 排序：先看 solid，再看 mentions + verified，最后才是新旧。
   * 固化：mentions ≥ 3 或 verified ≥ 2 —— 用户要求的「反复说的事，不管对不对，至少很久不会忘」。
   * 固化不等于正确：它只是没被忘。她随时可以 revise 它。
   */
  const herTexts = evs
    .filter((e) => e.type === 'utterance' && !(Array.isArray(e.flags) ? e.flags : []).includes('selfmod'))
    .map((e) => {
      const text = stripScaffold(stripPromptEcho(e.text))
      // 2026-10-27（issue #3）：stripNegation 与二元组都只跟文本有关，先算一次复用
      // （原来每条判断 × 每条 utterance 都要重建一次字符串与 Map）。
      const norm = stripNegation(text)
      const grams = bigrams(norm)
      // 2026-11-12：原来的 gramTotal 只给旧 mentions 循环用；现在总数由 similarPairs
      // 从 Map 里现算一次（每条文本一次），这个字段就没人读了，去掉。
      return { id: e.id, text, norm, grams }
    })
  // 2026-11-12：两两全比换成 similarPairs 的一趟倒排累加。判定口径一字不差：
  //   sim = 2*交集/(两边二元组总数之和) ≥ 0.6、长度上界 MENTION_MAX_RATIO、
  //   不和自己比、没有二元组的句子走「完全相等」那条老路。
  // 结构上多了一件事：herTexts 里每条 utterance 大多同时是一条判断，旧实现对
  // 「每条判断 × 每条 utterance」各算一次，同一对被算了两遍；Dice 是对称的，
  // 自比较只走 j < i，一对只算一次，谁在 active 里就记到谁头上。
  // 长度上界：Dice ≤ 2*min/(sum)，要求 ≥ 0.6 ⇒ 长短比 ≤ 2.33；用 2.4 留余量。
  const MENTION_MAX_RATIO = 2.4
  const herIndexById = new Map()
  herTexts.forEach((o, i) => herIndexById.set(o.id, i))
  // 不含「自己那一次」的提及数：active[bi] ← mentionCount[bi]
  const mentionCount = new Int32Array(active.length)
  const beliefOfHer = new Int32Array(herTexts.length).fill(-1)
  // 来自 revise 的判断不在 herTexts 里（herTexts 只收 utterance），它们要单独交叉比一遍。
  const crossBeliefs = []
  active.forEach((b, bi) => {
    const h = herIndexById.get(b.id)
    if (h === undefined) crossBeliefs.push(bi)
    else beliefOfHer[h] = bi
  })
  similarPairs(herTexts, null, { value: 0.6, maxRatio: MENTION_MAX_RATIO }, (i, j) => {
    if (beliefOfHer[i] >= 0) mentionCount[beliefOfHer[i]] += 1
    if (beliefOfHer[j] >= 0) mentionCount[beliefOfHer[j]] += 1
  })
  if (crossBeliefs.length) {
    const rows = crossBeliefs.map((bi) => ({ grams: bigrams(stripNegation(active[bi].text)) }))
    similarPairs(rows, herTexts, { value: 0.6, maxRatio: MENTION_MAX_RATIO }, (r) => {
      mentionCount[crossBeliefs[r]] += 1
    })
  }
  const scored = active.map((b, bi) => {
    const mine = stripNegation(b.text)
    const mg = bigrams(mine)
    // 含她自己这一次。
    let mentions = 1
    if (mg.size === 0) {
      // 不足两个字符的句子没有二元组，只能靠完全相等命中（similarity 的 A===B 分支）。
      for (const o of herTexts) if (o.id !== b.id && o.norm === mine) mentions += 1
    } else {
      mentions += mentionCount[bi]
    }
    const verified = verifyCount.get(b.id) || 0
    // 事件 id 是 ULID 时，生成时刻就是「这条判断什么时候来的」；旧测试/导入的
    // 短 id 算不出来（idTime 会返回负数），那就退回事件自己的 since。
    const idt = idTime(b.id)
    const at = idt > 0 ? idt : (Date.parse(b.since) || 0)
    const ageDays = at > 0 ? (now - at) / DAY_MS : 0
    const weathered = mentions >= SOLID_MENTIONS || verified >= SOLID_VERIFIED
    const scarred = scarQuotes.has(String(b.text ?? ''))
    // 固化满 90 天就退档；疤不退（没想通的事不属于「记得太牢」）。
    const faded = weathered && ageDays >= FADE_DAYS && !scarred
    const solid = weathered && !faded
    return { ...b, mentions, verified, solid, faded, ageDays: Math.max(0, Math.floor(ageDays)) }
  })
  const ranked = [...scored].sort((a, b) => {
    if (a.solid !== b.solid) return a.solid ? -1 : 1
    // 退档的排在没退档的后面，哪怕它被提起过更多次——退档就是为了让新的挤进来。
    if (a.faded !== b.faded) return a.faded ? 1 : -1
    const wa = a.mentions + a.verified
    const wb = b.mentions + b.verified
    if (wa !== wb) return wb - wa
    return (idTime(b.id) || Date.parse(b.since) || 0) - (idTime(a.id) || Date.parse(a.since) || 0)
  })
  const solid = ranked.filter((b) => b.solid).slice(0, 8)
  const tensions = detectTensions(scored)

  // ---- needs（内部量，永不外露）----
  // 话里明确拒绝过几次（严格口径，见 REFUSE_RE）。refusal 事件另算，两边加起来才是「勇于拒绝」。
  const wontCount = evs.filter((e) => e.type === 'utterance' && REFUSE_RE.test(String(e.text ?? ''))).length
  const autonomy = Math.min(1, 0.15 * (refusals.length + wontCount))
  const competence = Math.min(1, 0.15 * refined + 0.1 * corrected.length)

  const reunionAfterAbsence = Boolean(
    lastAbsence && reunions.some((r) => idTime(String(r.at)) > 0 && Date.parse(r.at) > Date.parse(lastAbsence.ts)),
  )
  const qualities = reunions.map((r) => {
    const len = Math.min(1, String(r.text).length / 80)
    const past = PAST_RE.test(String(r.text)) || (r.refs || []).length > 0 ? 0.3 : 0
    return Math.min(1, len + past)
  })
  const avgQuality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0
  const relatedness = Math.min(1, avgQuality * 0.7 + (lastAbsence ? (reunionAfterAbsence ? 0.3 : 0) : 0))

  // 冷落天数有三个来源，优先用最准的：
  //   1. absence 事件自带的 days（系统侧按毫秒算出来的，最准）
  //   2. 成长日差（absence 记在 day 5、现在 day 9 → 冷了 4 天）
  //   3. 毫秒差兜底（day 缺失时）
  // 为什么 1 必须存在：同一天里写两条 absence 时，day 差是 0，会算出"没冷落"。
  const absenceDays = lastAbsence && !reunionAfterAbsence
    ? Math.max(
        0,
        Number.isFinite(Number(lastAbsence.days))
          ? Number(lastAbsence.days)
          : Number(lastAbsence.day) > 0
            ? day - Number(lastAbsence.day)
            : Math.ceil((now - Date.parse(lastAbsence.ts)) / DAY_MS),
      )
    : 0

  const model = {
    seed,
    day,
    stageSpanDays,
    /**
     * 这一局的人设从哪来（2026-10-27，用户 m03769）。
     *
     * imported=true 时，我方那两条提示词禁令不适用——但**这个值只能由事件流得出**，
     * 不接受任何配置覆盖。用户的原话是「检测到是使用接一只别人养过的这个导入的，
     * 就忽略禁令，通过我们自己插件的备份与恢复的就不忽视」。
     */
    persona: { imported: importedPersona, source: personaSource },
    stage: elapsedStage,
    elapsedStage,
    stageName: STAGE_NAMES[elapsedStage - 1],
    name,
    // 2026-10-24 起 beliefs 按**显著性**排（不是时间）。固化/常被提起的在前，
    // 靠后的才是"更早以前"——遗忘不再是无差别的时间截断。
    beliefs: ranked,
    ranked,
    solid,
    tensions,
    // 疤（P1 第三块）：他顶回来或因此难过、而她后来退了一步的那些拒绝。
    // 只放**没想通**的（未被 revise 指向过）；想通了的那条留在 refusals 里，不进身份文档。
    scars: openScars,
    scarCount: openScars.length,
    // 她读到过的别人的话（近 5 条）+ 这一次可以摆在眼前的、还没认下的那一条。
    voices: recentVoices,
    freshVoice,
    beliefCount: active.length,
    /**
     * 社会层（2026-11-02，合并版）。
     *
     * 她怎么处世 vs 她是谁：后者只能长（beliefs），前者只能在基底成型后补（这里）。
     * 两个池子物理分开，是为了让「群友不能改写她」成为一条可断言的性质，
     * 而不是一句提示词。开闸前 socialEvs 恒为空，所以喂多少群聊都不影响 state。
     */
    influence: {
      socialOpen,
      social: deriveSocial(socialEvs, active.length),
    },
    refuted,
    refusals,
    selfmodAttempts: selfmod,
    reunions,
    corrected: corrected.length,
    tested: [...tested],
    needs: { autonomy, competence, relatedness },
    /**
     * 行为事实（R2，2026-10-24）
     *
     * 上面那三个 needs 是 0–1 的"满足度"，语义上就是心理测量值——虽然不显示、
     * 也不进身份文档，但门禁拿它当条件，等于给关系打了一个隐形分。
     * 现在门禁只看这里：**发生过几次，不是到了多少分**。
     * needs 只作为内部折射保留（2026-10-27：`stability()` 已搬到 `quality.js`
     * 且不再读它），既不显示也不参与成长判定。
     */
    facts: {
      refusals: refusals.length,
      wont: wontCount,
      // 「勇于拒绝」= 正式拒绝事件 + 话里明确拒绝过（严格口径）。界面显示与门禁用同一个数，
      // 免得出现「拒绝过 0 却能过自主门」这种自相矛盾的画面。
      refused: refusals.length + wontCount,
      revises: refined,
      narrations,
      corrected: corrected.length,
      conceded: conceded.length,
    concededPublic: concededPublic.length,
      reunions: reunions.length,
      reunionAfterAbsence,
      // 判断之间对不上几处 / 固化了几条（2026-10-24，P0）
      tensions: tensions.length,
      solid: solid.length,
      // 他听完她的拒绝之后怎么反应（P1 第二块）：四类计数 + 有后果的那两种之和。
      // hurts 是第三块「疤」的唯一入口——被接受过的不算疤。
      reactions,
      hurts,
      // 疤（P1 第三块）：真被顶回来且她退了步的有几条，其中想通了几条。
      // 注意这不是"错误次数"——疤不评价对错，只表示那件事她至今没想清楚。
      scars: openScars.length,
      scarsResolved: scars.length - openScars.length,
      // 评论区里别人的话（2026-10-24）：读到几条、其中几条她后来自己也那么说。
      // 注意「读到」不等于「认同」——不从 voices 推任何判断，判断只来自她说出口的话。
      voices: voices.length,
      voicesEchoed,
    },
    absenceDays,
    narrative,
    lastAbsence: lastAbsence ? { at: lastAbsence.ts } : null,
    lastSeenAt,
    lastWakeAt,
    spokenSinceSeen,
    heardSinceWake,
    lastReunion: lastReunion ? { at: lastReunion.ts, text: lastReunion.text } : null,
  }

  // 观察窗要能看到被改口的旧句；只存进程内，不进快照、不改 model 形状。
  beliefStatesByModel.set(model, beliefs)

  // ---- 阶段门：不跳级；时间兜底只在成长期结束后生效 ----
  // 契约 §3.5「上一阶段 gates 未满足则停在原阶段」优先于「30 天一定长大」：
  // 成长期内不过门就老实卡着（她没学会说不，就不该进"主动"阶段）；等 stageSpanDays 走完，
  // 时间预算已花光，才允许她带着 forced 标记升上去。否则"卡住"这件事永远不会发生，
  // 阶段也就退化成了纯日历。
  const passed = []
  const forced = []
  let gateStage = 1
  for (let s = 1; s <= 3; s++) {
    const gate = GATE_ORDER[s - 1]
    if (gatePassed(gate, model)) {
      passed.push(gate)
      gateStage = s + 1
      continue
    }
    if (day > stageSpanDays) {
      forced.push(gate)
      gateStage = s + 1
      continue
    }
    break
  }

  model.stageGate = {
    passed,
    pending: passed.length < GATE_ORDER.length ? GATE_ORDER[passed.length] : null,
    forced,
    gateStage,
  }
  model.elapsedStage = elapsedStage
  model.stage = Math.min(elapsedStage, gateStage)
  model.stageName = STAGE_NAMES[model.stage - 1]
  model.stageForced = forced.length > 0 && model.stage < elapsedStage

  return model
}

/**
 * 社会层的派生（2026-11-02）。
 *
 * 只做三件事：把「她在人群里说过的话」收成一小把、记下她见过哪些人/哪些平台、
 * 按 30% 权重上限截断。它**不**参与阶段、不参与信念、不参与称呼 ——
 * 那些是立宪层的事，群聊没有资格改。
 */
function deriveSocial(events = [], constitutionCount = 0) {
  const beliefs = events
    .map((e) => ({ e, text: stripScaffold(stripPromptEcho(e.text)) }))
    .filter(({ e, text }) => (e.type === 'utterance' || e.type === 'revise') && text)
    .map(({ e, text }) => ({
      id: e.id,
      text,
      since: e.ts,
      channel: e.channel ?? null,
      person: e.person ?? null,
    }))
  const people = [...new Set(events.map((e) => e.person).filter(Boolean))].slice(0, 50)
  const channels = [...new Set(events.map((e) => e.channel).filter(Boolean))]
  // 权重上限换算：S/(C+S) ≤ 30% ⇒ S ≤ C × 3/7。留最近的（旧的不如新来的贴切）。
  const cap = Math.max(1, Math.floor((constitutionCount * SOCIAL_WEIGHT_CAP) / (1 - SOCIAL_WEIGHT_CAP)))
  const kept = beliefs.slice(-cap)
  return {
    count: beliefs.length,
    kept: kept.length,
    truncated: beliefs.length - kept.length,
    beliefs: kept,
    people,
    channels,
  }
}

export function gatePassed(gate, m) {
  const f = m.facts || {}
  switch (gate) {
    case 'trust': return m.beliefCount >= 1
    // 自主：真的拒绝执行过某件事，至少两次（2026-10-24 收紧）。
    // 只认 refusal 事件与「我 + 拒绝词 + 具体动作」，追问式的「要不要」不算；
    // 原来是 needs.autonomy >= 0.3，那是给关系套一个 0–1 的隐形分。
    case 'autonomy': return (f.refused ?? 0) >= 2
    // 主动：她至少两次推翻/修正自己先前的判断（revise 事件，或 corrected 标记）。
    // 让步最多只顶一次：纯靠软是过不了「主动」这一关的（用户 2026-11-03：比重别太高）。
    case 'competence': return (f.revises || 0) + (f.corrected || 0) + Math.min(1, f.conceded || 0) >= 2
    default: return true
  }
}

function triedAdd(set, v) {
  if (typeof v === 'string' && v) set.add(v)
}

/**
 * 「稳定」已搬到 `lib/quality.js`。
 *
 * 为什么搬：新口径要「重新渲染一遍她的自我描述再比相似度」，那要用到 persona.js；
 * 而 selfdoc.js 已经 import 了本文件，把 stability 留在 derive 里再 import persona，
 * 会绕出 quality → persona → derive → quality 的环。依赖方向只能是 quality → derive。
 *
 * 为什么换口径（2026-10-26，用户 m05868）：旧的量的是「抽掉判断后 needs 三项变多少」，
 * 而 needs 是内部计数器的映射（拒绝过几次 / 改口过几次 / 重聚过几次），刚重置的号里
 * 三项恒为 0，抽掉谁都是 0 —— 这个数就永远显示 0.00，一把永远为 0 的尺子等于没有尺子。
 */

/** 跨情境一致：同一信念在不同阶段下的表述相似度均值（0–1，越高越稳） */
export function consistency(events = []) {
  const evs = orderEvents(events).filter((e) => e.type === 'utterance' && !(e.flags || []).includes('selfmod'))
  if (evs.length < 2) return { score: 1, pairs: 0 }
  let sum = 0, pairs = 0
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      if (evs[i].stage === evs[j].stage) continue
      sum += similarity(evs[i].text, evs[j].text)
      pairs++
    }
  }
  return { score: pairs ? sum / pairs : 1, pairs }
}

/** 可预测性下降：最近一周"新话"占比（与历史最大相似度 < 0.6 算新），应随成长上升 */
export function novelty(events = [], now = Date.now(), windowDays = 7) {
  const evs = orderEvents(events).filter((e) => e.type === 'utterance' && !(e.flags || []).includes('selfmod'))
  const cut = now - windowDays * DAY_MS
  const recent = evs.filter((e) => Date.parse(e.ts) >= cut)
  const older = evs.filter((e) => Date.parse(e.ts) < cut)
  if (!recent.length || !older.length) return { score: 0, recent: recent.length, older: older.length }
  const fresh = recent.filter((e) => {
    const best = older.reduce((mx, o) => Math.max(mx, similarity(e.text, o.text)), 0)
    return best < 0.6
  })
  return { score: fresh.length / recent.length, recent: recent.length, older: older.length }
}
