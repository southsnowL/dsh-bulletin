/**
 * 办公室面板（客户端半边）—— DSH 右侧栏里的「办公室」卡片。
 *
 * 这一版把两份方案合在了一起：
 *   - Codex 版：顶部标题 + 三个数字；公告 / 投递 / 健康 三个分栏；搜索、按发布者筛选；页脚的刷新状态；
 *     宽面板两列；只读（canWrite: false）时藏起写入口；窗口最小化时也暂停刷新；字段里不许出现「｜」；
 *     分栏能用方向键切换。
 *   - Claude 版：按日期分组；用「[02] 环境维护」认桌；量出来的折叠（真放不下才出现「展开」）；
 *     投递行做成小卡片；发布 / 编辑对话框（有效期快捷选项、实时预览、改前改后对照）；
 *     写接口没上线时提示「该功能尚未上线」且草稿不丢；409 之后由用户手动刷新、不自动重试；错误边界。
 *
 * | 分栏 | 内容 | 能做什么 |
 * |---|---|---|
 * | 公告 | 公告板（**AI 只能追加，用户可以删改**），按日期分组，新到的标「新」 | 搜索 · 按发布者筛选 · 只看新 · 发布（追加一行）· 编辑（改一行，要确认）· 删除（要确认 + 留一行记录） |
 * | 投递 | 插件生成的投递状态：待取 / 已取走 / 最近的取走记录 | 只读 —— 界面上不给改，改了也会被覆盖 |
 * | 健康 | 插件运行信息、面板版本、认过桌的会话、**删除记录（时间线）**、文件在哪 | 只读（删除记录能搜、能看全文、能复制原文） |
 *
 * ## 为什么是纯 JS
 *
 * 平台的客户端机制：往 `window.__ModuleLoader__` 注册一个懒工厂，React 从浏览器模块表里拿，
 * 没有构建步骤、没有 JSX、没有类型检查。所以：
 *   - 不引用宿主的任何客户端 UI 包（它们会无声变化），控件全部自己写；
 *   - 最外层包一个错误边界 `Boundary` —— 万一渲染出错，显示一张错误卡，而不是整张卡片变空白。
 *
 * ## 接口（地址和字段名都别改）
 *
 * | 做什么 | 请求 |
 * |---|---|
 * | 读 | GET  /sidebar/api/office |
 * | 读删除记录 | GET  /sidebar/api/office/deletions（失败 ⇒ 前端记 `null` = 问不到） |
 * | 发布 | POST /sidebar/api/office/announce |
 * | 编辑 | POST /sidebar/api/office/announce/edit（乐观锁：revision + oldRaw） |
 * | 删除 | POST /sidebar/api/office/announce/delete（乐观锁：revision + raw，带上 seenBy） |
 *
 * - GET 里带了 `canWrite: false` ⇒ 只读：发布 / 编辑入口都藏起来，页脚标「只读」。
 *   没带这个字段 ⇒ 当作「不知道」，入口照常显示，写失败再提示。
 * - 写接口没上线时：提交失败就提示「该功能尚未上线」，写好的内容留着不丢。
 * - revision 对不上（409 stale）时不自动重试：明确告诉用户「文件变了，刷新一下」，由用户点刷新再提交。
 * - 编辑要在界面里确认（改前 / 改后对照），不用浏览器自带的弹窗。
 *
 * ## 颜色
 *
 * 只用宿主的主题变量 `--dsw-alias-*`，亮 / 暗 / 换肤自动跟随。需要淡一点的底色时用
 * `color-mix(in oklab, var(--dsw-alias-…) N%, transparent)` 从这些变量里调，不引入任何新颜色。
 * 品牌色实心底上的文字用 `--dsw-alias-bg-base`（亮色主题里是浅的、暗色主题里是深的，两边都看得清）。
 *
 * ## 结构
 *
 * | 层 | 在哪 |
 * |---|---|
 * | 样式 | 顶部的 CSS 模板串（类名全部以 oap- 开头，卸载时整块移除） |
 * | 数据 | useOfficeData() · normalizeData() · postJSON() |
 * | 解析 | renderInline() · renderBlocks() · parseStatus() · parseBlocks() · pickSections() |
 * | 视图 | OfficePanel → AnnounceView（Entry）/ DispatchView / HealthView（RowCard · Section）/ Composer |
 *
 * > 宿主半边 index.js 与本文件互不引用 ⇒ 改这里不可能影响后端。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bulletin-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;
    const { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } = React;

    /**
     * ## ⭐⭐ **前端版本号** —— 写死在这儿，**它不是给自己看的，是给"排查的人"看的**
     *
     * ### 为什么需要它（这是被一个真 bug 逼出来的）
     *
     * 2026-10-01 排一个 bug 排了很久：**后端算得对（直接问接口能拿到正确的数字），
     * 而界面上一律显示 0。**
     *
     * 我于是判定"**浏览器跑的是旧的 `client.js`**" —— 而**界面上没有任何地方
     * 能看出这一点**，只能猜。**⇒ 我为那个猜测编了一整套错的缓存推理。**
     *
     * 真凶是别的东西（`normalizeData` 那个白名单把新字段吃了，见 `docs\06` 二.7）。
     *
     * ### 所以现在
     *
     * **前端（这个常量）和后端（接口给的 `panelVersion`）并排显示在「健康」页的「版本」小节**，
     * 还带一句"一致吗"。**⇒ "我看的是哪一版"从此不用猜。**
     *
     * ⚠️⚠️ **改了 `client.js` 就把它 +1**，而且**必须和 `package.json` 的版本对齐** ——
     * 这个常量唯一的作用就是**代表这个文件的内容**。
     * **它一旦和实际不符，那块"一致吗"就会给出错误答案，那比没有它更糟。**
     */
    const FE_VERSION = '0.3.33';

    /* ═══════════════════════════════════════════════════════════════════
     * 样式 —— ⚠️ 只用主题变量（--dsw-alias-*）。写死颜色的话，亮色/暗色必然有一个不对。
     *        唯一的例外是强调色 --oap-accent（DeepSeek 蓝，0.3.25 起），理由写在 CSS 开头那段注释里。
     * ═══════════════════════════════════════════════════════════════════ */
    const CSS = `
/* ── 根 ─────────────────────────────────────────────────────────── */
.oap-root { --oap-max:1180px; position:relative; display:flex; flex-direction:column; height:100%; min-height:0; min-width:0;
  overflow:hidden; isolation:isolate; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  font-size:13px; line-height:1.6; }
/* ── 强调色：DeepSeek 蓝（0.3.25）──────────────────────────────────────
   ⚠️ 这是整份 CSS 里唯一一个不是宿主 token 的颜色 —— 例外，而且只有这一个。
   为什么要例外：宿主暴露的变量里没有蓝色（docs/07 §5.2 那张表），而 DSH 的品牌色
   在亮 / 暗主题里是黑 / 白；"有几个会话见过"原来借的是警告色（琥珀），
   在一片黑白里很扎眼，读起来还像"出了问题" —— 可它只是一条信息。
   怎么守住"亮暗都对"：不直接用 DeepSeek 的蓝，而是往宿主的文字色里调 18% ——
   亮色主题里文字色是深的，蓝就偏深一点（白底上看得清）；暗色主题里文字色是浅的，蓝就偏亮一点。
   ⇒ 不用写两套，亮暗自动跟着走；换肤时它保持是蓝色（那正是要的）。
   ⚠️ 只给信息性的标记用（现在只有"见过数"）。警告 / 出错 / 成功仍然一律走宿主的 state token。
   ⚠️ 想退回"纯宿主 token"：把下面这一行的值换成 var(--dsw-alias-brand-primary) 就行（会变成黑 / 白）。 */
.oap-root { --oap-accent:color-mix(in oklab, #4d6bfe 82%, var(--dsw-alias-label-primary)); }
.oap-root *, .oap-root *::before, .oap-root *::after { box-sizing:border-box; }
.oap-root button, .oap-root input, .oap-root textarea, .oap-root select { font-family:inherit; }
.oap-root :focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.oap-ic { display:block; flex:0 0 auto; }
.oap-soft { color:var(--dsw-alias-label-secondary); }
.oap-root b, .oap-root strong { font-weight:600; }
.oap-root code, .oap-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
/* 行内代码的底色**从它所在那段文字的颜色里调**（currentColor），不用一块中性的灰：
   原来是 bg-layer-2 —— 放进彩色文字里（比如确认框那句警告色的提示），暗色主题下就成了
   "一块灰底 + 一段橙字"，看起来像个按钮（2026-10-01 看截图发现的）。现在跟着文字走：
   普通文字里还是淡灰，警告色文字里就是一层淡淡的警告色 —— 读起来是"标出来的字"，不是控件。 */
.oap-root code { padding:1px 5px; border-radius:5px; font-size:.88em; overflow-wrap:anywhere;
  background:color-mix(in oklab, currentColor 10%, transparent); }

/* ── 顶部：标题 + 三个数字 + 分栏 ───────────────────────────────────── */
.oap-head { position:sticky; top:0; z-index:5; flex:0 0 auto; border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base); }
.oap-head-in { max-width:var(--oap-max); margin:0 auto; padding:14px 16px 0; }
.oap-titlebar { display:flex; align-items:center; gap:10px; min-width:0; }
.oap-mark { flex:0 0 auto; width:34px; height:34px; display:grid; place-items:center; border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-brand-primary); }
.oap-titles { flex:1 1 auto; min-width:0; }
.oap-title { margin:0; font-size:15px; font-weight:600; line-height:1.35; }
.oap-subtitle { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11.5px; line-height:1.45;
  color:var(--dsw-alias-label-secondary); }
.oap-publish { flex:0 0 auto; height:32px; padding:0 12px 0 10px; display:inline-flex; align-items:center; gap:5px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-brand-primary); font-size:13px; font-weight:500; white-space:nowrap; cursor:pointer;
  transition:border-color .15s, background .15s; }
.oap-publish:hover { border-color:var(--dsw-alias-brand-primary);
  background:color-mix(in oklab, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-base)); }

/* 三个数字：点一下就到对应的分栏 */
.oap-stats { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; margin-top:12px; }
.oap-stat { min-width:0; display:flex; flex-direction:column; align-items:flex-start; padding:7px 12px 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); text-align:left; cursor:pointer; transition:border-color .15s; }
.oap-stat:hover { border-color:var(--dsw-alias-border-l2); }
.oap-stat-n { font-size:19px; font-weight:600; line-height:1.3; font-variant-numeric:tabular-nums; }
.oap-stat-l { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); }
.oap-stat-l b { color:var(--dsw-alias-brand-primary); }
.oap-stat.is-hot { border-color:color-mix(in oklab, var(--dsw-alias-brand-primary) 50%, transparent);
  background:color-mix(in oklab, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-base)); }
.oap-stat.is-hot .oap-stat-n { color:var(--dsw-alias-brand-primary); }

/* 分栏：和对话区「对话 / 轨迹 / 上下文」同一种样式 */
.oap-tabs { display:flex; align-items:stretch; gap:22px; height:40px; margin-top:6px; }
.oap-tab { position:relative; display:inline-flex; align-items:center; gap:6px; margin:0; padding:0 1px; border:0;
  background:transparent; font-size:13px; color:var(--dsw-alias-label-secondary); cursor:pointer; transition:color .15s; }
.oap-tab:hover { color:var(--dsw-alias-label-primary); }
.oap-tab[aria-selected="true"] { color:var(--dsw-alias-brand-primary); font-weight:600; }
.oap-tab[aria-selected="true"]::after { content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px;
  border-radius:2px; background:var(--dsw-alias-brand-primary); }
.oap-tab-n { min-width:18px; height:17px; padding:0 5px; border-radius:6px; text-align:center; font-size:10.5px;
  line-height:17px; font-weight:500; font-variant-numeric:tabular-nums; background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); }
.oap-tab-n.is-hot { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
.oap-tab-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-brand-primary); }

/* ── 图标按钮 ───────────────────────────────────────────────────── */
.oap-ibtn { flex:0 0 auto; display:inline-grid; place-items:center; width:30px; height:30px; padding:0; border:0;
  border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer;
  transition:background .15s, color .15s, opacity .15s; }
.oap-ibtn:hover:not(:disabled):not([aria-disabled="true"]) { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.oap-ibtn:disabled, .oap-ibtn[aria-disabled="true"] { cursor:default; opacity:.6; }
.oap-ibtn.oap-spin[aria-disabled="true"] { opacity:1; }
.oap-ibtn.is-sm { width:24px; height:24px; border-radius:7px; }
.oap-spin .oap-ic { animation:oap-spin .8s linear infinite; }

/* ── 滚动区 · 页脚 ─────────────────────────────────────────────── */
.oap-body { position:relative; flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain;
  scrollbar-gutter:stable; }
.oap-wrap { max-width:var(--oap-max); margin:0 auto; padding:14px 16px 24px; }
.oap-view { animation:oap-in .18s ease-out; }
.oap-stack { display:flex; flex-direction:column; gap:8px; }
.oap-status { flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); }
.oap-status-in { max-width:var(--oap-max); margin:0 auto; padding:6px 16px; display:flex; align-items:center; gap:7px;
  min-width:0; font-size:11px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.oap-status-t { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oap-live-dot { flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.oap-status-in.is-idle .oap-live-dot { background:var(--dsw-alias-state-idle-primary); }
.oap-status-in.is-busy .oap-live-dot { animation:oap-pulse 1s ease-in-out infinite; }
.oap-status-in.is-bad { color:var(--dsw-alias-state-warn-primary); }
.oap-status-in.is-bad .oap-live-dot { background:var(--dsw-alias-state-warn-primary); }
.oap-status-r { margin-left:auto; flex:0 0 auto; display:flex; align-items:center; gap:8px; white-space:nowrap; }
.oap-ro { display:inline-flex; align-items:center; gap:3px; padding:0 6px; border:1px solid var(--dsw-alias-border-l2);
  border-radius:5px; font-size:10.5px; line-height:16px; color:var(--dsw-alias-label-secondary); }

/* ── 工具条：搜索 · 发布者 · 只看新 · 待取/已取走 ─────────────────────── */
.oap-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:10px; }
.oap-search { flex:1 1 180px; min-width:0; height:32px; display:flex; align-items:center; gap:7px; padding:0 8px 0 10px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); cursor:text; transition:border-color .15s, box-shadow .15s; }
.oap-search:hover { border-color:var(--dsw-alias-border-l2); }
.oap-search:focus-within { border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 14%, transparent); }
.oap-search input { flex:1 1 auto; min-width:0; height:100%; padding:0; border:0; outline:none; background:transparent;
  color:var(--dsw-alias-label-primary); font-size:13px; }
.oap-search input::placeholder { color:var(--dsw-alias-label-secondary); opacity:.75; }
.oap-search input::-webkit-search-cancel-button { -webkit-appearance:none; appearance:none; display:none; }
.oap-root .oap-search input:focus-visible { outline:none; }
.oap-search-x { flex:0 0 auto; width:20px; height:20px; display:grid; place-items:center; padding:0; border:0; border-radius:50%;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); cursor:pointer; }
.oap-search-x:hover { color:var(--dsw-alias-label-primary); }
.oap-select { position:relative; flex:0 1 auto; min-width:0; display:inline-flex; align-items:center; }
.oap-select select { height:32px; min-width:0; max-width:200px; padding:0 28px 0 10px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:9px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:12.5px;
  text-overflow:ellipsis; -webkit-appearance:none; appearance:none; cursor:pointer; transition:border-color .15s; }
.oap-select select:hover { border-color:var(--dsw-alias-border-l2); }
.oap-select option { background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); }
.oap-select .oap-ic { position:absolute; right:9px; pointer-events:none; color:var(--dsw-alias-label-secondary); }
.oap-toggle { flex:0 0 auto; height:32px; padding:0 12px; display:inline-flex; align-items:center; gap:5px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary); font-size:12.5px; white-space:nowrap; cursor:pointer; transition:all .15s; }
.oap-toggle:hover:not([aria-disabled="true"]) { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.oap-toggle[aria-pressed="true"] { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary);
  background:color-mix(in oklab, var(--dsw-alias-brand-primary) 9%, var(--dsw-alias-bg-base)); }
.oap-toggle[aria-disabled="true"] { opacity:.5; cursor:default; }
.oap-toggle b { font-variant-numeric:tabular-nums; }
.oap-seg { flex:0 0 auto; display:inline-flex; align-items:stretch; gap:2px; height:32px; padding:3px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-1); }
.oap-seg button { display:inline-flex; align-items:center; gap:5px; padding:0 10px; border:0; border-radius:6px;
  background:transparent; color:var(--dsw-alias-label-secondary); font-size:12.5px; white-space:nowrap; cursor:pointer;
  transition:background .15s, color .15s; }
.oap-seg button:hover { color:var(--dsw-alias-label-primary); }
.oap-seg button[aria-pressed="true"] { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-weight:600;
  box-shadow:0 0 0 1px var(--dsw-alias-border-l1); }
.oap-seg-n { font-weight:500; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-secondary); }
.oap-seg-n.is-hot { color:var(--dsw-alias-brand-primary); font-weight:600; }
.oap-meta-line { display:flex; flex-wrap:wrap; align-items:center; gap:2px 4px; margin:0 2px; font-size:12px;
  color:var(--dsw-alias-label-secondary); }
.oap-meta-line b { color:var(--dsw-alias-brand-primary); font-weight:600; }
.oap-note { display:flex; align-items:center; gap:6px; margin:0 2px 10px; font-size:12px; color:var(--dsw-alias-label-secondary); }

/* ── 日期分组 · 两列网格 ─────────────────────────────────────────── */
.oap-group { display:flex; align-items:center; gap:8px; margin:16px 4px 8px; font-size:12px; font-weight:500;
  color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.oap-group::after { content:""; flex:1 1 auto; height:1px; background:var(--dsw-alias-border-l1); }
.oap-grid { display:grid; grid-template-columns:minmax(0, 1fr); gap:8px; }
.oap-root.is-wide .oap-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }

/* ── 一条公告 ───────────────────────────────────────────────────── */
.oap-card { position:relative; min-width:0; padding:11px 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px;
  background:var(--dsw-alias-bg-layer-1); transition:border-color .15s; }
.oap-card:hover { border-color:var(--dsw-alias-border-l2); }
.oap-card.is-new { border-color:color-mix(in oklab, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1)); }
.oap-card.is-flash { animation:oap-flash 2.6s ease-out; }
.oap-card.is-expired .oap-text { color:var(--dsw-alias-label-secondary); }
.oap-meta { display:flex; align-items:center; gap:7px; min-width:0; min-height:24px; font-size:12px;
  color:var(--dsw-alias-label-secondary); }
.oap-who { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-weight:600; color:var(--dsw-alias-label-primary); }
.oap-av { flex:0 0 auto; width:22px; height:22px; border-radius:7px; display:inline-grid; place-items:center;
  font-size:10.5px; font-weight:700; line-height:1; letter-spacing:-.02em; font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-brand-primary);
  background:color-mix(in oklab, var(--dsw-alias-brand-primary) 14%, transparent); }
.oap-av.is-owner { background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }
.oap-pill { flex:0 0 auto; display:inline-flex; align-items:center; gap:3px; height:20px; padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:999px; font-size:11px; line-height:1;
  white-space:nowrap; color:var(--dsw-alias-label-secondary); }
.oap-pill.is-new { border-color:transparent; font-weight:600; color:var(--dsw-alias-brand-primary);
  background:color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent); }
.oap-pill.is-muted { border-style:dashed; color:var(--dsw-alias-state-idle-primary); }
.oap-pill.is-dashed { border-style:dashed; }
.oap-ttl { margin-left:auto; }
.oap-text { margin-top:6px; font-size:13px; line-height:1.7; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.oap-clamp { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; }
.oap-clamp.is-2 { -webkit-line-clamp:2; }
.oap-foot { display:flex; align-items:center; gap:14px; min-width:0; margin-top:7px; }
.oap-link { flex:0 0 auto; display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; padding:0;
  border:0; background:transparent; font-size:12px; white-space:nowrap; color:var(--dsw-alias-label-secondary);
  cursor:pointer; transition:color .15s; }
.oap-link:hover:not([aria-disabled="true"]) { color:var(--dsw-alias-brand-primary); }
.oap-link[aria-disabled="true"] { opacity:.5; cursor:default; }
.oap-link > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oap-link.is-src { flex:0 1 auto; }
.oap-link.is-edit { margin-left:auto; }
/* ⭐ 删除（2026-10-01）：**平时低调，悬停时变红** ——
   ⚠️ **它不是在"破坏规矩"**（删除属于"用户那一半"，见 docs/01 §五.二），
   **但它会留下一处"分歧"**：见过它的人**不会收到任何通知** ⇒ **所以不该长得像日常动作。**
   ⚠️ 但"低调"不能走到"认不出来"：**鼠标一放上去就必须看起来是危险的**，
   否则手快点错了都不知道点的是什么。
   ⚠️⚠️ **这一段在 CSS 那个模板字符串里 —— 别在里面打反引号。**
   （我打了一个，整份文件当场语法错。**想引用名字就直接写名字，别加引号。**） */
.oap-link.is-del { color:var(--dsw-alias-label-secondary); }
.oap-link.is-del:hover:not([aria-disabled="true"]) { color:var(--dsw-alias-state-error-primary); }
/* 确认框里那句提示：比普通提示重一点，但**不是报错** ——
   ⚠️ 原来这里的注释写的是"文件里不会留下痕迹"，而那**已经不对了**
   （现在会往同目录的 公告-删除记录.md 追一行，面板「健康」页能看到）。 */
.oap-warnline { color:var(--dsw-alias-state-warn-primary); }
.oap-hint.has-ic { display:flex; align-items:flex-start; gap:6px; }
.oap-hint.has-ic > .oap-ic { margin-top:2px; }
.oap-hint.is-ok > .oap-ic { color:var(--dsw-alias-state-success-primary); }
.oap-src { display:flex; align-items:flex-start; gap:6px; margin-top:8px; padding:6px 6px 6px 10px; border-radius:8px;
  background:var(--dsw-alias-bg-layer-2); font-size:12px; color:var(--dsw-alias-label-secondary); }
.oap-src > div { flex:1 1 auto; min-width:0; padding-top:2px; overflow-wrap:anywhere; word-break:break-all; }

/* ── 提示条（警告 / 出错 / 成功）──────────────────────────────────── */
.oap-callout { display:flex; align-items:flex-start; gap:9px; padding:10px 12px; border-radius:10px; font-size:12.5px; line-height:1.55;
  border:1px solid color-mix(in oklab, var(--dsw-alias-state-warn-primary) 45%, transparent);
  background:color-mix(in oklab, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-base)); }
.oap-callout.is-error { border-color:color-mix(in oklab, var(--dsw-alias-state-error-primary) 45%, transparent);
  background:color-mix(in oklab, var(--dsw-alias-state-error-primary) 7%, var(--dsw-alias-bg-base)); }
.oap-callout.is-ok { border-color:color-mix(in oklab, var(--dsw-alias-state-success-primary) 45%, transparent);
  background:color-mix(in oklab, var(--dsw-alias-state-success-primary) 7%, var(--dsw-alias-bg-base)); }
.oap-callout.is-spaced { margin-bottom:12px; }
.oap-callout-ic { margin-top:2px; color:var(--dsw-alias-state-warn-primary); }
.oap-callout.is-error .oap-callout-ic { color:var(--dsw-alias-state-error-primary); }
.oap-callout.is-ok .oap-callout-ic { color:var(--dsw-alias-state-success-primary); }
.oap-callout-b { flex:1 1 auto; min-width:0; }
.oap-callout-t { font-weight:600; color:var(--dsw-alias-label-primary); }
.oap-callout-d { margin-top:2px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.oap-callout-lines { margin-top:6px; max-height:132px; overflow:auto; padding:6px 8px; border-radius:8px;
  background:var(--dsw-alias-bg-layer-2); font-size:11.5px; color:var(--dsw-alias-label-secondary); word-break:break-all; }
.oap-callout-lines > div + div { margin-top:4px; }
.oap-textbtn { margin-top:6px; padding:0; border:0; background:transparent; cursor:pointer;
  font-size:12.5px; font-weight:600; color:var(--dsw-alias-brand-primary); }
.oap-textbtn:hover:not(:disabled):not([aria-disabled="true"]) { text-decoration:underline; text-underline-offset:2px; }
.oap-textbtn:disabled, .oap-textbtn[aria-disabled="true"] { opacity:.6; cursor:default; }
.oap-textbtn.is-inline { margin:0 0 0 6px; font-size:12px; font-weight:500; }
.oap-textbtn.is-quiet { color:var(--dsw-alias-label-secondary); font-weight:400; }
.oap-textbtn.is-quiet:hover:not(:disabled):not([aria-disabled="true"]) { color:var(--dsw-alias-brand-primary); }
.oap-meta-line .oap-textbtn.is-quiet { margin-left:0; }
/* 公告页 → 删除记录的"跨页指路"：搜不到的那条，可能是被删了 */
.oap-xref { width:100%; display:flex; align-items:center; gap:8px; margin-top:10px; padding:9px 12px;
  border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; background:transparent; text-align:left;
  font-size:12.5px; color:var(--dsw-alias-label-secondary); cursor:pointer; transition:border-color .15s, color .15s; }
.oap-xref:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.oap-xref > span { min-width:0; flex:1 1 auto; }

/* ── 空状态 · 读取中 ─────────────────────────────────────────────── */
.oap-empty { display:flex; flex-direction:column; align-items:center; gap:6px; margin-top:4px;
  padding:28px 16px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; text-align:center;
  font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.oap-empty-ic { width:36px; height:36px; margin-bottom:4px; border-radius:10px; display:grid; place-items:center;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.oap-empty-t { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.oap-empty .oap-btn { margin-top:8px; }
.oap-path { max-width:100%; font-size:11px; word-break:break-all; opacity:.85; }
.oap-skel { position:relative; overflow:hidden; padding:12px; border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.oap-skel i { display:block; height:9px; border-radius:5px; background:var(--dsw-alias-bg-layer-2); }
.oap-skel i + i { margin-top:10px; }
.oap-skel::after { content:""; position:absolute; inset:0; transform:translateX(-100%); opacity:.7;
  background:linear-gradient(90deg, transparent, var(--dsw-alias-bg-layer-2), transparent);
  animation:oap-shimmer 1.4s ease-in-out infinite; }

/* ── 投递 / 健康：一行 → 一张小卡片（侧栏太窄，五列表格挤不下）──────────── */
.oap-row { min-width:0; padding:9px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px;
  background:var(--dsw-alias-bg-layer-1); }
.oap-row.is-hot { border-color:color-mix(in oklab, var(--dsw-alias-brand-primary) 50%, transparent); }
.oap-row-top { display:flex; align-items:center; gap:7px; min-width:0; font-size:12px; color:var(--dsw-alias-label-secondary); }
.oap-row-who { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500;
  color:var(--dsw-alias-label-primary); }
.oap-row-inline { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.oap-row-time { margin-left:auto; flex:0 0 auto; padding-left:8px; font-size:11.5px; white-space:nowrap;
  font-variant-numeric:tabular-nums; }
.oap-row-text { margin-top:4px; font-size:12.5px; line-height:1.6; overflow-wrap:anywhere; color:var(--dsw-alias-label-primary); }
.oap-row-sub { display:flex; flex-wrap:wrap; align-items:center; gap:3px 12px; margin-top:5px; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); }
.oap-row-sub .oap-av { width:16px; height:16px; border-radius:5px; font-size:9px; }
.oap-row-top .oap-av { width:20px; height:20px; border-radius:6px; font-size:10px; }
.oap-desk-inline { display:inline-flex; align-items:center; gap:5px; vertical-align:bottom; }
.oap-desk-chip { flex:0 1 auto; min-width:0; display:inline-flex; align-items:center; gap:6px; }
.oap-row-label { flex:0 0 auto; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.oap-row-arrow { flex:0 0 auto; display:inline-flex; color:var(--dsw-alias-label-secondary); }
.oap-kv-k { margin-right:4px; opacity:.75; }
.oap-id { margin-left:auto; font-size:11px; opacity:.7; }
.oap-id code { padding:0; background:transparent; }
.oap-more { align-self:flex-start; display:inline-flex; align-items:center; gap:4px; margin:2px 0 0 4px; padding:0; border:0;
  background:transparent; font-size:12px; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.oap-more:hover { color:var(--dsw-alias-brand-primary); }
.oap-quiet { display:flex; align-items:center; gap:8px; padding:11px 12px; border:1px dashed var(--dsw-alias-border-l2);
  border-radius:10px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.oap-quiet.is-ok .oap-ic { color:var(--dsw-alias-state-success-primary); }
.oap-quiet.is-warn { border-color:color-mix(in oklab, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.oap-quiet.is-warn .oap-ic { color:var(--dsw-alias-state-warn-primary); }
.oap-quiet > span { min-width:0; overflow-wrap:anywhere; }
.oap-quote { margin:2px 0; padding:2px 0 2px 10px; border-left:2px solid var(--dsw-alias-border-l2);
  font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.oap-hr { height:1px; margin:4px 0; background:var(--dsw-alias-border-l1); }
.oap-p { margin:2px 4px; font-size:12.5px; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.oap-subh { margin:6px 4px 0; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.oap-footnote { display:flex; gap:8px; margin-top:16px; padding:10px 12px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-1); font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.oap-footnote .oap-ic { margin-top:3px; }
.oap-footnote p { margin:0; }
.oap-footnote p + p { margin-top:4px; }

/* 可折叠的分节（像左侧会话列表的分组） */
.oap-sec { margin-top:14px; }
.oap-sec-h { width:100%; display:flex; align-items:center; gap:6px; margin:0 0 6px; padding:5px 6px 5px 4px;
  border:0; border-radius:8px; background:transparent; text-align:left; cursor:pointer;
  font-size:12.5px; color:var(--dsw-alias-label-secondary); transition:background .15s, color .15s; }
.oap-sec-h:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.oap-sec.is-closed .oap-sec-h { margin-bottom:0; }
.oap-chev { transition:transform .18s; }
.oap-sec.is-closed .oap-chev { transform:rotate(-90deg); }
.oap-up { transform:rotate(180deg); }
.oap-sec-name { font-weight:600; white-space:nowrap; color:var(--dsw-alias-label-primary); }
.oap-count { padding:0 7px; border-radius:999px; font-size:11px; line-height:18px; font-variant-numeric:tabular-nums;
  background:var(--dsw-alias-bg-layer-2); }
.oap-sec-hint { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11.5px; opacity:.8; }

/* 健康页：小标题 + 键值卡片 */
.oap-sh { display:flex; align-items:baseline; gap:8px; margin:20px 2px 8px; }
.oap-sh:first-child { margin-top:2px; }
.oap-sh h3 { margin:0; font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.oap-sh span { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.oap-kvs { padding:2px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.oap-kvr { display:grid; grid-template-columns:7.5em minmax(0, 1fr); gap:12px; align-items:start; padding:7px 0; font-size:12.5px; }
.oap-kvr + .oap-kvr { border-top:1px solid var(--dsw-alias-border-l1); }
.oap-kvr.is-plain { grid-template-columns:minmax(0, 1fr); }
.oap-kvr-k { color:var(--dsw-alias-label-secondary); }
.oap-kvr-v { min-width:0; overflow-wrap:anywhere; }
.oap-kvr-v.has-btn { display:flex; align-items:flex-start; gap:6px; }
.oap-kvr-v.has-btn > span { min-width:0; flex:1 1 auto; padding-top:1px; }
/* 一张卡片上面那行小字：说清这张卡的数据从哪来（面板版本和投递状态文件不是一个来源） */
.oap-cap { margin:12px 2px 6px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.oap-ok { display:inline-flex; align-items:center; gap:3px; margin-left:8px; vertical-align:-1px; color:var(--dsw-alias-state-success-primary); }
.oap-sh + .oap-cap { margin-top:0; }
.oap-group.is-tight { margin-top:6px; }

/* ── 删除记录：一条时间线（健康页）──────────────────────────────────
   一天一组（和公告页同一种日期分隔线）；左边一根竖线，每条一个点。
   点的样子 = 删的那一刻有没有会话见过：实心蓝（强调色）= 有（那就是一处"分歧"）、
   空心 = 没人见过、虚线圈 = 当时没问出来（⚠️ 不是 0，见 seenBadge）。
   （0.3.25 起从警告色换成强调色：和公告卡片上那颗"见过数"同一个颜色，见文件开头 --oap-accent。） */
.oap-tl { position:relative; margin:0 0 0 6px; padding:0 0 0 18px; }
.oap-tl::before { content:""; position:absolute; left:0; top:6px; bottom:16px; width:1px; background:var(--dsw-alias-border-l2); }
.oap-tl-item { position:relative; padding:0 0 14px; }
.oap-tl-item::before { content:""; position:absolute; left:-22px; top:6px; width:9px; height:9px; border-radius:50%;
  border:1.5px solid var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); }
.oap-tl-item.is-some::before { border-color:var(--oap-accent); background:var(--oap-accent); }
.oap-tl-item.is-unknown::before { border-style:dashed; border-color:var(--dsw-alias-state-idle-primary); }
.oap-tl-head { display:flex; align-items:center; gap:7px; min-width:0; min-height:22px; font-size:12px;
  color:var(--dsw-alias-label-secondary); }
.oap-tl-time { flex:0 0 auto; font-variant-numeric:tabular-nums; }
.oap-tl-head .oap-av { width:18px; height:18px; border-radius:6px; font-size:9.5px; }
.oap-tl-who { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;
  color:var(--dsw-alias-label-primary); }
.oap-tl-text { margin-top:3px; font-size:12.5px; line-height:1.65; overflow-wrap:anywhere; color:var(--dsw-alias-label-primary); }
.oap-tl-text.is-raw { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); }
.oap-tl-meta { display:flex; flex-wrap:wrap; align-items:center; gap:2px 12px; margin-top:4px; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); }
.oap-tl-meta > span { min-width:0; overflow-wrap:anywhere; }
.oap-tl-meta .oap-link { font-size:11.5px; }
.oap-tl-acts { margin-left:auto; display:inline-flex; align-items:center; gap:12px; }
.oap-tl-cut { color:var(--dsw-alias-state-warn-primary); }
.oap-tl-foot { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; margin:4px 2px 0; font-size:11.5px;
  color:var(--dsw-alias-label-secondary); }
.oap-tl-foot .oap-ic { opacity:.8; }
.oap-tl-file { display:inline-flex; align-items:center; gap:5px; min-width:0; }
/* 「有几个会话见过」—— 三档，不是两档：N / 没人见过 / 问不到（公告卡片和删除记录共用这一套）。
   有人见过那一档用强调色（蓝）：点、字、淡底都是它 —— 一颗"信息"标签，不是警告。 */
.oap-seen { flex:0 0 auto; margin-left:auto; display:inline-flex; align-items:center; gap:5px; height:20px; padding:0 8px;
  border:1px solid transparent; border-radius:999px; font-size:11px; line-height:1; white-space:nowrap;
  color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); }
.oap-seen::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; opacity:.7; }
.oap-seen.is-some { color:var(--oap-accent); font-weight:600;
  background:color-mix(in oklab, var(--oap-accent) 12%, transparent); }
.oap-seen.is-some::before { background:var(--oap-accent); opacity:1; }
.oap-seen.is-unknown { background:transparent; border:1px dashed var(--dsw-alias-border-l2); }
.oap-seen.is-unknown::before { display:none; }
/* ⚠️ **在公告卡片那一行里，它不能推到最右**（那条 margin-left:auto 是给删除记录那一行用的）——
   公告的 meta 行里已经有「发布者 / 新 / 有效期」在排队，推最右会把它们挤断。
   ⇒ 只在公告卡片这一处把 auto 收掉，**不碰删除记录那份样式**（那处正需要推最右）。
   ⚠️ 写这段时我在注释里打了反引号 —— **而整个 CSS 是个模板字符串，那对反引号把字符串截断了。**
   （这条规矩本来就写在文件顶部："CSS 模板串里没有反引号"。） */
.oap-meta .oap-seen { margin-left:0; }

/* 兜底：状态表没有 ## 分节时，按原样渲染 markdown */
.oap-md { font-size:12.5px; }
.oap-md h1 { margin:8px 0 4px; font-size:14px; font-weight:600; }
.oap-md h2 { margin:14px 0 6px; font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-secondary); }
.oap-md p { margin:3px 0; }
.oap-tr { display:flex; gap:8px; margin-bottom:4px; padding:6px 10px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.oap-tr.oap-th { padding:1px 10px; border-color:transparent; background:transparent; font-size:11px;
  color:var(--dsw-alias-label-secondary); }
.oap-td { flex:1 1 0; min-width:0; overflow-wrap:anywhere; }
.oap-td.oap-narrow { flex:0 0 auto; opacity:.75; }

/* ── 发布 / 编辑：面板内的对话框（不用浏览器自带弹窗）──────────────── */
.oap-scrim { position:absolute; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; padding:14px;
  background:color-mix(in oklab, var(--dsw-alias-bg-base) 55%, transparent);
  -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px); animation:oap-fade .16s ease-out; }
.oap-dlg:focus { outline:none; }
.oap-dlg { width:100%; max-width:480px; max-height:100%; display:flex; flex-direction:column; overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-overlay);
  box-shadow:0 18px 40px -14px color-mix(in oklab, var(--dsw-alias-label-primary) 28%, transparent);
  animation:oap-pop .2s cubic-bezier(.2, .9, .3, 1); }
.oap-dlg-h { display:flex; align-items:flex-start; gap:10px; padding:14px 12px 4px 16px; }
.oap-dlg-h > div { flex:1 1 auto; min-width:0; }
.oap-dlg-t { font-size:14.5px; font-weight:600; line-height:1.45; }
.oap-dlg-s { margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px;
  color:var(--dsw-alias-label-secondary); }
.oap-dlg-b { flex:1 1 auto; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:14px; padding:10px 16px 4px; }
.oap-dlg-f { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; padding:12px 16px 14px; }
.oap-dlg-hint { flex:1 1 180px; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.oap-hint { font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.oap-field { display:flex; flex-direction:column; gap:6px; }
.oap-label { display:flex; align-items:baseline; gap:8px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.oap-label-r { margin-left:auto; font-size:11px; opacity:.85; font-variant-numeric:tabular-nums; }
.oap-input, .oap-textarea { width:100%; padding:8px 11px; border:1px solid var(--dsw-alias-border-l2);
  border-radius:10px; outline:none; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  font-size:13px; line-height:1.6; transition:border-color .15s, box-shadow .15s; }
.oap-input.is-narrow { max-width:220px; }
.oap-textarea { display:block; min-height:88px; max-height:240px; resize:none; }
.oap-input:focus, .oap-textarea:focus { border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 16%, transparent); }
.oap-input.is-bad, .oap-textarea.is-bad { border-color:var(--dsw-alias-state-error-primary); }
.oap-input::placeholder, .oap-textarea::placeholder { color:var(--dsw-alias-label-secondary); opacity:.65; }
.oap-root .oap-input:focus-visible, .oap-root .oap-textarea:focus-visible { outline:none; }
.oap-field-err { font-size:11.5px; color:var(--dsw-alias-state-error-primary); }
.oap-choices { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.oap-choice { height:28px; padding:0 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px;
  background:transparent; color:var(--dsw-alias-label-secondary); font-size:12.5px; cursor:pointer; transition:all .15s; }
.oap-choice:hover { color:var(--dsw-alias-label-primary); }
.oap-choice[aria-pressed="true"] { border-color:var(--dsw-alias-brand-primary); font-weight:600; color:var(--dsw-alias-brand-primary);
  background:color-mix(in oklab, var(--dsw-alias-brand-primary) 10%, transparent); }
.oap-days { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.oap-days .oap-input { width:64px; height:28px; padding:0 8px; text-align:center; }
.oap-preview { padding:8px 11px; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px;
  font-size:12.5px; line-height:1.6; overflow-wrap:anywhere; }
.oap-btn { height:32px; padding:0 14px; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary); font-size:13px; white-space:nowrap; cursor:pointer; transition:background .15s, opacity .15s; }
.oap-btn:hover:not(:disabled):not([aria-disabled="true"]) { background:var(--dsw-alias-bg-layer-2); }
.oap-btn.is-primary { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base); font-weight:600; }
.oap-btn.is-primary:hover:not(:disabled):not([aria-disabled="true"]) { background:var(--dsw-alias-brand-primary); opacity:.88; }
/* 删除确认框的「删除」：原来挂着 is-danger 这个类，**而 CSS 里从来没有它** ⇒ 显示成和「发布」一样的品牌色。
   破坏性的那一下该长得不一样（和卡片上「删除」悬停变红是同一个颜色）。 */
.oap-btn.is-danger { border-color:var(--dsw-alias-state-error-primary); background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-bg-base); font-weight:600; }
.oap-btn.is-danger:hover:not(:disabled):not([aria-disabled="true"]) { background:var(--dsw-alias-state-error-primary); opacity:.88; }
.oap-btn:disabled, .oap-btn[aria-disabled="true"] { opacity:.45; cursor:default; }
.oap-diff { display:flex; flex-direction:column; gap:12px; }
.oap-diff-k { margin-bottom:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.oap-diff-v { position:relative; padding:7px 10px 7px 26px; border-radius:8px; font-size:12.5px; line-height:1.6; overflow-wrap:anywhere; }
.oap-diff-v + .oap-diff-v { margin-top:4px; }
.oap-diff-v::before { position:absolute; left:10px; top:7px; font-weight:700; }
.oap-diff-v.is-old { color:var(--dsw-alias-label-secondary);
  background:color-mix(in oklab, var(--dsw-alias-state-error-primary) 7%, transparent); }
.oap-diff-v.is-old::before { content:"−"; color:var(--dsw-alias-state-error-primary); }
.oap-diff-v.is-new { background:color-mix(in oklab, var(--dsw-alias-state-success-primary) 9%, transparent); }
.oap-diff-v.is-new::before { content:"+"; color:var(--dsw-alias-state-success-primary); }
.oap-diff-v i { font-style:normal; opacity:.6; }

/* ── 轻提示 ─────────────────────────────────────────────────────── */
.oap-toast { position:absolute; left:50%; bottom:46px; z-index:30; display:inline-flex; align-items:center; gap:6px;
  max-width:calc(100% - 32px); padding:7px 14px 7px 11px; border-radius:999px; pointer-events:none;
  background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-base); font-size:12.5px; white-space:nowrap;
  transform:translateX(-50%); animation:oap-toast .22s ease-out; }

/* ── 宽 / 窄（JS 量面板宽度后挂 is-wide / is-narrow）────────────────── */
.oap-root.is-wide .oap-head-in, .oap-root.is-wide .oap-wrap, .oap-root.is-wide .oap-status-in { padding-left:24px; padding-right:24px; }
.oap-root.is-narrow .oap-head-in { padding:10px 12px 0; }
.oap-root.is-narrow .oap-wrap { padding:12px 12px 20px; }
.oap-root.is-narrow .oap-status-in { padding:6px 12px; }
.oap-root.is-narrow .oap-mark, .oap-root.is-narrow .oap-subtitle { display:none; }
.oap-root.is-narrow .oap-stats { gap:6px; margin-top:10px; }
.oap-root.is-narrow .oap-stat { padding:6px 9px 7px; }
.oap-root.is-narrow .oap-stat-n { font-size:17px; }
.oap-root.is-narrow .oap-tabs { gap:18px; }
.oap-root.is-narrow .oap-card, .oap-root.is-narrow .oap-row { padding:10px 12px; }
.oap-root.is-narrow .oap-scrim { padding:8px; }
.oap-root.is-narrow .oap-search { flex-basis:100%; }
.oap-root.is-narrow .oap-select { flex:1 1 auto; }
.oap-root.is-narrow .oap-select select { width:100%; max-width:none; }
/* 窄的时候键值行改成上下两行：左边那列 7.5em 会把路径挤成一字一行 */
.oap-root.is-narrow .oap-kvr { grid-template-columns:minmax(0, 1fr); gap:1px; }
.oap-root.is-narrow .oap-kvr-k { font-size:11.5px; }
.oap-root.is-narrow .oap-tl { margin-left:4px; padding-left:16px; }
.oap-root.is-narrow .oap-tl-item::before { left:-20px; }

/* ── 动效 ───────────────────────────────────────────────────────── */
@keyframes oap-spin { to { transform:rotate(360deg); } }
@keyframes oap-shimmer { to { transform:translateX(100%); } }
@keyframes oap-pulse { 50% { opacity:.35; } }
@keyframes oap-in { from { opacity:0; transform:translateY(4px); } }
@keyframes oap-fade { from { opacity:0; } }
@keyframes oap-pop { from { opacity:0; transform:translateY(8px) scale(.98); } }
@keyframes oap-toast { from { opacity:0; transform:translate(-50%, 6px); } }
@keyframes oap-flash { 0%, 35% { border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in oklab, var(--dsw-alias-brand-primary) 18%, transparent); } }
@media (prefers-reduced-motion: reduce) {
  .oap-root *, .oap-root *::before, .oap-root *::after { animation-duration:.01ms !important;
    animation-iteration-count:1 !important; transition-duration:.01ms !important; }
}
`;

    /* ═══════════════════════════════════════════════════════════════════
     * 小工具
     * ═══════════════════════════════════════════════════════════════════ */
    const str = (v) => (v === null || v === undefined ? '' : String(v));

    /** HTML 实体还原（源文件里出现过 `&lt;收方&gt;`）。 */
    const ENT = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };
    const decodeEntities = (s) => str(s).replace(/&(lt|gt|quot|#39|apos|amp);/gu, (m) => ENT[m]);
    /** 去掉行内 markdown 记号，只留文字（用于 title 提示、复制、搜索、比较）。 */
    const stripMd = (s) => decodeEntities(s).replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/`([^`]+)`/gu, '$1').trim();
    /** 公告是一行一条：换行合并成空格。 */
    const oneLine = (s) => str(s).replace(/\s*[\r\n]+\s*/gu, ' ').trim();
    const isParenOnly = (s) => /^[（(][\s\S]*[）)]$/u.test(stripMd(s));
    const pad2 = (n) => String(n).padStart(2, '0');
    /** 公告文件用全角竖线「｜」分隔字段 —— 内容里出现它会把那一行拆坏。 */
    const hasBar = (s) => /｜/u.test(str(s));

    /** 线性图标（stroke = currentColor，颜色跟着文字走）。 */
    const ICONS = {
      office: ['M4 20.5h16', 'M6 20.5V5.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v15', 'M9.5 8.5h1.5', 'M13 8.5h1.5', 'M9.5 12h1.5', 'M13 12h1.5', 'M10.5 20.5v-4h3v4'],
      refresh: ['M20.5 12a8.5 8.5 0 1 1-2.49-6.01', 'M20.5 4v5h-5'],
      plus: ['M12 5.5v13', 'M5.5 12h13'],
      arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
      search: [{ c: [11, 11, 6.5] }, 'M16 16l4 4'],
      pencil: ['M14.5 5.5l4 4', 'M4 20l1-4.2L15.8 5a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19z'],
      file: ['M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z', 'M14 3.5V8h4.5'],
      chevron: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      checkCircle: [{ c: [12, 12, 8.5] }, 'M8.5 12.2l2.4 2.4 4.6-4.9'],
      alert: ['M12 4.2l8.6 15a1 1 0 0 1-.87 1.5H4.27a1 1 0 0 1-.87-1.5z', 'M12 10v4', 'M12 17.2v.1'],
      alertCircle: [{ c: [12, 12, 8.5] }, 'M12 8v4.5', 'M12 15.8v.1'],
      lock: [{ r: [5.5, 10.5, 13, 9.5, 2] }, 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5'],
      user: [{ c: [12, 8.5, 3.5] }, 'M5.5 19.5a6.5 6.5 0 0 1 13 0'],
      x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
      copy: [{ r: [8.5, 8.5, 11, 11, 2] }, 'M15.5 5.5V5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h.5'],
      megaphone: ['M4 10v4a1 1 0 0 0 1 1h2l6 4V5L7 9H5a1 1 0 0 0-1 1z', 'M16.5 9a4 4 0 0 1 0 6', 'M19 6.5a7.5 7.5 0 0 1 0 11'],
      inbox: [{ r: [3.5, 4.5, 17, 15, 2.5] }, 'M3.5 13h4.5l1.5 2.5h5l1.5-2.5h4.5'],
      clock: [{ c: [12, 12, 8.5] }, 'M12 7.5V12l3 2'],
      info: [{ c: [12, 12, 8.5] }, 'M12 11v5', 'M12 8v.1'],
      /** ⭐ 删除（2026-10-01 加）—— 一个垃圾桶：盖子 + 桶身 + 两条竖线。 */
      trash: ['M4 7h16', 'M9.5 7V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V7',
        'M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7', 'M10.5 11v5', 'M13.5 11v5'],
    };
    function icon(name, size, extraClass) {
      const s = size || 14;
      return h('svg', {
        className: extraClass ? `oap-ic ${extraClass}` : 'oap-ic',
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      }, (ICONS[name] || []).map((p, i) => {
        if (typeof p === 'string') return h('path', { key: i, d: p });
        if (p.c) return h('circle', { key: i, cx: p.c[0], cy: p.c[1], r: p.c[2] });
        return h('rect', { key: i, x: p.r[0], y: p.r[1], width: p.r[2], height: p.r[3], rx: p.r[4] });
      }));
    }

    /**
     * 行内 markdown → React 节点。
     *
     * ⚠️ 只支持公告/状态表实际用到的：`**粗体**` 与 `` `代码` ``（粗体里可以再套代码）。
     * 不是通用 markdown 渲染器 —— 不认识的语法原样当文本，不猜；也不产生任何 HTML / 链接。
     */
    function renderInline(text, keyBase) {
      const src = decodeEntities(text);
      const out = [];
      const re = /\*\*([^*]+)\*\*|`([^`]+)`/gu;
      let last = 0;
      let m;
      let i = 0;
      while ((m = re.exec(src)) !== null) {
        if (m.index > last) out.push(src.slice(last, m.index));
        const k = `${keyBase}-${i++}`;
        if (m[1] !== undefined) out.push(h('b', { key: k }, renderInline(m[1], k)));
        else out.push(h('code', { key: k }, m[2]));
        last = m.index + m[0].length;
      }
      if (last < src.length) out.push(src.slice(last));
      return out;
    }

    /**
     * 一段 markdown → React 节点（兜底用：状态表万一没有 `##` 分节，就原样渲染）。
     * 只支持标题 / 列表 / 引用 / 表格 / 行内；不认识的语法原样显示，不猜、不丢。
     */
    function renderBlocks(md, keyPrefix = 'md') {
      const lines = str(md).split(/\r?\n/u);
      const nodes = [];
      let table = null;
      const flushTable = (key) => {
        if (table === null) return;
        const rows = table;
        table = null;
        const head = rows[0];
        const body = rows.slice(1).filter((r) => !r.every((c) => /^:?-{2,}:?$/u.test(c)));
        nodes.push(h('div', { key: `t-${key}` },
          h('div', { className: 'oap-tr oap-th' },
            head.map((c, i) => h('div', { key: i, className: 'oap-td' }, renderInline(c, `th-${key}-${i}`)))),
          body.map((r, ri) => h('div', { key: ri, className: 'oap-tr' },
            r.map((c, ci) => h('div', { key: ci, className: `oap-td${ci === 0 ? ' oap-narrow' : ''}` },
              renderInline(c, `td-${key}-${ri}-${ci}`)))))));
      };
      for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (t.startsWith('|')) {
          (table || (table = [])).push(splitRow(t));
          continue;
        }
        flushTable(i);
        if (t === '') continue;
        const k = `${keyPrefix}-${i}`;
        if (t.startsWith('### ')) { nodes.push(h('h2', { key: k }, renderInline(t.slice(4), k))); continue; }
        if (t.startsWith('## ')) { nodes.push(h('h2', { key: k }, renderInline(t.slice(3), k))); continue; }
        if (t.startsWith('# ')) { nodes.push(h('h1', { key: k }, renderInline(t.slice(2), k))); continue; }
        if (t.startsWith('- ') || t.startsWith('* ')) { nodes.push(h('p', { key: k }, '· ', renderInline(t.slice(2), k))); continue; }
        if (t.startsWith('> ')) { nodes.push(h('p', { key: k, className: 'oap-soft' }, renderInline(t.slice(2), k))); continue; }
        nodes.push(h('p', { key: k }, renderInline(t, k)));
      }
      flushTable('end');
      return nodes;
    }

    /** 表格的一行 → 单元格。`\|` 是转义的竖线；反引号里的竖线也不拆。 */
    function splitRow(line) {
      const t = line.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '');
      const cells = [];
      let cell = '';
      let inCode = false;
      for (let i = 0; i < t.length; i += 1) {
        const ch = t[i];
        if (ch === '\\' && t[i + 1] === '|') { cell += '|'; i += 1; continue; }
        if (ch === '`') inCode = !inCode;
        if (ch === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
        cell += ch;
      }
      cells.push(cell.trim());
      return cells;
    }

    /** 从"详见"里取一个短标签（只显示文件名，别把整条路径铺开）。 */
    function sourceLabel(src) {
      const s = decodeEntities(src);
      const codes = [...s.matchAll(/`([^`]+)`/gu)].map((m) => m[1]);
      if (codes.length > 0) {
        const last = codes[codes.length - 1];
        const base = last.split(/[\\/]/u).filter(Boolean).pop() ?? last;
        return codes.length > 1 ? `${base} 等 ${codes.length} 处` : base;
      }
      const cleaned = s.replace(/^\**\s*(详见|怎么用|规矩|谁有什么状态)\**\s*[:：]?\s*/u, '').trim();
      const base = cleaned.split(/[\\/]/u).filter(Boolean).pop() ?? cleaned;
      return base.length > 0 ? base : s.slice(0, 40);
    }

    /* ── 日期（公告只写 MM-DD，没有年份）──────────────────────────────── */
    const DAY = 86400000;
    function today0() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
    function parseDay(s) {
      const m = /^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})$/u.exec(str(s).trim());
      if (!m) return null;
      const mo = Number(m[2]) - 1;
      const da = Number(m[3]);
      if (mo < 0 || mo > 11 || da < 1 || da > 31) return null;
      const t0 = today0();
      let d = new Date(m[1] ? Number(m[1]) : t0.getFullYear(), mo, da);
      // 没写年份又比今天晚好几天 ⇒ 多半是去年的（跨年时）
      if (!m[1] && d.getTime() - t0.getTime() > 2 * DAY) d = new Date(t0.getFullYear() - 1, mo, da);
      return d;
    }
    const fmtMD = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const fmtHM = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
    function dayLabel(date) {
      const d = parseDay(date);
      if (d === null) return str(date) || '没写日期';
      const diff = Math.round((today0().getTime() - d.getTime()) / DAY);
      if (diff === 0) return `今天 · ${date}`;
      if (diff === 1) return `昨天 · ${date}`;
      return str(date);
    }
    /**
     * 有效期那一栏 → 天数。**口径照公告插件**（各桌是按它收公告的，面板说的必须和它一样）：
     *
     * | 写法 | 天数 | 公告插件怎么算 |
     * |---|---|---|
     * | `0` / `长期` / `永久` / `不说`（可带「有效期」前缀）、`0 天` | `0` | 长期 |
     * | `30 天` / `有效期 30 天` / 裸数字 `30` | `30` | 30 天 |
     * | **空** | `null` | 按它自己的默认天数（默认 14，可配）—— **面板不知道那个数** |
     * | 认不出（比如 `长期有效`） | `null` | 同上，按默认天数 |
     *
     * ⚠️ 2026-10-01 改的（0.3.22）。原来是"空 ⇒ 0（长期）"、"含『长期』二字就算长期"，
     * 而公告插件那边**空 = 默认 14 天**、`长期有效` 也是默认 14 天 ⇒ **面板说"长期"，各桌那边会过期**。
     * 还有一处直接看得见的：面板自己发的长期公告写成 `0 天`，原来那颗小标签就显示「0 天」。
     */
    function ttlDaysOf(ttl) {
      const t = decodeEntities(ttl).trim();
      if (t === '') return null;
      const bare = t.replace(/^有效期\s*/u, '').trim();
      if (/^(0|不说|长期|永久)$/u.test(bare)) return 0;
      const m = /^(\d+)\s*天?$/u.exec(bare);
      return m ? Number(m[1]) : null;
    }
    function ttlInfo(ttl, date) {
      const t = decodeEntities(ttl).trim();
      if (t === '') {
        return { label: '默认期限', title: '没写有效期 —— 各桌按公告插件的默认天数算（默认 14 天，可能被改过）', unknown: true };
      }
      const days = ttlDaysOf(t);
      if (days === null) {
        return { label: t.replace(/^有效期\s*/u, ''), title: `各桌认不出「${t}」这个写法，会按公告插件的默认天数算（默认 14 天）`, unknown: true };
      }
      if (days === 0) return { label: '长期', title: t === '长期' ? '有效期：长期' : `有效期：长期（文件里写的是「${t}」）` };
      const start = parseDay(date);
      if (start === null) return { label: `${days} 天`, title: `有效期：${t}`, timed: true };
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
      const left = Math.round((end.getTime() - today0().getTime()) / DAY);
      if (left < 0) return { label: '已过期', title: `有效期 ${days} 天，${fmtMD(end)} 已到期`, expired: true };
      return { label: `${days} 天`, title: `有效期 ${days} 天 · 到 ${fmtMD(end)}（还剩 ${left} 天）`, timed: true };
    }

    /* ── 删除记录里的一条（只用于显示）──────────────────────────────── */

    /**
     * 删除记录里的时间 `at` → `Date`。
     *
     * ⚠️ **后端写的是 UTC，而且没标时区**：`new Date().toISOString().replace('T', ' ').slice(0, 19)`
     * ⇒ 北京时间 10-02 01:03 删的，记录里写的是 `2026-10-01 17:03:50`。
     * ⇒ 所以**没带时区的一律按 UTC 解析**，界面上显示成本地时间（悬停能看到记录里的原文）。
     * 以后后端要是改成带时区（`Z` / `+08:00`），这里照它自己的来，不用跟着改。
     * 认不出 ⇒ `null`（界面原样显示那段字，不猜）。
     */
    function parseAt(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/u.exec(str(s).trim());
      if (!m) return null;
      let zone = 'Z';
      if (m[7] && m[7] !== 'Z') zone = m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7];
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${zone}`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const fmtYMD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    /** 一个本地日期 → 分组标题（和公告页的「今天 · 10-01」同一种说法）。 */
    function dateLabel(d) {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.round((today0().getTime() - day.getTime()) / DAY);
      if (diff === 0) return `今天 · ${fmtMD(d)}`;
      if (diff === 1) return `昨天 · ${fmtMD(d)}`;
      return d.getFullYear() === today0().getFullYear() ? fmtMD(d) : fmtYMD(d);
    }

    /**
     * **旧版**后端记删除时只存原文的前 120 个字（`raw.slice(0, 120)`），读回来时整行又 `trim()` 过一次 ——
     * 截口正好落在空格上时，读回来的就只有 119（甚至 118）个字。⇒ 到 118 就当"可能被截过"。
     *
     * ⚠️⚠️ **只对旧记录这么猜**（0.3.25 改的）。后端从 0.3.24 起**存整行**，同时时间改成了"本地时间 + 偏移" ——
     * **记录的时间带不带偏移，正好就是"新记录还是旧记录"的判据**。
     * 原来不分新旧：一条 120 多字的公告删掉以后，新记录明明是完整的，也会被标"可能被截过"、而且不显示"原定"。
     * （后端那段注释说"这个标记对新的记录不会再出现"—— 不分新旧的话，其实会。）
     */
    const RAW_KEEP = 120;
    const hasZone = (at) => /(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(str(at).trim());
    const mayBeCut = (raw, legacy) => legacy && str(raw).length >= RAW_KEEP - 2;

    /**
     * 被删的那一行 → 显示用的字段。**只用于显示**：不拿去比对、不拿去写。
     *
     * 口径照后端 `parseAnnouncements`：`- MM-DD｜发布者｜一句话｜详见｜有效期`，中间多出来的段都归「一句话」。
     * ⚠️ 但记录里的原文**最多 120 个字** ⇒ 长公告会被截掉尾巴：
     * - 段数不够时不硬拆：日期、发布者照拿，剩下的整段当「一句话」，标上 `partial`；
     * - **段数够、但可能被截过时，最后一段（有效期）不能信** —— 截口可能正好落在它中间：
     *   `14 天` 截成 `1` 就成了"原定 1 天"（复查时实测到的）。⇒ 这时有效期当"不知道"，不显示。
     * 连日期都认不出 ⇒ 整行原样当「一句话」（`raw: true`，界面用等宽字原样显示）。
     */
    function parseDeletedLine(rawLine, legacy = true) {
      const line = str(rawLine).trim();
      const cut = mayBeCut(line, legacy);
      const m = /^-\s*(\d{2}-\d{2})｜(.*)$/u.exec(line);
      if (!m) return { date: '', publisher: '', summary: line, source: '', ttl: '', partial: true, raw: true, cut };
      const parts = m[2].split('｜').map((x) => x.trim());
      if (parts.length >= 4) {
        return {
          date: m[1], publisher: parts[0], summary: parts.slice(1, parts.length - 2).join('｜'),
          source: parts[parts.length - 2], ttl: cut ? '' : parts[parts.length - 1], partial: false, raw: false, cut,
        };
      }
      return { date: m[1], publisher: parts[0], summary: parts.slice(1).join('｜'), source: '', ttl: '', partial: true, raw: false, cut };
    }

    /**
     * 被删的那一行 → 搜索用的一串字。**只用那一行自己的字段**，和公告页的搜索（`AnnounceView` 里的 `hay`）同一个口径 ——
     * 公告页搜不到、跳过来能搜到的，必须是"同一个词在同一种字段里"。
     *
     * ⚠️ 0.3.22 发出去之前复查抓到的：原来这里还拼了记录的时间（`2026-10-01 09:03:50`）——
     * **"02""20""01"这种词会命中每一条**（年份里就有），公告页搜「02」桌，会说"删除记录里还有 7 条匹配"。
     */
    function deletedLineHay(row, deskNames) {
      const f = row.f;
      return `${f.date} ${f.publisher} ${deskNameOf(deskNames, f.publisher)} ${stripMd(f.summary)} ${stripMd(f.source)} ${f.ttl}`.toLowerCase();
    }

    /* ── 桌 ─────────────────────────────────────────────────────────── */
    const isOwner = (name) => /^(用户|我|主人)$/u.test(str(name).trim());
    function deskTag(name) {
      const s = stripMd(name);
      const num = /(\d{1,3})/u.exec(s);
      if (num) return num[1];
      const lat = /^[A-Za-z]{2}/u.exec(s);
      if (lat) return lat[0][0].toUpperCase() + lat[0][1].toLowerCase();
      return s.slice(0, 1) || '·';
    }
    function avatar(name) {
      if (isOwner(name)) return h('span', { className: 'oap-av is-owner', 'aria-hidden': 'true' }, icon('user', 12));
      return h('span', { className: 'oap-av', 'aria-hidden': 'true' }, deskTag(name));
    }
    /** `桌 02（环境维护）· 02-环境维护` → { num: '02', name: '环境维护', rest: '· 02-环境维护' }。 */
    function parseDesk(text) {
      const m = /^桌\s*(\d{1,3})\s*(?:[（(]([^）)]*)[）)])?\s*(.*)$/u.exec(stripMd(text));
      return m ? { num: m[1], name: m[2] || '', rest: m[3] || '' } : null;
    }
    /** 从投递状态里认出「桌号 → 桌名」，公告里就能显示「[02] 环境维护」。 */
    function deskNamesFrom(md) {
      const map = {};
      const re = /桌\s*(\d{1,3})\s*[（(]([^）)\n|]{1,24})[）)]/gu;
      let m;
      while ((m = re.exec(str(md))) !== null) {
        const k = String(Number(m[1]));
        if (!(k in map)) map[k] = m[2].trim();
      }
      return map;
    }
    function deskNameOf(names, publisher) {
      const m = /(\d{1,3})/u.exec(str(publisher));
      return m ? names[String(Number(m[1]))] || '' : '';
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 数据
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 把接口返回的东西整理成"一定有这些字段"的样子 —— 渲染层就不用到处判空，
     * 字段缺了也不会抛错把卡片搞空白。字段名照接口原样，一个没改。
     * `canWrite`：true / false 照抄；没给就是 null（= 不知道，写入口照常显示）。
     */
    /**
     * ## ⚠️⚠️⚠️ **这个函数是个白名单 —— 而后端加字段时我忘了加进来**
     * （2026-10-01 踩到：代价是查了一整个下午，而且**方向全错**）
     *
     * ### 失败现场
     *
     * 后端在响应里加了 `seenBy`（每条公告"有几个会话见过"）。
     * 我**查了三轮后端**（读域 → 判据 → 字段名），**每一轮都真找出一个 bug 并修掉**，
     * 而**界面上、以及删除确认框里，永远是 0。**
     *
     * **根因在这儿**：下面 `map` 出来的是一个**新对象**，只有列出来的那几个键。
     * **`seenBy` 根本不在里面** ⇒ 前端拿到的 `e.seenBy` 是 `undefined`
     * ⇒ `Number.isFinite(undefined)` 为 false ⇒ **显示 0。**
     *
     * ### ⚠️ 同一个原因还制造了另外两个"谜"
     *
     * | 现象 | 真因 |
     * |---|---|
     * | 页脚不显示版本徽章 | `panelVersion` **没在返回值里** ⇒ 条件 `typeof … === 'string'` 为 false |
     * | `seenByFiltered` 永远读不到 | 同上 |
     * | ✅ 而"星号渲染"那个修复**生效了** | 它改的是 **`summary`** —— **在名单里** |
     * | ✅ 而标签上的 `·b4` **显示出来了** | 它是 `registerTab` 的参数，**不走这个函数** |
     *
     * **⇒ 四个现象、一个原因。** 而我查了后端三次，**从没看过这个函数** ——
     * 因为它"看起来只是个清洗"。
     *
     * ### 教训
     *
     * > **"清洗 / 归一化 / normalize" 这类函数是**隐蔽的白名单**：
     * > 它不报错，只是**安静地把新字段扔掉**。**
     * >
     * > **⇒ 后端加字段时，必须问一句"前端那个 normalize 认它吗"。**
     * > **⇒ 而更根本的做法：别用白名单，用"透传 + 只补默认值"** ——
     * > 那样后端以后加字段**自动就能过去**，不用每次回来改这里。
     *
     * ⚠️ **而测试也帮不上忙**：我那些断言**全在后端那一侧**（接口返回什么），
     * **没有一条走"接口 → normalizeData → 组件"这条路**。
     */
    function normalizeData(raw) {
      const d = raw && typeof raw === 'object' ? raw : {};
      const announce = d.announce && typeof d.announce === 'object' ? d.announce : {};
      const status = d.status && typeof d.status === 'object' ? d.status : {};
      const paths = d.paths && typeof d.paths === 'object' ? d.paths : {};
      const list = Array.isArray(announce.entries) ? announce.entries : [];
      /** ⭐ **先透传原文，再规整** —— 见上面那段教训。 */
      const entries = list.filter((e) => e && typeof e === 'object').map((e) => ({
        ...e,
        date: str(e.date),
        publisher: str(e.publisher),
        summary: str(e.summary),
        source: str(e.source),
        ttl: str(e.ttl),
        raw: typeof e.raw === 'string' ? e.raw : '',
        id: typeof e.id === 'string' ? e.id : '',
        /** ⭐ **就是它**（`undefined` 会让确认框显示"没有任何会话见过"）。 */
        /**
         * ⚠️⚠️ **`null` 要留着**（2026-10-01 又一次纠正 —— **这是同一个 bug 的第四个化身**）
         *
         * 原来写的是 `Number.isFinite(e.seenBy) ? e.seenBy : 0` ——
         * 而 `Number.isFinite(null)` 是 `false` ⇒ **"问不到"又被压成 `0`** ⇒
         * 界面显示"**没有任何会话的「见过」记录里有这条**"，
         * 而那句读起来是"**没人在意，放心删**"。
         *
         * **⇒ 三档必须原样传下去：`≥1` / `0` / `null`。**
         *
         * ### ⚠️ 这个"补默认值"的形状今天出现了四次（值得单独记一条）
         *
         * | # | 在哪 | 怎么把"不知道"变成"知道"的 |
         * |---|---|---|
         * | 1 | 老 `normalizeData` | **白名单里根本没这个键** ⇒ `undefined` |
         * | 2 | 后端 `readPayload` | `asked.seen[e.id] ?? 0` |
         * | 3 | `ConfirmDelete` 里那行 | `Number.isFinite(…) ? … : 0` |
         * | 4 | **就是这里** | 同一个写法 |
         *
         * **⇒ 全是"给缺失补一个看起来正常的默认值"。**
         * **⇒ 而"默认值"和"真实值"长得一样时，这个 bug 就不可见了。**
         */
        seenBy: (typeof e.seenBy === 'number' && Number.isFinite(e.seenBy)) ? e.seenBy : null,
      }));
      const malformed = (Array.isArray(announce.malformed) ? announce.malformed : []).map((x) => (
        x && typeof x === 'object' ? str(x.raw || x.line || x.text || JSON.stringify(x)) : str(x)));
      /**
       * ⚠️⚠️ **顶层、`announce`、`status` 这三层原来还是白名单**（0.3.22 改成透传 —— 和 `entries` 同一个教训）。
       *
       * `entries` 那一层修过了（`...e`），**而外面这三层没修** ⇒ 当时就已经在吃字段：
       * **`seenSessions`（接口清单里写着"排查用"）、`announce.noise` 一直到不了界面。**
       * ⇒ 现在每一层都**先 `...` 透传，再规整认识的键**；后端以后加字段，不用回来改这里。
       *
       * ⚠️ 规整时**不把"不知道"补成"看起来正常的值"**：
       * - `seenSessions`：数字照抄；没有 / 不是数 ⇒ `null`（**不是 0**）
       * - `seenByFiltered`：`true` / `false` 照抄；**没给 ⇒ `null`**（原来是"没给就当 true" ——
       *   那等于替后端说了"数字已经滤过了"）。用的地方只认 `=== false`，所以 `null` 不会多出一句提示。
       */
      return {
        ...d,
        readAt: typeof d.readAt === 'number' ? d.readAt : Date.now(),
        canWrite: typeof d.canWrite === 'boolean' ? d.canWrite : null,
        /**
         * ⭐⭐ **这两个必须显式带出来** —— 它们是顶层字段，
         * 而**这个返回对象原来是个白名单**，所以它们被安静地丢掉了
         * （症状：页脚永远不显示版本徽章）。
         */
        panelVersion: str(d.panelVersion),
        /**
         * ⭐ **盘上 `client.js` 里的那个常量**（后端**现读**报上来的，2026-10-04 加）。
         * ⚠️ **必须显式列在这里** —— 这个返回对象是**白名单**，漏一个键就会安静地丢掉
         * （症状：那块"一致吗"只能靠猜，正是它要解决的问题 ✗）。
         */
        clientFileVersion: str(d.clientFileVersion),
        seenByFiltered: typeof d.seenByFiltered === 'boolean' ? d.seenByFiltered : null,
        seenSessions: (typeof d.seenSessions === 'number' && Number.isFinite(d.seenSessions)) ? d.seenSessions : null,
        paths: { ...paths, announce: str(paths.announce), status: str(paths.status) },
        announce: {
          ...announce,
          revision: announce.revision === undefined || announce.revision === '' ? null : announce.revision,
          exists: announce.exists !== false,
          count: typeof announce.count === 'number' ? announce.count : entries.length,
          malformed,
          entries,
        },
        status: {
          ...status,
          exists: status.exists !== false,
          markdown: typeof status.markdown === 'string' ? status.markdown : '',
        },
      };
    }

    /**
     * ## ⭐ 归一化「删除记录」的响应（2026-10-01 加）
     *
     * ### ⚠️ 它和 `normalizeData` 遵守同一条纪律
     *
     * 那个函数的教训（`docs\06` 二.7）：**白名单会把后端新加的字段安静地扔掉。**
     * **⇒ 这里同样"先透传、再规整"，而且不认识的键原样留着。**
     *
     * ### 三档要分得开（和 `seenBy` 同一个道理）
     *
     * | 值 | 意思 |
     * |---|---|
     * | `null`（**这个函数不返回它** —— 那是调用方在"请求失败"时写的） | **问不到** |
     * | `{ exists: false }` | **问到了，但还没删过** |
     * | `{ exists: true, entries: [] }` | 文件在，但里面没有条目（被人手清过？） |
     *
     * ⚠️ **`entries` 里每一项都把 `raw` 原样带着** —— 界面要能显示"删掉的是哪一行"。
     */
    function normalizeDeletions(raw) {
      const d = raw && typeof raw === 'object' ? raw : {};
      const list = Array.isArray(d.entries) ? d.entries : [];
      return {
        ...d,
        exists: d.exists === true,
        path: str(d.path),
        total: typeof d.total === 'number' ? d.total : list.length,
        /** ⚠️ **`seenBy` 可能是 `null`**（"当时没问出来"）—— 那个和 `0` 不是一回事。 */
        entries: list.filter((e) => e && typeof e === 'object').map((e) => ({
          ...e,
          at: str(e.at),
          raw: str(e.raw),
          seenBy: (typeof e.seenBy === 'number' && Number.isFinite(e.seenBy)) ? e.seenBy : null,
        })),
      };
    }

    /**
     * 写接口。返回 `{ kind, status, body }`：
     *   ok          —— `{ ok: true }`
     *   rejected    —— `{ ok: false, code, message }`（stale / not-found / invalid …）
     *   unavailable —— 接口还不存在（404/405/501、返回的不是约定的 JSON、根本连不上）
     *   error       —— 其它（比如 500 且没有约定的 JSON）
     * 永远不抛错。
     */
    const KNOWN_CODES = ['stale', 'not-found', 'invalid'];
    async function postJSON(url, payload) {
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (_) {
        return { kind: 'unavailable', status: 0, body: null };
      }
      let body = null;
      try { body = JSON.parse(await r.text()); } catch (_) { body = null; }
      const missing = r.status === 404 || r.status === 405 || r.status === 501;
      if (body && typeof body === 'object' && typeof body.ok === 'boolean') {
        // 接口没上线时，宿主的通用 404 也可能回 { ok:false, … } —— 不是约定里的错误码，就当「还没上线」
        if (!body.ok && missing && !KNOWN_CODES.includes(body.code)) return { kind: 'unavailable', status: r.status, body: null };
        return { kind: body.ok ? 'ok' : 'rejected', status: r.status, body };
      }
      if (r.ok || missing) {
        return { kind: 'unavailable', status: r.status, body: null };
      }
      return { kind: 'error', status: r.status, body: null };
    }

    /** 写失败 → 给人看的一句话。 */
    function explainWrite(res) {
      const body = res.body && typeof res.body === 'object' ? res.body : {};
      const msg = str(body.message).trim().replace(/[。.！!]+$/u, '');
      if (res.kind === 'unavailable') {
        return {
          tone: 'warn',
          title: '该功能尚未上线',
          detail: `写公告的接口还没接上（${res.status ? `HTTP ${res.status}` : '连不上'}）。你写的内容先留在这里，接口好了再点一次就行。`,
        };
      }
      if (res.status === 403) {
        return {
          tone: 'warn',
          title: '现在不能写',
          detail: `${msg ? `${msg}。` : ''}点「刷新」看看面板是不是变成只读了，写好的内容先留着。`,
          action: 'refresh',
        };
      }
      if (res.kind === 'rejected') {
        if (body.code === 'stale') {
          return {
            tone: 'warn',
            title: '文件变了，刷新一下',
            detail: '公告文件刚被别处改过，这次没有写进去。点「刷新」拿到最新版本，再提交一次。',
            action: 'refresh',
          };
        }
        if (body.code === 'not-found') {
          return {
            tone: 'error',
            title: msg || '找不到那一行（可能已被删除）',
            detail: '原来那一行在文件里已经变了。关掉这个窗口，对最新的内容重新编辑。',
            blocked: true,
          };
        }
        if (body.code === 'invalid') return { tone: 'error', title: '内容不符合格式', detail: msg || '检查一下再提交。' };
        return { tone: 'error', title: msg || `被拒绝了（${str(body.code) || `HTTP ${res.status}`}）`, detail: '' };
      }
      return { tone: 'error', title: `出错了（HTTP ${res.status}）`, detail: '稍后再试一次。' };
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_) { /* 走下面的兜底 */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }

    /** 记住上次停在哪个分栏（存不了就算了）。 */
    const VIEW_KEY = 'dsh-bulletin-panel:view';
    const VIEWS = ['announce', 'dispatch', 'health'];
    function readView() {
      try {
        const v = window.localStorage.getItem(VIEW_KEY);
        return VIEWS.includes(v) ? v : 'announce';
      } catch (_) { return 'announce'; }
    }
    function saveView(v) {
      try { window.localStorage.setItem(VIEW_KEY, v); } catch (_) { /* 忽略 */ }
    }

    /**
     * 折叠：默认收到几行；**真的放不下**才出现「展开」（量出来的，不靠字数猜；侧栏宽度变了会重新量）。
     */
    function useClamp(text) {
      const ref = useRef(null);
      const [open, setOpen] = useState(false);
      const [over, setOver] = useState(false);
      useEffect(() => {
        const el = ref.current;
        if (el === null || open) return undefined;
        const check = () => {
          const next = el.scrollHeight - el.clientHeight > 1;
          setOver((prev) => (prev === next ? prev : next));
        };
        check();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(check);
        ro.observe(el);
        return () => ro.disconnect();
      }, [open, text]);
      return { ref, open, setOpen, canToggle: open || over };
    }

    /** 量面板宽度：≥ 900 两列（is-wide），≤ 420 紧凑（is-narrow）。用 JS 量，不给根节点加尺寸约束。 */
    function useWidthMode(ref) {
      const [mode, setMode] = useState('');
      useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const update = () => {
          const w = el.clientWidth;
          let next = '';
          if (w >= 900) next = 'wide';
          else if (w > 0 && w <= 420) next = 'narrow';
          setMode((prev) => (prev === next ? prev : next));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
      }, [ref]);
      return mode;
    }

    /**
     * 数据层：只 fetch 那一个只读路由。
     *   - 卡片可见、且窗口没被最小化时，每 20 秒刷一次；看不见就停，回来先立刻刷一次。
     *   - 自动刷新撞上还没回来的请求就跳过；手动刷新会顶掉旧请求。
     *   - `reload()` 返回整理好的数据（失败返回 null），写接口 409 后刷新要用到。
     */
    function useOfficeData(visible) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const [loading, setLoading] = useState(false);
      const [loadedAt, setLoadedAt] = useState(0);
      /** ⭐ **删除记录**（2026-10-01 加）。`null` = **问不到**（不是"没删过"）。 */
      const [deletions, setDeletions] = useState(null);
      /**
       * ⚠️ **还没问过 ≠ 问不到**（0.3.22 加）。`deletions` 一开始就是 `null`，而主数据先到、删除记录后到 ——
       * 原来那一小段时间里，健康页会说"问不到删除记录接口"。⇒ 第一次有结果（成功或真的失败）之前，界面说"正在读"。
       * （单独一个布尔，而不是给 `deletions` 再加一种值：`null` 的意思一个字都不改。）
       */
      const [delAsked, setDelAsked] = useState(false);
      const [pageHidden, setPageHidden] = useState(() => document.visibilityState === 'hidden');
      const alive = useRef(true);
      const inflight = useRef(null);
      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          if (inflight.current) inflight.current.abort();
        };
      }, []);
      const load = useCallback(async (opts) => {
        const manual = Boolean(opts && opts.manual);
        if (inflight.current !== null && !manual) return null;
        if (inflight.current !== null) inflight.current.abort();
        const ctl = new AbortController();
        inflight.current = ctl;
        const started = Date.now();
        setLoading(true);
        if (manual) setBusy(true);
        try {
          const r = await fetch('/sidebar/api/office', { cache: 'no-store', signal: ctl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const next = normalizeData(await r.json());
          if (alive.current && !ctl.signal.aborted) {
            setData(next);
            setErr(null);
            setLoadedAt(Date.now());
          }
          /**
           * ⭐ **顺带取删除记录**（2026-10-01 加）。
           *
           * ⚠️ **它是第二个请求，而不是并进 `/api/office`** —— 理由：
           * 那个接口是**公告和投递的核心数据**，而删除记录是**健康页的附属信息**。
           * **⇒ 附属信息出问题（文件被删、接口没上线）不该让主数据也读不出来。**
           *
           * ⚠️ **失败一律写成 `null`（"问不到"），不是空数组** ——
           * "问不到"和"没删过"在界面上是两句话（见 `HealthView` 里那段）。
           */
          /**
           * ⚠️ **被顶掉的请求不算"问不到"**（0.3.22 改的）。
           *
           * 原来这里任何异常都写 `null` —— 包括 `AbortError`：自动刷新还没回来时点一下「刷新」，
           * 旧请求被 abort ⇒ 删除记录**闪一下"问不到"**，等新请求回来才恢复。
           * ⇒ 被 abort（手动刷新顶掉 / 卡片收起 / 卸载）⇒ **这次不算数，留着上一次的**；
           *   真的没应答（非 2xx、不是 JSON、`ok: false`、连不上）⇒ 才写 `null`。
           */
          try {
            const dr = await fetch('/sidebar/api/office/deletions', { cache: 'no-store', signal: ctl.signal });
            const body = dr.ok ? await dr.json() : null;
            const nextDel = body && typeof body === 'object' && body.ok !== false ? normalizeDeletions(body) : null;
            if (alive.current && !ctl.signal.aborted) { setDeletions(nextDel); setDelAsked(true); }
          } catch (error) {
            const aborted = (error && error.name === 'AbortError') || ctl.signal.aborted;
            if (alive.current && !aborted) { setDeletions(null); setDelAsked(true); }
          }
          return next;
        } catch (error) {
          if (error && error.name === 'AbortError') return null;
          if (alive.current) setErr(str(error && error.message ? error.message : error));
          return null;
        } finally {
          if (inflight.current === ctl) {
            inflight.current = null;
            if (alive.current) setLoading(false);
          }
          if (manual) {
            // 手动刷新时让转圈至少转一小会儿，不然看不出刷过了
            const wait = 450 - (Date.now() - started);
            if (wait > 0) await new Promise((res) => { setTimeout(res, wait); });
            if (alive.current) setBusy(false);
          }
        }
      }, []);
      useEffect(() => {
        const onVis = () => setPageHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
      }, []);
      const active = visible && !pageHidden;
      useEffect(() => {
        if (!active) {
          if (inflight.current) inflight.current.abort();
          return undefined;
        }
        void load();
        const t = setInterval(() => { void load(); }, 20000);
        return () => clearInterval(t);
      }, [active, load]);
      return { data, err, busy, loading, loadedAt, active, reload: load, patch: setData, deletions, delAsked };
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 共用的小控件
     * ═══════════════════════════════════════════════════════════════════ */

    /** 搜索框：Esc 清空，右边有清空按钮。 */
    function SearchBox({ value, onChange, placeholder }) {
      return h('label', { className: 'oap-search' },
        icon('search', 14),
        h('input', {
          type: 'search', value, placeholder, 'aria-label': placeholder,
          onChange: (ev) => onChange(ev.target.value),
          onKeyDown: (ev) => { if (ev.key === 'Escape' && value) { ev.stopPropagation(); onChange(''); } },
        }),
        value
          ? h('button', { type: 'button', className: 'oap-search-x', onClick: () => onChange(''), title: '清空', 'aria-label': '清空搜索' }, icon('x', 11))
          : null);
    }

    function EmptyState({ ic, title, children, action }) {
      return h('div', { className: 'oap-empty' },
        h('div', { className: 'oap-empty-ic' }, icon(ic || 'inbox', 18)),
        h('div', { className: 'oap-empty-t' }, title),
        children,
        action || null);
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 投递状态那份 markdown：拆成分节，再分给「投递」和「健康」两个分栏
     * 分节是稳定的（待取 / 已被取走 / 最近的取走记录 / 认过桌的会话 / 健康），
     * 但这里按通用规则拆：认不出的分节、认不出的表格，照样显示，不丢。
     * ═══════════════════════════════════════════════════════════════════ */

    /** `待取的单子（0）` → { name: '待取的单子', inner: '0' }。 */
    function splitParen(text) {
      const s = str(text).trim();
      const m = /^(.*?)\s*[（(]([^（）()]*)[）)]\s*$/u.exec(s);
      if (!m || m[1] === '') return { name: s, inner: '' };
      return { name: m[1].trim(), inner: m[2].trim() };
    }

    function parseStatus(md) {
      const out = { title: '', note: '', pre: [], sections: [], foot: [] };
      let cur = null;
      let foot = null;
      str(md).split(/\r?\n/u).forEach((line) => {
        const t = line.trim();
        let m = /^#{2,}\s+(.*)$/u.exec(t);
        if (m) {
          if (foot !== null && cur !== null) cur.lines.push('---', ...foot);
          foot = null;
          const p = splitParen(m[1]);
          const isNum = /^\d+$/u.test(p.inner);
          cur = {
            key: `${out.sections.length}-${p.name}`,
            name: p.name,
            count: isNum ? Number(p.inner) : null,
            hint: isNum ? '' : p.inner,
            lines: [],
          };
          out.sections.push(cur);
          return;
        }
        if (foot !== null) { foot.push(line); return; }
        m = /^#\s+(.*)$/u.exec(t);
        if (m && cur === null && out.title === '') {
          const p = splitParen(m[1]);
          out.title = p.name;
          out.note = p.inner;
          return;
        }
        // 最后一个分节之后的 `---` 以下是脚注
        if (cur !== null && /^(-{3,}|\*{3,}|_{3,})$/u.test(t)) { foot = []; return; }
        if (cur !== null) cur.lines.push(line);
        else out.pre.push(line);
      });
      if (foot !== null) out.foot = foot;
      return out;
    }

    /** 一个分节的正文 → 块：表格 / 列表 / 段落 / 引用 / 分隔线 / 小标题。 */
    function parseBlocks(lines) {
      const blocks = [];
      let table = null;
      let list = null;
      const flush = () => {
        if (table !== null) {
          const head = table[0];
          const rows = table.slice(1).filter((r) => !r.every((c) => /^:?-{2,}:?$/u.test(c)));
          blocks.push({ type: 'table', head, rows });
          table = null;
        }
        if (list !== null) { blocks.push({ type: 'list', items: list }); list = null; }
      };
      lines.forEach((line) => {
        const t = line.trim();
        if (t.startsWith('|')) {
          if (list !== null) flush();
          (table || (table = [])).push(splitRow(t));
          return;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/u.test(t)) { flush(); blocks.push({ type: 'hr' }); return; }
        const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(t);
        if (li) {
          if (table !== null) flush();
          (list || (list = [])).push(li[1]);
          return;
        }
        flush();
        if (t === '') return;
        if (t.startsWith('>')) { blocks.push({ type: 'quote', text: t.replace(/^>\s?/u, '') }); return; }
        const hd = /^#{1,6}\s+(.*)$/u.exec(t);
        if (hd) { blocks.push({ type: 'h', text: hd[1] }); return; }
        blocks.push({ type: 'p', text: t });
      });
      flush();
      return blocks;
    }

    /** 认出几个固定分节；认不出的放进 extras。 */
    function pickSections(parsed) {
      const find = (re) => parsed.sections.find((s) => re.test(s.name)) || null;
      const pending = find(/待取/u);
      const taken = find(/已被取走|已取走/u);
      const recent = find(/取走记录/u);
      const sessions = find(/认过桌|认桌/u);
      const health = find(/健康|运行信息/u);
      const known = [pending, taken, recent, sessions, health].filter(Boolean);
      return { pending, taken, recent, sessions, health, extras: parsed.sections.filter((s) => !known.includes(s)) };
    }

    /** 分节的条数：优先用标题里的数字，没有就数表格行；分节不存在 → null。 */
    function countOf(s) {
      if (!s) return null;
      if (s.count !== null) return s.count;
      const t = parseBlocks(s.lines).find((b) => b.type === 'table');
      return t ? t.rows.length : null;
    }

    /**
     * 状态文件开头那行「生成时间 … ｜ 插件 … ｜ 存储 …」→ [{ k, v }]（和数字重复的「待取 / 已取」去掉）。
     *
     * ⚠️ **分隔符两种都认：半角 `|` 和全角 `｜`**（0.3.22 改的）。
     * 投递插件（`f3-status.js`）现在写的是**全角** —— 而这里原来只认半角 ⇒ 那一行一直没被拆开：
     * 投递页把它当一段原文摆着（「待取 2 · 已取 3」还折到第二行），提示条里的「生成于 …」从来没出现过，
     * 「文件信息」里也少了插件和存储那几项。
     */
    const FACT_BAR = /[|｜]/u;
    function factsOf(parsed) {
      const out = [];
      parsed.pre.forEach((line) => {
        const t = line.trim().replace(/^>\s?/u, '');
        if (t === '' || !FACT_BAR.test(t) || t.startsWith('|')) return;
        t.split(FACT_BAR).map((x) => x.trim()).filter(Boolean).forEach((x) => {
          if (/^(待取|已取)/u.test(stripMd(x))) return;
          const m = /^(\S+?)\s+([\s\S]+)$/u.exec(x);
          out.push(m ? { k: stripMd(m[1]), v: m[2] } : { k: '', v: x });
        });
      });
      return out;
    }
    /** 开头里不是「a | b | c」那种的行（一般没有）：原样显示，不丢。 */
    function preLinesOf(parsed) {
      return parsed.pre.map((l) => l.trim().replace(/^>\s?/u, '')).filter((t) => t !== '' && !(FACT_BAR.test(t) && !t.startsWith('|')));
    }

    /** 按表头认出每一列是干什么的（认不出的列照样显示成「列名 值」）。 */
    function columnRoles(head) {
      const names = head.map((c) => stripMd(c));
      const find = (re, skip) => names.findIndex((n, i) => re.test(n) && !(skip || []).includes(i));
      const time = find(/时间|什么时候|时候|日期/u);
      const id = find(/单号|编号|会话号|^id$/iu, [time]);
      let text = find(/一句话|摘要|内容|说明/u, [time, id]);
      if (text < 0) text = find(/标题/u, [time, id]);
      // 「谁投的 / 发起方」：状态文件里有这一列，标题行就画成「[04] → [02]」（现在的文件里没有，后端加了就自动显示）
      const from = find(/谁投|发起|来自|投单|发件|寄件|source/iu, [time, id, text]);
      // 「目标桌」：单子是投给哪张桌的 —— 标题行写明「投给」，免得被当成「谁投的」
      const target = find(/目标/u, [time, id, text, from]);
      const used = [time, id, text, from, target].filter((i) => i >= 0);
      const rest = names.map((_, i) => i).filter((i) => !used.includes(i));
      const lead = target >= 0 ? target : (rest.length > 0 ? rest[0] : -1);
      return { time, id, text, from, lead, isTarget: target >= 0, meta: rest.filter((i) => i !== lead) };
    }

    /** 列表项 `插件版本：**1.3.1**` → { k: '插件版本', v: '**1.3.1**' }。 */
    function splitKV(text) {
      const m = /^\s*(?:\*\*)?([^：:*`|]{1,14}?)(?:\*\*)?\s*[：:]\s*([\s\S]*)$/u.exec(str(text));
      return m ? { k: m[1].trim(), v: m[2] } : { k: '', v: str(text) };
    }

    /** 标题行里的桌：`桌 02（环境维护）` 显示成 [02] 环境维护。 */
    function deskChip(text, key) {
      const d = parseDesk(text);
      if (d === null) return h('span', { key, className: 'oap-row-who' }, renderInline(text, key));
      return h('span', { key, className: 'oap-desk-chip', title: stripMd(text) },
        h('span', { className: 'oap-av', 'aria-hidden': 'true' }, d.num),
        h('span', { className: 'oap-row-who' }, d.name || `桌 ${d.num}`,
          d.rest ? h('span', { className: 'oap-soft' }, ` ${d.rest}`) : null));
    }

    /**
     * 次要列里的桌（「谁取走的」「取走的会话」）：一律写全「[02] 桌名 · 会话」。
     * 桌号必须看得见 —— 以前和标题同一张桌时省成只剩会话名，读起来像「取走的 = 投单的」。
     */
    function deskMeta(text, key) {
      const d = parseDesk(text);
      if (d === null) return renderInline(text, key);
      const session = d.rest.replace(/^[·・•|｜,，:：\s-]+/u, '').trim();
      return h('span', { key, className: 'oap-desk-inline', title: stripMd(text) },
        h('span', { className: 'oap-av', 'aria-hidden': 'true' }, d.num),
        h('span', null, d.name || `桌 ${d.num}`, session ? ` · ${session}` : ''));
    }

    /** 表格的一行 → 一张小卡片。 */
    function RowCard({ head, cells, roles, hot }) {
      const cell = (i) => (i >= 0 && i < cells.length ? cells[i] : '');
      const text = cell(roles.text);
      const lead = cell(roles.lead);
      const time = cell(roles.time);
      const id = cell(roles.id);
      const from = cell(roles.from);
      const clamp = useClamp(text);
      const meta = roles.meta.filter((i) => cell(i) !== '');
      const compact = text !== '' && stripMd(text).length <= 28 && meta.length === 0;
      const hasTop = lead !== '' || from !== '' || time !== '' || compact;
      return h('div', { className: `oap-row${hot ? ' is-hot' : ''}` },
        hasTop ? h('div', { className: 'oap-row-top' },
          from !== '' ? deskChip(from, 'from') : null,
          from !== '' && lead !== '' ? h('span', { className: 'oap-row-arrow', title: '投给' }, icon('arrowRight', 13)) : null,
          from === '' && roles.isTarget && lead !== '' ? h('span', { className: 'oap-row-label' }, '投给') : null,
          lead !== '' ? deskChip(lead, 'lead') : null,
          compact ? h('span', { className: 'oap-row-inline' }, lead !== '' ? '· ' : '', renderInline(text, 'ti')) : null,
          time !== '' ? h('span', { className: 'oap-row-time' }, renderInline(time, 'tm')) : null) : null,
        text !== '' && !compact
          ? h('div', { ref: clamp.ref, className: `oap-row-text${clamp.open ? '' : ' oap-clamp is-2'}` }, renderInline(text, 'tx'))
          : null,
        meta.length > 0 || id !== '' || (clamp.canToggle && !compact)
          ? h('div', { className: 'oap-row-sub' },
            clamp.canToggle && !compact
              ? h('button', { type: 'button', className: 'oap-link', onClick: () => clamp.setOpen((v) => !v) }, clamp.open ? '收起' : '展开')
              : null,
            meta.map((i) => h('span', { key: i },
              h('span', { className: 'oap-kv-k' }, stripMd(head[i] || '')), deskMeta(cell(i), `m${i}`))),
            id !== '' ? h('span', { className: 'oap-id oap-mono', title: stripMd(id) }, renderInline(id, 'id')) : null)
          : null);
    }

    const rowMatches = (cells, q) => q === '' || stripMd(cells.join(' ')).toLowerCase().includes(q);

    /** 一张表：默认露前 6 行，其余「展开其余 N 条」（和左侧「展开其余 1 个会话」一个说法）；搜索时全部显示。 */
    function RowList({ head, rows, hot, query }) {
      const [all, setAll] = useState(false);
      const roles = useMemo(() => columnRoles(head), [head]);
      const q = str(query).trim().toLowerCase();
      if (rows.length === 0) return h('div', { className: 'oap-quiet' }, icon('info', 15), h('span', null, '（空）'));
      const list = rows.filter((cells) => rowMatches(cells, q));
      if (list.length === 0) return h('div', { className: 'oap-quiet' }, icon('search', 15), h('span', null, '没有匹配的条目'));
      const LIMIT = 6;
      const capped = q === '' && !all && list.length > LIMIT;
      const shown = capped ? list.slice(0, LIMIT) : list;
      const seen = {};
      return h(Fragment, null,
        h('div', { className: 'oap-grid' }, shown.map((cells, i) => {
          const idText = roles.id >= 0 ? stripMd(cells[roles.id] || '') : '';
          const base = idText !== '' ? `id:${idText}` : `i:${i}`;
          seen[base] = (seen[base] || 0) + 1;
          return h(RowCard, { key: `${base}#${seen[base]}`, head, cells, roles, hot });
        })),
        capped
          ? h('button', { type: 'button', className: 'oap-more', onClick: () => setAll(true) },
            icon('chevron', 13), `展开其余 ${list.length - LIMIT} 条`)
          : null,
        q === '' && all && list.length > LIMIT
          ? h('button', { type: 'button', className: 'oap-more', onClick: () => setAll(false) },
            icon('chevron', 13, 'oap-up'), '收起')
          : null);
    }

    function StatusBlock({ b, hot, query }) {
      if (b.type === 'table') return h(RowList, { head: b.head, rows: b.rows, hot, query });
      if (b.type === 'list') {
        return h('div', { className: 'oap-kvs' }, b.items.map((it, i) => {
          const kv = splitKV(it);
          if (kv.k === '') return h('div', { key: i, className: 'oap-kvr is-plain' }, h('span', { className: 'oap-kvr-v' }, renderInline(it, `kv${i}`)));
          return h('div', { key: i, className: 'oap-kvr' },
            h('span', { className: 'oap-kvr-k' }, kv.k),
            h('span', { className: `oap-kvr-v${isParenOnly(kv.v) ? ' oap-soft' : ''}` }, renderInline(kv.v, `kv${i}`)));
        }));
      }
      if (b.type === 'hr') return h('div', { className: 'oap-hr' });
      if (b.type === 'quote') return h('div', { className: 'oap-quote' }, renderInline(b.text, 'q'));
      if (b.type === 'h') return h('div', { className: 'oap-subh' }, renderInline(b.text, 'h'));
      if (isParenOnly(b.text)) {
        // 「（没有待取的单子。）」这种整句括起来的，当成空状态
        return h('div', { className: `oap-quiet${hot ? ' is-ok' : ''}` },
          icon(hot ? 'checkCircle' : 'info', 15),
          h('span', null, renderInline(stripMd(b.text).replace(/^[（(]|[）)]$/gu, ''), 'p')));
      }
      return h('p', { className: 'oap-p' }, renderInline(b.text, 'p'));
    }

    /** 一个分节的正文。 */
    function SectionBody({ s, hot, query }) {
      const blocks = useMemo(() => parseBlocks(s.lines), [s.lines]);
      if (blocks.length === 0) return h('div', { className: 'oap-quiet' }, icon('info', 15), h('span', null, '（这一节是空的）'));
      return h('div', { className: 'oap-stack' }, blocks.map((b, i) => h(StatusBlock, { key: i, b, hot, query })));
    }

    /** 可折叠的分节（标题行像左侧会话列表的分组）。 */
    function Section({ title, count, hint, defaultOpen, children }) {
      const [open, setOpen] = useState(Boolean(defaultOpen));
      return h('section', { className: `oap-sec${open ? '' : ' is-closed'}` },
        h('button', { type: 'button', className: 'oap-sec-h', onClick: () => setOpen((v) => !v), 'aria-expanded': open },
          icon('chevron', 14, 'oap-chev'),
          h('span', { className: 'oap-sec-name' }, title),
          count !== null && count !== undefined ? h('span', { className: 'oap-count' }, count) : null,
          hint ? h('span', { className: 'oap-sec-hint' }, hint) : null),
        open ? children : null);
    }

    /** 分节里（所有表格）有几行匹配搜索。 */
    function matchCount(s, q) {
      if (!s || q === '') return null;
      return parseBlocks(s.lines).filter((b) => b.type === 'table')
        .reduce((n, b) => n + b.rows.filter((cells) => rowMatches(cells, q)).length, 0);
    }

    function noStatusFile(data) {
      return h(EmptyState, { ic: 'inbox', title: '还没有投递状态文件' }, h('div', { className: 'oap-path oap-mono' }, data.paths.status));
    }

    /* ── 投递 ───────────────────────────────────────────────────────── */
    function DispatchView({ data, parsed, picked, seg, setSeg, query, setQuery }) {
      if (data.status.exists === false) return h('div', { className: 'oap-view' }, noStatusFile(data));
      if (parsed.sections.length === 0) return h('div', { className: 'oap-view oap-md' }, renderBlocks(data.status.markdown));
      const { pending, taken, recent, extras } = picked;
      const nPending = countOf(pending) || 0;
      const key = seg === 'pending' || seg === 'taken' ? seg : (nPending > 0 || !taken ? 'pending' : 'taken');
      const cur = key === 'pending' ? pending : taken;
      const q = query.trim().toLowerCase();
      const gen = factsOf(parsed).find((f) => /生成/u.test(f.k));
      const foot = parsed.foot.map((l) => l.trim().replace(/^>\s?/u, '')).filter((l) => l !== '');
      const segBtn = (k, label, s) => (s ? h('button', { type: 'button', 'aria-pressed': key === k, onClick: () => setSeg(k) },
        label, h('span', { className: `oap-seg-n${k === 'pending' && nPending > 0 ? ' is-hot' : ''}` }, countOf(s) ?? '—')) : null);
      const hintOf = (s) => (q !== '' ? `${matchCount(s, q)} 条匹配` : s.hint);
      return h('div', { className: 'oap-view' },
        h('div', { className: 'oap-toolbar' },
          pending || taken ? h('div', { className: 'oap-seg', role: 'group', 'aria-label': '投递状态' },
            segBtn('pending', '待取', pending), segBtn('taken', '已取走', taken)) : null,
          h(SearchBox, { value: query, onChange: setQuery, placeholder: '搜索桌号、单号或正文' })),
        /**
         * ⚠️ **`parsed.note` 必须过 `renderInline`**（2026-10-01 看截图发现的）。
         *
         * 状态表那一行是写成 markdown 的：
         * `插件自动生成 —— **不要手改，改了会被覆盖**`
         * ⇒ **不过 `renderInline` 就会原样显示星号。**
         *
         * ⚠️ 而**下一行 `preLinesOf` 是有 `renderInline` 的** ——
         * **⇒ 同一个视图里一处渲染、一处没渲染**，那是最容易被忽略的一种不一致。
         * （它只在"那一行恰好带 markdown"时才看得出来 —— 所以它活了很久。）
         */
        h('div', { className: 'oap-note' }, icon('lock', 13),
          h('span', null, renderInline(parsed.note || '插件自动生成，只读', 'note'),
            gen ? ` · 生成于 ${stripMd(gen.v)}` : '')),
        preLinesOf(parsed).map((t, i) => h('p', { key: `pre${i}`, className: 'oap-p' }, renderInline(t, `pre${i}`))),
        cur
          ? h(SectionBody, { key: cur.key, s: cur, hot: key === 'pending', query })
          : h('div', { className: 'oap-quiet' }, icon('info', 15), h('span', null, '状态文件里没有这一节')),
        recent ? h(Section, { title: recent.name, count: countOf(recent), hint: hintOf(recent), defaultOpen: false },
          h(SectionBody, { s: recent, query })) : null,
        extras.map((s) => h(Section, { key: s.key, title: s.name, count: s.count, hint: hintOf(s), defaultOpen: true },
          h(SectionBody, { s, query }))),
        foot.length > 0
          ? h('div', { className: 'oap-footnote' }, icon('info', 14),
            h('div', null, foot.map((l, i) => h('p', { key: i }, renderInline(l, `ft${i}`)))))
          : null);
    }

    /* ── 健康 ───────────────────────────────────────────────────────── */

    /** `0.3.21` 对 `0.3.22` → 负 / 0 / 正（只比数字段；前面的 `v`、后面的 `-beta` 之类不算；认不出的段当 0）。 */
    function cmpVer(a, b) {
      const parts = (v) => str(v).trim().replace(/^v/iu, '').split(/[-+]/u)[0].split('.').map((x) => parseInt(x, 10) || 0);
      const pa = parts(a);
      const pb = parts(b);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    }

    /**
     * 「删的那一刻有几个会话见过」→ 一颗小标签。
     *
     * ⚠️⚠️ **三档，不是两档**（和删除确认框同一个纪律 —— 接口清单第三节）：
     *
     * | 值 | 标签 | 意思 |
     * |---|---|---|
     * | `N ≥ 1` | 「N 个会话见过」 | 删除留下的"分歧"：它们没收到任何通知，上下文里可能还留着它 |
     * | `0` | 「没人见过」 | 问到了，确实没人见过 |
     * | **`null`** | **「当时没问出来」** | 记录里写的是 `—` —— **绝不显示成 0** |
     *
     * 判 `null` 用的是"不是数字"，不是 `=== null` —— 万一哪天传进来 `undefined`，也落在"没问出来"这一档，
     * 而不是掉进"0 人"。
     */
    function seenBadge(n) {
      if (typeof n !== 'number') {
        return h('span', { className: 'oap-seen is-unknown', title: '删的时候没问到「见过数」（公告插件的接口没应答）—— 这不代表没人见过' }, '当时没问出来');
      }
      if (n === 0) {
        return h('span', { className: 'oap-seen is-none', title: '删的那一刻，没有任何会话的「见过」记录里有这条' }, '没人见过');
      }
      return h('span', {
        className: 'oap-seen is-some',
        title: `删的那一刻，有 ${n} 个会话的「见过」记录里有这条 —— 它们没收到任何通知，上下文里可能还留着它`,
      }, `${n} 个会话见过`);
    }
    const seenClass = (n) => (typeof n !== 'number' ? 'is-unknown' : (n === 0 ? 'is-none' : 'is-some'));

    /**
     * ## ⭐⭐ **活着的公告**上那颗"见过数"标签（`Entry` 用）
     *
     * ### 为什么单独写一颗，不直接用 `seenBadge`
     *
     * ⚠️ **`seenBadge` 的文案是"删的那一刻"、"当时没问出来"** ——
     * **那是"删除记录"的语义**（记录下的是**删那一瞬间**的快照）。
     * 而**公告卡片上这条公告还活着** ⇒ 说"删的那一刻"是错的。
     *
     * ⇒ 同一个数字、**两种时间点**，所以要两套文案：
     *
     * | | 哪来的 | 时间点 |
     * |---|---|---|
     * | `seenBadge` | 删除记录文件里存的那一行 | **删的那一刻** |
     * | `memberBadge`（这一颗） | 面板接口现算的 `e.seenBy` | **现在** |
     *
     * ### 三档（和别处同一个纪律，**绝不用 0 冒充"不知道"**）
     *
     * | 值 | 标签 | 意思 |
     * |---|---|---|
     * | `N ≥ 1` | **「N 个会话见过」** | 这么多个会话的「见过」记录里有它 |
     * | `0` | **「还没人见过」** | 问到了，确实没有 |
     * | **`null`** | **「问不到见过数」** | 接口没应答 —— **绝不显示成 0** |
     *
     * ⚠️ 判 `null` 用"不是数字"（`typeof !== 'number'`），和 `seenBadge` 同一条纪律：
     * **万一哪天传进来 `undefined`，也落在"问不到"，而不是掉进"0 人"。**
     */
    function memberBadge(n) {
      if (typeof n !== 'number') {
        return h('span', {
          className: 'oap-seen is-unknown',
          title: '问不到「有几个会话见过它」（公告插件的接口没应答）—— 这不代表没人见过',
        }, '问不到见过数');
      }
      if (n === 0) {
        return h('span', {
          className: 'oap-seen is-none',
          title: '目前没有任何会话的「见过」记录里有这条',
        }, '还没人见过');
      }
      return h('span', {
        className: 'oap-seen is-some',
        title: `目前有 ${n} 个会话的「见过」记录里有这条`,
      }, `${n} 个会话见过`);
    }

    /** 被删那一行的有效期 → 「原定 …」后面那几个字（口径同 `ttlDaysOf`）。 */
    function ttlText(ttl) {
      const t = decodeEntities(ttl).trim();
      if (t === '') return '';
      const days = ttlDaysOf(t);
      if (days === 0) return '长期';
      return days === null ? t.replace(/^有效期\s*/u, '') : `${days} 天`;
    }

    /**
     * 删除记录里的一条：**谁的哪条公告、什么时候删的、删的那一刻有几个会话见过**。
     *
     * - 时间显示成**本地**的（记录里存的是 UTC，见 `parseAt`），悬停能看到记录里的原文
     * - 被删的那一行拆成「发布者 / 一句话 / 详见 / 有效期」显示；拆不开就原样显示，不猜
     * - 一句话默认收到两行，真放不下才出现「展开」（和别处同一个量法）
     * - 「复制原文」复制的是**记录里那一整行** —— 误删了想恢复，可以把它贴回公告文件末尾
     */
    function DeletionItem({ row, deskNames, onCopy }) {
      const f = row.f;
      const text = f.summary !== '' ? f.summary : str(row.raw);
      const clamp = useClamp(text);
      const cut = f.cut;
      const deskName = deskNameOf(deskNames, f.publisher);
      const when = row.when;
      const zoned = hasZone(row.at);
      const timeTitle = when
        ? `删于 ${fmtYMD(when)} ${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}（本地时间）`
          + ` · 记录里写的是 ${row.at}${zoned ? '' : '（UTC）'}`
        : `记录里的时间：${row.at || '（没有）'}`;
      const meta = [];
      if (f.date) meta.push(`发布于 ${f.date}`);
      const tt = ttlText(f.ttl);
      if (tt) meta.push(`原定 ${tt}`);
      if (f.source) meta.push(`详见 ${sourceLabel(f.source)}`);
      return h('div', { className: `oap-tl-item ${seenClass(row.seenBy)}`, role: 'listitem' },
        h('div', { className: 'oap-tl-head' },
          h('span', { className: 'oap-tl-time', title: timeTitle }, when ? fmtHM(when.getTime()) : (row.at || '—')),
          f.publisher ? avatar(f.publisher) : null,
          f.publisher
            ? h('span', { className: 'oap-tl-who', title: deskName ? `${f.publisher} · ${deskName}` : f.publisher }, deskName || f.publisher)
            : null,
          seenBadge(row.seenBy)),
        h('div', { ref: clamp.ref, className: `oap-tl-text${f.raw ? ' is-raw' : ''}${clamp.open ? '' : ' oap-clamp is-2'}` },
          f.raw ? text : renderInline(text, 'dt')),
        h('div', { className: 'oap-tl-meta' },
          meta.length > 0 ? h('span', { title: f.source ? decodeEntities(f.source) : undefined }, meta.join(' · ')) : null,
          cut
            ? h('span', {
              className: 'oap-tl-cut',
              title: '后端记删除时只存这一行的前 120 个字。这一条到了那个长度 —— 后面的（包括「详见」「有效期」）可能没记下来',
            }, '可能被截过（记录只存前 120 个字）')
            : null,
          f.partial && !cut ? h('span', null, '不是标准的公告格式，原样显示') : null,
          h('span', { className: 'oap-tl-acts' },
            clamp.canToggle
              ? h('button', {
                type: 'button', className: 'oap-link', 'aria-expanded': clamp.open, onClick: () => clamp.setOpen((v) => !v),
              }, clamp.open ? '收起' : '展开')
              : null,
            h('button', {
              type: 'button', className: 'oap-link', onClick: () => onCopy(str(row.raw)),
              title: cut
                ? '复制记录里的那一行（⚠️ 它可能被截过 —— 想贴回公告文件的话，先看看后面全不全，不然会变成一行"解析不了"的坏行）'
                : '复制被删掉的那一行原文（误删了想恢复，可以把它贴回公告文件末尾）',
            }, icon('copy', 12), h('span', null, '复制原文')))));
    }

    /**
     * ## ⭐ 删除记录 —— 一条时间线（0.3.22，接口清单第三、五节那几个问题的回答）
     *
     * | 那几个方向 | 怎么做的 |
     * |---|---|
     * | 时间线，不是键值表 | 一天一组、最新在前，左边一根线、一条一个点 |
     * | 「当时见过数」要不要突出 | **要** —— 它是这条记录唯一有信息量的数字：右边一颗标签 + 线上那个点的样子（`seenBadge`） |
     * | 展开全部 | 默认露 6 条，「展开其余 N 条」（和投递页同一个说法）；接口只给最近 50 条，**文件里更多时明说** |
     * | 截断 + 看全文 | 一句话收到两行，「展开」看全；记录本身被截过（120 字）的，**标出来** |
     * | 跳到那条公告留下的空白处 | 跳不到"那个位置"（记录里没存行号，行号也会漂）—— 但**反过来能做**：公告页搜不到的，告诉你"删除记录里有"，点过来 |
     *
     * ### 三种"没有"要分开说（和 `seenBy` 同一个纪律）
     *
     * | `deletions` | 说什么 |
     * |---|---|
     * | `null` | **问不到**删除记录接口 —— 这不代表没删过 |
     * | `exists: false` | 还没删过 —— 删过之后这里会有记录（**不是错误**） |
     * | `exists: true`、一条也读不出 | 文件在，但没有读得出来的条目 |
     */
    const DEL_LIMIT = 6;
    function DeletionLog({ deletions, asked, rows, deskNames, onCopy, jump, onJumpDone }) {
      const [all, setAll] = useState(false);
      const [query, setQuery] = useState(() => (jump ? jump.q : ''));
      /** 搜索框出现过一次就留着 —— 不然从公告页带着词跳过来、把词删光时，框跟着消失，光标也丢了。 */
      const [searchKept, setSearchKept] = useState(() => Boolean(jump && jump.q));
      const onQuery = (v) => { setQuery(v); if (v) setSearchKept(true); };
      const headRef = useRef(null);
      // 从公告页"跳过来"：带上搜索词，把这一节滚到眼前（用完就还回去，下次切回来不再跳）
      useEffect(() => {
        if (!jump) return;
        setQuery(jump.q);
        if (jump.q) setSearchKept(true);
        const el = headRef.current;
        const body = el ? el.closest('.oap-body') : null;
        if (el && body) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
        if (onJumpDone) onJumpDone();
      }, [jump]); // eslint-disable-line react-hooks/exhaustive-deps

      const q = query.trim().toLowerCase();
      let summary = null;
      let content;
      /**
       * 顺序有讲究：**先看有没有读出条目，再看 `exists`**。
       * `normalizeDeletions` 把"没给 `exists`"规整成 `false` —— 万一哪天后端漏了这个键、却带着条目，
       * 这里也不会对着一串记录说"还没删过"。
       */
      if (!asked) {
        content = h('div', { className: 'oap-quiet' }, icon('clock', 15), h('span', null, '正在读删除记录…'));
      } else if (deletions === null) {
        content = h('div', { className: 'oap-quiet is-warn' }, icon('alertCircle', 15),
          h('span', null, '问不到删除记录接口（面板后端没应答）—— 这不代表没删过。'));
      } else if (rows.length === 0 && deletions.exists === false) {
        summary = '还没有';
        content = h('div', { className: 'oap-quiet' }, icon('trash', 15),
          h('span', null, '还没有删过公告 —— 删过之后这里会有记录：删了哪一行、什么时候删的、删的时候有几个会话见过。'));
      } else if (rows.length === 0) {
        summary = '0 条';
        content = h('div', { className: 'oap-quiet' }, icon('info', 15),
          h('span', null, '记录文件在，但里面没有读得出来的条目（被手动改过？）'));
      } else {
        const n = rows.length;
        const total = Math.max(typeof deletions.total === 'number' ? deletions.total : n, n);
        const nSeen = rows.filter((r) => typeof r.seenBy === 'number' && r.seenBy > 0).length;
        summary = `${total > n ? `最近 ${n} 条（共 ${total} 条）` : `${n} 条`}${nSeen > 0 ? ` · 其中 ${nSeen} 条删的时候有会话见过` : ''}`;
        // 自己的搜索框还认"删的那天 / 几点"（按界面上显示的本地时间，不带年份 —— 免得"20""02"命中每一条）
        const logHay = (r) => `${deletedLineHay(r, deskNames)} ${r.when ? `${fmtMD(r.when)} ${fmtHM(r.when.getTime())}` : str(r.at).toLowerCase()}`;
        const list = q === '' ? rows : rows.filter((r) => logHay(r).includes(q));
        const capped = q === '' && !all && list.length > DEL_LIMIT;
        const shown = capped ? list.slice(0, DEL_LIMIT) : list;
        // 按本地日期分组 —— 记录本来就是最新在前，分出来也是最新的一天在前。
        // ⚠️ 同一天可能分成不挨着的两组（时间认不出、或者文件被手动挪过行）⇒ key 带上第几次出现，免得重复
        const groups = [];
        const seenDay = {};
        shown.forEach((r) => {
          const day = r.when ? fmtYMD(r.when) : '?';
          const g = groups[groups.length - 1];
          if (g && g.day === day) { g.items.push(r); return; }
          seenDay[day] = (seenDay[day] || 0) + 1;
          groups.push({ day, key: `${day}#${seenDay[day]}`, label: r.when ? dateLabel(r.when) : '时间认不出', items: [r] });
        });
        content = h(Fragment, null,
          n > DEL_LIMIT || q !== '' || searchKept
            ? h('div', { className: 'oap-toolbar' },
              h(SearchBox, { value: query, onChange: onQuery, placeholder: '搜删掉的内容、发布者或日期' }))
            : null,
          q !== '' && list.length === 0
            ? h('div', { className: 'oap-quiet' }, icon('search', 15), h('span', null, '删除记录里没有匹配的'))
            : null,
          groups.map((g, gi) => h(Fragment, { key: `g-${g.key}` },
            h('div', { className: `oap-group${gi === 0 ? ' is-tight' : ''}` }, g.label),
            h('div', { className: 'oap-tl', role: 'list', 'aria-label': `${g.label} 删掉的公告` },
              g.items.map((r) => h(DeletionItem, { key: r.key, row: r, deskNames, onCopy }))))),
          capped
            ? h('button', { type: 'button', className: 'oap-more', onClick: () => setAll(true) },
              icon('chevron', 13), `展开其余 ${list.length - DEL_LIMIT} 条`)
            : null,
          q === '' && all && list.length > DEL_LIMIT
            ? h('button', { type: 'button', className: 'oap-more', onClick: () => setAll(false) },
              icon('chevron', 13, 'oap-up'), '收起')
            : null,
          h('div', { className: 'oap-tl-foot' },
            total > n ? h('span', null, `接口只给最近 ${n} 条；更早的 ${total - n} 条只在记录文件里。`) : null,
            deletions.path
              ? h('span', { className: 'oap-tl-file', title: deletions.path }, icon('file', 12), sourceLabel(deletions.path))
              : null,
            deletions.path
              ? h('button', {
                type: 'button', className: 'oap-ibtn is-sm', onClick: () => onCopy(deletions.path),
                title: '复制记录文件的路径', 'aria-label': '复制删除记录文件的路径',
              }, icon('copy', 12))
              : null));
      }
      return h(Fragment, null,
        h('div', { className: 'oap-sh', ref: headRef }, h('h3', null, '删除记录'), summary ? h('span', null, summary) : null),
        content);
    }

    /**
     * @param {object} p.deletions ⭐ **删除记录**（2026-10-01 加）——
     *   来自 `GET /sidebar/api/office/deletions`。
     *   ⚠️ **`null` 表示"问不到"**（不是"没有记录"）—— 那两件事在界面上必须分得开。
     * @param {object[]} p.delRows 同一份数据拆好的显示行（`OfficePanelBody` 里算一次，公告页也用）
     */
    function HealthView({ data, parsed, picked, onCopy, deletions, delAsked, delRows, deskNames, delJump, onJumpDone }) {
      const { health, sessions } = picked;
      const nSessions = countOf(sessions);
      const cw = data.canWrite;
      const kvRow = (k, v, copy, key) => h('div', { key: key || k, className: 'oap-kvr' },
        h('span', { className: 'oap-kvr-k' }, k),
        h('span', { className: `oap-kvr-v${copy ? ' has-btn' : ''}` }, h('span', null, v),
          copy ? h('button', { type: 'button', className: 'oap-ibtn is-sm', onClick: () => onCopy(copy), title: '复制', 'aria-label': `复制${k}` }, icon('copy', 13)) : null));
      const path = (p) => (p ? h('span', { className: 'oap-mono' }, p) : h('span', { className: 'oap-soft' }, '—'));
      let writeText = '后端没说（发布 / 编辑照常显示，写失败会提示）';
      if (cw === true) writeText = '可以发布、编辑、删除公告';
      if (cw === false) writeText = '只读';

      /**
       * ⭐⭐ **版本号并进「运行信息」（2026-10-01，用户定）**。
       *
       * > *"这个版本其实可以并入前面那个运行信息里"*
       *
       * ⚠️ **但它和上面那几行的来源不同**（那几行来自**投递状态文件**，版本号来自**面板自己的接口**）——
       * 所以两张卡片**各自头上一行小字说来源**（0.3.22 起；原来是下面一个虚线框，长得像"空状态"）。
       *
       * ⚠️ 0.3.22 还改了两处：
       * - **它原来只在状态文件里有「健康」那一节时才显示**（`health ? … : null`）——
       *   而"面板是哪一版"恰恰是**状态文件出问题时**最想知道的。⇒ 现在一直显示。
       * - 版本对不上那句原来是普通字符串，里面的反引号原样露在界面上 ⇒ 改走 `renderInline`；
       *   后端**没给**版本号时不再报"不一致"（那是"不知道"，不是"对不上"）。
       *
       * ⚠️ **前端版本号是写死在这个文件里的常量**（`FE_VERSION`），
       * **必须和 `package.json` 一起改** —— 有断言守着这两个数一致。
       * ⚠️⚠️ **但"有断言"不等于"断言会被跑到"**：2026-10-04 那次，断言一直在，
       * 而**自测清单里漏了这一套**（当时只跑了八套）⇒ 版本号漂了三个版本没人发现 ✗。
       * **⇒ 动过这个文件之后，`探针\test-bulletin-panel.mjs` 必须跑。**
       */
      const be = data.panelVersion;
      /**
       * ⭐⭐ **盘上那份 `client.js` 里的常量**（后端**现读**报上来的，2026-10-04 加）。
       *
       * 它是这块判断的**关键补充**：`be`（后端）和 `FE_VERSION`（浏览器手里这份）对不上时，
       * 有两种**药方完全相反**的情况，光凭那两个数**分不出来** ——
       *   · 盘上常量 **≠** `FE_VERSION` ⇒ **浏览器手里那份旧了** ⇒ **硬刷新** ✓
       *   · 盘上常量 **=** `FE_VERSION` ⇒ 浏览器手里这份**就是盘上最新的** ⇒
       *     **硬刷新没用** ✗ —— 真相是**发版时忘了把 `FE_VERSION` 一起 +1**
       *     （⚠️ 2026-10-04 真踩到：健康页叫人硬刷新，而那条建议**永远不可能生效** ✗）
       *
       * ⚠️ 后端没报这个字段（旧版后端 / 读文件失败）⇒ 空串 ⇒ **退回原来的说法**（不硬猜）。
       */
      const diskFeRaw = data.clientFileVersion;
      const diskFe = (diskFeRaw === null || diskFeRaw === undefined) ? '' : String(diskFeRaw);
      let verV;
      if (be === '') {
        verV = h('span', null, `前端 v${FE_VERSION} · `, h('span', { className: 'oap-soft' }, '后端没给版本号'));
      } else if (be === FE_VERSION) {
        verV = h('span', null, `v${FE_VERSION}`, h('span', { className: 'oap-ok' }, icon('check', 12), '前后端一致'));
      } else {
        const c = cmpVer(be, FE_VERSION);
        let why = renderInline('数字一样、写法不一样 —— 对一下 **client.js** 和 **package.json** 里的写法', 'ver');
        if (diskFe !== '' && diskFe === FE_VERSION) {
          /**
           * ⭐ **浏览器手里这份 == 盘上那份** ⇒ **不是缓存问题**，硬刷新救不了。
           * 而后端比它们新 ⇒ 真相是"改了 `package.json`、没改 `client.js`"。
           */
          why = renderInline(`**硬刷新没用** —— 盘上这份 \`client.js\` 自己就写着 **v${FE_VERSION}**，后端已经到 **v${be.replace(/^v/iu, '')}**：**发版时忘了把顶部那个常量一起 +1**，得改代码重新发版`, 'ver');
        } else if (c > 0) {
          why = renderInline('后端更新：浏览器多半还拿着旧的 **client.js**，硬刷新一下（Ctrl+Shift+R）', 'ver');
        } else if (c < 0) {
          why = renderInline('前端更新：多半是 **package.json** 的版本号忘了改，或者后端还没重启', 'ver');
        }
        verV = h(Fragment, null,
          h('span', { className: 'oap-warnline' }, `对不上：前端 v${FE_VERSION} · 后端 v${be.replace(/^v/iu, '')}`),
          h('br'),
          h('span', { className: 'oap-soft' }, why));
      }
      /**
       * 「见过数」从哪来、靠不靠得住（`seenSessions` / `seenByFiltered` —— 接口清单第二节，"排查用"）。
       * 删除确认框里那句"有 N 个会话见过"就是它；这一行回答"那个数能不能信"。
       */
      const ents = data.announce.entries;
      let seenV = null;
      if (ents.length > 0 && ents.every((e) => e.seenBy === null)) {
        seenV = h('span', { className: 'oap-warnline' }, '问不到 —— 公告插件的「见过」接口没应答（删除确认框会如实说"问不到"）');
      } else if (data.seenByFiltered === false) {
        seenV = '没拿到平台的会话名单 —— 已经删掉的会话也算在里面，数字可能偏大';
      } else if (data.seenSessions !== null) {
        seenV = `由公告插件统计，按 ${data.seenSessions} 个会话算`;
      }

      return h('div', { className: 'oap-view' },
        h('div', { className: 'oap-sh' }, h('h3', null, '运行信息')),
        h('div', { className: 'oap-cap' }, '投递插件 · 来自投递状态文件'),
        data.status.exists === false ? noStatusFile(data)
          : (health ? h(SectionBody, { s: health })
            : h('div', { className: 'oap-quiet' }, icon('info', 15), h('span', null, '状态文件里还没有运行信息'))),
        h('div', { className: 'oap-cap' }, '办公室面板 · 来自面板自己的接口'),
        h('div', { className: 'oap-kvs' },
          kvRow('面板版本', verV),
          seenV !== null ? kvRow('见过数', seenV) : null),
        h('div', { className: 'oap-sh' }, h('h3', null, '认过桌的会话'), nSessions !== null ? h('span', null, `${nSessions} 个`) : null),
        sessions ? h(SectionBody, { s: sessions })
          : h('div', { className: 'oap-quiet' }, icon('info', 15), h('span', null, '还没有会话认过桌')),
        h(DeletionLog, { deletions, asked: delAsked, rows: delRows, deskNames, onCopy, jump: delJump, onJumpDone }),
        h(Section, { title: '文件信息', defaultOpen: false },
          h('div', { className: 'oap-kvs' },
            kvRow('公告文件', path(data.paths.announce), data.paths.announce),
            kvRow('投递状态文件', path(data.paths.status), data.paths.status),
            deletions !== null && deletions.path ? kvRow('删除记录文件', path(deletions.path), deletions.path) : null,
            kvRow('写入', writeText),
            factsOf(parsed).map((f, i) => kvRow(f.k || `其它 ${i + 1}`, renderInline(f.v, `fact${i}`), null, `fact${i}`)))));
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 公告
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 一条公告。长正文默认折叠到 3 行，真的放不下才出现「展开」；
     * 能写时右下角有「编辑」和「删除」。
     */
    function Entry({ e, fresh, flash, deskName, canWrite, onEdit, onDelete, onCopy }) {
      const clamp = useClamp(e.summary);
      const [showSrc, setShowSrc] = useState(false);
      const hasSrc = e.source.trim() !== '';
      const ttl = ttlInfo(e.ttl, e.date);
      const canEdit = canWrite && e.raw !== '';
      const cls = ['oap-card'];
      if (fresh) cls.push('is-new');
      if (flash) cls.push('is-flash');
      if (ttl.expired) cls.push('is-expired');
      return h('article', { className: cls.join(' ') },
        h('div', { className: 'oap-meta' },
          avatar(e.publisher),
          // 和投递页一样用「[02] 环境维护」认桌；桌名从投递状态里认，认不出就显示原来的发布者
          h('span', { className: 'oap-who', title: deskName ? `${e.publisher} · ${deskName}` : undefined },
            deskName || e.publisher || '办公室'),
          fresh ? h('span', { className: 'oap-pill is-new' }, '新') : null,
          /**
           * ⭐⭐ **"有几个会话见过"** —— 直接摆在卡片上，**不用点进删除框才看得到**。
           *
           * ⚠️ 起因是一句直白的反馈：*"删除那里还可以看见这条公告被多少个会话看过"* ——
           * **那个数原来只出现在两个地方**：删除确认框里、以及删完之后的记录里。
           * **⇒ 结果是"想知道它有多少读者，得先走到'要删它'那一步"** —— 那不对。
           *
           * ⚠️ **只在有数的时候显示**（`null` 也显示，因为"问不到"本身是信息）。
           * 而它**和「新」标签并排**：一个说"我看过没"，一个说"多少人看过"。
           */
          memberBadge(e.seenBy),
          ttl.label
            ? h('span', { className: `oap-pill oap-ttl${ttl.expired ? ' is-muted' : ''}${ttl.unknown ? ' is-dashed' : ''}`, title: ttl.title },
              ttl.timed ? icon('clock', 11) : null, ttl.label)
            : null),
        h('div', { ref: clamp.ref, className: `oap-text${clamp.open ? '' : ' oap-clamp'}` }, renderInline(e.summary, 's')),
        clamp.canToggle || hasSrc || canWrite
          ? h('div', { className: 'oap-foot' },
            clamp.canToggle
              ? h('button', {
                type: 'button', className: 'oap-link', 'aria-expanded': clamp.open,
                onClick: () => clamp.setOpen((v) => !v),
              }, clamp.open ? '收起' : '展开')
              : null,
            hasSrc
              ? h('button', {
                type: 'button', className: 'oap-link is-src', 'aria-expanded': showSrc,
                onClick: () => setShowSrc((v) => !v), title: decodeEntities(e.source),
              }, icon('file', 12), h('span', null, showSrc ? '收起详见' : `详见：${sourceLabel(e.source)}`))
              : null,
            canWrite
              ? h('button', {
                type: 'button', className: 'oap-link is-edit', 'aria-disabled': !canEdit,
                onClick: () => { if (canEdit) onEdit(e); },
                title: canEdit ? '编辑这条公告' : '缺少原始行，没法安全地编辑',
              }, icon('pencil', 12), h('span', null, '编辑'))
              : null,
            /**
             * ⭐ **删除**（2026-10-01 加的）—— 起因：
             * *"误发的公告和测试用的公告，希望可以被我删掉。"*
             *
             * ⚠️ **它和「编辑」并排，但按钮样式是"低调"的**（`is-del`）——
             * ⚠️ **删除不是在"破坏规矩"**（它属于"用户那一半"）—— 但它会让"见过它的人"收不到任何信号，*
               * **所以不该长得像日常动作。**
             *
             * ⚠️ **点了不会直接删** —— 走一个确认框，
             * 而且框里会写清"**有几个会话的『见过』记录里有这条**"（后端算的 `seenBy`）。
             */
            canWrite
              ? h('button', {
                type: 'button', className: 'oap-link is-del', 'aria-disabled': !canEdit,
                onClick: () => { if (canEdit) onDelete(e); },
                title: canEdit ? '删掉这条公告（会问你一次）' : '缺少原始行，没法安全地删除',
              }, icon('trash', 12), h('span', null, '删除'))
              : null)
          : null,
        showSrc && hasSrc
          ? h('div', { className: 'oap-src' },
            h('div', null, renderInline(e.source, 'src')),
            h('button', {
              type: 'button', className: 'oap-ibtn is-sm', onClick: () => onCopy(stripMd(e.source)),
              title: '复制', 'aria-label': '复制详见',
            }, icon('copy', 13)))
          : null);
    }

    /** 发布者按桌号排（01、02 …），其余（用户、Codex …）排后面。 */
    function sortPublishers(list) {
      return [...new Set(list.filter(Boolean))].sort((x, y) => {
        const nx = /(\d{1,3})/u.exec(x);
        const ny = /(\d{1,3})/u.exec(y);
        if (nx && ny) return Number(nx[1]) - Number(ny[1]);
        if (nx) return -1;
        if (ny) return 1;
        return x.localeCompare(y, 'zh');
      });
    }

    function AnnounceView(props) {
      const {
        data, baseline, mine, onlyNew, setOnlyNew, query, setQuery, pub, setPub,
        canWrite, onEdit, onDelete, onCopy, flashRaw, deskNames,
        delRows, delTotal, onJumpDeletions,
      } = props;
      const a = data.announce;
      const all = a.entries;
      const isNew = (i) => baseline !== null && i >= baseline && !mine.has(all[i].raw);
      let newCount = 0;
      for (let i = 0; i < all.length; i += 1) if (isNew(i)) newCount += 1;

      const pubs = sortPublishers(all.map((e) => e.publisher));
      const activePub = pubs.includes(pub) ? pub : '';
      const q = query.trim().toLowerCase();
      const hay = (e) => `${e.date} ${e.publisher} ${deskNameOf(deskNames, e.publisher)} ${stripMd(e.summary)} ${stripMd(e.source)} ${e.ttl}`.toLowerCase();
      const filtering = q !== '' || activePub !== '' || onlyNew;
      const clearAll = () => { setQuery(''); setPub(''); setOnlyNew(false); };
      /**
       * 删除记录里有几条和这次搜索对得上（"跨页指路"用）。口径和上面的 `hay` 一样，
       * 而且**跟着发布者筛选走**；「只看新」开着时不指路（那时列表空，是因为"没有新的"，不是"被删了"）。
       */
      const delMatches = q !== '' && !onlyNew && a.exists !== false && Array.isArray(delRows)
        ? delRows.filter((r) => (activePub === '' || r.f.publisher === activePub) && deletedLineHay(r, deskNames).includes(q)).length
        : 0;

      // 新的在上；key 用原始整行（重复的加序号），自动刷新后展开状态不丢
      const seen = new Map();
      const items = [];
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const e = all[i];
        const n = seen.get(e.raw) || 0;
        seen.set(e.raw, n + 1);
        if (onlyNew && !isNew(i)) continue;
        if (activePub !== '' && e.publisher !== activePub) continue;
        if (q !== '' && !hay(e).includes(q)) continue;
        items.push({ e, fresh: isNew(i), key: `${e.raw}#${n}` });
      }
      const groups = [];
      items.forEach((it) => {
        const g = groups[groups.length - 1];
        if (g && g.date === it.e.date) g.items.push(it);
        else groups.push({ date: it.e.date, items: [it] });
      });

      let list;
      if (a.exists === false) {
        list = h(EmptyState, { ic: 'megaphone', title: '还没有公告文件' }, h('div', { className: 'oap-path oap-mono' }, data.paths.announce));
      } else if (items.length === 0 && onlyNew && q === '' && activePub === '') {
        list = h(EmptyState, {
          ic: 'checkCircle', title: '没有新的',
          action: h('button', { type: 'button', className: 'oap-btn', onClick: () => setOnlyNew(false) }, '看全部'),
        }, h('div', null, '上次看过之后还没有新公告。'));
      } else if (items.length === 0 && filtering) {
        list = h(EmptyState, {
          ic: 'search', title: '没有找到匹配的公告',
          action: h('button', { type: 'button', className: 'oap-btn', onClick: clearAll }, '清除筛选'),
        }, h('div', null, '换个关键词，或者清除筛选再看看。'));
      } else if (items.length === 0) {
        list = h(EmptyState, { ic: 'megaphone', title: '还没有公告' }, h('div', null, '有事要让整个办公室知道，就发一条。'));
      } else {
        list = groups.map((g) => h(Fragment, { key: `g-${g.items[0].key}` },
          h('div', { className: 'oap-group' }, dayLabel(g.date)),
          h('div', { className: 'oap-grid' }, g.items.map((it) => h(Entry, {
            key: it.key,
            e: it.e,
            fresh: it.fresh,
            flash: flashRaw !== '' && it.e.raw === flashRaw,
            deskName: deskNameOf(deskNames, it.e.publisher),
            canWrite,
            onEdit,
            onDelete,
            onCopy,
          })))));
      }

      return h('div', { className: 'oap-view' },
        // ⚠️ 解析不了的行必须露出来 —— 不能静默丢（静默的失败看起来像"没有"）
        a.malformed.length > 0
          ? h('div', { className: 'oap-callout is-spaced', role: 'alert' },
            icon('alert', 15, 'oap-callout-ic'),
            h('div', { className: 'oap-callout-b' },
              h('div', { className: 'oap-callout-t' }, `有 ${a.malformed.length} 行看着像公告，却解析不了`),
              h('div', { className: 'oap-callout-d' }, '格式可能变了，这几行不会出现在下面的列表里：'),
              h('div', { className: 'oap-callout-lines oap-mono' }, a.malformed.map((line, i) => h('div', { key: i }, line)))))
          : null,
        a.exists === false ? null : h('div', { className: 'oap-toolbar' },
          h(SearchBox, { value: query, onChange: setQuery, placeholder: '搜索公告或出处' }),
          pubs.length > 1
            ? h('span', { className: 'oap-select' },
              h('select', { value: activePub, onChange: (ev) => setPub(ev.target.value), 'aria-label': '按发布者筛选' },
                h('option', { value: '' }, '全部发布者'),
                pubs.map((p) => {
                  const n = deskNameOf(deskNames, p);
                  return h('option', { key: p, value: p }, n ? `${p} · ${n}` : p);
                })),
              icon('chevron', 13))
            : null,
          h('button', {
            type: 'button', className: 'oap-toggle', 'aria-pressed': onlyNew,
            'aria-disabled': !onlyNew && newCount === 0,
            onClick: () => { if (onlyNew || newCount > 0) setOnlyNew((v) => !v); },
            title: '只看上次看过之后新增的',
          }, '只看新', newCount > 0 ? h('b', null, newCount) : null)),
        a.exists === false ? null : h('div', { className: 'oap-meta-line' },
          filtering
            ? h(Fragment, null,
              h('span', null, `找到 ${items.length} 条`),
              h('span', { className: 'oap-soft' }, `（共 ${a.count} 条）`),
              h('button', { type: 'button', className: 'oap-textbtn is-inline', onClick: clearAll }, '清除筛选'))
            : h(Fragment, null,
              h('span', null, `共 ${a.count} 条`),
              newCount > 0 ? h('b', null, `· 新 ${newCount}`) : null,
              h('span', { className: 'oap-soft' }, '· 最新在前'),
              /**
               * ⭐ 「删过 N 条」（0.3.22）—— 公告页和删除记录之间的那根线。
               * 接口清单里说它们有"一种奇怪的关系"：那条公告在这里已经没了，记录在「健康」页。
               * ⇒ 这里不画"空白处"（位置找不回来，见 `DeletionLog` 那张表），只留一个低调的入口。
               */
              delTotal > 0
                ? h('button', {
                  type: 'button', className: 'oap-textbtn is-inline is-quiet', onClick: () => onJumpDeletions(''),
                  title: '看删掉了哪些（在「健康」页的删除记录里）',
                }, `· 删过 ${delTotal} 条`)
                : null)),
        list,
        /**
         * ⭐ **"搜不到的那条，可能是被删了"**（0.3.22）—— 接口清单第五节第 2 问最后一条的回答。
         *
         * 跳到"那条公告留下的空白处"做不到：记录里没存行号（存了也会漂）。
         * **但反过来能做**：你在这里搜一条、搜不到时，人最想知道的是"它去哪了" ——
         * ⇒ 删除记录里有匹配的，就在列表下面说一句，点一下带着搜索词跳过去。
         */
        delMatches > 0
          ? h('button', { type: 'button', className: 'oap-xref', onClick: () => onJumpDeletions(query.trim()) },
            icon('trash', 14),
            h('span', null, items.length === 0
              ? `它可能被删了：删除记录里有 ${delMatches} 条匹配「${query.trim()}」`
              : `删除记录里还有 ${delMatches} 条匹配「${query.trim()}」`),
            icon('arrowRight', 13))
          : null);
    }

    /* ═══════════════════════════════════════════════════════════════════
     * ⭐ 删除 —— 面板内的确认框（**不用浏览器自带的 confirm**）
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 删一条公告之前的确认。
     *
     * ## 为什么它和「编辑」共用同一个对话框外壳，却是独立的组件
     *
     * `Composer` 那一套是围绕"**编辑一段文本**"建的（正文框、有效期、逐字对照、两步确认）——
     * **删除没有可编辑的东西**，硬塞进去会让那个组件长出两套逻辑。
     * ⇒ 所以**只复用样式类**（`.oap-scrim` / `.oap-dlg` / `.oap-dlg-f`），**逻辑各写各的**。
     *
     * ## ⚠️ 它比"删掉一行"多做的那件事
     *
     * **它告诉用户"有几个会话的『见过』记录里有这条"**（`e.seenBy`，后端读公告插件的 seen 算的）。
     *
     * 因为**直接删除和"撤回"不一样**：删掉之后，**已经见过它的会话不会收到任何信号**
     * —— 它们上下文里还留着那条公告。**⇒ 那不是"污染"，是"分歧"。**
     *
     * 要能直接删（理由：*"真正有用的公告不会被撤回，没用的也不会留几天"*），
     * **⇒ 那就让删除"有据"**：**不阻止你，只让你不是不知道地删。**
     *
     * @param {object} p
     * @param {object} p.entry 要删的那条（`raw` / `summary` / `seenBy`）
     * @param {boolean} p.seenByFiltered `seenBy` 有没有过滤掉"已经不存在的会话"
     *   （`false` = 平台的会话名单没问出来 ⇒ **那个数字是历史记录数，比现实大**）
     */
    function ConfirmDelete({ entry, revision, seenByFiltered, deskName, onClose, onDone, reload }) {
      const [sending, setSending] = useState(false);
      const [note, setNote] = useState(null);
      const sendingRef = useRef(false);
      const cancelRef = useRef(null);
      const dlgRef = useRef(null);
      /**
       * ## ⚠️⚠️ **`null` 必须留着，不能压成 `0`**（2026-10-01 —— 这是同一个 bug 的第三个化身）
       *
       * 原来这一行是：
       *
       * ```js
       * const seenBy = Number.isFinite(entry.seenBy) ? entry.seenBy : 0;   // ⚠️
       * ```
       *
       * **`Number.isFinite(null)` 是 `false`** ⇒ **`null` 被安静地压成 `0`** ⇒
       * 下面那个"问不到"的分支**永远走不到**，界面永远显示
       * *"没有任何会话的「见过」记录里有这条 —— 删掉它不会影响谁。"*
       *
       * **⚠️ 而那一句是在骗人**：它把"**我不知道**"说成了"**没人在意，放心删**"。
       *
       * ### 为什么这个形状出现了三次（值得记）
       *
       * | # | 在哪 | 怎么把 `null` 变没的 |
       * |---|---|---|
       * | 1 | 后端 `normalizeData` 时代 | 白名单**根本没有这个键** ⇒ `undefined` |
       * | 2 | 后端 `readPayload` | `asked.seen[e.id] ?? 0` 把"查不到"补成 `0` |
       * | 3 | **这里** | `Number.isFinite(…) ? … : 0` 把 `null` 归一成 `0` |
       *
       * **⇒ 三处都是"给缺失补一个看起来正常的默认值"，而那正是把"不知道"伪装成"知道"。**
       * **⇒ `docs\06` 二.7 那条的共同原因，在这一下午里出现了三次。**
       */
      const seenBy = (typeof entry.seenBy === 'number' && Number.isFinite(entry.seenBy))
        ? entry.seenBy
        : null;

      /**
       * ⚠️ **打开时焦点给「取消」，不给「删除」**（0.3.22 改的）。
       * 原来给的是「删除」⇒ 点开确认框之后**手一抖按个回车就删了** —— 那这个框就白设了。
       * 破坏性操作的确认框，默认焦点放在"不会出事"的那个按钮上。
       */
      useEffect(() => {
        const prev = document.activeElement;
        cancelRef.current?.focus();
        return () => {
          try { if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus(); } catch (_) { /* 忽略 */ }
        };
      }, []);

      const submit = async () => {
        if (sendingRef.current) return;
        if (revision === null || revision === undefined || revision === '') {
          setNote({ tone: 'warn', title: '缺少文件版本', detail: '刷新一下拿到最新版本，再删。', action: 'refresh' });
          return;
        }
        sendingRef.current = true;
        setSending(true);
        setNote(null);
        const res = await postJSON('/sidebar/api/office/announce/delete', {
          revision,
          raw: entry.raw,
          /**
           * ⭐ **把"几个会话见过"一起带上去**（2026-10-01 加）。
           *
           * 服务端要把它写进「公告-删除记录.md」—— 那是删除唯一留下的痕迹。
           * **而这个数字此刻就在手上**（对话框里刚显示过它）：
           *
           * - 让服务端**自己再问一次**接口 ⇒ 多一次往返、多一个失败点，
           *   而且**两次结果可能不同**（记录里该写的是"用户看到的那一个"）
           * - **`null` 就照实传 `null`** ⇒ 服务端记 `—`（"没问出来"）
           *   ⚠️ **绝不传 0** —— `0` 的意思是"**确实没人见过**"，那是另一回事
           */
          seenBy: typeof entry.seenBy === 'number' ? entry.seenBy : null,
        });
        /**
         * ## ⚠️⚠️ **`postJSON` 返回的是 `{ kind, status, body }`，不是 `{ ok, data }`**
         * （2026-10-01 改的 —— 原来这里写的是 `res.ok && res.data && res.data.ok === true`）
         *
         * ### 那个写法为什么是错的
         *
         * `postJSON` 的返回值里**根本没有 `ok` / `data` 这两个键** ⇒
         * `res.ok` 是 `undefined` ⇒ 整个条件**永远为假** ⇒
         * **删除成功了，界面照样走"失败"那条路**，显示
         * *"删除没成功：宿主没给出原因，看后台日志"*。
         *
         * ⚠️ **而 `stale` / `not-found` 也认不出来** —— 它们在 `res.body.code` 里，
         * 而这里读的是 `res.data.code`（同样是 `undefined`）。
         * ⇒ **三种情况（成功 / 文件变了 / 那行没了）全都显示同一句话。**
         *
         * ### 怎么发现的
         *
         * Claude 复查时**真的把删除跑了一遍**：文件里那一行确实删掉了，
         * **而界面说"删除没成功"**。
         * **⇒ 而"删成功却报失败"比"报成功却没删"更危险** ——
         * 用户会再点一次，而第二次会删掉另一条。
         *
         * ### 现在照 `Composer` 那份写法（同一个 `postJSON`，本来就该一致）
         */
        if (res.kind === 'ok') {
          onDone({
            removed: entry.raw,
            revision: res.body ? res.body.revision : null,
            /**
             * ⭐ **后端现在就回 `logged`**（删除记录记上了没有）—— 原样带上去。
             *
             * ⚠️ **这句注释 2026-10-03 改过**：原来写的是*"后端以后要是回 `logged`…现在的后端不回 ⇒ `null`"* ——
             * **而它已经回了**（`panel/index.js` 的删除响应里带着 `logged`）。
             * ⇒ 于是那个 `null` 只剩一种含义：**后端没回、或者回了非布尔**（那是异常情况，不是常态）。
             *
             * ⭐ **判据**：**"以后要是…"这种话，一落地就得把"以后"删掉** ——
             * 不然下一个人读到的是一条**永远在未来**的注释。
             */
            logged: res.body && typeof res.body.logged === 'boolean' ? res.body.logged : null,
          });
          return;
        }
        const code = res.body && res.body.code;
        if (code === 'stale') {
          setNote({
            tone: 'warn', title: '文件已经变了',
            detail: '你看到的列表不是最新的 —— 关掉窗口，对最新的内容重新确认。', action: 'refresh',
          });
        } else if (code === 'not-found') {
          setNote({
            tone: 'error', title: '那一行已经不在了',
            detail: '可能已经被删掉，或者被别人改过。关掉窗口刷新看看。', action: 'refresh',
          });
        } else {
          /**
           * ⚠️⚠️ **原来这里会把整个面板弄崩**（0.3.22 修的）。
           *
           * 原来写的是 `detail: (res.body && res.body.message) || explainWrite(res) || '…'` ——
           * **`explainWrite` 返回的是一个对象**（`{ tone, title, detail }`），不是一句话 ⇒
           * 接口没给 `message` 时（**连不上、接口没上线、500 不是 JSON**）这个对象被当成文字塞进界面
           * ⇒ React 抛 *Objects are not valid as a React child* ⇒ **错误边界接住，整张卡片变成"渲染出错了"**，
           * 确认框也没了 —— 用户**不知道删没删成**。（复查时把网断掉点了一下「删除」，当场复现。）
           * ⇒ 现在**不借 `explainWrite` 的话**（那几句是给"发布 / 编辑"写的："你写的内容先留在这里"），
           *   删除自己说清楚。最要紧的是**连不上**那一种：请求可能已经到了后端、只是回应丢了 ——
           *   **删没删成说不准**，那就别说"没成功"，让用户刷新看一眼。
           *   （再点一次也不会多删：`revision` 一变，第二次会被 409 拦下。）
           */
          /**
           * **哪些情况能确定"没删"，哪些不能**（0.3.22 复查时又细分了一次）：
           *
           * | 情况 | 能确定吗 | 为什么 |
           * |---|---|---|
           * | 404 / 405 / 501（路由不在） | 能：没删 | 请求根本没进删除的逻辑 |
           * | 按约定回了 `ok:false`（`stale` / `not-found` 在上面；`read-only`、`write-failed` 等） | 能：没删 | 后端明说了 |
           * | 连不上（`status 0`） | **不能** | 请求可能已经到了、只是回应丢了 |
           * | 2xx 但回的不是约定的 JSON | **不能** | 后端应答了，多半删了 |
           * | 5xx 且不是 JSON | **不能** | 0.3.20 那个 bug 就是这样：行已经删了，之后抛错 |
           *
           * ⇒ 不能确定的，一律说"说不准，刷新看看"，**不说"没成功"** —— 用户会因为"没成功"再点一次。
           */
          const msg = str(res.body && res.body.message).trim();
          const routeMissing = res.kind === 'unavailable' && (res.status === 404 || res.status === 405 || res.status === 501);
          let n;
          if (routeMissing) {
            n = {
              title: `删除接口没应答（HTTP ${res.status}）`,
              detail: '这一次没删。面板后端可能还是没有删除功能的旧版 —— 看看「健康」页的面板版本。',
            };
          } else if (res.status === 403) {   // 403 是在进删除逻辑之前就拦下的（来源 / 只读）⇒ 能确定没删
            n = { title: '现在不能删', detail: `${msg ? `${msg}。` : ''}点「刷新」看看面板是不是变成只读了。`, action: 'refresh' };
          } else if (res.kind === 'rejected') {
            n = { title: '删除没成功', detail: msg || `后端拒绝了（${str(res.body && res.body.code) || `HTTP ${res.status}`}），看后台日志。` };
          } else {
            n = {
              title: res.status === 0 ? '没收到后端的回应' : `后端的回应不对（HTTP ${res.status}）`,
              detail: '这一次删没删成说不准 —— 刷新一下看看：那一条还在，就是没删成；不在了，删除记录里会有它。',
              action: 'refresh',
            };
          }
          setNote({ tone: 'error', ...n });
        }
        sendingRef.current = false;
        setSending(false);
      };

      /** Esc 关掉；Tab 只在框里转（和发布 / 编辑那个框同一套）。 */
      const onKeyDown = (ev) => {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          if (!sending) onClose();
          return;
        }
        if (ev.key === 'Tab' && dlgRef.current) {
          const items = [...dlgRef.current.querySelectorAll('button, input, textarea, select')]
            .filter((el) => !el.disabled && el.offsetParent !== null);
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
      };

      return h('div', { className: 'oap-scrim' },
        h('div', {
          ref: dlgRef, className: 'oap-dlg', role: 'alertdialog', 'aria-modal': 'true', tabIndex: -1,
          'aria-labelledby': 'oap-del-title', 'aria-describedby': 'oap-del-what', onKeyDown,
        },
          h('div', { className: 'oap-dlg-h' },
            h('div', null,
              h('div', { className: 'oap-dlg-t', id: 'oap-del-title' }, '删除这条公告'),
              h('div', { className: 'oap-dlg-s' },
                [deskName ? `${entry.publisher} · ${deskName}` : entry.publisher, entry.date].filter(Boolean).join(' · '))),
            h('button', {
              type: 'button', className: 'oap-ibtn is-sm', 'aria-disabled': sending, onClick: () => { if (!sending) onClose(); },
              title: '取消（Esc）', 'aria-label': '取消',
            }, icon('x', 14))),

          h('div', { className: 'oap-dlg-b' },
            // 要删的那条长什么样（让用户确认删的是对的那条）
            h('div', { className: 'oap-field' },
              h('div', { className: 'oap-label' }, h('span', null, '要删掉的这一条')),
              h('div', { className: 'oap-preview', id: 'oap-del-what' }, renderInline(entry.summary, 'del'))),

            /**
             * ⚠️⚠️ **这一段是这个框存在的全部理由** ——
             * 说清"删了之后别人那边会怎样"，**而不是只问"确定吗？"**
             *
             * ⚠️ **里面那两处 `**…**` 必须用 `renderInline` 包起来**
             * （2026-10-01 看截图发现的：**星号原样显示在界面上**）——
             * 只有 `renderInline` 认 `**粗体**` 和 `` `代码` ``，
             * **直接塞一个字符串进去是不会被渲染的。**
             * ⇒ 这一条是**通用**的：**写在 JSX 里的静态文字，不会自己变成粗体。**
             */
            /**
             * ## ⚠️⚠️ **三档，不是两档**（2026-10-01 改的，这一条是这次改动的核心）
             *
             * ```js
             * seenBy > 0 ? "有 N 个会话见过" : "没有任何会话的见过记录里有这条"
             * ```
             *
             * **⇒ 上面那个写法有两档，而现实有三档** ——
             * `null > 0` 是 `false` ⇒ **"问不到"会被显示成"没有任何会话见过这条"**。
             *
             * **⚠️ 而那一句正是这次要消灭的**：
             * 它读起来像"**放心删吧，没人在意**"，而实际是"**我不知道有没有人在意**"。
             * **⇒ 一个会撒谎的提醒，比没有提醒更危险。**
             *
             * | `seenBy` | 显示 |
             * |---|---|
             * | `≥1` | "有 N 个会话见过这条" |
             * | `0` | "没有任何会话的见过记录里有这条" |
             * | **`null`** | **"问不到 —— 不能确定有没有人见过"** |
             */
            seenBy === null
              ? h('div', { className: 'oap-callout', role: 'alert' },
                icon('alert', 15, 'oap-callout-ic'),
                h('div', { className: 'oap-callout-b' },
                  h('div', { className: 'oap-callout-t' }, '问不到「有几个会话见过这条」'),
                  h('div', { className: 'oap-callout-d' },
                    /**
                     * ⚠️ **这一整串必须和 `renderInline` 在同一行**（2026-10-01 踩到）。
                     *
                     * 探针里那条"**塞进 JSX 却没渲染的 markdown**"是**逐行**判的：
                     * 它要求"带 `**…**` 的那一行里**同时**出现 `renderInline`"。
                     * ⇒ 我把字符串拆成两行、`**` 落在了续行上 ⇒ **被判成可疑**。
                     *
                     * ⚠️ **而那次是假阳性**（它**确实**在 `renderInline(...)` 里）。
                     * **但我没去改判据，而是改了这一行的写法** —— 理由是：
                     * 那条判据**逐行**是对的（它防的是"整个字符串直接塞进 JSX"），
                     * 而**让"带 markdown 的那一行自己带上 renderInline"是个更耐读的写法**：
                     * 一眼就能看出这串文字过没过渲染。
                     */
                    renderInline('**这不代表没人见过** —— 只代表这次没问出来（多半是公告插件的接口没应答）。删掉之后，见过的那些会话**不会收到任何通知**。', 'del0'))))
              : seenBy > 0
                ? h('div', { className: 'oap-callout', role: 'alert' },
                  icon('alert', 15, 'oap-callout-ic'),
                  h('div', { className: 'oap-callout-b' },
                    h('div', { className: 'oap-callout-t' }, `有 ${seenBy} 个会话见过这条`),
                    h('div', { className: 'oap-callout-d' },
                      renderInline('删掉之后它们**不会收到任何通知** —— 那条公告还会留在它们的上下文里。', 'del1'),
                      h('br'),
                      '（如果这条本来就是误发的、或者只是测试，那没关系。）'),
                    /**
                     * ⚠️ **没过滤时，这个数字是"历史记录数"** ——
                     * 那就得说清它比现实大（见 `docs\07` §三「三件删除的代价」）。
                     */
                    /**
                     * ⚠️ 这句原来是普通字符串 ⇒ 里面的 `**…**` 原样露在界面上（和 0.3.21 修过的那几处同一类）。
                     */
                    seenByFiltered === false
                      ? h('div', { className: 'oap-callout-d' },
                        renderInline('这一次没问出来"哪些会话还在"，所以上面这个数**没有滤掉已经删除的会话**（可能比现实多）。', 'del3'))
                      : null))
                : h('div', { className: 'oap-hint has-ic is-ok' }, icon('checkCircle', 13),
                  /**
                   * ## ⚠️⚠️ 这句 2026-10-02 改过，**2026-10-03 又改了一次理由**
                   *
                   * ### 第一次（10-02）：去掉一个撑不起的承诺
                   *
                   * **原话**：*"没有任何会话的「见过」记录里有这条 —— **删掉它不会影响谁**。"*
                   * ⇒ 后半句是**承诺**，而那个数撑不起它。
                   *
                   * ### ⚠️ 第二次（10-03）：**第一版给的理由是错的**
                   *
                   * 我第一次改成了"记录受**数量上限**影响" —— **而那是反的**：
                   *
                   * | 机制 | 它让这个数…… |
                   * |---|---|
                   * | **整批记账**（注入上限 8 条，而 9 条全记） | ⚠️ **偏多** ⇒ **造不出假的 0** |
                   * | ⭐ **压缩后清空重记** | ✅ **这才是让 0 失真的那个** —— 已经过期的条目**不会再记回去** |
                   *
                   * **⇒ 我引用的机制"方向反了"**（外部终审指出来的）。
                   * **⭐ 一个理由引错了机制，比不给理由更糟** —— 它会让人以为自己懂了。
                   *
                   * ### 现在（只留站得住的那一句）
                   *
                   * **"账上没有" ≠ "没人读过"**，而**真正的机制是"压缩会重记这本账"。**
                   *
                   * ⭐ **判据没变**：**一个数只能为它自己作证。**
                   * **⚠️ 而"该不该删"仍然留给用户判断** —— 那本来就是这一栏存在的意义。
                   */
                  h('span', null, '没有任何会话的「见过」记录里有这条。'),
                  h('br'),
                  h('span', { className: 'oap-soft' },
                    '（这只是说"账上没有"：会话压缩后这本账会重记，已经过期的条目不会再记回去 —— 所以不等于没人读过。）')),

            h('div', { className: 'oap-hint has-ic' }, icon('info', 13),
              /**
               * ⚠️ **措辞 2026-10-01 改过**（原来是"公告文件的规矩是只增不改；删除是唯一会破坏它的操作"）。
               *
               * **为什么改**：那句把删除说成"破坏规矩"，而这给人一种**做错事**的感觉 ——
               * 而按角色写的规矩里，**删除本来就是用户那一半的权限**。
               * **⇒ 该说清的是"代价是什么"，不是"你在违规"。**
               *
               * ⚠️ **0.3.22 又改了一次：不再写文件名**（接口清单第五节第 1 问）。
               * 原来那句是 "只能去 `公告-删除记录.md` 里查" —— 文件名被渲染成 `<code>`，
               * 暗色主题下成了"一块灰底 + 一段橙字"，**看起来像按钮，而点了没反应**。
               * ⇒ 两处一起改：`code` 的底色改成从文字颜色里调（见 CSS 开头那条）；
               *   这句话指向**面板里看得见的地方**（「健康」页的删除记录），文件名和路径在那一节底下，能复制。
               * （"打开记录文件"那个方向没做：浏览器里的面板打不开本机文件，要做就得后端加一个"替你打开"的路由 —— 不值。）
               *
               * ⚠️ 原来这里还挂着 `oap-warnline`（想让这句是警告色）—— **它从来没生效过**：
               * `.oap-hint` 在 CSS 里写在它后面，同样的权重后写的赢 ⇒ 一直是普通的次要文字色。
               * 现在干脆不挂了：上面那个提示条已经是警告色，这句就安安静静地说明"痕迹去哪了"。
               */
              h('span', null, renderInline('公告文件里**不会留下"这里删过一行"的痕迹**。删的时候会自动记一笔，在「健康」页的**删除记录**里能看到 —— 那是这一行唯一的去处。', 'del2'))),

            note !== null
              ? h('div', {
                className: `oap-callout${note.tone === 'error' ? ' is-error' : ''}`,
                role: 'alert',
              },
              icon(note.tone === 'error' ? 'alertCircle' : 'alert', 15, 'oap-callout-ic'),
              h('div', { className: 'oap-callout-b' },
                h('div', { className: 'oap-callout-t' }, note.title),
                note.detail ? h('div', { className: 'oap-callout-d' }, str(note.detail)) : null,
                note.action === 'refresh'
                  ? h('button', {
                    // 带 manual：自动刷新正卡着时，不带就会被跳过 ⇒ 点了没反应
                    type: 'button', className: 'oap-textbtn', onClick: () => { onClose(); void reload({ manual: true }); },
                  }, '刷新一下')
                  : null))
              : null),

          // 不可点时用 aria-disabled 而不是 disabled（和发布 / 编辑框一样）：真 disabled 会把键盘焦点丢掉
          h('div', { className: 'oap-dlg-f' },
            h('div', { className: 'oap-dlg-hint' }, sending ? '正在删…' : ''),
            h('button', {
              type: 'button', className: 'oap-btn', ref: cancelRef, 'aria-disabled': sending,
              onClick: () => { if (!sending) onClose(); },
            }, '取消'),
            h('button', {
              type: 'button', className: 'oap-btn is-danger', 'aria-disabled': sending,
              onClick: () => { if (!sending) void submit(); },
            }, sending ? '删除中…' : '删除'))));
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 发布 / 编辑 —— 面板内的对话框
     * ═══════════════════════════════════════════════════════════════════ */
    const TTL_PRESETS = [0, 7, 30];
    /**
     * 原来的有效期**没写或认不出**时，编辑框先替用户填这个数 —— 它是公告插件的默认天数（`defaultTtlDays`，默认 14）。
     * ⚠️ 0.3.22 之前填的是「长期」：改个错字、一保存，一条"默认 14 天"的公告就悄悄变成了长期。
     * 填 14 ⇒ 各桌那边的效果**多半不变**（除非有人改过那个默认值 —— 所以标签和确认对照里都会明说）。
     */
    const TTL_DEFAULT_GUESS = 14;

    function Composer({ mode, entry, revision, draft, onDraft, onClose, onDone, reload }) {
      const isEdit = mode === 'edit';
      const [init] = useState(() => {
        if (isEdit) {
          const days = ttlDaysOf(entry.ttl);
          return {
            text: decodeEntities(entry.summary),
            source: decodeEntities(entry.source),
            days: days === null ? TTL_DEFAULT_GUESS : days,
            ttlUnknown: days === null,
            publisher: entry.publisher,
          };
        }
        return draft || { text: '', source: '', days: 0, ttlUnknown: false, publisher: '用户' };
      });
      const [text, setText] = useState(init.text);
      const [source, setSource] = useState(init.source);
      const [publisher, setPublisher] = useState(init.publisher || '用户');
      const [choice, setChoice] = useState(TTL_PRESETS.includes(init.days) ? init.days : 'custom');
      const [custom, setCustom] = useState(TTL_PRESETS.includes(init.days) ? '' : String(init.days));
      const [step, setStep] = useState('form');
      const [sending, setSending] = useState(false);
      const [note, setNote] = useState(null);
      const [rev, setRev] = useState(revision);
      const [blocked, setBlocked] = useState(false);
      const taRef = useRef(null);
      const primaryRef = useRef(null);
      const dlgRef = useRef(null);
      const sendingRef = useRef(false);
      /** 焦点交给提交按钮（等这一帧渲染完再给）。 */
      const focusPrimary = () => requestAnimationFrame(() => { if (primaryRef.current) primaryRef.current.focus(); });

      const cleanText = oneLine(text);
      const cleanSource = oneLine(source);
      const cleanPublisher = oneLine(publisher) || '用户';
      const ttlDays = choice === 'custom' ? parseInt(custom, 10) : choice;
      const ttlOk = choice !== 'custom' || (Number.isInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 3650);
      const barErr = {
        text: hasBar(cleanText),
        source: hasBar(cleanSource),
        publisher: !isEdit && hasBar(cleanPublisher),
      };
      const valid = cleanText !== '' && ttlOk && !barErr.text && !barErr.source && !barErr.publisher;
      const textChanged = cleanText !== oneLine(init.text);
      const sourceChanged = cleanSource !== oneLine(init.source);
      const ttlChanged = init.ttlUnknown || ttlDays !== init.days;
      const changed = !isEdit || textChanged || sourceChanged || ttlChanged;
      const canSubmit = valid && changed && !sending && !blocked;

      // 打开时聚焦正文、光标放到最后；关掉时把焦点还回去
      useEffect(() => {
        const prev = document.activeElement;
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) { /* 忽略 */ }
        }
        return () => {
          try { if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus(); } catch (_) { /* 忽略 */ }
        };
      }, []);
      // 正文框跟着内容长高
      useEffect(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`;
      }, [text, step]);
      useEffect(() => { if (step === 'confirm' && primaryRef.current) primaryRef.current.focus(); }, [step]);

      const close = () => {
        if (sending) return;
        if (!isEdit) {
          const keep = text.trim() || source.trim();
          onDraft(keep ? { text, source, days: ttlOk ? ttlDays : 0, ttlUnknown: false, publisher } : null);
        }
        onClose();
      };

      const submit = async () => {
        if (!canSubmit || sendingRef.current) return;
        // 没有文件版本就不写：乐观锁拿不到，宁可让用户先刷新
        if (rev === null || rev === undefined || rev === '') {
          setNote({ tone: 'warn', title: '缺少文件版本', detail: '刷新一下拿到最新版本，再提交。', action: 'refresh' });
          return;
        }
        if (isEdit && step === 'form') { setStep('confirm'); setNote(null); return; }
        sendingRef.current = true;
        setSending(true);
        setNote(null);
        let res;
        if (isEdit) {
          res = await postJSON('/sidebar/api/office/announce/edit', {
            revision: rev,
            oldRaw: entry.raw,
            // 没改的字段原样送回（保留源文件里的写法，比如 &lt;）
            text: textChanged ? cleanText : entry.summary,
            source: sourceChanged ? cleanSource : entry.source,
            ttlDays,
          });
        } else {
          const payload = { revision: rev, text: cleanText, ttlDays, publisher: cleanPublisher };
          if (cleanSource !== '') payload.source = cleanSource;
          res = await postJSON('/sidebar/api/office/announce', payload);
        }
        sendingRef.current = false;
        setSending(false);
        if (res.kind === 'ok') {
          onDone({ mode, line: str(res.body && res.body.line), revision: res.body ? res.body.revision : undefined });
          return;
        }
        const n = explainWrite(res);
        if (n.blocked) setBlocked(true);
        setNote(n);
      };

      // 409 之后：用户点「刷新」才刷新（不自动重试），拿到新 revision 再让用户自己提交
      const refresh = async () => {
        if (sendingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        const next = await reload({ manual: true });
        sendingRef.current = false;
        setSending(false);
        if (next === null) {
          setNote({ tone: 'error', title: '刷新失败', detail: '读不到最新数据，稍后再试。写好的内容还在。', action: 'refresh' });
          return;
        }
        const stop = (title, detail) => {
          setBlocked(true);
          setStep('form');
          setNote({ tone: 'error', title, detail });
          focusPrimary();
        };
        if (next.canWrite === false) { stop('面板现在是只读的', '写好的内容还在，可以先复制下来。'); return; }
        if (next.announce.exists === false) { stop('公告文件不见了', '写好的内容还在，可以先复制下来。'); return; }
        setRev(next.announce.revision);
        if (isEdit && !next.announce.entries.some((x) => x.raw === entry.raw)) {
          stop('这一条已经被别处改过了', '文件里找不到原来那一行。关掉这个窗口，对最新的内容重新编辑（你改的文字还在，可以先复制）。');
          return;
        }
        setBlocked(false);
        setNote({ tone: 'ok', title: '已刷新到最新版本', detail: isEdit ? '这一条没被别人动过，可以再确认一次。' : '可以再发一次了。' });
        focusPrimary(); // 「刷新」按钮随提示一起消失，焦点交给提交按钮，按回车就能再提交
      };

      const onKeyDown = (ev) => {
        if (ev.nativeEvent && ev.nativeEvent.isComposing) return; // 输入法选字时不抢按键
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          if (step === 'confirm' && !sending) setStep('form');
          else close();
          return;
        }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          void submit();
          return;
        }
        // Tab 只在对话框里转圈，不跑到后面被盖住的面板上
        if (ev.key === 'Tab' && dlgRef.current) {
          const items = [...dlgRef.current.querySelectorAll('button, input, textarea, select')]
            .filter((el) => !el.disabled && el.offsetParent !== null);
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        }
      };

      const noteEl = note === null ? null : h('div', {
        className: `oap-callout${note.tone === 'error' ? ' is-error' : ''}${note.tone === 'ok' ? ' is-ok' : ''}`,
        role: 'alert',
      },
      icon(note.tone === 'ok' ? 'checkCircle' : 'alert', 15, 'oap-callout-ic'),
      h('div', { className: 'oap-callout-b' },
        h('div', { className: 'oap-callout-t' }, note.title),
        note.detail ? h('div', { className: 'oap-callout-d' }, note.detail) : null,
        note.action === 'refresh'
          ? h('button', { type: 'button', className: 'oap-textbtn', 'aria-disabled': sending, onClick: () => { void refresh(); } },
            sending ? '正在刷新…' : '刷新')
          : null));

      const barTip = '不能有全角竖线「｜」—— 公告文件用它分隔字段';
      const hasMd = /\*\*[^*]+\*\*|`[^`]+`/u.test(cleanText);
      const form = h('div', { className: 'oap-dlg-b' },
        h('label', { className: 'oap-field' },
          h('span', { className: 'oap-label' }, h('span', null, '一句话说清发生了什么'),
            h('span', { className: 'oap-label-r' }, `${cleanText.length} 字`)),
          h('textarea', {
            ref: taRef, className: `oap-textarea${barErr.text ? ' is-bad' : ''}`, rows: 3, value: text,
            placeholder: '比如：跨桌往来改走信箱，老收件箱已删除。可以用 **粗体** 和 `代码`',
            onChange: (ev) => setText(ev.target.value),
          }),
          barErr.text ? h('span', { className: 'oap-field-err' }, barTip) : null),
        hasMd
          ? h('div', { className: 'oap-field' },
            h('span', { className: 'oap-label' }, h('span', null, '预览')),
            h('div', { className: 'oap-preview' }, renderInline(cleanText, 'pv')))
          : null,
        h('label', { className: 'oap-field' },
          h('span', { className: 'oap-label' }, h('span', null, '详见'), h('span', { className: 'oap-label-r' }, '可不填')),
          h('input', {
            className: `oap-input${barErr.source ? ' is-bad' : ''}`, value: source,
            placeholder: '文档路径或位置，比如 00-通用\\信箱\\README-信箱怎么用.md',
            onChange: (ev) => setSource(ev.target.value),
          }),
          barErr.source ? h('span', { className: 'oap-field-err' }, barTip) : null),
        h('div', { className: 'oap-field' },
          h('span', { className: 'oap-label' }, h('span', null, '有效期'),
            /**
             * ⚠️ 原来的有效期面板认不出时（包括**没写**），这里说清楚 —— 保存时会写成下面选的那个，
             * 确认那一步的对照里也会列出来（`ttlChanged` 为真）。0.3.22 起"没写"也走这一档：
             * 原来"没写"被当成「长期」默默带过，**而各桌那边它是默认 14 天** ⇒ 改一下错字，有效期就悄悄变成了长期。
             */
            init.ttlUnknown
              ? h('span', { className: 'oap-label-r' }, decodeEntities(entry.ttl).trim() === ''
                ? `原来没写 —— 各桌按默认天数算，先填了 ${TTL_DEFAULT_GUESS} 天`
                : `原来写的是「${decodeEntities(entry.ttl)}」，各桌认不出 —— 先填了 ${TTL_DEFAULT_GUESS} 天`)
              : null),
          h('div', { className: 'oap-choices', role: 'group', 'aria-label': '有效期' },
            TTL_PRESETS.map((d) => h('button', {
              key: d, type: 'button', className: 'oap-choice', 'aria-pressed': choice === d, onClick: () => setChoice(d),
            }, d === 0 ? '长期' : `${d} 天`)),
            h('button', {
              type: 'button', className: 'oap-choice', 'aria-pressed': choice === 'custom', onClick: () => setChoice('custom'),
            }, '自定义'),
            choice === 'custom'
              ? h('span', { className: 'oap-days' },
                h('input', {
                  className: 'oap-input', type: 'number', min: 1, max: 3650, value: custom, autoFocus: true,
                  'aria-label': '天数', onChange: (ev) => setCustom(ev.target.value),
                }), '天')
              : null)),
        isEdit ? null : h('label', { className: 'oap-field' },
          h('span', { className: 'oap-label' }, h('span', null, '发布者'), h('span', { className: 'oap-label-r' }, '默认「用户」')),
          h('input', {
            className: `oap-input is-narrow${barErr.publisher ? ' is-bad' : ''}`, value: publisher, placeholder: '用户',
            onChange: (ev) => setPublisher(ev.target.value),
          }),
          barErr.publisher ? h('span', { className: 'oap-field-err' }, barTip) : null),
        noteEl);

      const diffRow = (label, before, after) => h('div', { key: label },
        h('div', { className: 'oap-diff-k' }, label),
        h('div', { className: 'oap-diff-v is-old' }, before ? renderInline(before, `${label}o`) : h('i', null, '（空）')),
        h('div', { className: 'oap-diff-v is-new' }, after ? renderInline(after, `${label}n`) : h('i', null, '（空）')));
      const confirmBody = isEdit ? h('div', { className: 'oap-dlg-b' },
        h('div', { className: 'oap-diff' },
          textChanged ? diffRow('一句话', entry.summary, cleanText) : null,
          sourceChanged ? diffRow('详见', entry.source, cleanSource) : null,
          ttlChanged ? diffRow('有效期', entry.ttl || '（没写）', ttlDays === 0 ? '长期' : `${ttlDays} 天`) : null),
        h('div', { className: 'oap-hint' }, '确认后会直接改写公告文件里原来那一行，日期和发布者保持原样。'),
        noteEl) : null;

      /**
       * ⚠️ **这句原来写的是"公告只增不改：发出去就删不掉，之后只能编辑。"**
       * —— **2026-10-01 之后它是错的**（面板能删了）。
       *
       * **⇒ 而"发出去就删不掉"这种话留在界面上是会真误导人的**：
       * 用户会以为只能忍，于是不去删那条误发的公告。
       *
       * **新措辞要说清两件事**：① 发出去**是会被别人看到的**（广播）；
       * ② **AI 只能追加，删改是用户的事**（所以他点这一下，不是在"违规"）。
       */
      /**
       * ⚠️ **这一整串和 `renderInline` 在同一行是有意的** ——
       * 探针里那条"塞进 JSX 却没渲染的 markdown"是**逐行**判的。
       * **⇒ 让"带 markdown 的那一行自己带上 renderInline"，一眼就能看出它过没过渲染。**
       *
       * ⚠️ 而我第一次改这里时**漏了这一步**（只改了措辞）⇒ 断言当场抓到。
       */
      let hint = renderInline('发出去就会被各桌看到。**AI 只能追加**；改和删是你的事（要过一次确认）。', 'hint');
      if (isEdit) hint = step === 'confirm' ? '' : (changed ? '下一步会让你再确认一次。' : '还没有改动。');
      const title = isEdit ? (step === 'confirm' ? '确认修改这条公告？' : '编辑公告') : '发布公告';
      const sub = isEdit
        ? [entry.publisher || '办公室', entry.date, entry.ttl].filter(Boolean).join(' · ')
        : `以「${cleanPublisher}」的身份发到办公室公告板`;

      return h('div', { className: 'oap-scrim' },
        // tabIndex -1：鼠标点到框里不能聚焦的地方（正文、标题）时，焦点落在框上而不是掉到 body ⇒ Esc 还管用
        h('div', { ref: dlgRef, className: 'oap-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'oap-dlg-title', tabIndex: -1, onKeyDown },
          h('div', { className: 'oap-dlg-h' },
            h('div', null,
              h('div', { className: 'oap-dlg-t', id: 'oap-dlg-title' }, title),
              h('div', { className: 'oap-dlg-s' }, sub)),
            h('button', {
              type: 'button', className: 'oap-ibtn is-sm', onClick: close, 'aria-disabled': sending,
              title: '关闭（Esc）', 'aria-label': '关闭',
            }, icon('x', 14))),
          step === 'confirm' ? confirmBody : form,
          // 不可点的按钮用 aria-disabled 而不是 disabled：真 disabled 会把键盘焦点丢掉，Esc / Tab 就失灵了
          h('div', { className: 'oap-dlg-f' },
            /**
             * ⚠️ **`hint` 已经在它自己的定义处过了 `renderInline`**（见上面那段注释）——
             * **这里不要再包一层**（我给"发布"那句包了，而它是**假设**；
             * 编辑那几个分支是纯文本，也走同一条渲染路径，**多包一次就是双层节点**）。
             */
            hint ? h('div', { className: 'oap-dlg-hint' }, hint) : null,
            step === 'confirm'
              ? h(Fragment, null,
                h('button', {
                  type: 'button', className: 'oap-btn', 'aria-disabled': sending,
                  onClick: () => { if (!sending) { setStep('form'); setNote(null); } },
                }, '返回修改'),
                h('button', {
                  ref: primaryRef, type: 'button', className: 'oap-btn is-primary', 'aria-disabled': !canSubmit,
                  onClick: () => { void submit(); },
                }, sending ? '正在保存…' : '确认修改'))
              : h(Fragment, null,
                h('button', { type: 'button', className: 'oap-btn', 'aria-disabled': sending, onClick: close }, '取消'),
                h('button', {
                  ref: primaryRef, type: 'button', className: 'oap-btn is-primary', 'aria-disabled': !canSubmit,
                  title: 'Ctrl / ⌘ + Enter', onClick: () => { void submit(); },
                }, isEdit ? '保存修改…' : (sending ? '正在发布…' : '发布'))))));
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 主视图
     * ═══════════════════════════════════════════════════════════════════ */

    /** 错误边界：面板自己出错时显示一张错误卡，不让整张卡片变空白。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try { console.error('[办公室面板] 渲染出错：', error); } catch (_) { /* 忽略 */ }
      }

      render() {
        const { error } = this.state;
        if (error === null) return this.props.children;
        return h('div', { className: 'oap-root' }, h('div', { className: 'oap-body' }, h('div', { className: 'oap-wrap' },
          h('div', { className: 'oap-callout is-error' },
            icon('alertCircle', 15, 'oap-callout-ic'),
            h('div', { className: 'oap-callout-b' },
              h('div', { className: 'oap-callout-t' }, '办公室面板渲染出错了'),
              h('div', { className: 'oap-callout-d oap-mono' }, str(error && error.message ? error.message : error)),
              h('button', { type: 'button', className: 'oap-textbtn', onClick: () => this.setState({ error: null }) }, '重试'))))));
      }
    }

    const TABS = [['announce', '公告'], ['dispatch', '投递'], ['health', '健康']];

    function OfficePanelBody(props) {
      /** ⭐ 组件这一半的样式引用（和 `apply` 那一半各自计数 —— 见 `acquirePanelCss` 的注释）。 */
      useEffect(() => acquirePanelCss(), []);
      const visible = props.visible !== false;
      const { data, err, busy, loading, loadedAt, active, reload, patch, deletions, delAsked } = useOfficeData(visible);
      const rootRef = useRef(null);
      const width = useWidthMode(rootRef);
      const [view, setViewState] = useState(readView);
      const [onlyNew, setOnlyNew] = useState(false);
      const [aQuery, setAQuery] = useState('');
      const [pub, setPub] = useState('');
      const [dQuery, setDQuery] = useState('');
      const [seg, setSeg] = useState('auto');
      const [composer, setComposer] = useState(null);
      /** ⭐ 删除确认框（2026-10-01）—— 和 `composer` 分开，因为它是另一件事。 */
      const [confirmDel, setConfirmDel] = useState(null);
      /** ⭐ 从公告页跳到「健康 → 删除记录」（0.3.22）：`{ q, n }`，删除记录那一节用完就清掉。 */
      const [delJump, setDelJump] = useState(null);
      const [toast, setToast] = useState(null);
      const [flashRaw, setFlashRaw] = useState('');
      /** 「上次看过时」的条数 —— 比它多出来的就是新的（公告只增不改，新的一定在末尾）。 */
      const [baseline, setBaseline] = useState(null);
      const leftAt = useRef(null);
      const bodyRef = useRef(null);
      const draftRef = useRef(null);
      const mineRef = useRef(new Set());
      const timers = useRef({});
      const scrollMemo = useRef({});
      const tabRefs = useRef([]);

      useEffect(() => () => { Object.values(timers.current).forEach((t) => clearTimeout(t)); }, []);

      /** 切分栏：记住每个分栏滚到哪了，切回来还在原处。 */
      const switchTab = useCallback((next) => {
        if (bodyRef.current) scrollMemo.current[view] = bodyRef.current.scrollTop;
        setViewState(next);
        saveView(next);
      }, [view]);
      useLayoutEffect(() => {
        if (bodyRef.current) bodyRef.current.scrollTop = scrollMemo.current[view] || 0;
      }, [view]);

      useEffect(() => {
        if (data === null) return;
        const n = data.announce.entries.length;
        // 第一次读到时定基线；万一文件变短了（被人整理过），基线跟着缩，免得漏标
        if (baseline === null || n < baseline) setBaseline(n);
      }, [data, baseline]);
      // 看不见时记下条数；回来时，离开期间新到的就标成「新」
      useEffect(() => {
        if (!active) {
          if (data !== null) leftAt.current = data.announce.entries.length;
          return;
        }
        if (leftAt.current !== null) {
          setBaseline(leftAt.current);
          leftAt.current = null;
        }
      }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

      const say = useCallback((text, tone) => {
        setToast({ text, tone: tone || 'ok', n: Date.now() });
        clearTimeout(timers.current.toast);
        timers.current.toast = setTimeout(() => setToast(null), 2600);
      }, []);
      const flash = useCallback((raw) => {
        setFlashRaw(raw);
        clearTimeout(timers.current.flash);
        timers.current.flash = setTimeout(() => setFlashRaw(''), 2800);
      }, []);
      const copy = useCallback(async (text) => {
        const ok = await copyText(text);
        say(ok ? '已复制' : '复制失败', ok ? 'ok' : 'bad');
      }, [say]);

      const canWrite = data !== null && data.canWrite !== false;
      const openPublish = useCallback(() => {
        if (data !== null) setComposer({ mode: 'publish', revision: data.announce.revision, n: Date.now() });
      }, [data]);
      const openEdit = useCallback((e) => {
        if (data !== null) setComposer({ mode: 'edit', entry: e, revision: data.announce.revision, n: Date.now() });
      }, [data]);

      /**
       * ⭐ **打开删除确认框**（2026-10-01）—— 和 `openEdit` 是同一个形状，
       * 但**不共用 `composer`**：删除没有草稿、没有两步编辑，是另一件事。
       *
       * ⚠️ **必须带上 `e.seenBy`** —— 确认框那句"有 N 个会话见过这条"
       * 用的就是它（后端算好放进了 `announce.entries` 里）。
       */
      const openDelete = useCallback((e) => {
        if (data !== null) setConfirmDel({ entry: e, revision: data.announce.revision, n: Date.now() });
      }, [data]);

      /** 删完之后：清掉框、更新版本号、闪一下、告诉用户，然后重读一遍。 */
      const logCheck = useRef(null);
      const onDeleted = useCallback(({ removed, revision, logged }) => {
        setConfirmDel(null);
        if (revision !== undefined && revision !== null && revision !== '') {
          patch((d) => (d === null ? d : { ...d, announce: { ...d.announce, revision } }));
        }
        /**
         * ⚠️ **要从"自己发过的"集合里也去掉它** ——
         * 否则以后万一有内容完全相同的行，它会被当成"我刚发的"，**不显示「新」标记**。
         */
        mineRef.current.delete(removed);
        /**
         * ⚠️ **"记在删除记录里"不能想当然地说**（0.3.22 复查时补的）。
         *
         * 后端的规矩是"记账失败不否定删除"：记录写不进只打一行 warn，删除照样回 200。
         * 而它**真的静默失败过**（`body` 变量名撞车那次 —— 每一次删除都没记上，界面照样说成功）。
         * ⇒ ⚠️ **后端现在会回 `logged`**（2026-10-03 改准这句：原来写的是"没回（现在的后端）"），
         *   所以正常情况下走的是上面两条真话；**"没回"那档只剩异常情形** ——
         *   那时先只说"已删除"，等刷新拿到删除记录**对一下有没有这一笔**（下面那个 effect），
         *   有就补一句"记在哪"，没有就提醒。
         */
        if (logged === false) say('删掉了，但删除记录没记上 —— 看后台日志', 'bad');
        else say(logged === true ? '已删除 · 记在「健康」页的删除记录里' : '已删除');
        logCheck.current = logged === true || logged === false
          ? null
          : { want: str(removed).trim().slice(0, RAW_KEEP).trim(), before: deletions === null ? null : deletions.total };
        void reload({ manual: true });
      }, [say, reload, patch, deletions]);
      useEffect(() => {
        const c = logCheck.current;
        if (c === null || deletions === null) return;   // 问不到删除记录 ⇒ 这次不判断（不瞎报），等下一次
        logCheck.current = null;
        const hit = deletions.entries.some((e) => e.raw === c.want) && (c.before === null || deletions.total > c.before);
        if (hit) say('已删除 · 记在「健康」页的删除记录里');
        else say('删掉了，但删除记录里没找到这一笔 —— 看后台日志', 'bad');
      }, [deletions]); // eslint-disable-line react-hooks/exhaustive-deps
      const onDone = useCallback(({ mode, line, revision }) => {
        setComposer(null);
        // 先把新版本号记上（下一次提交不用等刷新），再去读一遍权威的文件内容
        if (revision !== undefined && revision !== null && revision !== '') {
          patch((d) => (d === null ? d : { ...d, announce: { ...d.announce, revision } }));
        }
        if (mode === 'publish') {
          draftRef.current = null;
          if (line) mineRef.current.add(line); // 自己刚发的不算「新」
          setOnlyNew(false);
          setAQuery('');
          setPub('');
          if (view !== 'announce') switchTab('announce');
          if (bodyRef.current) bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (line) flash(line);
        say(mode === 'publish' ? '已发布' : '已修改');
        void reload({ manual: true });
      }, [flash, say, reload, patch, view, switchTab]);

      const parsed = useMemo(() => parseStatus(data === null ? '' : data.status.markdown), [data]);
      const picked = useMemo(() => pickSections(parsed), [parsed]);
      const deskNames = useMemo(() => (data === null ? {} : deskNamesFrom(data.status.markdown)), [data]);
      /**
       * 删除记录 → 显示行（拆好被删那一行、解析好时间、给个稳定的 key）。算一次，健康页和公告页（跨页指路）共用。
       * ⚠️ 这只是**派生**出来给界面用的；`deletions` 本身原样留着（`null` 还是 `null`）。
       */
      const delRows = useMemo(() => {
        if (deletions === null) return [];
        const seen = {};
        return deletions.entries.map((e) => {
          const base = `${e.at}|${e.raw}`;
          seen[base] = (seen[base] || 0) + 1;
          // 时间不带偏移的 = 旧版后端写的 = 原文可能被截过（新版存整行，见 mayBeCut）
          return { ...e, f: parseDeletedLine(e.raw, !hasZone(e.at)), when: parseAt(e.at), key: `${base}#${seen[base]}` };
        });
      }, [deletions]);
      const delTotal = deletions === null || deletions.exists === false ? 0 : Math.max(deletions.total, delRows.length);
      const jumpToDeletions = useCallback((q) => {
        setDelJump({ q: str(q), n: Date.now() });
        switchTab('health');
      }, [switchTab]);
      const jumpDone = useCallback(() => setDelJump(null), []);
      const nPending = countOf(picked.pending);
      const nSessions = countOf(picked.sessions);
      let newCount = 0;
      if (data !== null && baseline !== null) {
        data.announce.entries.forEach((e, i) => { if (i >= baseline && !mineRef.current.has(e.raw)) newCount += 1; });
      }

      /* ── 顶部 ──────────────────────────────────────────────────────── */
      const stat = (target, n, label, hot, extra) => h('button', {
        key: target, type: 'button', className: `oap-stat${hot ? ' is-hot' : ''}`,
        onClick: () => { switchTab(target); if (target === 'dispatch') setSeg('pending'); },
        title: `到「${TABS.find((t) => t[0] === target)[1]}」`,
      }, h('span', { className: 'oap-stat-n' }, data === null || n === null ? '—' : n),
      h('span', { className: 'oap-stat-l' }, label, extra || null));

      const onTabKey = (ev, i) => {
        let j = null;
        if (ev.key === 'ArrowRight') j = (i + 1) % TABS.length;
        if (ev.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
        if (ev.key === 'Home') j = 0;
        if (ev.key === 'End') j = TABS.length - 1;
        if (j === null) return;
        ev.preventDefault();
        switchTab(TABS[j][0]);
        if (tabRefs.current[j]) tabRefs.current[j].focus();
      };
      const tabExtra = (id) => {
        if (data === null) return null;
        if (id === 'announce') {
          return h(Fragment, null,
            h('span', { className: 'oap-tab-n' }, data.announce.count),
            view !== 'announce' && newCount > 0 ? h('span', { className: 'oap-tab-dot', title: `${newCount} 条新公告` }) : null);
        }
        if (id === 'dispatch' && nPending !== null) {
          return h('span', { className: `oap-tab-n${nPending > 0 ? ' is-hot' : ''}`, title: nPending > 0 ? `${nPending} 张单子待取` : undefined }, nPending);
        }
        return null;
      };

      const head = h('div', { className: 'oap-head' }, h('div', { className: 'oap-head-in' },
        h('div', { className: 'oap-titlebar' },
          h('span', { className: 'oap-mark', 'aria-hidden': 'true' }, icon('office', 18)),
          h('div', { className: 'oap-titles' },
            h('h2', { className: 'oap-title' }, '办公室'),
            h('div', { className: 'oap-subtitle' }, '公告与跨桌投递')),
          h('button', {
            type: 'button', className: `oap-ibtn${busy ? ' oap-spin' : ''}`, 'aria-disabled': busy,
            onClick: () => { if (!busy) void reload({ manual: true }); }, title: '刷新：立刻重新读一次', 'aria-label': '刷新',
          }, icon('refresh', 16)),
          canWrite && data.announce.exists !== false
            ? h('button', { type: 'button', className: 'oap-publish', onClick: openPublish }, icon('plus', 15), '发布公告')
            : null),
        h('div', { className: 'oap-stats' },
          stat('announce', data === null ? null : data.announce.count, '公告', false,
            newCount > 0 ? h('b', null, ` · 新 ${newCount}`) : null),
          stat('dispatch', nPending, '待取单子', (nPending || 0) > 0),
          stat('health', nSessions, '认过桌的会话', false)),
        h('div', { className: 'oap-tabs', role: 'tablist', 'aria-label': '办公室分栏' },
          TABS.map(([id, label], i) => h('button', {
            key: id, ref: (el) => { tabRefs.current[i] = el; }, type: 'button', role: 'tab', className: 'oap-tab',
            id: `oap-tab-${id}`, 'aria-selected': view === id, 'aria-controls': 'oap-panel', tabIndex: view === id ? 0 : -1,
            onClick: () => switchTab(id), onKeyDown: (ev) => onTabKey(ev, i),
          }, label, tabExtra(id))))));

      /* ── 内容 ──────────────────────────────────────────────────────── */
      let content;
      if (data === null && err === null) {
        content = h('div', { className: 'oap-stack', 'aria-busy': 'true', 'aria-label': '读取中…' }, [0, 1, 2].map((i) => h('div', { key: i, className: 'oap-skel' },
          h('i', { style: { width: '30%' } }), h('i', { style: { width: '94%' } }), h('i', { style: { width: '62%' } }))));
      } else if (data === null) {
        content = h(EmptyState, {
          ic: 'alertCircle', title: '读不到数据',
          action: h('button', { type: 'button', className: 'oap-btn', 'aria-disabled': busy, onClick: () => { if (!busy) void reload({ manual: true }); } },
            icon('refresh', 14), '重试'),
        },
        h('div', { className: 'oap-mono' }, err),
        h('div', { className: 'oap-path' }, '数据来自宿主半边的只读路由 /sidebar/api/office。装好后需要硬刷新页面。'));
      } else if (view === 'dispatch') {
        content = h(DispatchView, { key: 'dispatch', data, parsed, picked, seg, setSeg, query: dQuery, setQuery: setDQuery });
      } else if (view === 'health') {
        content = h(HealthView, {
          key: 'health', data, parsed, picked, onCopy: copy, deletions, delAsked, delRows, deskNames, delJump, onJumpDone: jumpDone,
        });
      } else {
        content = h(AnnounceView, {
          key: 'announce', data, baseline, mine: mineRef.current, onlyNew, setOnlyNew,
          query: aQuery, setQuery: setAQuery, pub, setPub,
          canWrite, onEdit: openEdit, onDelete: openDelete, onCopy: copy, flashRaw, deskNames,
          delRows, delTotal, onJumpDeletions: jumpToDeletions,
        });
      }

      /* ── 页脚：刷新状态 ────────────────────────────────────────────── */
      let statusCls = '';
      let statusText = '可见时每 20 秒刷新';
      if (err !== null && data !== null) { statusCls = ' is-bad'; statusText = `刷新失败（${err}）· 显示的是 ${fmtHM(loadedAt)} 读到的内容`; }
      else if (err !== null) { statusCls = ' is-bad'; statusText = '读不到数据'; }
      else if (loading) { statusCls = ' is-busy'; statusText = '正在更新…'; }
      else if (!active) { statusCls = ' is-idle'; statusText = '看不见时暂停刷新'; }
      const readAt = data === null ? 0 : (data.readAt || loadedAt);

      return h('div', { ref: rootRef, className: `oap-root${width ? ` is-${width}` : ''}` },
        head,
        h('div', {
          className: 'oap-body', ref: bodyRef, id: 'oap-panel', role: 'tabpanel', 'aria-labelledby': `oap-tab-${view}`,
        }, h('div', { className: 'oap-wrap' },
          err !== null && data !== null
            ? h('div', { className: 'oap-callout is-spaced' },
              icon('alert', 15, 'oap-callout-ic'),
              h('div', { className: 'oap-callout-b' },
                h('div', { className: 'oap-callout-t' }, '最近一次刷新失败'),
                h('div', { className: 'oap-callout-d' }, `${err} · 下面是 ${fmtHM(loadedAt)} 读到的内容`),
                h('button', { type: 'button', className: 'oap-textbtn', 'aria-disabled': busy, onClick: () => { if (!busy) void reload({ manual: true }); } }, '再试一次')))
            : null,
          content)),
        h('div', { className: 'oap-status' }, h('div', { className: `oap-status-in${statusCls}` },
          h('span', { className: 'oap-live-dot' }),
          h('span', { className: 'oap-status-t' }, statusText),
          h('span', { className: 'oap-status-r' },
            /**
             * ⚠️⚠️ **版本号从这儿搬走了**（2026-10-01，用户定）。
             *
             * ## 原来在这儿的是什么
             *
             * 一行恒常显示的 `v${data.panelVersion}` —— 而它读的是**后端**的版本号。
             *
             * ### ⚠️ 而它有个致命缺陷：**它会撒谎**
             *
             * 后端是新的、浏览器还跑着旧的 `client.js` 时，**页脚照样显示新版本号。**
             * **⇒ 那正是那天把我骗惨的局面**：水印说"新版"，而界面上一个新东西都没有 ——
             * 我于是**排除了"前端是旧的"这个可能**，然后编了一整套错的缓存推理
             * （见 `docs\06` 二.7，真凶其实是 `normalizeData` 那个白名单）。
             *
             * ## 现在在哪儿
             *
             * **「健康」页的「版本」小节** —— 前端（`FE_VERSION`，写死在这个文件里）
             * 和后端（接口给的）**并排显示，还带一句"一致吗"**。
             *
             * **当时那句话是**：*"放进健康里吧，而且和健康这个词匹配，点开就可以查看插件的状态健康。"*
             *
             * **⇒ 页脚那个位置本来就是错的**：版本号是**排查时才想知道**的事，
             * 而页脚是**每天都看**的地方 —— 常驻的噪音换不来那点便利。
             */
            readAt ? h('span', { title: new Date(readAt).toLocaleString() }, `读取于 ${fmtHM(readAt)}`) : null,
            data !== null && data.canWrite === false ? h('span', { className: 'oap-ro' }, icon('lock', 10), '只读') : null))),
        composer !== null
          ? h(Composer, {
            key: composer.n,
            mode: composer.mode,
            entry: composer.entry,
            revision: composer.revision,
            draft: draftRef.current,
            onDraft: (d) => { draftRef.current = d; },
            onClose: () => setComposer(null),
            onDone,
            reload,
          })
          : null,
        /** ⭐ 删除确认框（和 `Composer` 平级，互斥不了 —— 一次只会有一个开着）。 */
        confirmDel !== null
          ? h(ConfirmDelete, {
            key: `del-${confirmDel.n}`,
            entry: confirmDel.entry,
            revision: confirmDel.revision,
            deskName: deskNameOf(deskNames, confirmDel.entry.publisher),
            /** 三档原样往下传（`true` / `false` / `null` = 不知道）；确认框只在 `=== false` 时多说一句。 */
            seenByFiltered: data === null ? null : data.seenByFiltered,
            onClose: () => setConfirmDel(null),
            onDone: onDeleted,
            reload,
          })
          : null,
        toast !== null
          ? h('div', { key: toast.n, className: 'oap-toast', role: 'status' },
            icon(toast.tone === 'bad' ? 'alertCircle' : 'check', 14), toast.text)
          : null);
    }

    /**
     * ⭐⭐ **面板样式的那一个 `<style>` 节点**（2026-10-04 加）。
     *
     * ## 为什么要有这一套
     *
     * 面板的**全部样式**就靠一个 `<style>` 撑着（见下面 `apply`）✓。
     * 原来是"**谁 apply 谁删**" ✗ —— 而**插件被卸载/重载、却没重新 `apply`** 的那一刻，
     * 节点被删掉了、**面板还在渲染** ✗ ⇒ 界面变成**裸 DOM**：
     * 统计卡退回浏览器给 `<button>` 的默认小方块、页签和公告条目全挤成纯文字 ✗
     * （2026-10-04 用户真撞上 ✓，还一度以为"面板坏了 / 版本旧了" ✗ —— 而 CSS 其实一个字都没变 ✓）。
     *
     * ## 现在
     *
     * | 函数 | 干什么 |
     * |---|---|
     * | `acquirePanelCss()` | **引用计数 +1**，返回释放函数 —— **插件和组件各持一份** ✓<br>⇒ 两边都走了才真删 ✓（正常卸载不留垃圾 ✓） |
     * | `ensurePanelCss()` | **每次渲染都查一下节点还在不在** ✓，不在就补上 ✓<br>⇒ 不管中间被谁删掉，**下一次渲染就自愈** ✓✓ |
     */
    let cssNode = null;
    let cssRefs = 0;
    function panelCssNode() {
      if (cssNode === null) {
        cssNode = document.createElement('style');
        cssNode.dataset.dshPlugin = 'dsh-bulletin-panel';
        cssNode.textContent = CSS;
      }
      return cssNode;
    }
    function acquirePanelCss() {
      const el = panelCssNode();
      if (!el.isConnected) document.head.appendChild(el);
      cssRefs += 1;
      return () => {
        cssRefs -= 1;
        if (cssRefs <= 0 && el.isConnected) el.remove();
      };
    }
    function ensurePanelCss() {
      const el = panelCssNode();
      if (!el.isConnected) document.head.appendChild(el);
    }

    /** 注册给宿主的组件（一个函数组件）：外面包一层错误边界。 */
    function OfficePanel(props) {
      /**
       * ⭐⭐ **每次渲染都确认样式还在**（2026-10-04 加）—— 这是"自愈"那一步 ✓。
       * 放在渲染里而不是 `useEffect` 里，是因为**effect 只在挂载时跑一次** ✗：
       * 插件被卸载重载后组件并不一定重新挂载 ⇒ 挂载型 effect 补不回来 ✓。
       * （这个调用是幂等的、只做两次属性读 ✓，代价可以忽略 ✓。）
       */
      ensurePanelCss();
      return h(Boundary, null, h(OfficePanelBody, props));
    }

    return {
      inject: ['betterSidebar'],
      apply(ctx) {
        /**
         * 样式**引用计数 +1**（2026-10-04 改）。
         *
         * ⚠️ 原来是"**谁 apply 谁删**"：插件被卸载/重载而没重新 `apply` 时，
         * 那个 `<style>` 就被删了，而**面板还在渲染** ⇒ 界面裸掉 ✗
         * （用户 2026-10-04 真撞上 ✓）。现在**插件和组件各持一份引用**，两位都走了才真删 ✓。
         */
        ctx.effect(() => acquirePanelCss());

        /**
         * ⚠️ **这里曾经挂过一个"前端构建标记"**（`办公室·b4`，2026-10-01 加的，**已撤**）。
         *
         * ## 它为什么被加、又为什么被撤
         *
         * 那天排一个怪现象：**后端明明是新版，界面上却看不到新加的东西。**
         * 而**界面上没有任何地方能看出"浏览器跑的是哪一版 `client.js`"** ⇒ 只能猜。
         * ⇒ 我在标签标题上加了个记号，用来一刀切开"前端旧 / 后端旧"。
         *
         * **它确实起了作用**（用户一看标签就知道前端是新的），
         * **但最后真凶在别处**（`normalizeData()` 那个白名单把新字段吃了）。
         *
         * ## ⇒ 撤掉它的理由
         *
         * **它是个调试脚手架，而「健康」页的「面板版本」已经把这个需求永久接管了** ——
         * 那里**前端（`FE_VERSION`）和后端（读 `package.json`）并排、还说一句一不一致**。
         * （⚠️ 这段原来写的是"页脚那个 `v0.3.12` 徽章" —— 徽章后来搬进了健康页，0.3.22 顺手把这句改对。）
         * ⇒ **留两个"版本记号"只会让人分不清该信哪个。**
         */
        ctx.effect(() => ctx.betterSidebar.registerTab({
          id: 'bulletin-panel',
          title: '办公室',
          description: '办公室公告（可发布、编辑）、跨桌投递与运行信息',
          order: 60,
          single: true,
          component: OfficePanel,
        }));
      },
    };
  },
});
