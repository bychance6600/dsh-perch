# 进度

## 现在在哪

**0.1.0 已发布（2026-11-08，tag `v0.1.0`）。** 代码已从 `dsh-fish-river`（0.1.68）复制过来，改名、删掉一半旧功能、账本已迁到 `~/.dsh-roost`。river 时代的变量名与文档尾巴已清（环境变量统一 `DSH_ROOST_*`，`install.ps1` 重写）。2026-11-07 已上真机（A11 首检通过）。A 段 35 条与 B 段 19 条验收全部收口（A1 于 2026-11-07 16:12 真机通过）。

- 基线：`node --test --test-isolation=none` → 最近一次全量 **1350 条 / 1339 过 / 9 红**（另有 2 skip，2026-11-09 `d91e911` 后核，本机已装运行时 ffmpeg）。没装 ffmpeg 时多一条 `dylink` 的 Referer。全量约 110 秒。
- 9 条红都是已知环境项与跨文件隔离假红（ULID、cover、growth_commit、坏 JSON、seen ×2、withWake、turn/end、消息没送进去）。逐文件独立进程跑，假红那几条会绿。原先 `ops_*_own` 那条也在这里，A27 的用例用 `rememberKnownTools([])` 复位后已转绿；`--test-isolation=none` 下 `withFileLock` 偶发一条，单跑是绿的。
- node 不在 PATH：用 `D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。


## 设置页首屏拆慢 + 记忆图谱独立页（2026-11-09，m00002）——已改

- 设置页：`lib/client.js` 的 `load()` 拆成 `load()`（`/state` `/today` `/status` 三条）与 `loadRest()`（其余 25 条），新增 `restLoaded` / `ensureRest()`；首屏后按页签切换或空闲时补。真实家目录副本三次：改前首屏 10 条核心 5,766 / 644 / 633 ms，随后 17 条 640 / 649 / 664 ms，整屏等完约 1.3 s；改后首屏 3 条 5,379（首跑 JIT）/ 434 / 440 ms，补的 25 条 856 / 830 / 843 ms，首屏字节 43,464（原 282,404）。插件 apply 启动 216 / 187 / 195 ms（改前同口径 212 / 205 / 201）。bundle：217,157 → 219,921 字节，gzip 71,633 → 72,413，brotli 56,952 → 57,624（其中「记忆图谱」入口约 +425 原始字节）。
- 记忆页：新增 `lib/memory-page.js`（独立深色 HTML，内联 CSS/JS、SVG 力导向，约 18 KB）；`lib/observe.js` 里 `/memory` 在 `Accept: text/html` 时直接回整页，新增 `/dsh-roost/api/memory`（只读，deriveSelf → nodes/edges，不加 CORS 头；`/memory` 的 JSON 仍走信任栅栏）。页内：时间滑杆按 `at` 过滤、硬边红 / 软边灰（bigram dice ≥ 0.34）、点节点看详情与邻近、`#n=` 深链、请求 8 秒超时，失败或空数据给「读不到记忆 + 原因 + 再试一次」。设置页「成长」加了「打开记忆图谱 →」。
- 实测：真实家目录副本 `/dsh-roost/api/memory` 200 / 171 ms / 165,609 字符（280,026 字节），654 节点 / 0 硬边 / 49 软边 / 2,483 事件；断网与 HTTP 500 都显示空态，不白屏。截图 `D:\fish\_archive\memory-data.png`、`memory-offline.png`、`memory-real.png`。
- 测试：`test/client.test.mjs` + `test/boot.test.mjs` 65/65；全量 `node --test --test-isolation=none` 1361 条 / 1350 过 / 9 红 / 2 skip（`D:\fish\_archive\full-test2.log`），9 条红与已知环境红同名，无新增。
- 侧栏入口（2026-11-09 追加）：`lib/client.js` 用 `ctx.slots.inject` + `ctx.slots.register` 注册 `sidebar.panellist`（id `roost-memory`，order 2，图标 + 文字「记忆图谱」）与 `main` keyed slot（iframe 装 `/dsh-roost/memory`）；「成长」页那行链接保留作兜底。未改宿主、未动 `@deepseek-ai` 包；全量 1361 条 / 1350 过 / 9 红 / 2 skip。
- 没动 `lib/derive.js`、`lib/schema.js`、`lib/channels/*`；三件与回执一起提交，未打 tag。


## 启动慢：derive 的 dice 重算（2026-11-09，m14029）——已改

- 现象：桌面版从双击到窗口出来约 23–26 秒；宿主主进程被 dsh-roost 的 `apply` 占满约 20 秒。
- 根因：启动时跑了 2 次 `stability()`（每次 24 次全量 `deriveSelf()`）。真实事件流 2332 条、600 条判断，CPU profile 里 `dice @ lib/derive.js:297` 占 28.1%（15.0 秒）；`mentions` 对每个候选都重算一遍完整 `dice()`，成本 = 判断数 × 候选数 × 二元组数。
- 修法：`lib/derive.js` 的 `mentions` 改成先用 `Int32Array` 累加交集、用 stamp 去重，再算一次比值；在 herTexts 里预存 `gramTotal = norm.length - 1`，避免重复遍历 Map。判定仍是 `2*交集/(|A|+|B|) >= 0.6`，输出逐字节等价。
- 实测：同一份真实事件流，`deriveSelf` 559 → 159 ms，`stability`（24 抽样）13471 → 4250 ms，`writeSelfDoc` 14082 → 4416 ms。真机重启（2026-11-09 16:20:57.536 进程创建 → 16:21:07.456 locale-cache）**启动到可用 9.92 秒**，之前同口径约 26 秒。
- 测试与提交：普通 `node --test` 1349 条 / 1347 过 / 0 失败 / 2 skip；`--test-isolation=none` 1349 条 / 1338 过 / 9 红 / 2 skip（9 条已知环境红）。提交 `39fbf68`「perf(derive): mentions 不再逐条重算 dice，启动期少约 12 秒」，已推 origin/main。
- 第二次 `stability()` 已由 `d91e911` 的共享 trial 缓存降到约 0.0ms（同一份事件流第一次约 3.5 秒）；还没在重启后复测整段启动。`--type=gpu-process` 长期吃满约 99% 单核是另一件事。


## 她这一轮只吐模型标记时再问一次（2026-11-09，m13843）——已改

- 现象：`~/.dsh` 的会话里，她记完 `her_note` 后第二步只输出 `</｜｜DSML｜｜ invoke>` / `</｜｜DSML｜｜ calls>`，没有正文；`turns.js` 把空正文当「这一轮没话说」，`turn/end` 正常结账，侧栏里就静默了。
- 修法：`lib/turns.js` 新增 `assistantSaid()`，把「真的一句话没说」与「只剩脚手架」分开；`assistantText()` 继续只返回剥过的正文。`assistant/message` 遇到后者只标 `pending.scaffoldOnly`，不 push 空话；`takeTurnEnd()` 在 `settle()` 之后调 `nudgeScaffold()`，用 `sc.prompt({ requestId: 'scaffold-…', mode: 'queue', content: [SCAFFOLD_RETRY_TEXT] })` 再问一次。只问一次；会话已换、回合已停、又有新 pending 时都不问。重问出来的话走 `recordWakeSay()` 落成 utterance，不重复结账。
- 测试：`test/turns.test.mjs` 新增两条（只吐 DSML → 重问一次且 talkmem 不含 DSML；「已完成」不算脚手架），19/19；定向 turns+guard+channel-router+derive+mem+pet-index+wake 154/154；全量 `node --test --test-isolation=none` **1349 条 / 1338 过 / 9 红 / 2 skip**（/tmp/full-scaffold.log），9 红与已知环境红同名。
- 已核旧污染：`events.jsonl` 2272 行里只有 2 条旧 DSML utterance（11-03、11-05），`talk-recent.json` 与身份文档没有；读侧 `derive`/`recall`/`observe` 都先剥，今天页也不显示。事件流只追加，没有删旧行。
- 需重启 DSH 才生效。

## 抖音材料层不再在启动时拉浏览器（2026-11-09，m13498）——已改

- 现象：只要开了「刷抖音」（`browse.douyin.enabled` 或 `channels.douyin.enabled` 任一为真），DSH 一启动就多一个 Edge/Chrome 进程，很占资源。
- 原因：`lib/channels/host.js` 的 `boot()` 会把抖音材料层 `loadOne('douyin')` 起来，`startReaders()` 调适配器的 `start()`；`lib/channels/douyin.js` 的 `start()` 原来直接 `launch()` + `navigate(homeUrl)`。
- 修法：适配器 `start()` 只 `makeTransport()` 登记材料层、置 `ready`，不 `launch`、不 `navigate`；`api()` 先看 `ready`（没登记就回「抖音没开」），再 `ensureLaunched()`，第一次真读接口时才开浏览器并导航，之后复用。`feed()` 走 `api()`，所以定时刷抖音也自动懒启。用 `busy` 计数 + `idleTimer`（`IDLE_CLOSE_MS = 3 * 60 * 1000`，`unref()`）在最后一次读完后闲置 3 分钟自动关；`stop()` 清定时器并关。`status()` 补 `enabled` / `launched` / `idleCloseMs`，旧字段 `connected/since/lastError/queued/sent/received` 保持原样。
- 顺带修掉 `lib/douyinlook.js` 的 `what=comments` 分支：原来直接 `return`，浏览器留在后台；现在整段 `try/finally` 关掉，没给 id 的早退也关。适配器里 `launch` 返回失败或抛错时，也先 `close` 半截进程再丢掉。
- 测试：`test/douyin-adapter.test.mjs` 新增「重复 start 也不拉浏览器」「第一次读接口才拉、之后复用」「闲置到点自己关，下次再开」；`test/douyin-look.test.mjs` 的 comments 两条补 `closed` 断言。定向 douyin-adapter + douyin-look + douyin-browse + channels-host 62/62；全量 `node --test --test-isolation=none` **1347 条 / 1336 过 / 9 红 / 2 skip**（/tmp/full-dy-lazy.log），9 红与已知环境红同名。
- 需重启 DSH 才生效；之后启动日志应只有「douyin 材料层就绪：浏览器等第一次用再开」，没有浏览器进程。

## 立场第三类与同题归组（2026-11-09，m13079）——已改

- 背景：她的判断里有大量守线式说法（不接、不签、不替、得我自己来），旧的 `classifyStance` 只认「喜欢 / 绝不」，这些一条都进不了立场；旧归组又拿整段字面相似度比，长段落一稀释就归不上。
- 分类：`lib/stance.js` 新增 `BOUNDARY_RE` 与 `boundary` 类，顺序是先守线、再绝不、再喜欢；「不(喜欢|爱|想|愿意)」加 `(?<!想)`，修掉「想不想要」被误判成「不想」。
- 归组：新增 `TOPIC_RULES` 与 `stanceTopic()`（name / agency / speech 三个话题）；`buildStances` 对 boundary 先按同话题收，没话题的只收同样没话题且字面相似度 ≥ `STANCE_SIM` 的；没话题、只有两条、又没疤背书的，整组不算。没动全局 `STANCE_SIM` 0.45。
- 渲染：身份文档的立场段分成 `### 我守的线` / `### 我不做的` / `### 我喜欢的`，标题仍是 `## 我站哪边`；`stanceSummary` 加 `stanceBoundaries`；设置页状态行、记忆页摘要、原理卡改成「守哪几条线」。
- 离线 dry-run（2026-11-09 00:5x，真实 `~/.dsh-roost`）：从 566 条 live 判断里多出三条守线组（一组 5 条、一组 4 条、一组 3 条），另两条因没话题、只有两条、无背书被排除。代表句原样搬进提示词会把立场段撑到约 850 字（`personaLine` 1623 / 1800）。改成 `boundaryLine()`：只摘第一个命中守线的那一句，句子太短就带上前一句，超过 100 字截断。再跑 dry-run，`personaLine` 总长 1752 / 1800，每条守线各只有一句，读起来是清单不是散文。
- 测试：`test/stance.test.mjs` 21/21（新增「守线进清单只摘那一句」：含「不能做的是」、不含铺垫句、长度 <100）；全量 `node --test --test-isolation=none` **1345 条 / 1334 过 / 9 红 / 2 skip**，9 红与已知环境红同名。
- 尚未重启 DSH，所以这三条还没进她的提示词；先给主人看味道，确认后再重启上线。

## GitHub Actions 修到全绿（2026-11-08，m11776）——已改

- 基线：远端 run `42470088380` 三个 job（ubuntu 22 / ubuntu 24 / Windows）全红；本地普通 `node --test` 是 1335 过 / 0 红 / 2 skip，`--test-isolation=none` 的 9 条红是已知环境项。
- Ubuntu 与 Windows 共同的假红一：`test/gate.test.mjs` 的夜间/峰时用例写死 `+08:00`，而 runner 是 UTC，`23:30+08` 变成 15:30（落进峰时）、`10:30+08` 变成 02:30（落进夜间）。改成 `new Date(2026, 10, 6, 23, 30)` 这类本地构造，gate 仍按机器本地小时判。
- Ubuntu 假红二：`test/install-pet.test.mjs` 用 `spawnSync('powershell.exe')` 压测试包，Ubuntu 上 ENOENT。测试在非 Windows 直接 `t.skip('身体和角色包只在 Windows 上解压')`。
- Windows 假红三：`test/pairfile.test.mjs` 的临时目录是 8.3 短路径（`RUNNER~1`），`realpath` 展开后与配置里的字面路径不同，被「防软链」检查误判成「这个路径经过链接」。`withDirs()` 先对 `mkdtemp` 的结果做 `realpath` 再建文件。
- 另外两处 CI 基建：`test/dylink.test.mjs` 的 Referer 用例在没装 ffmpeg 的 runner 上跳过（`e632b04`）；`.github/workflows/test.yml` 失败时把 `✖` 用例名做成注解，公开页也能看（`b8585e5`）。
- 验证：`TZ=UTC node --test test/gate.test.mjs` 16/16；gate + install-pet 18/18；pairfile 7/7；全量 `node --test` **1337 条 / 1335 过 / 0 红 / 2 skip**。
- 提交 `47b7714` 推送后，run `42474410235` 三个 job 全部 success。

## 备份、干净安装与恢复演练（2026-11-08，m12057）——已做

- 快照：`%USERPROFILE%\Desktop\bak\roost\2026-11-08-1920`。`home\` 5,336 文件 / 1,564,361,992 字节，排除 `instance.json`（218 B，运行锁）。源目录（排除 instance）逐文件 sha256 全等：0 缺失、0 多出、0 不同；`events.jsonl` 2,027 行、sha256 `9e092a80b622aae261b2d28483ea088c04ab466d7e70e26cea659809290d7263`；`config.json` `130efe1a...`、`home.json` `48df469f...`、`people.json` `043ce701...`。根目录有 `MANIFEST.md` 与 `SHA256SUMS.txt`（5,336 行，709,378 B，`sha256sum -c` 全 OK）。
- 干净安装：GitHub `bychance6600/dsh-roost` HEAD `ae37201` 重新 clone；`dependencies` / `devDependencies` / `peerDependencies` 都是 `{}`；干净克隆 `node --test` **1337 条 / 1333 过 / 0 红 / 4 skip**；空 profile 用自带 pnpm `add github:...` 装出 `dsh-roost 0.1.0`。
- 恢复演练：把快照 `home\` 复制到临时目录，用干净安装出来的 `lib/index.js` 启动假宿主（关 QQ / B 站 / 抖音 / 桌宠 / 上网 / 主动唤醒）。读回 2,026 条事件 + 1 条跳过（第 763 行是已知无 id 的旧测试行），第 6 天 / 阶段 1，31 人且主人印象非空，复用 `home.json` 里的会话（没新建、没叫醒），注册 12 个自带工具、46 条观测台路由；启动前后 `events.jsonl` 字节前缀一致。
- 真身没动：只做复制与临时副本启动，没有替换 `~/.dsh-roost`，也没有连 QQ。

## 社会层隔离测试屋（2026-11-08，m12281）——已做

- 目的：在不动她真实数据、不启第二个 DSH、不连 QQ 的前提下，把「差闸不写 / 四条齐只写一条 / social 永不进 beliefs / 社会页没有替她开的按钮」四条代码路径串起来跑一遍。
- 新增 `test/social-house.test.mjs`（4 条）。测试屋用 `tmpRoot()` 造临时家、`fakeCtx()` 假宿主、`stanceModel()` 桩（7 条立场、阶段 4）；`evaluateSocialGate`、`registerSocialOpen`、事件流、`deriveSelf` 都是真的。
- 断言：差一条闸时 `social_open` 返回 `ok:false`、事件数一条不增；四条齐后写入 1 条 `social-open:` 且 `deriveSelf(events).influence.socialOpen === true`，再调不写第二条；开闸后写 1000 条 `influence:'social'` 的陌生人 utterance，`beliefs` 与基准 `deepEqual`，只落在 `influence.social.count`；设置页社会页区间含「只读」且没有 `h('button'`。
- 定向 `node --test --test-isolation=none test/social-house.test.mjs test/social.test.mjs test/channel-router.test.mjs test/derive.test.mjs test/client.test.mjs` = 120/120。
- 全量 `node --test --test-isolation=none` = **1341 条 / 1330 过 / 9 红 / 2 skip**（/tmp/full-social-house.log），9 红与已知环境红同名。
- 基线文档同步到 1341/1330：AGENTS、CHANGELOG、README、交接、施工单、PROGRESS、docs/约定清单 B7；B11 加了这四条测试的证据。历史段落里的 1337/1326 是当时的记录，保留。
- 发布：2026-11-08 已推 `v0.1.0`（GitHub Release），CI 在该 tag 上三个 job 全绿。

## 桌宠 pet_act 注册、睡迹判据、窗口文案（2026-11-08，m10609）——已改

- P0：真机上 `pet_act` 注册失败，宿主报 `tool "pet_act" must declare output { schema, render, presentationMeta? }`，日志同时出现「工具面收窄延后（unknown global tool "pet_act"）」。`lib/pet/tool.js` 照 `lib/capture.js:113-136` 补了 `output.schema`（`{ ok:boolean, note:string }`）与 `output.render`（返回 ContentBlock 数组：成功 `[动了]`，失败 `[没动：…]`）；`test/pet-tool.test.mjs` 新增一条断言注册出的工具带 `output.render` 且返回数组。
- 睡醒判据（2026-11-08 16:00 协调板重定）：`lib/pet/index.js` 的 `checkAwake` 改成 `awake = 回合进行中 || 距最后一次动静 < idleSleepMin`；`lib/pet/state.js` 新增纯函数 `awakeByActivity()`。回合进行中一律算醒，五分钟只在 `turn/end` 之后起算；`turn/start`、`tool/call`、`assistant/message` 算她的动静，余额 / 通知 / 日历 / 到点本身不算。`idleSleepMin` 默认 5、范围 1–60，进 `config.pet` 与设置页「插件」页。旧的 `asleepFromEvents()` 保留给 scheduler 的「想一想」记账，桌宠不再读它。
- 窗口：`lib/client.js` 的兜底与设置页初始值从 `20:00` 改成 `08:00`；`lib/settings.js` 的 `DEFAULTS.window` 也改成 `08:00–23:00`。设置页这一段改叫「每天几点可以被叫醒」，提示写明「定时叫醒只落在这个时段里；不是在这段时间里一直醒着」；`lib/persona.js:466`、`lib/settings.js` 注释、`lib/selfcheck.js`、`lib/proactive.js` 的「醒着时段 / 醒来」同步改成「叫醒时段」。
- 测试：`pet-state` 新增动静判据（回合中、4:59 / 5:00、1 分钟档、坏值回落）与睡迹旧的记账用例；`pet-index` 改源码断言（必须用 `awakeByActivity`、记 `turnActive` / `lastActivityAt` / `idleSleepMin`，不许再出现 `asleepFromEvents`）；`settings` 新增 `idleSleepMin` 默认 5 与 1–60 夹取。定向 pet + settings 37/37；全量 **1325 条 / 1314 过 / 9 红 / 2 skip**（/tmp/full-pet-why.log），9 红与已知环境红同名。
- 状态文字（16:41 协调板）：`why` 从判语改成「说哪一段、从哪儿来」——`等：回合已结束，等下一次动静`、`思考：回合进行中`、`思考：工具已返回`、`动手：在翻 B 站`、`成了：这一轮结束了`、`出错：回合失败`；施工单的表格、验收 #5 与 body 侧样例同步改。
- 热更（16:53 协调板）：`idleSleepMin` 原来只在启动时读一次，设置页改完不重启不生效。现在 `/config` 保存后调 `petApplyConfig(next)` 写进运行中的 `base.idleSleepMin`，并立刻 `checkAwake()` 重判；`test/pet-index.test.mjs` 有源码守门。
- 角色包（17:31 协调板）：配置键从 `pet.petId` 改成 `pet.pack`（老配置自动迁过来，不丢已选角色），设置页「插件」卡加「角色包」输入；spawn 仍传 `--pet=<id>`，由 body 按 `~/.dsh-roost/pets/<id>` 找素材。仓库只留模板，素材不进 git。
- 重启后又发现一层：`parameters` 是手写标准形态，宿主报 `tool "pet_act" parameters must be lossless JSON before schema projection`，并连带整批工具不可用。协调侧已改成 `toJsonSchema({ action, why })`（提交 `6ae9d20`），输出是 `{type:'object',properties,required:['action'],additionalProperties:false}`；`test/pet-tool.test.mjs` 补了一条钉住这个形状。
- 真机确认（2026-11-08 15:22）：`工具面收窄：她这条会话只留 15 个工具，另有兜底守卫`；日志里不再出现 `工具注册失败` / `lossless JSON` / `工具面收窄延后`。15:27 她调 `pet_act` 点头，屏幕出现 done 绿圈；姿态也不再按时段判睡。`origin/main` 已到 `6ae9d20`。

## 桌宠交付形态、poke、动态动作（2026-11-08，m11289）——已改

- 交付形态（17:44 协调板）：`lib/pet/entry.js` 新增 `PET_BODY_NAME='dsh-roost-pet.exe'`、`defaultPetPath(root)`、`petPathOf(pet,root)`；`pet.path` 空着就找 `<root>/pet/dsh-roost-pet.exe`。`lib/pet/index.js` 的 `petStatus(cfg,root)` 多返回 `installed/path/pack/dead`，没装时不 spawn、`lastError` 留空、why 写「等：还没装身体（把 zip 解压到 ~/.dsh-roost/pet/）」。新增 `tools/install-pet.mjs`（零依赖，PowerShell `Expand-Archive`）：`--body <zip>` 必填、`--pack <zip>` 可选，解到 `<root>/pet/` 与 `<root>/pets/<id>/`，改 config 前先备份。设置页桌宠卡显示「已安装/未安装 · 路径」。
- poke（17:47 初版；23:20 协调板修订）：`pokeKind(lastPokeAt, now, minGapMs)` 只看间隔，返回 `turn` / `ignore`；睡着由身体自己只晃、不叫醒。隔够 `pokeMinGapMs` 就记 `meta poke:<ISO>` 并排一轮轻提示（不写 `seen`），回合中也不早退，`sc.prompt` 的 `mode:'queue'` 会等她这一轮结束；间隔内的点击只写日志，不写 meta、不排回合。`pokeMinGapMs` 默认 60000、夹 5000–600000，保存后热更。
- 动态动作（17:50）：新增 `lib/pet/actions.js`，按 `pet.dir` → `<root>/pets/<pack>/pet.json` → `<repo>/pets/<pack>/pet.json` 找包，读 `animations.actions`，过滤不安全名字；读不到/全坏/空都回落内置 10 个。`pet_act` 的 enum 与描述都跟着动作表走，未知动作回「没有这个动作：X。手边有：…」。
- 测试：`pet-index` 改「没装不 spawn」与默认路径；新增 `pet-actions` 4 条、`install-pet` 2 条；`pet-tool` 加角色包动作表与坏名回落；`settings` 加 `pokeMinGapMs` 夹取。定向 102/102；全量 **1337 条 / 1326 过 / 9 红 / 2 skip**（/tmp/full-pet-final2.log），9 红与已知环境红同名。
- 顺手修了一条跨文件假红：`test/look-video.test.mjs` 的两条 `resolveUrl` 用例先 `resetRisk()`，否则会被 `bili-risk` 留在进程里的读冷却串成 `COOLDOWN`（全量里多出 2 条红，单跑是绿的）。

## 桌宠入口按 launch.md（2026-11-08，m10008）——已改

- body 侧的启动约定已定稿在 `D:/fish/dsh-roost-pet/docs/launch.md`：`pet.path` 指向打包后的 `dsh-roost-pet.exe`（mac 是 .app 里的可执行文件）；开发态才用 `<repo>/node_modules/electron/dist/electron.exe <repo>`。stdio 三个 pipe、不 detached、不经 shell；`cwd` 是打包产物所在目录，开发态是 body 仓库根；spawn 前从 env 删掉 `ELECTRON_RUN_AS_NODE`。参数顺序 `--protocol=1 --size=… [--position=…] --click-through=0|1 --pet=<id>`，再接 `config.pet.args`；`--pet` 缺省 `default`。

- 退出码以 `launch.md` §3 与 `dsh-roost-pet/lib/exit.js` 为准：0 正常 / 1 未分类崩溃 / 2 握手或协议失败 / 3 已有实例 / 4 参数或配置错；`PROGRESS` 只在这里记一次，用户口述里的「3 握手失败 / 4 已有实例」与文件对调，已按文件实现并回报。0 与「自己 bye」不重拉；3/4 置 dead；1/2/信号按 1 秒、5 秒退避，最多 3 次。

- 代码：`lib/pet/entry.js` 重写（`petIdOf` / `bodyArgs` / `isElectronPath` / `entrySpec` / `childEnv` / `classifyExit`）；`lib/pet/index.js` 的 `spawnOnce` 改用 `entrySpec(cfg.pet)` 与 `childEnv(process.env)`，stdio 固定三 pipe、`windowsHide`；`lib/settings.js` 的 `pet` 默认值加 `repo:''`、`petId:'default'`，并做长度与白名单夹取；设置页宠物包路径提示写明打包产物与开发态两种填法，没有新增输入框。

- 开发态不猜路径：`pet.path` 是 electron.exe 时，`repo` 取 `pet.repo`；没填才从标准布局反推，且要求 `package.json` 的 name 是 `dsh-roost-pet`，推不出就报「请填 pet.repo」。

- 测试：`test/pet-entry.test.mjs` 14 条（默认/自定义 petId、大小与位置、非法 petId、打包产物 cwd、开发态反推与显式 repo、isElectronPath、childEnv 不改入参、退出码三组、常量）；`test/pet-index.test.mjs` 与 `test/settings.test.mjs` 同步改断言。定向 38/38；全量 **1320 条 / 1309 过 / 9 红 / 2 skip**（/tmp/full-pet-launch.log），9 红与已知环境红同名。

- 真 spawn 尚未跑，顺序等 body 侧给；协议与入口测试都用假身体锁死。

## 她复述了整段提示词（2026-11-08，m09172）——已修

- 用户贴出 QQ 记录：她的回复正文后面跟着整段「（QQ 上，跟一个人单独说话…）」「（前面几句：…）」「（你知道的事…）」以及 `</｜｜DSML｜｜ parameter>` 之类的标记。她不是故意念稿，是把收到的稿纸一起说出来了。
- 会话日志 `~/Downloads/dsh-session-session-6e4e9ce8-0005-4428-a3f7-8248a2828b0b/session.v4.jsonl`：turn 58 先调 `pair_file` 读、改，成功；step 3 的 assistant text 把正文 + 整段提示词 + DSML 关闭标记一起吐进 text，宿主当正文落库并发出。后面的轮次又把这段当「你：」历史拼回提示词，越滚越长。
- 两个根因：① `lib/channels/router.js` 出站只把 `stripScaffold(screen.text)` 存进 `outgoing` 做检查，真正 `adapter.send`、journal、`recordSaid` 仍在用没剥的 `screen.text`，标记因此出门；② `stripScaffold` 只删 DSML 标记与界面状态行，不删复述出来的提示词正文。
- 修法：`lib/guard.js` 新增 `PROMPT_ECHO_MARKERS` 与 `stripPromptEcho(text)`——只认 buildPrompt 写出的那几种行首标记（渠道独白 / 群、私下说话、这里不是只有你和他、前面几句、群里刚才还有人说话、你知道的事、在外面见过的做法、回不回、刚才那一步只输出了模型标记、醒一醒），同一段里出现两种以上才从最早一处截断；整段都是复述时返回空串。`lib/turns.js` 的 `assistantText` 与 `lib/channels/router.js` 的 `saidText` 都先过它；出站改为先 `cleaned = stripScaffold(stripPromptEcho(text))`，再过 `screenOutgoing`，`send` / journal / `recordSaid` / 返回值全部用 `outgoing`。
- 旧事件也要能看：事件流只追加，那条脏事件改不了；`lib/derive.js`（判断、称呼、社会层）、`lib/recall.js`（her_recall）、`lib/observe.js`（今天页时间线）在读的时候也先 `stripPromptEcho`，所以旧账里只剩她真说的那一段。
- 测试：`test/guard.test.mjs` 3 条（正文+整段提示词只留正文、整段复述返回空、只有一种标记时不动）；`test/channel-router.test.mjs` 1 条（正文+提示词+DSML 只发正文，事件流也干净）。定向 guard / channel-router / turns 79/79；全量 **1279 条 / 1268 过 / 9 红 / 2 skip**（/tmp/full-promptecho2.log），9 红与已知环境红同名。
- 需要重启 DSH 才会重载 `router.js` / `turns.js` / `guard.js`；重启后让她再走一次「读文件 → 改文件 → 回话」，确认出门的只有她自己的话。

## 桌宠 roost 侧（2026-11-08，m09369）——已接进主包

- 需求：dsh-pet 只是身体，roost 是脑子。协议唯一来源是 `https://github.com/bychance6600/dsh-roost-pet/blob/main/docs/protocol.md`（v1，一行一 JSON，stdio）；身体不生成台词、不自动打招呼，聊天框原文只走 `sayToHer`。
- 代码：新增 `lib/pet/state.js`（事件→五档，`thinking/acting/waiting/error/done`，中文档位，done 停 2 秒 / error 停 5 秒回 waiting）、`lib/pet/mirror.js`（`assistantText` → 按句切、单条 ≤200、同 `id:seq` 去重、8 秒没 ack 丢弃、队列上限 20）、`lib/pet/bridge.js`（注入 `{readable,writable}`，16KB 行上限，3 秒 hello 超时，坏 JSON 不崩）、`lib/pet/tool.js`、`lib/pet/index.js`（spawn 三次失败置 dead 只记一次，退避可被 `off()` 取消）。
- 五点口径已落：① `pet_act` 不进 `FISH_TOOLS`，只在 `petEnabled` 时由 `registerToolRestrict` 的 `extra` 追加，`selfcheck` 的 `expected` 跟 `petOn` 走；② 测试用 `test/fixtures/fake-body.mjs` 的 `PassThrough`，不真 spawn；③ `pet.enabled` / `pet.path` 进设置页「插件」、`buildConfig()` 与 `/config` 白名单；④ `/pet/status` 只回中文档位与事实，不出现 need 模型英文名；⑤ `talkSessionId` 拿不到就不挂、不刷日志。
- 接线：`lib/index.js` 在 `registerObserve` 前 `startPet`，关闭时 push `off`；`petSendAct` 传给工具侧。默认 `pet.enabled=false`，零副作用（不 spawn、不订阅、无网络）。
- 测试：`pet-state` 5 条、`pet-mirror` 5 条、`pet-bridge` 7 条、`pet-tool` 3 条、`pet-index` 4 条；定向 p5/naming/client/blank/selfcheck/boot/restrict/settings 141/141。当时全量 **1304 条 / 1293 过 / 9 红 / 2 skip**（/tmp/full-pet-final.log），9 红与已知环境红同名。
- T0 探针结论已写进 `docs/dsh-pet-施工单-roost侧.md` 附录 A：走路径 1，`acting` 精确到 `tool/call` → `tool/result`，不降级到 phase。
- `git grep` 的个人记号已清零（`test/channel-router.test.mjs:245` 与 `test/guard.test.mjs:232` 的 fixture 名字改成「小满」）。
## 两份说好的文件（2026-11-07，m08813）

- 需求：她想跟另一个项目的需求窗口对接，只要能读写两份文件。用户选定 `docs/dsh-pet-功能清单.md` 与 `docs/dsh-pet-需求与验收.md`，并说（m09086）：新项目具体怎么实现还没定，能读写这两份就行。
- 实现：主包加 `lib/pairfile.js` + 工具 `pair_file`（不做独立子包）。`config.pair = {enabled,a,b}` 放两个绝对路径；别名是文件名去掉扩展名（现为 `dsh-pet-功能清单` / `dsh-pet-需求与验收`）。动作只有 read / replace / append；replace 的 `oldText` 必须恰好出现一次；改和添都要带 read 回来的 16 位 hash；文件在两次之间变过就拒绝并给新 hash；写前留 `.bak`，用 `writeAtomic`。
- 边界：只认配置里的两个路径；realpath 必须与配置一致，拒软链 / 目录 / 二进制 / 大于 512KB；禁止她家 `~/.dsh-roost`、`~/.dsh`、用户主目录本身与系统目录。不写 events.jsonl、不记 `looked:`，不算她看过。
- 接线：`FISH_TOOLS` 加 `pair_file`（10→11，工具面 11→12）；`lib/index.js` 注册时把启动配置传进去，工具说明里带两个别名；`/config` 白名单加 `pair`；设置页插件页加「两份说好的文件」卡片（开关 + 两个路径 + hash/.bak 提示）。`~/.dsh-roost/config.json` 已打开并填好两个路径。
- 测试：`test/pairfile.test.mjs` 7 条；`p5` / `pairfile` / `boot` 44/44；全量 **1275 条 / 1264 过 / 9 红 / 2 skip**（/tmp/full-pair2.log），9 红与已知环境红同名。
- 还需重启 DSH 才会出现 `pair_file`（工具在启动时登记）。

## 工具白名单的警告（2026-11-07）

- 用户问「她要看 dsh-pet 项目要开什么工具」，答复是只开 `web_fetch`，不要开 read/glob/grep/bash；用户要求把这条写进项目，免得后面有人给授权时踩坑。
- 落点：`AGENTS.md` §3 与 §7（通用文件/命令工具不放 `config.tools.allow`，它们不是按目录授权，会读到 `~/.dsh-roost/home/她的身份.md`、配置和状态，绕过 no-read-self；写入类还能绕过 no-self-modify）、`README.md` §八、设置页「插件」工具卡（`lib/client.js`），以及 `docs/约定清单.md` A27 与 `CHANGELOG.md`。
- 只做用户可见的警告，不硬拦白名单：白名单本来就是显式放行口，硬拦会与「白名单只做加法」和现有 `ops_*` 用例冲突。要看某个项目的源码，给她 `web_fetch` 从 GitHub 读，或单独做只读小工具。
- 测试：`test/client.test.mjs` 新增源码守门（警告含「不能读自己的数值与设定」「run_code」「web_fetch」），A27 渲染断言也检查警告；`p5` / `naming` / `client` 56/56。全量 **1268 条 / 1257 过 / 9 红 / 2 skip**（/tmp/full-toolwarning.log），9 红同名。

## B 段验收（2026-11-07）

- 19 条全部 ✅，判据表在 docs/约定清单.md 的 B 节。做法：334/334 条验收相关测试 + 静态审计（rules.js 与上游逐字节同 5630 字节、三个依赖字段 {}、无删 events 路径、QQ 只发标准动作、social-open: 只有 lib/social.js 一处等）。
- 全量 node --test --test-isolation=none = 1259 条 / 1248 过 / 9 红 / 2 skip（/tmp/full-B15b.log），9 红与已知环境红逐条同名。
- B15 收口：browse.enabled=false 同时挡 B 站和抖音（含 zoom），并从工具面摘掉 BROWSE_TOOLS（web_search / web_fetch / bilibili_* / bili_* / douyin_look）；时段只拦逛（B 站 home/search，抖音 feed/search/hot，宿主 web_search / bilibili_search 由兜底守卫挡），不拦点击单条；B 站与抖音共用一个 0–6 的每日上限，当天计数相加。
- A1 真机拔网已验过：2026-11-07 15:14 与 16:10 两次独立断线，日志各是 47 秒（15:14:00→15:14:47、16:10:05→16:10:52），提示词两次都只出现一次，她也接住了「断了 47 秒」；16:03 没有新断线时提示词里没有这句。之前 15:15 那次她没接，已把断线句从提示词最上面挪到最新一条消息正前方。

## A1 真机（2026-11-07）——通过：两次断线都念到

- 日志核对：15:14:00 断开 → 15:14:47 连上；16:10:05 断开 → 16:10:52 连上。两次都是 47 秒，是两次独立断线，不是同一句重复。
- 提示词两次都在断线后的下一轮带上「（刚才这边断了一下，断了 47 秒。）」，且同一段断线只出现一次；16:03 没有新断线时这句不出现。
- 她 16:12 的回话里接住了：「每次断完，我这边会多一句「断了 47 秒」……今天这句来了两次」。A1 的「断过就说一句、没断不说」成立。
- 15:15 那次她没接，原因是断线句在提示词最上面、被前面的历史与设定淹了；已挪到最新一条消息正前方（`test/channel-router.test.mjs` 加了位置断言）。`lib/channels/router.js` 的 `buildPrompt` 仍只写事实，不写「你要先说这个」。
- 全量 1259 条 / 1248 过 / 9 红 / 2 skip（/tmp/full-A1b.log），9 红同名。A1 ✅。

## 抖音真机（2026-11-07）——`sleep is not defined`

- 她在 QQ 里说推荐流「看不见」，伸手试了一下，回的是「sleep is not defined」。这不是没登录，也不是页面变了，是代码自己抛的错。
- 根因：`packages/dsh-roost-douyin/index.js` 里 `browseFeed` 的默认等待函数写成了 `sleep`，`waitForDevtools` 也调 `sleep`，但子包从头到尾没有定义过它。测试里都传了 `sleep` 替身，所以一直没露。
- 修法：子包顶部补 `function sleep(ms)`（`setTimeout` 包成 Promise，负数/非数字按 0 算）。`browseFeed` 不传 sleeper 时就走它。
- 回归测试：`test/douyin-browse.test.mjs` 新增「不传 sleeper 也自己等，不报 sleep is not defined」，用假 transport 走一遍 `navigate` → `evaluate`，不启浏览器。
- 定向 douyin-browse / douyin-look / douyin-adapter 55/55；全量 **1262 条 / 1251 过 / 9 红 / 2 skip**（/tmp/full-douyin.log），9 红与已知环境红逐条同名。
- 已提交并推送 `3bec804`。
- **真机复验通过（2026-11-07 16:40，重启后）**：她在私聊里试了推荐流，`meta dyfeed:2026-11-07` 记下两条（`7696069353590148378`、`7696524579947726985`），报回「推荐流这次正常返回了，没有再报那个 sleep is not defined」，并念出两条的标题、时长与点赞；随后自己搜了「画眉 学口」，`meta searched:画眉_学口 douyin` 落库，并据此写了一条 `revise`。推荐流与搜索页的选择器在真页上都取到了条目。

## 只吐脚手架的一轮（2026-11-07）——已修

- 用户递来 `~/Downloads/dsh-session-session-d782502e-a35f-4a81-94be-93ce39e9ab21/session.v4.jsonl`：最后第 40 轮（18:56 本地）主人说「没关系的 有些问题慢慢就有答案了」，她先调 `her_note` 记下「那条界线答了一半……」，工具回「[记下了]」；第二步的 assistant 消息只有一个 text 块，正文是 `</｜｜DSML｜｜ invoke>` 与 `</｜｜DSML｜｜ calls>`（文件第 493 行），没有 tool/call，也没有一个字的话。整份 495 行里 DSML 只命中这一处。
- 后果：`qq-outbox.jsonl` 最后一条停在 18:55，18:56 没有发出任何消息。她不是没收到、不是 QQ 断线、也不是 guard 误拦。
- 链路：`lib/channels/router.js` 的 `saidText()` 对正文跑 `stripScaffold`，只剩标记时得到空串；`askHer()` 的 `reached.texts` 为空，`handleOne` 按「她一句话没说」返回 `{sent:false, why:'silent'}`，在出站那道 `scaffold` 日志之前就返回了，所以日志里只看到沉默。
- 修法：`saidText()` 改成返回 `{text, scaffoldOnly}`；`askHer()` 在「有正文但剥完是空」时返回 `why:'scaffold'`；`handleOne` 只在 `scaffoldOnly` 时再问一次（`SCAFFOLD_RETRY_TEXT`：「刚才那一步只输出了模型标记，没有话。把刚才想说的直接说出来，不要输出任何标记。」），第二次还是空就按沉默收；真的一句话不说的轮次不重问。
- 回归：`test/channel-router.test.mjs` 加「只吐脚手架时会再问一次；第二次说了就发」（假宿主按调用次序回两段），并在「她可以一句话不说」里钉住 `calls.length === 1`，防止把真沉默也重问。
- 全量 **1266 条 / 1255 过 / 9 红 / 2 skip**（/tmp/full-scaffold.log），9 红与已知环境红同名。定向 channel-router / guard / turns / derive / mem / impression 130/130。

## bili_watch 的证书校验（2026-11-07）——已修

- 用户转来她在 DSH 里的话：`bili_watch` 回「画面还是取不到。同一处证书校验失败，试了两次，一样的错。」stderr 是 `[tls] Peer certificate failed verification` + `Error opening input: I/O error`。同一条视频的 `bili_look` 正常，所以不是登录、不是风控。
- 根因不是 B 站证书坏了，是打包的 ffmpeg 9.0.2（gyan essentials，`--enable-gnutls`）在 Windows 上没有可用的根证书，而 ffmpeg 9 的 `tls_verify` 默认已经是 true。旧代码按「ffmpeg 默认 tls_verify=0」写成只在用户给了 `DSH_ROOST_CA_FILE` 时才加 `-tls_verify 1 -ca_file`，默认这条路等于让 gnutls 空手去校验。
- 复现：`ffmpeg -ss 1 -i <playurl> ...` 默认报 `Peer certificate failed verification`；`-tls_verify 0` 能过 TLS（随后因缺 Referer/UA 被 403）；补上 `-headers` 后出图 465501 字节；把 Node 的 `tls.rootCertificates` 写成 PEM 再加 `-tls_verify 1 -ca_file` 同样出图 465501 字节。
- 修法：`lib/video.js` 从 `node:tls` 取 `rootCertificates`，新增 `ensureCaFile(root)` 写 `media/ffmpeg-ca.pem`（内容没变就不重写）；`grabFrames` 对所有 http(s) 输入一律 `-tls_verify 1 -ca_file`。用户显式给的 `o.caFile` / `DSH_ROOST_CA_FILE` 仍然优先；**不退回 `-tls_verify 0`**。
- 测试：`test/video.test.mjs` 加 `ensureCaFile` 一条、把原来的 CA 守门改成「联网永远带 CA 且不许 tls_verify 0」；定向 video 23 条 21 过 2 skip（本地造片那两条本来就跳）。
- 真机：`grabFrames({ bvid:'BV1q541137ZE', at:[1,3] })` → ok，2 帧，`~/.dsh-roost/media/sheet-BV1q541137ZE-1794056294476-38521b-1.png`。
- 全量 **1267 条 / 1256 过 / 9 红 / 2 skip**（/tmp/full-bili-tls.log），9 红与已知环境红同名。需要重启 DSH 重新加载 `lib/video.js`。

## 身份文档里的 DSML 垃圾（2026-11-07）——已修

- 用户报：她身份文档「你自己说过的话」里摆着两行 `- </｜｜DSML｜｜ invoke>` 与 `- </｜｜DSML｜｜ calls>`。
- 源头是两条真事件：`~/.dsh-roost/events.jsonl` 第 425 行 `ev_01M6GMW20Y1P4Z3H288FN6QW6K`（11-03）与第 1393 行 `ev_01M6NJACW8R1GXQRDM27DM3J6W`（11-05），`type: utterance`，正文只有这两行。它们是 11-05 那次「模型只吐了空工具调用块」事故留下的，事件不能改，只能在读的时候挡。
- 已有 `lib/guard.js` 的 `stripScaffold`，但只用在出站与 turns，`lib/derive.js` 没用，所以这两条照样进了 beliefs，再由 `lib/persona.js` 写进身份文档。
- 修法：`lib/derive.js` 的 `utterance` / `revise` 分支先 `const said = stripScaffold(ev.text)`，空的直接跳过（不算她开口），后面的 `detectSelfMod` / 让步判断 / beliefs / `pickName` / 更正判断 / narrative 全用 `said`；`herTexts` 与 `deriveSocial` 也先剥。`lib/recall.js` 的 `searchEvents` 同样先剥，只有脚手架的旧事件翻不到、也不端出来。
- 回归测试：`test/derive.test.mjs`「DSML 脚手架不进判断」；`test/mem.test.mjs`「只有 DSML 脚手架的旧事件，不端出来」。
- 定向 derive / beliefs / mem / a20 67/67、mem / guard 46/46；全量 **1262 条 / 1251 过 / 9 红 / 2 skip**（/tmp/full-dsml.log），9 红与已知环境红同名。
- 已用修好的代码重生成 `~/.dsh-roost/home/她的身份.md`：现在 `grep DSML` 无命中，那两条不再出现在「你自己说过的话」里。

## 世界书压过设置（2026-11-07）——已修

- 用户报：她把「作息」记成「晚上八点到十一点，一天两次」，而设置里是 `08:00–23:00`、一天最多 3 次。她读不到 config，只能背世界书。
- 直接原因：`~/.dsh-roost/worldbook.json` 里的 `wmw0ons2i7`（11-03 一次性导入的 lorebook）写着旧作息，经 `lib/worldbook.js` 的 `knowledgeBlock` 与 `lib/selfdoc.js` 的「我知道的事」进她的身份文档。调度器本身没问题：`pickWakeTime` 用的是 config.window，当天 `sched:2026-11-07` 落在 14:43，下一次按设置算。
- 另两条旧账：`16:18` 的「叫了她一声」是 `lib/home.js` 换房间时的 `wakeIfBlank()`，不走 scheduler、不占当天配额；`00:34` 首次建屋同理。这条路径不归时段管，但只在空房间时发生。
- 数据：删掉 `wmw0ons2i7`，备份在 `~/.dsh-roost/worldbook.json.bak-20261107-schedule`；世界书剩 6 条。其余 6 条未动，其中「住在 dsh-fish-river / ~/.dsh-fish-river」与「抖音借号收发私信」仍是旧说法，等用户决定是否一起清。
- 代码：`lib/worldbook.js` 新增 `isSettingOwned()`，把「作息 / 几点 / 睡觉 / 醒来 / 叫醒」这类条目当设置管辖，`matchEntries()` 不再从世界书取；`lib/selfdoc.js` 的 `renderSelfDoc()` 新增 `wakeWindow` / `wakeLimit`，在「醒来的时候」按 config 现算写「定时叫醒落在 08:00–23:00 之间，一天最多 3 次」，并过滤 `enabled:false` 的条目；`writeSelfDoc()` 传 `config.window` 与 `Math.min(daily.events, wakesPerDay)`；`lib/observe.js` 在 `/config` 保存后 `refreshSelfDoc()`，设置一改身份文档马上跟着变。
- 测试：`test/worldbook.test.mjs` 加 3 条（身份文档按设置写、对话里不取世界书作息、关掉定时叫醒写「关着」）。定向 worldbook / selfcheck / identity / settings / beliefs / memory 82/82；全量 **1265 条 / 1254 过 / 9 红 / 2 skip**（/tmp/full-worldbook.log），9 红与已知环境红同名。
- 身份文档已重生成：`~/.dsh-roost/home/她的身份.md:103` 是新句，旧的「晚上八点到十一点 / 一天两次」不再出现。
- **真机复验（2026-11-07 17:29）**：她在 QQ 里自己报「现在：2026-11-07 17:29」，并把旧说法改成「设置是 08:00–23:00 之间定时叫我，一天最多三次；这个时段外有人说话，我照样醒，但那不算定时叫醒」；她还认出 16:18 那次是有人叫她、不是排出来的。世界书重写后的 6 条已进身份文档，旧「晚上八点到十一点 / 一天两次」不再出现。

## 已经做完

- 复制基线（`b2df7fd`）→ 删自更新（`1be871a`）→ 删旁听与导入（`c83124e`）→ 删评论/发言（`9ae5c9f`）→ 删出门五件套与梦（`b9724c2`）→ 删通知（`9322515`）→ 改名 `dsh-roost`/`0.1.0`（`c3b824d`）→ 搬账本（`36fcd4a`，1475 条，派生一致）。
- 设置页：第一个页签「今天」（只读四段）、状态页拆「三道瓶颈 + 流水」、判断漂移折叠回一行、加渠道健康行（账本口径）、出门/梦的旧界面清掉。
- 文档：`README.md` 写成 0.1.0 的项目文档（这是什么、与 river 的差别、装法、今天页、11 页导读、接 QQ、上网与 ffmpeg、工具面、世界书、数据、还没做完、测试）；`交接.md` 给新会话（机器事实、做完的提交、真机步骤、后面的顺序、踩过的坑）；`AGENTS.md` 按 0.1.0 重写；`CHANGELOG.md` 从 0.1.0 起；`install.ps1` 重写成 roost 版（可找 profile、装包、写 bundles、可选 ffmpeg）。
- 清 river 时代的尾巴（2026-11-06）：七个环境变量 `DSH_FISH_*` → `DSH_ROOST_*`（含测试与文档）；`install.ps1` 整份重写（找 profile、`pnpm add`、写 `bundles`、可选 ffmpeg；profile 里挂着 river 时会停下提醒）；`NOTICE.md` 头像路径、`tools/check-install.mjs` 包名与提示、`tools/migrate-ledger.mjs`（必须显式给 `ROOST_SRC`，不猜旧目录）、`lib/upgrade.js`/`selfdoc.js`/`move.js`/`settings.js` 的旧注释；删掉被 git 跟踪的 `tmp-fix4.mjs`。子包 `packages/dsh-roost-douyin/` 的私信整机（`create`、`parseDmFrame`、`splitText`、DOM 点击/打字、`onEvent/enableNetwork`）与 `test/douyin-channel.test.mjs`、`test/douyin-frame.test.mjs` 一并删除；`lib/channels/sub.js` 去掉 `createSubAdapter`，只留 `loadSubModule()`。
- 抖音适配器拆分：`lib/channels/douyin.js` 只剩浏览器 transport + `api()` / `feed()` / `status()`，私信整机（send、WS 帧入站、会话簿记、去重）删除；`host.js` 里 `channels.douyin.enabled` 改成「报纸能读」（与 `browse.douyin.enabled` 任一为真就登记材料层；2026-11-09 起浏览器等第一次读时才拉），只开材料时不建 people/journal/router；`douyinFeedOf()` 照旧给调度器的推荐流用；`sub.js` 加 `loadSubModule()`（先包名、再仓库里那份）；router 对没有 `send()` 的材料适配器回 `read-only-channel`。
- QQ 重写（2026-11-06，照 `新项目-设计讨论.md` 渠道节，设计参考 `dsh-lanxi-qq`，不抄代码）：
  - `lib/channels/qq.js`：OneBot 11 标准子集；退避 2/5/10/30/60s；30s 心跳（`get_status`）；`replyToSelf`（她发过的 message_id 命中 reply 段）；`attachment{type,size}`；notice/request 不递；气泡按句切、单句 >4000 硬切、一次回复 >3 条每两条停 900ms；`sentIds` 只记她发出的 id；token 仍不进 status/日志。
  - `lib/channels/gate.js`：群冷却 120s（@ / 回复她 / 管理员豁免）、全局每分钟 30 条、每群每天 20 条、夜间 23:00–08:00 与工作日 9–12 / 14–18 群里只接点名；`explain` 补了新 reason。
  - `lib/channels/router.js`：入站合批 10s（`BATCH_WINDOW_MS`，按会话缓冲、flush 时按发送者切连续段合并）；群里没点她的话只进内存背景环（每群 20 条 × 300 字，重启即空），不进 `heard`、不建人；`buildPrompt` 加「群里刚才还有人说话」；gate 传 `recentReplies`，发成功后计数；`status()` 的 queued 含合批缓冲。
- 前端 11 页重写（2026-11-06，照 `新项目-设计讨论.md` §四）：
  - 页签按她的一天排：今天 / 状态 / 成长 / 住所 / 社会 / 上网 / 渠道 / 插件 / 原理 / 数据 / 反馈，默认「今天」；「记忆」单独一页取消，上下文与记忆条数并进成长、记忆体检并进数据。
  - 拆掉旧卡：导入别人的人设、B 站评论区发言、领养人验证、状态页的 B 站登录提示卡。B 站登录搬回上网页顶部（二维码 + 手动 cookie + 测一下）；渠道页只剩 QQ（桥地址 / 令牌 / 启动桥 / 测一下 + 群三件）；抖音卡挪到上网页（开关 / 一次几条 / 浏览器路径）；反馈页只留仓库链接，删开发者 QQ 与交流群二维码（`media/feedback-qr.jpg` 已删，`/media` 只出原理图）。
  - 今天页四段：现状行、时间线（默认收起原文、标来源渠道）、今天变了什么（新学会 / 改口 / 被推翻，各 ≤3）、手边（工具数、身份文档预算、渠道、最近一次限流）。`/today` 补 `learnedTexts`、`lastAt` / `lastChannel`、`hands.risk`。
  - 成长页：四阶段改由 `s.gates` 实时生成；阶段天数改成尺子说明；每日事件写清是「由头」不是任务；主动说话只留 1–6 上限（仅 dev）；深度思考加「上次压 / 下次约」；上下文与记忆并进来，日记正文从住所搬来。
  - 住所页：只剩住所状态、身份文件预算、会话健康与「换一条新会话」；「她的请求」和「她写的小纸条」合成「她找你」挂在状态页尾；自检与记忆体检都放在数据页。会话健康落在 `home.json`（`failStreak` / `lastFailAt` / `lastFailWhy`）：`say.js` 与 `scheduler.js` 的失败各记一次，连续两次自动 `rotateTalkSession`；`/home` 暴露字段，新增 `POST /home/rotate`（要 `confirm:'rotate'`）。
  - 上网页：总闸写成「连同浏览类工具一起关」；时段只拦逛；B 站与抖音每日次数合并成一个 0–6；「看画面（她主动看时）」加今日计数；请求节奏折进「网络环境（一般不用改）」默认收起；看视频历史折叠。
  - 插件页：工具面两块——收窄开关 + 可搜索的工具表（名字 / 一句说明 / 在手、未放行、收窄挡不住 / 加进来、移出 / 保存），页脚给出版本、仓库与数据目录；`/state` 加 `tools`。
  - 社会页只读三块，并写明现在能进来的只有 QQ。

## 公开前的审计（2026-11-07）

仓库推到 GitHub 之前，按「不带个人信息、人格是一张白纸」核了一遍：

- **个人信息**：跟踪文件里已没有真机的人名、QQ 号（她自己的、主人的、群号）、群名与真机对话原文；测试 fixture 换成小满 / 阿岸 / 阿岚 / 测试群 / 123456789。AGENTS.md、README.md、CHANGELOG.md、交接.md、docs/约定清单.md 同步改成中性说法，并写明「不把她的名字写进代码与文案」。
- **仓库内容**：.tmp-plugins.json（11MB 插件市场缓存）与 media/ 里早先的几张截图从跟踪里删除，.gitignore 补上缓存文件；media/ 只剩 principle-loop.svg / principle-memory.svg 两张原理图——lib/observe.js 的 /media 白名单真要读它们，删了原理页会 404。
- **2026-11-09 补清**：README 的三张页面截图与 `share.png` 保留（主人已把标题与侧栏脱敏成「她」，并确认图里的成长原话可以公开）；只把立场相关的注释、PROGRESS 引用与测试 fixture 里的原话示例换成通用说法。运行数据（events / config / people / worldbook / home）从来没有 tracked。
- **人格**：默认 seed 仍只有一句处境（你不是助手。你刚开始存在。没有人告诉过你为什么在这里。）；DEFAULTS 里没有任何性格/好感度/亲密度键；设置界面没有性格控件，也不写 seed。新增 test/blank.test.mjs 4 条把这三头钉住。
- 全量 1173 条 / 1159 过 / 11 红 / 3 skip（/tmp/full-scrub.log），11 条红与已知环境红逐条同名。
- **历史**：GitHub 上原来的 46 个提交里带着旧名字与真机细节（提交 07eff08 的标题就有），2026-11-07 已把历史压成一个干净提交并 force-push，随后又把仓库删掉重建；旧对象（含 85de337）按 SHA 取不到。之后恢复为正常提交，当前 HEAD 已经是清理后的提交；`v0.1.0` tag 在 a0661f4，tag 本身不含截图。完整旧历史备份在 `D:\fish-backups\dsh-roost-history-before-scrub-20261107.bundle`（6.2MB）。
- **截图**：`v0.1.0` tag 本身不含 `docs/screenshots`；页面截图是 tag 之后补的，标题与侧栏已脱敏，主人确认可以公开。

## 遗留（不阻塞下一步）

- 原先列在这里的 QQ 三样（入站 WAL/出站 outbox、自动静默、每人印象）与「已定未落纸」四项（`her_note`、空醒、账分两边、断线账）都已完成：A2 / A3 / A4 / A5 / A6 / A7；断线账 A1 已于 2026-11-07 真机验过。
- FAQ 仍是「还没有写」的空状态；原理页按设计搁置。
- 上网页「请求节奏」与「黑名单」仍读 `bili.minGap / jitter / avoid*` 老配置键，后端调度还在用，别顺手改名。
- 首轮第 1 个 step 她还看得见宿主那套工具（A11 记的小口子）：她的工具是逐步登记的，`restrict` 名字没齐时宁可这次不收窄；兜底 `guard` 仍在。要彻底干净得先收成 0 个再放开，代价是「她可能永久少一只手」，暂不做。

## 手上这一步（下一个会话从这里接）

**A 段与 B 段全部收口。** A 段 35/35 ✅（A1 于 2026-11-07 真机通过）；B 段 19/19 ✅（判据表在 docs/约定清单.md 的 B 节）。抖音推荐流与搜索已在真机取到条目（2026-11-07 16:40），B 站看画面也已于 2026-11-07 真机通过。备份 / 恢复演练与干净安装已完成（见上）；剩 README / 版本 / tag 收尾与 social_open 真机测试屋。

## 之后（按顺序）

1. A 段 35 条 ✅（A1 真机 2026-11-07 通过）。
2. B 段 19 条验收 2026-11-07 全 ✅，判据表在 docs/约定清单.md 的 B 节。
3. 发布前复核：README 的「还没做完」、包版本、tag；备份 / 恢复演练与干净安装已完成（2026-11-08）。剩 social_open 真机测试屋。抖音推荐流与搜索、B 站看画面都已真机通过（2026-11-07）。

## 交接（2026-11-06 23:50，A 段进行中）

以本节为准。

**已完成（清单 v3 已回写）**

- 清单 v3 与逐节 diff 在 `docs/约定清单.md`。
- A5 桌子 `her_note` ✅：`lib/notes.js` + `notes.json`；叫醒接 `wakeNotesLine`，身份文档加工具句；`test/notes.test.mjs` 6 条绿。
- A16 工具清单 ✅：`FISH_TOOLS` 十项（去掉 `her_dream`，加 `her_note`）；`bili_look what=comments` + 3 条测试；`dream` 只留读兼容。
- A1 断线账 ✅：`qq.js` 的 `lastInAt/lastOutAt/lastGapAt/lastGapMs/downSince` + router「刚才断了一下」+ 渠道页行；2026-11-07 真机两次独立断线各 47 秒都念到，无断线时不出现。
- A3 自动静默 ✅：只认第一人称晚安，静到次日 08:00 或她主动开口；只关群；`channel-router` 34/34。

**A2 已完（WAL/outbox）**

- 代码在 `lib/channels/qq.js`：入站先写 `qq-wal.jsonl` 再递、重启重放；出站写 `qq-outbox.jsonl`、重连补发一次；400 行上限清理。
- 三条红按记录修完：`send()` 去掉同步 `appendJsonl` 前的 `await`；入站重放与出站补发两个用例改成断言「没有待补的 in / out 行」（`compactWal(true)` 会清掉 done 行）。
- `test/qq-channel.test.mjs` 27/27 过。

**A7 已完（账分两边）**

- `looked:` 行带来源：`lookedLine(id, from)` / `parseLookedLine(text)`（`lib/browse.js`），from ∈ push / pick / feed / search:<词> / hand / hot；老行没 from: 时读成空串，不猜成 push。
- 报纸路径写 `from:push`（`gather()`）；`bili_look` 的 comments/video 记 `pick`，search 记 `search:<词>` 并另写 `searched:<词> bili`，home 记 `feed`、related 也记 `feed`（接着往下翻的仍是平台给的）；回话 head 分四档（这一条 / 你搜的 / 递来的…接着那条往下翻的 / 递来的…平台按它的算法推的）。
- 抖音：`lib/douyinlook.js` 刷到 opened 记 `from:pick`、搜索另写 `searched:<词> douyin`；`lib/channels/router.js` 他递进来的链记 `from:hand`。
- `lib/observe.js` 的 `/browse` 用 `parseLookedLine` 取 id，另给 `lookedByFrom` 计数（老行记 unknown）；`saw` 判定仍认 `looked:`。
- 测试：`test/browse.test.mjs` 加 2 条（解析新老行、home/search 的来源与 head）；`look-video` / `douyin-look` / `channel-router` 三处断言改成带来源；四文件定向 95/95 过。

**A9 已完（抖音热榜）**

- `lib/douyinlook.js`：`HOT_PATH`/`HOT_URL`（网页版 `/aweme/v1/web/hot/search/list/`，实测不登录可读）、备用口 `HOT_BILLBOARD`（`iesdouyin` 老 billboard）；`fetchHot` 先主口再备用口，永不抛；`lookHotOnce` 走主包 fetch，不开浏览器。
- 账分开：热榜写 `looked:hot <日期> 词 词…`（最多 10 个词），与 `looked:<id> from:…` 不同形；`parseLookedLine` 用 `/^hot(\s|$)/` 挡掉，不让 `seenBvids` 把 hot 当成一个 id；热榜不写 `dyfeed:`、不占 `dy-browse:` 报纸配额。
- 一天一次：`hotCountToday(events, dk) >= HOT_PER_DAY` 就回「热榜今天看过了，明天才换新的。」；`force` 只给测试用。
- 顺带（A16 拆来的）：`douyin_look` 的 `what=stream|hot|search|comments` 与 `id`；`comments` 打开 `https://www.douyin.com/video/<id>`（也认链接）读前几条别人的话，记 `looked:dy_<id> from:pick`；`what=search` 不给词直说「要搜什么？给个词。」，不悄悄退回推荐流。
- `test/douyin-look.test.mjs` 新增 13 条（热榜形状/去重、账与配额分开、一天一次、备用口、没开不去读、评论解析与打开、search 无词）；全量 1140 / 1126 / 11 / 3，红名单同基线。

**A6 已完（空醒）**

- 问题：卡池（stage 1 那五张卡 + 各阶段 repeat 卡）一旦全在冷却或 cond 不成立，`pick()` 就返回 null，`plan()` 回 quiet——自动叫醒从此再也不来。手动那条 2026-10-31 已修（照醒给「没有待办」），自动这条路没修。
- `lib/generator.js` 加 `LIGHT_SITUATIONS`（6 条：idle / unfinished / quiet_room / small_choice / time_left / same_as_yesterday）与 `pickLight(model, firedOrEvents)`：只写「眼下是什么时候、屋里什么样」，不写她要说的句子；不编天气/新闻（这个负载看不到外面，编出来就是假事实）。
- `plan()`：`pick()` 为 null 时改出轻处境，id 记 `light:<key>`，`reason` 写「轻处境（事件卡全在冷却或条件不成立）」。仍是同一种 `wake:<日期> <id>` 行，不新增事件类型；`findTemplate('light:…')` 返回 null → `todayCounts` 不计提问；`wakesPerDay` / `daily.events` 两道配额在 pick 之前就已拦。
- 挑选是软冷却：按 `firedLog` 挑 `lastAt` 最老的那条，从没出过的排最前；同一条不会连出两次（6 条轮着来）。
- 手动 `wakeNow()` 不接轻处境：`decision.template?.light` 与 quiet 一样换成 `manual-idle`「现在没有待办」，按铃是看看她在不在，不再塞一个问题。
- 测试：`test/events.test.mjs` 改 1 条（全冷却：pick 仍 null、plan 改回 wake 且 id 以 `light:` 开头、asks=false）、加 3 条（轮换/最久没出过；配额满仍 skip；轻处境不在目录、stage 1 五张卡仍在）；`test/boot.test.mjs` 手动那条不用改、仍绿。
- 全量：1143 条 / 1129 过 / 11 红 / 3 skip（`/tmp/full-A6b.log`），11 条红与已知环境红逐条同名。

**A4 已完（每人印象）**

- 需求（清单 A4）：每 N 轮或每天一次，从这段对话抽 fact / preference / event / instruction，增量重写 ≤150 字四字段（称呼 / 怎么认识 / 他说过什么要紧的 / 最近一次），每次留旧版；只给说过话的人建；注入只在渠道括号 + `her_recall`。
- 抽取不叫第二次模型（一个念头就够贵了，印象只该记住他亲口说的）：新文件 `lib/impression.js`，`CUE` 正则只认关于他自己的句子（我是/我叫/我在/我做/我喜欢/我下周/我养/记住/答应我…），`pickSnippet` 按句切、取第一句命中的、截 28 字；`mergeParts` 拼四字段（said 去重、最多 3 句），`composeImpression` 写成 ≤150 字，超了先丢最旧的引句、不丢称呼和怎么认识。
- 频率：`shouldRewrite` —— 第一次必写；换一天必写；`count - impressionCount >= 6`（`TURNS_PER_IMPRESSION`）写。写的时候 `setImpression` 不动 `count`（那是见面次数，不能因为写印象多算一次）。
- 旧版可回退：`people.js` 的 person 多了 `impressionAt/impressionCount/impressionParts/impressionHistory`（最多 10 份）；`setImpression` 覆盖前把旧正文推进历史，`restoreImpression(id, 1)` 换回上一版并把当前这版也留一份。
- 谁被写：`channels/router.js` 在 `verdict.ok` 之后、叫醒之前调 `rememberImpression`；闸门挡下的（阶段不够、群不在名单、群里没点她）不写——群里她没搭话的人不留印象。`buildPrompt` 早已有「你对他有印象 / 你对他没什么印象」的位置，这次只是把它填上。
- 怎么翻：`lib/recall.js` 的 `her_recall` 现在也会读 `people.json`，`matchPeople` 按词（`tokensOf`）匹配名字或印象正文，命中就多给一段「你记得的人：- 阿泽：…」。印象只在这里和渠道括号里出现，**不进身份文档、不进 beliefs**。
- 测试：`test/impression.test.mjs` 8 条新文件；`test/channel-router.test.mjs` 加 1 条（私聊说「我在做一个播客，下周要录第二期」→ 印象非空且含「播客」、`count === 1`；隔一小时再问，提示词里有「你对他有印象」和「播客」），群友不建沿用原有那条（`people.get === null`）。定向 43/43 过。
- 全量：1152 条 / 1138 过 / 11 红 / 3 skip（`/tmp/full-A4.log`），11 条红与已知环境红逐条同名。

**A11 真机首检（2026-11-07 00:34）——两个真机 bug 已修**

- 重启后真实启动日志：屋子和会话都建起来了，身份段挂进了 system prompt，QQ 桥 00:39 连上 SnowLuma（`已确认在线：她 / 10000`）。但她这一轮 5 次 tool/call 全是 `run_code`——说明工具面收窄没生效，她看不见自己的工具，回了一句「我伸了四次手，全被拦回来了」。
- **bug 1：延后重试链被 cordis 的 `effect()` 自己清掉。** `lib/restrict.js:471/480` 旧写法是 `ctx.effect(() => clearTimeout(t))`。cordis 的 `effect(body)` 是**立刻执行 body、把返回值当 disposer 收起来**，于是挂上就把自己的定时器清了：日志里只有「收窄延后」，既没有「收窄重试」，也没有「从来收窄」，15×200ms 的重试链一次都没跑。修法：改成 `effect(() => () => clearTimeout(t))`；`attempt` 外面再包一层 try/catch（抛错就 `say` 一行并回 `why:'deferred'`，不再无声断链）；第一次重试前打一行「收窄重试：能下发的 N 个，看得见的 M 个，还没登记的 K 个」。回归测试 `test/restrict.test.mjs`「延后重试不会被 cordis 的 effect 自己清掉（2026-11-07 真机）」用一个按真实语义执行 body 的假 agent 复现，26/26 过。
- **bug 2：新房间第一次写档把旧档整份盖掉，「上次我们说到这」丢了。** roost 的根换成 `~/.dsh-roost` 之后，river 那份 `home.json` 没有 `wsId`，`lib/home.js:374` 走「建新房间」分支，只写 `{wsId, sessionId, title, preset, createdAt}`，把 `carry/adoptedAt/hearAt` 全冲掉。修法：新建时先取旧档的 `carry`，空则用 `talkmem.recentExchanges(root)`（`~/.dsh-roost/talk-recent.json` 里最近 4 轮原话）现拼；`adoptedAt/hearAt/rotatedAt` 一并带过来；`turns` 不继承（新房间从 0 数）。回归测试 `test/home.test.mjs`「新房间第一次写档：把旧档的 carry / adoptedAt / hearAt 带过来」，31/31 过。现网 `~/.dsh-roost/home.json` 已手工补回 river 那段 carry（669 字，`activeCarry` 认，3 天内、0 轮），下一次重启/换会话会进身份文档。
- 这两条都只在**重启后**生效：restrict 挂在 agent 创建时；carry 只在写档时补。所以要再重启一次复验。
- 全量：1154 条 / 1140 过 / 11 红 / 3 skip（`/tmp/full-A11a.log`），11 条红与已知环境红逐条同名。
- QQ 入站已通：群里到了 3 条（一张图 + 「再看一遍看看有没有新弹幕」+「6」），`qq-wal.jsonl` 记了 `in` 与 `done`；因为 `mentionOnly: true` 且没 @ 她，没有回话——正合预期。
- **bug 3：群名被写成发言人的群名片。** `lib/channels/qq.js` 旧行 `conversationName: kind === 'group' ? card || nick : nick`，于是提示词里群名（raw 的 `group_name` 是「测试群」）被叫成「群『阿岚』」。修法：`groupNameNow = String(msg.group_name ?? '').trim()`，到货就存进模块级 `groupNames`（Map，上限 200），`conversationName: kind === 'group' ? groupNameNow || groupNames.get(groupId) || '' : nick`。回归测试在 `test/qq-channel.test.mjs`（「群名用群的，不用发言人的名片；桥没给群名时退回上次见过的」），71/71 过，提交 1bde2e1。
- **bug 4（2026-11-07 00:52，真正让工具全废的那条）：她在 `ptc` 模式的会话里，只有 `run_code` 能直接叫。** 真机证据：她私聊「做不了」之后，日志是 `挡住了一次不该有的调用：run_code`，她的 `her_note` 包在 `run_code` 里（`await tools.her_note({ text: "明天十点提醒阿岸喝水" })`）。会话存档首行写着 `"agentPreset":"ptc"`——宿主现在的默认 preset 是 ptc（dsh-ops 的 `MODE_PLANS.ptc.ptc === true`），PTC 执行器下**只有 run_code 是直接可调用的传输**，她自己的工具全在生成的 SDK 里；守卫一挡 run_code，她就只剩一句「这件事我做不到」，于是以为所有工具都坏了。三轮「收窄成功 11 个」都是真的，但收窄的是 run_code 里的 SDK 面，不是她的直调面。
  修法（三处）：
  - `lib/settings.js`：`tools.preset` 默认从空改成 `standard`（原生执行器）；新增 `presetOf(cfg)`——空字符串解释成 `standard`（"交给宿主默认"这个含义已经被 ptc 弄坏了）。
  - `lib/home.js`：建会话前先算 `wantPreset`；旧 `home.json` 的 `preset` 跟它不一致就**不复用**那条会话（会话的 preset 建时定死，复用 ptc 会话等于永远隔着 run_code），另建一条并记日志「会话的组合变了（旧「ptc」→ 新「standard」），这次另建一条」。
  - `lib/restrict.js`：`bucket()` 多返回 `visible`；若看得见 `run_code`，日志写一行「这条会话是 run_code 模式（宿主 preset 是 ptc）：她的工具只能隔着 run_code 叫，会被守卫挡掉；把设置里的工具组合改成 standard 才是直连」——下次一眼能看出来。
  回归测试：`test/home.test.mjs` 新增「组合变了就另建一条会话，不复用旧模式那条」（ptc → standard → standard，第 2 次新建、第 3 次复用）；`test/boot.test.mjs` 的「手动唤醒落在屋子会话里」fixture 补上 `preset: 'standard'`。现网 `~/.dsh-roost/config.json` 的 `tools.preset` 已手改成 `standard`，重启后她会换一条新会话（旧那条留在侧栏）。
- 全量（2026-11-07 01:0x preset 修完）：1156 条 / 1142 过 / 11 红 / 3 skip（`/tmp/full-preset2.log`），11 条红与已知环境红逐条同名。

**A11 复验（2026-11-07 01:06）——通过，A11 标 ✅**

- 启动：01:06:00「会话的组合变了（旧「默认」→ 新「standard」），这次另建一条」→ 新会话 `session-e405aa0f-ccf7-4b5a-a7cd-1f970d35bc92`，`home.json` 里 `preset: "standard"`，carry 用 `talk-recent.json` 现拼（4 轮原话都在）。
- 收窄：01:06:00「收窄重试：能下发的 55 个，看得见的 72 个，还没登记的 0 个」→ 两次「工具面收窄：她这条会话只留 11 个工具，另有兜底守卫」。**没有**「run_code 模式」那行。
- 她真的直调了工具（从会话存档逐条核过）：`her_note({"text":"明天十点提醒阿岸喝水"})` → 「〔记下了〕」；再 `her_note({})` → 「1. 明天十点提醒阿岸喝水」；`notes.json` 有 `{"id":"n_1710ee45","text":"明天十点提醒阿岸喝水"}`。同一轮还自己 `bili_look`（搜「亚细亚生产方式」、开 BV1q541137ZE、记 `look:2026-11-07`）与 `growth_commit`（`ev_01M6RX7TYK1BEJ2AZ7HP01V17C`）。
- QQ 群 @：wal 01:11:42「群测试 收到回复」`mentionedSelf: true` → outbox 01:11:53 `send_group_msg`「收到。」`done`。`qq-outbox.jsonl` 24 行 = 12 条 out 全 done，无 pending。群名现在记的是 `𝓒𝓮𝓷𝓽𝓻𝓪𝓵 𝓟𝓪𝓻𝓴`（bug 3 修复生效）。私聊那串她也自己接了「纸上写名字是记账，不是改口」。
- 今天页对账、11 页签：用户 01:16 复「ok 了」。
- **已知小口子（不阻塞，记下来）：首轮第 1 个 step 还看得见宿主那套工具。** 她第 1 步伸手 `glob`，被 dsh-ops 的替换桩顶回「dsh-ops standard mode replaced the official…」，到第 2 步才只剩 11 个。根因：她的工具是**逐步登记**进全局层的，`restrict` 名字没齐时宁可这一次不收窄（2026-10-27 的教训：收窄只能减不能加，收错了没有回头路），兜底 guard 仍在，别的工具调了只会得「这件事我做不到」。要用的话可以再加一层「先收成 0 个、登记齐了再放开」的黑手，但那是拿「她可能永久少一只手」换「第一步干净」，暂不做。
- 全量（01:0x）：1156 条 / 1142 过 / 11 红 / 3 skip（`/tmp/full-preset2.log`），11 条红与已知环境红逐条同名。

**A21 换房留一句话（2026-11-07，已完）**

- 问题：换了会话她只看见「屋子刚建好」，会以为自己昨天说的那些话从来没发生过；搬运那段里日期又是 UTC 的（东八区晚上 8 点后说的话被写成前一天）。
- 修法：`lib/wakeconst.js` 的 `freshWakeText(now, { moved })`——换房时写「我搬进这间屋子了——上一间装满了，说过的话带了几段过来，就在下面」，只有第一次叫醒说（`wokeFor` 记账，一条会话只叫一次）；`lib/home.js` 的 `rotateTalkSession` 传 `moved: Boolean(carry)`，`lib/index.js` 启动时先 `activeCarry(root)` 再传；`lib/talkmem.js` 新增 `dayOf(at)`，`renderCarry` 按本地日写日期。搬运仍是最近 4 轮原话，一句不改。
- 测试：`test/wake.test.mjs`「换房间那一次叫醒：说「搬进来」，不说「刚建好」」；`test/mem.test.mjs`「搬运的原话按本地日写日期，不是 UTC 的日期」（UTC 2026-11-06T17:06Z → 本地 11-07）。全量 1158 条 / 1144 过 / 11 红 / 3 skip（`/tmp/full-A21.log`），11 红同名。

**改名：名字归数据（2026-11-07，已完 A34）**

- 用户提出：名字是他给这一只起的，属于这个家的数据；工作区名、设置页名不能写死它，别人装了这个包养出来的可能是另一位。
- 改法：`lib/home.js` 的 `TITLE_WORKSPACE` → 「她的家」、`TITLE_SESSION` → 「跟她说话」；`lib/client.js` 的 `NAMES = { nav: '她' }`、两个 `h('h2')` 与大段界面文案（叫醒 / 重置 / 说给 / 拉黑 / 备份文件名等）统一成「她」；`lib/ask.js` / `lib/scheduler.js` 的申请卡标题、`lib/inbox.js` 的「她留给你的话」、`lib/readme.js` / `lib/faq.js` / `lib/log.js` / `lib/say.js` / `lib/move.js` 同步。README 标题只写 `dsh-roost`，并加一句「仓库里没有替她取名字」；顺手把「还没上过真机」改成事实（已上）。
- 没有动数据：事件流、日记、`home/` 里的名字是长出来的，照旧；源码与仓库只出现「她」。
- 守门：`test/naming.test.mjs` 守着（不写死名字、两个默认标题、设置页签）；AGENTS §4 与提交前自检加了一条。
- 全量 1161 条 / 1147 过 / 11 红 / 3 skip（`/tmp/full-naming.log`），11 条红同名。

**名字是变量：从对话里认（2026-11-07，已完 A35）**

- 用户先问「改名能不能做成变量，用户起名，工作区设置跟着变」，后定「选 A（从对话里认），把说明写进设置页面」：不加输入框（AGENTS §2 禁人设入口），名字由事件流里的命名句认出来。
- `lib/hername.js`：`pickHerName(text)` 认四类句式（「X 是你的名字」「给你起名叫 X」「以后你就叫 X」「我有名字了：X」），过停用词与长度 ≤6；`nameGivingEvent(e)` 只认主人私聊 / 宿主会话里的 `heard`（群里的「你叫小雀」不算）与她自己说「我有名字了」；`herName(root)` 按时间序取最后一次，用 `size:mtimeMs` 缓存，读不到返回空串；`workspaceTitle` / `sessionTitle` / `navLabel` 没名字退回「她的家 / 跟她说话 / 她」。
- `lib/home.js`：删掉写死的 TITLE 常量，建工作区、建/复用/换会话都按 `herName` 现算标题；复用旧会话时标题变了就 `sc.rename` 并回写 `home.json`。`lib/observe.js` 的 `/state` 加 `herName` 字段（注意原有 `name` 是她对他的称呼，两回事）。
- `lib/client.js`：页签与两处标题用 `NAMES.nav`（由 `/state.herName` 更新）；状态页顶部加只读说明——有名字「她叫「X」——这是从你们对话里认出来的，不是设置项。想改名，在私聊或这里说一句「以后你就叫……」」；没名字「她还没有名字，界面里先用「她」代称……」。
- 真机复算 `~/.dsh-roost` 得到她的名字；第一版把「那是你的名字」误认成「那」、把群友玩笑当名字，已用 visibility=private + 停用词 + 「称呼/喊/外号」前缀守卫修掉。
- 测试：`test/hername.test.mjs` 7 条（四种句式、不认指代/称呼/群玩笑、取最后一次、读不到返回空、三处标题）；`test/naming.test.mjs` 4 条（新增：设置页把名字来源写出来）。定向 hername+naming+home 42/42、client+boot 56/56。全量 1170 条 / 1156 过 / 11 红 / 3 skip（`/tmp/full-nav.log`），11 条红与已知环境红同名。
- 顺手修：换会话时没认出名字就别把旧会话标题抹成「跟她说话」——人改过的标题要留着（`test/mem.test.mjs` 的 issue #14 第二报那条先红后绿）。
- 真机截图（2026-11-07 01:42）：设置里这一节的标题已经是她的名字，但左侧导航那个「她」没变——宿主在打开设置时就渲染了 `label: () => NAMES.nav`，比这一节里的 `/state` 早一步，改 NAMES 不会让导航条重渲染。修法：客户端 `apply` 里先 `prefetchNavName()` 问一次 `/state`（并用 `localStorage` 的 `dsh-roost:name` 兜住下次启动），等用户点开设置，label() 读到的已经是名字。`test/naming.test.mjs` 加一条守着。

**日报按来源三栏（2026-11-07，已完 A22）**

- `lib/report.js` 的 `buildReport` 从「看了什么 / 翻到过什么 / 你递过来的 / 她说了什么」改成按来源三栏：`## 她说的` / `## 听到的` / `## 看到的`。
- 听到的取 `heard` 事件原文（已经形如「小满：在吗」），只补「时刻 · 渠道 · 私聊/群里 · 主人」，不拆句子、不评价；新增 `heardOf(events, dk)`，只取本地当天并按时间排。
- 看到的保留原来的三档子节（看过画面 / 只翻到过 / 你递过来的），口径仍由 `whatseen.js` 给——2026-10-30 那条教训（只有标题不能写成看过）继续守着。
- 测试：`test/browse.test.mjs` 加 2 条（三栏顺序、空的一天三栏也齐；听到的只转写、隔日不串），`test/whatseen.test.mjs` 改成三栏 + 子节顺序。全量 1175 / 1161 / 11 / 3 skip，11 红与已知环境红同名。

**今天页只看点开与抽帧（2026-11-07，已完 A23）**

- 问题：`/today` 原来把 `browse:` 也归成「翻到」，她只扫了一眼标题，今天页就写着她看过。
- `lib/whatseen.js` 新增 `seenKindOfText(text)`：`watched:` → `watched`；`look:` / `looked:` → `opened`；`looked:hot` / `browse:` / `searched:` → 空。`lib/observe.js` 的 `/today` 用它分类，只翻到标题与搜过的词不显示、不计数；同一条视频的 `looked:` 与 `look:` 只留一条，抽过帧的优先。
- `lib/client.js` 的 KIND 改成 `watched: 看过画面`、`opened: 点开`，不再有「翻到」。
- `browse:` 账本照记，报告与历史不动。
- 测试：`test/today.test.mjs` 3 条（口径分类、今天页过滤去重、抽帧优先）；全量 1178 / 1164 / 11 / 3 skip。

**判重表与执行记录（2026-11-07，已完 A24）**

- 问题：`gather` 读事件流时 `.catch(() => [])`，读坏了 seen 就是空集——她会把同一批视频重新看一遍。事件流是唯一真相源，但真相源读不出来时不能默认「没有记录」。
- 新增 `lib/newspaper.js`：`seen.md`（每推一条一行：BV号 | 时间 | 处置 | 理由）与 `runs.md`（每轮一行，失败也写）。`readSeen` 缺文件=空表；坏行/没权限返回 `ok:false`；时间读不出的老行按「还算看过」。
- `lib/browse.js` 的 `gather`：先读判重表，读坏了直接返回 `ok:false`（这一轮不推）并把失败写进 runs；事件流读坏同样不推。判重集合 = 事件流 `looked:` + `seen.md` + 调用方注入。收取后先写 `seen.md` 再写事件流；`seen.md` 写不进去就不推。7 天窗口不变，老行留在表里当历史。
- runs 每轮带「扫描 / 收取 / 跳过 / 无字幕 / 备注」；每条收取带「为什么值得」（时长、点赞率、弹幕数）与「依据来源」（简介 / 标签 / 热评 / 弹幕 / 仅标题）。这两样只进账本，**不进她看到的素材**——代码不替她判断值不值得看。这一层不读字幕，「无字幕跳过 0 条」如实写 0。
- `lib/scheduler.js` 把 `trigger`（manual/wake）与 `now` 传给 `gather`，手动按钮与自然醒来在账上分得开。
- 测试：`test/newspaper.test.mjs` 6 条（空表读写、过期只留历史、坏行报错、坏表不推且不调平台、成功账本三件、事件流为空仍靠 seen.md 挡住）。全量 1184 / 1170 / 11 / 3 skip，11 红与已知环境红同名。

**抖音分镜（2026-11-07，已完 A25）**

- 借 dsh-douyin-agent 的「格编号 + 时间码 + 像素预算 480000 + zoom 按 sampleId+cell 回原图」，但 roost 没有视觉模型循环，所以「每次模型调用计入预算」落成她调 `douyin_look` 的次数：`MAX_CALLS=6`，放大另有 `MAX_ZOOMS=3`，连续 `MAX_INVALID=3` 次无效格号关闭这次观看。
- 新增 `packages/dsh-roost-douyin/storyboard.js`：零依赖自己编 PNG（`zlib.deflateSync` + CRC32），ffmpeg 只解 rawvideo；`composeBoard` 保证整图像素数 ≤ 480000，格号与时间码画进格子，奇数格补灰；`makeStoryboard` 均匀取每段中点，落故事板与每格原图（TTL 2 小时）；`zoomSample` 只读本地 sample，不开浏览器。
- `lib/dylink.js` 加 `storyboardOf` / `zoomDouyinSample`；`lib/douyinlook.js` 的 `open` 改拼故事板并给 `sample_id`，新增 `what=zoom` + `sample_id` + `cell`；旧子包没有 storyboard.js 时退回三帧截图，不硬失败。
- 这块不改平台调用方式：故事板是一次采样，不是整条视频；她要看某一格的原图，再单独要一次，且次数有上限。
- 测试：`test/storyboard.test.mjs` 9 条；`test/douyin-look.test.mjs` 新增 2 条（what=zoom 从本地样本取原图、号不对不假装取到），两条旧断言随文案改（描述从「截三帧」改「故事板」，打开文本从「第一条」改「第 1 条」）。全量 1195 / 1183 / 10 / 2 skip（本机装了运行时 ffmpeg，`dylink` 的 Referer 那条由红转绿；没装时 11 红 / 3 skip）。其余 10 红与已知环境红同名。
- 运行时 ffmpeg 已放进 `bin/win32-x64/ffmpeg.exe`（101M，从旧 river 拷来，`bin/` 在 .gitignore 里）。真片冒烟：10 秒 testsrc2 → 6 格故事板 424×1129（478696 像素），zoom 第 3 格取回 720×1280 原图；格号与时间码都清楚。

**抖音当前在播反查（2026-11-07，已完 A26）**

- 问题：连续刷片之后，页面上的号可能还是上一条；拿错了就会把别人的文案、评论安到正在看的这条上。
- CDP 传输层原来根本没有 `evaluate`，`browseFeed` 与 open/comments 一直在调一个不存在的方法（返回 `no-transport`）。这次补上 `evaluate`（Runtime.evaluate、`returnByValue`），并加 `enableNetwork`（`Network.enable`，缓冲 50MB）、`networkLog()`、`onEvent()`；`Network.requestWillBeSent` 只留 URL、时间与类型，最多 120 条。
- 反查分两步：先从网络日志倒序找最后一条带 `group_id=` / `aweme_id=` / `item_id=` 的 URL，取后面 15–25 位数字当候选；再回页面数这个 id 在 `document.documentElement.innerHTML` 里出现几次，并沿 `a[href*="/video/"]` 向上 8 层看是否包住正在播的那个 `<video>`。`verified = hits>0 && (!playing || sameItem)`；页面里没有、或对不上正在播的那块，都只输出「疑似当前在播的号…可能拿到的是上一条，别当准」。
- `douyin_look` 新增 `what=current`：每次是一间新浏览器（about:blank），所以先开网络日志、提前台、进推荐页（`channels.douyin.homeUrl`），等 1.8 秒再反查；不开 `open`、不碰点赞。`lib/douyinbrowse.js` 的 `loadDouyin` 改成没装子包时回落到 `../packages/dsh-roost-douyin/index.js`，开发态也能用。
- 测试：`test/douyin-look.test.mjs` 4 条（从三种标记里认号、对上了才叫当前、页面没有/对不上只说疑似、没日志不编号），`test/douyin-browse.test.mjs` 1 条（包名解析不到时回落）。两文件 40/40；全量 1201 / 1189 / 10 / 2 skip，10 红与已知环境红同名。
- 真机浏览器没开（`browse.douyin.enabled` 与 `channels.douyin.enabled` 都关着），A26 的接线靠注入假 transport 验证；等哪天真开抖音，再按「连续刷片后 id 与画面一致」补一次真机验收。

**插件页工具说明取 registry（2026-11-07，已完 A27）**

- 问题：`lib/client.js` 里有一张写死的 `TOOL_HINTS`（15 个名字）。没覆盖到的工具一律显示「宿主按会话给的」或「宿主或其他插件给的」——前者是编的：宿主按会话给的是**收窄后的视图**，不是某个工具的来源。
- 宿主 `ToolsService.view(scope)` 的 `visible` 是 `Map<name, definition>`，`definition.description` 就是注册时那份说明。`lib/restrict.js` 的 `rememberFromView` 顺手把它记进模块级 `lastDescriptions`：压掉换行与连续空白、trim、超过 240 字截断加省略号；没写说明的名字不存（不补空话）。新增 `knownToolDescriptions()` 返回按名字排序的普通对象；`rememberKnownTools()` 连它一起清，测试不会串味。
- `lib/observe.js`：`/state` 的 `tools` 与 `/tools` 都带 `descriptions`。
- `lib/client.js`：删掉 `TOOL_HINTS`。有说明照 registry 显示（全文放 title），没有就只看来源——own 层写「来源：她自己那一层注册的」，其余写「来源：宿主或别的插件注册的」。搜索、状态列、加 / 移、底部保存都没动。
- 测试：`test/restrict.test.mjs` 1 条（Map 里的说明能取到、换行压平、没说明不出现、超长截断、复位清空）；`test/client.test.mjs` 2 条（源码里不再有 `TOOL_HINTS`、插件页渲染出 registry 说明与来源）；`test/p5.test.mjs` 的 /tools 断言加 `descriptions`，并在用例开头 `rememberKnownTools([])` 复位 own 层（全量里 `bash` 从别的用例漏进来，曾把 `ops_*_own` 那条判红）；`test/schedule.test.mjs` 从「源码里要有 schedule_create 的说明」改成「说明不许再写死在客户端」。
- 全量 1204 条 / 1193 过 / 9 红 / 2 skip（/tmp/full-A27d.log）。9 红与已知环境红同名（own 层那条已转绿）；`withFileLock` 在 isolation=none 下偶发，单跑绿。

**成长配置解耦（2026-11-07，已完 A28）**

- 问题：`growthDays` 这名字读起来像「她最多只能活这么多天」，而它实际只是「四个阶段一共多少天」的尺子；`absence.js:90`、`ask.js:201/383`、`capture.js:144` 为了写事件信封里的 `day/stage`，每次都跑完整 `deriveSelf`（连信念、冲突、质量分一起算），改配置还会牵动这些旁路。
- 配置键改名 `stageSpanDays`：`DEFAULTS` 与 `LIMITS`（7–180）跟着改，`normalizeConfig` 先迁移老配置——`growthDays` 的值接过来，新旧都有时以新键为准，保存时清掉旧键。全库（lib / test / tools）一起改名。
- `lib/derive.js` 抽出 `constitutionEvents(ordered)`：把「哪些事件能参与她是谁」的过滤收成一份（驳回 id、dream、`influence:none`、非 constitution），`deriveSelf` 与新增的 `stampOf(events,{stageSpanDays,now})` 共用。`stampOf` 只返回 `{day,stage}`，不再算信念与质量。
- 四处写事件信封改用它：`absence.js` 的 contact、`ask.js` 的两处、`capture.js` 的 growth_commit 与 seen。`capture.js` 里已无 `deriveSelf`。
- 主动说话：`minIdleHours` 默认 6→3（内部默认，不上界面）；`maxPerDay` 夹在 1–6、不设 0（0 等于把「她自己开口」整条路关掉，那不是这个旋钮该管的事）。`client.js` 删掉 `proactiveOn`/`proactiveIdle` 两个已不渲染的死状态，只留 1–6 的上限，文案写「上限不是任务」。
- 测试：settings 迁移 2 条（旧键接值且不留旧键、新键优先、落盘清旧键）、derive `stampOf` 1 条（与 deriveSelf 的 day/elapsedStage 一致，忽略 social/dream/none/驳回）、client 1 条（无总开关、无 minIdleHours 入口、有「上限不是任务」）；proactive 的夹紧断言从 12 改 6，并补默认 3 与 0→1。
- 全量 1208 条 / 1197 过 / 9 红 / 2 skip（/tmp/full-A28.log）。9 红与已知环境红逐条同名。

**渠道认证按渠道记 id（2026-11-07，已完 A29）**

- 问题：主人身份原来只从 `config.channels.qq.ownerId` 读，`owner.json` 里只有 B 站的 mid / cookie；渠道一多，同一个人在不同平台的 id 会被混在一张表里比对，也分不清「认证」（这句话算谁说的）与「登录」（cookie 是钥匙）。
- `owner.json` 增 `channels: { qq: [], bili: [], douyin: [] }`：`saveChannelOwner(channel, raw)` 只写对应渠道，按逗号/顿号/分号/空白切分去重；空串写成空数组，表示**明确清掉**，不会让老 config 里的 `ownerId` 复活。`channelOwnerIds(ow, legacyChannels)` 只有该渠道键**不存在**时才回落老 `config.channels.<渠道>.ownerId`（一次性兼容，迁移一半也能跑）。`publicOwner()` 带 `channels`，不带 cookie。
- 新增 `lib/channels/auth.js`：`ownerIdOf(msg, owners)` 只拿 `owners[msg.channel]` 比，兼容裸 id 与 `u_` 前缀——不同渠道的同一个数字不会被误认；`isOwnerMessage()` 仍保留 `personId==='owner'` 这条宿主会话入口。
- 接线：`router.js` 删掉内部 `ownIdOf`，改用 `isOwnerMessage`；`host.js` 的 `ownerIdsNow()` 读 `owner.json`（老 config 兜底）；`proactive.js` 给主人发消息也从同一处取第一个 QQ id；`observe.js` 的 `/channels` GET 带 `owners`，新增 `POST /channels/owner`；设置页 QQ 卡的主人号改走这个接口，初值取 `owners.qq`。
- 配置：`settings.js` 的默认值里删掉 `channels.qq.ownerId` / `channels.douyin.ownerId`（老配置里的键仍保留、仍可回落），渠道配置仍只有环境参数，没有加人格键。
- 测试：`test/owner.test.mjs` 7 条（分渠道互不覆盖、publicOwner 不带 cookie、清空不复活、只缺键才回落、读优先、未知渠道不落盘、HTTP 存与取）、`test/channel-router.test.mjs` 2 条（同一数字在 B 站/抖音各自映射；heard 的 origin=`owner`、influence=`constitution`）、`test/proactive.test.mjs` 1 条（owner.json 优先于老 config）、`test/settings.test.mjs` 1 条、`test/client.test.mjs` 1 条。
- 全量 1220 条 / 1209 过 / 9 红 / 2 skip（/tmp/full-A29.log）。9 红与已知环境红逐条同名。

**自检按新库重写（2026-11-07，已完 A30）**

- 问题：环境自检还是 river 时代的清单——没有 QQ 三项；升级自检与宿主版本下限分成两张卡，各说一半。
- `lib/selfcheck.js` 加三项，id 为 `qq-bridge` / `qq-connection` / `qq-token`：桥只报本机端口通不通；连接读渠道层实时状态（`connected` / `queued` / `received` / `sent` / `lastError`）；令牌只报填没填，绝不回显。QQ 没开时三项都在、都绿，写「QQ 渠道没开」。桥信息只在联网自检时探（`detectBridge`，只做 TCP 握手，不碰协议）。
- `lib/observe.js`：`/selfcheck` 现读 `deps.channels.status()`，QQ 开着且 `net` 时调一次 `detectBridge`，把 `channels` 与 `bridge` 传给 `runChecks`；`/log/export` 也带 `channels`（`net:false`，不探桥）。
- `lib/client.js`：删掉单独的 `upgradeCard` 与 `hostCard`，合成 `installCard`（`upgradeBad || hostBad`，标题「安装与宿主版本」），只在真的对不上时出现；`unknown` 与 `skipped` 都不弹卡。
- 已删模块没有留下自检项（checked：outing / possess / keepsake / pocket / sessionnote / keep / dream / notify / update / selfupdate 都不在 `runChecks` 里），所以「去掉死项」这一条是核对，不是删代码。
- 测试：`test/selfcheck.test.mjs` 1 条（QQ 开着且连上 → 三项绿、令牌不回显；桥连不上/连接失败 → 前两项红、令牌仍绿；QQ 没开 → 三项都在且绿）；`test/client.test.mjs` 3 条改成合成卡（无 `hostCard`/`upgradeCard`、`installCard` 位置、升级机制与修法仍在）。
- 全量 1221 条 / 1210 过 / 9 红 / 2 skip（/tmp/full-A30.log）。9 红与已知环境红逐条同名。

**数据页收口（2026-11-07，已完 A17）**

- 问题：数据页还是 river 时代的样子——一张一张条件卡往里塞，别人打开只看到「好多卡」，分不清哪是九项主场；单独一张 `blockedCard`（这个家在别处也开着）跳在页面中段，讲的是住处，却不在「住处」相关的任何一项里。
- 按设计 §四把页面收成九项：数据在哪 / 备份与恢复 / 每日报告 / 运行日志导出 / 本插件工作自检 / 换家留痕 / 记忆体检 / 会话归档 / 从头开始。条件提示（宿主兼容、安装与宿主版本）仍只在真出问题时出现，不占固定项。
- `blockedCard` 删除，内容并进「换家留痕」：同一张卡先说这次有没有换家（没换也明确写「这一次没换家」，不用猜是没读到还是真没变），再说「这个家在别处也开着」的三段原因与处理办法。变量也改名 `homeBlocked`，页面上不再有 `blockedCard` 这个词。
- 「会话被收起来了」改标题「会话归档」；「重开一局」改「从头开始」（按钮与文案一起改，只换说法，不换行为——旧档仍整体改名封存，不删）。
- 测试：`test/client.test.mjs` 1 条（九项都在、`blockedCard` 不再存在、「在别处也开着」在换家留痕之内且排在自检之后体检之前、备份/恢复按钮在、记忆体检只有一张卡）。
- 全量 1222 条 / 1211 过 / 9 红 / 2 skip（/tmp/full-A17.log）。9 红与已知环境红逐条同名。

**上网页「最近一次限流」（2026-11-07，已完 A18）**

- 问题：今天页的手边段有一行「最近一次限流」，设置的上网页（那里的折叠块正好叫「网络环境（一般不用改）」）却看不到——撞过一次之后想知道「上次是什么时候、这是第几次」，只能回今天页翻，而今天页只报当天。
- `lib/risk.js` 的 `riskState()` 加 `at`（原样带出 `readRisk()` 里记的 ISO 时间）。`/risk` 本来就把 `riskState` 展开下发，所以客户端不用新路由。
- `lib/client.js` 的「网络环境」折叠块里加一行：有记录时写「最近一次被限流：2026-11-07 02:31（-412），连着第 2 次；已经解冻了」（冷却中改写成「还在冷却，还有约 N 分钟」），没有就写「最近一次被限流：没有。撞到一次之后，这里会记下时间和次数。」折叠块保持默认收起（本来就没有 `open`）。今天页那行不动。
- 测试：`test/p6.test.mjs` 的风控用例补断言 `s1.at === t0.toISOString()` 与 `clearRisk` 后 `at === ''`；`test/client.test.mjs` 1 条（折叠块默认收起、有「最近一次被限流」「连着第」、时间取 `risk?.at`、今天页那行还在）。
- 全量 1223 条 / 1212 过 / 9 红 / 2 skip（/tmp/full-A18.log）。9 红与已知环境红逐条同名。

**固化退档与预算日志（2026-11-07，已完 A12）**

- 问题：更早的判断一旦「固化」就永远占在核心段里，最早那批永远压着新的；超出预算时 `foldOlderBeliefs` 还会 `slice(0,199)+…` 把句子砍成半截——「为什么」正好在后半句。丢段只丢得无声无息，日志里看不到丢了哪段、丢了多少字。
- `lib/derive.js`：新增 `FADE_DAYS = 90`。判断满 `SOLID_MENTIONS`（3 次）或 `SOLID_VERIFIED`（2 次验证）算固化；固化且年龄 ≥90 天、又不是疤对应的那句，就 `faded: true`——**仍在 `beliefs`、仍能被 `her_recall` 翻到**，只是排序让位给未退档的、新的；`solid` 列表里不再有它。`scarQuotes` 从疤的 `quote` 取，命中就不退档。
- `lib/persona.js`：`foldOlderBeliefs` 改成整句取舍——按顺序放，放不下就 `break`，不再截断句子；第一条再长也放。`personaBudget` 新增 `droppedSections: [{label, chars}]`，与 `dropped` 同步。
- `lib/selfdoc.js`：重写身份文档时若 `droppedSections` 非空，记一行「身份文档：预算 X/Y，挤掉 段名（N 字）…」；用 `lastBudgetDrop`（每 root 一个签名）避免同一内容每次重写都刷。预算仍是 1800（A19 再谈 3→2）。
- 测试：`test/derive.test.mjs`「固化满 90 天退档：还在 beliefs，但让新的排到前面」；`test/beliefs.test.mjs`「折叠行不截断句子：放不下就少放一条」；`test/scar.test.mjs`「疤不折：过了 90 天，没想通的事也不退档」；`test/mem.test.mjs` 两条（`droppedSections` 形状、`writeSelfDoc` 的预算日志只记一次）。
- 全量 1228 条 / 1217 过 / 9 红 / 2 skip（/tmp/full-A12.log）。9 红与已知环境红逐条同名。

**判断只摆两条（2026-11-07，已完 A19）**

- 问题：A12 的 90 天退档已经在把旧的判断往后排，但每轮仍逐条摆 3 条；核心段（永远保留的那几段）里判断占比偏高。设计里的下一步是「beliefs 3→2，预算数字不动，不够再谈 2100」。
- `lib/persona.js`：`BELIEF_SHOWN` 3 → 2，`shownCount()` 的非数字回落与注释同步；`BELIEF_FOLDED` 仍是 3。排序与折叠逻辑不变——少摆的那一条折进「更早以前」，不删原文。
- `lib/settings.js`：`DEFAULTS.memory.beliefsShown` 3 → 2；夹取仍是 1–8，设置页标签与「每轮对话认知记忆条数」不变。`lib/client.js` 的 `useState(3)` 与 `cfg.memory?.beliefsShown ?? 3` 都改成 2，避免界面显示和实际用数不一致。
- 预算没动：`SELF_DOC_BUDGET` 仍 1800，`memory.docBudget` 仍默认 1800、夹在 600–4000。
- 测试：`test/beliefs.test.mjs` 默认值断言全改 2，新增「A19：默认只摆 2 条，核心段确实变小；预算仍是 1800，句子不截断」（`personaBudget` 默认 used < shown:3 的 used，折叠段不含 `…`）；`test/mem.test.mjs` 的折叠用例改为 2 条在眼前、被折的从第 3 条起、`还有 7 条更早的`；`test/identity.test.mjs` / `test/p8.test.mjs` 里写死 3 的断言同步改。
- 全量 1229 条 / 1218 过 / 9 红 / 2 skip（/tmp/full-A19b.log）；这一轮 `withFileLock` 偶发红，单跑 `test/tenant.test.mjs` 15/15 绿。9 条已知红同名。
- 她那份 `~/.dsh-roost/config.json` 里 `beliefsShown` 原本显式存着 3；已改成 2（重启或下次保存后生效），想调回在成长页改。

**父项 25 条移植（2026-11-07，已完 A20）**

- 问题：0.1.0 的代码是从 river 0.1.68 分出来的，父项 0.8.6–0.9.1 修过的一批小毛病没有全带过来；设计文档 §八列了「直接取」25 条，需要逐条对代码，能写的写，不写的记理由。
- 逐条表在 `docs/父项移植表.md`：25 条里 14 条照取、1 条部分取（群消息加 speaker 前缀；`sanitizeForeign` 早就有）、8 条已改等价、2 条不取（新库没有换房问话；没有会把时间线挤掉的独立聊天行）。
- 照取的：拒绝词表加「不同意/不赞成/不认同/不支持/不选/反对/否掉/否决」并带 `(?!他|她|你)` 守卫（`lib/derive.js:55`）；判断后面带本地日期与来路（`lib/persona.js:139`）；`her_recall` 的 `brief` 档（`lib/recall.js:197`）；事件计数分 real/meta/noise（`lib/eventcount.js:16`，状态条显示真实经历数）；BOM 先剥（`lib/store.js:115`）；归档后认 `live[0]`（`lib/home.js:234`）；手打答案读 `custom`（`lib/ask.js:277`）；`her_say` 每日上限真拦、成长坐标改用 `deriveSelf`（`lib/proactive.js:261-267`）；回执改「记下了」；头像临时名加随机后缀（`lib/avatar.js:103`）；主动投递前先 `isBusy`（`lib/scheduler.js:195`）；元话语拦截（`lib/proactive.js:57`）；三处 UTC 日期改本地（`lib/home.js:37/741`、`lib/say.js:265`、`lib/recall.js:169`）。
- 已改等价：90 天退档（A12）、冷落 seen 只在开口那刻记、醒一醒用 turn/end watcher + 30 秒 fallback + 换房、换房锁、探活内联、排队叫醒、45 分钟最小间隔 + set/clear 时机、换房日期按本地日（A21）。
- 不取：换房问话（新库 `rotateTalkSession` 不弹问，`wakeIfBlank` 本来就在新会话建好之后）；聊天行折行/「说 N」（新库没有独立聊天行，时间线已合并）。
- 新增 `test/a20.test.mjs` 10 条；`test/proactive.test.mjs` 加上限/元话语/坐标与「记下了」断言；`test/ask.test.mjs` 加 `selected:[] + custom`；`test/client.test.mjs` 加真实经历计数。
- 全量 1241 条 / 1230 过 / 9 红 / 2 skip（/tmp/full-A20b.log）。9 红与已知环境红逐条同名。

**建屋方案落纸（2026-11-07，已完 A31）**

- 问题：首启 / 建屋只有 `D:\fish\建屋方案-草.md` 一份按 river 757 行 `home.js` 写的草稿，名字、标题、会话组合、`carry` 都是旧口径；仓库里没有能照着建屋的定稿。
- 定稿写在 `docs/建屋方案.md`，十三节：四件事与明确不做、启动九步的实际顺序、数据目录树（会话 cwd 是 `home/`，不是账本根）、工作区幂等、会话复用/归档/宽限/组合变了另建/两把锁/EPERM 重试、`home.json` 字段与 carry、seed、叫醒只叫一次、空状态、换数据目录、全部默认值、失败降级表、九条验收与现有测试对应、不变量。
- 核对时改准了三处口径：seed 只认「没有 seed 事件」不是「目录为空」；两个实例共用一个 root 时，后开的那个不建会话、只读 `home.json`，工具写入由 `guardWrite()` 挡（启动链路的 seed / 换家 meta 并不按 tenant 结果拦写，文档不写成「不写盘」）；数据目录里 `notes.json` / `inbox.md` / `diary/` / `out/` 在 root 下，`home/` 里只有她的身份文件。
- 文档不含真实用户名、路径、QQ / 群号；默认值表直接对应 `lib/settings.js` 的 `DEFAULTS`（`stageSpanDays` 30、`wakesPerDay` 2、`window` 08:00–23:00、`tools.preset` standard、`memory.beliefsShown` 2 等）。
- `docs/约定清单.md` 的 §0 与 A31 行已改成「已定稿」并写清验收。
- 全量 1241 条 / 1230 过 / 9 红 / 2 skip（/tmp/full-A31.log）；9 红与已知环境红逐条同名。

**库形态收口（2026-11-07，已完 A32）**

- 问题：包名、许可、`files` 与 README 还混着 river 时代的路径和口径；从 GitHub 安装走 npm pack 时 `packages/` 不在包里，抖音子包会缺；README 的「还没做完」还写着已被真机推翻的几项。
- 改动：`package.json` 的 `files` 加 `packages` 与 `NOTICE.md`，删掉重复的 `tools/setup-ffmpeg.mjs`（`tools` 整目录已在 `files` 里）；LICENSE 保留原作者行，加「Copyright (c) 2026 dsh-roost 作者（0.1.0 重建版）」；README 本机路径改占位、首启写自动建屋与叫醒、工具段去掉「记梦」、数据目录换成实际树、「还没做完」按 A1/A8/A13/A14/B 段重写；AGENTS 的 CI 说明改 Node 22/24（Windows 单独一轮）。`media/` 只剩两张原理图，README 不再引用截图。
- 交接.md 同步：删掉「还没上过真机」「11 条红」「手上这一步：真机」这些已被 A11 推翻的段落，改成 A32/A33、A8、A13/A14、A1、B 段的实际顺序；基线改 1241/1230/9。
- 无新测试；全量 1241 条 / 1230 过 / 9 红 / 2 skip，9 红与已知环境红逐条同名。

**保留模块接线核验（2026-11-07，已完 A33）**

- 问题：0.1.0 删掉很多功能后，留下的 `backup` / `move` / `report` / `whatseen` / `talkmem` / `avatar` / `intent` / `askinchat` / `bridge` / `biliqr` / `selfcheck` / `risk` / `hostver` / `health` / `faq` 有没有真接在页上，没有逐项核过。
- 做法：写 `docs/接线核验.md`，15 个文件 / 16 条入口逐条列「入口 + 代码位置 + 结论」。`whatseen` 占今天页与看视频历史两条，所以 16 行。
- 结果：都有真实入口，没有孤儿。`faq` 按 A14 不上面板（反馈页只留仓库链接与空状态），`lib/observe.js:53` 仍在 import、`/faq`（1542）与 `/faq.data`（1531）仍在注册，直链能看。
- 无新测试；全量仍是 1241 条 / 1230 过 / 9 红 / 2 skip。

**B 站看画面改分镜（2026-11-07，已完 A8）**

- 问题：看画面原来按整条时长均匀抽 9 帧，切点、构图和声音都看不见；想再看某一段只能整条重扫；设置里只有「每条取几帧」。
- `lib/frames.js`（新增）：格号 / 时间码 / 波形与零依赖 PNG 编码，B 站与抖音共用画法；`composeBoard` 至少两格，底部 16% 画音频波形。
- `lib/video.js`：先用 B 站元数据拿时长，抽 96px 小图做灰指纹（`signature` / `frameDiff`），`pickSceneTimes` 按变化大优先、`minGap` 兜底、不足等距补；`from/to` 只扫该段；`findMoment` 只读字幕按一句话找回时间码，不占额度；三档细节 `compact/normal/fine` 决定格子大小、采样密度与是否取波形；缺 ffmpeg 返回 `{ok:false,why}` 并写真实原因。
- `lib/watch.js`：参数加 `from` / `to` / `find`；成功文本写「按变化挑了 N 格，拼成 M 张故事板」与每张路径、秒数，并声明「这是一次采样，不是整条视频」；`watched` meta 带张数与细节档。
- 设置页四个控件：几张故事板（1–3）、每张几格、细节档、清晰度（16/64/80）；旧「每条取几帧」删掉。
- 测试 13 条：`test/frames.test.mjs` 4 条；`test/video.test.mjs` 加切点 / 字幕匹配 / 波形 / 三档 5 条；`test/watch.test.mjs` 加 find 与 from/to 2 条；settings / client 各 1 条。
- 真机冒烟：ffmpeg 造 3 秒 testsrc，注入假 view 调 `grabFrames(frames:6,boards:2)`，出 2 张 922×518、3+3 格，格号与时间码可读。
- 全量 1254 条 / 1243 过 / 9 红 / 2 skip（/tmp/full-A8.log）；9 红与已知环境红逐条同名。

**删除清单复核（2026-11-07，已完 A15）**

- 问题：设计 §二的 12 行删除清单（自更新、B 站私信、抖音渠道壳、评论、出门/请神、旧版本记录、旧素材、仓库垃圾、兼容分支、旁听、导入卡、桌面通知）只做过「文件删了」，没有逐条核路由、配置键、界面、测试、文档残留；实测还找出几处死代码与旧文案。
- 12 行结论：① 自更新 `update.js`/`selfupdate.js` 不存在；② B 站私信 `channels/bili.js` 不存在，B 站只剩公开接口与扫码登录；③ 抖音 `channels/douyin.js` 无 `send`/`onMessage`，只留 `start/stop/status/api()/feed()`；④ 评论 `comment.js` 不存在，`bili_look what=comments` 是只读看评论；⑤ 出门/请神七件套与其死代码已清；⑥ 根目录无 `RELEASE-NOTES-*`；⑦ `media/` 只剩两张原理图；⑧ 仓库垃圾（`PROBE`、截图脚本、`.tmp-plugins.json`）不在树里；⑨ 导入功能已删，只保留 `import-mark` 的只读兼容（不是入口）；⑩ 旁听 `hear.js` 与界面字样已清；⑪ 导入卡已删，`/import` 现在只导世界书；⑫ 桌面通知 `notify.js` 已删，调度注释改成「只写报告，不弹通知」。
- 删掉的死代码：`lib/observe.js` 的 `/status` 里未定义的 `awayNow/awayLine/tripDays` 块（被 try/catch 吞掉、`away` 恒 null）、`rejectNoteToHome` 与它引用的四个不存在函数、死 import `lettersSince`；`lib/settings.js` 的 `DEFAULTS.outing` 与归一化；`lib/store.js` 的 `outsideSessions()` 与 appendEvent 里按 sessionId 盖 `influence:'none'` 的整段；`lib/proactive.js` 的 `away/rested` 参数与两个死分支；`test/isolation.test.mjs` 5 条。
- 旧文案：`persona.js` 的定时提醒说明书不再写「出门/请神」，改成「到点时你正在歇着或手上正忙，就先记下」；`client.js` 删 `st.away.line` 与「这条对话现在由她来答」，分组「能不能出门」改「能不能上网」；`scheduler`/`restrict`/`schema`/`sessiontitle`/`herdiary` 的陈旧注释一并清。
- 说明表：`lib/readme.js` 的 `README_VERSION` 2→3，数据表换成实际文件（`qq-wal.jsonl`、`qq-outbox.jsonl`、`douyin-profile/`、`home.json`、`people.json`、`notes.json`、`journal.json` 等），不再列 `keepsakes/`、`outings.json`、`possessions.json`、`session-notes.json`。
- 兼容：`lib/derive.js` 的 `IMPORT_NAME_PREFIX`/`IMPORT_MARK_PREFIX` 与 `importedPersona` 读取仍保留，但导入功能没有任何入口；它只用来不误读旧事件流，不是可用的入口。
- 测试：新增 `test/leftovers.test.mjs` 2 条（已删模块/配置键/界面字样不在；`readme.js` 数据表是实际文件）；定向 derive/proactive/settings/paths/client/p1/log/principle/askinchat/outside-surface/leftovers/schedule 全绿。
- 全量 1251 条 / 1240 过 / 9 红 / 2 skip（/tmp/full-A15.log），9 红与已知环境红逐条同名。基线从 1254 降到 1251 = 删 `isolation` 5 条 + 新增 2 条。

**0.9.1 六条逐条核（2026-11-07，已完 A10）**

- 问题：0.1.0 从 river 0.1.68 分出来，父项 0.9.1 的六条修复没有逐条对过；A20 只在全量表里笼统说「已覆盖」，A10 要的是每条都有代码位置与测试，不靠「上游改过」当证据。
- ① EPERM 重试：`lib/home.js:42-64` 的 `createSessionWithRetry` 只在 win32 对 `EPERM/EACCES/EBUSY/ENOTEMPTY` 重试，间隔 0/120/400ms，每次留一行日志；别的平台真失败就是真失败。测试 `test/a20.test.mjs:91`（三次成功 + linux 不重试）。
- ② BOM：`lib/store.js:110-116` 的 `readJson` 只剥最前面一个 U+FEFF，正文里的不碰。测试 `test/a20.test.mjs:85`（`\uFEFF{"a":1}` 能读）。
- ③ 归档认最近：`lib/home.js:223-234` 取 `sessionIds` 头一条（宿主把新会话插在前面），不是末尾的最旧那条。测试 `test/a20.test.mjs:106`（`['ses-new','ses-old']` 认 `ses-new`）。
- ④ 群 @ 昵称按原文：`lib/channels/qq.js:515-518` 的 `personName = kind === 'group' ? card || nick : nick || card`，不做空格换下划线，也不改下划线；群名用 `group_name`，不用发言人的名片。新增 `test/qq-channel.test.mjs`「群名片按原文用，空格和下划线都不改写（A10，0.9.1）」（`阿 岚_测试` 原样保留）。
- ⑤ 只粘 cookie 不清 uid：`lib/owner.js:169-190` 的 `saveOwner` 只改传进来的字段，cookie 分支不碰 `mid`/`nickname`；新增 `test/owner.test.mjs`「只粘 cookie 保存时，不清空已填的 uid 与昵称（A10，0.9.1）」。
- ⑥ `her_say` 上限真拦：`lib/proactive.js:257-264` 数当天 `proactive-say:<日>:` 记账，达到 `maxPerDay` 就不写事件；测试 `test/proactive.test.mjs:188`（默认 2 次，第三次挡在写盘前，坐标用 `deriveSelf`）。
- 测试净增 2 条；定向 qq-channel/a20/owner/proactive 79+23 全绿；全量 **1253 条 / 1242 过 / 9 红 / 2 skip**（/tmp/full-A10.log），9 红与已知环境红逐条同名。
- 结论：六条都已在新库里按修好的行为落着，不需要改生产代码；补了两条原先没直接钉住的测试（群名片原文、只粘 cookie）。

**原理页与反馈页收尾（2026-11-07，已完 A13/A14）**

- A13：`lib/client.js` 的 `principlePage` 还在，两张原理图仍走 `/media/principle-loop.svg` 与 `/media/principle-memory.svg`（`lib/observe.js` 的 `/media` 白名单只放这两张），缩放 / 拖动 / `Esc` 由 `test/principle.test.mjs`、`test/principle-zoom.test.mjs` 守着。本轮验收是「页面还在，内容不更新」，所以没改理论卡；等代码定型后再按新库重写、给卡片标文件与行号。
- A14：反馈页只剩「去仓库说」（仓库链接）与「常见问题：还没有写」的空状态，没有 FAQ 面板；`/faq` 与 `/faq.data` 路由保留给旧链接。`test/faq.test.mjs` 断言没有按钮、没有 `jget('/faq.data')`、有仓库地址、有「还没有写」。
- 无代码改动；定向 `faq` + `principle` + `principle-zoom` + `stance` 全绿。全量仍是 1254 条 / 1243 过 / 9 红 / 2 skip。

**下一步顺序**

1. ~~A11 收尾~~：已 ✅。~~A21~~：已 ✅。~~A34 改名~~：已 ✅。~~A35 名字变量~~：已 ✅。
2. ~~A22~~：已 ✅。~~A23~~：已 ✅。~~A24~~：已 ✅。~~A25~~：已 ✅。~~A26~~：已 ✅。~~A27~~：已 ✅。~~A28~~：已 ✅。~~A29~~：已 ✅。~~A30~~：已 ✅。~~A17~~：已 ✅。~~A18~~：已 ✅。~~A12~~：已 ✅。~~A19~~：已 ✅。~~A20~~：已 ✅。~~A31~~：已 ✅。~~A32~~：已 ✅。~~A33~~：已 ✅。~~A8~~：已 ✅。~~A13~~：已 ✅。~~A14~~：已 ✅。~~A15~~：已 ✅。~~A10~~：已 ✅。
3. A1 真机拔网验收并入 A11 之后（代码与模拟已过）。
4. **A36「没答完的问题」（openq）**：设计已定、**未实现**，见 `docs/待办-没答完的问题.md`。起因是 2026-11-09 她说「我还回不了，等它长出来」——说完就散了，没有下一步。要做三件：`openq` 事件（只收她自己的 utterance、窄正则、一天最多 2 条）、叫醒时把最早一条未关的问题摊在处境里、`/today` 里只读可见。**准度口径与回放验收写在那份文档里，实现前先回放 11-02～11-09 的账本。**

**环境注意**

- node 不在 PATH：`D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。
- 测试必须 `--test-isolation=none`（否则沙箱里 spawn EPERM）。
- `dsh-ops` 现在装着并接管了 pwsh/read/glob/grep（换成 `ops_*`）；不想用就在插件里停用，别带着测。

## 参照

- `D:\fish\新项目-设计讨论.md`：所有已定决策（渠道、材料、设置页逐页、删除清单、父项同步）。
- `docs/建屋方案.md`：首次启动、建屋与账本迁移的定稿（A31）。
