# dsh-perch-douyin

抖音材料层的可选子包，`dsh-perch` 用它开一个独立的浏览器。

它**不是渠道**。没有 `send`、没有 `onMessage`、不收私信。主包只拿它做三件事：

- 刷推荐流（`browseFeed`）——报纸的「抖音」那段；
- 用同一个浏览器请求站内接口（`createCdpTransport` + 主包的 `api()`）——详情、评论、搜索；
- 让 `douyin_look` / 链接解析能借这个登录态翻页。

```bash
pnpm add dsh-perch-douyin
```

装了就多一个能读的浏览器；没装时主包静默跳过（`loadSubModule()` 返回 `null`），刷抖音和 `douyin_look` 都回一句「抖音子包没装」，不报错、不建目录。

## 它要求什么

- **一个真的 Chromium**：本机装着 Microsoft Edge 或 Google Chrome（Windows / macOS）。Linux 服务器要自己接 Xvfb，本包不做。
- **一个能扫码的桌面窗口**：第一次启动会打开浏览器，你自己扫码登录抖音；登录态留在主包传进来的 `profileDir`（默认 `<数据目录>/douyin-profile`），**本包不读、不存、不打日志任何 cookie**。
- **一个固定端口**：默认 CDP 端口 9333。被占用时在设置里换一个。

## 它为什么是单独一个包

主包承诺「零依赖、装完就能跑」。浏览器自动化做不到：要真窗口、要能扫码、DOM 一改就得跟着改。把这种东西塞进主包，等于让只想在 DSH 里陪她的人也为它付安装代价。

## 它有多脆（先说清楚）

| 脆点 | 说明 |
| --- | --- |
| DOM 选择器 | 推荐流的卡片结构在 `index.js` 的 `FEED_SELECTORS`，**没有在真机上校准过**。第一次接通时按浏览器里的实际结构改这一块，别改下面的逻辑。 |
| 账号风控 | 这是浏览器自动化，不是官方协议。频率别调太低，账号有可能被风控。 |
| 图形会话 | 无头环境跑不了；`--headless` 对登录态不友好。 |

## 接口

```js
import { createCdpTransport, browseFeed, feedScript } from 'dsh-perch-douyin'

const transport = createCdpTransport({ browserPath: '', profileDir: '<root>/douyin-profile', debugPort: 9333 })
await transport.launch()          // start() 是别名
await transport.navigate('https://www.douyin.com/')

const got = await browseFeed({ transport, limit: 4 })
// { ok: true, items: [{ id, title, author, like }] }

await transport.close()
```

`createCdpTransport()` 返回的对象：

| 方法 | 作用 |
| --- | --- |
| `launch()` / `start()` | 起浏览器、连 CDP、`Page.enable` + `Runtime.enable`；失败回 `{ ok: false, why }`，永不抛 |
| `navigate(url)` | 打开页面 |
| `evaluate(expression, { awaitPromise })` | 在页面里跑一段表达式并取回值 |
| `close()` | 关浏览器 |

主包拿 `evaluate` 做的事：以页面身份 `fetch('/aweme/v1/web/...', { credentials: 'include' })`，所以登录态才带得上。整条外链会被主包拒绝。

## 已知未验证

- 推荐流选择器（见上）。
- 抖音的验证码/风控页：遇到时只回失败，不做绕过。
