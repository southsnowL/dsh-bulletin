/**
 * 功能 2：**按桌投递**（2026-09-30 的语义）。
 *
 * ## 单子是什么（用户选的"指针型"）
 *
 * **一句话 + 指向哪里** —— 内容本体留在文档里，单子只负责"告诉你有这么件事、去哪看"。
 *
 * ## 谁发（用户选的"AI 用工具发"）
 *
 * `dispatch_ticket` 工具（见 `f2b-dispatch-tools.js`）。**不做监视文件夹那套。**
 *
 * ## 谁收（用户选"送到一次" + "谁先来谁取走"）
 *
 * ⚠️ **单子挂在「桌」这一层，不是挂在会话上**：
 *   · 同一个桌的**任何一个会话**，谁先跑到就谁取走
 *   · 取走之后**同桌别的会话看不到** ⇒ **不会重复干活**
 *   · 压缩不改变会话号 ⇒ 不会重复送；**新会话也能取还没被取走的**
 *   · `NN-` 前缀就是继承机制 ⇒ **不需要额外的血缘追踪**（开工包 §三.2.3）
 *
 * ## ⚠️ 两个必须盯住的时序点（用户专门提醒过"隐形耦合 bug"）
 *
 * **① 判定与取走之间不许有 `await`**
 *   平台可以**并行跑不同会话**。如果"读 → 判断没人取 → （等）→ 标记取走"，
 *   两个会话会**都读到、都注入** ⇒ **同一件事干两遍**。
 *
 *   ⚠️ **而域的 `put` 是异步的**（"awaits backend durability FIRST, then mutates memory"
 *   —— 见 `dsh-storage-domain` 的 domain 运行时光释）：`put()` 之后**立刻读可能读不到新值**。
 *   ⇒ 所以**取走的判定必须用进程内的东西**（本文件的 `TAKEN`），
 *   域的写只是**尽力而为的持久化**（供重启后不重投）。
 *
 * **② 系统提示的渲染是同步的，而读存储是异步的**
 *   ⇒ **不能在渲染时才去查存储**。必须"pre-step 里查好 → 放进视图 → 渲染时同步取"。
 *   （这条在"提议改名"那里刚踩过一次：注入说桌 02、提示还说认不出。）
 *
 * ## ⚠️ 为什么本功能**自己解析桌**、不依赖"认桌"功能
 *
 * 有一条要求是"**这个功能得在认桌之后才能触发**"。但**依赖 ≠ 耦合**：
 * 直接读认桌功能的缓存的话，**第一轮**（认桌结果还没出来）**投递就送不出去**。
 * ⇒ 本功能**自己做一次同一套判定**（共用 `identity.js`），**两个功能各自独立可用**。
 */
import {
  OFFICE_DESK, deskFromTitle, deskLabel, getSessionsRevision, isSubagentSession, lookupDesk,
  readSessionTitle, rememberDesk,
} from '../identity.js';
import { errText } from '../log.js';
import { CLAIMS_KEEP, listRecords, putTracked } from '../store.js';

/** 本功能的配置键（与 `index.js` 的开关同名）。 */
export const FEATURE = 'dispatch';

/** `systemPrompt.section()` 的排序位。 */
const SECTION_ORDER = 420;

/**
 * ⭐ **进程内的"谁取走了"**（`ticketId -> { sessionId, at }`）。
 *
 * **这才是"谁先来谁取走"真正生效的地方**（见文件头时序点 ①）。
 * 域的 `tickets` 表是**持久副本**（供重启后不重投），不是判定依据。
 */
const TAKEN = new Map();

/** 某个单子在这一刻是不是已经被取走了（**同步**，跨会话立即可见）。 */
export function isTaken(ticketId) {
  return TAKEN.has(ticketId);
}

/**
 * ⚠️ **仅供自测**：清掉进程内状态。
 *
 * 为什么需要：`TAKEN` / `PENDING` 是**模块级**的（"谁先来谁取走"必须跨会话可见），
 * 而自测在**同一个进程**里跑多个场景 ⇒ 前一个场景取走的单子会让后一个场景
 * 看到"已被取走"（实测踩到过：7 条断言因此误报）。
 */
export function resetForTest() {
  TAKEN.clear();
  PENDING.clear();
}

/** 标记取走（**同步**，调用返回时对所有会话可见）。 */
export function markTaken(ticketId, sessionId) {
  if (isTaken(ticketId)) return false;
  TAKEN.set(ticketId, { sessionId, at: Date.now() });
  return true;
}

/**
 * 取走历史**必须有界**：只留最近 `CLAIMS_KEEP` 条，多的删掉。
 *
 * ⚠️ 这张表**天然只增不减**（每取一次多一行）⇒ 不修剪的话它会一直长。
 * 删失败**不影响任何事**（只是文件大一点），所以只记日志、不抛。
 */
async function pruneClaims(claims) {
  try {
    const all = listRecords(claims).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0));
    for (const [key] of all.slice(CLAIMS_KEEP)) await claims.delete(key);
  } catch { /* 修剪失败无所谓 */ }
}

/**
 * ⭐ **进程内的待投递视图**：`sessionId -> { text, desk, at }`。
 *
 * 为什么必须有它（而不是渲染时去查存储）：
 *   **系统提示的 `text()` 回调是同步的**，而读存储是异步的 ⇒ 渲染时查不了。
 */
const PENDING = new Map();

/** 读某个会话当前该看到的单子文本（**同步**）。 */
export function pendingTextFor(sessionId) {
  return PENDING.get(sessionId)?.text ?? '';
}

/**
 * 装配按桌投递。
 *
 * @param {object} api 共享运行环境
 * @returns {() => void} 卸载函数
 */
export function setup(api) {
  const { ctx, config, log, warn, store } = api;
  const tickets = store.tables.tickets;
  const claims = store.tables.claims;
  const sessions = store.tables.sessions;
  /** 上次检查是哪个 turn（一个 turn 只查一次）。 */
  const lastTurn = new Map();

  /**
   * 上次"告诉仪表盘"时，单子的计数（`待取/已取`）。
   *
   * ⚠️ 为什么要有这个（2026-09-30 实测）：`onStateChanged` 是**单向通知**，
   * 如果当时服务的实例没接上那个口子（热重载期间很容易发生），
   * **仪表盘就停在旧内容上，而且没人会发现**（实测：存储里已经有 3 张单子，
   * `.md` 上还写着"待取 0"）。
   * ⇒ pre-step 本来每轮就跑，**顺手纠偏**：计数和上次不一样就补写一次。
   */
  let rendered = null;

  /** 现在的计数。 */
  function snapshotCounts() {
    const rows = listRecords(tickets);
    const pending = rows.filter(([, r]) => r?.takenBy === null || r?.takenBy === undefined).length;
    /**
     * ⚠️ **会话表也要算进来**（2026-09-30，01 桌报的"状态表漏掉刚认桌的会话"）。
     *
     * 原来只比"单子计数" ⇒ **认桌落库不会触发补写**，仪表盘的"认过桌的会话"一直漏着新会话。
     *
     * ## ⚠️⚠️ 而 `getSessionsRevision()` 还不够（2026-10-01，桌 03 报的"改名不刷新"）
     *
     * 那个计数器是**单调递增的内存变量**，只在 `rememberDesk()` 时 +1。它有两个洞：
     *
     * | 洞 | 后果 |
     * |---|---|
     * | **进程重启归零** | 重启后如果单子计数没变，`rendered` 是 `null` ⇒ 会写一次（侥幸躲过）<br>**但只要写过一次，之后再改名就不够敏感了** |
     * | **它记的是"我调过 rememberDesk"**，不是"表里变了" | ⚠️ **别人往 `sessions` 表里写了东西，它不知道** |
     *
     * **⇒ 判据换成"表内容本身"**：把每条记录的 `desk|title` 拼起来当签名。
     * **它认的是"表里现在是什么"，而不是"我记不记得我改过"。**
     *
     * ⚠️ 代价：每轮拼一次字符串（会话数是个位数）—— **可以忽略**，
     * 而它换来的是**"状态表里写的就是库里现在的样子"**。
     *
     * ⚠️ **先按 id 排序再拼**：`listRecords` 的顺序取决于存储实现（域 / 文件可能不同），
     * **不排序的话，顺序一变就误判成"变了"** ⇒ 状态表会被无谓地反复重写
     * （而"生成时间"是个信号，见文件顶部那段）。
     */
    const sessionsSig = listRecords(sessions)
      .map(([id, r]) => `${id}=${r?.desk ?? ''}|${r?.title ?? ''}`)
      .sort()
      .join('\n');
    return {
      pending, total: rows.length, sessions: getSessionsRevision(), sessionsSig,
    };
  }

  /** 和上次比，变了就请仪表盘补写一次。 */
  function reconcileStatus() {
    const now = snapshotCounts();
    const same = rendered !== null
      && rendered.pending === now.pending
      && rendered.total === now.total
      && rendered.sessions === now.sessions
      /** ⭐ **表内容签名也要比**（见 `snapshotCounts` 那段：计数器认不出"别人改的表"）。 */
      && rendered.sessionsSig === now.sessionsSig;
    if (same) return;
    const first = rendered === null;
    rendered = now;
    api.onStateChanged?.(first ? '纠偏（首次）' : '纠偏');
  }

  /**
   * 列一张桌**还没被取走**的单子。
   *
   * ⚠️ **必须用 `listRecords`（存储无关），不能直接 `tickets.entries()`** ——
   * 兜底文件表没有 `entries`，直接调会抛（实测：`list_tickets` 当场失败，投递整个不可用）。
   */
  function openTicketsFor(desk) {
    const out = [];
    try {
      for (const [id, rec] of listRecords(tickets)) {
        if (rec?.desk !== desk) continue;
        // ① 进程内的取走记录优先（它是最新的，域的写是异步的）
        if (TAKEN.has(id)) continue;
        // ② 域的持久记录（重启前别人取走的，本进程没有内存记录）
        if (rec?.takenBy !== null && rec?.takenBy !== undefined) continue;
        out.push({ ...rec, id });
      }
    } catch (error) {
      warn('列单子失败（已忽略）', { error: errText(error) });
    }
    return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  /** 把单子格式化成给模型看的一小段。 */
  function formatTickets(desk, list) {
    /**
     * ## ⚠️ **时间用本地时间，不用 UTC**（2026-10-03 修）
     *
     * ### 原来写的是
     *
     * ```js
     * const when = new Date(t.at ?? Date.now()).toISOString().slice(5, 16).replace('T', ' ');
     * ```
     *
     * ⚠️ **`toISOString()` 永远是 UTC** —— 而**同一份单子在状态表里显示的是本地时间**
     * （`stamp()` 用的是本机时区）⇒ **同一个时刻，两个地方差 7 小时**（太平洋时区），
     * **而且半夜前后会差一天。**
     *
     * **⇒ 症状**：AI 看到"这张单子是 10-03 05:20 投的"，而**用户在面板上看到的是 10-02 22:20**，
     * **两边对不上，还会怀疑"是不是有两张单子"。**
     *
     * ⭐ **判据**：**同一件事的时间，在哪儿显示都该是同一个时刻的同一个写法** ——
     * 用本地时间（和状态表、和用户看的一致），**别用 UTC**。
     * （我们在"删除记录"上修过同一类问题，那次也是 UTC 和本地混着。）
     */
    const p2 = (n) => String(n).padStart(2, '0');
    const lines = list.map((t) => {
      const d = new Date(t.at ?? Date.now());
      const when = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      // ⚠️ 用 `deskLabel`（它自己会产出"桌 04"），**不要**再拼一个"桌"字 ——
      //    实测撞过：写成 `来自 **${label} 桌**` 会渲染成"来自 **桌 04 桌**"。
      return `· 来自 **${deskLabel(t.source ?? '办公室')}**（${when}）：**${t.summary}** —— 详见 \`${t.ptr}\``;
    });
    return `跨桌投递：**本桌有 ${list.length} 张待取的单子**（${deskLabel(desk)}）\n`
      + `${lines.join('\n')}\n`
      + '取走后**本桌其它会话不会再看到它**。**要用就用，不用就放过** —— **不需要回执**，也不用专门回应用户。';
  }

  // ── pre-step：解析桌 → 找单 → **同步取走** → 放进视图 ────────────────────────
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      const agent = payload?.agent;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId === '') return decision;

      /**
       * ⭐⭐ **子代理不是"桌"** —— 在这里也要排掉（2026-10-01 修的 bug）。
       *
       * ## 原来错在哪
       *
       * 这个判定**只写在认桌那个功能里**（`f0-identity.js`），
       * 而**这条入口是独立的**（见文件头那段"依赖 ≠ 耦合"）——
       * 它自己读会话、自己写 `sessions` 表，**却没有这个检查。**
       *
       * ⇒ **子代理绕过了排除，被重新写进会话表**，
       * 在状态表的"认过桌的会话"里变成一条"办公室"记录。
       * **⇒ 于是"子代理不会出现在办公室状态表"这句话，当时是不成立的。**
       *
       * ## 修法
       *
       * 判定提到 `src/identity.js` 的 `isSubagentSession`，
       * **所有入口 import 同一个** —— 而不是"在每处再抄一遍那个 if"。
       * （**抄一遍就是副本**；副本必然会有一处先过时。）
       */
      if (isSubagentSession(agent?.session)) return decision;

      const turn = typeof payload?.turn === 'number' ? payload.turn : undefined;
      if (turn !== undefined && lastTurn.get(sessionId) === turn) return decision;

      /**
       * ⚠️⚠️ **`reconcileStatus()` 从这儿挪到了"落库之后"**（2026-10-01）
       *
       * ## 为什么挪
       *
       * 它原来紧跟在"这个 turn 还没查过"的判断后面 —— 也就是**在刷新会话标题之前**。
       * **⇒ 它比的是"上一轮"的表内容** ⇒ **永远差一轮。**
       *
       * **⚠️ 而"差一轮"在真实使用里就等于"永远不变"**：
       * 用户改完会话标题之后，**常常就没有下一轮了**（他会去看面板，而不是再发一条消息）。
       * **⇒ 实测就是这样**：库改了、状态表没重写、而**界面上说"还是没变"**。
       *
       * ⇒ 现在它跑在**本轮的会话表写完之后**（见下面 `reconcileStatus()` 那一行）——
       * **同一轮里就发现"表变了"，同一轮就请仪表盘重写。**
       */

      /**
       * ── ① 自己解析桌（**不依赖认桌功能** —— 见文件头那段"依赖 ≠ 耦合"）────────
       *
       * ## ⚠️⚠️ 2026-10-01 改：**桌号认出来之后，标题仍然每轮刷一次**
       *
       * ### 原来错在哪（**别的桌观察到的**）
       *
       * 桌 03 指出：状态表「认过桌的会话」里，**他那张桌显示的还是旧标题**
       * （`03-本机电脑维护`），用户后来把会话改名成 `03-本地电脑维护`，
       * **而表里一直是旧的。**
       *
       * **根因**：原来 `if (desk === undefined)` 把**读标题**和**认桌号**绑在一起了 ——
       * **一旦桌号认出来，就再也不读标题**：
       *
       * ```js
       * const rec = { desk, title, at: Date.now(), … };   // ← 标题冻在这一刻
       * ```
       *
       * **⇒ 桌号永远是对的**（那是会话自己的编号，很少变），
       * **而显示的名字冻在"第一次认桌"那一刻。**
       * **单子收发完全不受影响**（按桌号走）—— 所以它只是一个**显示**问题，
       * **而"显示的问题"在这个文件里同样是问题**：状态表是给人看的。
       *
       * ### 现在
       *
       * **两个判据分开**：
       *
       * | 什么 | 什么时候定 |
       * |---|---|
       * | **桌号**（`desk`） | ⭐ **以标题为准**（标题读不到才退回上一次的）—— 「**编号就是地址**」，见下面那段更正 |
       * | **标题**（`title`） | ⭐ **每轮刷新**（它是显示用的名字，又是桌号的来源） |
       *
       * ⚠️ **代价**：每轮多一次 `readTitle()`（读会话日志）。**而它换来的是"表里写的是真名字"。**
       * ⚠️ **读不到就什么都不做**（保留上一次的标题和桌号）—— **不能因为一次读失败把已知的东西抹掉。**
       */
      const known = lookupDesk(sessionId) ?? sessions.get(sessionId);
      const knownDesk = typeof known?.desk === 'string' ? known.desk : undefined;
      const knownTitle = typeof known?.title === 'string' ? known.title : '';
      /** ⭐ **每轮都读**（不只是"还不知道桌号"时读）。 */
      const freshTitle = await readSessionTitle(agent?.ctx, sessionId);
      /** 第一次认桌时，读不到标题就**先不投**（下一轮再说）—— 老规矩不变。 */
      if (knownDesk === undefined && freshTitle === null) return decision;

      /**
       * ⭐⭐ **顺手纠偏仪表盘**（每轮最多一次；**表内容真变了**才请它重写）。
       *
       * ## ⚠️⚠️ 它的位置试过三个，前两个都是错的（2026-10-01，值得记）
       *
       * | 放哪 | 为什么错 |
       * |---|---|
       * | **① 最前面**（原来的位置） | **永远差一轮** —— 它比的是"上一轮"的表内容。<br>⚠️ 而"差一轮"在真实使用里常常等于"**永远不变**"（用户改完标题就去看面板，不会有下一轮） |
       * | **② 写库之后**（我修的第一版） | ⚠️⚠️ **永远相等** —— 它比的是"**我刚写进去的那张表**"。<br>**我一边要检测变更、一边先把变更做掉了** ⇒ 它每次都判定"没变"（实测：喊话数一直是 1） |
       * | **③ 认桌之后、写库之前**（现在） | ✅ 它读到的表**还是旧的那张** ⇒ 一比就发现"这个会话的标题变了" ⇒ **同一轮里就请仪表盘重写** |
       *
       * **⭐ 教训**：**"检测变更"必须发生在"做出变更"之前。**
       * 我把它挪到后面，是想让它"看到最新的"—— **结果它看到的是自己刚做的事。**
       *
       * ⚠️ 而它**不能拿"我刚算出来的结果"当依据**（那是另一种自指）——
       * 它必须**重新读库**，因为**别的写入者（认桌功能、别的会话）也在动同一张表。**
       */
      reconcileStatus();

      /**
       * ## ⚠️⚠️ 2026-10-02：**桌号不再"优先用旧的"**
       *
       * ### 原来错在哪
       *
       * 这里原来写的是 `knownDesk ?? deskFromTitle(freshTitle)` ——
       * **"认出来的桌号优先，标题只用来刷新显示名"**。
       * **⇒ 后果是"两条路不一样"**（一份外部审查顺着源码走出来的）：
       *
       * | 你怎么改标题 | 桌号会变吗 |
       * |---|---|
       * | **手动**把 `02-x` 改成 `03-y` | ❌ 不变（这里优先用 `knownDesk`） |
       * | **用插件的改名工具**改 | ✅ 变（那条路会重新认桌） |
       *
       * ⚠️ **而文档里一直写着"桌号就是标题前缀"** ⇒ **改标题本来就是一次换桌声明。**
       *
       * ### 现在
       *
       * **标题读得到 ⇒ 以标题为准；读不到 ⇒ 才退回已知的桌号**
       * （⚠️ **不能因为一次读失败就把身份丢了**）。
       *
       * ⚠️ **这里不再自己"定住"桌号** —— 那是 `f0-identity`（认桌功能）的职责，
       * 它现在每个新 turn 也重读标题、认账换桌。
       * **⇒ 两边看同一份事实，不会再出现"显示名变了、桌号没变"。**
       */
      const desk = freshTitle !== null ? deskFromTitle(freshTitle) : knownDesk;
      const title = freshTitle ?? knownTitle;
      /**
       * ## ⭐⭐ **没认出桌号的会话，不记进"认过桌的会话"**（2026-10-01 定）
       *
       * ### 起因
       *
       * > *"我开了个新对话，它认桌自动认到办公室了，**我觉得这个认桌应该要硬性要求
       * > 只有编号认桌之后才能进**。"*
       *
       * ### 为什么那是对的
       *
       * 他定的定位是"服务**一台电脑上所有会话**"⇒ **必然会有很多没 `NN-` 前缀的随手会话**。
       * 而**"认桌"就是那道门**：**没认出来 = 还没进来。**
       *
       * ⚠️ 原来会把这些会话**记进 `sessions` 表、桌号写"办公室"** ⇒
       * **它们在状态表的「认过桌的会话」里看起来像成员**（实拍：`办公室 · 你好`）——
       * **而它们其实取不到任何单子**（投递那道闸会拦住"办公室"）。
       * **⇒ 一个"看起来是成员、其实什么也做不了"的身份，比没有身份更坏。**
       *
       * ### 边界（**别把有道理的排除掉**）
       *
       * | 情况 | 记不记 |
       * |---|---|
       * | 标题是 `03-本地电脑维护` | ✅ 记（`desk = '03'`） |
       * | 标题**没有 `NN-` 前缀** | ⛔ **不记** —— 它还不是办公室成员 |
       * | 标题**读不到**（第一次） | ⛔ 不记，**而且不写 `rememberDesk`** ⇒ 下一轮标题读到了还能补认 |
       *
       * ⚠️ **公告那一侧一个字没改** —— 用户选的是"**只收紧投递**"：
       * **公告仍然广播给所有会话**（那是"入口"，新会话靠它才知道有这间办公室、
       * 才知道该把标题改成 `NN-名字`）。**入口不该关。**
       */
      const isMember = desk !== OFFICE_DESK && /^\d{2}$/u.test(String(desk));
      if (isMember && (desk !== knownDesk || title !== knownTitle)) {
        const rec = { desk, title, at: Date.now(), turn: turn ?? 0 };
        rememberDesk(sessionId, rec);
        try { sessions.put(sessionId, rec); } catch { /* 尽力而为 */ }
      }
      if (turn !== undefined) lastTurn.set(sessionId, turn);

      /**
       * 没认出桌 ⇒ 不投（**不知道这张会话是谁的，就不能把单子交给它**）。
       * 认桌那边会在同一轮或下一轮认出来，那时再投。
       *
       * ⚠️ **2026-10-01 起，这里从"主要防线"变成了"第二道闸"**：
       * 写入端（`dispatch_ticket`）现在**直接拒绝把"办公室"当目标**
       * （理由见那边的注释：广播本来就是公告，而且没有人会来取这种单子）。
       *
       * ⇒ 所以走到这里的情况只剩一种：**历史遗留的单子**（那个 bug 修好之前发出去的）。
       * **留着这道闸，是为了让那些老单子不至于被某个恰好叫"办公室"的会话取走。**
       */
      if (desk === '办公室') {
        PENDING.delete(sessionId);
        return decision;
      }

      const open = openTicketsFor(desk);
      if (open.length === 0) {
        PENDING.delete(sessionId);
        return decision;
      }

      // ── ③ ⭐ **同步取走**（判定与标记之间**一个 await 都没有**）────────────────
      const takenAt = Date.now();
      const claimed = [];
      for (const t of open) {
        if (!markTaken(t.id, sessionId)) continue;   // 别人抢先了 ⇒ 跳过
        claimed.push(t);
      }
      if (claimed.length === 0) {
        PENDING.delete(sessionId);
        return decision;
      }

      // 持久化**在取走之后**做（尽力而为；写失败也不改变"已经取走"这个事实）。
      for (const t of claimed) {
        const rec = { ...t, takenBy: sessionId, takenAt };
        delete rec.id;
        try {
          // ⚠️ **必须 `await`**（2026-09-30 实测）：域的 `put` 返回 Promise，
          //    而**同步 `try/catch` 接不住它的拒绝** ⇒ 写失败被静默吞掉
          //    （我原来就是这样：丢了单子还查不出原因）。
          await putTracked(tickets, t.id, rec);
        } catch (error) {
          warn('单子取走写不进存储（重启后可能重投）', {
            id: t.id, error: errText(error), code: error?.code ?? null,
          });
        }
        /**
         * ⭐ **另记一条取走历史**（2026-09-30，用户要"最近的取走记录"）。
         *
         * 为什么不在 `tickets` 表里就地记：那张表只反映"**当前**被谁取走"，
         * 而单子以后可能被删/被重投 —— **那时"曾经谁取过"就查不到了**。
         * key 用 `时间戳|单号` ⇒ 天然按时间排序，也能容纳同一单被取多次。
         *
         * ⚠️ **分隔符不要用 `\u0000`**（2026-09-30 实测踩到）：`\u0000` 在 JS 里
         * **就是一个真的 NUL 字符**，它会一路流进健康段、**落进状态表 `.md`**
         * ⇒ **整份表被判成二进制、读不出来**。（`|` 在这两种 id 里都不会出现，够安全。）
         */
        try {
          await putTracked(claims, `${takenAt}|${t.id}`, {
            ticketId: t.id, desk, by: sessionId,
            /**
             * ⭐ **`source`（谁投的）也记下来**（2026-09-30 加）。
             *
             * 为什么：状态表里那张"最近的取走记录"原来**看不出单子是谁发起的** ⇒
             * 用户把"目标桌"读成了"谁投的"（**一个真实的误读**，见 `docs/07`）。
             *
             * ⚠️ 而单子**以后可能被删** ⇒ 那时再想查"谁投的"就查不到了
             * ⇒ **趁取走的这一刻记下来**（历史表的价值就在这里）。
             *
             * ⚠️ 老记录里没有这个字段 —— 渲染时会**去 `tickets` 表兜底查**（见 `f3-status.js`）。
             */
            source: t.source,
            summary: String(t.summary ?? '').slice(0, 120), at: takenAt,
          });
        } catch (error) {
          warn('取走历史写不进存储（不影响本次取走）', { id: t.id, error: errText(error) });
        }
      }

      // 取走历史**必须有界**（它天然只增不减）。
      await pruneClaims(claims);

      PENDING.set(sessionId, { text: formatTickets(desk, claimed), desk, at: takenAt });
      log('投递/已取走', {
        session: sessionId.slice(0, 20), desk: deskLabel(desk),
        count: claimed.length, ids: claimed.map((t) => t.id),
      });
      // ⭐ 状态变了 ⇒ 让人看的仪表盘跟上（同一 tick 里多次变化只写一次）。
      api.onStateChanged?.('取走');
      rendered = snapshotCounts();
      return decision;
    } catch (error) {
      // fail-open：投递任何一步失败都绝不能影响会话。
      warn('投递失败（已忽略）', { error: errText(error) });
      return decision;
    }
  }));

  // ── 系统提示段落：**同步**把视图里的文本取出来 ─────────────────────────────
  ctx.effect(() => ctx.inject(['systemPrompt'], (pctx) => pctx.systemPrompt.section({
    name: 'bulletin-dispatch:tickets',
    order: SECTION_ORDER,
    text: (context) => {
      try {
        const sessionId = context?.agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId === '') return '';
        return pendingTextFor(sessionId);
      } catch (error) {
        warn('投递提示渲染失败（已忽略）', { error: errText(error) });
        return '';
      }
    },
  })));

  return () => { /* 监听器/段落由 ctx.effect 的 disposer 管 */ };
}
