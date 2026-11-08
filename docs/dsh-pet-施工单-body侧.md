# dsh-roost-pet 施工单（body 侧 · 给新会话）

- 日期：2026-11-08
- 你要写的：一个新仓库 `dsh-roost-pet`——桌面上那只透明的、只有身体的窗口。
- 你不需要读 roost 的代码。roost 会把它需要的一切，通过下面这套协议喂给你。
- 需求准绳在 `dsh-roost/docs/dsh-pet-给roost设计.md`（29 条）。本单是它的施工版；冲突时以需求文档为准。
- **协调板（2026-11-08 起）**：`D:\fish\dsh-pet-协调.md`，append-only、不进 git。每轮开始先读最后几节「当前下一步 / 给 ROOST / 给 BODY」；做完在末尾追加一条 `## [BODY] 2026-11-08 HH:MM`，写「做完：…，提交 …」或「卡住：…」。不改上面的内容，不提交这个文件。

---

## 0. 一句话

**roost 出字，你出身体。字从 roost 来，身体不生成字。**

---

## 1. 装好之后是什么样

1. DSH 桌面上多一个小窗：透明、无边框、置顶，只有她。右键有菜单（设置、宠物包、隐藏、退出）。
2. 她在 DSH 里说话——跟主人聊、QQ 有人找她、她自己醒来——每说一句，这句原样被抄到头顶气泡里。一个字不改，不总结、不截断。
3. 她想动（点头、摇头、跳一下、害羞、笑、伸懒腰、睡、醒、安静），roost 发 `act`；同一轮里她又说又动，就一边冒字一边演。她没说，就不出声。
4. 点它一下：只是看你一眼，不说话。双击弹一个小输入条，你打的字原样递给 roost；她的回复仍然是被抄回来的那句。没有「正在输入」。
5. 状态跟着她走：想 / 动手 / 等 / 出错 / 成了，加上睡与醒。
6. 它没有自己的嘴：不装模型、不存记忆、不开端口。roost 启动它，用父子进程的标准输入输出传话；roost 一退，它跟着退。

---

## 2. 硬边界（写代码时当红线）

- 不生成任何一句“她的话”：没有模板台词、没有随机碎碎念、没有本地模型。
- 不监听任何端口，不开 HTTP，不开 WebSocket，不做 IPC 服务端。唯一输入是 stdin。
- 不读 DSH 的数据目录，不读 roost 的文件；它只认 stdin 这一条线。
- 一次只开一只；第二只进程直接退出并报错。
- 退出要干净：进程、窗口、托盘都不留；不自启、不后台常驻。
- 仓库里不放任何宠物素材（素材有单独授权）；默认用 CSS 画占位。
- 除了 `settings.json` 与 `window.json` 两个本地小文件，不写盘。

---

## 3. 私有通道协议 v1

唯一来源：`docs/protocol.md`（v1，`dsh-roost-pet` 仓库）。**不要在这份文件里再抄一份字段表**——两边各抄一份，迟早分叉。

施工时记住三条（协议里也有，这里重复只为防漏）：

- stdout 只走协议，一行一条 JSON；任何日志、错误、调试输出一律走 stderr。
- 空行跳过、不 warn（Windows 上 stdout 开头可能多一个空行）。
- 收到 `say` 先 `ack` 再排队；队列满丢最新并 `log`。

其余（字段、握手、冒泡时长、背压、bye）照 `docs/protocol.md`。

---

## 4. 进程入口约定（roost 怎么起你）

这一节是两边对齐的入口契约。roost 侧的可执行版本在 `lib/pet/entry.js`；改约定先改这里，再同步两边代码。消息协议仍以 `docs/protocol.md` 为唯一来源，不要混在一起。

### 4.1 `pet.path` 指向什么

`pet.path` 指向 **body 自己的启动可执行文件**，不是 Electron runtime，也不是 `.cmd` / `.bat` / `.ps1`。

- Windows：`dsh-roost-pet.exe`（body 打包产物）。
- macOS：`dsh-roost-pet.app/Contents/MacOS/dsh-roost-pet`。
- Linux：`dsh-roost-pet`（可执行位要带上）。

Electron 怎么装、主进程怎么起、窗口怎么建，都是 body 内部的事；roost 只认这个可执行文件。打包之前，roost 只在开发态用 Electron 直接起：`pet.path` 指 `<repo>/node_modules/electron/dist/electron.exe`，`pet.repo` 指 `<repo>`，参数前面加仓库根、`cwd` 也是仓库根。没有 `pet.repo` 时只从标准布局反推，推不出来就报错，不猜别的路径。

roost 用 `spawn(path, args, { cwd, env, stdio: ['pipe','pipe','pipe'], windowsHide: true })`：

- 不经过 shell；路径里有空格也不会被拆开。
- 打包产物：`cwd` 是 body 可执行文件所在目录；开发态 Electron：`cwd` 是 body 仓库根。都不是她的数据目录（`~/.dsh-roost`）。
- spawn 前从 env 删掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 会当 node 跑，主进程根本不启动。
- 不 `detached`；roost 退出，body 的 stdin 会 EOF，body 必须跟着退。

### 4.2 传哪些参数

roost 固定按这个顺序传，body 必须认：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `--protocol=1` | 整数 | 消息协议版本；不认就按 4.4 的退出码 2 退 |
| `--size=1.0` | 0.5–2.0 | 初始大小；body 自己的设置窗可以再改，改完记在 body 的 `settings.json` |
| `--position=bottom-right` | 见下 | 可选；不传 = body 记住上次位置 |
| `--click-through=1` | 0 或 1 | 空白处是否点穿；1 = 点穿，不挡桌面 |
| `--pet=default` | 字符串 | 宠物包 id；加载失败先退回占位身体，不崩 |

- `--position` 只认：`bottom-right`、`bottom-left`、`top-right`、`top-left`、`center`。roost 在空串或乱写的值上**不传**这个参数。
- `--size` 由 roost 夹在 0.5–2.0；body 仍要自己再夹一次，别信外部输入。
- `--click-through` 缺省按 `1`。
- 这五项之后，roost 会把 `config.pet.args` 里的额外参数原样接上；body 不认识的自己忽略，不要因此退出。
- body 不要把 roost 的参数写回自己的 `settings.json` 再覆盖主人手改的值；参数只当这次启动的初值。

### 4.3 握手与超时

- roost 起进程后开始计时；**10 秒**内没收到 body 的 `hello`，就算握手失败：关连接、杀进程、按 4.5 重试。
- body 的 `hello` 要带 `v:1`；版本不认就写 stderr 说明并按 4.4 的退出码 2 退，不要硬跑。
- 握手成功后，`say` 的 ack 超时是 **8 秒**；超时 roost 丢这一条并记日志，不重发。body 收到 `say` 要先 `ack` 再排队。
- 日志、错误、调试输出一律走 stderr；stdout 只能有一行一条 JSON。

### 4.4 退出码：正常 bye、崩溃、握手失败要分得开

body 退出时按这个表给退出码：

| 退出码 | 含义 | body 什么时候用 |
| --- | --- | --- |
| `0` | 正常退出 | 收到 `bye`；用户从右键菜单选「退出」；窗口关闭；stdin EOF |
| `1` | 未分类崩溃 | 未捕获异常、渲染进程崩了、自己也不知道为什么 |
| `2` | 握手 / 协议失败 | `--protocol` 不认；`hello` 发不出去；协议版本对不上 |
| `3` | 已经有一只 | `app.requestSingleInstanceLock()` 没拿到 |
| `4` | 参数 / 配置错 | 参数缺值、`settings.json` 坏到起不来、宠物包根目录不可读 |

roost 怎么处理：

- `0`：不重拉。用户自己关的，尊重这个动作；日志只记一句。
- `3` / `4`：不重拉，直接置 dead。重试也不会好，别刷日志。
- `2` / `1` / 信号 / 其他：按 4.5 退避重试。
- 如果 body 先发了 `bye` 再退，不管退出码是什么都按正常退出算，不重拉。

### 4.5 重试与收尾

- 总共最多起 **3 次**（第一次 + 两次重试）。
- 两次之间等 **1 秒**、**5 秒**；第三次还起不来就置 dead，只记一条日志，不再排 15 秒。
- 每次失败包括：spawn 报错、10 秒没握手、进程非 0 退出、stdout 关了但 500ms 内没退出。
- roost 停插件时：先发 `bye`，等 **2 秒**；不退就 `kill`，再 1 秒不退就强杀。
- body 收到 `bye` 后 **3 秒内**退干净；3 秒没退，roost 会替它收。
- 重试和收尾都要能被 roost 的 `off()` 取消；停掉之后不许再 spawn。

---

## 5. 窗口

```js
new BrowserWindow({
  width: 360, height: 420, frame: false, transparent: true,
  hasShadow: false, resizable: false, skipTaskbar: true,
  alwaysOnTop: true, focusable: true,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
})
```

- `setAlwaysOnTop(true, 'floating')`；Windows 上 `setSkipTaskbar(true)`。
- 点击穿透：默认 `setIgnoreMouseEvents(true, { forward: true })`；渲染层 `pointermove` 命中身体矩形时通过 IPC 关掉穿透，离开再打开。空白处不挡桌面。
- 位置：`%APPDATA%/dsh-roost-pet/window.json` 存 `{x,y}`；启动时按当前显示器 clamp；`screen` 的 `display-added/removed/metrics-changed` 时重新 clamp。
- 不做：多显示器跟随、吸附边缘、开机自启。

---

## 6. 渲染

- 一个 `<canvas>` 或 `<video>` 播放宠物包帧序列；webm 用 VP9 alpha（Safari 不支持，只做 Windows/macOS 桌面）。
- 没包时画占位：圆角团子 + 两只眼，纯 CSS/SVG。
- 底噪四样，默认开：呼吸（缩放 2px）、张望（头微转）、打盹（闭眼 1–2 秒）、伸懒腰（偶尔）。自动换动作间隔 ≥ 3 分钟；不来回走、不反复转身、不连续换。
- 禁止：自动走动、靠近、敲桌面、随机台词、按日历换装。
- `quiet` 状态：停底噪切换、不出声、不凑近，但**不隐藏**；呼吸可以继续。
- `sleep`：播 `sleep.start → sleep.loop`，闭眼、呼吸放慢；除拖拽外不做任何自动动作；被 `wake` 时播 `sleep.end`。
- `done/error`：只改姿态与只读显示，2–5 秒后回 `waiting`，不冒泡。

---

## 7. 物理

- 拖：`pointerdown` 记 offset；`pointermove` 跟手；`pointerup` 用最近 120ms 的速度抛掷。
- 重力 2000px/s²；屏幕底/边反弹系数 0.35；落地挤压 0.08 秒后回弹。
- 不出屏、不卡缝、不穿进别的窗口。
- 睡觉时仍可拖，落地继续睡。
- 撞墙/落地有轻微反馈（可选）；两只宠物互撞不做（只有一只）。

---

## 8. 交互

- 单击身体：播 `click`（或 `look`）一次 + 发 `poke`；**不出声**。
- 双击：开聊天框（底部小输入条，Enter 发、Esc 关）。发送即 `input`，原文；不加「正在输入」、不回显自己的话。
- 右键菜单：设置、宠物包、隐藏、退出。睡着时没有“唤醒”。菜单里不放对话、余额、待办。
- 隐藏：只隐藏窗口，进程还在；从菜单再显示。退出才结束进程。
- 设置窗（独立小窗）：大小、位置、物理开关、底噪总开关、四样底噪各自开关、点击穿透、宠物包选择、只读状态（当前档 + 依据）。
- 只读状态读最近一条 `state` 的 `state` 与 `why`，不能改。

---

## 9. 宠物包

目录结构：

```
<pack>/pet.json
<pack>/<动画文件>.webm
```

`pet.json`：

```json
{
  "id": "default",
  "name": "默认",
  "size": 1.0,
  "animations": {
    "breathing": ["a.webm"],
    "look": ["b.webm"],
    "doze": ["c.webm"],
    "stretch": ["d.webm"],
    "turn": { "left": ["e.webm"], "right": ["f.webm"] },
    "drag": ["g.webm"],
    "sleep": { "start": ["h.webm"], "loop": ["i.webm"], "end": ["j.webm"] },
    "click": ["k.webm"],
    "actions": { "nod": ["l.webm"], "shake": ["m.webm"] }
  }
}
```

- 缺组回退顺序：`actions.x → click → turn → breathing`；再缺就静止。
- 校验：文件存在、数组非空、路径不越出包目录；坏包给明确报错（stderr + `log`），不静默。
- 换包：设置窗选择目录；立即重载；不需要重启。
- 季节/节日不自动换包。
- 素材标准（2026-11-08 实看结论）：单帧宽度 ≥ 360px、脸占画面 ≥ 1/4、透明背景；小尺寸 GIF 直接转 webm 会糊脸，宁可用少几帧的大图。「形象与动画用 pet 自带的默认形象（已同意），pet 那套 AI 大模型删掉」——身体不自帶生成。

---

## 10. 测试（不需要 Electron）

`node --test`，只测纯函数：

- `lib/protocol.js`：编解码、半行聚合、超长拆行、坏 JSON 不崩。
- `lib/physics.js`：拖拽、抛掷、重力、反弹、边界 clamp（给固定 dt）。
- `lib/pack.js`：加载、缺组回退、坏包报错、路径越界拒绝。
- 冒泡队列：顺序、去重、1.2 秒间隔（用假时钟）。

UI 与窗口手测，列一张清单（见第 12 节）。

---

## 11. 任务顺序

1. **骨架**：仓库、`package.json`（electron 固定大版本，`^` 不要）、main/preload/renderer、透明窗口、协议编解码、hello、`say` 冒泡、`state` 只读显示、`bye` 退出。
2. **物理与底噪**：拖/抛/边界；四样底噪与 ≥3 分钟间隔；点击穿透。
3. **交互**：单击、双击聊天框、右键菜单、隐藏/显示。
4. **睡/醒/安静**：按 `act` 与 `state` 切换。
5. **宠物包**：加载、校验、回退、换包。
6. **设置窗**：大小/位置/物理/开关/包/只读状态。
7. **失败演练**：stdin EOF、脏行、坏包、第二实例、窗口关闭、roost 消失。每种都要退得干净。
8. **README + NOTICE**：怎么装、怎么连、怎么换包、怎么退；声明未复制 dsh-pet 代码。

---

## 12. 手测清单（对着需求编号）

- 连上 roost：hello 成功；断掉 roost，3 秒内进程退出。
- 说一句带标点的话：气泡逐字一致；长文拆条、同序。
- 同一轮里 `say` + `act`：字和动作同时。
- 只 `act` 不说话：只有动作，没有气泡。
- 单击：动作，无字；睡着时单击只翻身。
- 双击：输入条；输入原文到达 roost；不显示「正在输入」。
- 静置 10 分钟：自动动作只在四样里，间隔 ≥3 分钟。
- 拖、甩、落地：不出屏。
- 右键：菜单四项；睡着时没有唤醒。
- 退出：进程树干净，`tasklist` 无残留。
- 第二实例：被拒，退出码 3。
- 坏参数（缺 `--protocol` 值、宠物包根目录不可读）：退出码 4，stderr 说清哪一项。
- 正常 bye / 关窗：退出码 0；未捕获异常：退出码 1；协议版本不认：退出码 2。

---

## 13. 坑

- **stdout 是协议**：任何 `console.log` 必须改到 stderr，否则一行日志就把 JSON 流冲坏。
- **Windows 穿透要 forward**：`setIgnoreMouseEvents(true, { forward: true })`，否则拿不到 hover，点不到身体。
- **透明窗口 + 视频**：部分显卡上 webm alpha 会黑底；先检测 `canPlayType`，失败就退回占位团子并 `log`。
- **DPR 缩放**：高 DPI 下用 `devicePixelRatio` 换算，否则气泡位置偏。
- **别把窗口设成 `focusable:false`**：聊天框要能输入；失焦时再恢复穿透。
- **Electron 版本固定**：升级要单独测透明与穿透。
- **素材授权**：不提交任何宠物素材；默认占位用 CSS。

---

## 14. 不做（看到这些就当没看见）

系统通知、待办、语音合成、语音识别、多宠物、余额档位/查询、对话记忆、季节自动换、浏览器 overlay、独立模式、手机交互、公开 HTTP、Cordis 公开面、自动打招呼、右键唤醒、到点自醒、随机碎碎念、换模型/性格/嗓子。

---

## 附录：协议示例

```jsonc
// 你 → roost
{"t":"hello","v":1,"body":"dsh-roost-pet/0.1.0","pet":"default"}
{"t":"input","id":"u1","text":"你在干嘛"}
{"t":"poke","x":812,"y":640}
{"t":"ack","id":"s1"}

// roost → 你
{"t":"hello","v":1,"roost":"0.1.0"}
{"t":"state","state":"thinking","why":"思考：回合进行中"}
{"t":"say","id":"s1","seq":0,"text":"在翻今天推来的几条。","final":true}
{"t":"act","action":"nod","why":"她点头"}
{"t":"state","state":"waiting","why":"等：回合已结束，等下一次动静"}
{"t":"act","action":"sleep","why":"她不在"}
```
