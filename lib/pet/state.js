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
    why: '等：回合已结束，等下一次动静',
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
    return next(cur, { state: 'thinking', why: '思考：回合进行中' }, now)
  }
  if (type === 'user/message' && opts.human) {
    return next(cur, { state: 'thinking', why: '思考：回合进行中' }, now)
  }
  if (type === 'tool/call') {
    const name = event?.data?.name
    return next(cur, { state: 'acting', why: toolWhy(name) }, now)
  }
  if (type === 'tool/result') {
    return next(cur, { state: 'thinking', why: '思考：工具已返回' }, now)
  }
  if (type === 'assistant/message') {
    // 有字没字都不改档：说话时她仍在这一轮里。发不发气泡由 mirror 决定。
    return cur
  }
  if (type === 'turn/end') {
    const kind = String(event?.data?.reason?.kind ?? event?.data?.reason ?? 'completed')
    if (kind === 'completed') {
      return next(cur, { state: 'done', why: '成了：这一轮结束了' }, now, 2000)
    }
    return next(cur, { state: 'error', why: '出错：回合失败' }, now, 5000)
  }
  if (type === 'prompt-failed') {
    return next(cur, { state: 'error', why: '出错：回合失败' }, now, 5000)
  }
  return cur
}

function localDayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 多久没动静算睡着（分钟）：默认 5，范围 1–60。 */
export const IDLE_SLEEP_MIN_DEFAULT = 5

/**
 * 她此刻醒着没有（2026-11-08，16:00 协调板定案）。
 *
 * 只看两件事：回合进行中，或者距最后一次动静还没到 idleSleepMin。
 * 余额、通知、日历、到点都不算；到点真起了一轮，会由 turn/start 算成动静。
 * 五分钟只在回合结束之后起算，所以回合里停十分钟也不会睡。
 */
export function awakeByActivity(turnActive, lastActivityAt, now = Date.now(), idleSleepMin = IDLE_SLEEP_MIN_DEFAULT) {
  if (turnActive === true) return true
  const mins = Number(idleSleepMin)
  const idle = Number.isFinite(mins) ? Math.min(60, Math.max(1, mins)) : IDLE_SLEEP_MIN_DEFAULT
  const last = Number(lastActivityAt)
  if (!Number.isFinite(last) || last <= 0) return false
  return now - last < idle * 60_000
}

/**
 * 她是不是把今天收了（2026-11-08，15:00 主人转述）。
 *
 * 这是 scheduler「想一想」的记账判据；桌宠从 16:00 起不再读它。
 * 只看账本，不读 window、不读 wokeToday：
 *   今天最后一条 `meta sleep:<今天>` 之后没有事件 → 睡；
 *   之后还有事件 → 不睡；没有这条标记 → 不睡。
 * 账本是 append-only，数组顺序就是发生顺序。
 */
export function asleepFromEvents(events = [], now = new Date()) {
  const key = `sleep:${localDayKey(now)}`
  const list = Array.isArray(events) ? events : []
  let last = -1
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i]
    if (e?.type === 'meta' && String(e?.text ?? '') === key) last = i
  }
  return last >= 0 && last === list.length - 1
}

/** 到点了就把 done/error 收回 waiting。 */
export function stateAt(prev, now = Date.now()) {
  if (!prev) return initialState(now)
  if (prev.until && now >= prev.until) {
    return { ...prev, state: 'waiting', why: '等：回合已结束，等下一次动静', until: 0 }
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
