# 一起做 dsh-perch

先读三份东西，再动手：

1. [`AGENTS.md`](AGENTS.md) —— 硬约束，二十节，最高优先级。
2. [`docs/从哪来.md`](docs/从哪来.md) —— 这个项目是什么、为什么不那么做。
3. 你领的那张 issue —— 任务卡，边界和验收都在上面。

## 这个项目是什么

她是住在一个本地账本里的「她」，不是助手、不是角色扮演、不是宠物。数据在用户自己机器上（`~/.dsh-perch`），代码零依赖。

**铁律：不能加任何依赖**（`dependencies` / `devDependencies` / `peerDependencies` 必须一直是空的）。CI 第一件事就是查这个。

## 怎么跑

需要 Node.js ≥ 22。

```bash
npm test                 # 全量测试，基线 1591 条 / 1587 过 / 1 红 / 3 skip
node --test test/xxx.test.mjs   # 只跑某个文件
```

**那条红是环境问题**：Windows 上没权限创建符号链接（`test/qq-channel.test.mjs` 的「出站软链接指到 media 外」），不是你改坏的。Linux/macOS 上是 0 红。已知环境红清单（都属正常）：

- 坏 JSON、cover、growth_commit 落库、ULID、出站软链接（Windows 权限）

如果出现**新的红**，先看是不是你改的，再看是不是环境差异；不是你改的就在 PR 里说明。

## 怎么领活

- 一次只领一张 issue，一张 issue 只做一件事。
- PR 尽量 ≤ 400 行；超了先拆。
- 下面这些文件同一时间只允许一个人改（冲突高发区）：`lib/channels/qq.js`、`lib/derive.js`、`lib/scheduler.js`。
- 改完在 PR 里报四行：**改了什么 / 测试结果 / 没做什么 / 卡在哪**。

## 跟 AI 一起干活

给你的 AI 看这三样：`AGENTS.md`、本文件、issue 正文。可以直接把下面这段丢给它：

> 你在 dsh-perch 仓库干活。先读 AGENTS.md、CONTRIBUTING.md 和你领的 issue。规则：零依赖；一次只做一件；PR ≤ 400 行；不许改 lib/derive.js、lib/identity.js、lib/persona.js（除非 issue 明确写）；不许自己发版、不许改版本号、不许加依赖；不许读 ~/.dsh-perch；提交前必须跑 `node --test` 并贴出基线数字。

你的 AI **不要**做这些：自行发版 / 改版本号 / 改 `AGENTS.md` 的硬约束 / 碰她的真实数据 / 引入新依赖 / 把本地路径和密钥写进代码。

## 提交与 PR

- 分支从 `main` 拉，PR 回 `main`；`main` 有分支保护，必须 CI 全绿 + 维护者批一次。
- 提交信息一句话说「为什么」，不只说「改了什么」。
- PR 模板里的自查项要真勾，不确定就写说明。
- **第一次贡献要在 PR 里确认已签署 [`CLA.md`](CLA.md)**（版权转让一页纸）——这是为了项目以后能商业化、能换许可证，不针对个人。

## 不许碰的东西

- 她的真实数据目录 `~/.dsh-perch` / `~/.dsh-perch-yunmei`；
- 私有库 `dsh-perch-plan`（内部设计文档）；
- GitHub secrets、npm 发布权、两个 QQ 桥的登录信息；
- `AGENTS.md` 的硬约束、`LICENSE`、`package.json` 的发布字段——要改先提 issue 讨论。

## 谁说了算

这个项目是单一决策人制：方向、路线、版本号、发版、开源/闭源、商业化方式，由维护者定；贡献者有提案权，没有否决权。角色（模块维护、审阅）可以授予也可以收回；分歧写进 issue，别在聊天里吵。

## 遇到问题

- 卡住超过半天：在 issue 里写一句「卡在哪」，别自己憋着改。
- 发现安全问题（泄露隐私、越权读写、凭据进日志）：不要公开提 issue，直接私信维护者。
