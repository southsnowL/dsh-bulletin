/**
 * **会话回收**：把"平台侧已经不存在的会话"从 `sessions` 表里清掉。
 *
 * ## 为什么需要（2026-09-30）
 *
 * > *"已认桌的会话，我要是把那个会话删掉，系统和仪表盘能不能也同步删掉？"*
 *
 * **原来不能** —— `sessions` 表**只增不减**（只有认桌时往里写，全项目**没有一处 `sessions.delete`**）
 * ⇒ 你删掉会话，它只是不再跑 `pre-step`，**记录永远留在表里**，
 * 状态表上**一直列着一个已经不存在的会话**。
 *
 * ⚠️ 这是"**表在骗人**"那一类问题 —— 与今天修过的几个同类（状态表漏会话、死配置键）。
 *
 * ## 判据（**2026-09-30 实测过，不是推断**）
 *
 * | 事实 | 证据 |
 * |---|---|
 * | 删会话后 `list()` 里少了它 | 24 → 23 ✅ |
 * | ⭐ **`stat(被删的 id)` 返回 `undefined`** | ✅ 实测 |
 * | ⭐ **`stat` 对"没在跑的旧会话"照样认得** | ✅ 被删的那个本来就没在跑，删前答"有"、删后才 `undefined` ⇒ **不会误删历史会话** |
 *
 * 平台契约原文：`stat` *"returns the snapshot, or **`undefined` when the session does not exist**"*。
 *
 * ## ⭐⭐ 判据的最终形态：**问平台"现在有哪些会话"，而不是自己记**（2026-09-30）
 *
 * ### 第一版（错的，已废）：自己维护一个"见过活着"的集合
 *
 * 原来是 `stat(id)` + 一个**进程内** `ALIVE` 集合：**只有"曾经查到过它活着"才敢删**。
 * 想防的是"平台一时查不到 ⇒ 误删"。
 *
 * **但它在真环境里坏了**（用户实测）：用户删掉一个会话后，回收**跑了 4 次都没清它**，
 * 而日志只说"没有发现已消失的会话" —— **看不出为什么**。逐 id 诊断才看清：
 *
 * ```
 * session-2265ab81… → undefined（平台说它不存在）
 * 但它在"见过活着"的集合里：没有
 * ⇒ if (!ALIVE.has(id)) continue;   ← 静默跳过
 * ```
 *
 * **根因**：进程**重启过** ⇒ `ALIVE` 重置 ⇒ 那个会话**从未在本进程被"认领"过**
 * ⇒ **安全阀永久拦着它**。**我为了防误删，造了一个重启后就永远不工作的东西。**
 *
 * ### 第二版（现在）：直接问平台要权威名单
 *
 * ⭐ **去仓库里找到了现成的**：`ctx.sessionQuery.listSessions()` ——
 * 契约原文：*"List the **complete logical corpus** with live precedence and cloned headers"*。
 *
 * ⇒ **拿它当"现在有哪些会话"的权威名单**，表里不在其中的就删。
 * **不需要内存集合、不需要持久化、跨重启天然正确**（平台知道真相，我不知道）。
 *
 * > ⚠️ `sessionQuery` **在插件根 ctx 上取不到** —— 只能在 **`agent.ctx`** 上拿
 * > （这一条在 `identity.js` 里已经踩过并记着）。所以扫描要在 **pre-step** 里做，
 * > 因为那里正好有 `payload.agent.ctx`。
 *
 * ## 安全设计（**三条**，第 2 条被上面那次替换掉了）
 *
 * | # | 措施 |
 * |---|---|
 * | **1** | **只删 `sessions` 表的记录** —— 不动单子、不动取走历史（那些是别的桌的事） |
 * | **2** | ⭐ **以 `listSessions()` 为准** —— 它不在名单里 ⇒ 平台说它不存在 ⇒ 才删。<br>（拿不到名单时**一条都不删** —— 宁可不清，也不误删） |
 * | **3** | **不删当前会话自己**（它当然存在，但省一次查询、也避免奇怪的时序） |
 * | **4** | **节流**（默认 10 分钟一次）：列名单/查询都是异步的，不能每步都全查 |
 *
 * ⚠️ **清掉一条记录不会丢东西** —— `sessions` 表是**缓存**（注释里就写着"这是缓存不是权威"）。
 * 那个会话要是又出现了，下一轮就会**重新认桌、重新写进去**。
 */
import { errText } from '../log.js';
import { listRecords } from '../store.js';
import { findSessionQuery } from '../identity.js';

/** 本功能的配置键（与 `index.js` 的开关同名）。 */
export const FEATURE = 'sessionGc';

/**
 * ⚠️ **只在"拿不到权威名单"时用的兜底**（第一版的机制）。
 *
 * 正常路径已经改成"问平台要名单"（见上面那段长注释）。
 * 这个集合只在**服务不可用**时留个念想 —— 但那时我们**一条都不删**，所以它其实不参与判据了。
 * 保留它只为了让自测能验"没见过活着就不敢删"这条历史行为。
 */
const ALIVE = new Set();

/** ⚠️ **仅供自测**：清掉进程内状态。 */
export function resetSessionGcForTest() {
  ALIVE.clear();
}

/**
 * 跑一次回收。
 *
 * @param {object} p
 * @param {object} p.sessions `sessions` 表
 * @param {object} p.sp `sessionPersistence` 服务
 * @param {string} p.selfSessionId 当前会话（**不删它**）
 * @param {Function} p.log 诊断日志
 * @param {Function} p.warn 警告
 * @returns {Promise<{ checked: number, removed: string[], alive: number }>}
 */
export async function sweepSessions({ sessions, sp, sessionQuery, selfSessionId, forget, log, warn }) {
  const rows = listRecords(sessions).filter(([, r]) => r !== null && typeof r === 'object');
  const removed = [];

  /**
   * ⭐ **明确点名"忘掉这个 id"**（2026-09-30 加，为清掉一个孤儿子代理）。
   *
   * ## 为什么需要这个入口
   *
   * 有个子代理会话（`e0c45fb8…`）—— 它**跑过一次**（所以表里有记录），
   * 但它是个**空壳**（解压后只有 header），而且**界面到不了它**
   * （子代理不列在侧栏、搜索也搜不到）。
   *
   * ⇒ 删掉它的文件之后，平台**可能**还认得它 ⇒
   * 常规判据（"平台认得就不删"）会**一直留着那一行**。
   * ⇒ 给一个**显式的、只删指定 id** 的入口，比等平台自己发现更干脆。
   *
   * ⚠️ **只在被明确点名时走这条路**（`forget: ['id']`）—— **绝不用于自动清理**。
   * 日常那条路仍然是"以 `listSessions()` 的权威名单为准"（见下面）。
   */
  if (Array.isArray(forget) && forget.length > 0) {
    for (const id of forget) {
      const key = String(id);
      if (key === selfSessionId) continue;
      try {
        await sessions.delete(key);
        removed.push(key);
        log('会话回收/按名忘掉', { id: key.slice(0, 24) });
      } catch (error) {
        warn('回收：忘不掉（不影响别的）', { id: key.slice(0, 24), error: errText(error) });
      }
    }
    return { checked: 0, removed, alive: ALIVE.size, skipped: [], platformKnows: null };
  }

  /**
   * ⭐ **第一步：问平台要"现在有哪些会话"的权威名单。**
   *
   * ⚠️ **拿不到名单就一条都不删** —— 宁可不清，也不误删。
   * （这正是第一版把 `ALIVE` 当判据时犯的错：那个判据在重启后**永远不工作**。）
   */
  let known = null;
  try {
    const all = await sessionQuery.listSessions();
    known = new Set(all.map((r) => String(r?.header?.id ?? '')).filter((x) => x !== ''));
  } catch (error) {
    warn('回收：拿不到会话名单 ⇒ 这一轮不删任何东西', { error: errText(error) });
  }
  if (known === null) {
    return { checked: 0, removed: [], alive: ALIVE.size, skipped: [], note: '拿不到权威名单，未动任何记录' };
  }

  /** 顺带把"平台认得、我们表里也有"的记进兜底集合（诊断用）。 */
  for (const [id] of rows) if (known.has(id)) ALIVE.add(id);

  const skipped = [];
  let checked = 0;

  for (const [id] of rows) {
    if (id === selfSessionId) continue;                 // 措施 3：不动自己
    checked += 1;
    if (known.has(id)) continue;                        // ⭐ 平台认得它 ⇒ 留着

    /**
     * ⚠️ **平台不认得它 ⇒ 删**。
     *
     * 这里**不再需要"我见过它活着没有"** —— 平台自己的名单就是真相。
     * （第一版正是在这里静默跳过，导致"重启前删掉的会话永远清不掉"。）
     */
    try {
      await sessions.delete(id);
      ALIVE.delete(id);
      removed.push(id);
    } catch (error) {
      warn('回收：删不掉（不影响别的）', { id: id.slice(0, 24), error: errText(error) });
      skipped.push(id);
    }
  }

  if (removed.length > 0) {
    log('会话回收/已清理', {
      count: removed.length,
      ids: removed.map((x) => x.slice(0, 24)),
      note: '平台名单里已经没有它们了',
    });
  } else {
    log('会话回收/检查', {
      checked,
      platformKnows: known.size,
      alive: ALIVE.size,
      heldBySafety: skipped.length,
      heldIds: skipped.map((x) => x.slice(0, 24)),
      note: skipped.length > 0 ? '有几个删不掉（见 warning）' : '表里每一条都还在平台名单里',
    });
  }
  return { checked, removed, alive: ALIVE.size, skipped, platformKnows: known.size };
}

/**
 * 装这个功能。
 *
 * @param {object} api `{ ctx, config, log, warn, store, onStateChanged }`
 */
export function setup(api) {
  const { ctx, config, log, warn, store } = api;
  const sessions = store.tables.sessions;
  const intervalMs = Number.isFinite(Number(config.sweepIntervalMs))
    ? Math.max(0, Number(config.sweepIntervalMs))
    : 600_000;
  /** 上次全查的时间（节流用）。 */
  let lastSweep = 0;
  /** 正在跑（防止两轮重叠）。 */
  let running = false;
  /** `sessionPersistence`（由下面的 `inject` 填上；没就位时就是 undefined）。 */
  let sp;
  /** ⚠️ 诊断用：这个实例的 pre-step 有没有被调过（只打一次）。 */
  let sawFirstCall = false;
  /**
   * ⚠️ **最近一次在 pre-step 里看到的 `sessionQuery`**。
   *
   * 为什么留这一手：诊断工具 `sweep_sessions` 是在**工具调用**里跑的，
   * 那里**未必有 `agent.ctx`** ⇒ 拿不到 `sessionQuery`。
   * 而它每次 pre-step 都会被看到 ⇒ **记住一份**，工具就能用。
   */
  let lastSessionQuery;

  /**
   * 试着跑一次（**节流 + 单飞**）。
   *
   * ⚠️ 列名单是**异步**的 ⇒ 不能每步都全查。
   * 挂在 pre-step 上只是为了"**每轮顺手看一眼**"，真正全查由 `sweepIntervalMs` 控制。
   *
   * ⚠️⚠️ **`sessionQuery` 必须从 `agent.ctx` 拿**（不是插件根 ctx）——
   * 这一条在 `identity.js` 里已经踩过并记着。
   */
  function maybeSweep(sessionId, sessionQuery) {
    if (intervalMs === 0) return;                       // 0 = 关掉（配置可关）
    if (sessionQuery === undefined) return;             // 拿不到名单服务 ⇒ 下次再说
    if (running) return;
    const now = Date.now();
    if (now - lastSweep < intervalMs) return;
    running = true;
    lastSweep = now;
    /**
     * ⚠️ **留痕**（2026-09-30 加）：排查"回收到底有没有跑"时，
     * 原来只有"跑完"的日志 ⇒ **分不清"没被调度"和"被调度了但正在跑"**。
     * （同一类"静默"问题本项目踩过很多次：认桌/检查 那行就是这么加的。）
     */
    log('会话回收/开始全查', { intervalMs, rows: listRecords(sessions).length });
    void sweepSessions({ sessions, sp, sessionQuery, selfSessionId: sessionId, log, warn })
      .then((r) => {
        // ⭐ 删了东西 ⇒ 喊一声让状态表跟上（与"认桌落库"走同一条通路）
        if (r.removed.length > 0) api.onStateChanged?.('会话回收');
      })
      .catch((error) => warn('会话回收整体失败（已忽略）', { error: errText(error) }))
      .finally(() => { running = false; });
  }

  /**
   * ⚠️ 用 **`inject` 拿服务**（不是 `ctx.get`）—— 这一条被误判过两次，
   * 详见 `进度与待办.md` §二之八之六：`ctx.get` 在"插件刚挂载那一刻"取不到任何服务。
   */
  ctx.effect(() => ctx.inject(['sessionPersistence'], (sctx) => {
    sp = sctx.sessionPersistence;
    log('会话回收/服务已就位', {
      intervalMs,
      /**
       * ⚠️⚠️ **把"我到底收到什么 config"整个打出来**（2026-09-30）。
       *
       * 现象：三份 `cordis.patch.yml`（源码 / profile junction / live 代际）**都写着 `60000`**，
       * 而这个日志报 `intervalMs = 600000` ⇒ **加载器传给插件的 config 不是我 patch 里那份**。
       * ⇒ 不再猜"是加载器旧了还是我读错了" —— **直接把现场打出来**：
       *   · `config` 上有没有 `sweepIntervalMs` 这个键
       *   · 如果有，值是多少
       *   · 全部键名是什么（看它像不像我那份 patch）
       */
      configKeys: Object.keys(config ?? {}),
      configSweep: config?.sweepIntervalMs,
      typeofSweep: typeof config?.sweepIntervalMs,
    });
  }));

  /** ⚠️ 平级的第二个 effect（**不要嵌套**）—— 监听器和 inject 各管各的。 */
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      const id = payload?.agent?.session?.id;
      /**
       * ⭐ **`sessionQuery` 只能在 `agent.ctx` 上拿**（插件根 ctx 上没有它）。
       *
       * ⚠️⚠️ **而且不能直接点属性** —— 实测报错原文：
       * `Error: cannot get property "sessionQuery" without inject`
       * ⇒ Cordis **必须先声明依赖**（`ctx.get(...)` 或 `inject`）。
       *
       * **`findSessionQuery()` 正是干这个的**（先 `get()`、不行再点属性）——
       * 而且 `identity.js` 里早就写着这条坑。**我第一次写这个功能时没照它做，白挨一次。**
       */
      const sq = findSessionQuery(payload?.agent?.ctx);
      if (sq !== undefined) lastSessionQuery = sq;
      /**
       * ⚠️ **每个进程的第一次调用必打一条**（2026-09-30 加，为了查一个查不出的问题）。
       *
       * 现象：真环境里 `认桌/检查` 每 10 秒都在跑（⇒ pre-step 是活的），
       * 但回收那条路**一次都没走到**（连"开始全查"都没有）——
       * 而**同样的代码在隔离环境逐字验过**（`intervalMs=60000` → 全查 → 检查）。
       * ⇒ 把**决定是否开跑的那几个变量的现场**打出来，**不再靠推断**。
       */
      if (!sawFirstCall) {
        sawFirstCall = true;
        log('会话回收/首次调度', {
          hasSessionId: typeof id === 'string' && id !== '',
          serviceReady: sp !== undefined,
          hasSessionQuery: sq !== undefined,
          intervalMs,
          configSweep: config?.sweepIntervalMs,
          running,
          lastSweep,
        });
      }
      if (typeof id === 'string' && id !== '') maybeSweep(id, sq);
    } catch (error) {
      warn('会话回收的调度出错（已忽略）', { error: errText(error) });
    }
    return decision;
  }));

  /**
   * 自测/诊断用：**立刻**跑一次（绕过节流）。
   *
   * ⚠️ 为什么要暴露它：真环境里回收"跑了但没删"，而**日志看不出为什么**
   * —— 分不清是"`stat` 说它还活着"、"没见过它活着"、还是"删失败了"。
   * ⇒ 给一个能**当场问**的入口，比读日志猜强。
   */
  function sweepNow(selfSessionId, sessionQuery, forget) {
    const sq = sessionQuery ?? lastSessionQuery;
    if (sq === undefined) return Promise.resolve({ checked: 0, removed: [], alive: ALIVE.size, skipped: [], note: '拿不到 sessionQuery（它只在 agent.ctx 上）' });
    return sweepSessions({ sessions, sp, sessionQuery: sq, selfSessionId, forget, log, warn });
  }

  /** 诊断用：现在"见过活着"的集合 + 节流状态。 */
  function gcState() {
    return {
      alive: [...ALIVE],
      aliveCount: ALIVE.size,
      intervalMs,
      lastSweep,
      running,
      serviceReady: sp !== undefined,
      hasSessionQuery: lastSessionQuery !== undefined,
    };
  }

  /**
   * ⭐ **诊断工具**（2026-09-30 加）。
   *
   * 为什么需要：真环境里回收"跑了但没删"，**读日志看不出为什么** ——
   * 分不清"`stat` 说它还活着"、"没见过它活着"、还是"删失败了"。
   * ⇒ 给一个**能当场问**的入口。
   */
  ctx.effect(() => ctx.inject(['tools'], (tctx) => tctx.tools.register({
    name: 'sweep_sessions',
    description:
      '【诊断】立刻跑一次会话回收（绕过节流），报告：查了几个、删了几个、'
      + '以及"见过活着"的会话集合。用来回答"我的会话回收到底有没有在工作"。'
      + '⚠️ 会真的删除记录（但只删"平台侧已确认不存在"的那些）。',
    parameters: {
      type: 'object',
      properties: {
        dry: { type: 'boolean', description: '只报告不删（默认 false）' },
        stats: { type: 'boolean', description: '逐 id 报平台名单里有没有它' },
        forget: {
          type: 'string',
          description: '⭐ **明确点名要忘掉的会话 id**（逗号分隔）—— 只删这些，'
            + '走的是"人明确要求"而不是自动判据。用来清掉"平台可能还认得、但确定不要了"的记录。',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async (args, exec) => {
      const out = [];
      const st = gcState();
      out.push(`节流：${st.intervalMs} ms ｜ 上次全查：${st.lastSweep === 0 ? '（还没跑过）' : `${new Date(st.lastSweep).toISOString().slice(11, 19)}Z`}`);
      out.push(`拿到 sessionQuery：${st.hasSessionQuery} ｜ sessionPersistence：${st.serviceReady}`);

      /**
       * ⭐ **先要权威名单** —— 判据是"平台名单里有没有它"，不再是"我见没见过它活着"。
       */
      let known = null;
      const sq = findSessionQuery(exec?.agent?.ctx) ?? lastSessionQuery;
      if (sq !== undefined) {
        try {
          const all = await sq.listSessions();
          known = new Set(all.map((r) => String(r?.header?.id ?? '')).filter((x) => x !== ''));
        } catch (error) { out.push(`⚠️ 列名单失败：${errText(error)}`); }
      }
      out.push(known === null
        ? '**平台名单：拿不到**（⇒ 按设计，这一轮不会删任何东西）'
        : `**平台名单里有 ${known.size} 个会话**`);

      const rows = listRecords(sessions).map(([id]) => id);
      out.push('');
      out.push(`我的记录表里有 ${rows.length} 条：`);
      if (known !== null && (args?.stats === true || args?.dry === true)) {
        for (const id of rows) {
          out.push(`  · \`${id.slice(0, 26)}…\` ${known.has(id) ? '（平台认得 ✅）' : '（**平台说没有** ⇒ 该清）'}`);
        }
      }

      if (args?.dry !== true) {
        out.push('');
        out.push('**跑一次全查**：');
        const forget = typeof args?.forget === 'string' && args.forget !== ''
          ? args.forget.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
        if (forget !== undefined) out.push(`  ⚠️ 这次是**按名忘掉**：${forget.join(', ')}`);
        const r = await sweepNow(exec?.agent?.session?.id, sq, forget);
        out.push(`  查了 ${r.checked} 个 · 删了 ${r.removed.length} 个${r.removed.length > 0 ? `：${r.removed.map((x) => `\`${x.slice(0, 22)}…\``).join('、')}` : ''}`);
        if (typeof r.note === 'string') out.push(`  说明：${r.note}`);
        if (Array.isArray(r.skipped) && r.skipped.length > 0) out.push(`  ⚠️ 没删掉的：${r.skipped.length} 个`);
        out.push(`  跑完"见过活着"的集合：${gcState().aliveCount} 个`);
      }
      return out.join('\n');
    },
  })));

  return { sweepNow, gcState };
}
