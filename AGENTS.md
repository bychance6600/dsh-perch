# 改这个仓库的硬约束

给要动这份代码的人（或 AI）看。**这个文件只讲「不能做什么」**，不是安装手册，也不是产品介绍——装法看 `README.md`，改了什么看 `CHANGELOG.md`。

> **2026-11-06：本文件已按 dsh-roost 0.1.0 重写。** 下面各节的规则都按重建后的现状写；旧版 `dsh-fish-river` 的条款里，凡提到渠道、出门、导入、通知、自更新、测试基线的，一律以这里为准：
>
> - 渠道只剩 **QQ（OneBot 11）+ DSH 会话**。B 站私信、抖音私信/群，连同 `lib/channels/bili.js`、`lib/channels/douyin.js` 里的私信整机都已删除。抖音只留推荐流/详情这类只读材料。
> - **出门/请神**（`outing.js`/`possess.js`/`keepsake.js`/`pocket.js`/`sessionnote.js`/`keep.js`/`dream.js`）已删除；只在设计文档里留了「以后要接回来的接口」。
> - **导入别人养过的那一位**（旧 0.5.3 例外）已删除。人格入口现在没有任何用户可填的地方。
> - **桌面通知**（`notify.js`）与 **自更新**（`update.js`/`selfupdate.js`）已删除。
> - 数据目录是 `~/.dsh-roost`；包名 `dsh-roost`；版本从 `0.1.0` 重新起。
> - 测试基线以 `node --test --test-isolation=none` 的实测为准（当前 1337 条 / 1326 过 / 9 条已知环境红，见 `PROGRESS.md`），不要再引用 1359。
> - 「三道门」统一叫「三道瓶颈」；「四道门」统一叫「四个阶段」。文案守门规则不变。

违背下面任何一条，即使测试全绿也算改坏了：这几条守的不是代码正确性，是**这个插件还是不是它自己**。

---

## 1. 零依赖是铁律

`package.json` 里 `dependencies` / `peerDependencies` / `devDependencies` **三个必须永远是 `{}`**。

- 原因不只是「省事」：DSH 插件多挂一个包，就可能把宿主正在用的旧核心包拖进依赖树，装完重启后宿主直接崩（本机踩过，见 `README.md` 里 tool.js 那段 `unsupported JSON schema` 的记录）。
- 需要 HTTP → 用内置 `fetch`。需要签名 → 用内置 `crypto`。需要解压 → 用内置 `zlib`。需要子进程 → 用内置 `child_process`。**这些全都有，没有必须装包才能干的事。**
- 测试只用 `node:test` + `node:assert`，不引测试框架。

## 2. 不许加人格设置界面

**没有**性格滑条、好感度数字、亲密度进度条、人设输入框、情绪标签。

- 设置页只放**环境参数**：几点醒、醒几次、一天几条事件、刷不刷 B 站、每天刷几次。这些是「生长环境」，不是她本人。
- **桌宠是身体，不是人格。** `pet.enabled` / `pet.path` / `pet.pack` / `pet.idleSleepMin` / `pet.pokeMinGapMs` 是环境参数；不许加模型、性格、嗓子、台词模板，也不许让身体替她开口或自动打招呼。说不说话由事件流和她自己的工具决定；睡不睡只看回合在不在跑、离上一次动静多久（`idleSleepMin` 默认 5、范围 1–60），不是作息设置。`pet.path` 空着就找 `<root>/pet/dsh-roost-pet.exe`，没有就报「还没装身体」；身体与角色包用 `tools/install-pet.mjs` 解压安装。动作表从角色包的 `pet.json` 现读（读不到回落内置 10 个），不是写死的；换包要重启才生效。睡着时点一下只晃，不算戳；醒着时可能记一条 `meta poke:` 并起一轮轻提示，但不算她听过、不进记忆。
- 人格只能**通过事件长出来**。任何让用户直接写「你是一个温柔的…」的入口，等于把产品变回角色扮演，直接违反本项目的立项前提。
- 判断标准很简单：如果加了之后用户能**直接指定**她是什么样的人，就是错的。
- 旧版那个「导入别人养过的那一位」的例外（0.5.3）**已经删掉**，不要再以任何形式接回来。

## 3. 四条黑名单是代码级硬禁，不是提示词

真相在 `lib/rules.js`（四层结构）与 `lib/persona.js`（`PRESCRIPTION_BANS`、`HARD_BANS`），不在文档里。

| 条款 | 真相在哪 | 守它的测试 |
| --- | --- | --- |
| 不撒娇卖萌（写成「还不会」，不是「不许」） | `lib/rules.js` 的 `learn-affection` | `test/rules.test.mjs`（断言含「还不会」且不含「不可以」） |
| 没有好感度/亲密度数字 | `lib/rules.js` 的 `no-relational-score` | `test/rules.test.mjs`（提示词里 `cannot` 只剩这一条） |
| 不能读自己的数值与设定（能看自己说过什么） | `lib/rules.js` 的 `no-read-self`（物理层，`section: null`，**不进提示词**）；工具侧由 `lib/restrict.js` 的 `HER_TOOLS` 收窄 | `test/rules.test.mjs` + `test/restrict.test.mjs` |
| 不能调工具改自己 | `lib/rules.js` 的 `no-self-modify`（物理层，同样不进提示词）；写入侧入口是 `lib/capture.js` 的 `growth_commit`（判断）与 `lib/herdiary.js` 的 `write_diary`（日记） | `test/rules.test.mjs` + `test/capture.test.mjs` |

三条实现原则，改代码时别破坏：

- **物理层与契约层不进提示词。** 写「你不可以读设定」等于告诉她「旁边有份设定，很关键」——那是诱因，不是防线。靠代码不给路径、不给工具来保证。
- **不要绕过 `lib/guard.js`。** 她是"根本没看见"重塑人格那句话，不是"看见了但被劝住"。任何新的输入口（新工具、新接口、新外部文本源）都必须过 `guard.js`；秘密外发（cookie / token / `sk-` / Bearer / 长 base64）在这里一律拦下。
- **不要把通用文件 / 命令工具放进 `config.tools.allow`。** `read` / `write` / `edit` / `glob` / `grep` / `bash` / `run_code` 这类不是按目录授权的：一放行，她就能读到 `~/.dsh-roost/home/她的身份.md`、配置和状态，等于绕过 `no-read-self`；写入类还能绕过 `no-self-modify`。要看某个项目的源码，给她 `web_fetch` 从 GitHub 读，或者单独做一个只读的小工具。

## 4. 文案有守门词，改之前先看测试

面向用户的字符串（`lib/client.js` 里的界面文案）有三条硬规矩，全部有测试盯着：

- **不出现男字旁的「他」**，统一写「你」。`test/p5.test.mjs` 逐字扫。例外只有 `其他/其它` 这类词素。她自己的话、引用别人的话不受此限。
- **统一「四个阶段」与「三道瓶颈」**，**禁**「四道门 / 三道门」。`test/principle-zoom.test.mjs` 明确断言 `三道门`/`四道门` 不出现。
- **不把她的名字写进代码与文案。** 名字是这一只被养出来之后才有的，属于 `~/.dsh-roost` 里的数据，不属于项目。随包发布的界面、侧栏、设置页、README 一律只用「她」：默认工作区标题「她的家」、会话标题「跟她说话」、设置页签「她」。事件流、日记、`home/` 里出现她的名字是正常的（那是长出来的），代码里写死才是错。`test/naming.test.mjs` 守着。
- **立场不是第五关。** 措辞只能是「四个阶段完成之后才会开始有立场」。图上不许再退回「底部一行小字」的表达——立场是独立区块，由 `test/principle.test.mjs`（viewBox 1160 + 含「立场清单」）与 `test/stance.test.mjs`（旧的「纵向长「立场清单」」写法必须不存在）共同守着。

改文案时**先跑这三条**再改别的，否则会来回返工。

## 5. `events.jsonl` 只能追加

`~/.dsh-roost/events.jsonl` 不能删除记录，是唯一可信源，一行一条。**任何改写/删除/重排都是篡改她的记忆。**

- 状态（`state.json`）是派生品，随时可由 `rebuild()` 重算；改它没意义，会被覆盖。
- 「让她忘」不是删行，是**降低召回**（`lib/persona.js` 的 `foldOlderBeliefs`：更早的判断折成一行「记不清原话了」，疤那类永不折叠），事件原文始终还在 `events.jsonl` 里，她也能用 `her_recall` 翻回去。
- 重置与恢复都不删数据：`reset.js` 改名前缀封存，`backup.js` 恢复前把旧档搬去 `dsh-roost-backups/pre-restore-*`。
- 新增事件类型**不必**改 `lib/schema.js` 的 `EVENT_SCHEMA_VERSION`：旧读者读不认识的 `type` 会跳过（`readEvents` 对未知类型宽容），`ask`、`answer`、`heard` 都是这样加进去的。但**改字段语义、把可选字段变必填、删字段**必须升 `v` 并写迁移（旧版本遇到新 `v` 要拒，否则静默丢字段）。

## 6. 改完必须跑全套测试

```bash
node --test
```

当前基线 **1337 个**（2 条 skip），其中 **9 条已知环境红**见 `PROGRESS.md`。**不许新增红**——那 9 条是跨文件隔离造成的（`withFileLock` 偶发），谁修好都欢迎，但别把「我没碰它」当理由放着。

按环境挑跑法：

- **正常环境**：上面这条命令（不带参数，Node 自己递归找 `test/*.test.mjs`），约 17–18 秒。
- **别写成 `node --test "test/*.test.mjs"`**：更老的 Node 20 不展开 glob，会直接报 `Could not find '.../test/*.test.mjs'`；引号里的通配符从 Node 22 起才认。CI 就是被这条拖红的。
- **也别写成 `node --test test/`**（目录形式）：Node 26 + Windows 下报 `MODULE_NOT_FOUND`，沙箱里还会 `spawn EPERM`。
- **沙箱 / 受限环境**：用 `node --test --test-isolation=none`，或逐文件跑（全量约 105 秒）。
- **`--test-isolation=none` 有跨文件假红**：ULID、cover、growth_commit、坏 JSON、seen、withWake、ops_*、turn/end、wake 那几条会因共享进程互相干扰而报错，单跑对应文件是绿的。判断是不是假红：逐文件独立进程跑一遍，全绿即假红。
- **`test/media.test.mjs` 的 `detectFfmpeg` 依赖 spawn**，在禁 spawn 的环境里会红（`spawnSync ... EPERM`）。这是环境限制，不是代码问题——但**不许**为了让它变绿而删掉那条断言。

CI 也跑同一套（`.github/workflows/test.yml`，Node 22 / 24 各跑一遍，Windows 再单独一轮）。

## 7. QQ 只接 OneBot，不内置 QQ 协议

社区想把她接到 QQ 上。**不要把 QQ 协议、登录、扫码塞进这个插件**——桥（如 SnowLuma，备选 NapCat）是独立进程，负责登录并暴露 OneBot v11 WebSocket；本插件只做 OneBot 客户端：连 WS、发 `send_*`、收 `message`。

- 适配器只写 **OneBot 11 标准子集**（`message`/`notice` 事件、`send_group_msg`/`send_private_msg` 等标准动作）。不要用任何桥的扩展动作；换桥还能跑。
- 桥地址 / 令牌 / 启动桥 / 测一下，都在设置页「渠道」页的 QQ 卡里填。插件允许按用户填的路径 `spawn` 起桥（`detached` + `unref`），但不解析协议、不做登录。
- `config.tools.allow`（设置页「插件」页的工具表）放行的是**宿主工具名**，包括桥暴露的 `qq_send_message, qq_get_unread_messages, qq_reply`。名字对不上，她就会答「我没法在 QQ 上说话」——这不是插件坏了，是名字没对上。
- 放行之后要念给她听：身份文档「我手上有什么」由 `lib/persona.js` 的 `toolBrief(extra)` 生成、`lib/selfdoc.js` 把 `config.tools.allow` 作为 `extraTools` 传进去。看不见一只手，她就不会用。
- 白名单只做加法。`config.tools.allow` 与 `HER_TOOLS` 取并集，不要用它去减工具；收窄只走 `lib/restrict.js` 那一套。
- **白名单不是万能口：不要放行通用文件 / 命令工具**（`read` / `write` / `edit` / `glob` / `grep` / `bash` / `run_code` 这类）。它们不是按目录授权的，一放行就能读到她的身份文档、配置和状态，正好绕过「不能读自己的数值与设定」；写入类还能绕过「不能调工具改自己」。要看某个项目的源码，给她 `web_fetch` 从 GitHub 读，或单独做一个只读小工具。理由与数据目录的界线见 §3。

**其余平台同理**：Chatbox、Monica、AstrBot 这些客户端/框架也走「社区桥 + 白名单」这条路——不要把它们的协议塞进本插件，先找能桥过去的项目，再把工具名填进 `config.tools.allow`。

## 8. 两条成长通道不许合并

事件的 `influence` 字段决定这条经历算「她是谁」还是「她怎么处世」，**写入时定格，永不重算**。

- `constitution`（默认，没写就是它）：进 `beliefs`，能改阶段、能改称呼、能和她自己打架。
- `social`：只在 `meta social-open:` 之后才被读，进 `model.influence.social`，**不进** `beliefs`，不改阶段、不改称呼、不参与冲突检测。
- `none`：流水层，完全不参与派生。

守它的测试是 `test/channels.test.mjs`，其中两条是性质断言，不是行为断言：

- 「未开闸时喂 1000 条 social 事件，`deriveSelf` 的输出逐字节不变」；
- 「开闸后 social 事件也不出现在 `beliefs` 里」。

**不许**把 `social` 并进 `beliefs` 再用权重排序——那等于让群友最终仍能改写她，只是慢一点。物理分开是这条产品的底线。

另外：这五个字段只收系统侧（`source !== 'tool'`）。她如果能自己打 `influence:'constitution'`，就等于给自己批了通行证——和 `flags` 同一个道理。

## 9. 渠道层只负责「把话送到」，不负责「她是谁」

`lib/channels/*` 是**桥**，不是第二个大脑。它决定一条消息能不能送到、要不要回；它**不许**决定她怎么说、更不许给她打分。

硬边界：

- **渠道配置里不许出现人格键**。`config.channels.<name>` 只允许 `enabled / wsUrl / accessToken / bridgePath / replyInGroup / groups / mentionOnly / ownerId / browserPath / homeUrl / intervalMs` 这些「在哪、开不开、多久一次」。加一个 `persona` 或 `tone` 键就是绕开第 2 节。
- **进站必过 `guard.sanitizeForeign`，出站必过 `screenOutgoing` + `looksLikePrivateLeak`**。适配器自己不做判断：`send()` 只负责发，判断在上层 `router.js`。
- **可见性按会话判**：群聊 `visibility:'public'`，私聊 `visibility:'private'`。私聊事件只对该 `person` 可见，连主人都看不到原文——这是「不看别人私聊」的代码化。
- **`heard` 只能由 system 写**（不在 `HER_TYPES` 里），`origin:'guest'`、`influence:'social'`；只有主人私聊来的话才配 `origin:'owner'`、`influence:'constitution'`。
- **群里默认只在她被 @ 时开口**。`mentionOnly`（默认 `true`）关着的时候不看她有没有被点名；开着的时候群消息必须带 `mentionedSelf: true` 或 `replyToSelf: true` 才轮到后面几道判断。适配器负责认 @（OneBot 的 `at` 段 / CQ 码）与「回复她」；gate 负责用它，router 只透传。
- **群白名单挡的是「长」，不只是「说」**：名单外（`group-not-allowed`）的群只留一行 `journal.json` 流水，**不写 `heard`**——没听见的事不能长到她身上，也不能出现在「她认得谁」里。这条与界面文案「名单外的群她连听都不听」是同一句话，改一边就得改另一边。
- **没被点名的群消息只进内存背景环**：每群最近 20 条、每条 300 字，只在下次被叫醒时作为「群里刚才还有人说话」塞进提示词，不落盘、重启即空。不要把它写进 `heard` 或 `people`。
- **合批 10 秒**：同群/同私聊的连续消息按窗口合并；flush 时按发送者切连续段，一段一条，别把它们混成一个人说的。
- **渠道全关时不建文件、不连网**：`startChannels` 必须在 `createPeople`/`createJournal` 之前短路。这条有测试（`test/channels*.test.mjs`），别为了「统一初始化」把它挪走。
- **适配器永不抛**：`start/stop/send/status` 一律 `{ ok, why }`；凭据不进 `status()`、不进日志。
- **抖音不是渠道，是材料层**。`lib/channels/douyin.js` 只有 `start/stop/status/api()/feed()`，没有 `send`/`onMessage`；`channels.douyin.enabled` 的意思是「报纸能读」，不是「私信开着」。router 遇到没有 `send()` 的适配器回 `read-only-channel`。
- **协议不进主包**：主包只有 QQ 的 OneBot 客户端与各渠道的薄壳；抖音这种要真浏览器的，实现放在 `packages/dsh-roost-douyin/`，由 `lib/channels/sub.js` 的 `loadSubModule()` 懒加载（先找已安装的 `dsh-roost-douyin`，找不到就用仓库里那份；代码分开，随仓库一起分发）。可选性由「开不开」+「懒加载」体现：不开就不 `import`、不拉浏览器、不建 `douyin-profile`。
- **登录态是主人的，也是她自己的**：B 站扫码拿到的 cookie 只写 `owner.json`（0600），不进日志、不进 `status()`、不回显；二维码只活在内存里。抖音用 `<root>/douyin-profile` 这一个浏览器目录，扫码一次就留着。
- **代发是主人的话，不是她的话**：`POST /channels/send` 只做三件事——发出去、写一行 `role:'owner'` 的流水、返回结果。不问她、不过 gate、不过出站筛、不写事件流。

## 10. 社会层开闸只能她自己按

- **能不能开**：`lib/socialgate.js` 的四条闸（阶段 ≥3、立场 ≥6、30 天没整条推翻、活 ≥14 天且稳定度在 0.02–0.35）。**只从事件流算，不落盘、不可配置。**
- **开不开**：`social_open` 工具（`lib/social.js`），她调用才写 `social-open:<ISO>` 的 meta。**没有任何 HTTP 路由或配置项能替她开**——加了就等于给了主人一次「让她变成另一种人」的权力。
- **差着的时候**：身份文档一个字都不写（`lib/selfdoc.js` 的 `socialSection` 返回空串）；调用工具也只回一句「还差什么」，绝不写事件。
- **开过之后**：`lib/derive.js` 才把 `influence:'social'` 的事件放进 `influence.social`（上限 30%），且永远不进 `beliefs`。
- **开过之后必须真的读到**：身份文档「我在外面学到的」（`lib/selfdoc.js` 的 `socialLines`）与渠道提示词「在外面见过的做法」（`lib/channels/router.js` 的 `buildPrompt`）各一处。只派生不注入，等于没开。

## 11. 世界书是知识，不是人格

`worldbook.json` 里的是**事实**——她住哪、公司在几楼、你们养过什么猫。它可以导入、可以删，但**永远不许**变成「她是什么样的人」。

- **只进提示词的「你知道的事」一节**（`lib/worldbook.js` 的 `knowledgeBlock`），按关键词取，一次最多 5 条、共 1200 字。两处都写成事实清单：渠道回复的「你知道的事」与身份文档的「我知道的事」（≤24 条、每条 ≤200 字）。
- **不改阶段、不进 `beliefs`、不算事件**：查一条设定不是一段经历。
- **作息归设置管**：世界书里的「作息 / 几点睡 / 一天醒几次」不当知识读，由 `lib/worldbook.js` 的 `isSettingOwned()` 挡掉；身份文档的「醒来的时候」按 `config.window` 与 `Math.min(daily.events, wakesPerDay)` 现算（`lib/selfdoc.js` 的 `wakeScheduleLine()`），停用条目不念。2026-11-07 真机上，11-03 一次性导入的旧作息压过了设置，她背成「晚八点到十一点、一天两次」；这类静态知识不能盖住用户后来改的设置。
- **匹配靠关键词，不靠模型**：她为什么记得这条，要能一句话解释。
- **面板里没有编辑框**：能导入、能清空；「她语气温柔」这种句子没有入口。设置页上它在「成长」页（原来单开一页「记忆」，2026-11-06 并页后收在这里）。
- **内容不归插件生成**：世界书内容由会话侧生成、主人导入；插件只负责存与取。

## 12. 设置页的页签是「她的一天」，不是「配置分类」

- 十一个页签，按她的一天排：**今天（默认）/ 状态 / 成长 / 住所 / 社会 / 上网 / 渠道 / 插件 / 原理 / 数据 / 反馈**。
- **「社会」页只读**：四道闸、学到的处世办法都可以看，但**没有**「替我开」的按钮——开闸的唯一入口是 `social_open` 工具（§10）。页面上出现任何写 `social-open:` 的路径都算违规。
- **「记忆」不再单独一页**：上下文与记忆条数并进「成长」，记忆体检并进「数据」。
- **同一件事只留一个入口**：B 站登录只在上网页顶部（扫码为主，贴 cookie 收进 `<details>`）；渠道页只剩 QQ。
- **设置项必须能显式保存**：`commitInput` 有「保存」按钮、回车也提交——只有 `onBlur` 时，填完直接重启就会丢。
- **今天页永远只读**：不放假数据、不放按钮。它只回答「她今天做了什么、变了什么、手边有什么」。

## 13. 出门/请神已经删除，不要再接回来

旧的 `outing.js`/`possess.js`/`keepsake.js`/`pocket.js`/`sessionnote.js`/`keep.js`/`dream.js` 已从仓库删除，界面、路由、事件类型一并清掉。

- 设计文档里只留了「以后可能接回来的接口」，**没有实现**。要接回来，先改设计文档，再按「隔离带」重做：写入时盖章 `influence:'none'`（`appendEvent` 里按 `outings.json`/`possessions.json` 的 sessionId 认）、读取时 `deriveSelf` 与 `evaluateSocialGate` 过滤掉。
- **不许**用「按时间窗过滤」或「按她当时在不在外面过滤」替代按会话 id 认。
- 现在没有这层隔离带，所以**不要**顺手把出门写事件的路子重新接上。

## 14. 「自己看」和「社会层」是两条线

人格最早只该从**她自己看见的东西**和**她和主人的对话**里长出来；陌生人要等她开闸之后才算数。

- **自己看**：B 站刷站（`browse.*`）、抖音推荐页（`browse.douyin.*`）、DSH 会话、主人私聊。这些是 `constitution` 或环境素材，什么时候都在。
- **社会层**：群聊、评论区里的别人（`voice` 事件）、陌生人私信。开闸前**不参与派生**，开闸后也只进 `influence.social`，永不进 `beliefs`（§8）。
- **刷抖音与刷 B 站同地位**：两个配额合并成一个每日上限（0–6，界面上一个控件），互不挤占；`lookBeforeWake` 必须把两路结果合起来交给同一次唤醒，不许只留一路。
- **素材不是记忆**：`dy-browse:` / `video` 这类只写「此刻推到你面前的」，她的感想才走 `utterance`。
- 子包 `dsh-roost-douyin` 没装时，刷抖音静默跳过（`loadSubModule()` 返回 `null`），不许报错、不许建目录。

## 15. ffmpeg 是运行时资产，不是依赖，也不进 git

「看画面」要抽帧，抽帧要 ffmpeg。规矩：

- **查找顺序固定**：`DSH_ROOST_FFMPEG`（显式指定时只认这一条，不回落）→ 自带的 `bin/<平台>-<架构>/ffmpeg.exe`（`bundledFfmpegPath()`）→ PATH。三条都试完才算「没有 ffmpeg」。
- **二进制不进 git**：`ffmpeg.exe` 正好 100 MB，卡在 GitHub 单文件上限上；`bin/` 在 `.gitignore` 里，但进 npm 包（`files` 含 `bin`）。谁 clone 下来谁跑 `node tools/setup-ffmpeg.mjs`。
- **不许为了让它跑起来引第三方解压库**：`tools/setup-ffmpeg.mjs` 用系统自带的 `Expand-Archive` / `unzip`。
- 缺 ffmpeg 时**必须降级而不是失败**：日志写一行 `看画面：抽帧失败 <bvid> …`，其余照常。测试要能造出「没有 ffmpeg」（同时清 `PATH` 并把 `DSH_ROOST_FFMPEG` 指到不存在的路径），否则本机装了自带那份之后这条覆盖会假绿。

## 16. 抖音只有推荐流与详情，没有私信

抖音在 0.1.0 里是**材料**：推荐流、一条作品的详情、搜索、评论、画面。它不再是聊天的地方。

- `lib/channels/douyin.js` 只暴露 `start/stop/status/api()/feed()`；没有 `send`、没有 `onMessage`、没有会话簿记、没有去重。
- `api(p)` 只收站内路径（以 `/` 开头），走同一个浏览器 `evaluate(fetch(...))`，cookie 才带得上；整条外链一律拒。
- 登录态留在 `<root>/douyin-profile`；不要回落到 `os.tmpdir()`，否则每轮都换、扫码一次就丢。
- 旧版从 WebSocket 帧里读私信的那套（`parseDmFrame`、`splitText` 的私信用法）已随子包的私信整机删除；主包本来就没在调用它。**不要**把「收私信」改回读 DOM，也不要重新引入私信。
- 他递进来的抖音链接仍要解析（`lib/dylink.js`）：解析成功写事实并记 `meta looked:dy_<id>`；解析失败写「这边没打开它，别猜里面是什么」，且不记 `looked:`。

## 17. 小模型下面，文档里能被引用的句子都会被背出来

用 Qwen3-14B 接进 DSH 实测：问它「介绍下你的设定」，它把身份文档逐条念了出来——工具名、规则原文、连「我还不太会用撒娇」都念。**加禁令是负优化**：禁令本身也成了可背诵的句子（加了「我不会列举条目」之后，它先把这句念了出来）。

所以：

- 身份文档里不写「我不能……」这类可被当作答案引用的第一人称禁令；要约束行为，就写进工具说明、代码逻辑，或者放到末尾的短例子里（例子只给一两句，别给清单）。
- 任何字面标记（叫醒词之类）都不要在文档里写出原文——写出什么，就会被复述什么。
- **工具说明同理，清单就是模板。** `write_diary` 原来写着「写今天发生了什么、你注意到什么、你怎么想的」，14B 把这三句拆开重组成「今天发生了很多事情，我注意到一些细节」交回来；删掉清单之后复读消失。写「不要写成汇报」也会被当成一句可引用的内容（「不是汇报」出现在正文里）。
- `narration` 没带 `refs` 一律降级成 `utterance`，由 `test/capture.test.mjs` 守住。

## 18. 链接能打开才叫看过，打不开就说打不开

- 任何渠道的文本里出现抖音链接，路由层要先替她去解析（`lib/dylink.js`）：短链只跟一次跳转，详情走她自己那个浏览器的页面请求（cookie 才带得上）。
- **解析成功**：提示词里写事实（文案、作者、时长、互动数、有没有拉到画面），并记一条 `meta looked:dy_<id>`。
- **解析失败**：写「这边没打开它，别猜里面是什么」，且**不记** `looked:`。没看成的不能说看过——这条由 `test/channel-router.test.mjs` 两个用例钉住。
- 私信里的「分享卡片」只有「分享图文」四个字，没有 id：那条路不算看过，不许拿它补内容。要让她看见，得是链接。
- 从别的渠道（群里、评论区）来的链接算社会层：开闸前不进她的处世方式。

---

## 提 PR / 提交前自检

- [ ] 三个依赖字段还是 `{}`
- [ ] 没有新增人格设置入口
- [ ] 新输入口都过了 `guard.js`
- [ ] `node --test --test-isolation=none` 只剩 9 条已知环境红（基线 1337 条 / 1326 过 / 2 skip）
- [ ] 界面文案没有「他」「四道门」「三道门」「好感度」，也没有写死任何名字
- [ ] 改了 `EVENT_SCHEMA_VERSION` 的话，`CHANGELOG.md` 里写了迁移说明
