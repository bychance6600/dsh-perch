/**
 * channels/auth.js —— 「这句话是不是他本人说的」
 *
 * A29（2026-11-07）：认证归渠道层，登录归 owner.js。
 * 渠道适配器只如实给出对方的 id（QQ 号 / B 站 uid / 抖音 openid），
 * 这一层按 **消息来自哪个渠道** 去比对主人名单；不同渠道的 id 绝不混着比。
 *
 * 为什么不能混：QQ 号 12345 与某个 B 站 uid 12345 是两个世界的人。
 * 混在一张表里会把陌生人当成主人——认错一次，她就会把陌生人的话记进 constitution。
 */

import { splitOwnerIds } from '../owner.js'

/** 渠道名 → 主人 id 列表。数字也接受，统一转字符串再比。 */
function wanted(owners, channel) {
  const raw = owners?.[String(channel ?? '')]
  return splitOwnerIds(raw)
}

/**
 * 这条消息发信人是不是主人。
 * 命中返回那个 id，否则空串。只做字符串比较——不猜昵称、不看头像。
 * 兼容两种 personId：裸 id（B 站 uid / 抖音 openid）与适配器加的 `u_` 前缀。
 */
export function ownerIdOf(msg, owners = {}) {
  const ids = wanted(owners, msg?.channel)
  if (!ids.length) return ''
  const got = String(msg?.personId ?? '')
  for (const id of ids) {
    if (got === id || got === `u_${id}`) return id
  }
  return ''
}

/** 是不是主人。`personId === 'owner'` 是旧调用方留的显式标记。 */
export function isOwnerMessage(msg, owners = {}) {
  if (String(msg?.personId) === 'owner') return true
  return ownerIdOf(msg, owners) !== ''
}
