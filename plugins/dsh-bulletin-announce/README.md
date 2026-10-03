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

不想让插件自己装平台依赖（`@deepseek-ai/dsh-*` 由 DSH 提供）—— 安装时 pnpm 提示 "peer 依赖没满足" 是正常的，**不用管**：装错版本反而会让插件加载失败。

Apache-2.0 · 完整文档在[仓库](https://github.com/southsnowL/dsh-bulletin)
