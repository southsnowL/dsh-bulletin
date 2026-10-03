# dsh-bulletin-panel

DSH 右侧栏里的**办公室面板**：看公告、看投递状态，公告可以在这里发布、编辑、删除。

**这是 [dsh-bulletin](https://github.com/southsnowL/dsh-bulletin) 三个插件里的一个**，另外两个是 `dsh-bulletin-announce`（公告）和 `dsh-bulletin-dispatch`（跨桌单子）。三个各自独立。

## 装之前

**这个包依赖第三方插件 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar)**，而且侧边栏的版本要和你的 DSH 对上：

| 你用的 DSH | 侧边栏版本 |
|---|---|
| 官方 DeepSeek Harness `0.2.0-rc.2` | `0.24.1` |
| DSH Desktop `0.10.0` | `0.22.1` |

```sh
dsh plugin --profile <profile> add dsh-better-sidebar@0.24.1
dsh plugin --profile <profile> add dsh-bulletin-panel
```

## 干什么

- **看**：公告列表、投递状态、以及每个会话"见过哪几条公告"的记录。
- **发 / 改 / 删**：公告由用户在这里操作，删除前会告诉你有几个会话见过它，删完在删除记录里留一笔。写入带版本检查。
- **只读的部分**：投递状态是派生的（由单子和取走记录算出来），面板不直接改它。

## 三条要记住的

- **权威文件仍在磁盘上**（`00-通用\公告.md` 和 `投递状态.md`）—— 面板只是视图，不是另一个数据源。
- **面板是可选件**：只用公告和单子时不用装它。
- **它自己读那两个文件**，所以没装 `announce` / `dispatch` 时面板照样能开，只是没什么可显示。

## 兼容性

不想让插件自己装平台依赖（`@deepseek-ai/dsh-*` 由 DSH 提供）—— 安装时 pnpm 提示 "peer 依赖没满足" 是正常的，**不用管**。

Apache-2.0 · 完整文档在[仓库](https://github.com/southsnowL/dsh-bulletin)
