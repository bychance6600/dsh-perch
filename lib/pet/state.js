/**
 * pet/state.js —— 她会怎么动（纯函数）
 *
 * 桌宠是身体，不是第二个她。这里只把「她这条会话里发生了什么」翻译成五档：
 * thinking / acting / waiting / done / error。不生成台词，不猜情绪。
 *
 * 2026-11-08（m09369）：施工单 §3.3。事件形状来自 T0 探针
 * （docs/dsh-pet-施工单-roost侧.md 附录）：turn/start、user/message、
 * tool/call、tool/result、assistant/message、turn/end。
 */

export const PET_STATES = Object.freeze(['thinking', 'acting', 'waiting', 'error', 'done'])

/** 给界面看的字；协议里仍然发英文档名。 */
export const STATE_LABELS = Object.freeze({
  thinking: '思考',
  acting: '动手',
  waiting: '等',
  error: '出错',
  done: '成了',
})

/** 工具名 → 一句事实（不写评价、不写第一人称）。 */
const TOOL_WHY = {
  bili_look: '在翻 B 站',
  bili_watch: '在看画面',
  douyin_look: '在刷抖音',
  her_recall: '在翻旧事',
  her_diary: '在翻日记',
  write_diary: '在写日记',
  growth_commit: '在记东西',
  pair_file: '在看桌上的文件',
  her_note: '在写纸条',
  notes: '在看纸条',
  pet_act: '在动一下',
}

export function toolWhy(name) {
  const n = String(name ?? '')
  return `动手：${TOOL_WHY[n] ?? '在做事'}`
}

export function labelOf(state) {
  return STATE_LABELS[String(state ?? '')] ?? '等'
}

export function initialState(now = Date.now()) {
  return {
    state: 'waiting',
    why: '等：她醒着，没在做事',
    until: 0,
    asleep: false,
  }
}

function next(prev, patch, now, holdMs = 0) {
  return {
    ...prev,
    ...patch,
    until: holdMs > 0 ? now + holdMs : 0,
  }
}

/**
 * 一条会话事件 → 新状态。
 * @param {object} prev 上一状态
 * @param {object} event { type, data }
 * @param {{now?:number, human?:boolean}} opts
 */
export function reducePetState(prev, event, opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const cur = prev && typeof prev === 'object' ? prev : initialState(now)
  const type = String(event?.type ?? '')
  if (type === 'turn/start') {
    return next(cur, { state: 'thinking', why: '思考：模型回合中', asleep: false }, now)
  }
  if (type === 'user/message' && opts.human) {
    return next(cur, { state: 'thinking', why: '思考：模型回合中', asleep: false }, now)
  }
  if (type === 'tool/call') {
    const name = event?.data?.name
    return next(cur, { state: 'acting', why: toolWhy(name), asleep: false }, now)
  }
  if (type === 'tool/result') {
    return next(cur, { state: 'thinking', why: '思考：刚动完手' }, now)
  }
  if (type === 'assistant/message') {
    // 有字没字都不改档：说话时她仍在这一轮里。发不发气泡由 mirror 决定。
    return cur
  }
  if (type === 'turn/end') {
    const kind = String(event?.data?.reason?.kind ?? event?.data?.reason ?? 'completed')
    if (kind === 'completed') {
      return next(cur, { state: 'done', why: '成了：这一轮完了' }, now, 2000)
    }
    return next(cur, { state: 'error', why: '出错：回合失败' }, now, 5000)
  }
  if (type === 'prompt-failed') {
    return next(cur, { state: 'error', why: '出错：回合失败' }, now, 5000)
  }
  return cur
}

/** 到点了就把 done/error 收回 waiting。 */
export function stateAt(prev, now = Date.now()) {
  if (!prev) return initialState(now)
  if (prev.until && now >= prev.until) {
    return { ...prev, state: 'waiting', why: '等：她醒着，没在做事', until: 0 }
  }
  return prev
}

/** 下一档还要停留多久（毫秒）；没有就 0。 */
export function holdLeft(prev, now = Date.now()) {
  const until = Number(prev?.until ?? 0)
  if (!until) return 0
  return Math.max(0, until - now)
}

/**
 * 她醒着没有。sleep 是身体动作，不占五档。
 * @returns {{asleep:boolean, act:'sleep'|'wake'|'', why:string}}
 */
export function awakeChange(prev, awake, now = Date.now()) {
  const asleep = Boolean(prev?.asleep)
  if (awake === false) {
    if (asleep) return { asleep: true, act: '', why: String(prev?.why ?? '') }
    return { asleep: true, act: 'sleep', why: '睡：她不在' }
  }
  if (asleep) return { asleep: false, act: 'wake', why: '醒：她回来了' }
  return { asleep: false, act: '', why: String(prev?.why ?? '') }
}
