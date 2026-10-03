/**
 * 「提议改名」—— 2026-09-30 的 **方案 A：提议 + 用户点头才改**。
 *
 * ## 为什么不是"AI 自己改"（哪怕技术上完全做得到）
 *
 * 平台**确实**提供了这个能力（实测查到的服务契约）：
 *   `ctx.sessionTitle.rename(session, title)` —— **真服务，不是 `@Remote`，插件直接可调**。
 * （另一条 `ctx.sessionController.rename()` 是 `@Remote`，那是**给 UI 的**，即用户手动改名走的路。）
 *
 * 但能改 ≠ 该自己改。两条风险：
 *   ① **会覆盖用户起的名字** —— 会话里所有 AI 都能改标题；
 *   ② **任何一张桌都能改任意会话的名字**，包括别的桌的。
 * 而办公室既有规矩是「**动别的桌子之前要先问用户**」——
 * **标题记录的是"这张会话属于谁"，它是用户的东西，不是插件的。**
 *
 * ## 所以本功能只做两件事
 *
 * 1. **认不出桌时，提议一次**（写进系统提示；只在"标题没有 `NN-` 前缀"时出现，
 *    而且**只提议一次** —— 用户不理会就不再唠叨）；
 * 2. 提供 **`set_session_title` 工具** —— **AI 只在明确同意后**才调用它。
 *
 * ⚠️ **已经有 `NN-` 前缀的会话一个字都不提** —— 绝不覆盖用户已经起好的名字。
 *
 * ## ⚠️ 一个硬事实（2026-09-30）
 *
 * > **"开新会话不能直接改名，要先发一条消息产生真实会话之后我才能手动改。"**
 *
 * ⇒ 所以"平台先给自动标题、用户后改名"是**必然顺序**。
 * ⇒ 这条提议是**这个缺口的补丁**：AI 可以在用户同意后**当场**改名，不用用户去点。
 * ⇒ 而且**名字建议也不是瞎猜** —— 它从"这个会话最可能在干哪张桌的活"推：
 *    `cwd` 能对上某张桌的工作区 ⇒ 用那张桌的名字；否则用**最近在改的文件路径**推。
 */
import { deskFromTitle, deskLabel, isResolvedDesk, lookupDesk, rememberDesk } from '../identity.js';
import { errText } from '../log.js';

/** 本功能的配置键（与 `index.js` 的开关同名）。 */
export const FEATURE = 'proposeRename';

/**
 * `systemPrompt.section()` 的排序位。
 *
 * ⚠️ **`order` 是必填的**（服务契约 `PromptSection.order: number`），
 * 忘了传会抛错。用一个小正数：排在"身份/人设"之后、具体工具说明之前。
 */
const SECTION_ORDER = 400;

/**
 * 装配"提议改名"。
 *
 * @param {object} api 共享运行环境（见 `index.js`）
 * @returns {() => void} 卸载函数
 */
export function setup(api) {
  const { ctx, config, log, warn, store } = api;
  const sessions = store.tables.sessions;
  const deskNames = config.deskNames ?? {};

  /**
   * "这个会话提过了"的记账。
   *
   * ⚠️⚠️ **两个坑都踩过（2026-09-30 发现的）**：
   *
   * ① **原来用内存 `Set`** ⇒ 插件重载 / DSH 重启后**忘了** ⇒ 同一个会话**又提一次**。
   *    **⇒ 落盘记**（`misc` 表，键 `proposed:<sessionId>`）——
   *    **因为"一直被提示"比不提示更糟**（见 `docs\01` 那一节）。
   *
   * ② **原来在"返回文本之前"就 `add()`** ⇒ 万一那次渲染没真的送到模型
   *    （平台可能为了测量/试渲染而调用 `text()`），**就永久不说了** —— 反向的错。
   *    **⇒ 改成 `text()` 被调用过一次之后才记账**（保守：宁可多提一次，不可漏提）。
   *
   * ⚠️ 顺带：**`misc` 是权威存储，跨重装/重启都在**；它写不上时退回内存集合
   * （那样最坏是多提一次，可接受）。
   */
  const proposedMemory = new Set();
  const proposalKey = (sessionId) => `proposed:${sessionId}`;

  function alreadyProposed(sessionId) {
    try {
      if (store.tables.misc?.get?.(proposalKey(sessionId)) !== undefined) return true;
    } catch { /* 存储读不了 → 看内存 */ }
    return proposedMemory.has(sessionId);
  }

  function markProposed(sessionId) {
    proposedMemory.add(sessionId);
    try {
      store.tables.misc?.put?.(proposalKey(sessionId), { value: new Date().toISOString(), at: Date.now() });
    } catch (error) {
      warn('改名提议的记账写不上（最坏是下次再提一次）', { error: errText(error) });
    }
  }

  // ── ① 提议（写进系统提示，但**只在没认出桌时**，且只提一次）────────────────
  ctx.effect(() => ctx.inject(['systemPrompt'], (pctx) => pctx.systemPrompt.section({
    name: 'bulletin-dispatch:propose-rename',
    order: SECTION_ORDER,
    text: (context) => {
      try {
        const agent = context?.agent;
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== 'string' || sessionId === '') return '';
        // ⭐ **先查"当前真相"视图**（同步、进程内），没有才查权威存储。
        //    修的就是"注入说桌 02、系统提示还说认不出"那个矛盾：
        //    视图让**同一轮里所有读者看到同一份**数据。
        const known = lookupDesk(sessionId) ?? sessions.get(sessionId);
        const desk = typeof known?.desk === 'string' ? known.desk : undefined;
        // ⭐ **已经认出桌的会话一个字都不提** —— 绝不覆盖用户起好的名字。
        if (desk === undefined || isResolvedDesk(desk)) return '';
        if (alreadyProposed(sessionId)) return '';

        // ⚠️ **不猜桌号**：多张桌共用同一个 cwd（`<工作区>`），
        //    从会话上**推不出**它属于哪张桌 —— 猜错比不猜更糟。**直接问用户。**
        const deskList = Object.entries(config.deskNames ?? {})
          .map(([id, name]) => `\`${id}-${name}\``).join('、');
        const text = '跨桌投递：这个会话的标题没有桌号前缀，**认不出它属于哪张桌**。\n'
          + (deskList === '' ? '' : `办公室的桌子有：${deskList}。\n`)
          + '⚠️ 顺手可以问用户一句"这个会话是哪张桌的"，但**要改名前必须先得到用户同意** —— '
          + '同意之后才调用 `set_session_title`。**用户不同意就不要改，也不要再问第二次。**\n'
          + '（`NN-` 前缀是跨桌投递唯一能读出来的桌身份。）';
        // ⭐ 记账**放在最后**：只有真的要给出这段文本时才记（见上面坑 ②）。
        markProposed(sessionId);
        return text;
      } catch (error) {
        // fail-open：提示渲染失败绝不影响会话。
        warn('改名提议渲染失败（已忽略）', { error: errText(error) });
        return '';
      }
    },
  })));

  // ── ② 工具：AI 在**用户同意后**用它改名 ────────────────────────────────────
  ctx.effect(() => ctx.inject(['tools'], (tctx) => tctx.tools.register({
    name: 'set_session_title',
    description:
      '把**当前会话**的标题改成「NN-名字」形式（N 是两位桌号），让跨桌投递能认出它属于哪张桌。'
      + '⚠️ **必须先在对话里把新标题给用户看过、得到用户同意，才能调用本工具** —— '
      + '标题属于用户，不要自己决定改。'
      + '前缀 `NN-` 后面可以带数字区分同一张桌的第几个会话（如 `02-环境维护2`）。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '新标题，必须形如 `02-环境维护2`（两位数字 + 连字符 + 名字）',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      const wanted = String(args?.title ?? '').trim();
      // ⚠️ 复用**同一个**正则（`identity.js`），避免"写的时候和读的时候规则不一样"。
      if (!/^\d{2}\s*[-－—–]\s*\S/u.test(wanted)) {
        throw new Error('标题必须是「两位数字 + 连字符 + 名字」的形式，例如 `02-环境维护2`');
      }
      const agent = exec?.agent;
      const session = agent?.session;
      if (session === undefined) throw new Error('拿不到当前会话（无法改名）');

      // `sessionTitle` 是**真服务**（不是 @Remote）⇒ 插件可以直接调。
      // 老写法（`ctx.get(...)` 在根作用域）取不到，所以从 `agent.ctx` 试。
      const st = findSessionTitle(agent?.ctx) ?? findSessionTitle(ctx);
      if (st === undefined || typeof st.rename !== 'function') {
        throw new Error('本运行时没有 sessionTitle.rename（无法改名）—— 请让用户手动改会话标题');
      }
      const snap = st.rename(session, wanted);
      const title = snap?.title ?? wanted;
      const desk = deskFromTitle(title);
      const sessionId = String(session?.id ?? '');
      // ⭐ **改名之后立刻同步身份**（2026-09-30 加 —— 实测发现"改了名插件却不认"）：
      //    光靠"下一轮重读"也能自愈，但**同一轮里**别的读者可能已经按旧身份算过了
      //    ⇒ 当场把身份改过来，**不留窗口期**。
      const record = { desk, title, at: Date.now() };
      try {
        sessions.put(sessionId, record);
      } catch (error) {
        // 持久层写不上不影响改名本身（下一轮重读会补上）。
        warn('改名后同步持久层失败（下一轮会重读补上）', { error: errText(error) });
      }
      // ⭐ **更重要的一步**：写进"当前真相"视图 ⇒ **同一轮里还没渲染的读者立刻看到**。
      rememberDesk(sessionId, record);
      log('改名/已改', { session: sessionId.slice(0, 20), title, desk: deskLabel(desk) });
      return `已把本会话标题改为「${title}」。`
        + (isResolvedDesk(desk)
          ? `跨桌投递已认它为 **${deskLabel(desk)}**（当场生效，不用等下一轮）。`
          : '（⚠️ 但新标题仍然没有桌号前缀，跨桌投递还是认不出桌。）');
    },
  })));

  return () => { /* 监听器/段落由 ctx.effect 的 disposer 管 */ };
}

/**
 * 在给定 ctx 上找 `sessionTitle`。
 *
 * ⚠️ 与 `sessionQuery` 同样的坑：**插件根作用域不一定取得到**，`agent.ctx` 上才有。
 * 而且判断"有没有"要 `typeof x.rename === 'function'` ——
 * **`Object.keys(服务)` 看不到方法**（方法在原型链上）。
 */
function findSessionTitle(c) {
  if (c === undefined || c === null) return undefined;
  try {
    const direct = typeof c.get === 'function' ? c.get('sessionTitle') : undefined;
    if (direct !== undefined && direct !== null) return direct;
  } catch { /* 换下一个途径 */ }
  try {
    if (c.sessionTitle !== undefined && c.sessionTitle !== null) return c.sessionTitle;
  } catch { /* 放弃 */ }
  return undefined;
}
