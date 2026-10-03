/**
 * 桌身份：**会话标题开头的两位数字**。
 *
 * ⚠️ 为什么是标题、不是别的（2026-09-30 四轮实测，三条原假设被推翻）：
 *   · **血缘 `parent` 继承 —— 不行**：压缩不重建会话、手动开新会话 `ancestors` 为空、
 *     **会话头根本没有 `parent` 字段**（只有 `parentSession`，且新会话没有）。
 *   · **`agent.session.header.title` 永远是 `null`** —— 标题不在 header 里，
 *     **必须调 `ctx.sessionQuery.readTitle()`**（官方叫"基于日志的标题"）。
 *   · ⭐ **`ctx.sessionQuery` 在插件根作用域取不到，只能在 `agent.ctx` 上拿。**
 *
 * ⭐ 而用户的命名方式让这件事变成一行正则（2026-09-30 明确）：
 *   「NN-」前缀**永远固定**，只有后面会变 —— 换会话继承同一张桌时他会命名成
 *   `02-环境维护1`、`02-环境维护2`… **不会改前面的编号**。
 *   ⇒ **所以只解析开头两位数字就够，不要去匹配整个标题。**
 */

/**
 * ⭐ **会话表改动计数**（进程内、单调递增）。
 *
 * ## 为什么需要它（2026-09-30，01 桌报的一个真 bug）
 *
 * 状态表（仪表盘）的"认过桌的会话"漏掉了**刚认桌的那个会话**。01 桌给的证据：
 *
 * ```
 * ms=2619769  状态表/已更新  reason=纠偏      ← 先写仪表盘（此时 sessions 还是 4 条）
 * ms=2619778  认桌/检查      session=b1fc6053 cached=01   ← 9 毫秒后才认桌落库
 * ```
 *
 * **根因**：两个 `agent/pre-step` 处理器**在同一个 turn 里并行跑**，而
 * **纠偏的判据只看「单子计数」，完全不看会话表** ⇒ 认桌落库之后**没人再纠偏一次**。
 *
 * ⇒ 修法：**认桌每写一次会话表就 +1**，纠偏把它一起比。
 * （为什么用计数器而不是"会话条数"：**改一条已存在的记录时条数不变** ——
 *   比如上面那个"补 `sessionId`"的修复就会改记录而不加条数。）
 */
let sessionsRevision = 0;

/** 会话表被改动了几次（**单调递增**，只用来比"变没变"）。 */
export function getSessionsRevision() {
  return sessionsRevision;
}

/** ⚠️ **仅供自测**：归零。 */
export function resetSessionsRevisionForTest() {
  sessionsRevision = 0;
}

/**
 * 桌号正则。
 *
 * ⚠️ **不要图省事改松**（两种改松都实测会误判）：
 *   · `/^(\d{1,2})\D/` → 会把 `2-环境维护1`（一位数字）也认了
 *   · `/^(\d{2})/`     → 不要求分隔符 ⇒ ⚠️ **`2026-09-30 的事` 会被误判成「桌 20」**
 *
 * 容忍：前导空格、数字后的空格、半角 `-`、全角 `－`、连接号 `—`、短横 `–`。
 */
const DESK_RE = /^\s*(\d{2})\s*[-－—–]\s*/u;

/** 拿不准时回落的身份 —— **诚实地说"不知道是哪张桌"，不假装知道**。 */
export const OFFICE_DESK = '办公室';

/**
 * ⭐⭐ **这个会话是不是"子代理"**（`parentSession` 有值就是）。
 *
 * ## 为什么它必须是一个**共享**判定（2026-10-01 修的一个真 bug）
 *
 * 原来这段判定**只写在 `f0-identity.js` 里**（认桌那个功能）。
 * 而 `f2-dispatch.js` 有**自己的一条入口**，它也读会话、也写 `sessions` 表 ——
 * **却没有这个检查。**
 *
 * ⇒ 后果：**子代理绕过了排除，被投递功能重新写进了会话表**，
 * 在状态表的"认过桌的会话"里变成一条"办公室"记录。
 * **⇒ 于是"子代理不会出现在办公室状态表"这句话，当时是不成立的。**
 *
 * **⇒ 修法就是"让所有入口用同一个判定"** —— 所以它住在这儿（两边都 import 得到）。
 *
 * ## ⚠️ 判据用**平台自己标的血缘**（`parentSession`）
 *
 * **不要**去猜 `sessionId` 里有没有 `session-` 前缀 —— 那是**巧合**，不是契约。
 *
 * ⚠️ 而 `parentSession` **在类型上属于 header / record，不属于 `AgentSession`**
 * ⇒ **两个地方都试**（运行时它在哪一份上，我不猜）。
 *
 * @param {object} session 会话对象（`agent.session` / `agent.session.header` 都行）
 * @returns {boolean}
 */
export function isSubagentSession(session) {
  if (session === undefined || session === null) return false;
  try { if (session.parentSession !== undefined) return true; } catch { /* 试下一条 */ }
  try { return session.header?.parentSession !== undefined; } catch { return false; }
}

/**
 * 从会话标题解析桌身份。
 *
 * ⚠️ **返回的是两位数字字符串**（如 `'02'`），不是 `'桌 02'` ——
 * 投递单里存的 `desk` 也用这个形式，**匹配逻辑不该掺显示格式**。
 * 要给人看的名字用 {@link deskLabel}。
 *
 * @param {unknown} rawTitle 会话标题（可能是 null / undefined / 非字符串）
 * @returns {string} `'02'` 这样的两位数字，或 {@link OFFICE_DESK}
 */
export function deskFromTitle(rawTitle) {
  if (typeof rawTitle !== 'string') return OFFICE_DESK;
  const m = DESK_RE.exec(rawTitle.trim());
  return m === null ? OFFICE_DESK : m[1];
}

/** 这个身份是不是"从标题真的读出来了"（而不是回落的）。 */
export function isResolvedDesk(desk) {
  return typeof desk === 'string' && /^\d{2}$/u.test(desk);
}

/** 给人看的写法：`'02'` → `'桌 02'`；`'办公室'` 原样。 */
export function deskLabel(desk) {
  return isResolvedDesk(desk) ? `桌 ${desk}` : OFFICE_DESK;
}

/**
 * **进程内的"当前真相"**（2026-09-30 加 —— 修"同一轮里两个读者看到不同数据"）。
 *
 * ## 为什么需要它
 *
 * 实测暴露的矛盾：同一个 turn 里，
 *   · **消息注入**说"认作桌 02"（对，因为它是**异步读标题之后**才写的）
 *   · **系统提示**还在说"认不出桌"（错，因为**它的渲染是同步的**，读到的是改名前的快照）
 *
 * **⇒ 根因不是"读得对不对"，而是"两个读者在什么时刻读"**：
 *   一个在异步更新**之前**渲染，一个在**之后**注入 ⇒ 天然不同步。
 *
 * ## 它是什么
 *
 * 一个**进程内的同步小缓存**：`sessionId -> { desk, title, turn }`。
 *   · **写**：认桌 / 改名时立刻写（同步，零延迟）
 *   · **读**：谁都先查它 —— **同一进程里所有读者看到同一份**
 *   · 它**不是权威**（重启会丢），权威仍是存储域 —— 查不到时回落过去
 *
 * ⚠️ **不拿 `store.js` 的域表来干这件事**：域是**持久**层，
 * 把"进程内一致性"塞进去会把两件事混在一起。**视图只解决"同一进程内一致"。**
 */
const VIEW = new Map();

/** 记录某个会话现在的身份（**同步**，调用后立刻对所有读者可见）。 */
export function rememberDesk(sessionId, patch) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  const prev = VIEW.get(sessionId) ?? {};
  VIEW.set(sessionId, { ...prev, ...patch, at: Date.now() });
}

/** 读某个会话现在的身份；没有就 `undefined`（调用方再去查权威存储）。 */
export function lookupDesk(sessionId) {
  return VIEW.get(sessionId);
}

/**
 * 在给定 ctx 上找 `sessionQuery`。
 *
 * ⚠️ **必须两处都试**（实测）：插件**根作用域取不到**，`agent.ctx` 上才有。
 * 而且 `Object.keys(服务)` **看不到方法**（方法在原型链上）⇒
 * 判断"有没有"要 `typeof x.fn === 'function'`，不能看 key 列表。
 *
 * @param {object|undefined} c 候选 ctx
 * @returns {object|undefined}
 */
export function findSessionQuery(c) {
  if (c === undefined || c === null) return undefined;
  try {
    const direct = typeof c.get === 'function' ? c.get('sessionQuery') : undefined;
    if (direct !== undefined && direct !== null) return direct;
  } catch { /* 换下一个途径 */ }
  try {
    if (c.sessionQuery !== undefined && c.sessionQuery !== null) return c.sessionQuery;
  } catch { /* 放弃 */ }
  return undefined;
}

/**
 * 读一个会话的标题。
 *
 * @param {object|undefined} agentCtx `agent.ctx`（**不是插件根 ctx**）
 * @param {string} sessionId
 * @returns {Promise<string|null>} 标题，或 `null`（读不到 —— 调用方据此**不要缓存**）
 */
export async function readSessionTitle(agentCtx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const sq = findSessionQuery(agentCtx);
  if (sq === undefined) return null;
  if (typeof sq.readTitle !== 'function') return null;
  try {
    const snap = await sq.readTitle(sessionId);
    const title = snap?.title;
    return typeof title === 'string' && title !== '' ? title : null;
  } catch {
    // 读标题失败只是"这次不知道"，绝不影响会话。
    return null;
  }
}

/**
 * 批量读标题（功能 1 状态表要用 —— 实测 14 个一次读通）。
 *
 * @param {object|undefined} agentCtx
 * @param {readonly string[]} sessionIds
 * @returns {Promise<Map<string,string>>} 只含读到的
 */
export async function readSessionTitles(agentCtx, sessionIds) {
  const out = new Map();
  const sq = findSessionQuery(agentCtx);
  if (sq === undefined || typeof sq.readTitleSnapshots !== 'function') return out;
  try {
    const results = await sq.readTitleSnapshots([...sessionIds]);
    for (const r of results ?? []) {
      if (r?.status === 'fulfilled') {
        const t = r.value?.title?.title;
        if (typeof t === 'string' && t !== '') out.set(String(r.sessionId), t);
      }
    }
  } catch { /* 批量读失败就当作都没读到 */ }
  return out;
}
