# dsh-bulletin-dispatch

**跨桌投递**：让同一台电脑上、不同工作区里的长期会话能互相"投单子"——一句话 + 一处"详见哪里"。

**这是 [dsh-bulletin](https://github.com/southsnowL/dsh-bulletin) 三个插件里的一个**，另外两个是 `dsh-bulletin-announce`（公告）和 `dsh-bulletin-panel`（侧栏面板）。三个各自独立。

## 装

```sh
dsh plugin --profile <profile> add dsh-bulletin-dispatch
```

```yaml
- id: bulletin-dispatch
  name: dsh-bulletin-dispatch
  config:
    workspaceRoot: 'D:\my-office'
    deskNames:
      '01': 游戏开发
      '02': 环境维护
    statusFile: 'D:\my-office\00-通用\投递状态.md'
```

## 干什么

- **认桌**：会话标题开头的 `NN-` 就是桌号（`02-环境维护`）。一张桌可以有很多会话承接。
- **投递**：`dispatch_ticket` 把一句话投给某个桌号；单子挂在**桌**上，不挂在会话上 —— 那张桌**下一个开始干活的会话**取走它，**只有一个**会话能取。
- **领取**：`list_tickets` 看本桌还有哪些待取。
- **状态表**：生成一份给人看的 `投递状态.md`（谁投的、谁取走的、什么时候）。
- **会话回收**：认过桌的会话被删掉后会清理记录，不让名册无限长。

## 三条要记住的

- **单子只告知，不是派活** —— 要不要做由对方和用户决定，**也不需要回执**。
- **取走 ≠ 做完**：取走只表示"那个会话把它拿走了"，插件不跟踪结果。
- **投递不依赖信箱**：能一句话说清的事直接在单子正文里说，不必另建文件。

## 兼容性

**不声明宿主要求** ✓ —— 所以插件市场的卡片上会显示"**未声明宿主要求**"，那是**准确的**：
我们不用版本号拦人，也确实不知道未来哪些版本一定配得上 ⇒ **不声明比乱声明诚实**。

**实测过**：DSH `0.2.0-rc.2` 和 `0.2.1-rc.2`（后者发布当天验过：三个插件都正常挂载、测试全绿）。
系统：Windows。

**平台依赖由 DSH 提供**（本包不装、也不声明 peer）。用到的平台包：`@deepseek-ai/dsh-storage-domain`（单子与领取记录的存储域）、`@deepseek-ai/dsh-llm`（单子正文的上下文接口）。

> ⚠️ 装的时候如果 pnpm 提示别的插件有 peer 问题，**与本包无关** —— 本包没有平台 peer，不会出现这类提示。

Apache-2.0 · 完整文档在[仓库](https://github.com/southsnowL/dsh-bulletin)
