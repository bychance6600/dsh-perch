/**
 * quality.js —— 「判断漂移」里最重的那一个指标：稳定
 *
 * 为什么单独一个文件：
 *   derive.js 不能 import persona.js（persona 反过来不依赖 derive，但
 *   selfdoc.js → derive.js 已经是一条边；把 stability 留在 derive 里而它又要
 *   用到 persona 的渲染，就会绕出环）。所以把这个「要同时看见事件流与她的自我描述」
 *   的指标单独放，依赖方向是 quality → derive + persona，没有再指回来的边。
 *
 * 2026-10-26 换尺子（用户 m05868 定口径）：
 *   原来的 stability 量的是「抽掉 k 条判断后，needs 三项（autonomy/competence/relatedness）
 *   变多少」。那三个数是**内部计数器**的映射（拒绝过几次、改口过几次、重聚过几次），
 *   不是「她这个人」。刚重置的号里三项常年是 0，抽掉谁都是 0，于是稳定永远显示 0.00——
 *   一个永远为 0 的尺子等于没有尺子。
 *
 *   现在的口径就是用户那句话：「少给她几条她信的事，她还是不是她」。
 *   做法：随机抽掉 k 条她还在拿着的判断（连同那条源头事件），重新算一遍她的自我描述，
 *   和原来的比相似度。变化越大 = 她的自我越依赖那几条 = 越承重。
 *
 *   指数解读（界面上的三档由此而来）：
 *     · 接近 0：抽掉几条，她一个字都没变——那些判断其实只是记账，谁都能被替换。
 *     · 中间：她的自我长在这些事上，抽掉一条会少一块，但整体还在。
 *     · 接近 1：全部押在少数几条上，少一条就是另一个人。
 *   所以它不是一个「越大越好」的分，是一个体检值。界面文案已经同步，不再说「越接近 1 越好」。
 *
 * 2026-11-17 提速（真机 /state 冻 23 秒的主因就是这个函数）：
 *   老实现每抽一次样就 deriveSelf(剔除后的事件流) 一遍。真实账本 3399 条事件、1014 条判断，
 *   deriveSelf 约 216ms，24 遍 ≈ 8.4 秒。但 24 遍里有 22 遍的**渲染文本只差一个数字**：
 *   「更早以前」那条折叠行写「（还有 1010 条更早的…）」，抽掉 3 条不可见的判断就变成 1007。
 *   换句话说，绝大多数抽样在算同一件事。这里把「抽掉几条判断」做成了增量：
 *     · 不重放事件流，只把 base 模型（/state 已经算过的那份）的 beliefs 按 id 删掉；
 *     · 被删的判断如果原来被别的判断「提到过」（mentions），按同一套判据把增量扣回去；
 *     · 重排 / 固化 / 折叠都是这条链上的纯函数，照着原实现重算（不是近似）。
 *   只有少数抽样**真的**必须重放（改口事件、阶段门、疤、叙事句等），见 needsReal()。
 *   输出口径一个字都没变：同 events / 同参数下 {score,worst,sample,k,beliefs} 与原实现逐位相同，
 *   由 ablate.verify 开关在测试里对着真 deriveSelf 逐条对拍（见下面 verify 分支）。
 */

import {
  deriveSelf,
  similarity,
  clampInt,
  stripNegation,
  orderEvents,
  SOLID_MENTIONS,
  SOLID_VERIFIED,
  FADE_DAYS,
} from './derive.js'
import { buildSections, shownCount, SELF_DOC_BUDGET, BELIEF_FOLDED } from './persona.js'
import { isConcede } from './refuse.js'
import {
  buildStances,
  classifyStance,
  gatesDone,
  stanceExclusions,
  stanceSection,
  stanceTopic,
  STANCE_MAX,
  STANCE_MIN_GROUP,
  STANCE_MIN_MENTIONS,
  STANCE_MIN_VERIFIED,
  STANCE_SIM,
} from './stance.js'

/**
 * 「永远是同一份骨架」的小节标题。
 *
 * 为什么要把它们剔掉再比：她读到的身份文本大约三千字，其中「你是谁 / 现在 /
 * 不能做的 / 你还不会的 / 他说的事和你记得的不一样时 / 他不好受的时候」这几段在抽掉判断前后
 * **一个字都不会变**。把它们算进相似度，分母被常数撑满，任何真实变化都会被稀释成
 * 0.00 几，指数就废了。剔掉之后剩下的部分（她自己说过的话、疤、立场、对不上的话、
 * 对自己的说法）才是随事件流变化的那块。
 */
const FIXED_HEADERS = [
  '## 你是谁',
  '## 现在',
  '## 不能做的',
  '## 你还不会的',
  '## 他说的事和你记得的不一样时',
  '## 他不好受的时候',
]

function variableSelfText(model, opts = {}) {
  const shown = shownCount(opts.shown)
  const sections = buildSections(model, opts)
  const kept = []
  for (const sec of sections) {
    const text = String(sec?.text ?? '')
    if (!text) continue
    if (FIXED_HEADERS.some((h) => text.startsWith(h))) continue
    kept.push(text)
  }
  // shown 只影响「你自己说过的话」那一节里列几条，buildSections 已按它裁剪，
  // 这里再兜一次：模型换成旧调用方传进来的 beliefs 也不会突然多列。
  void shown
  return kept.join('\n')
}

/**
 * 把段表拼成「可变文本」：剔掉固定骨架，并把立场段换成事先算好的那份。
 *
 * 为什么立场段要单独换：buildSections 里唯一的重活是 buildStances——它要拿
 * 「她说过的话」两两比相似度（真实账本 136 条候选，约 210ms），而这里每次抽样
 * 只需要换掉其中几条，没必要每次重跑一遍全量比对（见 buildStancesFast）。
 */
function assembleVariableText(sections, stanceText) {
  const kept = []
  let stancePlaced = false
  for (const sec of sections) {
    const text = String(sec?.text ?? '')
    if (!text) continue
    if (FIXED_HEADERS.some((h) => text.startsWith(h))) continue
    // 精简模型渲染出来的立场段是按「前几条判断」算的，不能用；用传进来的那份。
    if (text.startsWith('## 我站哪边')) continue
    if (!stancePlaced && stanceText && text.startsWith('## 你自己说过的话')) {
      kept.push(stanceText)
      stancePlaced = true
    }
    kept.push(text)
  }
  if (stanceText && !stancePlaced) kept.push(stanceText)
  return kept.join('\n')
}

// 2026-10-27（issue #3）：stability 的抽样要跑 24 次全量 deriveSelf，而 /state
// 与心跳在事件流不变时会重复问同一件事。缓存键只认「长度 + 末条 id + 参数」：
// 事件流只追加，长度和末条 id 一起变了才是新流；重置后 id 不会复用。
const STABILITY_CACHE_LIMIT = 8
const stabilityCache = new Map()

// 2026-11-09：observe 与 socialgate 各调一次 stability，ablate 的 shown/budget 不同，
// 但喂给 deriveSelf 的 24 组 kept 事件完全一样；原来第二次要把 24 次全量 deriveSelf
// 再算一遍（启动期多约 4.2 秒）。这里只缓存「单次 deriveSelf 的结果」，不碰 stability
// 的外层结果，所以 shown/budget 的渲染差异与统计口径都不变。
const TRIAL_CACHE_LIMIT = 64
const trialCache = new Map()

function trialKey(events, opts, drop) {
  const last = events.length ? events[events.length - 1] : null
  // deriveSelf 的 stageSpanDays 默认是 30；observe 传 30、socialgate 不传，
  // 两边其实是同一个值，键里要按默认值归一，否则第二次仍然整份重算。
  return [events.length, last?.id ?? '', opts?.stageSpanDays ?? 30, opts?.now ?? '', drop].join('|')
}

function trialModel(events, opts, kept, dropKey) {
  const key = trialKey(events, opts, dropKey)
  const hit = trialCache.get(key)
  if (hit) {
    trialCache.delete(key)
    trialCache.set(key, hit)
    return hit
  }
  const model = deriveSelf(kept, opts)
  trialCache.set(key, model)
  if (trialCache.size > TRIAL_CACHE_LIMIT) {
    trialCache.delete(trialCache.keys().next().value)
  }
  return model
}

function stabilityKey(events, opts, ablate) {
  const last = events.length ? events[events.length - 1] : null
  return [
    events.length,
    last?.id ?? '',
    opts?.stageSpanDays ?? 30,
    opts?.now ?? '',
    ablate?.k ?? '',
    ablate?.trials ?? '',
    ablate?.seed ?? '',
    // shown / budget 缺省时 deriveSelf 与渲染都用默认值；按生效值归一，
    // 让 observe 的 2/1800 与 socialgate 的缺省命中同一条缓存。
    shownCount(ablate?.shown),
    ablate?.budget ?? SELF_DOC_BUDGET,
    ablate?.withBans === false ? 0 : 1,
    // 对拍模式的结果不能和正常模式混用（它可能抛错，也可能多花十倍时间）。
    ablate?.verify === true ? 'verify' : '',
  ].join('|')
}

/** 清掉缓存（测试用：多个用例之间不想互相命中）。 */
export function clearStabilityCache() {
  stabilityCache.clear()
  trialCache.clear()
  // prep 是按 base 模型对象挂的：模型对象换了自然失效，但显式清掉更省内存。
  prepCache = new WeakMap()
}

// ---------------------------------------------------------------------------
// 快路径（增量）：把「抽掉几条判断」算成对 base 模型的一次补丁
// ---------------------------------------------------------------------------

// 与 derive.js 打分那段的 similarPairs 同口径：二元组 Dice >= 0.6 才算「提到过」，
// 且两条判断的二元组数量不能差太多（maxRatio 2.4）。这两个数不许各自漂。
const MENTION_THRESHOLD = 0.6
const MENTION_MAX_RATIO = 2.4

// prep 按 base 模型对象缓存：/state 会把刚算好的 model 传进来，同一份模型上
// 24 次抽样共用一份「谁提到谁」的预处理结果。clearStabilityCache 会换新的。
let prepCache = new WeakMap()

function bigramsOf(text) {
  const s = String(text ?? '')
  const grams = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    grams.set(g, (grams.get(g) || 0) + 1)
  }
  return grams
}

function gramsTotal(grams) {
  let total = 0
  for (const n of grams.values()) total += n
  return total
}

function gramsInter(a, b) {
  let inter = 0
  for (const [g, n] of a) {
    const m = b.get(g)
    if (m) inter += Math.min(n, m)
  }
  return inter
}

/**
 * 一条判断参与「被提到」判定的形状。
 *
 * derive.js 里 mentions 用的是 stripNegation 之后的二元组（否定词先剥掉，
 * 「我不喜欢 X」和「我喜欢 X」不算两句不一样的话）。这里必须是同一份文本，
 * 否则增量扣回去的数字会和真重放对不上。
 */
function judgmentForm(text) {
  const norm = stripNegation(String(text ?? ''))
  const grams = bigramsOf(norm)
  return { norm, grams, size: grams.size, total: gramsTotal(grams) }
}

function mentionsLike(a, b) {
  if (!a || !b) return false
  if (!a.size || !b.size) return false
  const lo = Math.min(a.size, b.size)
  const hi = Math.max(a.size, b.size)
  if (hi > lo * MENTION_MAX_RATIO) return false
  const sum = a.total + b.total
  if (!sum) return false
  const inter = gramsInter(a.grams, b.grams)
  if (!inter) return false
  return (2 * inter) / sum >= MENTION_THRESHOLD
}

function stanceSinceOf(item) {
  const at = Date.parse(item?.since ?? '')
  return Number.isFinite(at) ? at : null
}

// stance.js 里的 stanceObject 没有导出；这里是逐字复刻（只用于判「是不是同一件事」）。
function stanceObjectOf(text) {
  return String(text ?? '')
    .replace(/我|绝不|永远不会|不再|不想|不愿意|不喜欢|不|喜欢|爱看|爱听|偏爱|更想|宁愿|更愿意/g, '')
    .replace(/[\s，。！？、,.!?；;：:'"「」（）()]/g, '')
}

function sameStanceTopic(a, b) {
  const ta = stanceTopic(a)
  const tb = stanceTopic(b)
  if (ta && tb) return ta === tb
  const x = stanceObjectOf(a)
  const y = stanceObjectOf(b)
  if (!x || !y) return false
  if (x === y) return true
  return similarity(x, y) >= 0.6
}

/**
 * buildStances 的冲突消解（stance.js 里的 resolveConflicts 没导出，逐字复刻）。
 *
 * 同一件事在不同 kind 下各站过一边时只留最后一次说法：哪条更新留哪条，
 * 并在留下的那条上挂 changedFrom（渲染时写成「这件事我改过口」）。
 */
function resolveStanceConflicts(groups) {
  const out = []
  for (const g of groups) {
    const clash = out.findIndex((o) => o.kind !== g.kind && sameStanceTopic(o.text, g.text))
    if (clash < 0) {
      out.push(g)
      continue
    }
    const other = out[clash]
    const a = stanceSinceOf(other)
    const b = stanceSinceOf(g)
    if (a === null || b === null || a === b) {
      out.splice(clash, 1)
      continue
    }
    if (b > a) {
      g.changedFrom = other.text
      out.splice(clash, 1)
      out.push(g)
    } else {
      other.changedFrom = g.text
    }
  }
  return out
}

/**
 * 复刻 buildStances，但只遍历「会被 classifyStance 认出来」的判断。
 *
 * 为什么可以这样省：原实现的外层遍历里，classifyStance 为空的判断直接 continue，
 * 内层也要求 kind 相同，所以它们永远进不了 used、也永远成不了组员——
 * 跳过它们不改变任何结果。真实账本 1014 条判断里只有 136 条会被认出来，
 * 而两两比相似度正是 buildStances 的全部耗时（约 210ms）。
 *
 * 相似度按「id 对」缓存：同一条判断的文本在抽掉别的判断时不会变，
 * 所以不同抽样之间可以复用（pairSim 跟着 base 模型走，见 buildMeta）。
 */
function buildStancesFast(model, exclusions, pairSim) {
  if (!gatesDone(model)) return []
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  const scars = Array.isArray(model.scars) ? model.scars : []
  const live = []
  for (const b of beliefs) {
    if (b.status && b.status !== 'active') continue
    if (exclusions.has(String(b.id ?? ''))) continue
    const kind = classifyStance(b.text)
    if (!kind) continue
    live.push({ b, kind, topic: kind === 'boundary' ? stanceTopic(b.text) : '' })
  }
  const simOf = (a, b) => {
    const ia = String(a?.id ?? '')
    const ib = String(b?.id ?? '')
    const key = ia <= ib ? ia + '\u0000' + ib : ib + '\u0000' + ia
    const hit = pairSim.get(key)
    if (hit !== undefined) return hit
    const sim = similarity(a?.text, b?.text)
    pairSim.set(key, sim)
    return sim
  }
  const used = new Set()
  const groups = []
  for (const entry of live) {
    if (used.has(entry.b.id)) continue
    const kind = entry.kind
    const group = [entry.b]
    used.add(entry.b.id)
    for (const other of live) {
      if (used.has(other.b.id)) continue
      if (other.kind !== kind) continue
      if (kind === 'boundary') {
        if (entry.topic) {
          if (other.topic !== entry.topic) continue
        } else if (other.topic) {
          continue
        } else if (simOf(entry.b, other.b) < STANCE_SIM) {
          continue
        }
      } else if (simOf(entry.b, other.b) < STANCE_SIM) {
        continue
      }
      group.push(other.b)
      used.add(other.b.id)
    }
    let mentions = 0
    let verified = 0
    for (const one of group) {
      mentions += Number(one.mentions ?? 0)
      verified += Number(one.verified ?? 0)
    }
    const anchor = String(group[0].text ?? '')
    let scarHits = 0
    for (const s of scars) {
      if (similarity(s?.quote ?? '', anchor) >= STANCE_SIM) scarHits++
    }
    const backed = scarHits > 0 || mentions >= STANCE_MIN_MENTIONS || verified >= STANCE_MIN_VERIFIED
    if (group.length < STANCE_MIN_GROUP && !backed) continue
    if (kind === 'boundary' && !entry.topic && group.length < 3 && !backed) continue
    const last = group[group.length - 1]
    groups.push({
      kind,
      text: String(last.text ?? '').trim(),
      members: group.map((x) => x.id),
      since: last.since ?? null,
      mentions,
      verified,
      scars: scarHits,
      backed,
    })
  }
  const resolved = resolveStanceConflicts(groups)
  resolved.sort((a, b) => (b.scars - a.scars) || ((b.mentions + b.verified) - (a.mentions + a.verified)))
  return resolved.slice(0, STANCE_MAX)
}

/**
 * base 模型的预处理：一次算好，24 次抽样共用。
 *
 * 这里只算「不随抽样变的东西」：每条判断的文本形状（给 mentions 增量用）、
 * 哪些判断会被立场认出来、对不上的那几句、疤里那句退让、事件的先后顺序。
 */
function buildMeta(events, base, eventsById, exclusionsArr, exclusionsKey, eventsKey) {
  const beliefs = Array.isArray(base.beliefs) ? base.beliefs : []
  const byId = new Map()
  const forms = new Map()
  for (const b of beliefs) {
    const id = String(b?.id ?? '')
    if (!id) continue
    byId.set(id, b)
    forms.set(id, judgmentForm(b.text))
  }
  // 判断只有两个来源：utterance（她说过的话）和 revise（改口声明）。
  // revise 来的判断不在 herTexts 里，derive.js 对它的 mentions 是**单向**加的
  // （只加它自己，不改对方），所以抽掉别的判断时它也可能要减——见 buildPatched。
  const crossIds = new Set()
  for (const id of byId.keys()) {
    const ev = eventsById.get(id)
    if (!ev || ev.type !== 'utterance') crossIds.add(id)
  }
  const truthy = new Set()
  for (const b of beliefs) {
    if (classifyStance(b?.text)) truthy.add(String(b.id ?? ''))
  }
  // detectTensions 只渲染前 3 对里的第一对，但删掉任何一对都可能让后面的顶上来，
  // 所以保守地把 3 对里的 id 全算进敏感集合。
  const tensionIds = new Set()
  for (const t of Array.isArray(base.tensions) ? base.tensions : []) {
    if (t?.a?.id) tensionIds.add(String(t.a.id))
    if (t?.b?.id) tensionIds.add(String(t.b.id))
  }
  // 疤的「她后来还是让了」那句原文：抽掉它会让疤里的那句话变（甚至整条疤消失）。
  // 只在有疤时才有意义，真实账本多数情况下是空的。
  const scarConcede = new Set()
  for (const s of Array.isArray(base.scars) ? base.scars : []) {
    const text = String(s?.concedeText ?? '')
    if (text) scarConcede.add(text)
  }
  // 重排的兜底顺序：derive.js 的 ranked 用稳定排序，输入是 active 的顺序，
  // 也就是事件流里判断被 push 的顺序。补丁模型按同一个顺序摆回去，
  // 再套同一个比较器，平手的相对位置才对得上。
  const ordered = orderEvents(events.filter((e) => e?.influence !== 'none'))
  const evsOrder = []
  for (const ev of ordered) {
    if (ev?.type !== 'utterance' && ev?.type !== 'revise') continue
    const id = String(ev?.id ?? '')
    if (byId.has(id)) evsOrder.push(id)
  }
  const exclusions = new Set(exclusionsArr)
  const pairSim = new Map()
  const stances = buildStancesFast(base, exclusions, pairSim)
  return {
    eventsKey,
    exclusionsKey,
    events: eventsById,
    byId,
    forms,
    crossIds,
    truthy,
    tensionIds,
    scarConcede,
    evsOrder,
    exclusions,
    pairSim,
    stances,
  }
}

function baseMeta(events, base, eventsById) {
  const exclusionsArr = stanceExclusions()
  const exclusionsKey = exclusionsArr.join('\u0000')
  const last = events.length ? events[events.length - 1] : null
  const eventsKey = String(events.length) + '|' + (last?.id ?? '')
  const cached = prepCache.get(base)
  if (cached && cached.eventsKey === eventsKey && cached.exclusionsKey === exclusionsKey) return cached
  const meta = buildMeta(events, base, eventsById, exclusionsArr, exclusionsKey, eventsKey)
  prepCache.set(base, meta)
  return meta
}

/**
 * 这次抽样能不能走补丁（不走真重放）。
 *
 * 只有「抽掉一条普通的 utterance 判断」才安全：她的判断、固化、折叠、立场全都是
 * 这些判断的纯函数，删一条就是少一条。下面这些情况会改到别的东西，必须真跑：
 *   · 改口（revise）事件被抽掉：它推翻的旧判断会复活、被打脸那段会少一条；
 *   · 叙事句被抽掉：narrative 是「最后说的一句回看自己的话」，要退回到更早那句；
 *   · 对不上（tensions）里的一句被抽掉：后面对不上的可能顶上来；
 *   · 疤里那句退让被抽掉：疤的措辞会变；
 *   · 阶段门/「勇于拒绝」这类计数掉到阈值以下：她可能整阶段退回去。
 */
function needsReal(base, meta, drop) {
  const removed = drop.size
  for (const id of drop) {
    const event = meta.events.get(id)
    if (!event || event.type !== 'utterance') return true
    if (meta.scarConcede.size && isConcede(event.text)) return true
    if (meta.tensionIds.has(id)) return true
    const b = meta.byId.get(id)
    if (!b) return true
    if (base.narrative?.source === 'said' && b.text === base.narrative.text) return true
  }
  if (Number(base.beliefCount ?? 0) - removed < 1) return true
  const facts = base.facts
  if (!facts) return true
  // 自主门：facts.refused = 拒绝事件 + 话里明确拒绝过。抽掉的 utterance 至多让 wont 少 1。
  const autonomy = Number(facts.refused ?? 0)
  if (autonomy >= 2 && autonomy - removed < 2) return true
  // 能力门：改口（refined）+ 更正 + 认错（当众只算半次）。抽 utterance 只可能减更正/认错。
  const competence =
    Number(facts.revises || 0) + Number(facts.corrected || 0) + Math.min(1, Number(facts.conceded || 0))
  if (competence >= 2 && competence - removed < 2) return true
  return false
}

function applyMentionDelta(b, removedMentions) {
  if (!removedMentions) return b
  const verified = Number(b.verified ?? 0)
  const mentions = Number(b.mentions ?? 1) - removedMentions
  const oldWeathered = Number(b.mentions ?? 0) >= SOLID_MENTIONS || verified >= SOLID_VERIFIED
  // 疤不退档：derive.js 里 scarred 只看文本对不对得上疤的原话，与 weathering 无关。
  // 这里只在「会被用到」的那一支需要知道它（老状态已经 weathered 且过了 90 天），
  // 那时 faded 的取值反过来就告诉我们 scarred 是什么。
  const scarred = oldWeathered && Number(b.ageDays ?? 0) >= FADE_DAYS ? !b.faded : false
  const weathered = mentions >= SOLID_MENTIONS || verified >= SOLID_VERIFIED
  const faded = weathered && Number(b.ageDays ?? 0) >= FADE_DAYS && !scarred
  return { ...b, mentions, faded, solid: weathered && !faded }
}

/** derive.js 里 ranked 的比较器（不加平手兜底：V8 排序稳定，按事件顺序摆好即可）。 */
function rankCompare(a, b) {
  if (a.solid !== b.solid) return a.solid ? -1 : 1
  if (a.faded !== b.faded) return a.faded ? 1 : -1
  const wa = a.mentions + a.verified
  const wb = b.mentions + b.verified
  if (wa !== wb) return wb - wa
  return (Date.parse(b.since) || 0) - (Date.parse(a.since) || 0)
}

/**
 * 补丁模型：base 的 beliefs 去掉 drop 里的那几条，别的字段原样沿用。
 *
 * 为什么「别的字段原样沿用」是对的：她自我描述里随判断变的部分只有
 * 「你自己说过的话 / 反复想起过的事 / 更早以前（折叠）/ 立场 / 对不上」，
 * 这五处要么直接读 beliefs，要么是 beliefs 的纯函数；其余（疤、拒绝、叙事、
 * 改口记录、近况）都由别的事件算出来，抽一条普通判断动不到它们（needsReal 已挡）。
 */
function buildPatched(base, meta, drop) {
  const delta = new Map()
  for (const id of drop) {
    const x = meta.byId.get(id)
    const xf = meta.forms.get(id)
    if (!x || !xf) continue
    // 一句话被提到几次：mentions = 1 + 它和别的 utterance 判断对里「像」的次数。
    // 只有它本来 >1 才可能扣到别人头上（否则它没有配对对象）。
    const scanHer = Number(x.mentions ?? 0) > 1
    for (const y of base.beliefs) {
      if (y.id === id) continue
      const yCross = meta.crossIds.has(y.id)
      // revise 来的判断是单向计数的：它被 herTexts 提到就自己 +1，
      // 所以不管 x 的 mentions 是几，都要单独看它一眼。
      if (!yCross && !scanHer) continue
      const yf = meta.forms.get(y.id)
      if (!yf) continue
      let hit = false
      if (yf.size === 0) {
        // 剥完否定词什么都不剩的判断（比如纯标点）：derive.js 按「整句相等」数。
        hit = !yCross && xf.norm === yf.norm
      } else {
        hit = mentionsLike(xf, yf)
      }
      if (hit) delta.set(y.id, (delta.get(y.id) || 0) + 1)
    }
  }
  const patched = []
  const seen = new Set()
  for (const id of meta.evsOrder) {
    if (drop.has(id) || seen.has(id)) continue
    const b = meta.byId.get(id)
    if (!b) continue
    seen.add(id)
    patched.push(applyMentionDelta(b, delta.get(id) || 0))
  }
  // 兜底：万一 base 里有判断不在事件流顺序表里（外部传进来的模型形状怪），
  // 也要留着，不然会静默少一条。
  for (const b of base.beliefs) {
    const id = String(b?.id ?? '')
    if (!id || drop.has(id) || seen.has(id)) continue
    seen.add(id)
    patched.push(applyMentionDelta(b, delta.get(id) || 0))
  }
  patched.sort(rankCompare)
  return {
    model: {
      ...base,
      beliefs: patched,
      ranked: patched,
      beliefCount: patched.length,
      solid: patched.filter((b) => b.solid).slice(0, 8),
    },
    touched: delta,
  }
}

/**
 * 精简渲染：只把「折叠窗口以内」的判断留给 buildSections，其余用空文本占位。
 *
 * 为什么这样能省：buildSections 里唯一的重活是立场段（buildStances 两两比相似度），
 * 而它只看被 classifyStance 认出来的判断。占位判断的 text 是空串，认不出来，
 * 于是立场段这次渲染是空的（由调用方插入事先算好的 stanceText）。
 * 「你自己说过的话」只取前 shown 条，「更早以前」只取紧接其后的 3 条，
 * 剩下的只需要**知道条数**（折叠行里那个「还有 N 条」），所以空占位就够。
 * 判断太少（不超过 shown + 折叠数）时不做精简，直接走原渲染。
 */
function fastSelfText(model, renderOpts, stanceText) {
  const shown = shownCount(renderOpts?.shown)
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  const headLen = Math.min(beliefs.length, shown + BELIEF_FOLDED)
  if (headLen >= beliefs.length) return null
  const reduced = beliefs.slice(0, headLen)
  for (let i = headLen; i < beliefs.length; i++) {
    // 空文本 + 独立 id：不参与立场分类，也不出现在任何段落的正文里。
    reduced.push({ id: '__stability_fold_' + i, text: '' })
  }
  const sections = buildSections({ ...model, beliefs: reduced, ranked: reduced }, renderOpts)
  return assembleVariableText(sections, stanceText)
}

/** opts.model 是不是一份能直接当 base 用的模型（/state 已经算过 deriveSelf 时就走这条路）。 */
function usableModel(model, eventsById) {
  if (!model || typeof model !== 'object') return false
  if (!Array.isArray(model.beliefs) || !Array.isArray(model.ranked)) return false
  if (!Array.isArray(model.solid) || !Array.isArray(model.tensions)) return false
  if (!Array.isArray(model.refuted) || !Array.isArray(model.scars)) return false
  if (!Array.isArray(model.refusals) || !Array.isArray(model.selfmodAttempts)) return false
  if (!model.facts || !model.stageGate) return false
  if (!Number.isFinite(Number(model.beliefCount))) return false
  for (const b of model.beliefs) {
    if (!b || typeof b.id !== 'string' || !b.id) return false
    if (!Number.isFinite(Number(b.mentions))) return false
    // 判断必须能对回事件：补丁按事件顺序摆位、按事件类型判要不要真重放，全靠这张表。
    if (!eventsById.has(b.id)) return false
  }
  return true
}

function mapEventsById(events) {
  const map = new Map()
  for (const ev of events) {
    if (ev?.id) map.set(String(ev.id), ev)
  }
  return map
}

/**
 * 稳定（承重度）：抽掉 k 条她还在拿着的判断，看她还是不是她。
 *
 * @param {object[]} events 事件流
 * @param {object}   opts   传给 deriveSelf 的选项（stageSpanDays / now / model）
 * @param {object}   ablate { k, trials, seed, shown, budget, withBans, verify }
 * @returns {{score:number, worst:number, sample:number, k:number, beliefs:number}}
 *   score  = 平均变化量（0 = 完全没变，1 = 完全是另一个人）
 *   worst  = 单次最大变化量
 *   sample = 实际跑了多少次抽样
 *   k      = 每次抽掉几条（她判断不够 k 条时按实际条数）
 *   beliefs= 参与抽样的判断条数（0 表示她还没有判断，测不出来）
 */
export function stability(events = [], opts = {}, ablate = {}) {
  const verify = ablate?.verify === true
  // 2026-10-27（issue #3）：/state 每次请求和心跳都会重跑这份 24 次抽样，
  // 而事件流在同一秒内不会变。按「事件流指纹 + 参数」缓存，指纹只认长度与末条 id
  // （事件流只追加，这两项变了才算新流）。对拍模式不读也不写缓存。
  const key = stabilityKey(events, opts, ablate)
  if (!verify) {
    const hit = stabilityCache.get(key)
    if (hit) return hit
  }
  const k = clampInt(ablate.k ?? 3, 1, 10, 3)
  const trials = clampInt(ablate.trials ?? 24, 1, 200, 24)
  const seed = Number.isFinite(ablate.seed) ? ablate.seed : 42
  const renderOpts = {
    shown: ablate.shown,
    budget: ablate.budget,
    withBans: ablate.withBans !== false,
  }

  const eventsById = mapEventsById(events)
  // /state 在调 stability 之前已经算过 deriveSelf 了（observe.js 把 model 传进来）。
  // 再算一遍纯属浪费——真实账本上一份 deriveSelf 就要 216ms，而 24 次抽样全都建立在
  // 同一个 base 上。传进来的模型形状不对、或调用方用 modelFor 声明了它来自别的账本就
  // 退回自己算——保证老调用方的输出一个字都不变，也不给假数。
  const provided = opts?.model
  // 调用方传了 modelFor 就是明确声明「这份模型是从这个事件数组算出来的」：不是同一个数组
  // （比如别的调用方缓存了一份旧模型）就不认，宁可自己重算——错的最少只是慢。
  const sameStream = opts?.modelFor === undefined ? true : opts.modelFor === events
  const base = sameStream && usableModel(provided, eventsById)
    ? provided
    : trialModel(events, opts, events, '')
  const beliefIds = (base.beliefs ?? []).map((b) => b.id).filter(Boolean)
  if (beliefIds.length === 0) return { score: 0, worst: 0, sample: 0, k: 0, beliefs: 0 }

  const meta = baseMeta(events, base, eventsById)
  const stanceTextBase = stanceSection(meta.stances)
  const fastBaseText = fastSelfText(base, renderOpts, stanceTextBase)
  const baseText = fastBaseText === null ? variableSelfText(base, renderOpts) : fastBaseText

  if (verify) {
    // 对拍点一：精简渲染 + 快版立场，必须和全量渲染逐字相同。
    const realBaseText = variableSelfText(base, renderOpts)
    if (realBaseText !== baseText) {
      throw new Error(
        'stability(verify): base 文本对不上\n'
          + diffHint(realBaseText, baseText),
      )
    }
    const realStance = stanceSection(buildStances(base))
    if (realStance !== stanceTextBase) {
      throw new Error(
        'stability(verify): 快版立场段对不上真版 buildStances\n'
          + diffHint(realStance, stanceTextBase),
      )
    }
  }

  const rnd = mulberry32(seed)
  const take = Math.min(k, beliefIds.length)
  const textCache = new Map()
  const mismatches = []
  let forced = 0
  let worst = 0
  let sum = 0
  let sample = 0

  for (let t = 0; t < trials; t++) {
    const pool = [...beliefIds]
    const drop = new Set()
    for (let i = 0; i < take && pool.length; i++) {
      drop.add(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    }
    // 那条判断的源头事件可能是一条 utterance，也可能是一条 revise——
    // 按 id 删，不按类型删。删 revise 会让它推翻的旧判断复活，那是真实的变化。
    const dropKey = [...drop].sort().join(',')
    let text
    if (!needsReal(base, meta, drop)) {
      // 同一组 drop 只渲染一次：判断少的时候 24 次抽样会撞上同一组（老实现靠
      // trialCache 也等于只算一次），这里保持一致，顺便省掉重复渲染。
      const cached = textCache.get(dropKey)
      if (cached !== undefined) {
        text = cached
      } else {
        const { model: patched, touched } = buildPatched(base, meta, drop)
        let needStance = false
        for (const id of drop) {
          if (meta.truthy.has(String(id))) { needStance = true; break }
        }
        if (!needStance) {
          for (const id of touched.keys()) {
            if (meta.truthy.has(String(id))) { needStance = true; break }
          }
        }
        const stances = needStance ? buildStancesFast(patched, meta.exclusions, meta.pairSim) : meta.stances
        const stanceText = needStance ? stanceSection(stances) : stanceTextBase
        const fast = fastSelfText(patched, renderOpts, stanceText)
        text = fast === null ? variableSelfText(patched, renderOpts) : fast
        textCache.set(dropKey, text)
      }
    } else {
      forced++
      const kept = events.filter((e) => !drop.has(e.id))
      text = variableSelfText(trialModel(events, opts, kept, dropKey), renderOpts)
    }

    if (verify) {
      // 对拍点二：每一条走补丁的抽样都真跑一遍 deriveSelf(kept)，逐字比文本。
      const kept = events.filter((e) => !drop.has(e.id))
      const realText = variableSelfText(trialModel(events, opts, kept, dropKey), renderOpts)
      if (realText !== text) {
        mismatches.push({ trial: t, drop: [...drop], realText, fastText: text })
      }
    }

    const drift = 1 - similarity(baseText, text)
    sum += drift
    if (drift > worst) worst = drift
    sample++
  }

  if (verify && mismatches.length) {
    const first = mismatches[0]
    throw new Error(
      'stability(verify): ' + mismatches.length + '/' + sample + ' 处抽样对不上（真 deriveSelf vs 补丁）\n'
        + '首个不一致 trial=' + first.trial + ' drop=' + JSON.stringify(first.drop) + '\n'
        + diffHint(first.realText, first.fastText),
    )
  }
  if (verify) {
    // verify 模式下 forced 只用于冒烟：真实账本上通常会有一部分抽样必须真重放。
    void forced
  }

  const result = {
    score: sample ? sum / sample : 0,
    worst,
    sample,
    k: take,
    beliefs: beliefIds.length,
  }
  if (!verify) {
    stabilityCache.set(key, result)
    if (stabilityCache.size > STABILITY_CACHE_LIMIT) {
      stabilityCache.delete(stabilityCache.keys().next().value)
    }
  }
  return result
}

/** 第一处差异的前后文（对拍抛错时用；只在失败路径上跑，不影响热路径）。 */
function diffHint(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  let i = 0
  while (i < left.length && i < right.length && left[i] === right[i]) i++
  const from = Math.max(0, i - 40)
  return [
    '第一处差异在第 ' + i + ' 个字：',
    '  真值 …' + left.slice(from, i + 60) + '…',
    '  补丁 …' + right.slice(from, i + 60) + '…',
  ].join('\n')
}

/**
 * 稳定的三档判读。界面只显示这一句，不显示阈值。
 *
 * 为什么给三档而不是「越高越好」：这个指数的两端都是病。
 * 阈值取 0.02 / 0.35 是看她的真实数据定的——抽 3 条、她只有五六条判断时，
 * 只要真动到可见的那几条，变化量就在 0.3 以上；抽空了都没动，就是 0.00 附近。
 */
export function stabilityBand(v) {
  const beliefs = Number(v?.beliefs ?? 0)
  const sample = Number(v?.sample ?? 0)
  if (!sample || beliefs === 0) return '还没攒到判断，测不出来'
  if (beliefs <= 3) return '只有 ' + beliefs + ' 条判断，抽掉一条就是一大块'
  const score = Number(v?.score ?? 0)
  if (score < 0.02) return '这些判断还只是记账，抽掉几条她没变'
  if (score > 0.35) return '全压在这几条上，少一条就是另一个人'
  return '长在这些事上，抽掉一条少一块'
}

function mulberry32(a) {
  return function next() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
