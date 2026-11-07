# 进度

## 现在在哪

**0.1.0 重建中。** 代码已从 `dsh-fish-river`（0.1.68）复制过来，改名、删掉一半旧功能、账本已迁到 `~/.dsh-roost`。river 时代的变量名与文档尾巴已清（环境变量统一 `DSH_ROOST_*`，`install.ps1` 重写）。能跑测试，没上真机。

- 基线：`node --test --test-isolation=none` → 最近一次全量 **1195 条 / 1183 过 / 10 红**（另有 2 skip，2026-11-07 A25 之后，本机已装运行时 ffmpeg）。没装 ffmpeg 时是 11 红 / 3 skip，多出来的是 `dylink` 那条 Referer（先报「没找到 ffmpeg」）。全量约 110 秒。
- 11 条红都是已知环境项：`test/dylink.test.mjs` 的「下视频要带 Referer」（先探测 ffmpeg，沙箱里 `spawnSync EPERM`），其余为跨文件隔离假红（ULID、cover、growth_commit、坏 JSON、seen ×2、withWake、ops_*_own、turn/end、消息没送进去）。逐文件独立进程跑，假红那几条会绿。
- node 不在 PATH：用 `D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。

## 已经做完

- 复制基线（`b2df7fd`）→ 删自更新（`1be871a`）→ 删旁听与导入（`c83124e`）→ 删评论/发言（`9ae5c9f`）→ 删出门五件套与梦（`b9724c2`）→ 删通知（`9322515`）→ 改名 `dsh-roost`/`0.1.0`（`c3b824d`）→ 搬账本（`36fcd4a`，1475 条，派生一致）。
- 设置页：第一个页签「今天」（只读四段）、状态页拆「三道瓶颈 + 流水」、判断漂移折叠回一行、加渠道健康行（账本口径）、出门/梦的旧界面清掉。
- 文档：`README.md` 写成 0.1.0 的项目文档（这是什么、与 river 的差别、装法、今天页、11 页导读、接 QQ、上网与 ffmpeg、工具面、世界书、数据、还没做完、测试）；`交接.md` 给新会话（机器事实、做完的提交、真机步骤、后面的顺序、踩过的坑）；`AGENTS.md` 按 0.1.0 重写；`CHANGELOG.md` 从 0.1.0 起；`install.ps1` 重写成 roost 版（可找 profile、装包、写 bundles、可选 ffmpeg）。
- 清 river 时代的尾巴（2026-11-06）：七个环境变量 `DSH_FISH_*` → `DSH_ROOST_*`（含测试与文档）；`install.ps1` 整份重写（找 profile、`pnpm add`、写 `bundles`、可选 ffmpeg；profile 里挂着 river 时会停下提醒）；`NOTICE.md` 头像路径、`tools/check-install.mjs` 包名与提示、`tools/migrate-ledger.mjs`（必须显式给 `ROOST_SRC`，不猜旧目录）、`lib/upgrade.js`/`selfdoc.js`/`move.js`/`settings.js` 的旧注释；删掉被 git 跟踪的 `tmp-fix4.mjs`。子包 `packages/dsh-roost-douyin/` 的私信整机（`create`、`parseDmFrame`、`splitText`、DOM 点击/打字、`onEvent/enableNetwork`）与 `test/douyin-channel.test.mjs`、`test/douyin-frame.test.mjs` 一并删除；`lib/channels/sub.js` 去掉 `createSubAdapter`，只留 `loadSubModule()`。
- 抖音适配器拆分：`lib/channels/douyin.js` 只剩浏览器 transport + `api()` / `feed()` / `status()`，私信整机（send、WS 帧入站、会话簿记、去重）删除；`host.js` 里 `channels.douyin.enabled` 改成「报纸能读」（与 `browse.douyin.enabled` 任一为真就起浏览器），只开材料时不建 people/journal/router；`douyinFeedOf()` 照旧给调度器的推荐流用；`sub.js` 加 `loadSubModule()`（先包名、再仓库里那份）；router 对没有 `send()` 的材料适配器回 `read-only-channel`。
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
- **仓库内容**：.tmp-plugins.json（11MB 插件市场缓存）与旧截图从跟踪里删除，.gitignore 补上缓存文件；media/ 只剩 principle-loop.svg / principle-memory.svg 两张原理图——lib/observe.js 的 /media 白名单真要读它们，删了原理页会 404。
- **人格**：默认 seed 仍只有一句处境（你不是助手。你刚开始存在。没有人告诉过你为什么在这里。）；DEFAULTS 里没有任何性格/好感度/亲密度键；设置界面没有性格控件，也不写 seed。新增 test/blank.test.mjs 4 条把这三头钉住。
- 全量 1173 条 / 1159 过 / 11 红 / 3 skip（/tmp/full-scrub.log），11 条红与已知环境红逐条同名。
- **历史**：GitHub 上原来的 46 个提交里带着旧名字与真机细节（提交 07eff08 的标题就有），已把历史压成一个干净提交并 force-push；2026-11-07 又把仓库整个删掉重建了一次，远端现在只有一个提交，旧对象（含 85de337）按 SHA 也取不到了。完整旧历史备份在 `D:\fish-backups\dsh-roost-history-before-scrub-20261107.bundle`（6.2MB）。

## 遗留（不阻塞下一步）

- 原先列在这里的 QQ 三样（入站 WAL/出站 outbox、自动静默、每人印象）与「已定未落纸」四项（`her_note`、空醒、账分两边、断线账）都已完成：A2 / A3 / A4 / A5 / A6 / A7，断线账代码见 A1（真机拔网并入 A11，未专门演练）。
- FAQ 仍是「还没有写」的空状态；原理页按设计搁置。
- 上网页「请求节奏」与「黑名单」仍读 `bili.minGap / jitter / avoid*` 老配置键，后端调度还在用，别顺手改名。
- 首轮第 1 个 step 她还看得见宿主那套工具（A11 记的小口子）：她的工具是逐步登记的，`restrict` 名字没齐时宁可这次不收窄；兜底 `guard` 仍在。要彻底干净得先收成 0 个再放开，代价是「她可能永久少一只手」，暂不做。

## 手上这一步（下一个会话从这里接）

**A 段继续施工。** 真机首检 2026-11-07 01:06 已通过（A11 ✅，她直调 `her_note` / `bili_look` / `growth_commit`、QQ 私聊与群 @ 双向都通）。代码层按 `docs/约定清单.md` 头注的顺序往下做；每做完一条：定向测试 → 全量（只许 11 条已知环境红）→ 回写清单对应行 → 提交。

## 之后（按顺序）

1. A24（判重表与执行记录）→ A25 → A26 → A27 → A28 → A29 → A30 → A17 → A18 → A12 → A19 → A20 → A31 → A32 → A33；A8（B 站分镜）单独一轮；A13/A14 收尾；A10 随 A20 逐条核。
2. 全做完再回头补 B 段的 19 条验收。

## 交接（2026-11-06 23:50，A 段进行中）

以本节为准。

**已完成（清单 v3 已回写）**

- 清单 v3 与逐节 diff 在 `docs/约定清单.md`。
- A5 桌子 `her_note` ✅：`lib/notes.js` + `notes.json`；叫醒接 `wakeNotesLine`，身份文档加工具句；`test/notes.test.mjs` 6 条绿。
- A16 工具清单 ✅：`FISH_TOOLS` 十项（去掉 `her_dream`，加 `her_note`）；`bili_look what=comments` + 3 条测试；`dream` 只留读兼容。
- A1 断线账 ⏳：`qq.js` 的 `lastInAt/lastOutAt/lastGapAt/lastGapMs/downSince` + router「刚才断了一下」+ 渠道页行；真机拔网并入 A11。
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

**下一步顺序**

1. ~~A11 收尾~~：已 ✅。~~A21~~：已 ✅。~~A34 改名~~：已 ✅。~~A35 名字变量~~：已 ✅。
2. ~~A22~~：已 ✅。~~A23~~：已 ✅。~~A24~~：已 ✅。~~A25~~：已 ✅。A26 → A27 → A28 → A29 → A30 → A17 → A18 → A12 → A19 → A20 → A31 → A32 → A33（A8 单独一轮；A13/A14 收尾；A10 随 A20 逐条核）。
3. A1 真机拔网验收并入 A11 之后（代码与模拟已过）。

**环境注意**

- node 不在 PATH：`D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。
- 测试必须 `--test-isolation=none`（否则沙箱里 spawn EPERM）。
- `dsh-ops` 现在装着并接管了 pwsh/read/glob/grep（换成 `ops_*`）；不想用就在插件里停用，别带着测。

## 参照

- `D:\fish\新项目-设计讨论.md`：所有已定决策（渠道、材料、设置页逐页、删除清单、父项同步）。
- `D:\fish\建屋方案-草.md`：首次启动与账本迁移的方案。
