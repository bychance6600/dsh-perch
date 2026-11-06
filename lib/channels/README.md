# 渠道适配器契约

主包只认这一份接口。渠道实现**不许**直接读写 `events.jsonl`、不许自己决定回不回、
不许自己拼提示词——那些是 `router.js` 与 `gate.js` 的事。适配器只干两件事：
**把外面的话搬进来**，**把她的话送出去**。

## 接口

```js
import { create } from './qq.js'

const adapter = create({
  log,                 // (...a) => void
  config,              // 这个渠道自己的配置段（见下）
  WebSocketImpl,       // 测试注入用；缺省 globalThis.WebSocket
  fetchImpl,           // 测试注入用；缺省 globalThis.fetch
  now,                 // 测试注入用；缺省 Date.now
})

adapter.name                     // 'qq' | 'douyin'
await adapter.start()            // → { ok, why }  永不抛
await adapter.stop()             // → void
await adapter.send({             // → { ok, id?, why? }  永不抛
  conversation: { kind: 'dm' | 'group', id, name },
  text,
})
const off = adapter.onMessage(fn)  // → 注销函数
```

**例外：抖音（`douyin.js`）是材料层，不是渠道**（2026-11-06）。它只有
`start / stop / status / api() / feed()`，没有 `send`、没有 `onMessage`——
抖音私信已删。`router` 允许 `adapters` 里存在这种只读适配器：链接解析
（`lib/dylink.js`）与刷抖音借它的 `api()` / `feed()`，但永远不会有消息从它进来。
它的 `enabled` 只表示「这台浏览器能读报纸」。

## 进来的一条消息（规范化后）

```js
{
  channelId: 'qq',            // 与 schema.js 的 CHANNELS 一致
  kind: 'dm' | 'group',
  conversationId: '123456',   // 群号 / 对方 uid（字符串，永远）
  conversationName: '群名',    // 拿不到就 ''
  personId: 'u_123456',       // 全局唯一，前缀见下
  personName: '昵称',
  text: '……',                 // 已去掉 @ 机器人、已 trim；空串表示只有图/表情
  images: [],                 // 图片 url 或本地路径，可为空
  attachment: { type: 'image', size: 2048 }, // 可选：只留一条附件元数据，正文留空
  mentionedSelf: false,       // 这条有没有 @ 她（群里决定要不要听）
  replyToSelf: false,         // 这条是不是在回复她发过的消息（与 @ 同等算点名）
  isAdmin: false,             // 群主/管理员（冷却豁免；可选）
  at: 1700000000000,
  raw: { … }                  // 原始报文，只给排查用，不许进提示词
}
```

`personId` 一律带渠道前缀（`u_` + 平台 uid），跨渠道的同名人不合并——
「同一个人」是 `people.js` 的判断，不是适配器的。

## 规则（违背了就是改坏了）

1. **永不把异常抛给调用方。** `start` / `send` / `stop` 一律返回对象；异常在里面吞掉、记日志。
2. **重连自己管。** 阶梯退避，别让 router 去管 socket。断了要把 `ok:false` 记进 `adapter.status()`。
3. **凭据不许进日志。** cookie / access_token / SESSDATA 打印前打码（照 `lib/log.js` 的 `redact`）。
4. **不许在模块加载时建连接。** 只有 `start()` 里才碰网络——否则插件 import 阶段就会被拖死。
5. **不许有运行时依赖。** HTTP 用 `fetch`，WS 用 `globalThis.WebSocket`（Node 22+），
   CDP 用 `child_process` + 内置 WS。`package.json` 的三个依赖字段必须保持 `{}`。
6. **进站文本必须过 `guard.js` 的 `sanitizeForeign` + `looksLikeRewriting`。**
   适配器可以只做 `sanitizeForeign`，但**不许**把原始文本直接交出去。
7. **`send()` 里不许再判断"该不该说"。** 只判断"技术上能不能发"（超长切段、被禁言、没登录）。
   该不该说是 router 的事。

## router 那边（2026-11-06，照 `新项目-设计讨论.md` 渠道节）

- **合批**：同一个会话连着的几句先攒 10 秒（`BATCH_WINDOW_MS`），窗口到了按发送者
  切连续段，每段合成一条再问她。她不会因为对方把一句话拆成三条而回三遍。
- **入站分叉**：私聊全进 `heard`；群里只有 @ 她、回复她的话才进 `heard`，其余只进内存背景环
  （每群最近 20 条、每条 300 字），她被叫醒时作为「群里刚才还有人说话」带上，明说不是对她说的。
  白名单外的群连 @ 都不进，只留一行流水。
- **群友不逐个建人**：只有私聊的人、或点过她名的群友才进 `people.json`。
- **配额**（`gate.js`，不上面板）：群冷却 120s（@、回复她、管理员豁免）、全局每分钟 30 条、
  每群每天 20 条；夜间 23:00–08:00、工作日 9–12 / 14–18 群里只接点名。
- **气泡**：`splitBubbles` 按句切，单句超过 4000 字硬切；一次回复超过 3 条时，每两条之间停 900ms。

## 配置段

每个渠道在 `config.json` 里占一个键，默认全关：

```json
{
  "channels": {
    "qq":  { "enabled": false, "wsUrl": "ws://127.0.0.1:3001", "token": "", "groups": [], "replyInGroup": false },
    "douyin": { "enabled": false }
  }
}
```

`groups` 是群号白名单，空数组 = 一个群都不回。私聊不受它管。
抖音没有群、没有私信，`ownerId / groups / replyInGroup / mentionOnly` 都已经不用了；
它的 `browserPath / homeUrl` 只管那台读报纸的浏览器（`browse.douyin` 里也有同名项）。

## 状态（给观测台读）

`adapter.status()` 返回可直接 JSON 的对象，**不许**含凭据：

```js
{ ok: true, connected: true, since: 1700000000000, lastError: '', queued: 0, sent: 12, received: 30 }
```
