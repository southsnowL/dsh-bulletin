# dsh-bulletin-announce

办公室**公告**通道：一个追加式的公告文件，各会话在每一步之前自动收到"自己还没见过"的新公告。

**这是 [dsh-bulletin](https://github.com/southsnowL/dsh-bulletin) 三个插件里的一个**，另外两个是 `dsh-bulletin-dispatch`（跨桌单子）和 `dsh-bulletin-panel`（侧栏面板）。三个各自独立，装哪个看你需要哪个。

## 装

```sh
dsh plugin --profile <profile> add dsh-bulletin-announce
```

装完在 profile 的 `cordis.patch.yml` 里配一下（`workspaceRoot` 指你的办公室目录）：

```yaml
- id: bulletin-announce
  name: dsh-bulletin-announce
  config:
    workspaceRoot: 'D:\my-office'
    announcementFile: 'D:\my-office\00-通用\公告.md'
```

## 干什么

- **发**：给会话一个 `announce` 工具，往公告文件末尾追加一行。
- **送**：每一步之前，把"在有效期内 + 这个会话没见过"的公告送进上下文。新开的会话会自动补看；上下文压缩之后会重发一次。
- **不重复**：每个会话自己记一份"见过哪些"的账（公告指纹是内容算出来的）。

## 三条要记住的

- **规矩按角色分**：**AI 只往后加；改和删是用户的事**（面板里能改能删，都有确认）。
- **"发公告要用户批准"是约定，不是闸门** —— 插件拦不住直接往文件里写。
- **追加式**：新公告永远在末尾；文件里的旧条目会一直留着（过期不删）。

## 兼容性

**不声明宿主要求** ✓ —— 所以插件市场的卡片上会显示"**未声明宿主要求**"，那是**准确的**：
我们不用版本号拦人，也确实不知道未来哪些版本一定配得上 ⇒ **不声明比乱声明诚实**。

**实测过**：DSH `0.2.0-rc.2`、`0.2.1-rc.2` 和 `0.2.1-rc.3`（最近一次 2026-10-24 验过：三个插件都正常挂载、15 套测试全绿）。
系统：Windows。

**平台依赖由 DSH 提供**（本包不装、也不声明 peer）。用到的平台包：`@deepseek-ai/dsh-storage-domain`（公告游标的存储域）、`@deepseek-ai/dsh-commands`（`/mute`、`/unmute` 命令）、`@deepseek-ai/dsh-llm`（注入接口）。

> ⚠️ 装的时候如果 pnpm 提示别的插件有 peer 问题，**与本包无关** —— 本包没有平台 peer，不会出现这类提示。

Apache-2.0 · 完整文档在[仓库](https://github.com/southsnowL/dsh-bulletin)
