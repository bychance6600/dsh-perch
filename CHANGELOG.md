# 更新日志

## 0.1.0（2026-11-06）

重建版。代码从 `dsh-fish-river` 0.1.68 复制过来，改名 `dsh-roost`，数据目录迁到 `~/.dsh-roost`。这是新线的第一版（2026-11-07 已上真机：A11 首检通过）。

### 重写

- **QQ 渠道**：按 `新项目-设计讨论.md` 的渠道节重写 `lib/channels/qq.js`、`gate.js`、`router.js`。只写 OneBot 11 标准子集；心跳 30s，重连退避 2/5/10/30/60s；群冷却 120s（被 @、回复她、管理员豁免）、每分钟 30 条、每群每天 20 条、夜间 23:00–08:00 与工作日峰时只接点名；同一会话 10 秒合批，flush 时按发送者切段；群里没点她的消息只进内存背景环（每群 20 条 × 300 字），不进账；回复按句切气泡、超过 3 条每两条停 900ms；`replyToSelf` 认得她自己的 message_id；附件只记一条元数据。
- **抖音改成材料层**：`lib/channels/douyin.js` 只留浏览器 transport、`api()` 与 `feed()`，没有 `send`/`onMessage`；`channels.douyin.enabled` 只表示「报纸能读」；`sub.js` 加 `loadSubModule()`；`host.js` 起材料时不建 people/journal/router。
- **设置页**：页签按她的一天重排为 11 个（今天 / 状态 / 成长 / 住所 / 社会 / 上网 / 渠道 / 插件 / 原理 / 数据 / 反馈），默认「今天」。今天页四段（现状、时间线、今天变了什么、手边）；成长页四阶段实时生成、上下文与记忆并页；住所页只留状态与会话健康（连续两次发送失败自动换会话，新增 `POST /home/rotate`）；上网页合并 B 站与抖音的每日次数、看画面加今日计数、请求节奏与历史折叠；插件页改成收窄开关 + 可搜索工具表；反馈页只留仓库链接。
- **世界书**：面板从渠道页移到成长页；内容仍由会话侧生成、主人导入，插件不写。

### 删除

- 渠道：B 站私信、抖音私信/群（`lib/channels/bili.js`、抖音子包里的私信整机与相关测试已一并删除）。
- 功能：出门/请神（`outing`/`possess`/`keepsake`/`pocket`/`sessionnote`/`keep`/`dream`）、导入别人养过的那一位（`import`）、桌面通知（`notify`）、自更新（`update`/`selfupdate`）、B 站评论区发言、领养人验证、反馈页的开发者 QQ 与交流群二维码。
- 界面：旧的「记忆」页、B 站评论卡、导入卡、领养人卡。

### 命名

- **名字归数据，不写进代码**：界面、侧栏、设置页、README 里不再写死任何名字——名字是这一只被养出来之后才有的。默认工作区标题「她的家」、会话标题「跟她说话」、设置页签「她」；别人的这一只叫什么，由他们自己的对话长出来。`test/naming.test.mjs` 守着。
- README 标题只写 `dsh-roost`，并注明「仓库里没有替她取名字」。
- **名字是变量，从对话里认**：不设名字输入框。`lib/hername.js` 从事件流里认「X 是你的名字」「给你起名叫 X」「以后你就叫 X」「我有名字了：X」这类句子（只认主人私聊 / 宿主会话，群友玩笑不算），取最后一次；工作区「X的家」、会话「跟X说话」、侧栏页签 `X`，认不出退回「她」。设置页状态页顶部写清这是从对话里认出来的、不是设置项，要改名就在对话里说一句。

### 清理

- 环境变量统一成 `DSH_ROOST_*`：`DSH_ROOST_HOMES`、`DSH_ROOST_LOCATION`、`DSH_ROOST_PROFILES`、`DSH_ROOST_FFMPEG`、`DSH_ROOST_CA_FILE`、`DSH_ROOST_HOME`、`DSH_ROOST_DEV`。旧名不再认。
- `install.ps1` 整份重写：roost 版能找 `~/.dsh/profiles/*`、找 node/pnpm、`pnpm add` 本包、把 `dsh-roost` 写进 `dsh.profile.bundles`（带时间戳备份），可选跑 `tools/setup-ffmpeg.mjs`；profile 里还挂着 `dsh-fish-river` 时会停下来要求确认。
- `tools/migrate-ledger.mjs` 不再默认猜旧数据目录：必须显式给 `ROOST_SRC`。
- `NOTICE.md` 头像路径、`tools/check-install.mjs` 的包名与提示、若干旧注释都已改到 roost；删掉被 git 跟踪的 `tmp-fix4.mjs`。
- 抖音子包里的私信整机（`create`/`parseDmFrame`/`splitText`/DOM 点击与打字/`onEvent`/`enableNetwork`）删除，只留 `createCdpTransport`/`browseFeed`；对应两条测试一并删除。

### 数据

- 账本从旧目录迁到 `~/.dsh-roost`（1475 条，派生结果一致）；事件流仍然只追加。

### 兼容

- `dsh >=0.2.0-rc.1 <0.3.0-0`，Node ≥ 22；`dependencies` / `peerDependencies` / `devDependencies` 仍为空。
- 测试基线：`node --test --test-isolation=none` → 1173 条 / 1159 过 / 11 条已知环境红 / 3 skip，见 `PROGRESS.md`。
