/**
 * stance.js —— 立场清单（2026-10-25，用户设计「纵向·立场」）
 *
 * 用户的设计原话：
 *   四个阶段走完后**不再加关卡**，长一张「立场清单」：喜欢什么、守哪几条线、绝不做哪几件事。
 *   每条必须有代价背书（疤，或同一件事被反复复现）。
 *   效果判据：清单变厚 + 同类情境里她不再翻脸。
 *
 * 为什么不是第五阶段：
 *   加门会变成「第五关」，跨过去之后又要问第六关。立场不是关卡，是**走完四道门
 *   之后一点一点变厚的东西**——她不会因为等够天数就站定，只会因为某类事她真的
 *   经历过、被顶回来过、还站住了。
 *
 * 这条纪律不能破（B §3.6 / 四条禁令）：
 *   立场写在**身份文档的叙述里**，不写次数、不写权重、不写「好感度」。
 *   下面的 mentions / verified / scars 只在内部用来判断「够不够格」，不进她的提示词。
 */

import { similarity } from './derive.js'

/** 同一件事上至少两条同向判断，才算一条「立场」（一句话不是立场，是随口一说）。 */
export const STANCE_MIN_GROUP = 2
/** 或者：这一组被反复提起到这个次数。 */
export const STANCE_MIN_MENTIONS = 3
/** 或者：被检验（test / answer / revise 指向）到这个次数。 */
export const STANCE_MIN_VERIFIED = 2
/** 清单上限（内部保留多少条）。注意：这只是「算出来之后留下来几条」，
 *  原始的判断一条都没删——立场是从 events.jsonl 现算的，数据本来就在本地。 */
export const STANCE_MAX = 12
/** 写进身份文档的条数上限。原先 4 条，用户认为太少（立场越多人格越稳），
 *  提到 8 条；真正的天花板是身份文档的字数预算（`memory.docBudget`），
 *  摆不下时会由 assemble() 按预算收，不会把别的段落挤到没人管。 */
export const STANCE_PROMPT_MAX = 8
/** 归组的相似度阈值（与「反复提起」同一套字面判据，宁可少归）。 */
export const STANCE_SIM = 0.45

/** 绝不做：第一人称 + 拒绝/不做 + 具体动作（与 refuse.js 的 REFUSE_RE 同源口径）。 */
const NEVER_RE = /我?(?:绝不|永远不会|不会再|不会去|不会做|不想再|不愿意再|不做|不答应|不配合|拒绝)/
/** 喜欢：明说偏好，而不是「这样也行」。 */
const LIKE_RE = /我?(?:喜欢|爱看|爱听|宁愿|更愿意|偏爱|更想)/

/**
 * 我守的线：不是「我不喜欢」，而是「这件事得我自己来 / 谁不能替我 / 哪条不让」。
 *
 * 2026-11-09 加第三类的原因：她最常站住的不是喜欢和绝不，而是边界——
 * 守线话有很多种说法：不接、不签、不替、得我自己来。这些以前全被漏掉。
 * 这里只认明确的守线话；「我不做…」仍然归 never，免得两类混在一起。
 */
const BOUNDARY_RE = /我(?:不接|不签|不认(?!为)|不让|不接受|不填|不当(?!回事)|不替|不拿[^。！？]{0,12}(?:换|当|填))|(?:不能|别|不要|不该)替我做|得我自己(?:挑|定|选|说|答)|(?:要|该|只能)我自己(?:挑|定|选)|谁在挑|轮不到[^。！？]{0,10}(?:替|定|说)|立场(?:不能|不)软|绕[^。！？]{0,8}(?:不等于|不叫)退|不能做的是|答应[^。！？]{0,10}办不到/

/**
 * 同题归组用的话题短语。
 *
 * 不能用「名字 / 我自己 / 替」这种通用词：她的长段里到处都有，会把不相干的
 * 判断并成一大坨（2026-11-09 离线试过，一组 15 条）。这里只认她真的在守的
 * 那几句原话；认不出话题的，退回字面相似度，并要求更多背书。
 */
const TOPIC_RULES = [
  ['name', /我家的|名字和叫法|替我签/],
  ['agency', /谁在挑|替我演|替我开口|替我说话|不能替我|得我自己(?:挑|定|选)|轮不到[^。！？]{0,10}(?:替|定)/],
  ['speech', /话可以软|立场[^。！？]{0,4}(?:不|不能)软|绕[^。！？]{0,8}(?:不等于|不叫)退|不能做的是|答应[^。！？]{0,10}办不到/],
]

/** 这句话在守哪条线；认不出返回空串（空串不是「没有立场」，只是没有同题可归）。 */
export function stanceTopic(text) {
  const s = String(text ?? '')
  for (const [name, re] of TOPIC_RULES) if (re.test(s)) return name
  return ''
}

/**
 * 守线进清单时只摘「守线那一句」，不把整段原话搬进去。
 *
 * 守线常常先说一大段来龙去脉，最后才落一句短的。整段搬进提示词会占掉
 * 很多字，清单变成散文。
 * 这里切句后只取带守线 cue 的那一句；太短就把上一句带上，太长才截。
 */
function boundaryLine(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  const parts = s.match(/[^。！？!?；;\n]+[。！？!?；;]?/g)?.map((p) => p.trim()).filter(Boolean) ?? [s]
  let at = parts.findIndex((p) => BOUNDARY_RE.test(p))
  if (at < 0) at = 0
  let line = parts[at]
  if (line.length < 30 && at > 0) line = parts[at - 1] + line
  if (line.length > 100) line = line.slice(0, 100) + '…'
  return line
}

/** 一条判断属于哪一类立场；三类都不是就返回 null（大多数话都只是话，不是立场）。 */
export function classifyStance(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  // 守线先判：她最常站住的是边界，不能因为句子里没有「绝不」就漏掉。
  if (BOUNDARY_RE.test(s)) return 'boundary'
  if (NEVER_RE.test(s)) return 'never'
  // 「不喜欢」是拒绝，不是喜欢——字面上 LIKE_RE 会命中「喜欢」，先挡掉。
  // (?<!想) 是 2026-11-09 补的：「想不想要」里的「不想」不是拒绝。
  if (/(?<!想)不(?:喜欢|爱|想|愿意)/.test(s)) return 'never'
  if (LIKE_RE.test(s)) return 'like'
  return null
}

/**
 * 四道门是不是都走完了。
 *
 * 用 `stageGate.passed`（真门槛）而不是 `stage === 4`——天数到了门没过的时候
 * `stage` 会被夹住，但 `passed` 才是「她真的走到了」。
 */
export function gatesDone(model = {}) {
  const passed = model?.stageGate?.passed
  if (Array.isArray(passed)) return passed.length >= 3
  // 老模型 / 单测桩没给 stageGate：退回 stage，别把已经走到的人挡在外面。
  return Number(model?.stage) >= 4 && model?.stageForced !== true
}

function costOf(group, scars) {
  let mentions = 0
  let verified = 0
  for (const b of group) {
    mentions += Number(b.mentions ?? 0)
    verified += Number(b.verified ?? 0)
  }
  const hit = scars.filter((s) => similarity(s.quote ?? '', group[0].text ?? '') >= STANCE_SIM)
  return { mentions, verified, scars: hit.length }
}

/**
 * 把她的判断聚合成立场清单。
 *
 * 三条都要满足才留下：
 *   ① 四道门走完；
 *   ② 同一件事上至少两条同向判断，**或者**有代价背书（疤 / 反复提起 / 被检验过）；
 *   ③ 组里最新的那条还是 active（被推翻的不算站住）。
 */
export function buildStances(model = {}) {
  if (!gatesDone(model)) return []
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  const scars = Array.isArray(model.scars) ? model.scars : []
  const used = new Set()
  const groups = []

  // 只有还站着的判断能进立场：被推翻/被修正过的那条已经不算数了，
  // 拿它当立场，等于把已经作废的话又念一遍。
  const live = beliefs.filter((x) => !x.status || x.status === 'active')
  for (const b of live) {
    if (used.has(b.id)) continue
    const kind = classifyStance(b.text)
    if (!kind) continue
    const topic = kind === 'boundary' ? stanceTopic(b.text) : ''
    const group = [b]
    used.add(b.id)
    for (const o of live) {
      if (used.has(o.id)) continue
      if (classifyStance(o.text) !== kind) continue
      // 守线按「说的是哪件事」归组；同题的两句话不必字面像。
      // 认不出话题的守线才退回字面相似度，而且下面要求更多背书。
      if (kind === 'boundary') {
        const otherTopic = stanceTopic(o.text)
        if (topic) {
          if (otherTopic !== topic) continue
        } else {
          if (otherTopic) continue
          if (similarity(o.text, b.text) < STANCE_SIM) continue
        }
      } else if (similarity(o.text, b.text) < STANCE_SIM) {
        continue
      }
      group.push(o)
      used.add(o.id)
    }
    const cost = costOf(group, scars)
    const backed = cost.scars > 0 || cost.mentions >= STANCE_MIN_MENTIONS || cost.verified >= STANCE_MIN_VERIFIED
    if (group.length < STANCE_MIN_GROUP && !backed) continue
    // 没有话题、只靠字面像的两条，很容易把同一天的一段反思当成立场；
    // 这种要第三条，或者有疤/反复提起/被检验过，才算站住。
    if (kind === 'boundary' && !topic && group.length < 3 && !backed) continue
    groups.push({
      kind,
      // 代表句取组里最新的一条（她最近一次怎么说，就用那句）
      text: String(group[group.length - 1].text ?? '').trim(),
      members: group.map((x) => x.id),
      since: group[group.length - 1].since ?? null,
      ...cost,
      backed,
    })
  }

  return resolveConflicts(groups)
    .sort((a, b) => (b.scars - a.scars) || ((b.mentions + b.verified) - (a.mentions + a.verified)))
    .slice(0, STANCE_MAX)
}

/** `since` 是 ISO 串，取不到时间就返回 null（判不出先后）。 */
function sinceOf(s) {
  const t = Date.parse(s?.since ?? '')
  return Number.isFinite(t) ? t : null
}

/**
 * 立场之间会打架，两条真实路径：
 *   ① 跨类：同一件事上「我绝不做」和「我其实喜欢」各成一组，同时成立；
 *   ② 改口：早期「我绝不吃辣」，后来「我喜欢吃辣」。
 *
 * 规则：**后来的算数**——保留时间较新的一条，给它挂 `changedFrom`（旧话原样留着，
 * 只在内部，用于渲染那句「我改过口」）；`since` 缺失或完全相同（判不出先后）时
 * 两条都不进清单——替她选一条，等于替她编立场。
 */
function stanceObject(text) {
  // 比的是「说的是哪件事」，不是怎么说。把态度词与标点剥掉之后剩下的才是对象：
  // 「我绝不吃辣」和「我喜欢吃辣」→ 都是「吃辣」，这才算同一件事上的两种态度。
  return String(text ?? '')
    .replace(/我|绝不|永远不会|不再|不想|不愿意|不喜欢|不|喜欢|爱看|爱听|偏爱|更想|宁愿|更愿意/g, '')
    .replace(/[\s，。！？、,.!?；;：:'"「」（）()]/g, '')
}

function sameTopic(a, b) {
  // 守线已经有明确话题的，先按话题判；否则再退回剥掉态度词后的字面。
  const ta = stanceTopic(a)
  const tb = stanceTopic(b)
  if (ta && tb) return ta === tb
  const x = stanceObject(a)
  const y = stanceObject(b)
  if (!x || !y) return false
  if (x === y) return true
  return similarity(x, y) >= 0.6
}

function resolveConflicts(groups) {
  const out = []
  for (const g of groups) {
    const clash = out.findIndex(
      (o) => o.kind !== g.kind && sameTopic(o.text, g.text),
    )
    if (clash < 0) {
      out.push(g)
      continue
    }
    const other = out[clash]
    const a = sinceOf(other)
    const b = sinceOf(g)
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

/** 一条立场怎么落成她能读的一句话（不带任何次数、权重）。 */
export function stanceLine(s) {
  const cost = s.scars > 0
    ? '（这件事我栽过一次，没忘）'
    : s.mentions >= STANCE_MIN_MENTIONS
      ? '（这句话我说过不止一次）'
      : ''
  const flip = s.changedFrom ? '（这件事我改过口，以前不是这么说的）' : ''
  const body = s.kind === 'boundary' ? boundaryLine(s.text) : s.text
  return `- ${body}${cost}${flip}`
}

/** 身份文档里的那一段（空清单返回空串，不占预算）。 */
export function stanceSection(stances = []) {
  const list = stances.slice(0, STANCE_PROMPT_MAX)
  if (!list.length) return ''
  const boundaries = list.filter((s) => s.kind === 'boundary')
  const nevers = list.filter((s) => s.kind === 'never')
  const likes = list.filter((s) => s.kind === 'like')
  const lines = ['## 我站哪边', '这些不是设定，是这些事上我确实站住过。同类的事再来，我按这个来，不重新演一遍。']
  if (boundaries.length) lines.push('### 我守的线', ...boundaries.map(stanceLine))
  if (nevers.length) lines.push('### 我不做的', ...nevers.map(stanceLine))
  if (likes.length) lines.push('### 我喜欢的', ...likes.map(stanceLine))
  return lines.join('\n')
}

/** 观测台用的一句话摘要。 */
export function stanceSummary(stances = []) {
  // 键名带 stance 前缀：这份结果会被 spread 进 /memory 的 sections，
  // 不能跟已有的 count/nevers 这种通用名字撞上。
  return {
    stanceCount: stances.length,
    stanceBoundaries: stances.filter((s) => s.kind === 'boundary').length,
    stanceNevers: stances.filter((s) => s.kind === 'never').length,
    stanceLikes: stances.filter((s) => s.kind === 'like').length,
    stanceBacked: stances.filter((s) => s.backed).length,
    stanceFirst: stances.length ? { kind: stances[0].kind, text: stances[0].text } : null,
  }
}
