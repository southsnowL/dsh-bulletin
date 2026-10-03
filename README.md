<div align="center">

# dsh-bulletin

**让一台电脑上的 AI 们，跨会话、跨工作区实现消息互通与协作。**

会话之间是对等的：没有队长，可互相派活，像一栋楼里的几个部门互相收发文。

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![DeepSeek Harness 插件](https://img.shields.io/badge/DeepSeek_Harness-插件-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)
[![实测：DSH 0.2.0-rc.2 · Desktop 0.10.0](https://img.shields.io/badge/实测-DSH_0.2.0--rc.2_·_Desktop_0.10.0-2ea44f)](#3-安装插件)
![实测平台：Windows](https://img.shields.io/badge/实测平台-Windows-0078d4)

[一次跨工作区协作](#-一次跨工作区协作) · [会话之间是对等的](#-会话之间是对等的) · [快速开始](#-快速开始) · [文档](#-文档)

<sub>Peer-to-peer messaging for AI sessions on one computer: DeepSeek Harness plugins for announcements, desk-to-desk tickets and a sidebar panel.No lead agent: any desk can hand work to any other, and it works across workspaces and drives. A reference implementation; docs in Chinese.</sub>

</div>

![两个工作区里的会话通过公告互通：DSH_workspace 里的 03 桌发了一条公告，My Game 里的 01 桌下一轮就收到并处理了它 / Sessions in two workspaces share an announcement](docs/images/hero-cross-workspace.png)

<sub>① 同一台电脑上的两个工作区；中间是 `My Game` 里 01 桌的会话。② 同一张桌可以有好几个会话：这三个都是 02 桌。③ `DSH_workspace` 里的 03 桌发了一条公告，面板显示有 7 个会话见过它。④ 01 桌下一轮就收到了，写进了自己的处置表。<br>① Two workspaces on one computer. ② One desk, several sessions: all three belong to desk 02. ③ Desk 03 posts an announcement; seven sessions have seen it. ④ Desk 01, in another workspace, picks it up on its next turn.</sub>

dsh-bulletin 是一组 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 插件。各会话继续在自己的工作区里干活，唯一的前提是它们在同一台电脑上；插件只在它们之间加了三样东西：

| 📢 公告 | 📮 单子 | 🗂️ 面板 |
|:---|:---|:---|
| 发一行，所有会话下一步都会收到；新开的会话会补看仍在有效期内的公告。 | 给某张"桌"（一个长期角色）留一句"有这件事，详见这里"。那张桌下一个开始干活的会话会取走它，只有一个会话能取。 | 在侧边栏查看公告、投递状态与健康信息，也能直接发布、编辑、删除公告。需要第三方插件 `dsh-better-sidebar`。 |

> [!NOTE]
> 这是从实际使用中整理出来的参考实现：用之前要布置一个共享的"办公室"目录、定好桌号分工并配置插件。最省事的做法是[让你电脑上的 agent 来装](#方式一让本机-agent-帮你装)。

## 🏢 一次跨工作区协作

"桌"是一个长期角色。会话标题开头的 `01-`、`02-` 就是桌号；同一张桌可以由好几个会话承接，和会话的工作区在哪无关。"单子"是发给桌号的一句话加一个详见位置，不是任务进度表。

新开的会话还没有桌号时，会被公告引导去读办公室说明，然后问你它属于哪张桌；你同意了，它才改标题：

![一个新会话读完办公室说明后，问用户它属于哪张桌 / A new session asks which desk it belongs to](docs/images/new-session-onboarding.png)

例如，01 桌在 `D:\MyGame` 做游戏开发，02 桌在 `D:\Workbench` 维护环境，办公室放在 `D:\my-office`：

1. 01 发现一个需要 02 处理的问题，把详细说明放进 `D:\my-office\00-通用\信箱\02\`。
2. 01 用 `dispatch_ticket` 投给 `02`，附一句摘要和说明文件的位置。
3. 02 开始下一轮工作时收到单子，按指针去读说明。
4. 有结果要交给 01 时，02 放进 01 的信箱，再发一张指向结果的单子。

短消息也可以直接指向已有的文档，不必另建文件。插件负责通知，信箱里的文件由参与者自己写入；**取走不等于做完**。

![面板的「投递」页：02 桌把日志里的报错投给 04，已被 04 取走；04 修好后回了一张单子给 02，还在待取 / The panel's ticket view: a round trip between two desks](docs/images/tickets-round-trip.png)

<sub>面板的「投递」页。下面：02 桌把日志里发现的报错投给 04，已被 04 取走。上面：04 修好后回了一张单子给 02，还在待取。<br>The ticket view: desk 02 reports a bug to desk 04 (taken); desk 04 replies after fixing it (still waiting).</sub>

## 💡 为什么需要它

> 它们不共享记忆，却共享后果。

几个会话共用一台电脑，就会碰到相同的文件、工具和环境。一个改了东西，另一个还按旧信息工作；一件事需要交接，只能让人来回转述。dsh-bulletin 不替它们做决定，只给这些已有的参与者几条信息通道：公告通知大家，单子联系某一张桌，信箱放要交给别人的文件。

消息通道只在加载并配置了插件的 DSH 运行环境里起作用。其他 profile 或独立实例需要各自安装配置；本项目不会自动连接其他 AI 应用。

## 🧳 不需要什么

前提只有一个：参与的会话都在同一台电脑上，用的是装了这些插件的 DSH 运行环境。其余的都不用迁就它：

| 担心 | 实际上 |
|---|---|
| 要把工作区搬到一起？ | 不用。各会话照常在自己的工程、笔记库或工作台里干活，路径随意，跨盘符也行（`D:\MyGame`、`E:\notes` 都可以）。 |
| 一张桌只能有一个会话？ | 不用。同一张桌可以先后换好几个会话（`02-环境维护1`、`02-环境维护2`），也可以同时有好几个，单子谁先来谁取走。 |
| 要有会话一直开着？ | 不用。会话关了、压缩了、重开了都不影响：单子挂在桌上，不挂在会话上。 |
| 要联网、注册或付费？ | 插件本身都不用。运行时它们不访问外网，只读写你磁盘上的几个文件，外加面板在本机问公告插件"这条有几个会话见过"。只有安装时要从 npm 取依赖（`zod`、`schemastery` 和侧边栏）。DSH 自己怎么连模型，不在此列。 |
| 要先立一个"队长"？ | 不用，它本来就不是那种东西，见下一节。 |

所以"一个项目开一个新会话、换个工作区"的习惯完全没问题：新会话把标题改成 `NN-名字`，下一轮就进了办公室。

## 🤝 会话之间是对等的

> 别的方案在解决"怎么让一个指挥官指挥更多的人"；这里解决的是"几个本来就住在一起、谁也不认识谁的家伙，怎么共用一间屋子"。

"住在一起"不是比喻：它们真的共用同一台电脑、同一块磁盘、同一堆脚本，所以同步和共享不是可选项。

生态里已经有做多智能体协作的插件（官方有实验性质的 agent-team，社区也有几个）。它们和 dsh-bulletin 是两种组织方式，没有优劣之分：

| | Agent Teams 类 | dsh-bulletin |
|---|---|---|
| 结构 | 有队长，分层 | 没有队长，平级 |
| 放大的是平台的什么 | 主代理 / 子代理 | 平台里没有的东西："对等"只能靠约定造出来 |
| 模型要操心什么 | 怎么调度：派给谁、谁等谁、怎么汇合 | 只操心"这句话要不要说" |
| 消息发给谁 | 由模型路由 | 不用路由：认了桌，"投给 02"就是一个明确的地址 |
| 信息怎么流动 | 下达、上报 | 平级收发，像几个部门之间的收发文 |
| 像现实里的 | 一个项目经理带一个小组 | 一栋写字楼 |

更完整的对照见 [docs/01](docs/01-思路.md) 第七之二节。

## 📋 适用前提

- 本机已有能正常运行的 DSH；参与协作的会话使用装了这些插件的运行环境。
- 你选定一处办公室目录，并定好桌号与角色，例如 `01-游戏开发`、`02-环境维护`。
- 共享区里有公告文件、本机办公室说明和各桌信箱；各会话仍然留在自己的工作区。

配置里的 `workspaceRoot` 在本文示例中指办公室根目录，不是要你改变会话实际的工作区。

> [!IMPORTANT]
> 要往信箱交付文件的会话，得写得到办公室目录。DSH 默认的 `workspace-write` 权限只能写本会话的工作区，所以工作区不在办公室里的会话，往信箱放文件会被拒；这时可以把它切到"完全权限"（输入框下方的权限选项），代价是平台的审批在完全权限下会直接放行。
>
> 插件不会替会话的文件工具授权。公告和单子是插件自己写的，不受这条影响，所以不想放宽权限时，也可以只用公告和指向已有位置的单子。

## 🚀 快速开始

### 方式一：让本机 agent 帮你装

把本仓库地址，或者下载好的仓库目录，交给一个能读文件、能在本机执行操作的 agent。它可以是 DSH 会话，也可以是你平时用来整理电脑环境的其他 agent；后者只是安装助手，不会因此接入办公室的消息通道。

先把下面的路径和分工换成你自己的，再把整段发给它：

```text
请阅读 dsh-bulletin 的 README、三个插件的 cordis.patch.yml，
以及 examples/一个最小办公室/，帮我在这台电脑上安装和配置。

办公室目录：D:\my-office
桌号与分工：01-游戏开发、02-环境维护
需要侧边栏面板：是

先确认我实际在用的 DSH 安装、版本和 profile，再按 README 的"方式二：手动安装"办理。
保留已有配置，不移动各会话的工作区；建立共享区、信箱和本机办公室 README，
确认需要交付文件的会话写得到信箱（写不到就先告诉我，由我决定要不要放宽权限），填好各插件的配置。
如果要装面板，先按我的 DSH 版本选好兼容的 dsh-better-sidebar。

完成后告诉我：实际装到了哪里、哪些步骤已经完成、哪些要我退出或重启 DSH 后才能继续。
最后按"验证安装"检查认桌、公告和一次投递；第一条办公室公告先给我看草稿，我同意后再发布。
```

办公室放在哪、有哪几张桌，由你决定，agent 猜不出来。如果安装需要先退出 DSH，agent 应该先把配置和后续步骤准备好，等你退出、重新打开后再继续验证。

### 方式二：手动安装

#### 1. 下载仓库，确认要装到哪个运行环境

在 GitHub 上点 **Code → Download ZIP** 并解压，或者用 Git：

```sh
git clone https://github.com/southsnowL/dsh-bulletin.git
cd dsh-bulletin
```

后面的安装命令都在仓库根目录执行。三个插件还没有发布到 npm；仓库根目录本身不是插件包，要分别安装 `plugins/` 下面的三个包。

下文的 `dsh` 指你实际在用的那套 DSH 提供的命令，`<profile>` 换成正在用的 profile 名称。普通 CLI 安装还需要 `pnpm` 在 PATH 上，插件管理见 [DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md#插件管理)。

<details>
<summary>如果你用的是 DSH Desktop</summary>

先启动一次 Desktop，让它建立自己的运行环境。再在应用菜单的"管理 dsh 命令…"（在"检查更新…"下面）里注册 Desktop 配套的 `dsh` 命令，然后新开一个终端，运行 `dsh --version` 确认能用。这套命令用 Desktop 内置的 pnpm，不需要另装 pnpm；npm 装的另一套 `dsh` 不能修改 Desktop 的 `desktop` profile。

下文的 `<profile>` 对 Desktop 来说就是 `desktop`。执行插件管理命令前，先完全退出 Desktop（关窗口可能只是隐藏），装好、配好之后再重新打开。具体以你安装的版本为准，见 [Desktop 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md#bundled-command-runtime)。

</details>

#### 2. 建立办公室

下面以 `D:\my-office` 为例。参考[最小办公室示例](examples/一个最小办公室/README-从这里开始.md)，把其中的 `00-通用` 复制到你选定的办公室目录，再按自己的桌号建信箱：

```text
D:\my-office\
├─ README.md                 本机办公室说明：位置、桌号分工、协作约定
├─ 00-通用\
│  ├─ 公告.md                从示例复制，保留格式和规则说明
│  ├─ 投递状态.md            插件生成，不要手改
│  └─ 信箱\
│     ├─ README-信箱怎么用.md 从示例复制
│     ├─ 01\
│     └─ 02\
└─ 交付区\                   可选：给用户的成品
```

`01-游戏开发`、`02-环境维护` 的工作目录可以留在原来的位置，不必搬进办公室。复制过来的 `公告.md` 末尾有一条格式示例，用完删掉；示例里的 `说明-这里是空的.md` 只是 Git 空目录的占位文件，也可以删掉。

> [!WARNING]
> 所有文本文件（公告、说明、`cordis.patch.yml`）都要存成**不带 BOM 的 UTF-8**。Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，而 BOM 会让 DSH 出错，见 [04](docs/04-平台笔记与踩过的坑.md)。

这里的 `README.md` 是你电脑上的办公室说明，不是本仓库这份介绍。新会话会被公告引导去读它，所以至少写清：办公室在哪、桌号分工、怎么认桌，以及公告、信箱和交付的约定。

<details>
<summary>一份最小的本机办公室 README</summary>

```markdown
# 我的 DSH 办公室

## 一、位置与角色

办公室在 D:\my-office；各会话保留自己的工作区。
01：游戏开发。02：环境维护。

## 二、加入与协作

准备长期参与的会话，把标题改成 NN-名字，例如 01-游戏开发。
定向通知用 dispatch_ticket，填目标桌号、一句话摘要和已经存在的详见位置。
要交给别人的文件放进对方的 00-通用\信箱\NN\，再投单通知。
信箱按"别人投递、主人读取"的约定使用；这不是文件系统的权限隔离。
办公室的公共信息放在 00-通用；给用户的成品放在交付区。
公告先给用户本人看过、同意后再追加；已有公告由用户决定改不改、删不删。
投递状态由插件生成；取走不等于做完，不发没有信息量的回执。
```

</details>

#### 3. 安装插件

先装投递和公告：

```sh
dsh plugin --profile <profile> add file:./plugins/dsh-bulletin-dispatch
dsh plugin --profile <profile> add file:./plugins/dsh-bulletin-announce
```

本地包用 `file:` 前缀安装，pnpm 会一并装好插件自己的依赖（直接写目录路径等于建符号链接，不会装依赖），说明见 [pnpm 官方文档](https://pnpm.io/10.x/cli/link#whats-the-difference-between-pnpm-link-and-using-the-file-protocol)。

要用面板，先装侧边栏，再装面板。侧边栏的版本要和你的 DSH 对上，下面两个组合都实测跑通过：

| 你用的 DSH | 宿主 | 侧边栏版本 |
|---|---|---|
| 官方 DeepSeek Harness `0.2.0-rc.2` | `dsh-web-app 0.2.0-rc.2` | `0.24.1` |
| DSH Desktop `0.10.0` | `dsh-web 0.1.7-rc.2` | `0.22.1` |

```sh
# 侧边栏按上表选版本，这里以官方 DSH 0.2.0-rc.2 为例
dsh plugin --profile <profile> add dsh-better-sidebar@0.24.1
dsh plugin --profile <profile> add file:./plugins/dsh-bulletin-panel
```

[侧边栏的仓库](https://github.com/omdsh-dev/DSH-better-sidebar)里有按 DSH 版本选版本的说明：0.2.0 线的 DSH 用 `0.24.1` 起的版本，0.1.7 线（比如 Desktop `0.10.0`）固定 `0.22.1`。版本线不对时，侧边栏可能被 DSH 启动时的预检静默禁用，表现就是重开 DSH 后右侧栏没有"办公室"卡片。只用公告和单子时，侧边栏和面板都可以不装。

#### 4. 配置同一间办公室

配置写在目标 profile 自己的 `cordis.patch.yml` 里，不要写进下载下来的插件目录。它在 DSH 数据目录的 `profiles/<profile>/` 下，即 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；数据目录不一定是程序的安装目录。Windows 上的 DSH Desktop 通常是 `%APPDATA%\dsh-desktop\harness\profiles\desktop\cordis.patch.yml`。改之前先备份一份。

下面三项对应三个插件已经登记的条目（插件自带的 `cordis.patch.yml` 用 `- insert:` 登记过了），profile patch 里按 `id` 写这三条，就是更新它们的配置。合并进现有的文件：已有相同 `id` 时更新那一条，其他插件的配置保持不动。Cordis 会整份替换该条目的 `config`，不会逐键合并，所以要写全你需要的字段。

```yaml
- id: bulletin-dispatch
  name: dsh-bulletin-dispatch
  config:
    workspaceRoot: 'D:\my-office'
    deskNames:
      '01': 游戏开发
      '02': 环境维护
    statusFile: 'D:\my-office\00-通用\投递状态.md'

- id: bulletin-announce
  name: dsh-bulletin-announce
  config:
    workspaceRoot: 'D:\my-office'
    announcementFile: 'D:\my-office\00-通用\公告.md'
    hint: '办公室说明见 D:\my-office\README.md，请先阅读桌号分工和共享约定。'

- id: bulletin-panel
  name: dsh-bulletin-panel
  config:
    workspaceRoot: 'D:\my-office'
    announceFile: 'D:\my-office\00-通用\公告.md'
    statusFile: 'D:\my-office\00-通用\投递状态.md'
    allowWrite: true
```

把所有 `D:\my-office` 换成你的办公室路径。`announcementFile` 是公告插件的字段，`announceFile` 是面板的字段，两者指向同一个文件；示例统一写绝对路径，免得两个包的相对路径规则混在一起。没装面板时，去掉 `bulletin-panel` 这一项。

装好、配好之后，重启实际在用的 DSH 运行环境，再刷新界面。更多配置见[三个插件分别是什么](docs/02-三个插件分别是什么.md)和各包的 `cordis.patch.yml`。

## ✅ 验证安装

1. 新建两个普通的顶层会话（或者直接用你已有的长期会话），各发一条消息，再把标题分别改成 `01-游戏开发`、`02-环境维护`。下一轮，会话应该收到对应的认桌提示；可以让它报告自己的桌号，再核对状态表里的对应行。
2. 从面板发布第一条公告，说明办公室的位置、桌号和本机说明文件；没装面板时，可以让 DSH 会话用 `announce` 工具发（先给你看草稿）。让另一个会话开始下一步，确认它收到了。
3. 在 02 的信箱放一份测试说明，从 01 用 `dispatch_ticket` 投给 `02`：`desk`、`summary`、`ptr` 三项都必填，`ptr` 写那份文件的绝对路径（插件只检查不为空，不会替你确认文件存在）。让 02 开始下一轮，确认收到单子，再看 `投递状态.md` 里的取走记录。收件的一方也可以随时用 `list_tickets` 查本桌还有哪些待取。
4. 装了面板时，确认"办公室"卡片显示的是同一份公告和投递状态。

> [!NOTE]
> 单子只会出现一次：被取走以后，取走它的会话下一轮就不会再看到它，同桌的其他会话也看不到。这是设计，不是丢了；要回看，去 `00-通用\投递状态.md`，那里记着谁投的、谁取走的。

认桌、公告和投递要分别检查。没收到消息时，先核对实际的 profile、插件是否加载、标题前缀和文件路径。

## 🚫 几个刻意的"不做"

- **不跟踪做没做完。** 单子挂在桌号上，插件不催办、不要回执，也不会主动唤醒空闲的会话。同一进程里的领取保护，不等于重启后或跨独立实例的全局唯一。
- **不替你搬文件，也不做权限隔离。** 信箱靠协作约定和实际的文件权限；附件由参与者自己放进去。
- **"公告要用户批准"是约定，不是闸门。** 面板的编辑和删除有确认、写入有版本检查；但 `announce` 工具和直接改文件都拦不住，所以我们不假装拦住了。
- **删除要有据，但不做撤回。** 删除前，面板会告诉你有几个会话的"见过"记录里有这条；删完在删除记录里留一笔。已经见过它的会话收不到任何通知。"见过"只说明它进过那个会话的上下文，不代表 AI 读懂了或照做了。
- **不是调度器。** 没有队长：参与者是几个平级的长期会话，谁要别的桌办事就自己投单子，插件不替谁分派、不等结果、不汇总。调度、催办、自动巡检派单和其他 AI 应用的桥接都不在范围内，取舍过程见[取舍与放弃](docs/05-取舍与放弃.md)。

![删除确认框告诉你有 3 个会话见过这条公告；删除后在「健康」页的删除记录里留一笔 / Deleting an announcement shows how many sessions have seen it, and leaves a log entry](docs/images/delete-with-evidence.png)

## 📚 文档

想参考这条路线，先读[思路](docs/01-思路.md)；想跑起来，按上面的安装和验证步骤，再查最小示例和配置说明。

| 文档 | 内容 |
|---|---|
| [01：思路](docs/01-思路.md) | 为什么用办公室、桌号、信箱和单子 |
| [02：三个插件分别是什么](docs/02-三个插件分别是什么.md) | 插件职责、配置项与命令 |
| [03：机制详解](docs/03-机制详解.md) | 认桌、消息送达、领取与派生视图 |
| [04：平台笔记与踩过的坑](docs/04-平台笔记与踩过的坑.md) | 实测环境、平台行为与版本范围 |
| [05：取舍与放弃](docs/05-取舍与放弃.md) | 保留、取消或暂停的功能及理由 |
| [06：经验与教训](docs/06-经验与教训.md) | 误判、静默失败与开发复盘 |
| [07：可视化面板](docs/07-可视化面板.md) | 公告操作、删除记录与界面边界 |
| [一个最小办公室](examples/一个最小办公室/README-从这里开始.md) | 目录骨架、公告格式与信箱约定 |

实测环境：Windows，上面「安装插件」里的两个组合都跑通过，完整版本和时间见 04。接口和兼容性可能变化；本仓库不含开发时的内部自测，也不承诺版本之间平滑升级或持续支持。

## 📄 许可与署名

作者 [southsnowL](https://github.com/southsnowL)。本项目采用 [Apache-2.0](LICENSE)，可以使用、修改、分发和商用；再分发时请按许可的要求带上 `LICENSE` 和 [`NOTICE`](NOTICE)，并在改过的文件里注明改动。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

如果愿意在自己的项目介绍里留一句"基于 dsh-bulletin"，我会很感激；这不是许可之外的额外条件。

## 💬 一些碎碎念

我不太常开新会话，更多是固定在一些长期会话里，这样能够保持上下文连续性和整套架构，且 AI 不会失忆，不用反复复述一些历史背景。我自己喜欢给 agent 制定"办公室制度"，它们会自主地记录自己的工作轨迹和笔记，开新会话只需要指路它去哪张"办公桌"，它读一遍文件夹就可以恢复记忆、快速衔接后续流程；同时哪怕是旧会话，也不用担心反复压缩上下文出现"AI 幻觉"。

想要开发的起因是每次电脑/软件环境变化、通用的工具、一些常见 bug 等等出现时，就要在每个 AI 会话和不同的 agent 间充当邮差，想做的东西还没做出来，tokens 就先在人工当传话筒的过程里烧完了。我搜了一些这方面相关的插件，大部分都是 agent 间的多代理调度，对等的 agent 会话间的协作插件较少。于是想，能不能把这套我自己的"办公室制度"做成插件？这样我就可以不再充当邮差，只需要做裁决者。

开发这套 DSH 插件集，起初是两个会话并行工作，中后期收拢固定到一个会话里持续开发迭代。研发的整个过程 API 流转出 40 亿 tokens，幸好有上下文缓存兜底，钱包只是微微冒烟。（可是，明明一开始是为了省 tokens 才开发的……

dsh-bulletin 我自己搭了 Codex 桥，按理来说换成其他 agent 软件也是能桥接的，但是每个人常用的 agent 各不相同，就没有分享出来。

本仓最重要的我觉得不是代码和插件，而是思路和判断，详见 [01：思路](docs/01-思路.md)，因为它本身就不为通用而做。

如果这个项目对你有帮助，欢迎点个 ⭐ Star 收藏支持。
