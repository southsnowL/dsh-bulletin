/**
 * 按桌投递的**工具**（给 AI 用）。
 *
 * ## 的边界（2026-09-30）
 *
 * | 项 | 决定 |
 * |---|---|
 * | 单子形态 | **指针型**：一句话 + 指向哪里（内容本体留在文档里） |
 * | 谁发 | ⭐ **AI 用工具发** —— **不做监视文件夹那套** |
 * | "已处理" | **不做** —— 只保证送到 |
 * | 怎么送到 | 写进**系统提示**（不占消息流） |
 * | 收方 | **谁先来谁取走**（同桌只有一个会话能拿到） |
 *
 * ## ⚠️ 一条写给模型的边界说明
 *
 * **投递不是"派活"** —— 它把"有这么件事、去哪看"放到对方桌上，
 * **要不要做由对方（和用户）决定**。所以工具描述里写明"**不需要回执**"，
 * 免得收方纠结要不要回应（2026-09-30："别让它重新分析/分心"）。
 */
import { deskLabel, OFFICE_DESK } from '../identity.js';
import { isTaken } from './f2-dispatch.js';
import { lastWrite, listRecords, putTracked } from '../store.js';

/** 生成单子 id：时间 + 一小段内容哈希（**不引入新依赖**，用便宜的字符串哈希）。 */
function makeTicketId(desk, summary, at) {
  let h = 0;
  const s = `${desk}\u0000${summary}\u0000${at}`;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  /**
   * ⭐ **末尾再加一段随机**（2026-10-05 加，回应 Codex 审查 **P2-4**）。
   *
   * id 原来是"**时间 + 内容哈希**"，而哈希只吃 `桌号 + 摘要 + 时间` ✗ ⇒
   * **同一毫秒 + 同一摘要**（指针不同）会撞成同一个 id ⇒ 第二张**覆盖**第一张 ✓
   * （审查靠**冻结时间**复现过 ✓）。加 3 位 base36 随机 ⇒ 撞号要先撞毫秒、再撞随机 ✓。
   */
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return `t${at.toString(36)}${(h >>> 0).toString(36).slice(0, 5)}${rand}`;
}

/**
 * 归一化目标桌的写法：接受 `02` / `2` / `桌 02` / `02 桌`。
 *
 * ## ⚠️⚠️ **"办公室"不再是合法的投递目标**（2026-10-01 定）
 *
 * ### 原来什么样（一个黑洞）
 *
 * 这个函数原来把 `办公室` 归一成 `OFFICE_DESK`，工具的说明里还写着
 * *"不确定是哪张桌就填『办公室』"* —— **而接收端会跳过所有"办公室"会话**
 * ⇒ **那些单子永远不会被任何人取走，静静地躺在状态表里显示"待取"。**
 *
 * ### 用户为什么说该删（**这个理由比"有个 bug"更根本**）
 *
 * > *"投给办公室不相当于全桌通告吗？那不就是公告功能吗？"*
 *
 * **⇒ 一针见血**：一个"发给所有人"的单子**就是公告**，而公告早就有了。
 * **两套机制做同一件事，就是副本** —— 而我们整套东西的立场就是"副本是病根"。
 *
 * > *"而且真要投给办公室的话，那应该投给 02，02 是整个 DSH 环境的维护者和办公室管理员。"*
 *
 * **⇒ 所以"要通知全局"有两个正当出路，都不是"投给办公室"**：
 * - **公告**（`announce` 工具）—— 真正的广播
 * - **投给桌 02**（办公室管理员）—— 一个**有人负责**的明确地址
 *
 * @param {string} raw
 * @returns {{desk: string}|{office: true}|{bad: true}}
 *   `office` 单独一档，因为**它需要一句专门的解释**（不是"拼错了"）
 */
function normalizeDesk(raw) {
  const s = String(raw ?? '').trim();
  /** ⚠️ **完全没填**单独一档 —— 它和"填了办公室"是**两件事**，报错也该不一样。 */
  if (s === '') return { blank: true };
  if (s === OFFICE_DESK || s === '办公室') return { office: true };
  const m = /(\d{1,2})/u.exec(s);
  if (m === null) return { bad: true };
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 99) return { bad: true };
  return { desk: String(n).padStart(2, '0') };
}

/**
 * 装配投递工具。
 *
 * @param {object} api 共享运行环境
 * @returns {() => void} 卸载函数
 */
export function setup(api) {
  const { ctx, config, log, warn, store } = api;
  const tickets = store.tables.tickets;
  const deskNames = config.deskNames ?? {};

  const deskHint = () => Object.entries(deskNames)
    .map(([id, name]) => `\`${id}\`（${name}）`).join('、');

  // ── 工具 ①：发单 ──────────────────────────────────────────────────────────
  ctx.effect(() => ctx.inject(['tools'], (tctx) => tctx.tools.register({
    name: 'dispatch_ticket',
    description:
      '把一件事**投给某张桌**：写一张"指针型"单子（一句话 + 详见哪里），'
      + '对方开桌/下一轮时会在系统提示里看到它，**谁先来谁取走**（同一张桌只有一个会话会拿到）。'
      + '⚠️ **单子只负责告知，不是派活** —— 要不要做由对方和用户决定，**不需要回执**。'
      + `目标桌用两位数编号：${deskHint()}。`
      + '⚠️ **没有"投给所有人"这回事** —— 要广播就用 `announce`（那是公告）。',
    parameters: {
      type: 'object',
      properties: {
        desk: { type: 'string', description: '目标桌，如 `02`（也接受 `2` / `桌 02`）' },
        summary: { type: 'string', description: '一句话说清是什么（**不要复制内容本体**）' },
        ptr: { type: 'string', description: '详见哪里：文件或目录路径（**指向权威位置**）' },
      },
      required: ['desk', 'summary', 'ptr'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      const target = normalizeDesk(args?.desk);
      /**
       * ⭐⭐ **"办公室"要说一句专门的解释**（不是"拼错了"）——
       * 而且**要给出两条正当出路**，否则 AI 只会换个地方瞎试。
       *
       * 2026-10-01 的原话：
       * > *"投给办公室不相当于全桌通告吗？那不就是公告功能吗？"*
       * > *"真要投给办公室的话，那应该投给 02，02 是整个 DSH 环境的维护者和办公室管理员。"*
       */
      if (target.blank === true) {
        throw new Error(
          `目标桌不能为空 —— 单子必须投给**某一张具体的桌**（可用：${deskHint()}）。\n`
          + '⚠️ 如果这件事是"想让所有人都知道"，那它不是单子，是**公告**（用 `announce` 工具）。',
        );
      }
      /**
       * ## ⚠️⚠️ 2026-10-03：**去掉了这两句"我们办公室的约定"**
       *
       * ### 原来写的是
       *
       * ```text
       * … 要通知办公室管理员就投给桌 02。
       * · 想通知**办公室管理员**（DSH 环境维护那张桌）⇒ 投给 `02`。
       * ```
       *
       * **⇒ 而"02 是管理员"是**我们自己那张桌的约定**，不是这套东西的规则。**
       *
       * ⚠️ **别人装上以后，他的模型也会被这么告知** —— 而人家的 `02`
       * 完全可能是"前端"、是空的、或者根本不存在。
       * **⇒ 一句写死的桌号，会在别人的办公室里指错人。**
       *
       * ⭐ 一份**公开的参考实现**里，**不该出现"我们办公室的编制"。**
       * （外部终审指出来的，指得对。）
       */
      if (target.office === true) {
        throw new Error(
          '「办公室」**不是投递目标** —— 单子必须投给**某一张具体的桌**。\n'
          + '· 想让**所有人**都知道 ⇒ 那不是单子，是**公告**（用 `announce` 工具）。\n'
          + (deskHint() === '' ? '' : `· 这个办公室现有的桌：${deskHint()}。\n`)
          + '⚠️ 原来允许填"办公室"，但**没有任何会话会去取那种单子** —— 它们会一直在状态表里显示"待取"，'
          + '**等于投进了黑洞**。所以现在直接拒掉。',
        );
      }
      if (target.bad === true) {
        throw new Error(`目标桌无法识别：「${String(args?.desk)}」—— 用两位数编号，如 \`02\`（可用：${deskHint()}）`);
      }
      const desk = target.desk;
      const summary = String(args?.summary ?? '').replace(/\s+/gu, ' ').trim();
      if (summary === '') throw new Error('summary（一句话）不能为空');
      const ptr = String(args?.ptr ?? '').trim();
      if (ptr === '') throw new Error('ptr（详见哪里）不能为空 —— 单子是指针型的，必须给出去哪看');
      if (summary.length > 300) throw new Error('summary 太长（>300 字）—— 单子只放一句话，内容本体留在文档里');

      const at = Date.now();
      const id = makeTicketId(desk, summary, at);
      // 来源桌：从**发单这个会话**的身份推（认不出来就诚实写"办公室"）。
      const fromDesk = (() => {
        try {
          const sid = exec?.agent?.session?.id;
          const known = sid === undefined ? undefined : store.tables.sessions.get(sid);
          const d = typeof known?.desk === 'string' ? known.desk : undefined;
          return d === undefined || d === OFFICE_DESK ? OFFICE_DESK : d;
        } catch { return OFFICE_DESK; }
      })();

      const record = {
        id, desk, summary, ptr, source: fromDesk, at, takenBy: null,
      };
      try {
        // ⚠️ **必须 `await`**（2026-09-30 实测）：域的 `put` 返回 Promise，
        //    同步 `try/catch` **接不住拒绝** ⇒ 写失败会被静默吞掉，
        //    而工具照样回执"已投给 XX" —— 我原来就是这样丢了两张真单子。
        await putTracked(tickets, id, record);
      } catch (error) {
        warn('单子写不进存储（本次投递未生效）', {
          id, error: String(error?.message ?? error), code: error?.code ?? null,
        });
        throw new Error(`单子没能写入存储（本次投递未生效）：${String(error?.message ?? error)}`);
      }
      log('投递/已发单', { id, desk: deskLabel(desk), from: deskLabel(fromDesk), summary: summary.slice(0, 40) });
      // ⭐ 状态变了 ⇒ 让人看的仪表盘跟上（同一 tick 里多次变化只写一次）。
      api.onStateChanged?.('发单');
      return `已投给 **${deskLabel(desk)}**（单号 \`${id}\`）：${summary}\n`
        + `详见：\`${ptr}\`\n`
        + '它会在对方**下一轮**出现在系统提示里；**谁先来谁取走**，取走之后同桌别的会话看不到。'
        + '（不需要回执 —— 对方做不做由它和用户决定。）';
    },
  })));

  // ── 工具 ②：看本桌还有什么待取 ────────────────────────────────────────────
  ctx.effect(() => ctx.inject(['tools'], (tctx) => tctx.tools.register({
    name: 'list_tickets',
    description:
      '列出**本桌还没被取走**的投递单（只读）。用来跟进"还有哪些事挂着"，'
      + '或排查"我是不是漏看了什么"。**不会取走任何单子** —— 取走发生在正常开桌/下一轮时。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (_args, exec) => {
      const sid = exec?.agent?.session?.id;
      const known = sid === undefined ? undefined : store.tables.sessions.get(sid);
      const desk = typeof known?.desk === 'string' ? known.desk : OFFICE_DESK;
      if (desk === OFFICE_DESK) {
        return '本会话还没认出桌（标题没有 `NN-` 前缀），所以看不出"本桌"有哪些单子。'
          + '（先让用户定一下这个会话属于哪张桌。）';
      }
      const rows = [];
      try {
        // ⚠️ 用 `listRecords`（存储无关）—— 兜底文件表没有 `entries`，直接调会抛。
        for (const [id, rec] of listRecords(tickets)) {
          if (rec?.desk !== desk) continue;
          if (isTaken(id)) continue;
          if (rec?.takenBy !== null && rec?.takenBy !== undefined) continue;
          rows.push({ id, ...rec });
        }
      } catch (error) {
        return `列单子失败：${String(error?.message ?? error)}`;
      }
      /**
       * ⚠️ **区分"真的没有"和"我列不出来"**（2026-09-30 测试抓到）：
       * 如果存储既不支持 `entries()` 也不支持 `keys()`，`listRecords` 会返回空 ——
       * 那时报"没有待取的单子"是**静默漏报**，比报错更糟。
       * ⇒ 只有确认"能枚举"时才敢说"没有"。
       */
      const canEnumerate = typeof tickets?.entries === 'function' || typeof tickets?.keys === 'function';
      if (rows.length === 0 && !canEnumerate) {
        return `${deskLabel(desk)}：**列不出来** —— 当前存储（兜底文件表）没有"枚举全部"的能力。`
          + '这不代表没有单子，只代表我看不到。';
      }
      if (rows.length === 0) return `${deskLabel(desk)}：**没有待取的单子**。`;
      const lines = rows
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
        .map((t) => `· \`${t.id}\` 来自 **${deskLabel(t.source ?? OFFICE_DESK)}**：${t.summary} —— 详见 \`${t.ptr}\``);
      return `${deskLabel(desk)}：**待取 ${rows.length} 张**\n${lines.join('\n')}`;
    },
  })));

  // ── 工具 ③：诊断（排查"写没落盘"这类问题）────────────────────────────────
  ctx.effect(() => ctx.inject(['tools'], (tctx) => tctx.tools.register({
    name: 'dispatch_diag',
    description:
      '【诊断】只读地报告投递存储的状态：用的是域还是兜底文件、最近一次写的结果、'
      + '单子总数与各自状态，并**现场试写一笔探测记录**（写到 `misc` 表，不碰业务数据）。'
      + '用来回答"单子到底有没有落盘"。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => {
      const out = [];
      /**
       * ⚠️ **先报版本**（2026-09-30 加）。
       *
       * 今天热装了 30 多次，反复出现"**服务工具的实例是旧的**"——
       * 而我没有任何办法一眼认出来，只能靠推断（`refresh_status` 明明注册成功却调不到，
       * 就是这样查了半天的）。⇒ **诊断工具都报版本号，下次一眼就知道在跟谁说话。**
       */
      out.push(`插件版本：**${api.version ?? '?'}**（服务这次调用的就是这个实例）`);
      out.push(`存储位置：**${store.where}**（domain=平台存储域 / file=兜底文件）`);
      const lw = lastWrite;
      out.push(`最近一次写：${lw.at === null ? '（本进程还没写过）' : `${new Date(lw.at).toISOString().slice(11, 19)}Z key=${lw.key} → ${lw.ok === true ? '成功' : `**失败** ${lw.error}（code=${lw.code}）`}`}`);

      let total = 0;
      const byState = { 未取: 0, 已取: 0 };
      try {
        for (const [, rec] of listRecords(tickets)) {
          total += 1;
          if (rec?.takenBy === null || rec?.takenBy === undefined) byState.未取 += 1;
          else byState.已取 += 1;
        }
        out.push(`单子总数：${total}（未取 ${byState.未取} / 已取 ${byState.已取}）`);
      } catch (error) {
        out.push(`列单子失败：${String(error?.message ?? error)}`);
      }

      // ⭐ **现场试写** —— 这是回答"能不能写"的唯一可靠办法。
      try {
        await putTracked(store.tables.misc, '__diag__', { value: new Date().toISOString(), at: Date.now() });
        out.push('现场试写：**成功** ✅（存储可写）');
      } catch (error) {
        out.push(`现场试写：**失败** ❌ ${String(error?.message ?? error)}（code=${error?.code ?? '无'}）`);
      }
      out.push('（探测键是 `misc.__diag__` / `misc.__probe__`，不属于业务数据。）');
      return out.join('\n');
    },
  })));

  return () => { /* 工具由 ctx.effect 的 disposer 管 */ };
}
