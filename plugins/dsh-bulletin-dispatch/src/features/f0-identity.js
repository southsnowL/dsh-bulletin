/**
 * 功能 0（骨架）：**认桌 + 开桌自报身份**。
 *
 * 这是整包的地基 —— 功能 2–6 全建在"这张会话属于哪张桌"之上。
 * 所以第一步只做它，做到**能在真实会话里看见**为止。
 *
 * 实现要点（全部来自 2026-09-30 四轮实测，不再自己试）：
 *   · 身份 = **会话标题开头的两位数字**（见 `identity.js` 的注释）
 *   · 标题**不在 header 里**，必须 `agent.ctx.sessionQuery.readTitle()`
 *   · `readTitle` 失败时**不要缓存**，下一步再试（标题是平台异步生成的，第一次常常还没有）
 *
 * ⚠️ **fail-open**：本功能任何一步失败都只记日志，**绝不影响会话**。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  /**
   * ⚠️ **`OFFICE_DESK` 2026-10-02 从这个 import 里去掉了** ——
   * 它原来只用在"认不出桌才重读"那个条件里，而**那条条件改掉了**（见下面 `needRead` 那段）。
   * **⇒ 留着一个不再使用的 import，下一个读代码的人会以为这里还在用"办公室"那档。**
   */
  deskFromTitle, deskLabel, isResolvedDesk, isSubagentSession, lookupDesk,
  readSessionTitle, rememberDesk,
} from '../identity.js';
import { errText } from '../log.js';

/** 本功能的配置键（与 `index.js` 的开关同名）。 */
export const FEATURE = 'identity';

/** 重读标题的冷却（毫秒）。设置项在 `index.js`，这里只是兜底默认值。 */
const DEFAULT_RECHECK_MS = 10_000;

/**
 * 装配"认桌"。
 *
 * @param {object} api 共享运行环境
 * @param {object} api.ctx 插件根 ctx
 * @param {object} api.config 已校验的配置
 * @param {(kind: string, payload?: object) => void} api.log
 * @param {(message: string, payload?: object) => void} api.warn
 * @param {{ tables: Record<string, object>, where: string }} api.store
 * @returns {() => void} 卸载函数
 */
export function setup(api) {
  const { ctx, config, log, warn, store } = api;
  /** `sessionId -> { desk, title, at }` —— ⚠️ **缓存，不是权威**（标题能被用户改）。 */
  const sessions = store.tables.sessions;
  const recheckMs = Number.isFinite(Number(config.recheckMs)) ? Math.max(0, Number(config.recheckMs)) : DEFAULT_RECHECK_MS;

  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    // ⚠️ 顺序很重要：**先 `await next()` 拿到 decision**（waterfall 必须往下走），
    //    再做自己的事，最后**原样或加一条**返回。
    const decision = await next();
    try {
      const agent = payload?.agent;
      const sessionId = agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId === '') return decision;

      /**
       * ⭐⭐ **子代理不是"桌"—— 直接不认。**（2026-09-30 加）
       *
       * ## 为什么（真事）
       *
       * 用户看到状态表里有一行「**办公室** `—` 你是一个独立的技术评审。请\*」，
       * 问"这是谁"。查出来是**我自己派出去的一个子代理**（`origin: 'subagent'`，
       * `parentSession` 就是我这条会话），**而且它压根没跑起来**（解压后只有 header）。
       *
       * ## 根因：**子代理不可能有桌**
       *
       * 认桌靠的是**会话标题的 `NN-` 前缀**，而子代理的标题是
       * **派出去时那段提示词的开头**（"你是一个独立的技术评审…"）——
       * **它天然不可能有 `NN-` 前缀**。⇒ 认出来必然是"办公室"。
       *
       * ⇒ 于是**只要子代理跑过一步，状态表里就会多一行"办公室"** ——
       * 不是偶发 bug，是**设计上必然**。
       *
       * ## 这一改的两个效果
       *
       * | # | 效果 |
       * |---|---|
       * | **1** | **根治**：子代理不再进 `sessions` 表 ⇒ 状态表里再也不会出现它 |
       * | **2** | 顺带让状态表**更准**：那张表本来只该有"桌" |
       *
       * ⚠️ **判据本身已搬到 `src/identity.js` 的 `isSubagentSession`**
       * （2026-10-01）—— 因为 `f2-dispatch.js` 有**自己的入口**，
       * 而当时那里**没有这个检查** ⇒ 子代理绕过了排除。
       * **⇒ 现在所有入口 import 同一个判定，不在各处再抄一遍。**
       */
      if (isSubagentSession(agent?.session)) return decision;

      // ⭐ **先查"当前真相"视图**，没有才查权威存储。
      //    视图是同步的、进程内的 ⇒ **同一轮里所有读者看到同一份**
      //    （修的就是"注入说桌 02、系统提示还说认不出"那个矛盾）。
      const known = lookupDesk(sessionId) ?? sessions.get(sessionId);
      const cachedDesk = typeof known?.desk === 'string' ? known.desk : undefined;
      const cachedTitle = typeof known?.title === 'string' ? known.title : undefined;
      const at = typeof known?.at === 'number' ? known.at : 0;
      const cachedTurn = typeof known?.turn === 'number' ? known.turn : undefined;

      // ── 决定"这次要不要读标题" ──────────────────────────────────────────────
      //
      // ⚠️⚠️ 这条规则**改过两次**，两次都是真 bug 逼出来的：
      //
      // **第一版："只读一次就缓存"** ⇒ 会话刚建时平台**先给自动标题**（「打招呼问候」），
      //   读到它就认成"办公室"并缓存 ⇒ **用户改名后永不重读** ⇒ 永远认错桌。
      //
      // **第二版："没认出桌就按冷却重读"**（10 秒）⇒ **仍然会漏**。实测（2026-09-30）：
      //   09:44:38 读了一次（超时，仍是「你好」）⇒ 刷新计时器；
      //   09:44:46 **用户改名** ⇒ 距上次读才 8 秒 < 冷却 ⇒ `needRead=False` ⇒ **不重读**；
      //   会话结束 ⇒ **永久停在"办公室"**。
      //   **⇒ 根因：我拿"上次读的时间"当计时器，可"用户改名"是个事件，不是时间流逝。**
      //
      // **第三版（现在）：按 turn 边界检查** ——
      //   · 一个 turn 里读**最多一次**（同 turn 的后续 step 跳过，不费）
      //   · **每个新 turn 都重新检查** ⇒ 用户在**任何两轮之间**改名，下一轮就认对
      //   · ⚠️ **"已经认对桌的会话不重读"** —— 这一条 **2026-10-02 去掉了**，
      //     理由见下面 `needRead` 那段（**改编号就是换桌**，而那正是文档一直说的）。
      //   · `recheckMs` 只在**同 turn 内**当二次保险（turn 信息缺失时退回按时间）
      const turn = typeof payload?.turn === 'number' ? payload.turn : undefined;
      const now = Date.now();
      const newTurn = turn !== undefined && turn !== cachedTurn;
      /**
       * ⭐ **一次性补齐**：老记录里没有 `sessionId` 副本 ⇒ **强制读一次标题**把它补上。
       *
       * ## 为什么需要（2026-09-30，两个 bug 叠在一起才暴露出来）
       *
       * 状态表的"认过桌的会话"那一列**会话名全渲染成 `—`**：因为 `sessions` 记录里
       * **没有 `sessionId` 副本**（渲染时 `s.sessionId ?? s.id` 两边都是 undefined）。
       *
       * ① 第一个 bug：`sessionId` 原来**只在"认桌结果变了"那条分支里写** ⇒
       *    **早就认好桌的会话永远走不到那条分支** ⇒ 永远没有这个字段。
       * ② 第二个 bug（**修完 ① 才发现**）：那段补写代码在 `if (!needRead) return` **之后**，
       *    而"已经认好桌"的会话 `needRead` 恒为 `false` ⇒ **补写代码根本执行不到**。
       *
       * ⇒ 所以判据要放到**这道闸门之前**：**"老记录缺这个字段"本身就是该读一次的理由**。
       *   **一次性** —— 补上之后就不再触发（不会变成每步都读）。
       */
      /**
       * ## ⚠️⚠️ **`cachedDesk` 必须是"真桌号"**（2026-10-03 补，外部终审指出）
       *
       * ### 原来是什么样
       *
       * ```js
       * const needBackfill = cachedDesk !== undefined && (…缺 sessionId…);
       * ```
       *
       * ⚠️ **而 `cachedDesk` 可能是 `'办公室'`**（标题没编号 / 压根没读到）——
       * 那种记录**本来就不该存在**（见下面 `:215` 那处修正），
       * **⇒ 拿它当"该补字段"的理由，会让没编号的会话每一步都重读一次标题。**
       *
       * ⇒ 收紧成 **`isResolvedDesk(cachedDesk)`**（`/^\d{2}$/`）。
       */
      const needBackfill = isResolvedDesk(cachedDesk)
        && (sessions.get(sessionId)?.sessionId === undefined);
      /**
       * ## ⭐⭐ **"桌号认定后不随标题变"这条规矩，2026-10-02 改掉了**
       *
       * ### 原来是什么样
       *
       * ```js
       * const needRead = cachedDesk === undefined
       *   ? (turn !== undefined ? newTurn : now - at >= recheckMs)
       *   : (cachedDesk === OFFICE_DESK && newTurn);   // ⚠️ 认出来的桌，再也不重读
       * ```
       *
       * **⇒ 已经认对桌的会话永远不重读标题。**
       * 而 `f2-dispatch` 那边**每轮都重读**（它只拿标题刷新显示名）——
       * **⇒ 结果是"两条路不一样"**：手动把标题从 `02-x` 改成 `03-y`，
       * **显示名跟着变了，桌号却还是 02**；而**用插件的改名工具改，会当场变成 03。**
       *
       * ### 为什么改成"也重读"（一份外部审查顺着源码走了一遍，说服了我们）
       *
       * **原来那条"不让改名悄悄换桌"的理由是**：
       * *"老单子会找错人"* —— ⚠️ **而它不成立**：
       *
       * | 顾虑 | 实际 |
       * |---|---|
       * | 换成 03 之后，先前的 02 单子会不会被它取走 | ❌ 不会 —— 它现在只取 03 的单子 |
       * | 那 02 的单子怎么办 | ✅ **留在那儿**，等 **02 桌别的会话**来取（单子挂在**桌**上，不挂在会话上） |
       * | 已经取走的会不会受影响 | ❌ 不会 |
       *
       * **⭐ 另外，README 和文档里的说法一直是"桌号就是标题前缀"** ——
       * **⇒ 手动改标题本身就是一次"我换桌了"的声明**，而我们却当它没发生。
       * **那不只是不一致，是"文档说的和做的不一样"。**
       *
       * ### 代价（说清楚）
       *
       * **每个新 turn 多读一次标题**（`readSessionTitle` 读的是会话日志）。
       * ⚠️ 而这件事**本来就在发生** —— `f2-dispatch` 每轮都读它。
       * **⇒ 现在两边共用这一次判定，总量没变。**
       *
       * ⚠️ **只在 turn 边界重读**（不在同 turn 的每个 step 重复读）——
       * **标题是用户在"两轮之间"改的**，同一个 turn 里不会变。
       */
      const needRead = cachedDesk === undefined
        ? (turn !== undefined ? newTurn : now - at >= recheckMs)
        : newTurn;
      // ⭐ **这一步要留痕**（0.1.3 加）：排查"处理器到底有没有跑、为什么没重读"时，
      //    没有这条就无法区分"没被调用"和"被调用了但判定不用读"。
      log('认桌/检查', {
        session: sessionId.slice(0, 20), step: payload?.step, turn,
        cached: cachedDesk ?? null, cachedTurn: cachedTurn ?? null,
        ageMs: at === 0 ? null : now - at, newTurn, needRead, needBackfill,
      });
      if (!needRead && !needBackfill) return decision;

      const title = await readSessionTitle(agent?.ctx, sessionId);
      // ⚠️ 读不到标题 ⇒ **不要写缓存**，下一步再试（标题是平台异步生成的，第一次常常还没有）。
      if (title === null) {
        log('认桌/标题暂时读不到，下次再试', { session: sessionId.slice(0, 20) });
        return decision;
      }

      const desk = deskFromTitle(title);
      /**
       * ## ⚠️⚠️⚠️ **"认不出来"的会话不该进名单**（2026-10-03 修）
       *
       * ### 原来错在哪（**外部终审指出来的，而且我一读源码就确认了**）
       *
       * 下面那条"变了"的分支**无条件 `sessions.put(...)`** ——
       * **而 `desk` 可能是 `OFFICE_DESK`（'办公室'）**（标题没 `NN-` 前缀时 `deskFromTitle` 就回落到它）。
       *
       * **⇒ 症状**：**随手开的、没编号的会话会以"办公室"出现在「认过桌的会话」名单里**，
       * **面板顶上那个计数也算它。**
       *
       * ### ⚠️ 而这是我们**自己文档说不会发生**的事
       *
       * `docs/01` · `docs/02` · `docs/03` 里**五处**都写着"认不出就不记" ——
       * **⇒ 代码和文档相反，而错的是代码。**
       *
       * ### ⭐ 而且是**我自己留的伏笔**
       *
       * 下面 `:244` 那行注释写着：*"只对**真的读出来了**的会话报身份 —— 回落到'办公室'的会话没什么可报的"*。
       * **⇒ 说明我当时就知道这个区别，只是把它用在了"报身份"上，没用在"记名单"上。**
       *
       * ### 修法（三处一起）
       *
       * | 处 | 改成 |
       * |---|---|
       * | `needBackfill` | 只给**真桌号**补字段 |
       * | "没变"那支的 `missingId` | 同上（否则没编号的会话每步都写一次存储） |
       * | **这一支的 `put`** | **只有真桌号才进库**；**原来在某张桌、现在标题没编号了 ⇒ 从名单里删掉**（它离开办公室了） |
       *
       * ⚠️ **而 `rememberDesk(...)` 照旧要写** —— 那是**内存里的"当前真相"视图**，
       * `f1` 的"邀请一次"靠它（**邀请和"算不算成员"是两件事**）。
       */
      // ⚠️ **认出来过、且没变** ⇒ 只刷新时间戳与 turn，不重复注入。
      if (cachedDesk === desk && cachedTitle === title) {
        /**
         * ⚠️⚠️ **这里有一个真 bug，2026-09-30 由 01 桌报出来**：
         *
         * `sessionId` 副本原来**只在下面那条"变了"的分支里加** ⇒
         * 而那些**桌早就认好了**的会话永远走这条分支 ⇒ **它们的记录里永远没有 `sessionId`**
         * ⇒ 状态表的"认过桌的会话"那一列**全渲染成 `—`**（实测 5 条记录，0 条有 `sessionId`）。
         *
         * ⇒ 修法：**补齐缺失的字段**（不是"每次都写"，那会每步都动存储）。
         *
         * ⚠️ ⚠️ **判断要查存储，不能查 `known`**（内存视图）——
         * `known` 是本步开头取的快照，**它自己就可能缺这个字段**
         * ⇒ 拿它当判据会**每次都认为"缺"，每次都写一遍**。
         *   （`needBackfill` 那道闸门用的是 `sessions.get(...)`，正是为了同一个理由。）
         */
        const missingId = sessions.get(sessionId)?.sessionId !== sessionId;
        /** ⚠️ **只给真桌号补** —— 否则没编号的会话每一步都会重写一次存储。 */
        if (missingId && isResolvedDesk(desk)) {
          sessions.put(sessionId, { sessionId, desk, title, at: now, turn: turn ?? cachedTurn ?? 0 });
          // ⭐ 会话表变了 ⇒ 让纠偏看得见（否则仪表盘会漏掉这条，01 桌报的就是这个）
          api.onStateChanged?.('认桌');
        }
        rememberDesk(sessionId, { sessionId, desk, title, at: known?.at ?? now, turn: known?.turn ?? 0 });
        return decision;
      }

      const record = { sessionId, desk, title, at: now, turn: turn ?? cachedTurn ?? 0 };
      /**
       * ⭐ **只有"真桌号"才进名单**（见上面那段长注释）。
       *
       * ⚠️ 而**"原来在某张桌、现在标题没编号了" ⇒ 从名单里删掉** ——
       * 那是"它离开办公室了"（**用户把标题改掉了**），不是"它还在，只是名字读不到"
       * （后者在前面的 `title === null` 那一步就 `return` 了，走不到这里）。
       */
      if (isResolvedDesk(desk)) {
        sessions.put(sessionId, record);
      } else if (sessions.get(sessionId) !== undefined) {
        await sessions.delete(sessionId);
      }
      // ⭐ 同步写进"当前真相"视图 —— **让同轮里还没渲染的读者立刻看到**。
      rememberDesk(sessionId, record);
      /**
       * ⭐ **告诉仪表盘"会话表变了"**（2026-09-30，01 桌报的漏会话 bug）。
       *
       * 为什么必须有这一步：**两个 `agent/pre-step` 处理器在同一个 turn 里并行跑**
       * —— 投递那边可能**先**纠偏（那时这条会话还没落库），9 毫秒后这里才写。
       * 没有这一声，就**没人再纠偏一次**，仪表盘就一直漏着它。
       * （而且 `onStateChanged` 走的是**同步视图 + 下一 tick 合并**，
       *   所以这一次喊话会读到**已经落库的**会话表 —— 实测 01 桌的时序差正是 9 ms。）
       */
      api.onStateChanged?.('认桌');
      log(cachedDesk === undefined ? '认桌/已认' : '认桌/刷新', {
        session: sessionId.slice(0, 20), title, desk: deskLabel(desk),
        resolved: isResolvedDesk(desk), was: cachedDesk === undefined ? null : deskLabel(cachedDesk),
      });

      // 只对"真的读出来了"的会话报身份 —— 回落到"办公室"的会话没什么可报的
      // （它还没起名字，平台的自动标题会一直变）。
      if (!isResolvedDesk(desk)) return decision;

      const text = String(config.identityNotice ?? '')
        .replaceAll('{desk}', deskLabel(desk))
        .replaceAll('{title}', title);
      if (text.trim() === '') return decision;

      const messages = Array.isArray(decision?.messages) ? decision.messages : [];
      return { ...decision, messages: [...messages, makeNotice(text)] };
    } catch (error) {
      // fail-open：认桌失败绝不影响会话。
      warn('认桌失败（已忽略）', { error: errText(error) });
      return decision;
    }
  }));

  return () => { /* 监听器由 ctx.effect 自己的 disposer 管 */ };
}

/**
 * 造那条"报身份"的消息。
 *
 * ⚠️⚠️ **必须有 `source`**（2026-09-30 真炸过一次，教训血淋淋）：
 *   平台下游到处在读 `message.source.kind`（消息种类的判别联合）。
 *   我第一版只传了 `content` ⇒ `source` 是 `undefined` ⇒
 *   下游一读就是 **`Cannot read properties of undefined (reading 'kind')`**，
 *   **整个 turn 直接失败**（用户看到"本轮运行失败"）。
 *
 *   ⇒ 所以对齐**已验证能跑**的公告插件写法：`source: { kind: …, form: …, summary: … }`。
 *   这里用 `kind: 'user'` —— 它是 `MessageSourceMap` 里**确定存在**的一种，
 *   不为了好看去造一个新 kind（那要平台认，不值当）。
 */
function makeNotice(text) {
  return createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  });
}
