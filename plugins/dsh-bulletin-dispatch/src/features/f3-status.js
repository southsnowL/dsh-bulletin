/**
 * 功能 1 · **送达状态表**（给人看的仪表盘）。
 *
 * ## 的四条（2026-09-30，实现前先对过）
 *
 * | 项 | 决定 |
 * |---|---|
 * | **给谁看** | **用户自己** —— 一个窗口，**不需要任何人去核对它** |
 * | **写什么** | 单子清单与状态 · 最近的取走记录 · **插件与存储的健康信息** |
 * | **何时写** | **状态真的变了才写**（发单 / 取走 / 认桌改名 触发） |
 * | **落盘确认** | ⭐ **`flush()` 之后再 `stat()`** —— 真确认，不是假阳性 |
 *
 * ## ⚠️ 我对开工包做了三处更正（实测证据见 `进度与待办.md`）
 *
 * | 开工包 | 实际 |
 * |---|---|
 * | 用 `stat()` 确认"真的落盘了" | **`stat()` 不证明落盘**（契约：backend 延迟物理落盘时 `stat` 也看得到）⇒ 要先 `flush()` |
 * | `stat` 给 `revision` + `size` | 实际是 `{ header, revision, sizeBytes }`，**`eventCount` 是 `undefined`** |
 * | 拿 `revision` 判"变没变" | 实测 **`flush()` 前后 revision 不变**（它是**内容**指纹）⇒ 不能当"落盘信号" |
 *
 * ## ⚠️ 它是**派生视图，不是权威**（开工包的原则，照办）
 *
 * 全部内容都从 `tickets` / `claims` / 会话表**现算**，**不另存一份会漂移的状态**。
 * 另外：**它没有 5 秒防抖**（开工包提过）—— 用"写入/取走的瞬间"触发就够，
 * 防抖只会让仪表盘**滞后**。
 */
import { errText, safe } from '../log.js';
import {
  CLAIMS_KEEP, lastFileError, lastWrite, listRecords, putTracked, readTextFile, sanitizeText, writeTextFile,
} from '../store.js';

/** 本功能的配置键（与 `index.js` 的开关同名）。 */
export const FEATURE = 'status';

/** 取走记录里最多显示几条（文件里存的是有界的 `CLAIMS_KEEP` 条）。 */
const CLAIMS_SHOWN = 8;

/** 最近一次"落盘确认"的结果（给仪表盘用）。 */
const durability = {
  at: null, ok: null, ms: null, error: null,
  sessionId: null, revision: null, revisionChanged: null,
};

/** 最近一次"状态文件自己"的写入结果。 */
const lastStatusWrite = { at: null, ok: null, error: null, file: null };

let dirty = false;
let scheduled = false;

/** 把时间戳格式化成 `MM-DD HH:mm`（本地时区，给人看）。 */
function stamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `桌 04` 这种显示名；认不出的桌原样显示。 */
function deskName(desk, deskNames) {
  if (typeof desk !== 'string' || desk === '') return '（未知）';
  if (desk === '办公室') return '办公室';
  const label = deskNames?.[desk];
  return label === undefined ? `桌 ${desk}` : `桌 ${desk}（${label}）`;
}

/** 会话 id 缩短显示（只留尾部一段，够认出是谁）。 */
function shortSession(id) {
  if (typeof id !== 'string') return '—';
  return id.length <= 18 ? id : `…${id.slice(-16)}`;
}

/** 表格里的一个单元格：把 `|` 转义掉，免得把表格撑破。 */
function cell(text) {
  return String(text ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ').trim();
}

/**
 * 生成**派生视图**（纯函数：只读存储，不写任何东西）。
 *
 * @param {object} p
 * @param {object} p.store 存储表
 * @param {object} p.config 插件配置
 * @param {string} p.version 插件版本
 * @param {object} [p.health] ⭐ **"写了没人看"的那些东西**（2026-10-01 加，见下面"健康"段）
 *   `{ lastFileError, problems, fileTableCount }`
 * @returns {string} markdown
 */
export function renderStatus({ store, config, health }) {
  const deskNames = config?.deskNames ?? {};
  const now = Date.now();

  /**
   * ⭐ **会话号 → 人看得懂的称呼**（2026-09-30："只有会话编号，有的不太好看"）。
   *
   * ## 问题
   *
   * 状态表里好几列原来只显示 `…cec-88e78eef6baa` 这种**截断的会话号** ——
   * 对人不友好：**我不认识那个号，我只想知道"是哪张桌、哪个会话"**。
   *
   * ## 修法
   *
   * `sessions` 表里**本来就有** `desk` 和 `title` ⇒ 建一张映射，显示成：
   *
   * ```
   * 桌 02（环境维护）· 02-环境维护
   * ```
   *
   * ⚠️ 三个边界：
   * | # | 边界 |
   * |---|---|
   * | **1** | **查不到就退回会话号**（不假装认识它 —— 认过的会话才在表里） |
   * | **2** | **会话号仍然保留在括号里/标题里** —— 需要精确对照时还找得到（别把信息删掉） |
   * | **3** | 这是**约定要给人看**的（本文件顶部就写着"派生视图"）⇒ 可读性优先 |
   */
  const sessionLabels = new Map();
  for (const [id, rec] of listRecords(store.tables.sessions)) {
    if (rec === null || typeof rec !== 'object') continue;
    const desk = typeof rec.desk === 'string' && rec.desk !== '' ? rec.desk : null;
    const title = typeof rec.title === 'string' && rec.title !== '' ? rec.title : null;
    if (desk === null && title === null) continue;
    sessionLabels.set(id, {
      desk: desk === null ? null : deskName(desk, deskNames),
      title,
    });
  }

  /**
   * 会话的可读称呼。
   *
   * @param {string} id 会话号
   * @returns {string} 形如 `桌 02（环境维护）· 02-环境维护`；查不到就退回截断的会话号
   */
  function who(id) {
    const hit = sessionLabels.get(id);
    if (hit === undefined) return `\`${shortSession(id)}\``;   // ⚠️ 边界 1：查不到就如实显示号
    const parts = [];
    if (hit.desk !== null) parts.push(hit.desk);
    if (hit.title !== null) parts.push(hit.title);
    return parts.join(' · ');
  }

  /** 同上，但**把会话号留在括号里**（给人核对用）。 */
  function whoWithId(id) {
    const hit = sessionLabels.get(id);
    return hit === undefined
      ? `\`${shortSession(id)}\``
      : `${who(id)}（\`${shortSession(id)}\`）`;
  }

  // ── 单子：待取的 / 已取的 ────────────────────────────────────────────────
  const pending = [];
  const taken = [];
  for (const [id, rec] of listRecords(store.tables.tickets)) {
    const row = { id, ...rec };
    if (rec?.takenBy === null || rec?.takenBy === undefined) pending.push(row);
    else taken.push(row);
  }
  pending.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  taken.sort((a, b) => (b.takenAt ?? b.at ?? 0) - (a.takenAt ?? a.at ?? 0));
  /** ⭐ **按单号查单子** —— "最近的取走记录"里老记录没有 `source`，要靠它兜底。 */
  const ticketsById = new Map([...pending, ...taken].map((t) => [String(t.id), t]));

  // ── 取走历史（自己有界；这里只显示最近几条）──────────────────────────────
  const claims = listRecords(store.tables.claims)
    .map(([key, rec]) => ({ key, ...rec }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const recent = claims.slice(0, CLAIMS_SHOWN);

  // ── 会话（按桌分组）─────────────────────────────────────────────────────
  /**
   * ⚠️⚠️ **要连 key 一起留着**（2026-09-30 修）。
   *
   * 原文是 `.map(([, rec]) => rec)` —— **把 key 丢了**。
   * 而 `sessions` 表的 key **就是会话号** ⇒ 于是**老记录（没有 `sessionId` 字段的那些）
   * 明明有号，却渲染成 `—`**（"有数据却说没有"）。
   *
   * ⇒ 现在保留 `id`（＝存储 key），取号时 `s.sessionId ?? s.id` 两道兜底。
   */
  const sessions = listRecords(store.tables.sessions)
    .map(([id, rec]) => ({ id, ...rec }))
    .filter((rec) => rec !== null && typeof rec === 'object');

  const lines = [];
  lines.push('# 投递状态（插件自动生成 —— **不要手改，改了会被覆盖**）');
  lines.push('');
  lines.push(
    `生成时间 ${stamp(now)} ｜ 插件 \`dsh-bulletin-dispatch\` ${config?.__version ?? '?'}`
    + ` ｜ 存储 ${store.where === 'domain' ? '平台存储域' : '文件'}`
    + ` ｜ 待取 ${pending.length} · 已取 ${taken.length}`,
  );
  lines.push('');

  // ── ① 待取的单子（最重要的一段，放最前）────────────────────────────────
  lines.push(`## 待取的单子（${pending.length}）`);
  lines.push('');
  if (pending.length === 0) {
    lines.push('（没有待取的单子。）');
  } else {
    /**
     * ## ⭐⭐ **加了「谁投的」这一列**（2026-10-02）
     *
     * ### 为什么（**它是被看到的**）
     *
     * 用户看着面板问：*"这个待取的『投给 04』**没有显示是谁投给 04 的**，
     * 但是下面已取走的就有显示。"*
     *
     * **⇒ 对。而根因在这张表的表头里** —— 它一直只有
     * `单号 | 目标桌 | 一句话 | 详见 | 什么时候发的`，
     * **压根没有"谁投的"这一列** ⇒ **前端读不到，所以画不出来。**
     *
     * ⚠️ **而"谁投的"这张表是最该有的**：**「已被取走」那两张表在 2026-09-30 就加了这一列**，
     * 起因正是同一种误读（*"取走的会话和投单的会话是一样的？"*）——
     * **⇒ 当时只加在了两张已取走的表上，漏了这张最靠前的。**
     *
     * **⭐ 判据**：**三张投递表列的是同一件事，列名就该对齐** ——
     * 不然读者会在"有的表有、有的表没有"之间自己猜。
     */
    lines.push('| 单号 | 谁投的 | 目标桌 | 一句话 | 详见 | 什么时候发的 |');
    lines.push('|---|---|---|---|---|---|');
    for (const t of pending) {
      lines.push(
        `| \`${cell(t.id)}\` | ${cell(deskName(t.source, deskNames))} | ${cell(deskName(t.desk, deskNames))} | ${cell(t.summary)}`
        + ` | \`${cell(t.ptr)}\` | ${stamp(t.at)} |`,
      );
    }
  }
  lines.push('');

  // ── ② 已取走的（还没做"做完"跟踪，所以这里只说"被谁取走了"）────────────
  lines.push(`## 已被取走（${taken.length}）`);
  lines.push('');
  if (taken.length === 0) {
    lines.push('（还没有单子被取走。）');
  } else {
    /**
     * ⭐ **加了「谁投的」这一列**（2026-09-30）。
     *
     * ## 为什么要加（**它是被一个真实的误读逼出来的**）
     *
     * 用户看这张表时问：*"取走的会话和投单的会话是一样的？"*
     * —— **因为他看不出单子是谁发起的**：这张表原来只有"目标桌"，
     * **没有发起方** ⇒ 那一列**既是"投给谁"又像是"谁投的"**，读的人只能猜。
     *
     * ## 值的格式由**前端**定，不是随意的
     *
     * 侧边栏面板（`dsh-bulletin-panel`）会把这列渲染成
     * **`[04] 插件事务 → [02] 环境维护`** —— 它靠的是 `桌 NN（桌名）` 这个**固定形状**。
     * ⇒ **改这个格式前要问前端**（那是它解析得出来的前提）。
     */
    lines.push('| 单号 | 谁投的 | 目标桌 | 一句话 | 谁取走的 | 什么时候 |');
    lines.push('|---|---|---|---|---|---|');
    for (const t of taken.slice(0, 12)) {
      lines.push(
        `| \`${cell(t.id)}\` | ${cell(deskName(t.source, deskNames))}`
        + ` | ${cell(deskName(t.desk, deskNames))} | ${cell(t.summary)}`
        + ` | ${cell(who(t.takenBy))} | ${stamp(t.takenAt)} |`,
      );
    }
  }
  lines.push('');

  // ── ③ 最近的取走记录（历史表，**单子被删了也还在**）──────────────────────
  lines.push(`## 最近的取走记录（最近 ${recent.length} 条，最多留 ${CLAIMS_KEEP} 条）`);
  lines.push('');
  if (recent.length === 0) {
    lines.push('（还没有取走记录。）');
  } else {
    /**
     * ⭐ **加了「谁投的」这一列**（2026-09-30）。
     *
     * ⚠️ **老记录里没有 `source` 字段**（那是加这个字段之前写的）⇒
     * **去 `tickets` 表兜底查一次**；查不到就显示 `—`（**诚实地说"不知道"**，不猜）。
     *
     * ⇒ 所以"谁投的"这一列的判据是：**先看记录自带，再查单子表，都没有就 `—`。**
     */
    const sourceOf = (c) => {
      if (typeof c.source === 'string' && c.source !== '') return c.source;
      const t = ticketsById.get(String(c.ticketId));
      return typeof t?.source === 'string' ? t.source : '';
    };
    lines.push('| 时间 | 单号 | 谁投的 | 目标桌 | 取走的会话 | 那一句话 |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of recent) {
      const src = sourceOf(c);
      lines.push(
        `| ${stamp(c.at)} | \`${cell(c.ticketId)}\` | ${src === '' ? '—' : cell(deskName(src, deskNames))}`
        + ` | ${cell(deskName(c.desk, deskNames))}`
        + ` | ${cell(who(c.by))} | ${cell(c.summary)} |`,
      );
    }
  }
  lines.push('');

  // ── ④ 各桌现在有哪些会话（认过桌的才算）────────────────────────────────
  /**
   * ⚠️ **表头数字要和实际行数一致**（2026-09-30 实测踩到）：
   * 原来写 `${sessions.length}`，但下面是**按桌分组**渲染的，
   * 而"**办公室**"（认不出桌的会话）**没有桌号** ⇒ 有的实现会把它分到 `undefined` 组、有的不会
   * ⇒ **表头写 5、实际只有 4 行**（"数字对不上"正是我今天在别处反复踩的那类问题）。
   * ⇒ 改成**先分组、再按分组算数**。
   */
  const byDesk = new Map();
  for (const s of sessions) {
    const list = byDesk.get(s.desk) ?? [];
    list.push(s);
    byDesk.set(s.desk, list);
  }
  /**
   * ⚠️ **只在名单里显示"真桌号"**（2026-10-03 加，**兜住库里已经有的老记录**）。
   *
   * ## 为什么需要这道兜底
   *
   * 同一天修了 `f0-identity`：**没编号的会话不再进名单**
   * （它原来会以"办公室"记一条，于是**看起来像个成员、而实际取不到任何单子**）。
   *
   * **⚠️ 而修的是"以后不写"，不是"以前写的不算"** ——
   * 用过旧版的人的库里**已经躺着"办公室"那些老记录**，
   * **不滤掉的话，他们升级之后界面上还是那个样子**（而且没人知道该去删）。
   *
   * **⇒ 判据：`/^\d{2}$/`（和 `isResolvedDesk` 同一个）——
   * 认过桌的名单里只该有桌号。**
   */
  const desksShown = [...byDesk.keys()]
    .filter((d) => typeof d === 'string' && /^\d{2}$/u.test(d))
    .sort();
  const rowsShown = desksShown.reduce((n, d) => n + byDesk.get(d).length, 0);
  lines.push(`## 认过桌的会话（${rowsShown}）`);
  lines.push('');
  if (rowsShown === 0) {
    lines.push('（还没有会话认过桌。）');
  } else {
    lines.push('| 桌 | 会话标题 | 会话号 | 什么时候认的 |');
    lines.push('|---|---|---|---|');
    for (const desk of desksShown) {
      for (const s of byDesk.get(desk).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
        /**
         * ⚠️ **会话号从第一列挪到第三列**（2026-09-30："只有会话编号，有的不太好看"）。
         *
         * 原因：同一行**已经有"桌"和"会话标题"**了 —— 人靠这两个就认得出。
         * 会话号仍然留着（需要精确对照时有用），但**不再是主角**。
         *
         * ⚠️ 而**缺 `sessionId` 的老记录显示 `—`**：`s.id` 是**存储的 key**（＝会话号），
         * 但第一版误以为它也缺 ⇒ 明明有号却显示 `—`。**有 key 就用 key。**
         */
        const sid = s.sessionId ?? s.id;
        lines.push(
          `| ${cell(deskName(desk, deskNames))} | ${cell(s.title)}`
          + ` | \`${shortSession(sid)}\` | ${stamp(s.at)} |`,
        );
      }
    }
    // ⚠️ 没分到组的（缺 `desk` 字段的脏记录）要**如实报出来**，不能悄悄吞掉
    const orphans = sessions.length - rowsShown;
    if (orphans > 0) lines.push(`| （没桌号） | 有 ${orphans} 条记录缺 \`desk\` 字段，没有渲染 | | |`);
  }
  lines.push('');

  // ── ⑤ 健康（排查时最有用的一段）─────────────────────────────────────────
  lines.push('## 健康');
  lines.push('');
  lines.push(`- 插件版本：**${config?.__version ?? '?'}**`);
  lines.push(`- 存储：**${store.where === 'domain' ? '平台存储域' : '文件'}**（状态文件 \`${safe(store.file) || '（取不到路径）'}\`）`);
  if (store.lastWrite?.at) {
    const w = store.lastWrite;
    // ⚠️ key 可能很长（claims 的 key 是"时间戳|单号"）⇒ 截一下别撑爆这一行；
    //    并且**消毒控制字符**（万一别处又漏进来一个 NUL，整份表就又读不出来了）。
    const key = typeof w.key === 'string' && w.key.length > 40 ? `${w.key.slice(0, 40)}…` : w.key;
    lines.push(`- 最近一次写存储：${stamp(w.at)} ${w.ok === true ? '成功 ✅' : `**失败** ❌ ${w.error ?? ''}`}${key ? `（key=${sanitizeText(key)}）` : ''}`);
  } else {
    lines.push('- 最近一次写存储：（本进程还没写过）');
  }
  if (durability.at === null) {
    lines.push('- **落盘确认**：（还没跑过）');
  } else {
    lines.push(
      `- **落盘确认**：${stamp(durability.at)} ${durability.ok === true ? '✅ 通过' : `❌ ${durability.error ?? '失败'}`}`
      + ` —— \`flush()\` ${durability.ms ?? '?'} ms，\`stat()\` revision ${durability.revisionChanged === true ? '**已变化**' : '未变（内容没动时正常）'}`
      + `（会话 \`${shortSession(durability.sessionId)}\`）`,
    );
  }
  if (lastStatusWrite.at !== null) {
    lines.push(
      `- 本文件上次生成：${stamp(lastStatusWrite.at)} ${lastStatusWrite.ok === true ? '成功 ✅' : `**失败** ❌ ${lastStatusWrite.error ?? ''}`}`
      + `（**这次生成就是因为它**：状态变了才写）`,
    );
  }

  /**
   * ## ⭐⭐ **把"写了没人看"的东西显示出来**（2026-10-01 加）
   *
   * ### 为什么
   *
   * 这个插件里有**两处"记了但没人读"**的东西 —— Claude 复查时点出来的：
   *
   * | 东西 | 原来 | 现在 |
   * |---|---|---|
   * | **`lastFileError`**（存储写失败 / 读不懂） | **写 3 处、读 0 处** —— 注释还写着*"`dispatch_diag` 会报出来"*，**而那个工具不存在** | 显示在这儿 |
   * | **`problems`**（`warn()` 攒下的问题） | 只在内存里，**从来没露过面** | 显示在这儿 |
   *
   * **⇒ 这正是 `docs\06 习惯二`**（"凡是跳过，都要留痕"）—— 它们**留了痕，但没人看得见**，
   * 而"没人看得见的痕"和"没留痕"在效果上一样。
   *
   * ⚠️ **放在"健康"段**：那是**用户排查时会去看的地方**（它自己就是这么设计的）。
   *
   * ⚠️ **只在有问题时才出现** —— 健康的东西不该在状态表里占三行（那样会让真正的问题淹没）。
   */
  const lastFileError = health?.lastFileError;
  if (lastFileError !== null && lastFileError !== undefined && lastFileError.error !== null) {
    lines.push(`- ⚠️ **最近一次存储文件出错**：${stamp(lastFileError.at)} —— ${sanitizeText(String(lastFileError.error))}`);
  }
  /**
   * ⚠️ **存储文件里到底有几条记录** —— 这一条是对着"单子其实没落盘"那类事故加的：
   * `lastWrite` 说"成功"，而文件里是空的 ⇒ **两个数一对比，谎就露了。**
   */
  if (typeof health?.fileTableCount === 'number') {
    lines.push(`- 存储文件里的单子数：**${health.fileTableCount}**（和上面"待取 + 已取"对不上就说明有东西没落盘）`);
  }
  const problems = health?.problems;
  if (Array.isArray(problems) && problems.length > 0) {
    lines.push(`- ⚠️ **本进程攒下的问题 ${problems.length} 条**：`);
    for (const one of problems.slice(0, 5)) lines.push(`  - ${sanitizeText(String(one))}`);
    if (problems.length > 5) lines.push(`  - …还有 ${problems.length - 5} 条（看插件日志）`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('> 这份文件是**派生视图**：全部内容由单子和取走记录现算，**没有另存一份会漂移的状态**。');
  /**
   * ⚠️ **这句原来结尾带着"（2026-09-30）"** —— 2026-10-01 删掉了。
   *
   * ## 为什么删（**这是"生成物该不该带来源"的一个通用判据**）
   *
   * 这份文件是**插件生成的、给各桌读的**。而"谁在什么时候拍板的"是**开发过程**的事，
   * **不属于"这份文件在说什么"** —— 它和它上面那句"派生视图"的说明放在一起，读起来像
   * "这个决定是临时的、是某个人说了算的"，**而读者需要知道的是"规矩是什么"。**
   *
   * **⇒ 判据**：**生成物里写"当前事实"，不写"这个事实是谁定的"。**
   * **要记来源，记在仓库的 `docs\` 里**（那儿才是"我们为什么这么定"的家）。
   *
   * ⚠️ **而这条是别的桌读出来提给我们的**（桌 03，2026-10-01 的单子）——
   * **他们看到的是生成物，而生成物是他们的界面。**
   */
  lines.push('> 「已取走」只表示**有会话把它取走了** —— 投递插件**不跟踪"做没做完"**。');
  return lines.join('\n');
}

/**
 * 装这个功能。
 *
 * @param {object} api `{ ctx, config, log, warn, store, version }`
 */
export function setup(api) {
  const { ctx, config, log, warn, store } = api;
  const file = config.statusFile;

  /**
   * ⚠️⚠️ **路径为空 ⇒ 不装配**（2026-10-01 实测踩到，加了这道闸）。
   *
   * ## 踩到什么
   *
   * `writeTextFile` 是**原子写**：先写 `${file}.tmp`、再 `renameSync` 到 `file`。
   *
   * ⇒ **`file` 是空串时**：临时文件成了 **`.tmp`**，而 `renameSync('.tmp', '')` **失败**
   * ⇒ **一个 9 KB 的 `.tmp` 留在进程的 cwd 里**（我们在工作区根和仓库文件夹里**各发现一个**）。
   *
   * ## 为什么 `file` 会是空
   *
   * `apply()` 里是这样推的：
   *
   * ```
   * statusFile = <workspaceRoot>\00-通用\投递状态.md
   * ```
   *
   * **`workspaceRoot` 没配 ⇒ 推导出来就是空串。**
   * 而"什么都没配"的实例**确实会被加载**（实测：插件升级/重装的中间代际跑过一次）——
   * 它没有桌名、没有路径，**却在往磁盘上写东西**。
   *
   * ## 这道闸的意义
   *
   * **没有配好就不许写。** 宁可状态表这一轮不出现，
   * 也不要在别人的工作区里**悄悄留一个叫 `.tmp` 的垃圾文件** ——
   * **那种文件没人知道是谁建的，也没人敢删。**
   */
  if (typeof file !== 'string' || file.trim() === '') {
    warn('statusFile 是空的 —— 状态表本次不装配（**这不是故障**：多半是 workspaceRoot 没配）', {
      workspaceRoot: config.workspaceRoot === undefined ? '(未配)' : config.workspaceRoot,
      hint: '配好 workspaceRoot，或显式配一个 statusFile',
    });
    return {
      request: () => {}, verifyDurability: async () => ({ ok: null, error: '未装配（statusFile 为空）' }),
      snapshot: () => ({ file: '', durability: {}, lastStatusWrite: {} }),
      generateNow: () => {}, readBack: () => undefined,
    };
  }

  /**
   * ⚠️ **状态表文件和存储文件不能是同一个路径**（2026-09-30 实测踩到）。
   *
   * 两者格式不同：状态表是**纯 markdown**，存储是**JSON**。
   * 配成同一个路径 ⇒ **互相覆盖**（实测：打开 .md 看到的是存储的 JSON）。
   * ⇒ 这里直接挡住，并且**如实告诉用户配错了**。
   */
  if (typeof store.file === 'string' && store.file !== ''
      && store.file.toLowerCase() === String(file).toLowerCase()) {
    warn('状态表文件与存储文件是同一个路径 —— 状态表本次不装配（它们格式不同，会互相覆盖）', {
      statusFile: safe(file),
    });
    return {
      request: () => {}, verifyDurability: async () => ({ ok: null, error: '未装配' }),
      snapshot: () => ({ file, durability: {}, lastStatusWrite: {} }),
      generateNow: () => {}, readBack: () => undefined,
    };
  }

  /**
   * ⭐⭐ **落盘确认** —— 提成 setup 里的**具名函数**（2026-10-01 修的一个真 bug）。
   *
   * ## 原来错在哪
   *
   * 它原来**只是返回对象的一个方法**（`return { async verifyDurability(exec) {…} }`），
   * 而两个诊断工具里却**裸名字调用**它：
   *
   * ```js
   * const d = await verifyDurability(exec);     // ← 闭包里根本没有这个名字
   * ```
   *
   * ⇒ **`refresh_status` 和 `probe_flush` 一调就 `ReferenceError: verifyDurability is not defined`。**
   * （`refresh_status` 更糟：它**先把状态表生成了**，然后才以一个错误结束。）
   *
   * ## 为什么我的测试没抓到
   *
   * 因为它测的是**返回对象的那个方法**（`api.verifyDurability()`），
   * **不是"注册之后、被真正调用"的那个工具**。
   * ⇒ 这正是审阅者说的：**"验证必须实际调用注册后的工具"**。
   *
   * ## 现在的写法
   *
   * **一个函数声明，工具和返回对象共用同一份**（声明会提升 ⇒ 放哪都行，
   * 但为了可读性放在两道早退之后）。
   *
   * @param {object} [exec] 工具执行上下文（拿 sessionId 用）
   */
  async function verifyDurability(exec) {
    const sessionId = exec?.agent?.session?.id;
    const sp = findPersistence(exec?.agent?.ctx) ?? findPersistence(ctx);
    const t0 = Date.now();
    if (sp === undefined) {
      Object.assign(durability, {
        at: Date.now(), ok: null, ms: null, error: '取不到 sessionPersistence（不影响投递）',
        sessionId: sessionId ?? null, revision: null, revisionChanged: null,
      });
      log('状态表/落盘确认：取不到 sessionPersistence', {});
      return durability;
    }
    try {
      const before = typeof sessionId === 'string' ? (await sp.stat(sessionId))?.revision : undefined;
      await sp.flush();                     // ⭐ 持久屏障（实测 0 ms、全局无参数）
      const after = typeof sessionId === 'string' ? (await sp.stat(sessionId))?.revision : undefined;
      Object.assign(durability, {
        at: Date.now(), ok: true, ms: Date.now() - t0, error: null,
        sessionId: sessionId ?? null,
        revision: after === undefined ? null : String(after),
        revisionChanged: before === undefined || after === undefined ? null : String(before) !== String(after),
      });
      log('状态表/落盘确认', {
        ok: true, ms: durability.ms, revisionChanged: durability.revisionChanged,
      });
    } catch (error) {
      Object.assign(durability, {
        at: Date.now(), ok: false, ms: Date.now() - t0, error: errText(error),
        sessionId: sessionId ?? null, revision: null, revisionChanged: null,
      });
      warn('落盘确认失败（不影响投递）', { error: errText(error) });
    }
    return durability;
  }

  /**
   * 生成一次并落盘。
   *
   * ⚠️ **`.md` 就写 markdown**（2026-09-30 实测纠正）：我原本想"一个文件既给人看、
   * 又给机器读"，把 markdown 塞成 JSON 里的一个字符串字段 —— 结果
   * **你打开 `投递状态.md` 看到的是 `{"generatedAt":…}`，根本不能读**。
   * ⇒ 分成两份：**`.md` 是给人看的纯 markdown**；**机器镜像写进存储的 `misc` 表**。
   */
  function generate(reason) {
    const text = renderStatus({
      store: { ...store, lastWrite },
      config: { ...config, __version: api.version },
      /**
       * ⭐⭐ **"写了没人看"的那些东西**（2026-10-01 加，见"健康"段那段注释）。
       *
       * ⚠️ **每一项都是真读出来的，一个都不许糊弄**：
       * - `lastFileError` 从 store 模块**实时读**（它是可变对象，读时才是最新）
       * - `problems` 从 `api` 拿（`index.js` 建 log 时就攒着）
       * - `fileTableCount` **现场数文件里有多少单子** ——
       *   它是"单子到底有没有落盘"这个问题的直接答案（对着那次"回执成功、磁盘上没有"的事故加的）
       */
      health: {
        lastFileError,
        problems: api.problems,
        fileTableCount: (() => {
          try { return listRecords(store.tables.tickets).length; } catch { return undefined; }
        })(),
      },
    });
    try {
      writeTextFile(file, text);
      Object.assign(lastStatusWrite, { at: Date.now(), ok: true, error: null, file });
      log('状态表/已更新', { reason, file: safe(file) });
    } catch (error) {
      Object.assign(lastStatusWrite, { at: Date.now(), ok: false, error: errText(error), file });
      warn('状态表写不出去（不影响投递）', { reason, error: errText(error) });
    }
    // 机器可读的镜像（计数 / 版本 / 存储位置）—— **存进存储**，不污染那个 .md。
    try {
      const tickets = listRecords(store.tables.tickets);
      void putTracked(store.tables.misc, 'status:mirror', {
        value: JSON.stringify({
          at: Date.now(),
          version: api.version,
          store: store.where,
          pending: tickets.filter(([, r]) => r?.takenBy === null || r?.takenBy === undefined).length,
          taken: tickets.filter(([, r]) => r?.takenBy !== null && r?.takenBy !== undefined).length,
          file,
          reason,
        }),
        at: Date.now(),
      }).catch(() => { /* 镜像写不进去无所谓 —— 权威是那个 .md 和 tickets 表 */ });
    } catch { /* 同上 */ }
  }

  /** 立刻生成一次（合并同一 tick 里的多次请求）。 */
  function flushStatus(reason = '手动') {
    dirty = false;
    generate(reason);
  }

  // ── 两个工具：让人/我能**手动**验这条链路 ─────────────────────────────────
  ctx.effect(() => ctx.inject(['tools'], (tctx) => {
    /**
     * ① 重新生成状态表。
     *
     * ⭐ `verify: true` 时**顺便做落盘确认**（`flush()` 之后 `stat()`）——
     * 这正是"**真的落盘了吗**"那个问题的**唯一正确回答方式**。
     */
    tctx.tools.register({
      name: 'refresh_status',
      description:
        '重新生成给人看的送达状态表（`00-通用\\投递状态.md`）。'
        + '传 `verify: true` 会**顺带做落盘确认**：先调 `sessionPersistence.flush()`（持久屏障），'
        + '再 `stat()` 读回 —— **只 `stat()` 不能证明落盘**（后端可能延迟物理落盘）。',
      parameters: {
        type: 'object',
        properties: {
          verify: { type: 'boolean', description: '是否顺带做落盘确认（flush + stat），默认 true' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: String(v) }],
      },
      execute: async (args, exec) => {
        flushStatus('手动');
        const out = [`状态表已重新生成：\`${safe(file)}\``];
        // 计数**现算**（不再读文件里的镜像 —— 那个镜像现在存在存储里，不是文件里）
        const rows = listRecords(store.tables.tickets);
        const pending = rows.filter(([, r]) => r?.takenBy === null || r?.takenBy === undefined).length;
        out.push(`单子：待取 ${pending} · 已取 ${rows.length - pending}`);
        if (args?.verify !== false) {
          const d = await verifyDurability(exec);
          out.push(d.ok === true
            ? `落盘确认：✅ 通过（flush ${d.ms} ms，stat revision ${d.revisionChanged === true ? '已变化' : '未变'}）`
            : `落盘确认：${d.ok === null ? '⚠️ 跳过' : '❌ 失败'} —— ${d.error ?? ''}`);
          // 确认结果也要写进文件（否则仪表盘上永远看不到它）
          generate('落盘确认');
        }
        return out.join('\n');
      },
    });

    /** ② 只做落盘确认（不改状态表内容）。 */
    tctx.tools.register({
      name: 'probe_flush',
      description:
        '【只读探针】只做**持久屏障**验证：`sessionPersistence.flush()` + `stat()`。'
        + '用来回答"这个会话的日志到底落盘了没有"。唯一动作是一次 `flush()`（不产生新事件）。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: 'flush | stat | all（默认 all）' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: String(v) }],
      },
      execute: async (args, exec) => {
        const d = await verifyDurability(exec);
        const out = [];
        out.push(`本会话：\`${d.sessionId ?? '(取不到)'}\``);
        out.push(d.ok === true
          ? `flush() → ✅ ${d.ms} ms`
          : `flush() → ${d.ok === null ? '⚠️ 跳过（取不到服务）' : `❌ ${d.error}`}`);
        if (d.revision !== null) {
          out.push(`stat() revision：\`${String(d.revision).slice(0, 60)}\``);
          out.push(`flush 前后是否变化：${d.revisionChanged === true ? '变了' : '**没变**（内容没动时正常 —— revision 是内容指纹，不是落盘信号）'}`);
        }
        out.push('（判断依据：**`flush()` 是持久屏障**；单看 `stat()` 会有假阳性。）');
        return out.join('\n');
      },
    });
  }));

  return {
    /** 状态变了 —— **安排一次生成**（同一 tick 多次请求只写一次）。 */
    request(reason) {
      dirty = true;
      if (scheduled) return;
      scheduled = true;
      // 微任务：把"一轮里发生的多次变化"合并成一次写。
      void Promise.resolve().then(() => {
        scheduled = false;
        if (dirty) flushStatus(reason);
      });
    },

    /**

    /**
     * ⚠️ **这里原来是方法体，现在只是转发给上面那个具名函数**（2026-10-01 修 bug）。
     *
     * 那次 bug 的成因就是"**有两份**"：工具里裸名字调一份（不存在的），
     * 返回对象里定义另一份。**⇒ 现在只有一份，两边都指向它。**
     *
     * 实测：**`flush()` 前后 `revision` 一模一样**（它是**内容**的指纹，不是持久状态）。
     * 契约也说"相等可当没变；**不等什么都不保证**"。
     * ⇒ 这里只把 `revision` 当**参考**记下来，**不拿它下结论**。
     */
    verifyDurability,

    /** 供工具/自测读当前状态（不含 markdown）。 */
    snapshot() {
      return {
        file,
        durability: { ...durability },
        lastStatusWrite: { ...lastStatusWrite },
      };
    },

    /** 自测/诊断用：立刻生成一次。 */
    generateNow: flushStatus,

    /** 读回刚写下的状态文件（自测用）—— **纯 markdown 文本**。 */
    readBack: () => readTextFile(file),
  };
}
/** 在给定 ctx 上找 `sessionPersistence`（**两条路都试** —— 根 ctx 与子 ctx 形态不同）。 */
function findPersistence(c) {
  if (c === undefined || c === null) return undefined;
  try {
    if (c.sessionPersistence !== undefined && c.sessionPersistence !== null) return c.sessionPersistence;
  } catch { /* 试下一条 */ }
  try {
    const viaGet = typeof c.get === 'function' ? c.get('sessionPersistence') : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet;
  } catch { /* 放弃 */ }
  return undefined;
}
