/**
 * 跨桌投递插件 `dsh-bulletin-dispatch`
 *
 * ⭐ **架构要求（2026-09-30 明确）**：
 *   *"不用一个功能写一个插件，而是一个插件包含多个功能，我们后面开发的功能可以直接装进插件里。"*
 *   *"既然要做插件，就要做好来，不是极简也不是解决单一问题。"*
 *
 * ⇒ **一个包、多功能、配置里逐个开关**（**不要**运行时扫目录/动态 import ——
 *    平台没有热插拔，加功能一定要重装+重启，动态那点优势根本用不上；
 *    而且开关式的行为完全由"代码版本 + 配置"决定，好排查）。
 *
 * ⚠️ **每个功能都必须 fail-open**（一个包装多个功能 ⇒ 任何一个写错就是每个会话都受影响）：
 *   **读文件失败、解析失败、存储失败、平台 API 抛错 —— 一律只记日志，绝不冒泡。**
 *
 * ⚠️⚠️ **这个包现在只有 6 个功能，而且"就这些了"**（2026-09-30）：
 *   `identity`（认桌）· `sessionGc`（会话回收 —— 清掉已删除会话的记录）·
 *   `proposeRename`（提议改名）· `dispatch`（按桌投递）·
 *   `dispatchTools`（发单/看单）· `status`（给人看的状态表）。
 *
 *   ⚠️ **2026-10-01 更正**：这段原来写"**5 个**"、并列了 5 个名字 ——
 *   **而下面 `FEATURES` 里是 6 个**（`sessionGc` 被漏掉了）。**数字和名单都对不上。**
 *   ⭐ **教训**：**"总共 N 个"这种句子，要么不写，要么让它和那份名单挨着** ——
 *   分开写就一定会漂，而**它漂了多久没人知道**。
 *
 *   **开工包里的功能 3/4/5/6 全部取消或暂停**（写入护栏 / 事实表+扫副本 / 体检分发 / Codex 桥）——
 *   ⚠️ **别把这几个编号和上面那 6 个搞混**：那是**开工包里被砍掉的编号**，不是同一套。
 *   它们共用同一个模式：*"自动检测到异常 → 自动投给某张桌"*。
 *   而**投递单的价值恰在于：指针型 · 由有判断力的一方发出 · 不需要回执** ⇒
 *   **把它自动化，得到的是"更多单子"，不是"更少跨桌改动"。**
 *   决定与证据：见 `docs\05-取舍与放弃.md`
 *
 * ⚠️ **模块顶层不做会抛错的事** —— 2026-09-29 公告插件就是因为域名带连字符
 *    在模块加载时抛错，导致 **DSH 起不来**（那条正则在 `defineDomain` 里，`store.js` 已注明）。
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from 'schemastery';
import { createLog, errText } from './src/log.js';
import { DOMAIN_NAME, domainSpec, openStore, resetStoreForTest, TABLES } from './src/store.js';
import { setup as setupIdentity } from './src/features/f0-identity.js';
import { setup as setupSessionGc } from './src/features/f0b-session-gc.js';
import { setup as setupProposeRename } from './src/features/f1-propose-rename.js';
import { setup as setupDispatch } from './src/features/f2-dispatch.js';
import { setup as setupDispatchTools } from './src/features/f2b-dispatch-tools.js';
import { setup as setupStatus } from './src/features/f3-status.js';

export const name = 'bulletin-dispatch';

/**
 * ⭐ **把"留空的配置项"推导出一个默认路径**（2026-10-01 加）。
 *
 * ## 为什么需要它
 *
 * 这个插件的默认值原来是**写死的本机绝对路径**（`<作者的工作区>\…`）。
 * 那种默认值对别人**一定是错的** —— 而更糟的是：**它会安静地在别处建文件**，
 * 用户根本不知道为什么桌面上多了个目录。
 *
 * ⇒ 现在那些键**默认留空**，由这里**从 `workspaceRoot` 推导**：
 *
 * ```
 * workspaceRoot = <你的工作区>
 * statusFile    = <你的工作区>\00-通用\投递状态.md
 * ```
 *
 * ⚠️ **用反斜杠拼**（不用 `path.join`）：`path.join` 在 Windows 上给正斜杠，
 * 而这个项目的路径**全程是反斜杠** —— 混用会让日志和配置看起来像两种东西。
 */
function underRoot(workspaceRoot, ...segments) {
  const root = String(workspaceRoot ?? '').replace(/[\\/]+$/u, '');
  if (root === '') return '';
  return [root, ...segments].join('\\');
}

/** 所有依赖都走可选查找（`ctx.get`），缺了任何一个都不该让插件装不上。 */
export const inject = [];

/** 自己故意抛的错都带这个前缀 —— 便于"识别是不是我拦的"（见文件头）。 */
export const GUARD_PREFIX = '[bulletin-dispatch]';

export const Config = z.object({
  /**
   * ⭐ **办公室的根目录** —— 公告、投递状态、信箱这些都在它下面。
   *
   * ⚠️ **这个没有默认值**（2026-10-01 改的）：原来默认写死了作者本机的路径。
   * 一个不写默认值的必填项，**比一个猜错的默认值好** ——
   * 猜错的话，插件会安静地在别处建文件，而你不知道为什么。
   *
   * ## ⭐⭐ **怎么填（2026-10-01 说清了，这是最容易被误读的一条）**
   *
   * **填"这间办公室在哪"，不是"你的工作区在哪"。**
   *
   * ⚠️ **它们可以是两个完全不同的地方** ——
   * 这个插件服务的是**同一台电脑上的所有 DSH 会话**，
   * **它们的工作区可以各不相同**（一张桌在 `D:\MyGame`，另一张在 `D:\DSH_workspace`），
   * **而它们照样在同一间办公室里。**
   *
   * | 情况 | 填什么 |
   * |---|---|
   * | 几"桌"共用一个工作区 | 那个共同的上层目录 |
   * | ⭐ **各桌工作区不同** | **另找一个中立目录当办公室**（`D:\办公室` 之类）—— 它不属于任何一张桌 |
   */
  workspaceRoot: z.string()
    .description('办公室工作区根。用于路径归一与"哪些路径算办公室范围"'),

  /**
   * ⭐ **功能开关** —— 加新功能就在这里加一个键，代码里带全部功能。
   * 关掉的功能**完全不装配**（连监听器都不挂），而不是"装配了但不做事"。
   */
  features: z.object({
    identity: z.boolean().default(true).description('认桌：读会话标题的 NN- 前缀，开桌时自报身份'),
    sessionGc: z.boolean().default(true)
      .description('会话回收：把平台侧**已删除**的会话从记录里清掉（判据是 `sessionPersistence.stat()` 返回 undefined；'
        + '⚠️ 实测过：它认得"没在跑的旧会话"，不会误删历史）'),
    proposeRename: z.boolean().default(true)
      .description('提议改名：认不出桌时提议一次（**改不改由用户点头**，AI 用 set_session_title 工具改）'),
    dispatch: z.boolean().default(true)
      .description('按桌投递：单子挂在"桌"上，**谁先来谁取走**，写进系统提示（不占消息流）'),
    dispatchTools: z.boolean().default(true)
      .description('投递工具：`dispatch_ticket`（发单）与 `list_tickets`（看本桌待取）'),
    status: z.boolean().default(true)
      .description('送达状态表：生成 `00-通用\\投递状态.md`（**用户自己看的仪表盘**，派生视图）'),
    /**
     * ⚠️ **这里曾经有一个 `guard` 开关，2026-09-30 删掉了**（功能 3「写入护栏」，2026-09-30 取消）。
     *
     * **为什么删掉开关、而不是留着**：挂着一个"永远不实现的开关"本身就是误导 ——
     * 看配置的人会以为"关着而已，打开就有护栏"。**清单里没有的，就是没有的。**
     *
     * 取消的两条理由（③ 是技术事实，跟流量无关）：
     *   ① 公告（用户裁决）+ 投递单（AI 自主）两个通道已覆盖"跨桌协作"的真实需求
     *   ② 路径判据**分不清"许可的交付/部署"和"越权改动"**（路径长得一模一样）
     *      ⇒ 要么误伤交付、要么加一堆例外 ⇒ 最后没人信它
     *
     * ⚠️⚠️ **功能 4 / 5 / 6 也一并取消了**（2026-09-30，独立评审背书）——
     * 所以 `facts` / `checkup` / `codex` 这三个开关**也删了**，
     * 连它们的配置骨架（`factsFile` / `scanRoots` / `existenceRoots` / `textExtensions`）一起删。
     *
     * **三个功能是同一个东西的三个实例**：*"自动检测到异常 → 自动投给某张桌"*。
     * 而投递单的价值恰在于：**指针型、由有判断力的一方发出、不需要回执** ——
     * **把它自动化，得到的是"更多单子"，不是"更少跨桌改动"。**
     *
     * 决定与证据：见 `docs\05-取舍与放弃.md`
     */
  }).description('逐个功能的开关。关掉的功能不装配'),

  /**
   * 桌号 → 桌名。用于"办公室有哪几张桌"的提示与名字建议。
   *
   * ⚠️ **默认空**（2026-10-01）：原来这里写着作者办公室的四张真实桌名 ——
   * 那种默认值对别人**没有意义**，而且会让人以为"必须配成那样"。
   *
   * **不配也能跑**：状态表会显示成「桌 01」「桌 02」，功能一个不少。
   * **配了更好看**：认桌提示和状态表里会用你的名字。
   */
  deskNames: z.dict(z.string()).default({})
    .description('桌号 → 桌名，如 { "02": "环境维护" }。**不配也能跑**（显示成"桌 02"）'),

  /**
   * 会话回收的**节流**（毫秒）。`0` = 关掉回收（配置可关）。
   *
   * ⚠️ 为什么必须节流：判据 `sessionPersistence.stat()` 是**异步**的，
   * 每轮把全部会话查一遍不合适。默认 **10 分钟**一次 ——
   * 用户删会话那种事**不需要秒级反应**。
   */
  sweepIntervalMs: z.number().min(0).default(600_000)
    .description('会话回收的全查间隔（毫秒）。0 = 关掉回收'),

  /** 开桌时那条"报身份"的消息。`{desk}` / `{title}` 会被替换。 */
  identityNotice: z.string().default(
    '（跨桌投递：本会话认作 **{desk}** —— 从会话标题「{title}」读出来的。'
    + '本桌的投递单会送到这里。）',
  ).description('认桌成功后注入的那一句。`{desk}`=桌号、`{title}`=会话标题；留空 = 不注入'),

  /**
   * 重读标题的冷却（毫秒）。
   *
   * ⚠️ **为什么必须有这个**（2026-09-30 说明的一个硬事实）：
   *   **开新会话不能直接改名** —— 得先发一条消息、产生真实会话，**然后**才能手动改。
   *   ⇒ "平台先给自动标题、用户后改名"是**必然顺序**，不是偶发。
   *   ⇒ 所以"没认出桌"的会话必须允许**重读**，否则永远认在自动标题上（如「打招呼问候」）。
   *
   * 冷却只是防止每步都读（`readTitle` 有成本）。`0` = 每步都读（最灵敏、最费）。
   */
  recheckMs: z.number().default(10_000)
    .description('没认出桌时，隔多久重读一次标题。0 = 每步都读'),

  /** 状态持久化的兜底文件（域打不开时用；域正常时也可能被读来做并集）。 */
  stateFile: z.string().default('')
    .description('状态文件（**这是权威存储**）。留空 = 用 DSH 家目录的 storages\\bulletin_dispatch_state.json'),

  /**
   * 是否**额外**把状态镜像一份到平台存储域。
   *
   * ⚠️ **默认关**（2026-09-30 后实测决定的）：
   * 平台存储域在这个环境里**打开成功、写却不落盘、也不报错**（证据见 `进度与待办.md` 二之八之七），
   * 而文件存储**真的能写**。⇒ 文件是唯一权威；域镜像只是可选的额外备份，
   * **默认关掉它，让主路径彻底不受域影响。**
   */
  mirrorToDomain: z.boolean().default(false)
    .description('额外把状态镜像到平台存储域（默认关；域在这个环境里写不落盘）'),

  /**
   * ⚠️⚠️ **这里曾经有 4 个"功能 4 用"的配置骨架，2026-09-30 一起删了**：
   * `factsFile` / `scanRoots` / `existenceRoots` / `textExtensions`。
   *
   * **为什么删**：功能 4 已取消（2026-09-30）⇒ **留着这些键就是"挂着一个永远不实现的开关"**，
   * 而那个先例是我们自己在功能 3 上立的（见 `features` 那段长注释）。
   * **看配置的人会以为"骨架都在，只差实现"** —— 那是误导。
   *
   * 要用的那天再写回来（成本很低：事实表就 8 行、扫描判据也已经实测过，
   * 证据都在 `docs\05-取舍与放弃.md`）。
   */

  /**
   * ⚠️ **这里曾经有一个 `ticketsFile`（默认 `00-通用\投递.jsonl`），2026-09-30 删掉了。**
   *
   * 它是**功能 2 早期设计的残留**：那时打算把单子存成一个 JSONL 文件。
   * 实际实现走的是**存储层**（文件 `harness\storages\bulletin_dispatch_state.json`，
   * 表 `tickets` / `claims` / `sessions` / `misc`）——
   * ⇒ 那个键**从未被读过一次**，而它指的 `投递.jsonl` **在磁盘上根本不存在**。
   *
   * **⇒ 删掉**，理由与"取消的功能不留空开关"同一条（见 `features` 那段长注释）：
   * **挂着一个永远不生效的键，会让读配置的人以为"单子存在那个文件里"。**
   * （这个键是 2026-09-30 办公室体检发现的 —— 见 `00-通用\办公室体检\体检报告-20260930.md`。）
   */

  /**
   * 状态表输出到哪（功能 1）。
   *
   * ⚠️ **默认值由 `workspaceRoot` 推导**（2026-10-01）：
   * 原来是写死的作者本机路径 —— 那种默认值对别人**一定是错的**，
   * 而错了之后它会**安静地生成在别处**。
   * ⇒ 现在**留空就推导**：`<workspaceRoot>\00-通用\投递状态.md`。
   */
  statusFile: z.string().default('')
    .description('人看的送达状态表（插件自动生成，不要手改）。留空 = <工作区>\\00-通用\\投递状态.md'),

  /**
   * 诊断日志（JSONL）。**留空 = 关闭**。
   *
   * ⚠️ 默认值也改成空了（2026-10-01）：原来写死作者本机的 `tmp\…`。
   * **一个"默认就会写日志"的插件，会在别人机器上到处留文件。**
   */
  debugLog: z.string().default('')
    .description('诊断日志。留空 = 关闭（排查时才有用）'),
});

/** 功能装配表：**加新功能 = 加一个 features/fN-*.js + 这里加一行 + 配置加一个开关**。 */
const FEATURES = [
  { key: 'identity', title: '认桌（骨架）', setup: setupIdentity },
  { key: 'sessionGc', title: '会话回收（清掉已删除的会话记录）', setup: setupSessionGc },
  { key: 'proposeRename', title: '提议改名（用户点头才改）', setup: setupProposeRename },
  { key: 'dispatch', title: '按桌投递（谁先来谁取走）', setup: setupDispatch },
  { key: 'dispatchTools', title: '投递工具（发单 / 看本桌待取）', setup: setupDispatchTools },
  { key: 'status', title: '送达状态表（给人看的仪表盘）', setup: setupStatus, needsStatus: true },
];

/**
 * 版本号：**读真的 package.json**。
 *
 * 2026-09-29 两次因为"装的是新版、跑的是旧版"白查半天 ⇒
 * **日志里没有版本号就无法自证**，所以挂载时自报版本。
 * 用 `import.meta.url` 定位：装好之后 `index.js` 与 `package.json` 同目录。
 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(`${dirname(fileURLToPath(import.meta.url))}/package.json`, 'utf8')).version ?? 'unknown';
  } catch { return 'unknown'; }
})();

export function apply(ctx, config) {
  /**
   * 把留空的键推导成实际路径 —— **必须在建 log 之前做**（log 也要读 `debugLog`）。
   * ⚠️ 不直接改 `config`（那是框架的对象）⇒ 复制一份再填。
   */
  config = {
    ...config,
    statusFile: config.statusFile !== '' && config.statusFile !== undefined
      ? config.statusFile
      : underRoot(config.workspaceRoot, '00-通用', '投递状态.md'),
  };

  const { log, warn, problems } = createLog({ logPath: config.debugLog, tag: name });

  const enabled = Object.entries(config.features ?? {})
    .filter(([, on]) => on === true)
    .map(([k]) => k);

  log(`已挂载 v${PLUGIN_VERSION}`, {
    version: PLUGIN_VERSION,
    featuresEnabled: enabled,
    featuresAll: Object.keys(config.features ?? {}),
    workspaceRoot: config.workspaceRoot,
  });

  // 共享运行环境：每个功能拿到的是同一份 log / store / config。
  const api = { ctx, config, log, warn, problems, store: undefined, version: PLUGIN_VERSION };

  /**
   * ⭐⭐ **用 `inject` 拿存储，而不是 `ctx.get`**（2026-09-30 实测纠正）。
   *
   * ## 失败现场
   *
   * 原来在 `apply()` 里调 `ctx.get('storageDomain')`，**热重载后连续 7 次挂载每次都取不到**，
   * 全退回了兜底文件存储。加了探针一看：
   *
   * ```
   * probe: storageDomain=无 storage=无 sessionQuery=无
   * ```
   *
   * **不只 `storageDomain`，连我确认能用的 `sessionQuery` 也是"无"** ⇒
   * **`ctx.get` 在"插件刚挂载那一刻"根本不可靠** —— 那些服务是**之后**才挂到 ctx 上的。
   *
   * ## 为什么 `inject` 能解决
   *
   * 官方契约（`cordis_inspect` 的 Service 表里写着）：
   *   `hardDependency: { inject: ['storageDomain'], expression: 'ctx.storageDomain' }`
   * ⇒ **`inject` 就是"让框架保证依赖可用之后再叫我"**。
   * 用 `ctx.inject(['storageDomain'], cb)` 包起来 ⇒ **回调触发时服务一定在**。
   *
   * ⚠️ 这同时解释了 2026-09-29 那次"`storageDomain` 缺失"的误判 ——
   * **根本原因就是查得太早**，只是当时靠"懒打开"绕了过去，没找到这一层。
   */
  const storeReady = new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      ctx.inject(['storageDomain'], (sctx) => {
        void openStore(sctx, {
          file: config.stateFile !== '' ? config.stateFile : undefined,
          log,
          warn,
          mirrorToDomain: config.mirrorToDomain === true,
        }).then(done, (error) => {
          warn('存储打开失败（功能会用不了，但会话不受影响）', { error: errText(error) });
          done(undefined);
        });
      });
      /**
       * 兜底：万一 `inject` 永远不触发（服务确实不在），
       * **别让功能永远等不到存储**（那会导致"装上了但什么都不做"这种最难查的状态）。
       *
       * ⚠️⚠️ **`ctx.setTimeout` 不能"读一下看看在不在"**（2026-09-30 实测）：
       * 平台 ctx 用 getter 实现它，**读那个属性本身就会抛**
       * `Error: cannot get property "timer" without inject`
       * ⇒ 我原来写的 `typeof ctx.setTimeout === 'function'` **拦不住**（读的时候已经炸了），
       * 而那次异常被外层 `catch` 吞掉 ⇒ **兜底计时器根本没设上**。
       * ⇒ 现在：**用 try/catch 包住那次读取**，读不到就用全局 `setTimeout`。
       */
      const later = (() => {
        try {
          if (typeof ctx.setTimeout === 'function') return (fn, ms) => ctx.setTimeout(fn, ms);
        } catch { /* 读它就抛 ⇒ 用全局的 */ }
        return (fn, ms) => setTimeout(fn, ms);
      })();
      later(() => {
        if (settled) return;
        log('等存储域超时（10 秒）—— 改用兜底文件存储装配功能', {});
        void openStore(ctx, { file: config.stateFile !== '' ? config.stateFile : undefined, log, warn })
          .then(done, () => done(undefined));
      }, 10_000);
    } catch (error) {
      warn('inject(storageDomain) 失败 —— 改用兜底文件存储', { error: errText(error) });
      void openStore(ctx, { file: config.stateFile !== '' ? config.stateFile : undefined, log, warn })
        .then(done, () => done(undefined));
    }
  });

  const ensureStore = () => storeReady;

  /**
   * ⭐ **"状态变了"的通知口**（功能 1 用）。
   *
   * 谁变谁喊一声（发单 / 取走 / 认桌改名），由状态表决定**怎么写、写几次**
   * —— 这样投递那边**不需要知道仪表盘的存在**，耦合是单向的。
   * 功能 1 没开时这里就是空操作（fail-open）。
   */
  let statusApi;
  const onStateChanged = (reason) => {
    try { statusApi?.request?.(reason); } catch { /* 仪表盘的问题绝不影响投递 */ }
  };

  for (const feature of FEATURES) {
    if (config.features?.[feature.key] !== true) {
      log('功能未开启，跳过装配', { feature: feature.key, title: feature.title });
      continue;
    }
    try {
      // 需要"状态变了"通知的功能，把口子接过去（**单向往外喊**）。
      const extra = feature.needsStatus === true ? {} : { onStateChanged };
      // 功能等存储就位再装配。
      void ensureStore().then((store) => {
        if (store === undefined) {
          warn('存储不可用，该功能本次不装配', { feature: feature.key });
          return;
        }
        try {
          const built = feature.setup({ ...api, store, ...extra });
          if (feature.needsStatus === true) {
            statusApi = built;
            // 装配完先出一次 —— 否则新装的仪表盘要等到"下一次状态变化"才有内容。
            built?.generateNow?.('装配');
          }
          log('功能已装配', { feature: feature.key, title: feature.title, store: store.where });
        } catch (error) {
          warn(`功能装配失败（已忽略）：${feature.title}`, { feature: feature.key, error: errText(error) });
        }
      });
    } catch (error) {
      // 一个功能装不上，绝不能影响别的功能，更不能影响插件挂载。
      warn(`功能装配抛错（已忽略）：${feature.title}`, { feature: feature.key, error: errText(error) });
    }
  }

  /**
   * ⭐ **卸载留痕**（0.1.3 加）。
   *
   * 为什么需要：2026-09-30 排查"认桌没生效"时，**分不清到底是**
   *   （a）处理器根本没被调用，还是（b）被调用了但判定不用重读。
   * 有了这行，日志里就能看出"某个版本是不是被静默卸载了"。
   */
  ctx.effect(() => () => {
    log('已卸载', { version: PLUGIN_VERSION });
    /**
     * ⚠️⚠️ **刻意不 `close()` 存储域**（2026-09-30 实测，代价是丢了两张真单子）。
     *
     * ## 失败现场
     *
     * 12:50:56 与 12:53:54 两条 `投递/已发单` 都正常返回，**但介质里 `tickets: 0 条`**。
     * 而 12:56:12 又有一次热挂载 ⇒ **旧实例卸载时把域 `close()` 了**，
     * 那两条 `put` 还在**写链**里没落盘，**一起没了**。
     *
     * ## 为什么不该由我关
     *
     * `storageDomain` 是**全局单例**（同名域只能开一次，再开报 `already-open`），
     * 而这个实例只是"当前用它的插件实例之一"。**为了我自己的热重载，
     * 去关掉一个别人（包括我自己的下一个实例）还要用的共享资源 —— 这是我的错。**
     *
     * ⇒ 由**平台**在真正卸载时关闭（`dsh-storage-domain` 官方契约：
     *   *"Domains still open when the facility unmounts are closed by the plugin disposer"*）。
     * ⇒ 我这边只留痕。**代价是热重载期间会短暂出现"域已被旧实例打开"**，
     *   那时新实例退回兜底存储 —— **可以接受**（重启后一切归位），
     *   **总比丢数据好。**
     */
  });
}

/**
 * 供**装机前验证**用的导出（不导出就无法断言"域版本 / 兼容声明"这类契约）。
 *
 * ⚠️ 两个注意：
 *   ① 平台不会读它 —— 只是把内部事实露给**仓库外那套自测**里的装机前验证用
 *      （⚠️ **那套自测没有随本仓库发布**，见 `docs\05` 末尾那段）；
 *   ② **必须放在文件末尾** —— 放前面会因为读 `PLUGIN_VERSION` 撞上"临时死区"
 *      （`Cannot access 'PLUGIN_VERSION' before initialization`，实测踩到过）。
 */
export const __test = {
  domainName: DOMAIN_NAME,
  domainSpec,
  tables: TABLES,
  version: PLUGIN_VERSION,
  /** 仅供自测：清掉域句柄缓存（模块级状态会跨场景）。 */
  resetStoreForTest,
};
