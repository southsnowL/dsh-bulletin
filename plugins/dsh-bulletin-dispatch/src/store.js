/**
 * 状态存储：**平台存储域优先，插件自己的文件兜底，读的时候取并集**。
 *
 * 为什么不是"只用存储域"（2026-09-29 的实战教训）：
 *   域**曾经静默打不开**（原因是表 schema 用错了 zod 导入 ⇒ 平台校验失败 ⇒ 域每次 open 都抛
 *   `invalid-record`），那时游标只能待在内存 ⇒ **每次重启都重发**。
 *   ⇒ 所以兜底文件不是多余的：**域坏了，功能也得活着**（fail-open 的一部分）。
 *
 * ⚠️ 两条硬约束：
 *   ① **域名/表名必须匹配 `/^[a-z][a-z0-9_]*$/`（不能有连字符）** ——
 *      `defineDomain` 在**模块加载时**就校验，不合法会让 **DSH 起不来**（2026-09-29 真炸过）。
 *   ② 域的表 schema 用 **zod**，而且必须 **`import { z } from 'zod'`（命名导入）** ——
 *      `import z from 'zod'` 拿到的是模块命名空间，造出来的 schema **没有 `parse`**。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z as zod } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { errText, safe } from './log.js';

/** ⚠️ 正则 `/^[a-z][a-z0-9_]*$/` —— **横杠不合法**。 */
export const DOMAIN_NAME = 'bulletin_dispatch';
/**
 * 域版本。
 *
 * ⚠️⚠️ **踩过一个大坑：不要为了"加个可选字段"就升版本**（2026-09-30，代价是所有写都被拒）。
 *
 * ## 失败现场
 *
 * 我给 `tickets` 表加字段时把版本从 1 升到 2，并声明 `compatibleVersions: [1]`，
 * 以为"向后兼容"就没事。日志里的真相：
 *
 * ```
 * 存储域已打开（优先用它） v=2                    ← 看起来成功
 * …但介质永远是 v1、一条新记录都写不进去
 * warn  err=StorageError: unit 'bulletin_dispatch': stored version 1 != expected 2
 *       code=version-mismatch
 * ```
 *
 * **⇒ `compatibleVersions` 只让"读"通过，不让"写"** ——
 * 后端在**每次写入**时都比对 `stored version == descriptor.version`，不等就拒。
 * 于是表现为"打开成功、每次写静默失败"（而我当时还没 `await` 那个 Promise，连错都看不到）。
 *
 * ## ⇒ 正确做法
 *
 * **版本是格式契约；加"可选字段"不构成新格式** ——
 * 旧记录用 `zod.optional()` / `.default()` 照样校验得通，**不该升版本**
 * （见 `sessionSchema.turn`、`ticketSchema.takenBy` 的注释）。
 * **只有真的不兼容时**（老记录按新 schema 必然校验失败）才升版本，
 * 那时该做的是**迁移**，而不是声明"我读得懂"。
 */
export const DOMAIN_VERSION = 1;

/** 表名（同样受那条正则约束）。 */
export const TABLES = {
  /** `sessionId -> { desk, title, at }` —— ⚠️ **这是缓存不是权威**，标题能被用户改。 */
  sessions: 'sessions',
  /** `单子id -> { id, desk, ptr, status, at, from }` —— 投递单。 */
  tickets: 'tickets',
  /**
   * `${sessionId}|${ticketId} -> { at }` —— 已送记录（**按会话+单子，不是按会话**）。
   *
   * ⚠️ 分隔符用 `|`（原来写的是 `\u0000`）—— 虽然这一列从不显示到任何文本里，
   * 但**统一用可打印字符**能免掉一整类麻烦（见 `sanitizeText` 那段）。
   */
  sent: 'sent',
  /**
   * `取走时间戳|单号 -> { ticketId, desk, by, at }` —— **取走历史**。
   *
   * 为什么单独一张表（2026-09-30 加，用户要"最近的取走记录"）：
   * `tickets` 表里只有"**当前**被谁取走"，而**单子可能被删/被重投** ——
   * 那时"曾经谁取过"就查不到了。历史要单独留一份。
   *
   * ⚠️ **有界**：只留最近 `CLAIMS_KEEP` 条（见 `pruneClaims`），
   * 否则这张表会一直长（每取一次多一行，永不回收）。
   */
  claims: 'claims',
  /** `key -> { value, at }` —— 杂项（最后一次 pre-step 等派生信息）。 */
  misc: 'misc',
};

/** 取走历史最多留多少条（**必须有界** —— 它天然只增不减）。 */
export const CLAIMS_KEEP = 50;

const sessionSchema = zod.object({
  /**
   * 会话 id 的**副本**。
   *
   * ⚠️ 可选（老记录没有）：`sessions` 表的 key 就是它，但**遍历时拿不到 key**
   * （`listRecords` 给的是 `[key, value]`，而渲染状态表的地方只传了 value）
   * ⇒ 存一份副本最省事。这是 2026-09-30 实测补的（渲染出来"会话 = —"）。
   */
  sessionId: zod.string().optional(),
  desk: zod.string(),
  title: zod.string(),
  at: zod.number(),
  /**
   * 上次读标题时所在的 turn（**判断"是不是新的一轮"用它**）。
   *
   * ⚠️ 可选：老记录（`0.2.0` 之前写的）没有这个字段，读出来是 `undefined` ——
   * 那正好被当成"还没在某个 turn 里检查过"，于是下一轮会重读。**兼容是免费的。**
   */
  turn: zod.number().optional(),
});
const ticketSchema = zod.object({
  id: zod.string(),
  /** 目标桌：两位数字（`'02'`）或 `'办公室'`。 */
  desk: zod.string(),
  /**
   * 一句话说清是什么（**指针型**：内容本体留在文档里，见 `ptr`）。
   *
   * ⚠️ **有默认值是为了"老记录仍然校验通过"** —— 这正是**能不升域版本**的前提
   * （升版本会让后端**拒绝所有写**，见 `DOMAIN_VERSION` 的注释）。
   */
  summary: zod.string().default(''),
  /** 指向哪里（文件/目录路径）。 */
  ptr: zod.string(),
  /** 来自哪张桌（`'04'` 或 `'办公室'`）。老记录叫 `from`，没有这个字段。 */
  source: zod.string().default('办公室'),
  at: zod.number(),
  /**
   * 被哪个会话取走了；`null` = 还没人取。
   *
   * ⚠️ **这就是"谁先来谁取走"的全部实现**（2026-09-30 ）：
   *   · 单子挂在**桌**这一层（`desk`），**不是挂在会话上**
   *   · 同一个桌的**任何一个会话**，谁先跑到就谁取走
   *   · 取走之后**同桌别的会话看不到** ⇒ **不会重复干活**
   *   · 压缩不改变会话号 ⇒ 不会重复送；**新会话也能取没被取走的**
   */
  takenBy: zod.string().nullable().default(null),
  /** 取走时间。 */
  takenAt: zod.number().optional(),
});
const sentSchema = zod.object({ at: zod.number() });
const miscSchema = zod.object({ value: zod.string(), at: zod.number() });
/** 取走历史的一条。字段带默认值 ⇒ **老记录/缺字段也能校验通过**（不用升域版本）。 */
const claimSchema = zod.object({
  ticketId: zod.string().default(''),
  desk: zod.string().default(''),
  /** 取走的会话 id。 */
  by: zod.string().default(''),
  /** 那一句话（**留个副本**：单子以后可能被删，历史里还看得见它是什么）。 */
  summary: zod.string().default(''),
  at: zod.number(),
});

/** 域声明。**表名/域名都在模块顶层校验** —— 不合法这里就抛，DSH 起不来。 */
export const domainSpec = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  /**
   * ⚠️ **不再声明 `compatibleVersions`**（曾经写过 `[1]`，但那条路是错的）：
   * 它只让**读**通过，**写仍会被后端以 `version-mismatch` 拒绝** ⇒
   * 表现为"打开成功、每次写静默失败"（2026-09-30 实测，所有写都丢了）。
   * **⇒ 正确做法是根本不升版本**（加可选字段不是新格式），见 `DOMAIN_VERSION` 的注释。
   */
  /**
   * ⚠️ **万一还有读不懂的记录：挪到一边并跳过，而不是让整个域打不开。**
   * 域打不开 ⇒ 功能整体退化（`0.1.x` 那次"游标静默失效"就是这么来的）。
   */
  invalidRecords: 'backup-and-skip',
  tables: {
    [TABLES.sessions]: domainTable(sessionSchema),
    [TABLES.tickets]: domainTable(ticketSchema),
    [TABLES.sent]: domainTable(sentSchema),
    [TABLES.claims]: domainTable(claimSchema),
    [TABLES.misc]: domainTable(miscSchema),
  },
});

/**
 * **一份文件 = 一份共享文档**（2026-09-30 重写，修两个会**静默丢数据**的真 bug）。
 *
 * ## 原来的两个缺陷（实测踩到）
 *
 * | # | 缺陷 | 后果 |
 * |---|---|---|
 * | **1** | **每张表各自缓存自己的 doc**（`sessions` / `tickets` / `misc` 各一份），而 `persist()` 只写 `{ [tableName]: doc }` | 写 A 表时文件里**只剩 A 表** ⇒ **其它表整个被抹掉** |
 * | **2** | 只读一次就永远用内存快照 | 别人（另一个实例）改过文件后**看不见** ⇒ 写回时**覆盖掉人家的改动** |
 *
 * ⇒ 现象正是我遇到的：写一笔 `misc` 探针，**刚发出去的单子就没了**。
 *
 * ## 现在的做法
 *
 * · 同一文件下**所有表共用一份文档**，一次读、一次写（**所有表一起写回**）；
 * · 读之前看 **mtime + size**，**变了就重新加载** ⇒ 别人的改动看得见；
 * · "读-改-写"**同步**完成（单进程内不会交错）。
 */
const FILE_DOCS = new Map();

function fileDocEntry(file) {
  let entry = FILE_DOCS.get(file);
  if (entry === undefined) {
    entry = { doc: undefined, mtime: -1, size: -1 };
    FILE_DOCS.set(file, entry);
  }
  return entry;
}

/** 读整份文档；**文件被改过就重新加载**。 */
function loadDoc(file) {
  const entry = fileDocEntry(file);
  try {
    if (!existsSync(file)) {
      // 文件被删了 ⇒ 丢弃内存快照（否则会"复活"已删内容）
      if (entry.mtime !== -1) { entry.doc = {}; entry.mtime = -1; entry.size = -1; }
      entry.doc ??= {};
      return entry.doc;
    }
    const st = statSync(file);
    if (entry.doc !== undefined && entry.mtime === st.mtimeMs && entry.size === st.size) {
      return entry.doc;                       // 没人动过 ⇒ 用缓存的
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    entry.doc = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    entry.mtime = st.mtimeMs;
    entry.size = st.size;
    return entry.doc;
  } catch (error) {
    return handleUnreadable(file, entry, error);
  }
}

/**
 * ## ⚠️⚠️ **读不懂存储文件时怎么办**（2026-10-01 加 —— 原来这里就是一个 `catch { return {} }`）
 *
 * ### 为什么"返回空文档"是灾难
 *
 * 这个文件是**权威存储**（单子 / 取走记录 / 会话表**全在里面**）。
 * 原来解析失败时**静默返回 `{}`** ⇒ 上层以为"办公室还没开始用过" ⇒
 * **下一次 `put` 就把整个文件覆盖成只剩新写的那一条** ⇒
 * **所有历史悄无声息地没了。**
 *
 * **⚠️ 这正好踩了我们自己写的两条**：
 * - `docs\06 习惯二`：**"静默的防护，看起来像坏了"** —— 而这里更糟，**它会把数据真的弄坏**
 * - `docs\04 §八`：**"要覆盖一个文件，正确做法是原子写"**
 *
 * ### 现在的做法
 *
 * 1. ⭐ **把坏文件改名留档**（`<file>.corrupt-<时间戳>`）——
 *    **数据可能还能人工救回来，绝不能让它被下一次写覆盖**
 * 2. ⭐ **记进 `lastFileError`**（诊断工具会把它报出来）
 * 3. **返回空文档**（fail-open：办公室还能用，只是这一轮没有历史）
 *
 * **⇒ 跳过可以，但必须让人知道跳过了什么。**
 */
function handleUnreadable(file, entry, error) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backup = `${file}.corrupt-${stamp}`;
  let moved = false;
  try {
    renameSync(file, backup);        // 挪走 ⇒ 后面的写不会覆盖它
    moved = true;
  } catch { /* 挪不走也不能让插件起不来 */ }
  Object.assign(lastFileError, {
    at: Date.now(),
    file,
    error: `读不懂存储文件（${errText(error)}）`
      + (moved ? ` —— 已挪到 \`${backup}\` 留档，**没有覆盖它**`
        : ' —— ⚠️ **挪走失败，下一次写会覆盖它！**'),
  });
  entry.doc = {};
  entry.mtime = -1;
  entry.size = -1;
  return entry.doc;
}

/** 文件写失败时的最后一条错误（诊断用）。**绝不许假装成功。** */
export const lastFileError = { at: null, error: null, file: null };

/**
 * 写回整份文档（**所有表一起**），并刷新 mtime/size。
 *
 * ## ⚠️ 用**原子写**（2026-10-01 改的 —— 原来是裸 `writeFileSync`）
 *
 * ### 踩到什么
 *
 * 这个文件是**权威存储**（不是可选的镜像）：单子、取走记录、会话表**全在里面**。
 * 而它原来是**直接覆盖写**：
 *
 * ```
 * writeFileSync(file, JSON.stringify(doc))
 * ```
 *
 * ⇒ **写到一半被打断**（崩溃 / 强杀 / 断电）⇒ **文件半截** ⇒
 * 下次读的时候 `JSON.parse` 失败 ⇒ 而 `loadDoc` 那个 `catch` **静默返回 `{}`**
 * ⇒ **所有单子和取走记录悄无声息地消失**，界面上就像"办公室还没开始用过"。
 *
 * **⚠️ 这同时违反了我们自己写的两条**：
 * - `docs\04 §八`：**"要覆盖一个文件，正确做法是原子写"**
 * - `docs\06 习惯二`：**"凡是跳过，都要留痕"**
 *
 * ### 修法
 *
 * **先写 `.tmp` 再 `rename`** —— 读者永远看不到半截文件。
 * （和 `writeTextFile`、面板的 `writeAtomic` 同一个套路。）
 *
 * ⚠️ **失败照样抛**（2026-09-30 那条教训不动）：
 * 这里必须如实抛，让调用方记下"这次真的失败了"——
 * **`catch {}` 吞掉写失败，正是"工具回执成功、磁盘上什么都没有"那个 bug。**
 */
function saveDoc(file, doc) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);          // 原子替换：读者要么看到旧的、要么看到新的
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 清理失败就算了 */ }
    throw error;
  }
  const st = statSync(file);
  const entry = fileDocEntry(file);
  entry.doc = doc;
  entry.mtime = st.mtimeMs;
  entry.size = st.size;
}

/**
 * 文件里的一张表（与域的表同接口：`get` / `put` / `delete` / `entries` / `keys`）。
 *
 * ⚠️ **必须能"列全部"**：原来只有 `get/put/delete` ⇒ 退回文件存储时
 * `list_tickets` 直接报 `entries is not a function`，**投递整个不可用**。
 */
function fileTable(file, tableName) {
  const tableOf = (doc) => {
    const t = doc[tableName];
    if (t !== null && typeof t === 'object' && !Array.isArray(t)) return t;
    doc[tableName] = {};
    return doc[tableName];
  };
  return {
    get: (key) => tableOf(loadDoc(file))[key],
    /**
     * ## ⚠️⚠️ **写失败必须抛出去**（2026-10-01 改的 —— 原来是 `catch` 掉只记不报）
     *
     * ### 失败现场（Claude 复查时**真的跑出来的**）
     *
     * 它把状态文件指到一个写不进去的路径上，然后：
     *
     * | 谁 | 报告 |
     * |---|---|
     * | `dispatch_ticket` | ✅ 成功，回执"**已投给 桌 01**" |
     * | 诊断工具的"最近一次写" | ✅ 成功 |
     * | **磁盘上** | ❌ **根本没有这个文件** |
     *
     * **⇒ 单子只活在内存里，一重启就没了** —— 而这正是 `docs\06` 写的那个
     * **"工具回执成功、磁盘上什么都没有"**，我们以为自己早就修掉了。
     *
     * ### 根因
     *
     * 原来这里是 `catch { lastFileError = … }` —— **fail-open，而且不告诉任何人。**
     * 注释里写着*"`dispatch_diag` 会报出来"*，**而那个工具不存在，
     * 整个仓库也没有任何一处读 `lastFileError`**（我实测：写 3 处、读 0 处）。
     *
     * ### 现在
     *
     * **直接抛。** 调用方（`putTracked` → 各工具）本来就有 `try/catch`，
     * 它们会把失败**如实说给用户听**（"本次投递未生效"）。
     *
     * ⚠️ **这和"fail-open"不矛盾**：fail-open 说的是
     * *"存储坏了不能让会话用不了"* —— 那是**上层**该决定的事
     * （工具报错但插件照常活着）。**而这一层撒谎，上层就没法做那个决定。**
     *
     * > **存储层的职责是"如实"，不是"体贴"。**
     */
    put: (key, value) => {
      const doc = loadDoc(file);
      tableOf(doc)[key] = value;
      try {
        saveDoc(file, doc);                    // ⭐ 写回**整份**文档（所有表一起）
      } catch (error) {
        /** ⚠️ 仍然记一份（诊断用），**但绝不吞掉**。 */
        Object.assign(lastFileError, { at: Date.now(), error: errText(error), file });
        throw error;
      }
    },
    /**
     * ⚠️ **`delete` 这里仍然是"记了不抛"**（2026-10-01 只改了 `put`）——
     * 这是**有意的**，不是漏掉：删除失败的后果是"多留了一行记录"，
     * 而 `put` 失败的后果是**"用户以为存了，其实没有"**。**两者不对称。**
     * （**如果哪天要改，请先想清楚"多留一行"和"少存一条"哪个更糟。**）
     */
    delete: (key) => {
      const doc = loadDoc(file);
      const t = tableOf(doc);
      const had = Object.prototype.hasOwnProperty.call(t, key);
      if (had) {
        delete t[key];
        try { saveDoc(file, doc); } catch (error) {
          Object.assign(lastFileError, { at: Date.now(), error: errText(error), file });
        }
      }
      return had;
    },
    entries: () => Object.entries(tableOf(loadDoc(file)))[Symbol.iterator](),
    keys: () => Object.keys(tableOf(loadDoc(file)))[Symbol.iterator](),
    get size() { return Object.keys(tableOf(loadDoc(file))).length; },
  };
}

/** 域句柄的**跨实例缓存**（键 = 域名）。见下面 `openDomainHandle` 的说明。 */
const HANDLE_CACHE = new Map();

/**
 * 把**控制字符**换成可见形式（写纯文本文件前必须过一遍）。
 *
 * ⚠️ **为什么必须有**（2026-09-30 实测，状态表因此整份读不出来）：
 * 我在 key 里用 `` `${at}\u0000${id}` `` 当分隔符 —— 而 **`\u0000` 在 JS 里
 * 就是一个真的 NUL 字符**（不是"反斜杠 + u0000"那几个字符）。
 * 日志走 JSON 会被转义成 `\u0000`，**没事**；但状态表是**纯文本、原样写出**
 * ⇒ **NUL 直接落进 `.md`** ⇒ 读文件的工具判定"这是二进制文件"，**整份表打不开**。
 *
 * ⇒ 一律转成可见写法：**写出去的文本里不许有裸控制字符**。
 * （NUL 尤其要命：它是"二进制文件"的判定依据，编辑器/读工具都会因此罢工。）
 */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/\u0000/gu, '\\0')                                    // NUL → 可见的 \0
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '·');  // 其余 C0（保留 \t \n）
}

/**
 * 写一个**纯文本文件**（原子替换：先写临时文件再改名）。
 *
 * ⚠️ **失败会抛**（不许假装成功 —— 这是今晚反复踩的那个模式）。
 * 主存储那边需要 fail-open 的话，**由它自己**决定吞。
 *
 * ## ⚠️⚠️ `file` 为空 ⇒ **抛错，不写**（2026-10-01 实测踩到）
 *
 * 这段是**原子写**：先写 `${file}.tmp`、再 `renameSync` 到 `file`。
 *
 * ⇒ **`file` 是空串时**：临时文件成了 `.tmp`，`renameSync('.tmp', '')` **失败**
 * ⇒ **一个 9 KB 的 `.tmp` 留在进程的 cwd 里**。
 * 我们在**工作区根**和**仓库文件夹**里各发现一个 —— **没人知道是谁建的，也没人敢删。**
 *
 * ⇒ 所以在这里**挡住**：**路径不合法就当场抛**，别在别人磁盘上留无主文件。
 * （状态表那边另有一道更早的闸：`statusFile` 为空就整个不装配，见 `f3-status.js`。）
 *
 * @param {string} file 目标路径
 * @param {string} text 文件内容（**内部会消毒控制字符**）
 */
export function writeTextFile(file, text) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('writeTextFile：目标路径是空的 —— 拒绝写（否则会留下一个叫 ".tmp" 的无主文件）');
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, sanitizeText(text), 'utf8');
  renameSync(tmp, file);            // 原子替换：读者永远看不到半截文件
  return statSync(file).mtimeMs;
}

/** 读一个纯文本文件（读不到给 `undefined`）。 */
export function readTextFile(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * **最近一次域写的结果**（诊断用）。
 *
 * ⚠️ 为什么要记：2026-09-30 出现"`put` 看起来成功、但介质根本没变"的静默失败，
 * 而日志里**什么错都没有** —— 因为没人把结果记下来。
 * ⇒ 现在每次写都留痕（成功/失败 + 错误 + code），并可由 `dispatch_diag` 工具读出来。
 */
export const lastWrite = { at: null, key: null, ok: null, error: null, code: null };

/** 包一层：写并记录结果（**不吞错**，调用方仍能拿到拒绝）。 */
export async function putTracked(table, key, value) {
  try {
    await table.put(key, value);
    Object.assign(lastWrite, { at: Date.now(), key, ok: true, error: null, code: null });
    return true;
  } catch (error) {
    Object.assign(lastWrite, {
      at: Date.now(), key, ok: false,
      error: String(error?.message ?? error), code: error?.code ?? null,
    });
    throw error;
  }
}

/**
 * ⚠️ **仅供自测**：清掉域句柄缓存。
 *
 * 和 `f2-dispatch.js` 的 `resetForTest` 同一个道理 —— 缓存是**模块级**的，
 * 自测在同一个进程里跑多个场景 ⇒ 不清会让后一个场景"看到域已经开着"（实测误报过 2 条）。
 */
export function resetStoreForTest() {
  HANDLE_CACHE.clear();
}

/**
 * 拿到**活着的**域句柄：先看缓存，缓存里的还能用就直接复用。
 *
 * ⚠️⚠️ **为什么必须这样**（2026-09-30 实测，代价是丢了两张真单子）：
 *
 * 失败现场：12:50:56 与 12:53:54 两条 `投递/已发单` 都正常返回，
 * **但介质里 `tickets: 0 条`** —— 因为期间热重载了 **6 次**，每次新实例都
 * **重新 `open()` 一个新域**，而旧实例卸载时又把它 `close()` 了 ⇒
 * **那两条 `put` 还在写链里没落盘，跟着域一起没了。**
 *
 * ⇒ 缓存句柄之后：**热重载不再重开域**，后面的实例直接复用同一个活着的域，
 *   `already-open` 也不会出现，写链不会被切断。
 *
 * ⚠️ **不缓存 `close()` 的后果**：句柄会一直活到进程结束。
 *   对"办公室级"的小域来说这是**正确的** —— 它本来就该是进程级的共享状态。
 */
async function openDomainHandle(facility, log = () => {}, warn = () => {}) {
  const key = DOMAIN_NAME;
  const cached = HANDLE_CACHE.get(key);
  if (cached !== undefined) {
    /**
     * ⚠️ 探活必须**探"能不能写"**，不能只看 `table()` 在不在。
     *
     * `DomainImpl.enqueue()`：`if (this.disposing) return Promise.reject(new DomainError('closed', …))`
     * ⇒ 域一旦开始关闭，**它的每一次 `put` 都拒绝**；
     * 而 `table()` **在 disposing 时仍然可用** ⇒ 用它探活会**把死句柄当成活的**，
     * 于是从此所有写静默失败（我原来就栽在这儿）。
     */
    if (await handleCanWrite(cached)) return cached;
    HANDLE_CACHE.delete(key);              // 死了 ⇒ 丢掉，重新开
    try { await cached.close?.(); } catch { /* 关不掉也无所谓 */ }
  }
  try {
    const handle = await facility.open(domainSpec);
    HANDLE_CACHE.set(key, handle);
    return handle;
  } catch (error) {
    /**
     * ⚠️ **`already-open` 要复用，不要退回兜底**（2026-09-30 实测）。
     *
     * 失败现场：重启后新实例 `open()` 报
     * `DomainError: domain 'bulletin_dispatch' is already open (code=already-open)`
     * ⇒ 我原来一律退回兜底文件存储 ⇒ **同一个域，一半功能读域、一半读写文件**
     * （这正是"投递收到了、但列不出来"那种自相矛盾现象的来源）。
     *
     * ⇒ 正确做法：`facility.get(name)` 能把**已经开着的那一个**拿出来用。
     * 它是 `DomainImpl | undefined`（官方标注为诊断面，但复用是正当用途 ——
     * 域是全局单例，同一个名字本来就只有一份状态）。
     */
    if (error?.code === 'already-open') {
      const existing = facility.get?.(DOMAIN_NAME);
      if (existing !== undefined) {
        HANDLE_CACHE.set(key, existing);
        return existing;
      }
    }
    throw error;
  }
}

/**
 * 这个句柄**还能写吗**？
 *
 * ⚠️ 真的写一条探测记录（`misc` 表的固定键，**不污染业务表**）——
 * 比"看接口在不在"可靠得多（见上面那段说明）。
 */
async function handleCanWrite(handle) {
  try {
    const probe = handle?.table?.(TABLES.misc);
    if (probe === undefined) return false;
    await probe.put('__probe__', { value: 'ok', at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

/**
 * 列一张表的**全部**记录（存储无关）。
 *
 * ⚠️ **为什么要单独一个函数**（2026-09-30 实测）：
 * 我原来在两处直接写 `table.entries()` —— 而**兜底文件表没有 `entries`**
 * ⇒ 一旦退回兜底存储，`list_tickets` 当场报 `not a function`，**投递整个不可用**。
 * ⇒ 这里**按能力探测**：`entries()` → `keys()`+`get()` → 空。
 * **永远不会抛**，最多列不出来（那时调用方自己决定怎么报）。
 *
 * @param {object|undefined} table
 * @returns {Array<[string, unknown]>}
 */
export function listRecords(table) {
  if (table === undefined || table === null) return [];
  try {
    if (typeof table.entries === 'function') {
      const out = [];
      for (const pair of table.entries()) {
        if (Array.isArray(pair) && pair.length >= 2) out.push([pair[0], pair[1]]);
      }
      return out;
    }
  } catch { /* 换 keys() */ }
  try {
    if (typeof table.keys === 'function' && typeof table.get === 'function') {
      const out = [];
      for (const key of table.keys()) out.push([key, table.get(key)]);
      return out;
    }
  } catch { /* 列不出来就算了 */ }
  return [];
}

/**
 * 在给定 ctx 上找 `storageDomain`。
 *
 * ⚠️⚠️ **两条路都要试，而且 `ctx.storageDomain` 优先**（2026-09-30 实测踩到）：
 *   · 用 `ctx.inject(['storageDomain'], (sctx) => …)` 时，**回调收到的子 ctx 上
 *     `ctx.get` 可能不是函数**（实测：`probe=(ctx.get 不是函数)`）⇒
 *     那会儿只能读属性 `sctx.storageDomain`。
 *   · 反过来，**插件根 ctx 上属性读不到、只有 `ctx.get` 能取**。
 *   ⇒ **两边都试**，谁先给到就用谁。**不要假设只有一种形态。**
 */
function findStorageDomain(ctx) {
  if (ctx === undefined || ctx === null) return undefined;
  try {
    if (ctx.storageDomain !== undefined && ctx.storageDomain !== null) return ctx.storageDomain;
  } catch { /* 换下一个途径 */ }
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('storageDomain') : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet;
  } catch { /* 放弃 */ }
  return undefined;
}

/**
 * 打开存储。
 *
 * ## ⭐ 为什么**以插件自己的文件为权威**（2026-09-30 ）
 *
 * 实测（证据在 `进度与待办.md` 二之八之七）：**平台存储域在这个环境里打开成功、写却不落盘、也不报错**
 * —— 发单回执成功、日志有 `已发单`、**介质 `tickets=0`、零错误**。
 * 而**同一个插件的文件存储是真能写的**（现场试写成功）。
 *
 * ⇒ 取舍：**文件是唯一权威（读写的都只有它）**，域降为**只写不读的镜像**（有备份意义）。
 * **刻意不做"读并集"** —— `2026-09-29` 那次"两份游标取并集"是被迫的兼容措施，
 * 但它也带来了"两个读者看到不同数据"那类隐患。既然现在能选，就**只留一个权威**。
 *
 * ⚠️ **镜像也绝不阻塞主路径**：它只 `put`（不 `await`、不 `open` 失败就不镜像）。
 *
 * @param {object} ctx 插件根 ctx（或 `inject` 回调收到的子 ctx）
 * @param {{ file?: string, log: Function, warn: Function }} options
 * @returns {Promise<{ tables: Record<string, object>, where: string, close: () => void }>}
 */
export async function openStore(ctx, options) {
  const { file, log, warn } = options;
  const path = file ?? defaultStateFile();
  const tables = {};
  for (const name of Object.values(TABLES)) tables[name] = fileTable(path, name);

  // 域镜像是**可选**的（默认关）。见下面 `mirrorToDomain` 的说明。
  if (options.mirrorToDomain === true) {
    void (async () => {
      try {
        const facility = findStorageDomain(ctx);
        if (facility === undefined) {
          log('存储：用文件（域此刻取不到；域只当备份，不影响功能）', { file: safe(path) });
          return;
        }
        const handle = await openDomainHandle(facility, log, warn);
        const tableNames = [];
        for (const [name, table] of Object.entries(tables)) {
          let dt;
          try { dt = handle.table(name); } catch (error) {
            log('域镜像：取表失败', { table: name, error: errText(error) });
          }
          tableNames.push(`${name}=${dt === undefined ? '无' : typeof dt.put}`);
          mirrorTable(table, dt, name, log);
        }
        log('存储：文件为权威 + 域做镜像', { file: safe(path), domain: DOMAIN_NAME, tables: tableNames.join(' ') });
      } catch (error) {
        log('存储：域镜像建立失败（不影响功能，文件仍是权威）', { error: errText(error) });
      }
    })();
  } else {
    log('存储：只用文件（域镜像已关闭）', { file: safe(path) });
  }

  // ⚠️ 把**实际用的**文件路径报出去（配置留空时是默认路径）——
  //    否则健康段只能写"默认位置"，排查时等于没说。
  return { tables, where: 'file', file: path, close: () => { /* 什么都不关 —— 交给平台 */ } };
}

/**
 * 把"文件表"包一层：**写时顺带镜像进域**（不 await、不阻塞、失败只记一次）。
 *
 * ⚠️ 只写不读 —— 读永远走文件，**这样就不存在"两个读者看到不同数据"**。
 */
function mirrorTable(fileBacked, domainTable, name, log) {
  if (domainTable === undefined) return;
  let warned = false;
  const originalPut = fileBacked.put;
  fileBacked.put = (key, value) => {
    const result = originalPut(key, value);        // 文件是权威：同步写完
    try {
      void Promise.resolve(domainTable.put(key, value)).catch((error) => {
        if (warned) return;
        warned = true;
        log('域镜像写入失败（不影响功能）', { table: name, error: errText(error) });
      });
    } catch { /* 镜像永远不许影响主路径 */ }
    return result;
  };
  const originalDelete = fileBacked.delete;
  fileBacked.delete = (key) => {
    const result = originalDelete(key);
    try { void Promise.resolve(domainTable.delete(key)).catch(() => {}); } catch { /* 同上 */ }
    return result;
  };
}

/**
 * 状态文件的默认位置。
 *
 * ⚠️ **不能用相对路径**（2026-09-30 实测踩到）：
 * 相对路径会被解析到**进程的工作目录** —— 实测写到了
 * `%APPDATA%\dsh-desktop\launch-root\bulletin_dispatch_state.json`（**不是** `harness\storages\`）。
 * 那里既不好找、也不在"持久状态该待的地方"。
 *
 * ⇒ 优先用平台给的 **`DSH_HOME`**（它就是这个 Harness 的家目录），
 * 退路才是按 `APPDATA` 拼。**两者都给绝对路径。**
 */
function defaultStateFile() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home !== '') {
    return `${home}\\storages\\bulletin_dispatch_state.json`;
  }
  const appData = process.env.APPDATA;
  if (typeof appData === 'string' && appData !== '') {
    return `${appData}\\dsh-desktop\\harness\\storages\\bulletin_dispatch_state.json`;
  }
  return 'bulletin_dispatch_state.json';
}

/**
 * 读一条记录（域与兜底**都要看** —— 谁记得都算数）。
 *
 * ⚠️ 只读一份是 2026-09-29 踩过的坑：域修好前后各有一份数据，
 * 只读其中一份 ⇒ **在另一份里记过的会被当成"没见过"** ⇒ 重复投递。
 * 这里的策略：**优先域；域没有就看兜底**（对"记录存在性"来说这就是并集）。
 *
 * @param {object} primary 域的表（可能已退化成兜底表）
 * @param {object|undefined} fallback 兜底表（当 primary 就是兜底时传 undefined）
 * @param {string} key
 * @returns {object|undefined}
 */
export function getEither(primary, fallback, key) {
  try {
    const p = primary?.get?.(key);
    if (p !== undefined && p !== null) return p;
  } catch { /* 域读失败 → 看兜底 */ }
  try {
    const f = fallback?.get?.(key);
    if (f !== undefined && f !== null) return f;
  } catch { /* 都没有 */ }
  return undefined;
}
