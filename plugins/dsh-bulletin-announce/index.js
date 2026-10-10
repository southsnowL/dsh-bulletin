/**
 * 办公室公告（第一版）
 *
 * 机制本体是一个**追加式的公告文件**（⚠️ 规矩**按角色**分：**AI 只往后加；改和删是用户的事** ——
 * 别再把这条读成"文件不能被改"，那会把用户能删那一半盖住，见 `docs\01` §五.二）；
 * 本插件只负责两件事：
 *   ① 让各桌能"发"公告（announce 工具）
 *   ② 每步之前把"有效期内 + 本会话没见过"的公告送进会话
 *
 * 三条硬约束（照开工包 v1 §6.1 与 skill《practices》）：
 *   - `agent/pre-step` 是 waterfall：**一定调 next()**，**所有错误自己吞掉**，
 *     否则会卡住所有桌的每一步。
 *   - **失败必须 fail-open**：读不到文件、存不了游标，都不影响会话正常进行。
 *   - **Model-visible means logged**：注入走 `createUserMessage`（正式消息构造器），
 *     不允许自定义会话事件类型。
 *
 * 文件是本体：**插件停了，办公室退回纯文件流程，什么都不会丢。**
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// ⚠️ **版本号要读真的 package.json**（2026-09-29 加）：
// 今天两次因为"装的是新版、跑的是旧版"而白查半天 —— **日志里没有版本号就无法自证**。
// 用 `import.meta.url` 定位：装好之后 `index.js` 与 `package.json` 同目录（pnpm 的硬链接）。
const PLUGIN_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(`${here}/package.json`, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
import z from 'schemastery';        // Config 用 schemastery（平台对 Config 的约定）
// ⚠️ **域的表 schema 用 zod，而且必须命名导入 `{ z }`**（2026-09-29 实测踩到）：
// 写成 `import z from 'zod'` 拿到的是**模块命名空间**，`z.object(...)` 造出来的东西
// **没有 `parse` / `safeParse`** —— 表现为存储域打开时抛
// `stored record … does not match its schema`（平台调 `valueSchema.parse` 失败）。
// 本机 zod 是 **4.6.5**，`parse` 仍在（同一 major 内可用）。
import { z as zod } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';

export const name = 'bulletin-announce';

/**
 * 事件监听必须自己吞异常：pre-step 是 waterfall，冒泡会卡住整个办公室。
 *
 * ⚠️ **刻意不声明 `inject`**：本插件**所有依赖都走可选查找**（`ctx.get(...)`），
 * 缺了任何一个都不该让它装不上。`commands` / `systemPrompt` / `storageDomain`
 * 都是这么用的（见 `apply` 里的 `ctx.inject([...], …)`）。
 */
export const inject = [];

// ─────────────────────────────────────────────────────────────────────────────
// 存储：每会话"已见过哪些公告"的游标
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 存储域名。
 *
 * ⚠️ **必须匹配 `/^[a-z][a-z0-9_]*$/`** —— **不能有连字符**（`defineDomain` 在**模块加载时**就校验，
 * 不合法会**在插件加载阶段就抛错**；而插件是 required ⇒ **整个 DSH 起不来**）。
 * 这一条曾经真的把 DSH 弄到只能进安全模式（2026-09-29，写成 `bulletin-announce`）。
 */
const DOMAIN = 'bulletin_announce';
const CURSOR_TABLE = 'seen';

/**
 * 游标记录（**zod**，不是 schemastery —— 域的表 schema 是 zod 的活儿）。
 *
 * `ids` 存的是**条目的内容指纹**（不是行号）—— 因为别的读者会往同一个文件追加，
 * 行号会漂移，内容不会。
 */
const cursorSchema = zod.object({
  ids: zod.array(zod.string()),
  updatedAt: zod.number(),
});

const announceDomainSpec = defineDomain({
  name: DOMAIN,
  version: 1,
  tables: { [CURSOR_TABLE]: domainTable(cursorSchema) },
});

// ─────────────────────────────────────────────────────────────────────────────
// 读公告文件
// ─────────────────────────────────────────────────────────────────────────────

const ENTRY_RE = /^-\s*(\d{2})-(\d{2})｜([^｜]*)｜([^｜]*)｜([^｜]*)｜(.*)$/u;
const TAIL_CHUNK = 32768;
const READ_BUDGET = 4 * 1024 * 1024;

/** 标题里显示"今天"用的本地日期。 */
const todayMmDd = () => {
  const n = new Date();
  return `${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};

/**
 * 从后往前分块读文件，凑够 `maxEntries` 条公告就停。
 *
 * 为什么倒着读：**新条目永远在末尾**（AI 只能往后追加），而条目会无限增长、
 * **过期的条目仍留在文件里** —— 正序读会把整个文件读完只为拿最新几条，
 * 倒序读到第一条过期条目就能停。
 *
 * ⚠️ **"新条目在末尾"这条仍然成立，即便用户可以改行、删行** ——
 * 因为"发一条新的"永远是**追加到末尾**，改和删都动不了这条性质。
 * （⚠️ 但**别把这条推广成"文件不会被改"** —— 那是那个被淘汰的旧名字要说的事。）
 *
 * ⚠️ 实现要点（两条都是自测抓出来的真 bug，别改回去）：
 *   ① 窗口内容必须是**"字节 0 到窗口尾的完整前缀"**，从尾往前扫。
 *      不要"每轮把起点前移一块、再把新块拼上去" —— 那样窗口会越界，
 *      最后拿到的是文件**开头**那一段，把已经读到的条目覆盖掉。
 *   ② 窗口**尾部**才是最新内容，所以只保留"最后一条换行符之后"的部分，
 *      避免窗口尾停在一个被截断的半行上。
 *
 * @returns `lines` 按**文件顺序（旧→新）**排列，最多 `maxEntries` 条。
 */
function readAnnouncementLines(file, maxEntries) {
  const no = openSync(file, 'r');
  try {
    const size = fstatSync(no).size;
    let win = TAIL_CHUNK;
    let found = [];
    let truncatedStart = false;
    let atStart = size === 0;

    while (!atStart) {
      const from = Math.max(0, size - win);
      const len = size - from;
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = readSync(no, buf, got, len - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      atStart = from === 0;
      const text = buf.subarray(0, got).toString('utf8');
      /**
       * ## ⚠️⚠️ 2026-10-01 修的：**文件末尾那条没换行的公告会被漏掉**
       *
       * ### 原来错在哪
       *
       * ```js
       * const body = atStart ? text : text.slice(0, text.lastIndexOf('\n') + 1);
       * ```
       *
       * 非首窗时**一律丢掉"最后一个换行之后"的内容** —— 想法是
       * *"窗口开头可能从半行切进来，所以按换行对齐"*。
       *
       * ⚠️ **但窗口的尾部方向是反的**：
       * - **窗口开头**：可能从半行切进来 ⇒ **确实要丢掉那半行**（更早的窗口会补全）
       * - **窗口末尾**：**它就是文件的真末尾** ⇒ 那里**没有换行也是一条完整的行**
       *
       * ⇒ 于是一条"写到一半、最后没打换行"的公告**永远不会被读到**。
       * （我们自己的追加工具会补换行，但**用户直接编辑文件**就会触发。）
       *
       * ### 修法
       *
       * 只在**非首窗**时丢掉开头那半行；**末尾那段如果自己就长得像一条公告，就留下它。**
       * 判据用 `startsWith('- ')` —— 和下面那个循环**同一把尺子**，不另立标准。
       */
      let body;
      if (atStart) {
        body = text;
      } else {
        const cut = text.lastIndexOf('\n') + 1;
        const tail = text.slice(cut);
        // ⚠️ 末尾那段是**文件最后一行**（完整），只要它长得像公告就得留下。
        body = tail.startsWith('- ') ? `${text.slice(0, cut)}\n${tail}` : text.slice(0, cut);
      }

      const hits = [];
      for (const raw of body.split('\n')) {
        const line = raw.replace(/\r$/u, '');
        if (line.startsWith('- ')) hits.push(line);
      }
      // 整窗落在一条超长行内部时 hits 为空 —— 此时**不要**覆盖已有结果。
      if (hits.length > 0) found = hits.slice(-maxEntries);

      if (atStart) break;
      if (found.length >= maxEntries) {
        truncatedStart = true;
        break;
      }
      if (win >= READ_BUDGET) {
        // 兜底：超过预算还没凑够就返回已有的（fail-open），不无限读下去。
        truncatedStart = true;
        break;
      }
      win = Math.min(win * 4, READ_BUDGET);
    }

    return { lines: found, truncatedStart };
  } finally {
    closeSync(no);
  }
}

/**
 * 解析公告文件。
 *
 * @returns `entries`（**旧→新**，只含有效期内）· `visibleCount`（有效期内总条数，
 *          可能大于 `entries.length` —— 被 `maxEntries` 截断时）·
 *          `malformed`（**看着像公告却解析不了的行** —— 2026-10-01 加，
 *          因为这些行**永远送不到，而在界面上和"文件里没有它"完全一样**）
 */
function parseAnnouncements(file, maxEntries, defaultTtlDays) {
  if (!existsSync(file)) {
    return { entries: [], visibleCount: 0, malformed: [], reason: 'file-missing' };
  }
  const { lines } = readAnnouncementLines(file, maxEntries);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const seen = new Set();
  const kept = [];
  /** ⚠️ **坏行要报出来**（见下面循环里那段注释）。 */
  const malformed = [];
  let visible = 0;

  for (const line of lines) {
    const m = ENTRY_RE.exec(line);
    /**
     * ⚠️⚠️ **解析不了的行不能一声不吭**（2026-10-01 加）。
     *
     * 原来这里就是 `continue` —— 而那正是 `docs\06 习惯二` 说的那类失败：
     * **跳过可以，但必须留痕。** 一条因为格式不对而永远送不到的公告，
     * **在界面上和"文件里没有它"完全一样。**
     *
     * ⚠️ 判据用"**看着像公告**"（`- ` 开头 + 里面有日期），
     * 免得把说明文字、表格、空行都算成坏行（那样噪音会淹没信号）。
     */
    if (m === null) {
      if (/^-\s*\d/u.test(line)) malformed.push(line.slice(0, 120));
      continue;
    }
    /**
     * ⚠️⚠️ **指纹必须和面板算得一模一样**（2026-10-01 修）。
     *
     * ## 原来错在哪
     *
     * 这里原来是 `createHash('sha1').update(line)` —— **拿原始行算**。
     * 而面板那边拿的是 **`line.trim()` 之后**的行（它 `raw` 就是 trim 过的）。
     *
     * **⇒ 一行只要行尾多一个空格，两边算出来的指纹就不同。**
     * **⇒ 症状**：面板显示"**没有任何会话见过这条**"（它拿自己算的指纹去 seen 集合里查，
     * 查不到）—— **而各桌其实早就收到了。**
     *
     * **⚠️ 而这一类差异最难发现**：公告能送到、显示也正常，
     * **只有那个"见过数"是错的** —— 而它是删除前唯一的提醒。
     *
     * ⇒ 现在两边都按 **"剥掉 `\r`、去掉两端空白"** 之后的那一行算。
     * （行尾空格基本是编辑器留的噪音，**不该影响"这是不是同一条"**。）
     */
    const fingerprintOf = line.replace(/\r$/u, '').trim();
    const id = createHash('sha1').update(fingerprintOf).digest('hex').slice(0, 16);
    if (seen.has(id)) continue;
    seen.add(id);

    const entry = {
      id,
      mmdd: `${m[1]}-${m[2]}`,
      publisher: m[3].trim(),
      text: m[4].trim(),
      source: m[5].trim(),
      ttlLabel: '',
      expiring: true,
    };

    const raw = m[6].trim();
    if (raw === '') {
      entry.ttlLabel = `${defaultTtlDays} 天`;
      entry.expiring = true;
    } else if (/^(0|不说|长期|永久)$/u.test(raw)) {
      entry.ttlLabel = '长期';
      entry.expiring = false;
    } else {
      // ⚠️ 这一栏的写法**不止一种**，解析器必须都认（2026-09-29 实测踩到）：
      //   本文件头部教的是 `有效期 N 天`，而插件自己写的是裸的 `N 天`。
      //   旧版只认裸数字 ⇒ 手工写的 `有效期 0` 被当成 `0 天`（应为"长期"）。
      const days = /^有效期\s*(\d+)\s*天?$/u.exec(raw) ?? /^(\d+)\s*天?$/u.exec(raw);
      if (days !== null) {
        const n = Number.parseInt(days[1], 10);
        entry.days = n;
        entry.expiring = n > 0;
        entry.ttlLabel = n === 0 ? '长期' : `${n} 天`;
      } else if (/^(不说|长期|永久)$/u.test(raw.replace(/^有效期\s*/u, '').trim())) {
        entry.ttlLabel = '长期';
        entry.expiring = false;
      } else {
        // 真的认不出来：当作没写，不要因此丢掉这条公告。
        entry.ttlLabel = `${defaultTtlDays} 天`;
        entry.expiring = true;
      }
    }

    /**
     * 过期判定：公告日期 + N 天。
     *
     * ## ⚠️⚠️ 2026-10-01 修的：**跨年时去年的公告会"复活"**
     *
     * ### 原来错在哪
     *
     * ```js
     * let base = new Date(today.getFullYear(), month - 1, day);   // 一律按今年算
     * if (base > today) base = today;                             // 算到未来就钳到今天
     * ```
     *
     * ⇒ **元旦那天**：去年的 `12-31` 按今年算 ⇒ 变成"今年 12-31" ⇒ 在未来 ⇒ 钳到"今天"
     * ⇒ **一条早就该过期的公告，变成"今天刚发的"** ⇒
     * **它会被推给每个新会话，压缩后还会重发。**
     *
     * ### 修法：**和面板用同一个判据**
     *
     * > **没写年份、又比今天晚好几天 ⇒ 多半是去年的。**
     *
     * （面板的 `parseDay` 早就是这么判的 —— 两边不一致时，
     * **面板显示"已过期"、各桌却当新公告收到**，那种矛盾比 bug 本身更让人困惑。）
     *
     * ## ⚠️ 这条推定的**边界**（写清楚，不假装它更聪明）
     *
     * 协议里日期只有 `MM-DD`，**没有年份** ⇒ 下面这件事它做不到：
     * **区分"去年 12-31"和"前年 12-31"** —— 两者看起来一样。
     * 真需要跨多年区分，得往协议里加年份（那是另一个决定，见 `docs\03`）。
     */
    if (entry.expiring) {
      const month = Number.parseInt(m[1], 10);
      const day = Number.parseInt(m[2], 10);
      const days = entry.days ?? defaultTtlDays;
      let base = new Date(today.getFullYear(), month - 1, day);
      /**
       * ⚠️ `2 * 86400000` = 两天。为什么留两天余量而不是"只要晚一天就算去年"：
       * **时区**。写公告的人可能在北京时间、读者的机器在别的时区 ——
       * 差一天是正常的，差好几天才是"跨年"。
       */
      if (base.getTime() - today.getTime() > 2 * 86400000) {
        base = new Date(today.getFullYear() - 1, month - 1, day);
      }
      const until = new Date(base.getTime());
      until.setDate(until.getDate() + days);
      if (until.getTime() <= today.getTime()) continue;
    }

    visible += 1;
    kept.push(entry);
  }

  return { entries: kept, visibleCount: visible, malformed, reason: 'ok' };
}

/**
 * ## ⚠️⚠️ 2026-10-01 修的：**这里原来按"内容哈希"排序，不是按时间**
 *
 * ### 原来错在哪
 *
 * ```js
 * const newestFirst = (entries) => [...entries].sort((a, b) => (a.id < b.id ? 1 : -1));
 * //                                                        ↑ a.id 是 createHash('sha1')！
 * ```
 *
 * `id` 是**整行内容的 SHA1 前 16 位** —— 它**和时间没有任何关系**。
 * ⇒ 实测：文件里 `1,2,3,4,5` 五条被排成 **`3,2,4,1,5`**。
 *
 * ### 为什么它比"看着丑"严重
 *
 * 注入时有数量上限（`maxPerInjection`）⇒ **被截掉的是"哈希较小"的，不是"较旧"的**
 * ⇒ **一条刚发的公告可能因为哈希小而不显示，而一条很旧的反而显示。**
 *
 * ### 修法
 *
 * ⭐ `parseAnnouncements` **本来就按文件顺序解析**，而**新条目永远追加在末尾**
 * ⇒ **文件里"旧 → 新"** ⇒ **直接反转就是"最新优先"。**
 * **不需要重新排序，也不需要时间戳。**
 *
 * ⚠️ **而这条判据的依据不是"文件不会被改"，是"新增永远往后加"。**
 * 用户改一行、删一行都动不了这一条 —— 但**换成"用户可以插到中间"就不成立了**
 * （而那时**得按日期排**，因为 `date` 是内容里的真字段）。
 */
const newestFirst = (entries) => [...entries].reverse();

// ─────────────────────────────────────────────────────────────────────────────
// 注入（本版唯一的"界面" —— 文案规格见 文案规格-注入内容.md）
// ─────────────────────────────────────────────────────────────────────────────

function lineFor(entry) {
  const head = `- ${entry.mmdd}｜${entry.publisher}｜${entry.text}`;
  const withSource = entry.source === '' ? head : `${head}｜${entry.source}`;
  return entry.ttlLabel === '' ? withSource : `${withSource}｜${entry.ttlLabel}`;
}

/**
 * 构造注入的消息。
 *
 * `kind: 'announcement'` 是**声明式**的来源标签（本插件自己的种类）；
 * `form: 'notice'` 是平台已有的上下文成形形式，并携带一行 summary
 * （会话事件因此自描述，读日志的人不用猜这条消息是什么）。
 */
function renderAnnouncement(entries, visibleCount, opts, opening) {
  const shown = entries.slice(0, opts.maxPerInjection);
  const hidden = entries.length - shown.length;
  // ⚠️ 三种情形要说清，别混成一句（2026-09-29 实测后指出）：
  //   · 开桌首次   → "你没见过 N 条"（对：这个会话确实第一次见）
  //   · 压缩后重发 → "上下文已压缩，重发当前有效 N 条"（**不能说"你没见过"** —— 它是见了又忘）
  //   · 后续新增   → "新增 N 条"
  const situation = opts.resend === true ? '上下文已压缩，重发当前有效' : (opening ? '你没见过' : '新增');
  const title = `${opts.titlePrefix} · ${situation} ${entries.length} 条 · ${todayMmDd()}`;
  const parts = [title];
  /**
   * 只在"给全量"的两种情形加一句指路（2026-09-29 02 桌便条 §四）：
   * **平台的注入发生在会话第一步，而"读办公室根 README"是会话的第一个动作** ——
   * ⇒ 新会话会先看到公告，但那时它还**不知道"02 桌"是谁、"根 README §八"在哪**。
   * **顺序改不了**（注入由平台事件触发，早于读 README），**能改的是"衔接"**。
   *
   * ⚠️ **不加"读过 README 就不再提示"的逻辑** —— 那要追踪会话读取状态 = 新机制，
   * 为了少一行字不值得（用户要"机制做少"）。
   * ⚠️ **也别加长** —— 它可能反复出现，长了就是噪音。
   */
  const withHint = opening || opts.resend === true;
  if (withHint && typeof opts.hint === 'string' && opts.hint !== '') parts.push('', opts.hint);
  /**
   * 压缩后重发时**额外**说一句用途（2026-09-30）。
   *
   * ⚠️ **为什么必须有**：压缩会把公告从上下文里"挤掉"，所以要重发一次 ——
   * **但重发的目的是"恢复上下文"，不是"让你重新研究一遍"。**
   * 没有这句话时，模型很容易把它当成**新到的重要信息**去重新分析，
   * **把开发注意力分散掉**（原话：*"不要让被 AI 去重新分析公告内容，这样反而会分散开发注意力"*）。
   *
   * ⇒ 所以：**一句话点明"这是上下文重建、不是新消息、不必重新分析、继续手上的活"**。
   * ⚠️ **只有压缩重发时才有这句** —— 开桌第一次看公告是应该认真看的。
   */
  if (opts.resend === true && typeof opts.resendNote === 'string' && opts.resendNote !== '') {
    parts.push('', opts.resendNote);
  }
  parts.push('', ...shown.map(lineFor));
  if (hidden > 0) {
    parts.push('', `还有 ${hidden} 条更旧的没列出，需要时读：${opts.file}`);
  }
  // ⚠️ 只有**真的哪儿都写不进去**时才提示（2026-09-29 复核：文件游标是持久的，
  //    所以 `storageDomain` 缺失**不再**算降级 —— 它只是走另一条同样可靠的路）。
  if (opts.degraded === true) {
    parts.push('', '（提示：本次的"已读位置"没能写进插件存储，所以这条可能在下一次重复出现。）');
  }
  /**
   * ⭐⭐ **坏行要报出来**（2026-10-01 加）。
   *
   * ## 为什么必须报
   *
   * 解析不了的行**永远送不到**，而在界面上它和"文件里根本没有这一行"**完全一样**。
   * ⇒ 一条格式写坏的公告，**作者以为发出去了，各桌永远收不到，而且两边都不报错。**
   *
   * ⚠️ **这正是 `docs\06 习惯二`**（"凡是跳过，都要留痕"），
   * 而这条规矩在本文件里被违反得最久 —— 原来那里就是一个 `continue`。
   *
   * ⚠️ **措辞要克制**：它只是"这一行读不懂"，**不是"办公室坏了"** ——
   * 别让读者以为要做什么。而且**最多列 3 行**（再多就是噪音）。
   */
  if (typeof opts.malformedHint === 'string' && opts.malformedHint !== '') {
    parts.push('', opts.malformedHint);
  }
  void visibleCount;
  const text = parts.join('\n');
  return createUserMessage({
    source: {
      kind: 'announcement',
      form: 'notice',
      summary: `办公室公告：${entries.length} 条${hidden > 0 ? `（另 ${hidden} 条未列出）` : ''}`,
    },
    content: [{ type: 'text', text }],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 发布：谁能确定发布者，谁就填；确定不了就诚实写"办公室"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从会话标题读桌号（2026-10-01 加，和投递插件用同一个判据）。
 *
 * 为什么需要：桌身份本来就在一个平台事实里 —— 会话标题（01-名字）。
 * 投递插件早就是这么认的，而公告这边原来只认 cwd；
 * 而 cwd 在多张桌共用一个工作区时认不出来（会全落回"办公室"）。
 *
 * 所以现在两个判据都用，而且标题优先。
 * 改这里就要同时想投递插件那边 —— 两个插件的认桌判据必须一致。
 */
const DESK_RE = /^\s*(\d{2})\s*[-－—–]\s*/u;

/**
 * 读会话标题里的桌号。
 *
 * @returns 两位数字（如 02），或 null（标题里没有前缀）。
 *
 * ⚠️ **这个函数必须和投递插件的 `deskFromTitle()` 保持一致** ——
 * 两个插件对"我是哪张桌"必须是同一个判据，否则会出现
 * "投递认得出、公告认不出"这种自相矛盾。
 */
function deskFromTitle(rawTitle) {
  if (typeof rawTitle !== 'string') return null;
  const m = DESK_RE.exec(rawTitle.trim());
  return m === null ? null : m[1];
}

/**
 * 从会话 cwd 推导发布者（**标题读不出桌号时的后备**）。
 *
 * ⚠️ **为什么兜底是"办公室"，而不是"未知来源"**（2026-09-29）：
 * Desktop 强制**会话 `cwd` 必须等于它所属工作区的路径**
 * （`dsh-workspace\lib\types\entity.js:80-83`），
 * 而**多张 DSH 桌共用同一个工作区**时 ⇒ **cwd 分不出是哪张桌**。
 * 所以"办公室"是**正确的答案**（确实是这个办公室发的），"未知来源"听起来像故障。
 *
 * ⚠️ **不要再加"子文件夹 -> 桌名"的映射** —— 那些键**永远不会被命中**
 * （cwd 永远不等于工作区下面的子文件夹），留着只会误导下一个读代码的人。
 *
 * 能自动确定的只有一种情况：**某个工作区只属于一张桌**
 * （例如 `D:\只有一张桌的工作区` → 01 桌）。
 */
function publisherFor(cwd, config) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return config.fallbackPublisher;
  const normalized = cwd.replace(/[\\/]+$/u, '').toLowerCase();
  const hit = Object.entries(config.publisherNames)
    .find(([path]) => path.replace(/[\\/]+$/u, '').toLowerCase() === normalized);
  if (hit !== undefined && hit[1] !== '') return hit[1];
  return config.fallbackPublisher;
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 插件自己的落盘目录：**优先问平台要 `DSH_HOME`**。
 *
 * ## ⚠️ 为什么不再写死 `%APPDATA%\dsh-desktop\harness\`（2026-10-03 改）
 *
 * 那个路径是**社区壳（DSH Desktop）**的家 —— 它只是**当时那个客户端**的约定，
 * 不是"平台给插件的位置"。官方 DeepSeek Harness 的家是 `DSH_HOME`（`~\.dsh`）。
 * 写死 APPDATA 的后果是实打实的：
 *
 * > `/mute` 的状态会被写进**那套已经停用、准备清掉**的旧家里 ——
 * > 把要删的目录重新造出来，而新家里永远找不到它。
 *
 * ⇒ 所以这里**和 `bulletin-dispatch` 的 `defaultStateFile()` 用同一套判据**：
 * **`DSH_HOME` → `%USERPROFILE%\.dsh`（官方客户端的默认家）**。
 *
 * ⚠️⚠️ **退路不许猜"社区壳那个家"**（2026-10-04 又实测了一次）：
 * 官方客户端里 **`DSH_HOME` 是空的**（没从环境里传下来）⇒ 退路生效 ⇒
 * `/mute` 的状态会被写进**那套已经停用、准备清掉的旧家**里去。
 * （社区壳自己会把家设进 `DSH_HOME` ⇒ 那条线照旧 ✓，不会因为这次改动受影响。）
 * ⭐ 最稳的是在 profile 的 patch 里显式配 `cursorFile` / `muteFile`（本机值写在本机配置里）。
 *
 * @returns {string} 目录；两个环境变量都没有时返回空串（调用方退化成裸文件名）
 */
function stateDir() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home !== '') return `${home}\\storages`;
  const profile = process.env.USERPROFILE;
  if (typeof profile === 'string' && profile !== '') return `${profile}\\.dsh\\storages`;
  return '';
}

/**
 * 游标文件的默认位置。
 *
 * 放在 **DSH 家目录的 `storages\`** 下，与平台自己的持久状态
 * （`checkpoints.json` / `workspace.json`）同处 —— 那是插件数据的正确归属地，
 * **不要写进工作区**（工作区是内容，不是运行时状态）。
 * 显式配置 `cursorFile` 可以覆盖。
 */
function defaultCursorFile() {
  const dir = stateDir();
  return dir === '' ? 'bulletin_announce_cursor.json' : `${dir}\\bulletin_announce_cursor.json`;
}

/** 静音状态文件的默认位置（与游标文件同处，理由同上）。 */
function defaultMuteFile() {
  const dir = stateDir();
  return dir === '' ? 'bulletin_announce_mute.json' : `${dir}\\bulletin_announce_mute.json`;
}


export const Config = z.object({
  /**
   * ⚠️ **这个没有默认值**（2026-10-01 改的）：原来默认写死了作者本机的路径。
   *
   * **一个猜错的默认值，比一个必填项糟** —— 插件会**安静地在别处建/读文件**，
   * 而用户不知道为什么公告是空的。
   *
   * **怎么填**：`<你的工作区>\00-通用\公告.md`
   */
  announcementFile: z.string()
    .description('公告文件路径（UTF-8 无 BOM。**AI 只追加；用户可以删改** —— 这是按角色写的规矩，'
      + '不是"这个文件不能被改"）'),
  /**
   * ⭐ **静音开关** —— 关掉后**一点活都不干**（连公告文件都不读），但 `announce` 工具仍可用。
   *
   * ## ⭐⭐ 2026-10-03：**`/mute` 改成每个会话一份了**
   *
   * | | 作用范围 | 怎么切 | 切回来时 |
   * |---|---|---|---|
   * | **`enabled: false`** | ⚠️ **全局**（所有会话） | 改配置 + 重启 | **不补**（它压根没记游标） |
   * | **`/mute`** | ⭐ **只有当前那个会话** | 随时，一个命令 | ⭐ **把静音期间积压的一次性补上** |
   *
   * **⇒ 现在一个是全局、一个是每会话**（**这才是它们该有的差别**）。
   *
   * ### ⚠️ 而这段注释**前两版都写错了**，错法还不一样（都留着，因为都有教益）
   *
   * | 版 | 写的 | 错在哪 |
   * |---|---|---|
   * | 1 | "`enabled` 是全局、`/mute` 是**单会话**" | ⚠️ **写反了** —— 那时 `/mute` 其实是全局的（`handler: () => {}` 连会话号都没接） |
   * | 2 | "**两个都是全局的**"（还专门解释了"会话级静音在这个插件里并不存在"） | ✅ 对当时是对，**而它把一个实现缺口写成了设计事实** |
   * | **3（现在）** | `/mute` 是每会话的 | —— |
   *
   * **⭐ 第 1 版和第 2 版合起来教了一件事**：
   * **"文档写错了"和"代码写错了"很难分清** ——
   * 第 1 版其实写的是**设计意图**（单会话），而我把代码的现状当成了唯一事实、
   * 于是**把意图改成了现实**（第 2 版），**还在注释里论证"它本来就该是全局的"。**
   * **⇒ 那比单纯记错更糟：它让一个 bug 看起来像设计。**
   */
  enabled: z.boolean().default(true)
    .description('静音开关：false = 完全不注入公告（连文件都不读）。⚠️ 这是全局的（所有会话），'
      + '区别是 /mute 解除时会把积压的补上，这个不会'),
  maxPerInjection: z.number().min(1).max(50).default(8).step(1)
    .description('单次最多列几条公告（超出的只报条数和文件路径）'),
  defaultTtlDays: z.number().min(0).max(3650).default(14).step(1)
    .description('条目没写有效期时的默认天数'),
  /** 工作区根。**没有默认值** —— 理由同 `announcementFile`。 */
  workspaceRoot: z.string()
    .description('工作区根目录（仅供人工核对；插件不靠 cwd 判断桌身份）'),
  publisherNames: z.dict(z.string()).default({
    /**
     * ⚠️ 键必须是**完整工作区路径**，不是子文件夹名 —— 见 `publisherFor` 的注释。
     *
     * ⚠️ **默认空**（2026-10-01）：原来这里写着作者本机的两个真实目录
     * （其中一个还是**另一个项目的工作区**）—— 那种默认值对别人毫无意义，
     * 而且会让人以为"这个键必须配"。
     *
     * **什么时候需要配它**：只有"**一个工作区只属于一张桌**"时才配。
     * 几张桌共用一个工作区的话，**分不出来** ⇒ 让它们落到 `fallbackPublisher`（"办公室"）才是诚实的。
     */
  }).description('工作区路径 -> 发布者显示名（只配"一个工作区只属于一张桌"的）'),
  fallbackPublisher: z.string().default('办公室')
    .description('推导不出桌名时的发布者（默认"办公室"—— 是正确答案，不是故障）'),
  titlePrefix: z.string().default('办公室公告').description('注入内容首行的开头'),
  /**
   * ## ⚠️ **默认 `hint` 改过**（2026-10-03，外部终审指出）
   *
   * ### 原来写的是
   *
   * ```text
   * （这是办公室的公告。桌名、以及各处「详见」指的位置，都在办公室根 README 里 ——
   *  它的 §二 是开新会话的第一步。还没读过就先读它。）
   * ```
   *
   * ⚠️ **而"§二"是**我们那份办公室 README 的**结构** ——**
   * **`examples/一个最小办公室/` 里根本没有"办公室根 README"，更没有 §二。**
   *
   * **⇒ 而这句话**每次开桌、每次压缩后都会注入** ⇒
   * **照着示例布环境的人，会被自己的插件反复指去一个不存在的小节。**
   *
   * ### 现在
   *
   * **只说"有一份办公室根 README、还没读就先读它"** ——
   * **它存在与否、里面怎么分节，是各个办公室自己的事。**
   * （示例的布置步骤里也补了一步"写办公室根 README"。）
   */
  hint: z.string().default(
    '（这是办公室的公告。桌名和各处「详见」指的位置，都写在办公室根目录的 README.md 里；'
    + '还没读过就先读它。）',
  ).description('注入时附的一句"指路"（只在开桌 / 压缩后重发时出现；留空 = 不附）'),
  resendNote: z.string().default(
    '（这是压缩后的上下文重建，**不是新消息**；条目内容与你之前看过的一样。'
    + '**不用重新分析、也不用回应用户**，继续手上的活即可。）',
  ).description('压缩后重发时额外那句"说明用途"（防止模型把重发当新信息重新分析）；留空 = 不附'),
  /** ⚠️ **默认关闭**（2026-10-01）：一个"默认就写日志"的插件，会在别人机器上到处留文件。 */
  debugLog: z.string().default('')
    .description('诊断日志（JSONL，逐行追加）。留空 = 关闭。只在排查问题时需要看它。'),
  cursorFile: z.string().default(defaultCursorFile())
    .description('每会话"已读到哪"的游标文件。平台存储域可用时优先用存储域；否则用它（持久）'),
  muteFile: z.string().default(defaultMuteFile())
    .description('静音状态文件（/mute 与 /unmute 用）。⚠️ 必须持久，否则重启后静音自己解除；'
      + '⚠️ 它按会话记（一个一个 sessionId），不再是一个全局布尔'),
  /**
   * ⚠️⚠️ **这段文案 2026-10-03 改成条件句**（因为渲染它的人分不清是哪个会话）。
   *
   * ## 为什么必须改
   *
   * 那一段渲染在**系统提示**里，而**渲染回调拿不到会话号**
   * （`AssembleContext.scope` 是不透明对象）⇒ 它只能问"这台机器上有人静音过吗"。
   * **⇒ 于是"没静音但机器上别人静音了"的会话也会读到这段。**
   *
   * **⇒ 原文"目前处于**静音**状态"会直接误导那些会话**（它们明明在正常收公告）。
   * 改成**条件句**：它说的是"**如果你发现公告没来**"，**而不是"你就是静音的"**。
   */
  mutedNotice: z.string().default(
    '（**如果你发现办公室公告没来**：可能有人在这个会话里执行了 `/mute`。'
    + '要恢复并补上积压的，让用户执行 `/unmute`。）',
  ).description('有会话静音时写进系统提示的那一行（⚠️ 是条件句 —— 读到它的会话不一定自己静音了）；留空 = 不提示'),
});

export function apply(ctx, config) {
  const file = config.announcementFile;
  const opts = config;
  /**
   * 诊断输出。
   *
   * ⚠️ **不能只走 `ctx.logger.info`** —— 实测（2026-09-29）它**到不了**
   * `%APPDATA%\dsh-desktop\logs\harness.log`（日志桥只接了 warn/error），
   * 于是"加了诊断却什么也看不到"。现在走**两条都不依赖平台**的路：
   *   ① `process.stderr.write`（日志桥明确会带走 stderr）
   *   ② 追加写 `debugLog` 指定的 JSONL（**我自己完全掌控，最可靠**）
   */
  const log = (message, extra) => {
    const stamp = new Date().toISOString();
    const line = `[bulletin-announce] ${message}`;
    try {
      ctx.logger?.info?.(line);
    } catch {
      /* 不影响功能 */
    }
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      /* 不影响功能 */
    }
    if (typeof opts.debugLog === 'string' && opts.debugLog !== '') {
      try {
        appendFileSync(opts.debugLog, `${JSON.stringify({ t: stamp, msg: message, ...extra })}\n`, 'utf8');
      } catch {
        /* 诊断写不了就算了，绝不影响功能 */
      }
    }
  };

  // ── 存储：**先用插件自己的游标文件**，平台存储域存在时优先用它 ──────────────
  //
  // ⚠️ 为什么主路径不是 `storageDomain`（2026-09-29 实测）：那个服务在本机运行时
  //    **是缺失的**（插件日志：`storageDomain=缺失`），于是游标只能待在内存里
  //    ⇒ 每次重启/压缩都重发一遍公告。**协议本来就允许"读者自己记游标"**
  //    （见 `协议-只增不改的公告文件-v1.md` §4 —— ⚠️ **那份文档在我们桌里，不在仓库里**；
  //     而它的**文件名**里还留着那个旧名字，"只增不改"**描述的是"AI 只往后加"**，
  //     不是"文件不能被改"），所以自持一个 JSON 文件是最稳的。
  //    存储域仍然保留：本机将来装配了它，就自动升级用它（等价于原设计）。
  let domainPromise;
  const domainIssues = [];
  let domainClosed = false;

  /** 文件游标：形状与存储域的表一致，`{ [sessionId]: { ids, updatedAt } }`。 */
  const cursorFile = typeof opts.cursorFile === 'string' && opts.cursorFile !== '' ? opts.cursorFile : undefined;
  let cursorDoc;

  function loadCursorDoc() {
    if (cursorDoc !== undefined) return cursorDoc;
    cursorDoc = {};
    if (cursorFile === undefined) return cursorDoc;
    try {
      if (existsSync(cursorFile)) {
        const parsed = JSON.parse(readFileSync(cursorFile, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cursorDoc = parsed;
      }
    } catch (error) {
      log('游标文件读不了，从空开始', { error: String(error?.message ?? error) });
    }
    return cursorDoc;
  }

  /**
   * 把游标写盘。⚠️⚠️ **原子写 + 存不住就抛**（2026-10-05 改，回应 Codex 审查 **P2-6**）。
   *
   * ## 原来错在哪
   *
   * 直接 `writeFileSync(cursorFile, …)` **覆盖写** ✗ ⇒ 写到一半崩就是**半截 JSON** ✓；
   * 而失败只 `log` 一句、**不上报** ✗ ⇒ 上层（`saveSeen`）以为存住了 ✓
   * ⇒ **它那个"写失败要留痕"的分支永远不会触发** ✗ ⇒ 重启后从空账开始 ⇒ **公告重发一遍** ✓。
   *
   * ## 现在
   *
   * 先写 `.tmp` 再 `rename`（和 dispatch、面板同一个套路 ✓）；**失败抛出去** ✓
   * ⇒ `saveSeen` 会如实记 `writeFailed` 并进 `domainIssues` ✓。
   * ⭐ **存住了才更新内存那份**（`cursorDoc = doc`）—— 和 dispatch 的 P1-1 修法一致 ✓。
   *
   * @param {object} doc 要落盘的那份（**调用方先改副本** ✓）
   */
  function persistCursorDoc(doc) {
    if (cursorFile === undefined) { cursorDoc = doc; return; }   // 没有文件 ⇒ 内存就是全部 ✓
    mkdirSync(dirname(cursorFile), { recursive: true });
    const tmp = `${cursorFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      renameSync(tmp, cursorFile);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* 清理失败就算了 */ }
      throw error;
    }
    cursorDoc = doc;                                             // ⭐ 存住了才认这份 ✓
  }

  /**
   * 与存储域的表同形状的极简实现：`get` / `put` / `delete`。
   *
   * ⚠️⚠️ **`entries()` 是 2026-10-01 补的，而且它的缺失害我绕了一圈。**
   *
   * ## 现场
   *
   * 我加"列出每条公告被几个会话见过"（`seenCounts`）时，写的是：
   *
   * ```js
   * const entries = typeof table?.entries === 'function' ? [...table.entries()] : [];
   * ```
   *
   * —— **一个"没有就当作空"的兜底。** 而存储域那张表**有** `entries()`、
   * 这个文件表**没有** ⇒ 而那台机器上 `storageDomain` 是缺的（正常情况！）
   * ⇒ **走的就是这个文件表** ⇒ `entries()` 不存在 ⇒ **兜底成空数组** ⇒
   * **`sessions: 0`、每条都是 `undefined`。**
   *
   * **⚠️ 而它不报错、不抛异常、接口返回 200** —— 一个看起来完全正常的"没有人见过"。
   * **⇒ 那正是这次改动要消灭的那类失败，而我差点又造了一个。**
   *
   * ⇒ 现在两张表**形状对齐**（域的表有 `entries()`，这里也补上）。
   * **⚠️ 教训**：写 `typeof x === 'function' ? … : 兜底` 的时候，
   * 那个"兜底"是在**替一个静默失败打掩护** ——
   * **先确认两边形状真的一样，再写兜底。**
   */
  const fileTable = {
    get: (key) => loadCursorDoc()[key],
    /**
     * ⭐⭐ **改副本 → 存住 → 才算数**（2026-10-05 改，回应 Codex 审查 **P1-1** + **P2-6**）。
     *
     * 原来先改内存那份、再 `persistCursorDoc()` ✗ —— 而它**吞错** ⇒
     * 一次写失败之后，内存里"这条已经读过了"、磁盘上却什么都没有 ✗
     * ⇒ 重启后**重新注入一遍**（用户看到的公告重复 ✓），而**谁也没被告知** ✓。
     * 现在存不住就**抛** ✓ ⇒ `saveSeen` 的失败分支会如实记下来 ✓。
     */
    put: (key, value) => {
      const next = { ...loadCursorDoc(), [key]: value };
      persistCursorDoc(next);
    },
    delete: (key) => {
      const cur = loadCursorDoc();
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return false;
      const next = { ...cur };
      delete next[key];
      persistCursorDoc(next);
      return true;
    },
    /** ⭐ 和存储域的表同形状：**枚举全部 `[sessionId, record]`**。 */
    entries: () => Object.entries(loadCursorDoc()),
  };

  /** 真的写不进去时才置位（决定注入内容里要不要提示用户）。 */
  let writeFailed = false;

  function getDomain() {
    if (domainPromise === undefined) {
      domainPromise = (async () => {
        const facility = ctx.get('storageDomain');
        if (facility === undefined) {
          const reason = 'storageDomain 未装配 —— 游标走插件自己的文件（正常且持久，不是降级）';
          domainIssues.push(reason);
          log(reason, { cursorFile });
          return undefined;
        }
        try {
          const handle = await facility.open(announceDomainSpec);
          ctx.effect(() => () => {
            domainClosed = true;
            void handle.close().catch(() => {});
          });
          const table = handle.table(CURSOR_TABLE);
          log('游标域已打开（优先用存储域）', { put: typeof table?.put });
          return table;
        } catch (error) {
          // 域打不开 → 退回插件自己的文件。**这不是降级**（文件同样持久），只是换了条路。
          const reason = `存储域打不开，改用游标文件：${error instanceof Error ? error.message : String(error)}`;
          domainIssues.push(reason);
          log(reason, { cursorFile });
          return undefined;
        }
      })();
    }
    return domainPromise;
  }

  /** 取当前该用的"表"：存储域有就用它，否则用插件自己的游标文件（**持久，不是降级**）。 */
  async function activeTable() {
    if (!domainClosed) {
      const table = await getDomain();
      if (table !== undefined) return { table, where: 'domain' };
    }
    return { table: fileTable, where: 'file' };
  }

  /** 读一张表的已见 id（两张表的形状一样）。 */
  const idsOf = (table, sessionId) => {
    try {
      const record = table.get(sessionId);
      return Array.isArray(record?.ids) ? record.ids : [];
    } catch {
      return [];
    }
  };

  /**
   * 读"已见"。
   *
   * ⚠️ **两张表要取并集**（2026-09-29 修）：域与游标文件**可能同时有数据**
   * （域修好之前写的是文件，之后写的是域）。只读其中一张 ⇒
   * 在另一张里记过的会话会被当成"没见过" ⇒ **重复注入**。
   * 取并集之后，两边谁记得都算数。
   */
  async function loadSeen(sessionId) {
    const { table, where } = await activeTable();
    const primary = idsOf(table, sessionId);
    const fallback = where === 'domain' ? idsOf(fileTable, sessionId) : [];
    const merged = new Set([...primary, ...fallback]);
    log(`loadSeen 读到 ${merged.size} 条已见`, {
      session: sessionId.slice(0, 20), where, primary: primary.length, fallback: fallback.length,
    });
    return merged;
  }

  /**
   * ## ⭐⭐ **列出"每条公告被几个会话见过"**（2026-10-01 加）
   *
   * ### 为什么这件事必须由**这个插件**来做
   *
   * 原来这个数字是**面板**自己算的 —— 而它为了算它，要碰**四样不属于它的东西**：
   *
   * | 面板原来要碰的 | 为什么不对 |
   * |---|---|
   * | 写死的路径 `%APPDATA%\…\harness\storages` | ⚠️ **dispatch 优先用 `DSH_HOME`，面板不看** ⇒ 两个插件认的目录可能不是一个 |
   * | 平台的**磁盘格式** `{ unit, global, tables: { seen } }` | ⚠️ 那是**存储域后端自己的格式**，平台一改面板就瞎 |
   * | 这个插件的**私有游标文件** | ⚠️ 那是内部状态，不是接口 |
   * | **抄一份指纹算法** | ⚠️ 实测已经咬过一次（行尾空格 ⇒ "见过数"变 0） |
   *
   * **⇒ 四样加起来，那个数字有四个独立的出错理由** —— 而它是**删除前唯一的提醒**。
   *
   * ### 现在：只有这个插件知道"谁知道"
   *
   * 它知道自己的指纹怎么算、自己的 seen 存在哪、哪些会话算数。
   * **⇒ 面板只管显示，一个字节的内部格式都不用碰。**
   *
   * @param {Set<string>|null} [live] 还存在的会话 id。
   *   ⚠️ **不传或传 `null` ⇒ 不过滤**（有一个会话的记录就算一个）。
   * @returns `{ seen: Record<指纹, 人数>, filtered: boolean, sessions: number }`
   *   ⚠️ **`filtered: false` 表示"没过滤"** —— 面板要能区分
   *   "**真的没人见过**"（`0`）和"**我问不出来**"（它不会出现在映射里）。
   */
  async function seenCounts(live = null) {
    const filtered = live !== null && live !== undefined;
    const map = Object.create(null);
    let counted = 0;
    /** ⚠️ **两张表都要看**（域 + 文件），和 `loadSeen` 同一个理由：谁记得都算数。 */
    const tables = [fileTable];
    if (!domainClosed) {
      const t = await getDomain();
      if (t !== undefined) tables.unshift(t);
    }
    /** `sessionId -> Set(ids)` 的并集。 */
    const bySession = new Map();
    for (const table of tables) {
      let entries;
      try {
        entries = typeof table?.entries === 'function' ? [...table.entries()] : [];
      } catch (error) {
        log(`seenCounts 读表失败（已忽略这一张）：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const [sessionId, record] of entries) {
        if (typeof sessionId !== 'string' || sessionId === '') continue;
        if (filtered && !live.has(sessionId)) continue;
        const ids = Array.isArray(record?.ids) ? record.ids : [];
        if (ids.length === 0) continue;
        let set = bySession.get(sessionId);
        if (set === undefined) { set = new Set(); bySession.set(sessionId, set); }
        for (const id of ids) if (typeof id === 'string') set.add(id);
      }
    }
    for (const set of bySession.values()) {
      counted += 1;
      for (const id of set) map[id] = (map[id] ?? 0) + 1;
    }
    return { seen: map, filtered, sessions: counted };
  }

  async function saveSeen(sessionId, ids) {
    const { table, where } = await activeTable();
    try {
      await table.put(sessionId, { ids: [...ids], updatedAt: Date.now() });
      log('saveSeen 已写入', { session: sessionId.slice(0, 20), count: ids.size, where });
    } catch (error) {
      // 不吞：写失败必须留痕，否则就成了"注入成功但游标没落盘"这种静默不一致。
      writeFailed = true;
      const reason = `saveSeen 写入失败（${where}）：${error instanceof Error ? error.message : String(error)}`;
      domainIssues.push(reason);
      log(reason, {
        session: sessionId.slice(0, 20),
        count: ids.size,
        where,
        tableType: typeof table,
        putType: typeof table?.put,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /**
   * 因压缩而重置游标的会话。
   *
   * 用来把首行说准：压缩后重发**不是**"你没见过"，而是"见了又忘"。
   * 只影响一次（那次注入之后删掉）。
   */
  const resentAfterCompaction = new Set();

  async function clearSeen(sessionId) {
    resentAfterCompaction.add(sessionId);
    const { table, where } = await activeTable();
    const record = table.get(sessionId);
    if (record !== undefined) await table.delete(sessionId);
    /**
     * ⭐⭐ **兜底那份也要清**（2026-10-05 加，回应 Codex 审查 **P2-5**）。
     *
     * ## 那个不对称
     *
     * **读**的时候是"**存储域 ∪ 兜底文件**"两份合并 ✓（谁记得都算数 ✓）——
     * 而**清**的时候只清**当前那张表** ✗ ⇒ 兜底里的旧记录会被**合并回来** ✓ ⇒
     * 这个会话的"已见"看起来没被清掉 ⇒ **压缩之后该重发的公告发不出去** ✓
     * （用户以为"压缩了会补课"，其实没有 ✓）。
     *
     * ## 现在
     *
     * **和读对称：两边都清** ✓。清兜底失败**不抛**（压缩检测那条路不该因为存储失败而中断 ✓）——
     * 但要**留痕**（`docs\06 习惯二`：凡是跳过都要留痕 ✓）。
     */
    if (where !== 'file') {
      try {
        if (fileTable.get(sessionId) !== undefined) fileTable.delete(sessionId);
        log('clearSeen 顺带清了兜底游标（否则它会和被清掉的那份合并回来）', { session: sessionId.slice(0, 20) });
      } catch (error) {
        log('clearSeen 清兜底游标失败 —— 下次压缩后可能不重发', {
          session: sessionId.slice(0, 20),
          error: String(error?.message ?? error),
        });
      }
    }
    log('clearSeen 已删除（下次重发并标注原因）', { session: sessionId.slice(0, 20), where });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 静音（/mute · /unmute）
  //
  // ## ⚠️⚠️ **这一段原来写反了**（2026-10-01 清掉的）
  //
  // 它原来写着：
  //
  //   > "翻译成机制：**解除静音时不能把静音期间积压的补上** —— 否则一解除就刷一屏。"
  //
  // **⇒ 那是反的**，而且**它和本文件另外两处（下面 L8xx 的 `/unmute` 回执、
  // 以及压缩重置那段）写的正好相反** —— 那两处是对的。
  // **⇒ 同一条语义在同一个文件里有两个说法，而错的那个在最上面。**
  //
  // ## 真正的语义（**原话，被纠正过一次**）
  //
  //   > **"以 /mute 为基线补发积压的，不然信息差补不上。"**
  //
  // **⇒ 解除静音时要把静音期间积压的公告一次性补上。**
  // 理由不是"用户体验"，是**信息本身**：静音期间别人发的东西，
  // **不补就等于这些会话永远缺一块**（而它们还以为自己看全了）。
  //
  // ⚠️ **怎么实现的**：静音期间**完全不动游标**（不是"记下来以后跳过"）——
  // 游标停在原处 ⇒ 解禁时那些条目仍然是"没见过"的 ⇒ 自然被补发。
  // **⇒ 所以这个语义不需要额外机制，只需要"静音时别推进游标"。**
  // ───────────────────────────────────────────────────────────────────────────

  /** 静音状态文件（**必须持久**，否则重启后静音自己解除、公告又冒出来）。 */
  const muteFile = typeof opts.muteFile === 'string' && opts.muteFile !== '' ? opts.muteFile : undefined;
  /**
   * `{ muted: boolean, since: number|null }`
   *
   * ⚠️ **这里原来还有一个 `mutedIds: string[]`** —— 2026-10-01 删掉了。
   * 它是那句**写反了的注释**（"解除静音时不补发"）的产物：
   * 那种设计需要一个字段记住"静音期间发过哪些、解禁时要跳过它们"。
   *
   * **⇒ 而真实语义是"要补发"** ⇒ **根本不需要这个字段** ——
   * 静音期间不动游标就够了。
   * **⇒ 于是它成了一个"每次读/写都带上、但从来没被读过一次"的死字段。**
   *
   * **⚠️ 而死字段比"没用的代码"更糟**：它会让人以为"静音是按条目记的"，
   * 从而**推出一个错的行为**（就像我照着那行注释写错过 `enabled` 的说明）。
   */
  /**
   * ## ⭐⭐ 2026-10-03：**静音改成"每个会话一份"了**（原来是全局的）
   *
   * ### 原来是什么样（**一个实现跑偏了的设计**）
   *
   * ```js
   * let muteState = { muted: false, since: null };   // ⚠️ 一个布尔、一个时间
   * ```
   *
   * **⇒ 在任何会话里敲 `/mute`，所有会话全停收。**
   *
   * ### ⚠️ 而它自己的说法是"给你静音"
   *
   * `/mute` 的回执原文：*"静音期间别的桌照常发公告，**只是不注入给你**"* ——
   * **说给"你"，做给"所有人"。**
   *
   * ### 为什么能改成每会话（**问过平台契约**）
   *
   * | 需要什么 | 有没有 |
   * |---|---|
   * | `/mute` 那个 handler 拿得到会话身份吗 | ✅ **拿得到** —— `CommandInvocation.agent.id`（`Agent { id: SessionId }`） |
   * | 注入那条路拿得到吗 | ✅ **它本来就有**（`deliver(agent, …)` 里 `agent.session.id`） |
   * | 命令能注册成 agent 作用域吗 | ✅ 能（*"definitions registered through a command-injected child of an agent context **shadow globals for that agent**"*） |
   *
   * **⇒ 三个条件都满足，所以全局从来不是"做不到"，是"当时没接那个参数"**
   * （`handler: () => {}` —— **连 `invocation` 都没接**）。
   *
   * ### 新形状
   *
   * ```js
   * { muted: { '<sessionId>': { since: 1727… } } }
   * ```
   *
   * ⚠️ **`since` 也必须是每会话的** —— 它记的是"这个会话从什么时候开始静音"，
   * 而"积压从哪算起"本来就是每个会话各自的（游标也是每会话一份）。
   *
   * ⚠️ **向后兼容**：老的 `{ muted: true, since: N }` 读进来会被**忽略并清掉**
   * （**不迁移** —— 旧的"全局静音"没法猜它想静音哪个会话；
   * 而"升级后静音自己解除"这个后果是**可接受的**：它只会多收几条公告，
   * **而多收一条公告远好过"一直静音着而用户不知道"。**）
   */
  let muteState;

  function loadMuteState() {
    if (muteState !== undefined) return muteState;
    muteState = { muted: {} };
    if (muteFile === undefined) return muteState;
    try {
      if (existsSync(muteFile)) {
        const parsed = JSON.parse(readFileSync(muteFile, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && parsed.muted !== null && typeof parsed.muted === 'object') {
          /** ⚠️ 逐项校验：只收"值是对象、且 since 是数"的那些。 */
          const kept = {};
          for (const [sid, v] of Object.entries(parsed.muted)) {
            if (sid !== '' && v !== null && typeof v === 'object') {
              kept[sid] = { since: typeof v.since === 'number' ? v.since : Date.now() };
            }
          }
          muteState = { muted: kept };
        } else if (parsed?.muted !== undefined) {
          /** ⚠️ 老形状（全局布尔）⇒ **不迁移**，只记一笔。 */
          log('静音状态是老形状（全局的），已按"未静音"处理', { was: parsed.muted });
        }
      }
    } catch (error) {
      log('静音状态读不了，按"未静音"处理', { error: String(error?.message ?? error) });
    }
    return muteState;
  }

  /**
   * 把静音状态写盘。⚠️ **原子写**，并且**返回"到底存住了没有"**（2026-10-05 改，回应 Codex 审查 **P2-6**）。
   *
   * 静音是**用户主动下的命令** ⇒ 存不住时**不该让命令失败**（静音当场就生效 ✓），
   * 但**必须如实告诉用户"重启会失效"** ✓ —— 所以这里返回布尔，由调用方补一句 ✓。
   *
   * @returns {boolean} 是否真的落盘（没有配静音文件时算"不需要落盘，成功" ✓）
   */
  function persistMuteState() {
    if (muteFile === undefined) return true;
    const tmp = `${muteFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dirname(muteFile), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(loadMuteState(), null, 2)}\n`, 'utf8');
      renameSync(tmp, muteFile);
      return true;
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* 清理失败就算了 */ }
      log('静音状态写不了（静音可能不持久）', { error: String(error?.message ?? error) });
      return false;
    }
  }

  /** ⭐ **按会话查**（`sessionId` 必传 —— 传空/非字符串 ⇒ 一律当"没静音"）。 */
  const isMuted = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    return loadMuteState().muted[sessionId] !== undefined;
  };

  /** 当前文件里**有效**的全部条目（`/unmute` 时用来如实报告"积压了几条"）。 */
  const activeEntries = () => parseAnnouncements(file, 500, opts.defaultTtlDays).entries;

  // 命令：/mute 与 /unmute
  ctx.effect(() => ctx.inject(['commands'], (cctx) => cctx.commands.register({
    definitionId: CommandDefinitionId('dsh-bulletin-announce/mute'),
    name: 'mute',
    description: '静音办公室公告（**只静音当前这个会话**）：静音期间不注入；解除时把静音期间积压的一次性补上',
    /**
     * ⚠️ **`invocation.agent.id` 就是会话号**（2026-10-03 才接上这个参数）。
     *
     * **原来写的是 `handler: () => {…}`** —— 连参数都不接，
     * 所以"按会话静音"根本无从谈起（**而回执却写着"不注入给你"**）。
     */
    handler: (invocation) => {
      const sessionId = invocation?.agent?.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { kind: 'error', text: '拿不到这个会话的标识，无法只静音它（这条命令需要会话上下文）。' };
      }
      const state = loadMuteState();
      if (state.muted[sessionId] !== undefined) {
        return { kind: 'success', text: '公告在这个会话里已经是静音状态。用 /unmute 恢复（届时会补上积压的）。' };
      }
      state.muted[sessionId] = { since: Date.now() };
      /** ⭐ 存住了没有（2026-10-05）—— 存不住就明说"重启会失效" ✓，不假装一切正常 ✗ */
      const mutedSaved = persistMuteState();
      log('已静音（本会话）', { session: sessionId, since: state.muted[sessionId].since, saved: mutedSaved });
      return {
        kind: 'success',
        text: '办公室公告**在这个会话里**已静音。别的桌照常发公告，**别的会话也照常收** —— '
          + '只是不注入给你；用 /unmute 恢复时会把这段时间**积压的一次性补上**（不会漏掉）。'
          + (mutedSaved ? '' : '\n\n⚠️ **但这个静音状态没能写进磁盘** —— 这次重启之后它会失效。'),
      };
    },
  })));

  ctx.effect(() => ctx.inject(['commands'], (cctx) => cctx.commands.register({
    definitionId: CommandDefinitionId('dsh-bulletin-announce/unmute'),
    name: 'unmute',
    description: '解除办公室公告静音（只解除当前这个会话）：把静音期间积压的公告一次性补上',
    handler: (invocation) => {
      const sessionId = invocation?.agent?.id;
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { kind: 'error', text: '拿不到这个会话的标识，无法只解除它（这条命令需要会话上下文）。' };
      }
      const state = loadMuteState();
      const mine = state.muted[sessionId];
      if (mine === undefined) return { kind: 'success', text: '公告在这个会话里本来就没静音。' };
      // ⚠️ **不需要动游标**（2026-09-29 纠正语义后复核）：
      //    静音期间根本不注入 ⇒ 这个会话的游标**自然停在那里** ⇒
      //    一解除，下一步就会把"积压的"当作"没见过"正常送出去。
      //    **这正是用户要的**：*"以 /mute 为基线补发积压的，不然信息差补不上。"*
      const pending = activeEntries().length;
      delete state.muted[sessionId];
      const unmutedSaved = persistMuteState();
      log('已解除静音（本会话，积压会在下一步补上）', {
        session: sessionId,
        activeNow: pending,
        mutedForSec: Math.round((Date.now() - mine.since) / 1000),
      });
      return {
        kind: 'success',
        text: `办公室公告**在这个会话里**已恢复。当前文件里有效 ${pending} 条 —— `
          + '你静音期间积压的那些，会在下一次注入时**一并补上**。'
          + (unmutedSaved ? '' : '\n\n⚠️ **但"解除静音"没能写进磁盘** —— 这次重启之后可能又变回静音。'),
      };
    },
  })));

  /**
   * ## ⚠️⚠️ **`order` 是必填的**（2026-10-02 修 —— 这个漏了一整天多）
   *
   * ### 症状（**02 桌报出来的**）
   *
   * ```
   * error bulletin-announce: TypeError: prompt section "bulletin-announce:muted" order must be a finite number
   * ```
   *
   * **从 2026-09-29 23:14 起，每次挂载都报**（`harness.log` 里约 85 次）。
   *
   * ### 根因
   *
   * 服务契约里 `PromptSection.order: number` 是**必填**，**没有默认值**：
   *
   * ```ts
   * export interface PromptSection {
   *     readonly name: string;
   *     readonly order: number;   // ⚠️ 忘了传就抛
   *     readonly text: string | ((context) => string);
   * }
   * ```
   *
   * **而这里原来只给了 `name` 和 `text`** ⇒ 回调抛 ⇒ **那一段从来没注册上。**
   *
   * ### ⚠️ 为什么它躲了一天多没被发现
   *
   * **因为"静音提示"只在 `/mute` 之后才该出现** ——
   * 平时就算注册成功，它渲染出来也是空串（`isMuted()` 是 false）。
   * **⇒ 唯一的症状是日志里每隔一次挂载多一行 error**，而**功能上什么都没坏。**
   *
   * ⭐ **这正是那种"只有日志知道"的缺陷** —— 而它被 02 桌翻日志翻出来了。
   *
   * ### ⚠️ 而这一段是我自己写过的
   *
   * `f1-propose-rename.js` 里有一模一样的警告：
   * *"⚠️ `order` 是必填的（服务契约 `PromptSection.order: number`），忘了传会抛错。"*
   * **⇒ 我在那边写了，然后在这边忘了。**
   *
   * ### 值取多少
   *
   * **同一个约定：一个小正数**（和 `f1` 的 400、`f2` 的 420 同族，排在"身份/人设"之后、
   * 具体工具说明之前）。**`announce` 的注入说明本来就该在这一带。**
   */
  const SECTION_ORDER = 410;

  /**
   * ## ⚠️⚠️ 这个提示段 2026-10-03 **语义变了**（因为它从"全局静音"变成"每会话静音"）
   *
   * ### 现在它不能问"是不是静音了"
   *
   * 那个 `text` 回调拿到的上下文是 **`AssembleContext { scope?: ScopeKey; signal? }`** ——
   * ⚠️ **`scope` 是个不透明对象，不是会话号**（问过平台契约）。
   * **⇒ 从这里问不出"当前这个会话静音了没有"。**
   *
   * ### 那它渲染什么
   *
   * **渲染一段固定的说明**（`mutedNotice`）—— 它只在**真的静音了**的时候才有意义，
   * 而**"现在是不是静音着"由 `deliver()` 那边拦**（那里有 `sessionId`）。
   *
   * ⚠️ **代价说清**：**没静音的会话也会在系统提示里看到这段话。**
   * ⇒ 所以 `mutedNotice` 的措辞要**写成"如果你看到公告没来"**那种条件句，
   * **而不是"你已经静音了"**（后者会误导没静音的会话）。
   *
   * ⭐ **判据**：**拿不到会话身份的地方，就别假装自己拿得到** ——
   * 宁可渲染一段条件句，也不要按全局状态瞎猜（原来那个 `isMuted()` 正是全局的）。
   */
  ctx.effect(() => ctx.inject(['systemPrompt'], (pctx) => pctx.systemPrompt.section({
    name: 'bulletin-announce:muted',
    order: SECTION_ORDER,
    /**
     * ⚠️ **渲染前再确认一次"这台机器上到底有没有任何会话在静音"** ——
     * 一个都没有（绝大多数时候）就渲染空串，**别让所有会话都白读一段**。
     *
     * ⇒ 于是它的实际行为是：**"有人静音过"时才出现，而它说的是条件句。**
     * （**这是能做到的最好的近似** —— 真正精确需要 agent 作用域，那是另一条路。）
     */
    text: () => (Object.keys(loadMuteState().muted).length > 0 ? (opts.mutedNotice ?? '') : ''),
  })));

  // ── 发布工具（所有模式可见：全局注册） ──────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // ⭐⭐ **只读接口：`GET /sidebar/api/announce/seen`**（2026-10-01 加）
  //
  // ## 为什么要有它
  //
  // 面板要显示"有几个会话见过这条"（**删除前唯一的提醒**）。
  // 原来它自己算 —— 而为了算它，**要碰四样不属于它的东西**（写死的路径、
  // 平台的磁盘格式、这个插件的私有游标文件、抄一份指纹算法）。
  // **⇒ 那个数字于是有四个独立的出错理由。**（"抄指纹"那一条已经真的咬过一次。）
  //
  // **⇒ 现在算这件事回到这个插件里** —— 只有它知道指纹怎么算、seen 存在哪、谁算数。
  //
  // ## ⚠️ 只读、只本机、失败就明确失败
  //
  // - **只有 GET**（405 挡掉别的）
  // - **只认本机同源**（403 挡掉别的）—— 和面板那几条写路由一个规格，虽然这条是只读的
  // - **问不到会话名单时 `filtered: false`**（而不是假装过滤过）
  //   ⇒ 面板就能区分"**真的没人见过**"和"**我问不出来**"，那是这次改动的一半价值
  // ───────────────────────────────────────────────────────────────────────────

  /** 平台会话名单服务（拿它来滤掉已经不存在的会话）。 */
  let sessionQuery;
  ctx.effect(() => ctx.inject(['sessionQuery'], (sctx) => {
    sessionQuery = sctx.sessionQuery;
    return () => { sessionQuery = undefined; };
  }));

  /**
   * ⚠️ **`rec.header.id`** —— id **不在顶层**（2026-10-01 在面板那边踩到，代价是"全 0"）。
   * 平台契约是 `{ header: SessionHeader; live: boolean; persisted: boolean }`，
   * **没有 `sessionId`、没有 `id`。**
   * @returns `Set<string>|null` —— `null` 表示**问不到**（不是"一个都没有"）
   */
  async function liveSessionIds() {
    const sq = sessionQuery;
    if (sq === undefined || sq === null || typeof sq.listSessions !== 'function') return null;
    try {
      const list = await sq.listSessions();
      if (!Array.isArray(list)) return null;
      const ids = new Set();
      for (const rec of list) {
        const id = rec?.header?.id;
        if (typeof id === 'string' && id !== '') ids.add(id);
      }
      return ids.size === 0 ? null : ids;
    } catch (error) {
      log(`问会话名单失败（这一轮不过滤）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 读这个会话的**标题**（`01-名字` 那种）。
   *
   * ⚠️ **标题不在 `header` 里** —— `header.title` 永远是 `null`，
   * **必须调 `sessionQuery.readTitle()`**（投递插件那边也踩过同一个坑，见它的 `identity.js`）。
   *
   * ⚠️ **`sessionQuery` 这个变量在上面只声明了一次**（`let sessionQuery;`）——
   * 它同时服务于"滤会话名单"和"读标题"两件事。
   * **我加这个函数时在下面又声明了一遍**（`let sessionQuery;` 第二处），
   * 而**同一个作用域里重复 `let` 是语法错误**。
   *
   * ## ⚠️⚠️ 而那次的排查过程比错误本身更值得记
   *
   * **node 把出错位置报成了另一个函数（`deskFromTitle`）所在的行** ——
   * V8 的作用域预扫会让行号**偏到前面去**。
   * **⇒ 我信了那个行号，把那个函数周围的注释、反引号、配对全查了一遍，绕了很久。**
   * **⇒ 最后是 `grep` 给出权威行号、一眼看见"两个 `let sessionQuery`"，才结束。**
   *
   * **⭐ 教训**：**`node --check` 报的行号可以偏；`grep` 报的不会。**
   * 遇到"那个位置看起来完全正常"的语法错误，**先去找重复声明/重复定义**。
   *
   * @returns `Promise<string|null>` —— 读不到就 `null`（**调用方据此回落后备判据**，不报错）
   */
  async function readSessionTitle(sessionId) {
    const sq = sessionQuery;
    if (sq === undefined || sq === null || typeof sq.readTitle !== 'function') return null;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    try {
      const snap = await sq.readTitle(sessionId);
      /** ⚠️ 平台可能给 `{ title }` 也可能直接给字符串 —— **两种都认**（和投递那边一致）。 */
      const title = typeof snap === 'string' ? snap : snap?.title;
      return typeof title === 'string' && title !== '' ? title : null;
    } catch (error) {
      log(`读会话标题失败（这一条按后备判据署名前）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 写一个 JSON 响应（和面板那半边同一形状）。 */
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  /**
   * ⚠️ **和面板那份是同一套判据**（回环地址 + 严格端口）。
   * 那份在 `docs\04` 里记着（含 IPv6 的坑）—— 这里是**只读**接口，
   * 但规格不变：**本机之外一律 403。**
   */
  function isLocalSameOrigin(req) {
    const host = String(req?.headers?.host ?? '');
    const origin = String(req?.headers?.origin ?? '');
    if (origin === '') return true;              // curl 之类的命令行调用没有 Origin
    try {
      const o = new URL(origin);
      const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
      if (!allowed.has(o.hostname)) return false;
      return o.host === host;                    // ⭐ **端口也要一致**
    } catch {
      return false;
    }
  }

  ctx.effect(() => ctx.inject(['webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/api/announce/seen',
    /** ⚠️ **`async` + `await` 缺一不可** —— 面板那边就因为这个漏了 `await`
     *  返回过一个合法的空 `{}`（见 `docs\06`）。 */
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'method', message: '这个路由只读（GET）' });
        return;
      }
      if (!isLocalSameOrigin(req)) {
        sendJson(res, 403, { ok: false, code: 'origin', message: '只允许本机同源的请求' });
        return;
      }
      try {
        const live = await liveSessionIds();
        const { seen, filtered, sessions } = await seenCounts(live);
        sendJson(res, 200, {
          ok: true,
          /**
           * ⚠️ **`filtered: false` 是有意义的信息，不是"没过滤"这么简单** ——
           * 它说的是"**平台没告诉我哪些会话还在**" ⇒ 面板**必须**把有记录当成"见过"，
           * 而**不能**把没记录当成"肯定没人见过"。
           */
          filtered,
          /** 参与统计的会话数（排查用：**它突然变成 0 就说明名单出问题了**）。 */
          sessions,
          /** `{ 指纹: 人数 }` —— **没出现过的指纹 = 0 人见过**。 */
          seen,
        });
      } catch (error) {
        log(`seen 接口失败：${error instanceof Error ? error.message : String(error)}`);
        sendJson(res, 500, { ok: false, code: 'failed', message: String(error?.message ?? error) });
      }
    },
  })));

  ctx.effect(() => ctx.inject(['tools'], (tctx) => tctx.tools.register({
    name: 'announce',
    description:
      // ⚠️ 措辞依据（2026-09-29  + 02 桌整理的便条）：
      //    · **正面表述**（"这个频道做什么"），不要写成"禁止 X、禁止 Y"的清单 —— 否定式清单容易被当建议绕过
      //    · **三类**是判据；别窄化成"只有变更"（**"能力上新"同样该发**，纠正过一次）
      //    · **只有用户能批准** —— 说清是"用户本人"，别让模型理解成"另一张桌也能批"
      //    · **不加技术拦截**（用户要的就是靠自觉）
      // 一律写"用户本人"而不是"用户"，避免模型把"批准"理解成某个角色。
      '往办公室公告文件末尾追加一条公告，让其它桌在开桌/后续步骤里自动看到。'
      + '这个频道只做一件事：通知全桌 AI 的"办公室级事实"。发之前先确认它属于这三类之一：'
      + '① 契约变化（路径/约定/规矩/接口变了，按旧信息办事会出错）；'
      + '② 能力上新（各桌新获得了一个可能性，比如能联网了、有了新工具）；'
      + '③ 跨桌裁决（办公室级规矩改了，或某个有争议的判断定了）。'
      + '自检："别的桌不知道这件事，会不会不知道更好用 / 更容易出错？" 都不会 → 不要发。'
      + '留在自己桌上的：工作过程与回执、桌内结论、给某个特定对象的回复或更正、还没定论的事、凭据或个人信息。'
      + '⚠️ 只有用户本人能批准 —— 调用本工具之前，必须先在对话里把草稿给用户本人看过并得到同意；'
      + '未经用户本人同意不要调用本工具。'
      + '形态：一句话 + 去哪看 —— 说清发生了什么、详见哪里，不要求别的桌必须改什么。'
      + '**别填 `publisher`** —— 发布者由插件按你的会话标题自动定（`NN-` 前缀 ⇒ `NN 桌`），不用你写。'
      + '各桌只往末尾加，不改、不删已有的行（只有用户本人能删改）。同一件事不要重复发。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '一句话说清发生了什么。陈述句，不写命令、不寒暄。',
        },
        source: {
          type: 'string',
          description: '权威位置（路径或文档名），供别人需要时去看。建议写，不要复制内容过来。',
        },
        ttlDays: {
          type: 'number',
          description: '有效期天数。默认 14；写 0 表示长期有效。过期的条目留在文件里但不再送达。',
        },
        publisher: {
          type: 'string',
          description:
            '⚠️ **已忽略，别填。** 发布者由插件按你的会话标题自动定（`NN-` 前缀 ⇒ `NN 桌`）——'
            + '因为"桌号 = 标题前缀"是这套东西的第一原则，**身份不能由调用方自报**'
            + '（否则投递插件认你是一张桌、公告却署名另一张）。'
            + '**要代表别的桌发话，就让那张桌自己发**，或者写进正文。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      const text = String(args?.text ?? '').replace(/\s+/gu, ' ').trim();
      if (text === '') throw new Error('公告内容不能为空');
      const source = String(args?.source ?? '').replace(/\s+/gu, ' ').trim();
      const rawTtl = args?.ttlDays;
      const ttl = rawTtl === undefined || rawTtl === null
        ? opts.defaultTtlDays
        : Math.max(0, Math.trunc(Number(rawTtl)));
      if (!Number.isFinite(ttl)) throw new Error('ttlDays 必须是数字');

      /**
       * ## ⭐⭐ **署名：三个判据，按可信度排**（2026-10-01 加的第一个）
       *
       * | 序 | 判据 | 什么时候用 |
       * |---|---|---|
       * | **1** | **调用方显式填了 `publisher`** | AI 读过办公室 README、自己知道是哪张桌 |
       * | **2** | ⭐ **会话标题的 `NN-` 前缀** | **和 cwd 无关** —— 每个会话自己带着（**这一条是今天加的**） |
       * | **3** | cwd → `publisherNames` 映射 | **只对"一个工作区只属于一张桌"有效** |
       * | 4 | 兜底 `fallbackPublisher`（"办公室"） | 三个都认不出来 |
       *
       * ### ⚠️ 为什么要加第 2 条
       *
       * 原来只有 1 / 3 / 4。而**第 3 条在这个办公室的主要用法下会失灵**：
       * 这个办公室可以容纳**工作区各不相同**的会话 —— 而**多张桌共用一个工作区**时，
       * cwd 分不出是谁 ⇒ **全落回"办公室"**。
       *
       * 投递插件**早就是从标题认桌的**（`deskFromTitle()`）——
       * **⇒ 两个插件对"我是谁"必须用同一个判据**，否则会出现
       * "投递认得出、公告认不出"这种自相矛盾。
       *
       * ⚠️ **标题读不到（或没有前缀）时不报错，安静回落后备判据** ——
       * 署名不准是小事，**发不出公告才是大事**。
       */
      const sessionId = exec?.agent?.session?.id;
      const titleDesk = deskFromTitle(await readSessionTitle(sessionId));
      const cwd = exec?.agent?.session?.header?.cwd;
      const byTitle = titleDesk === null ? '' : `${titleDesk} 桌`;
      const byCwd = publisherFor(cwd, opts);
      /**
       * ## ⚠️⚠️ 2026-10-03：**"显式填的 `publisher` 压过标题"这条去掉了**
       *
       * ### 原来写的是
       *
       * ```js
       * const declared = String(args?.publisher ?? '')…;
       * const publisher = declared === '' ? derived : declared;   // ⚠️ 显式填的盖过标题
       * ```
       *
       * ### 为什么去掉（**外部终审指出，而它点破的是本仓库的第一原则**）
       *
       * 本仓库的第一原则是 **"桌号 = 标题前缀"** ——
       * `docs/03` 专门有一节（零点七）在讲**"两个插件对『我是谁』必须给同一个答案"**。
       *
       * **⚠️ 而"显式填就压过它"正是在那个原则之外开的口子**：
       *
       * | 场景 | 投递插件认为它是 | 公告插件署成 |
       * |---|---|---|
       * | 标题 `01-游戏开发` 的会话，调 `announce({ publisher: '02 桌' })` | **01** | ⚠️ **02** |
       *
       * **⇒ 同一个会话，两个插件说它是不同的桌** ——
       * **而"不统一"正是当初统一判据要修掉的那个毛病。**
       *
       * ⭐ **判据**：**身份要么是"平台侧的事实"（标题），要么什么都不是** ——
       * 不能由调用方自报。**要代表别的桌发话，就让那张桌自己发**
       * （或者写进正文：*"我替 02 桌转达"* —— **那读起来反而更诚实**）。
       *
       * ⚠️ **而这条原来有断言钉着**（原话：*"显式填的 `publisher` 压过标题（AI 自己说的最准）"*）——
       * **那条断言写的时候没意识到它和零点七冲突**（今天一并反过来）。
       *
       * ⚠️ **工具参数 `publisher` 暂时留着**（描述里标了"已忽略"）——
       * 老提示里可能还带着它，**留着参数就不会让那些调用直接报错**。
       */
      const derived = byTitle !== '' ? byTitle : byCwd;
      const publisher = derived;
      const declared = String(args?.publisher ?? '').replace(/[\r\n｜]/gu, ' ').trim();
      if (declared !== '' && declared !== derived) {
        log('忽略调用方自报的 publisher（身份以标题为准）', { session: sessionId, declared, derived });
      }

      const ttlLabel = ttl === 0 ? '长期' : `${ttl} 天`;
      /**
       * ⚠️⚠️ **`｜` 必须转义掉，而且三个字段一个不能漏**（2026-10-01 修）。
       *
       * ## 失败现场（Claude 复查时实测）
       *
       * 用 `announce` 工具发一条**正文里带 `｜`** 的公告：
       *
       * | 谁 | 看到什么 |
       * |---|---|
       * | 面板 | 全文、长期（它按首尾取字段，所以"看起来正常"） |
       * | **各桌** | ⚠️ **只收到前半句**；"详见"变成了后半句；**有效期变成 14 天** |
       *
       * 因为这一行会变成 **6 段以上**，而 `ENTRY_RE` 要求**正好 5 段** ⇒
       * `([^｜]*)` 匹配不上 ⇒ **整条解析不了** ⇒ 那一段被当成别的字段。
       *
       * ## 根因：**同一件事有三份定义，而只有一份处理了它**
       *
       * | 谁 | 打一个 `｜` 会怎样 |
       * |---|---|
       * | **面板**（`formatAnnounceLine`） | 换成 `丨`（**保留可读性**） |
       * | **这个工具 · `publisher`** | 换成**空格**（信息丢了） |
       * | **这个工具 · `text` / `source`** | ⚠️ **原样写进去 ⇒ 拆坏行** |
       *
       * **⇒ 现在统一成 `丨`（U+4E28，一个汉字，长得几乎一样）** ——
       * 和面板一致，**既保住可读性，又不破坏结构**。
       *
       * ⚠️ 为什么不"直接报错让用户改"：那对一个**给人/给 AI 用的发布口**来说太重了，
       * **为了一个全角竖线让整条公告白写**。悄悄换掉、并在回执里说明（见下面）。
       */
      const esc = (s) => String(s).replace(/｜/gu, '丨');
      /** ⚠️ **换过就说** —— 悄悄改写用户输入也是"静默"的一种（哪怕方向是好的）。 */
      const escaped = [publisher, text, source].some((s) => String(s).includes('｜'));
      const entry = `- ${todayMmDd()}｜${esc(publisher)}｜${esc(text)}｜${esc(source)}｜${ttlLabel}`;

      ensureHeader(file);
      ensureTrailingNewline(file);
      // ⚠️ **这里故意走 Node 的 `fs`，不走 `ctx.fs`**（02 桌 2026-09-29 指出，别"顺手改回去"）：
      // 公告文件在 `00-通用\` 下，属于**工作区共享区**；而模型的**文件工具**在 `workspace-write`
      // 模式下只能写"本会话的 workspaceRoot"，**跨工作区会被拒**（01 桌就是另一个工作区）。
      // 插件从 Cordis 上下文直接调 Node `fs`，用宿主权限写，所以**跨工作区也能发公告** ——
      // 这是本工具相对"模型直接改文件"的一个**隐性优势**：改了这里，桌 01 就发不出公告了。
      appendFileSync(file, `${entry}\n`, 'utf8');

      const how = declared !== '' ? '会话声明'
        : (byTitle !== '' ? '**按会话标题推导**'
          : (byCwd === opts.fallbackPublisher ? '推导不出桌名，按默认' : '按工作区推导'));
      return `已发布到 ${file}\n${entry}\n发布者「${esc(publisher)}」（${how}）`
        + (escaped
          ? '\n⚠️ **正文/详见里的全角竖线 `｜` 被换成了 `丨`** —— '
            + '`｜` 是字段分隔符，留在里面会把这一行拆成更多段、**导致各桌读不出来**。'
            + '（长得几乎一样，意思不变。）'
          : '')
        + '；有效期结束后不再送达，条目仍留在文件里。';
    },
  })));

  // ── 送达 ────────────────────────────────────────────────────────────────

  async function deliver(agent, decision, step, messages) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return decision;

    /**
     * 静音时**直接跳过**，而且**绝不动游标** —— 这是"补发积压"能成立的全部秘密：
     * 游标停在静音前的位置 ⇒ 解除后那些"积压的"仍是"没见过" ⇒ 自然被补上。
     *
     * ⚠️ **语义被纠正过**（2026-09-29）：02 桌便条一度写成"解除时不补发"，
     * **而正确的语义是相反的** —— *"以 /mute 为基线**补发**积压的，不然信息差补不上。"*
     */
    if (isMuted(sessionId)) return decision;

    const opening = step === 1;
    // 开桌那一步要多读一些：visibleCount 用来如实报告"一共有几条"。
    const scanMax = opening ? Math.max(opts.maxPerInjection * 4, 40) : opts.maxPerInjection * 2;
    const { entries, visibleCount, malformed } = parseAnnouncements(file, scanMax, opts.defaultTtlDays);
    /**
     * ⚠️⚠️ **坏行要先于"没有新公告"检查**（2026-10-01）。
     *
     * 原来这里紧接着就是 `if (entries.length === 0) return decision;` ——
     * **⇒ 一个"只有坏行、没有好行"的公告文件，读起来跟"空文件"一模一样。**
     *
     * **⇒ 报坏行的提示必须自己也能"触发一次注入"** —— 否则它永远没机会说出口。
     * ⚠️ 所以下面那个提前 return 要**让坏行绕过它**。
     */
    const malformedHint = malformed.length === 0
      ? ''
      : `⚠️ 公告文件里有 ${malformed.length} 行**看着像公告却读不出来**（格式可能写坏了，` +
        `**这几行谁也收不到**）：\n` +
        malformed.slice(0, 3).map((l) => `  ${l}`).join('\n') +
        (malformed.length > 3 ? `\n  …还有 ${malformed.length - 3} 行` : '');
    if (entries.length === 0 && malformedHint === '') return decision;

    const seen = await loadSeen(sessionId);
    const fresh = entries.filter((entry) => !seen.has(entry.id));
    if (fresh.length === 0 && malformedHint === '') return decision;

    const ordered = newestFirst(fresh);
    // 只有**真的写不进去**才提示用户（域不可用不算 —— 游标走文件，同样持久）。
    const degraded = writeFailed;
    // 这次是不是"压缩后重发"（决定首行措辞，见 renderAnnouncement）。
    const resend = resentAfterCompaction.delete(sessionId);
    const message = renderAnnouncement(
      ordered, visibleCount, { ...opts, degraded, resend, malformedHint }, opening,
    );

    // 先记账、再注入：注入抛错时最多"下次不再重复"，不会每步都重试同一批。
    // ⚠️ 顺序是刻意的（2026-09-29 加诊断时复核过）：反过来的话，
    //    一次失败的注入会让游标永远落后 ⇒ 每步都重试同一条公告。
    for (const entry of fresh) seen.add(entry.id);
    await saveSeen(sessionId, seen);

    log(`向 ${sessionId.slice(0, 20)}… 注入 ${fresh.length} 条公告（${opening ? '开桌' : '增量'}，有效期可见 ${visibleCount} 条${malformed.length > 0 ? `，另有 ${malformed.length} 行读不出来` : ''}）`);
    return { ...decision, messages: [...messages, message] };
  }

  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    let decision;
    try {
      decision = await next();
    } catch (error) {
      // 下游自己炸了：不要替它兜底，原样抛回（我们只保证自己不炸）。
      throw error;
    }
    try {
      /**
       * ⚠️⚠️ **全局开关在这里生效**（2026-10-01 修的 —— 原来它只是个"装饰"）。
       *
       * `enabled` 这个键**一直在配置里、也一直写在挂载日志里**，
       * 但**送达入口从来没检查过它** ⇒
       * **`enabled: false` 之后公告照发** —— 一个"看起来关掉了、其实没关"的开关。
       *
       * **⚠️ 这正是 `docs\06 习惯二` 那类失败**：不报错、不生效、看起来在工作。
       *
       * ⇒ 放在**最前面**检查（在 `next()` 之后、任何读文件之前）：
       * **关掉就应该一点活都不干**，连公告文件都不去读。
       *
       * ⚠️ **它和 `/mute` 的区别有两处**（⚠️ 2026-10-03 改正：这里原来写的是「两个都是全局的」——
       * 那是 `/mute` 改成**每会话**之前的结论。现在是 `enabled` 全局、`/mute` **只管当前那个会话**）：
       * - `enabled: false` = 改配置 + 重启 ⇒ **"这个环境根本不要公告"**（解除时不补）
       * - `/mute` = 一个命令随时切 ⇒ **"我暂时不想被打扰，但别让我漏掉"**（解除时**补**积压的）
       * ⇒ **两条判断都留着，但理由不一样**（见上面 `enabled` 那段配置注释）。
       */
      if (opts.enabled === false) return decision;
      if (decision?.kind === 'reject') return decision;
      const messages = decision?.messages ?? [];
      const step = payload?.step;
      // 空消息批出现在"工具调用之后的步"（实测 step≥2 时 count=0）。
      // 那种步里模型已经拿到上下文了，别为它多花 token —— 下一步还会给机会。
      if (!(messages.length === 0 && step !== 1)) {
        return await deliver(payload?.agent, decision, step, messages);
      }
    } catch (error) {
      // fail-open：读文件/存游标/渲染 任何一步失败都不能影响会话。
      log(`送达失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
    return decision;
  }));

  // ── 压缩检测：上下文被折叠 ⇒ 重置游标 ⇒ 下一步重发当前有效公告 ──────────
  //
  // 为什么必须这样：游标代表"读者现在还记得什么"，不是"文件里发过什么"。
  // 压缩会把旧消息遮蔽（shadowed），**模型是真的忘了**，而游标还在说"它见过了"。
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.id;
    const agentCtx = agent?.ctx;
    if (typeof sessionId !== 'string' || sessionId === '' || agentCtx === undefined) return;
    try {
      agentCtx.effect(() => agentCtx.on('session/event', (_session, event) => {
        if (event?.type !== 'compaction/end') return;
        void clearSeen(sessionId).then(
          () => log(`检测到压缩（${sessionId}）：游标已重置，下一步重发当前有效公告`),
          () => {},
        );
      }));
    } catch (error) {
      log(`挂压缩检测失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  /**
   * ⚠️⚠️ **这条日志曾经害人**（2026-09-29 → 2026-09-30 两次排查）。
   *
   * 原来写的是 `storageDomain=${ctx.get('storageDomain') === undefined ? '缺失' : '可用'}` ——
   * 而 **`ctx.get` 在"插件刚挂载那一刻"根本不可靠**（那时服务还没挂到 ctx 上）。
   * ⇒ 日志打成 `storageDomain=缺失`，**被读成"这台机器没有这个服务"**，
   *   于是"照缺失去设计"，还写进了配置注释和说明文档（02 桌专门发便条指出这是误判）。
   *
   * **真相**（2026-09-30 实测，本桌自己挖到底）：
   *   · `ctx.get` 在这一刻**连 `sessionQuery` 都取不到** ⇒ 它是"**此刻的快照**"，不是"平台能力"
   *   · 正解是 **`ctx.inject([...])`** —— 让框架保证依赖就位之后再叫我
   *   · 顺带发现第二层：`inject` 回调收到的子 ctx 上，服务是**属性**而不是 `ctx.get` 能取的
   *
   * ⇒ 现在**如实说"此刻"**，并给一句怎么正确判断，**不让下一个人再读错**。
   * 详证据：`进度与待办.md` 二之八之七、`使用说明.md` 那条"曾经的错话"。
   */
  const availableNow = (() => {
    try { return ctx.get('storageDomain') !== undefined; } catch { return false; }
  })();
  const mountLine = availableNow
    ? `已挂载 v${PLUGIN_VERSION}：公告文件 ${file}，enabled=${opts.enabled}，storageDomain 此刻=可用`
    : `已挂载 v${PLUGIN_VERSION}：公告文件 ${file}，enabled=${opts.enabled}，`
      + 'storageDomain 此刻=取不到（**这只是挂载这一刻的快照，不代表平台没有这个服务** ——'
      + ' 要用 inject 声明依赖，见本行上方那段注释；域真打不开时游标会走同目录的 bulletin_announce_cursor.json）';
  log(mountLine, { version: PLUGIN_VERSION, storageDomainAtMount: availableNow });
  if (domainIssues.length > 0) log(`降级说明：${domainIssues.join(' / ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 写入侧的小工具：统一 UTF-8 无 BOM（见协议 §5）
// ─────────────────────────────────────────────────────────────────────────────

const HEADER = `# 办公室公告

> 本文件是整个办公室的「最近发生了什么」。
> **⚠️ 规矩按角色分**（2026-10-01 改的说法 —— 原来是笼统的"只增不改"）：
> **AI 只能往末尾追加**（不改已有的行，也不删过期的行）；
> **用户本人可以删改**，但要经过面板、要确认、要留记录（面板的「删除」会往 \`公告-删除记录.md\` 追一行）。
> 写法：\`- MM-DD｜发布者｜一句话｜详见哪里｜有效期 N 天\`
> 最后一栏**只有两种含义**：**写天数**（如 \`30 天\`）或 **\`长期\`**。省略不写 = 默认 **14 天**。
> **\`长期\` 等价写法**（都认，但**建议就用 \`长期\`**）：\`0\`、\`0 天\`、\`不说\`、\`永久\`。
> **\`N 天\` 也接受写成 \`N\` 或 \`有效期 N 天\`** —— 三种写法读起来一样；工具写出来的是 \`N 天\`。
> ⚠️ **规范只此一处**：以前头部教 \`0\`、工具写 \`0 天\`、解析器只认 \`0\`，三种说法互相打架（2026-09-29 修）。
> **过期的条目留在文件里，只是不再送达** —— 所以不需要为了清理来改这个文件。
>
> **⚠️ 本文件必须是 UTF-8 无 BOM。** 用 PowerShell 的 \`Set-Content -Encoding UTF8\` 会写入 BOM，
> 会让写入方和读取方来回翻转编码。请用文件工具或 Node 写。
>
> **谁可以写**：任何一张桌、Codex、以及用户本人。
> DSH 各桌用 \`announce\` 工具发布（发布者会自动填写）；Codex 和用户**直接往末尾追加一行**就行。
> ⚠️ **正文里别打全角竖线 \`｜\`** —— 它是字段分隔符，留在里面会把这一行拆成更多段，
> **导致各桌读不出来**（工具会自动把它换成 \`丨\`，并告诉你换了）。
>
> **公告是告知，不是命令**：说清发生了什么、详见哪里，不要求别的桌必须改什么。
> 「详见哪里」请指向**权威位置**，不要把内容复制过来（同一件事只留一个权威存放处）。

`;

/** 文件不存在时**不自动创建**（避免把错路径变成一个空文件）；只在根目录下会自建。 */
function ensureHeader(file) {
  if (existsSync(file)) return;
  writeFileSync(file, HEADER, 'utf8');
}

/** 保证追加点在一行开头：文件末尾没有换行时先补一个。 */
function ensureTrailingNewline(file) {
  const size = statSync(file).size;
  if (size === 0) return;
  const buf = Buffer.allocUnsafe(1);
  const no = openSync(file, 'r');
  try {
    readSync(no, buf, 0, 1, size - 1);
  } finally {
    closeSync(no);
  }
  if (buf[0] !== 0x0a) appendFileSync(file, '\n', 'utf8');
}

// 保持解析与文案函数可被自测引用（自测会剥掉两个外部导入后直接加载本文件）。
// 另外导出域名与域 spec：自测要断言它们满足平台的正则 —— 见 DOMAIN 的注释。
export { parseAnnouncements, publisherFor };
export const __test = {
  readAnnouncementLines,
  renderAnnouncement,
  HEADER,
  domainName: DOMAIN,
  domainSpec: announceDomainSpec,
  cursorTable: CURSOR_TABLE,
  // 供"装机后核验"断言版本读到的是真的（今天两次栽在"装新版跑旧版"上）
  pluginVersion: PLUGIN_VERSION,
};
