# dsh-pet 施工单（roost 侧 · 给写 roost 代码的会话）

- 日期：2026-11-08
- 你改的是 `D:\fish\dsh-roost`。body 侧另一个窗口在写 `D:\fish\dsh-roost-pet`，并**已拿到** `docs/dsh-pet-施工单-body侧.md`。
- 需求准绳：`docs/dsh-pet-给roost设计.md`（29 条）。本单只写 roost 这半边。
- 约束照旧：零依赖、`events.jsonl` 只追加、新输入口过 `lib/guard.js`、不加人格设置界面、不改成长口径。
- **协调板（2026-11-08 起）**：`D:\fish\dsh-pet-协调.md`，append-only、不进 git。每轮开始先读最后几节「当前下一步 / 给 ROOST / 给 BODY」；做完在末尾追加一条 `## [ROOST] 2026-11-08 HH:MM`，写「做完：…，提交 …」或「卡住：…」。不改上面的内容，不提交这个文件。roost 当前这一轮先跑完，下一轮再按此执行。

---

## 0. 一句话

roost 是脑子，pet 是身体。roost 负责：开关、起进程、订阅她的话、算五档与睡醒、给动作工具、暴露只读状态。**它不生成字，也不替 body 决定说什么。**

---

## 1. 先做 T0：探针（半小时）

目的：确认宿主的事件形态，决定「动手」档能多准。写一个临时脚本（不提交），用 `ctx.on('session/event')`：

- 打印 `assistant/message` 里 `message.content[].type` 的全部取值（看有没有 `tool` 之类非 text 块）；
- 打印所有事件 `type`（看有没有 `tool/start`、`tool/end`、`tool/result`）；
- 让她跑一个会调工具的任务（例如让她 `her_recall` 一次）。

结论写进 `docs/dsh-pet-给roost设计.md` 或本单附录，决定 4.3 的降级路径：

1. 有工具事件 → `acting` 精确到工具在跑；
2. 只有非 text 块 → 该块出现即 `acting`；
3. 都没有 → 用 `deriveStatus().phase`：`browsing|writing` 算 `acting`，其余算 `thinking`。

---

## 2. 配置（`lib/settings.js` 的 `DEFAULTS`）

```js
pet: {
  enabled: false,        // 默认关；改完要重启才生效（boot 时读）
  path: '',              // 空 = <root>/pet/dsh-roost-pet.exe；开发态可填 electron.exe
  repo: '',              // 仅开发态：body 仓库根（electron.exe <repo>）；打包产物不用
  args: [],              // 额外参数
  size: 1.0,             // 0.5–2.0
  position: '',          // '' = body 记住上次位置；或 'bottom-right'
  clickThrough: true,
  pack: 'default',       // 角色包文件夹名（~/.dsh-roost/pets/<id>）；--pet=<id>
  idleSleepMin: 5,       // 多久没动静算睡着，1–60；保存后热更
  pokeMinGapMs: 60000,   // 两次点击之间至少隔多久，5000–600000
},
```

`AGENTS.md` 补一句：`pet` 是环境参数，不是人格参数。

角色素材不放仓库：一个角色 = `~/.dsh-roost/pets/<id>/` 一个文件夹（`pet.json` + 视频文件），文件夹名就是 `pet.pack`。仓库里只留不含素材的模板。

---

## 3. roost 侧文件

```
lib/pet/index.js     startPet(ctx, deps) → off()；状态、poke、配置热更
lib/pet/bridge.js    协议编解码、行缓冲、hello 超时、背压
lib/pet/state.js     事件 → 五档/睡醒（纯函数）
lib/pet/mirror.js    assistantText → 分条、去重、节流（纯函数）
lib/pet/status.js    给 /pet/status 与设置页的只读快照
lib/pet/entry.js     入口解析：pet.path 优先，空则 <root>/pet/dsh-roost-pet.exe
lib/pet/actions.js   角色包动作表：读 pet.json、过滤坏名、回落内置 10 个
lib/pet/tool.js      注册 pet_act，enum 与描述跟着动作表走
tools/install-pet.mjs  解压身体/角色包 zip，写 config（零依赖）
test/pet-bridge.test.mjs  test/pet-state.test.mjs  test/pet-mirror.test.mjs
test/pet-index.test.mjs  test/pet-actions.test.mjs  test/pet-tool.test.mjs
test/install-pet.test.mjs
```

### 3.1 `startPet(ctx, deps)`

- 读 `deps.config.pet`；`enabled` 假 → 直接返回 `() => {}`（不 spawn、不注册工具、不挂事件）。
- `pet.path` 空时用 `petPathOf()` 找 `<root>/pet/dsh-roost-pet.exe`；文件不存在就算没装：不 spawn、`lastError` 留空、why 写「等：还没装身体（把 zip 解压到 ~/.dsh-roost/pet/）」。
- `const spec = entrySpec({ ...pet, path: petPath }); spawn(spec.path, spec.args, { stdio: ['pipe','pipe','pipe'], cwd: spec.cwd, windowsHide: true })`。两种入口由 `lib/pet/entry.js` 的 `entrySpec()` 统一解析：打包产物直接起、`cwd` 是 exe 所在目录；开发态 `pet.path` 指 `node_modules/electron/dist/electron.exe`，`pet.repo` 填 body 仓库根（缺省只从标准布局反推，推不出就报错，不猜别的路径），参数前面加仓库根、`cwd` 也是仓库根。`pet.args` 原样接在最后。
- 参数由 `lib/pet/entry.js` 生成：`--protocol=1 --size=… [--position=…] --click-through=0|1 --pet=<id>`，再接 `pet.args`。`<id>` 取 `config.pet.pack`（老配置的 `petId` 自动迁过来）。spawn 前从 env 删掉 `ELECTRON_RUN_AS_NODE`。
  入口约定正文在 body 仓库的 `docs/launch.md`；不要在这里另写一份。
- 子进程 stdout 按行读；stderr 收进 roost 日志（前缀 `[pet]`）。
- 握手：10 秒内收 `hello`；没收到 → kill，按 1 秒 / 5 秒退避重试；总共 3 次（第一次 + 两次重试），第三次置 `dead`，只写日志。
- 退出码：`0` 正常关掉，不重拉；`3`（已经有一只）/ `4`（参数错）直接 `dead`；
  `2` / `1` / 信号 / 其他按退避重试。body 先发 `bye` 再退，不管退出码都按正常退出。
- 返回的 `off()` 要：停订阅、发 `bye`、等 2 秒、`kill`、清定时器（含重试与 `bye` 的定时器）。

### 3.2 订阅

只认 `talkSessionId(ctx, { root })` 那条会话：

```js
ctx.on('session/event', (session, event) => {
  if (session?.id !== talkId) return
  ...
})
```

`lib/turns.js` 已经订阅了同一条总线；不要重复订阅成两份，把 pet 的订阅放在 `startPet` 里、用同一个过滤条件。

### 3.3 五档（`lib/pet/state.js`，纯函数）

| 事件 | 档 | 停留 |
| --- | --- | --- |
| `turn/start` 或 human 的 `user/message` | `thinking`；`turnActive=true`，刷新 `lastActivityAt` | — |
| 工具在跑（见 §1）或 `phase` 为 `browsing/writing` | `acting` | — |
| `assistant/message` 有 text | 保持 `thinking`（或 `acting`），同时推 `say`；刷新 `lastActivityAt` | — |
| `turn/end` 成功 | `done`；`turnActive=false`，刷新 `lastActivityAt` | 2 秒 → `waiting` |
| `turn/end` 失败 / `prompt-failed` | `error`；`turnActive=false`，刷新 `lastActivityAt` | 5 秒 → `waiting` |
| `turnActive===false` 且距 `lastActivityAt` ≥ `idleSleepMin` | `act:sleep` | 下一次她自己的动静前一直睡 |
| `turnActive===true` 或距 `lastActivityAt` < `idleSleepMin` | `act:wake` | — |

`idleSleepMin` 默认 5、范围 1–60（`config.pet.idleSleepMin`，设置页「插件」页）。设置页保存后由 `petApplyConfig(next)` 当场热更并重判，不用重启。判据只看回合与动静：回合进行中一律算醒，五分钟只在回合结束后起算；余额 / 通知 / 日历 / 到点本身不算动静。

`why` 只用事实：`思考：回合进行中`、`思考：工具已返回`、`动手：在翻 B 站`、`等：回合已结束，等下一次动静`、`出错：回合失败`、`成了：这一轮结束了`。说哪一段、从哪儿来，不写评价。

### 3.4 镜像（`lib/pet/mirror.js`）

- 取 `assistantText(data)`；空串不推。
- 按 `。！？!?；;\n` 断句，单条 ≤200 字，超长按逗号再切。
- 同一 `message.id` 分步重放只推一次；按 `seq` 顺序推；`turn/end` 补 `final=true`。
- **不推**：工具回显、状态行、`recordWakeSay` 的短句（沿用 `turns.js` 的 `MIN_SAY` 口径）。
- 背压：一条未 `ack` 前不推下一条；8 秒没 ack 丢弃并记日志，不重发。

### 3.5 聊天门（需求 #5）

`input` → `sayToHer(ctx, text, deps)`：

- `looksLikeRewriting` 命中 → 静默丢弃（不回、不冒泡、不记事件）。
- 成功后**不要**拿返回值当气泡（`said` 是 HER_TYPES 事件，不是原话）；回复走 3.4 镜像。
- 超时/失败 → 静默；不提示、不重试。

### 3.6 `pet_act` 工具

- **不进** `FISH_TOOLS`（2026-11-08 m09369）：常驻白名单由 selfcheck 逐项核对，宠物默认关着，
  放进去会让每次正常安装都报「少一个工具」。改成：`pet.enabled` 为真时由 `lib/index.js`
  通过 `registerToolRestrict` 的 `extra` 追加；`selfcheck` 的 `expected` 也跟 `petOn` 条件走。
- 动作表从角色包现读：`lib/pet/actions.js` 的 `readPetPack(pet, root)` 按 `pet.dir`（开发态）→ `<root>/pets/<pack>/pet.json` → `<repo>/pets/<pack>/pet.json` 顺序找，读 `animations.actions` 的键，过滤不安全的名字；读不到、全坏或空都回落内置 10 个：`nod|shake|bounce|shy|laugh|stretch|sleep|wake|quiet|loud`。
- `parameters.action.enum` 与描述都跟动作表走；描述列前 20 个「名字 中文」，超过 20 个补「等 N 个」。未知动作回「没有这个动作：X。手边有：…」。
- 描述：一句话说清「身体语言，不代表说话；说话时同时调它，字和动作一起出；只能做这些，不能替你说」。
- `execute` 只回 `{ ok, note }`，不回状态、不回表情数字。

### 3.7 只读状态

- `GET /pet/status`：`{ enabled, installed, path, pack, connected, state, why, pet, lastError, dead }`。
- 设置页「插件」页加只读块：桌宠（已安装/未安装、路径、连上/没开/连不上）、当前档 + 依据、角色包、身体包、最近一次错误（有才显示）。
- **不加**：唤醒按钮、语音开关、模型/性格/嗓子、自动重启。

---

## 4. 协议（roost 这半边要实现的）

完整表见 `https://github.com/bychance6600/dsh-roost-pet/blob/main/docs/protocol.md`（v1，唯一来源；本仓库不存第二份）。roost 只需实现：

- 发：`hello`、`say`、`state`、`act`、`bye`
- 收：`hello`、`input`、`poke`、`ack`、`log`、`bye`
- 行缓冲：按 `\n` 切；单行 >16KB 丢弃并记日志；坏 JSON 丢弃并记日志（不要崩）。
- `poke` 按三档处理：睡着 → 只让 body 晃一下，不算戳、不记；回合进行中 → 只记一条 `meta poke:<ISO>`，不另起一轮；醒着且距上次戳够 `pokeMinGapMs` → 记 meta 并起一轮轻提示（不写 `seen`）。`poke` 不是「她听过」，不进记忆。

---

## 5. 测试

- `test/pet-state.test.mjs`：给定事件序列 → 期望的 `state` 序列（含 done/error 停留、按回合与动静判睡）。
- `test/pet-mirror.test.mjs`：分句、200 字、去重、短句过滤、final。
- `test/pet-bridge.test.mjs`：用一个假 body（`test/fixtures/fake-body.mjs`，Node 脚本说协议）跑：握手、say 排队、ack 超时、脏行、EOF、重试三次后 dead。
- `test/pet-actions.test.mjs`：安全动作名、角色包候选顺序、坏名过滤、缺/坏/空回落内置。
- `test/install-pet.test.mjs`：没 `--body` 报用法；用 PowerShell `Compress-Archive` 造 zip，解身体与角色包、写 config、备份旧 config。
- 测试不碰真实数据目录；用 `tmp` root。
- 全量基线：`node --test --test-isolation=none`，本次完成后为 1337 条 / 1326 过 / 9 条已知红 / 2 skip；加了测试要更新 `AGENTS.md` 的基线数字。

---

## 6. 验收（roost 半边）

| # | 验收 |
| --- | --- |
| 1 | `pet.enabled=false` 时零副作用：不 spawn、不注册工具、无网络 |
| 2 | 开启后，她在侧栏说一句 → body 收到逐字 `say`；标点不改 |
| 3 | 她说一句、同时调 `pet_act` → 两者都到 |
| 4 | 五档跟事件走；无工具事件时按 §1 降级 |
| 5 | 回合结束超过 `idleSleepMin`（默认 5 分钟）→ `act:sleep`；`turn/start`、`tool/call`、`assistant/message` 任一 → `act:wake`；回合进行中停十分钟也不睡 |
| 6 | 聊天框输入原文到达 `sayToHer`；guard 命中时零输出 |
| 7 | body 没装/路径错/崩溃 → 只记日志，她的话与工具不受影响 |
| 8 | 退出 roost → body 2 秒内退出，无残留 |
| 9 | `pet.path` 空、`<root>/pet/dsh-roost-pet.exe` 不存在 → 状态是「未安装」，不 spawn、`lastError` 为空；把 zip 解压进去后重启就能连上 |
| 10 | 角色包 `pet.json` 的 `animations.actions` 改了 → `pet_act` 的 enum 与描述跟着变；坏名被滤掉，整份坏回内置 10 个 |
| 11 | 戳一下：睡着只晃；回合中只记 `meta poke:`；醒着且隔够 `pokeMinGapMs` 才起一轮轻提示 |

---

## 7. 坑

- `ctx.on('session/event')` 是全局的，必须按 sessionId 过滤。
- `sayToHer` 的 `said` 不是原话；气泡只走镜像。
- 叫醒轮也会 `turn/end`；只认 `talkSessionId` 那条，别把叫醒当「成了」。
- body 的 stdout 是协议；roost 侧也不要往子进程 stdin 乱写非 JSON。
- 重试退避要能被 `off()` 取消，否则停插件后还在 spawn。

---

## 附录 A：T0 探针结论（2026-11-08）

探针没有另写脚本：真机会话已经留下完整事件流，直接解开看，比再造一轮更准。

- 取样：`~/.dsh/sessions/<她那条会话的工作区>/session-34828eca-3c2f-472d-be57-88d4277679e2/session.v4.jsonl.zstd`
  （多帧 zstd，按 magic `28 B5 2F FD` 切帧；23 帧 / 48 行）。
- 事件类型：`session`、`permission/preset`、`sandbox/mode`、`approval/policy`、`session/title`、
  `agent/inbox/spliced`、`turn/start`、`step/start`、`system/message`、`user/message`、
  `request/header`、`request/context`、`session-log-deepseek/delivery-accepted`、
  `assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end`。
- `assistant/message.data.message.content` 的块类型：`reasoning`、`tool-call`、`text`。
  `tool-call` 形如 `{ type:'tool-call', id, name, arguments }`。
- `tool/call.data` = `{ turn, step, callId, name, arguments }`。
- `tool/result.data` = `{ turn, step, message:{ role:'tool', source:{kind:'tool',callId}, toolCallId,
  content:[{type:'text',text}], isError:false, id } }`；`sourceEventSeqs` 指向对应的 call。
- `turn/end.data` = `{ turn, reason:{ kind:'completed' } }`。

**结论：走 §1 的路径 1。**「动手」可以精确到 `tool/call` → `tool/result`，不需要退回
`assistant/message` 的非 text 块，也不需要 `deriveStatus().phase`。`lib/pet/state.js` 的
`reducePetState` 就按这四个事件实现；失败回合用 `data.reason?.kind` 判，未取样到的形状
按「不是 completed 就算失败」处理。

---

## 附录 B：协议示例

```jsonc
// roost → body
{"t":"hello","v":1,"roost":"0.1.0"}
{"t":"state","state":"thinking","why":"思考：模型回合中"}
{"t":"say","id":"s1","seq":0,"text":"在翻今天推来的几条。","final":true}
{"t":"act","action":"nod","why":"她点头"}
{"t":"act","action":"sleep","why":"她不在"}

// body → roost
{"t":"hello","v":1,"body":"dsh-roost-pet/0.1.0","pet":"default"}
{"t":"ack","id":"s1"}
{"t":"input","id":"u1","text":"你在干嘛"}
{"t":"poke","x":812,"y":640}
```
