# 第三方声明

本仓库**依赖一个第三方插件**。它**不是**本项目的一部分，有自己的许可。

---

## `dsh-better-sidebar`

| | |
|---|---|
| **它提供什么** | 给 DSH 加**侧边栏**，并开放 `ctx.betterSidebar.registerTab` —— **卡片页能出现，全靠它** |
| **谁依赖它** | `dsh-bulletin-panel`（**唯一**依赖第三方的包） |
| **许可** | MIT |
| **仓库** | https://github.com/omdsh-dev/DSH-better-sidebar |

**⚠️ 为什么单列一份**：本仓库的 `dsh-bulletin-panel` **没有它就不工作**
（没有地方注册卡片），所以它是**实打实的依赖**，不是可选项。

**⚠️ 你要不要为它做什么，取决于"你怎么分发"**：

| 你怎么分发 | 要保留它的版权声明吗 |
|---|---|
| **把本仓库当源码发出去**（`git clone` / 发 zip） | ❌ **不用** —— 它**不在这份源码里**，是使用者自己装 |
| ⭐ **把它的代码一并复制或打包进你的产物**（单文件打包、vendor 依赖、离线安装包…） | ✅ **要** —— 那种情况下**它已经成了你产物的一部分**，得**保留它的版权和许可声明** |

**⇒ 一句话**：**这份声明的作用是告诉你"它存在、它有自己的许可"** ——
**要不要照做，看你的产物里有没有那份代码。**

---

## DSH（DeepSeek Harness）本身

本项目是 **DSH 的插件**，跑在 DSH 之上。
**DSH 不是本仓库的一部分**，它有自己的许可 —— 请以它自己的声明为准。

---

## 本仓自己的依赖（`zod` · `schemastery`）

| 包 | 运行期依赖 | peer 依赖（**宿主提供**） |
|---|---|---|
| `dsh-bulletin-announce` | `zod` · `schemastery` | `@deepseek-ai/dsh-commands` · `@deepseek-ai/dsh-llm` · `@deepseek-ai/dsh-storage-domain` |
| `dsh-bulletin-dispatch` | `zod` · `schemastery` | `@deepseek-ai/dsh-llm` · `@deepseek-ai/dsh-storage-domain` |
| `dsh-bulletin-panel` | **无** | **无** |

**`zod` 和 `schemastery` 都是 MIT。** ⚠️ **而"要不要为它们做什么"同样取决于分发方式**：

| 你怎么分发 | 要保留它们的版权声明吗 |
|---|---|
| **让包管理器装**（`pnpm add` —— 它们进 `node_modules`） | ❌ **不用额外做** —— **那份代码和它自己的 `LICENSE` 一起躺在那儿** |
| ⚠️ **把它们的代码复制或打包进你的产物** | ✅ **要** —— **和上面 `dsh-better-sidebar` 同一个道理** |

**⇒ 所以这里不需要你在项目介绍里反复署名** —— **要保留声明的是那些代码，不是"你用了它"这件事。**

**⇒ `@deepseek-ai/*` 那几个是宿主提供的**（peer），**不是打包进去的**，也不由本仓库分发。

### 想自己核这几条许可的话

**别信这份文件的转述，去看它们自己的声明** ——

| 包 | 它自己的许可 |
|---|---|
| **`dsh-better-sidebar`** | [仓库](https://github.com/omdsh-dev/DSH-better-sidebar)（以它仓库里的 `LICENSE` 为准） |
| **`zod`** | [zod 官方许可](https://github.com/colinhacks/zod/blob/main/LICENSE)（MIT） |
| **`schemastery`** | [schemastery 官方许可](https://github.com/shigma/schemastery/blob/master/LICENSE)（MIT，`Copyright (c) 2021-present Shigma`） |

**⚠️ 而这份文件本身可能过时**（依赖会换版本、许可会改）——
**它记的是"我们发这一版时的事实"，最终以各包自己的声明为准。**

---

*（如果你发现这里漏了什么，请提 issue —— 声明漏了是法律问题，不是小事。）*
