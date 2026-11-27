/**
 * 「这一轮是渠道在问她」的开关（2026-11-03）。
 *
 * 为什么需要：渠道回复走的是 `sessionController.prompt`，她答的话会作为
 * `assistant/message` 出现在**她自己那条 DSH 会话**里。`lib/turns.js` 的
 * 叫醒轮记账（recordWakeSay）看到没有 pending 的 assistant/message 就会记一条
 * `channel: dsh` 的 utterance —— 于是同一句渠道回话被记了两次（dsh + qq），
 * 判断被重复计入 beliefs。
 *
 * 这里只放一个计数：`lib/channels/router.js` 在问她之前 +1、问完 -1；
 * `turns.js` 见到 &gt;0 就把这一轮让给渠道层记（那边记 `channel: qq/bili/douyin`）。
 *
 * 用计数而不是布尔：两台渠道可能并发问，各自的 finally 都要能正确退场。
 */
const state = { active: 0 }

/** 渠道这一轮的原话（见文件末尾 setExternalHeard 的说明）；空串=没有。 */
let externalHeard = ''

export function beginExternalTurn() {
  state.active += 1
  return state.active
}

export function endExternalTurn() {
  if (state.active > 0) state.active -= 1
  return state.active
}

export function isExternalTurn() {
  return state.active > 0
}

export function _resetExternalTurn() {
  state.active = 0
  externalHeard = ''
}

/**
 * 渠道这一轮「他到底说了什么」的原话旁路（团队卡 #7 复核 P1-2）。
 *
 * 为什么需要：渠道轮的 user 消息正文是 `buildPrompt` 组装出来的整段稿纸
 * （「（QQ 的群「…」。说话的是 X。…）」开头、末行是「（回不回…你自己定）」），
 * 组装层拿它做预取会把 boilerplate 当关键词——旧实现（4a8acf9）用的是 `clean`
 * 原话。这里只放一句原文，组装层在 `isExternalTurn()` 为真时优先用它。
 *
 * 与 active 计数分开：并发渠道轮时它只是「最近一次的原话」，差一点点不影响
 * 正确性（顶多这一轮检索的话不对，不会漏段、不会抛）。
 */
export function setExternalHeard(text) {
  externalHeard = String(text ?? '')
  return externalHeard
}

export function getExternalHeard() {
  return externalHeard
}

export function clearExternalHeard() {
  externalHeard = ''
}
