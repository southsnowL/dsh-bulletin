/**
 * 办公室面板（宿主半边）：**读**两个权威文件，**按明确授权写其中一个**。
 *
 * ## 路由
 *
 * | 方法 | 路径 | 干什么 | 写吗 |
 * |---|---|---|---|
 * | `GET` | `/sidebar/api/office` | 公告条目 + 状态表原文 + 文件指纹 | ❌ 只读 |
 * | `POST` | `/sidebar/api/office/announce` | **追加**一条公告 | ✅ 写公告 |
 * | `POST` | `/sidebar/api/office/announce/edit` | **改**已有的一条 | ✅ 写公告 |
 * | `POST` | `/sidebar/api/office/announce/delete` | ⭐ **删**掉一条（2026-10-01 加） | ✅ 写公告 |
 *
 * ## ⚠️ 四条边界（**这是本插件最重要的部分**）
 *
 * | # | 边界 | 为什么 |
 * |---|---|---|
 * | **1** | **只写公告文件**，`投递状态.md` **绝不写** | 状态表是**派生视图**（投递插件生成的）—— 面板写它就是第二个真相源 |
 * | **2** | ⭐ **删除属于"用户那一半"** | 规矩是"**AI 只能追加，用户可以删改**"（见 `docs\01` §五.二）——<br>所以面板**提供**删除，但它**长得不像日常动作**：要过确认框、删前告诉你**有几个会话见过**、删后往 `公告-删除记录.md` **追一行** |
 * | **3** | ⭐ **乐观锁**：写的时候必须带回 `revision`，对不上 ⇒ **409 拒绝** | 公告文件**可能同时被别的东西写**（AI 用 `announce` 工具、用户手改）。**对不上就拒绝，绝不覆盖别人的改动** |
 * | **4** | ⭐ **原子写**：写临时文件 → 改名 | **半截文件 = 公告坏了 = 各桌再也收不到公告**。这是事故，不是小毛病 |
 *
 * > ⚠️ **第 2 条 2026-10-01 改过**：原来写的是"⛔ **没有删除**"（那是第一版的事）。
 * > 而"用户可以删改"**本来就在规矩里**（`docs\01` §五.二一直写着）——
 * > **只是"只增不改"这个旧名字把它盖住了。**
 *
 * ## 权限（2026-09-30，两层）
 *
 * | 层 | 做法 |
 * |---|---|
 * | **A** | **只认本机 + 同源** —— 校验 `Origin`/`Host` 是本机地址。**外站页面发不进来** |
 * | **C** | **破坏性操作（编辑）要确认** —— 这是**前端**的责任（界面上弹确认框）。宿主这层只提供 `revision` 护栏 |
 *
 * > ⚠️ **为什么不用平台的审批机制**：当前会话的审批策略是"完全权限" ⇒ **审批会静默通过，等于没拦**。
 * > 所以"确认"只能靠**界面上的确认框** —— 那才真拦得住误点。
 *
 * ## "只有用户能改"靠什么
 *
 * 不是靠登录（本机页面就是用户本人），而是：
 * **这是用户专用的界面** + **编辑要确认**（前端）+ **乐观锁**（后端）。
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'bulletin-panel';

/**
 * 一条公告行的**开头**：`- MM-DD｜`。
 *
 * ⚠️ 这里**只用它判断"这是不是一条公告"**，剩下的正文用 `text.replace(...)` 取 ——
 * **不要让正则去捕获正文**。
 *
 * > 为什么写这条注释：第一版就是这么错的 —— 正则写成 `/^-\s*(\d{2}-\d{2})｜([^｜]*)｜([\s\S]*)$/`，
 * > 然后取 `m[3]` 当正文。**可 `m[2]` 才是发布者、`m[3]` 已经是"发布者之后的全部"**
 * > ⇒ **发布者被当成了正文、正文被当成了"详见"**，整个面板错位。
 * > 教训：**捕获组越多越容易数错；能不用捕获就不用。**
 */
const ANNOUNCE_HEAD = /^-\s*(\d{2}-\d{2})｜/u;

/** 一条"看起来想当公告行、但格式不对"的行（用来**如实报错**，不是静默丢弃）。 */
const ANNOUNCE_WANNABE = /^[-*]\s*\d/u;

/** 一天多少毫秒（用于把 `ttlDays` 变成"N 天"）。 */
const DAY = 86_400_000;

/**
 * 把公告文件解析成条目。
 *
 * 协议（`00-通用\公告.md` 头部 + `docs\03-机制详解.md`）：
 *
 * ```
 * - MM-DD｜发布者｜一句话｜详见哪里｜有效期
 * ```
 *
 * ## ⚠️⚠️ **必须是正好 5 段**（2026-10-01 改的 —— 原来"几段都能解析"）
 *
 * ### 踩到什么
 *
 * 这个解析器原来写的是"**从两边往中间取**"：段数 ≥3 就认，
 * **倒数第 1 段当有效期、倒数第 2 段当详见**。
 *
 * 而**写入器 `formatAnnounceLine`** 在"有效期长期 + 没填详见"时**只写 3 段**。
 *
 * ⇒ 于是**自己写的行自己读错位**：
 *
 * ```
 * 写出来：- 10-01｜用户｜测试B｜00-通用\说明.md      （4 段）
 * 读回来：正文 = 空 · 详见 = "测试B" · 有效期 = "00-通用\说明.md"   ❌
 * ```
 *
 * ### 而更糟的是"合不上"这件事本身
 *
 * **同一个协议有三份定义**（写入器、本解析器、`dsh-bulletin-announce` 的 `ENTRY_RE`），
 * 而公告插件的正则**要求正好 5 段** ⇒ **3 段 / 4 段的行，各桌永远收不到，而且不报错**。
 *
 * **⇒ 这就是 `docs\01` 里"副本是病根"那条规矩，在代码里的一个活样本。**
 * **⇒ 修法：**段数定死 5，**两个解析器口径一致**；
 * **而"写出来的每一种行都必须能被对方读出来"这件事，有一套自测守着**
 * （"面板写 → 公告插件读"那一段）。
 *
 * ⚠️ **那套自测在仓库外，没有随本仓库发布**（见 `docs\05` 末尾那段）——
 * **别在这个仓库里找它。**
 *
 * @param {string} text 公告文件全文
 * @returns {{entries: object[], noise: number, malformed: string[]}}
 *   `noise` = 标题/说明/空行（**正常**）；`malformed` = 看着像公告却没解析出来的行（**要报出来**）
 */
export function parseAnnouncements(text) {
  const entries = [];
  let noise = 0;
  const malformed = [];

  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') { noise += 1; continue; }
    const head = ANNOUNCE_HEAD.exec(line);
    if (head === null) {
      if (ANNOUNCE_WANNABE.test(line)) malformed.push(line);
      else noise += 1;
      continue;
    }
    /**
     * ⚠️⚠️ **判据是"至少 4 段"，不是 5** —— 因为**日期已经被切掉了**。
     *
     * `head[0]` 是 `- MM-DD｜`（**日期连同它后面那个分隔符**）⇒
     * 从这里往后，协议剩下的字段是 **4 个**：
     *
     * ```
     * 发布者｜一句话｜详见哪里｜有效期
     *   1      2       3        4        ← 段数 = 4
     * ```
     *
     * **⚠️ 我第一版写成 `< 5`，结果"面板自己写的行，面板自己判成坏行"** ——
     * 一个 off-by-one，而且症状很像"写入器又写错了"。（`malformed: 1` 就是它。）
     *
     * **⇒ 写这种"数段数"的代码时，先数清楚"从哪切起"。**
     */
    const parts = line.slice(head[0].length).split('｜').map((s) => s.trim());
    if (parts.length < 4) { malformed.push(line); continue; }
    const publisher = parts[0];
    /** ⚠️ 中间可能有多个 `｜`（用户打的分隔符已被写入器换成"丨"，但老行可能还有）
     *  ⇒ 除首尾各两个字段外，**剩下的全归"一句话"**。 */
    const ttl = parts[parts.length - 1];
    const source = parts[parts.length - 2];
    const summary = parts.slice(1, parts.length - 2).join('｜');
    /**
     * ⚠️⚠️ **这个指纹必须和公告插件算得一模一样**（2026-10-01）——
     * 因为"删除公告"要拿它去问"**这条被几个会话见过**"。
     *
     * 公告插件那边（`index.js`）：
     *
     * ```js
     * const id = createHash('sha1').update(line).digest('hex').slice(0, 16);
     * ```
     *
     * | 细节 | 两边都得一样 | 为什么 |
     * |---|---|---|
     * | 算法 | `sha1` | 换成 sha256 ⇒ **全部对不上，见过数永远是 0** |
     * | 输入 | **那一整行**（含开头的 `- `） | 少了前缀就是对不上 |
     * | 编码 | **默认 utf8**（别显式写 `'utf8'` 之外的东西） | 中文行会算出不同的哈希 |
     * | 截取 | **前 16 位十六进制** | —— |
     * | 那个 `line` | **`raw.replace(/\r$/u,'')` 之后、且两端已 trim** | ⚠️ **`\r` 会让哈希完全不同**（CRLF 文件） |
     *
     * **⇒ 最后一行是最容易错的**：公告插件读文件时是 `split('\n')` 再剥 `\r`，
     * 而这里也是先把整行 `trim()` 过。**两边都必须拿"剥了 \r、去了两端空白"的那一行去算。**
     */
    const id = createHash('sha1').update(line).digest('hex').slice(0, 16);
    entries.push({ id, date: head[1], publisher, summary, source, ttl, raw: line });
  }
  return { entries, noise, malformed };
}

/** 读一个文件；读不到就返回 `null`（**不抛** —— 面板缺一个文件不该整个坏掉）。 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * ⭐ **内容指纹**（乐观锁用）。
 *
 * 客户端拿到它、写的时候带回来；**对不上就说明"你读到的和现在的不一样"** ⇒ 拒绝。
 *
 * @param {string|null} text 文件内容（`null` = 文件不存在）
 * @returns {string} 12 位十六进制
 */
export function revisionOf(text) {
  return createHash('sha256').update(text ?? '\u0000(不存在)', 'utf8').digest('hex').slice(0, 12);
}

/**
 * ⭐⭐ **原子写**：先写同目录的临时文件，再 `rename` 覆盖。
 *
 * ## 为什么必须这样（**这是事故级的要求**）
 *
 * 公告文件是**各桌获取办公室信息的唯一入口**（整个公告机制靠它）。
 * 如果直接 `writeFileSync(path)` 写到一半崩了 ⇒ **文件半截 ⇒ 所有桌都读不到公告**。
 *
 * `rename` 在同一分区上是**原子的** ⇒ 读者要么看到旧全文，要么看到新全文，**永远看不到半截**。
 *
 * @param {string} path 目标文件
 * @param {string} text 新内容
 */
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // ⚠️ 不要 BOM（`进度与待办.md` 里记着：`Set-Content -Encoding UTF8` 写 BOM 会崩 Harness）
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'w' });
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 清理失败就算了 */ }
    throw error;
  }
}

/**
 * ⭐⭐ **公告文件的跨进程锁 + "写之前再核一次"**（2026-10-05 加，回应 Codex 审查 **P1-3**）。
 *
 * ## 那个窗口
 *
 * 面板的策略是**乐观锁**：先读一份快照 → 比 `revision` → 对了就**整份写回** ✓。
 * 可是"**比**"和"**写**"之间有一段真空 ✗ —— 外部程序（另一个会话的公告工具、
 * 或另一个 DSH 实例）在这段时间里**追加了一行** ⇒ 我们那次"整份写回"会**把它吞掉** ✓，
 * 而接口照样回 200 ✓（审查用模拟验证过：追加行消失、返回 `ok:true` ✓）。
 * ⚠️ 而"直接往文件里追加"是**项目明确支持**的用法 ✓ ⇒ 这不是假想敌 ✓。
 *
 * ## 怎么补
 *
 * 拿一把**文件锁**（`<file>.lock` 的原子创建 ✓，和 dispatch 那边同一套路 ✓），
 * 在锁里**重新读盘 + 再核一次 `revision`** ✓，对得上才写 ✓：
 * - 对得上 ⇒ 窗口没了 ✓（锁期间没有别的写者）
 * - 对不上 ⇒ 抛 `code='stale'` ⇒ 上层回 **409** ✓（让用户刷新重试，绝不猜 ✓）
 *
 * ⚠️ 锁时长可用环境变量调（**只为自测**）：`DSH_BULLETIN_LOCK_WAIT_MS` / `..._STALE_MS` ✓
 */
const ANNOUNCE_LOCK_STALE_MS = Number(process.env.DSH_BULLETIN_LOCK_STALE_MS ?? '') || 10000;
const ANNOUNCE_LOCK_WAIT_MS = Number(process.env.DSH_BULLETIN_LOCK_WAIT_MS ?? '') || 5000;
const sleepSyncMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function withAnnounceLock(path, fn) {
  const lock = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > ANNOUNCE_LOCK_STALE_MS) { unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() - started > ANNOUNCE_LOCK_WAIT_MS) {
        const busy = new Error(`拿不到公告文件锁（${lock}）—— 有别的进程正在写，请稍后重试`);
        busy.code = 'busy';
        throw busy;
      }
      sleepSyncMs(15 + Math.floor(Math.random() * 35));
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* 释放失败就算了 */ } }
}

/**
 * ⭐ **锁里复核 revision，然后整份写回**（三个写入口都用它 ✓）。
 *
 * @param {string} path 公告文件
 * @param {unknown} expectedRevision 客户端那份快照的 revision
 * @param {string} text 要写的新全文
 */
function writeAnnounceChecked(path, expectedRevision, text) {
  return withAnnounceLock(path, () => {
    const now = readTextOrNull(path);
    if (now === null) {
      const gone = new Error('公告文件在写入前不见了');
      gone.code = 'not-found';
      throw gone;
    }
    if (String(expectedRevision ?? '') !== revisionOf(now)) {
      const stale = new Error('文件刚被别处改了（就在要写下去的那一刻）');
      stale.code = 'stale';
      throw stale;
    }
    writeAtomic(path, text);
  });
}

/** `MM-DD`（公告行的日期格式）。 */
function todayMmDd(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把一条公告**拼成一行**（协议格式）。
 *
 * ## ⚠️⚠️ **永远写满 5 段**（2026-10-01 改的 —— 原来会写 3 段或 4 段）
 *
 * ### 踩到什么
 *
 * 原来这里是"**没内容就省掉那一段**"：
 *
 * ```js
 * const parts = [date, publisher, text];        // 3 段
 * if (src !== '' || days > 0) parts.push(src);  // 有出处 或 有天数 ⇒ 4 段
 * if (days > 0) parts.push(`${days} 天`);       // 只有天数 > 0 才补第 5 段
 * ```
 *
 * **⇒ 有效期选默认的"长期"（`0`）时，只有 3 段或 4 段。**
 *
 * ### 为什么那是致命的
 *
 * `dsh-bulletin-announce` 的 `ENTRY_RE` **要求正好 5 段**（5 个 `｜`）
 * ⇒ **3 段 / 4 段的行，各桌永远收不到 —— 而且一声不吭。**
 *
 * **⇒ 于是"面板发的公告"这条路上的东西，全部静默丢失。**
 *
 * ### 修法
 *
 * **字段定死 5 个；空的写空串，但分隔符一个不少。**
 * 这样"段数"就不再是一个会变的东西，两个解析器也没有猜的余地。
 *
 * ⚠️ **"长期"怎么写**：写 **`0 天`**（不是空）。
 * 因为空串在协议里表示"**没写**"⇒ 解析器会退回默认的 14 天 ⇒ **那是一条会过期的公告**，
 * **和用户选的"长期"不是一回事**。（`announce` 工具的说明里就写着"写 0 表示长期有效"。）
 *
 * @param {object} p
 * @returns {string}
 */
export function formatAnnounceLine({ date, publisher, text, source, ttlDays }) {
  /**
   * ⚠️⚠️ **全角竖线不能让用户打进来**（2026-10-01 实测抓到的第二个坑）。
   *
   * ## 为什么
   *
   * 它是**字段分隔符**。用户在一句话里打一个 `｜` ⇒ 那一段裂成两段 ⇒
   * **总段数变成 6 或 7** ⇒ **公告插件的正则（要求正好 5 段）再也匹配不上** ⇒ **整条公告静默丢失**。
   *
   * 实测：`- 10-01｜用户｜甲｜乙｜丙｜x.md｜0 天`（7 段）⇒ 公告插件读不出来。
   *
   * ## 怎么处理
   *
   * **换成"丨"（U+4E28，一个汉字，长得几乎一样）** —— 保留可读性，又不破坏结构。
   * ⚠️ 另一个选择是"拒绝并报错"，但对一个**给人用的发布框**来说，
   * **为了一个全角竖线让用户重写一整条公告**，太重了。**悄悄换掉 + 在界面提示**更合适。
   *
   * @param {string} s
   * @returns {string} 去掉换行、替换掉分隔符、两边去空
   */
  const seg = (s) => String(s ?? '').replace(/[\r\n]+/gu, ' ').replace(/｜/gu, '丨').trim();

  const days = Number(ttlDays ?? 0);
  /**
   * ## ⚠️⚠️ 长期写成 `长期`，**不是 `0 天`**
   *
   * ### 原来写的是
   *
   * ```js
   * const ttl = Number.isFinite(days) && days > 0 ? `${days} 天` : '0 天';
   * ```
   *
   * ⛔ **而 `0 天` 不是这个项目的规范写法** —— 公告文件头部专门为这件事写过一段：
   *
   * > *"规范只此一处：以前头部教 `0`、工具写 `0 天`、解析器只认 `0`，
   * > **三种说法互相打架**（2026-09-29 修）。"*
   *
   * ### 为什么这次才暴露
   *
   * ⚠️ **因为它不报错** —— 解析器把 `0 天` 认成"长期"，**功能上一切正常**。
   * 但**同一个字段、两个写入口、两种写法**：
   *
   * | 谁写 | 写出来的是 |
   * |---|---|
   * | **`announce` 工具** | `长期` |
   * | **面板（这里）** | ⛔ `0 天` |
   *
   * **⇒ 症状是**"文件里有的写 `长期`、有的写 `0 天`"** ——
   * 而**读的人（和以后的代码）会以为这两种有区别**。
   *
   * **⭐ 判据**：**同一件事只有一种规范写法，而所有写入口都该写那一种。**
   * （发现它的方式很实在：用户测试时从面板发了条公告，看文件里是 `0 天`，
   * 而同一天用工具发的那条是 `长期` —— 两条并排躺在同一个文件里。）
   */
  const ttl = Number.isFinite(days) && days > 0 ? `${days} 天` : '长期';
  /**
   * ⚠️ **顺序不能错**：日期｜发布者｜一句话｜详见｜有效期。
   */
  return `- ${[seg(date), seg(publisher), seg(text), seg(source), ttl].join('｜')}`;
}

/** 读请求体（有上限，免得被人拿它当内存炸弹）。 */
function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * **来源检查：只接受"本机 + 同源"的写请求**。
 *
 * ## 它防的是什么（**不是防黑客**）
 *
 * 本机用户就是主人 ⇒ **它不是权限系统**。它防的是：
 * **你浏览器里别的页面顺手往这个端口发一个请求。**
 *
 * ## ⚠️⚠️ 2026-10-01 修正：**原来它没在比"同源"**
 *
 * ### 原来错在哪
 *
 * 旧实现只做一件事：**检查 `Origin` 的主机是不是本机**（`127.0.0.1` / `localhost` / `::1`）。
 * ⇒ **`http://localhost:4000` 上的任意一个页面，往 `localhost:43129` 发写请求，照样放行。**
 * 那**不是同源** —— 只是"两边都在本机"。
 *
 * **⚠️ 而 README 承诺的是"只认本机同源"** ⇒ **承诺与实现不一致**。
 *
 * ### 而且 `split(':')[0]` 会把 IPv6 切坏
 *
 * `[::1]:3000` 按冒号切 ⇒ 得到 `[` ⇒ **判成本机失败** ⇒
 * **一个合法的同源 IPv6 请求反而被拒。**
 *
 * ### 现在的做法
 *
 * 1. ⭐ **真的比同源**：把 `Origin` 解析出来，**和请求的 `Host` 比**（主机名 + 端口）
 * 2. ⭐ **IPv6 用 `URL` 解析**（它自己会处理方括号），**绝不手工按冒号切**
 * 3. ⭐ **默认端口要归一**（`http://x:80` 和 `http://x` 是同一个源）
 *
 * ### ⚠️ 一个我们**故意不查**的东西
 *
 * **协议（http/https）不比较** —— 这个面板**只跑在 http 上**（本机回环），
 * 比它没有意义。**宁可写清"不查它"，也不要假装查了。**
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLocalSameOrigin(req) {
  const originHost = req.headers?.origin;
  const requestHost = req.headers?.host;
  if (typeof requestHost !== 'string' || requestHost === '') return false;
  /**
   * 没有 `Origin` 的请求（同源 GET、某些客户端）⇒ 只看 `Host` 是不是回环。
   * ⚠️ 写请求走的是 `fetch`，浏览器一定会带 `Origin` ⇒ 这条路径主要给读请求用。
   */
  if (originHost === undefined || originHost === '') return isLoopbackAuthority(requestHost);
  let o;
  try {
    o = new URL(originHost);
  } catch {
    return false;                       // `Origin: null` 之类 ⇒ 拒
  }
  /** 两边都必须是本机，而且**端口要对上**。 */
  return isLoopbackAuthority(requestHost) && sameOriginAs(requestHost, o.host);
}

/**
 * 回环地址判定。**IPv6 交给 `URL` 处理，不手工切冒号。**
 *
 * ⚠️ 2026-10-01 修正：原来用 `h.replace(/^\[|\]$/,'').split(':')[0]` ——
 * **`[::1]:3000` 会被切成 `[`** ⇒ 合法的 IPv6 请求反被拒。
 */
function isLoopbackAuthority(authority) {
  const a = parseAuthority(authority);
  if (a === null) return false;
  return isLoopbackHost(a.host);
}

/** `127.0.0.1` / `localhost` / `[::1]` —— 三种写法**都指本机**。 */
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/**
 * 请求的 `Host` 和 `Origin` 是不是**同一个源**。
 *
 * ## ⚠️ 为什么主机名比"字符串相等"松一点（2026-10-01 的决定）
 *
 * `127.0.0.1` / `localhost` / `[::1]` **指向同一台机器**，
 * 而**浏览器发哪个写法取决于用户是怎么打开这个面板的**（地址栏敲的是哪个）。
 *
 * ⇒ 如果严格比字符串，那么"用 `127.0.0.1` 打开、但 `Host` 头是 `localhost`"这种情况
 * **会把用户自己的合法请求拒掉** —— 那不叫安全，那叫坏掉。
 *
 * **⚠️ 而端口必须严格相等**：那才是"同源"里真正防住跨站的那一半
 * （`localhost:4000` 上的页面 ≠ `localhost:43129` 上的面板）。
 */
function sameOriginAs(requestAuthority, originHost) {
  const a = parseAuthority(requestAuthority);
  const b = parseAuthority(originHost);
  if (a === null || b === null) return false;
  if (a.port !== b.port) return false;
  return isLoopbackHost(a.host) && isLoopbackHost(b.host);
}

/**
 * 解析 `host[:port]`，**正确处理 IPv6 的方括号**。
 *
 * ⚠️ 判据是"**方括号里全归主机**，方括号之后才可能是端口" ——
 * 而不是"按冒号切第一段"（那会把 `[::1]:3000` 切成 `[`）。
 *
 * @param {string} authority 例：`127.0.0.1:43129` · `localhost` · `[::1]:3000`
 * @returns {{host: string, port: string}|null}
 */
function parseAuthority(authority) {
  const s = String(authority ?? '').trim();
  if (s === '') return null;
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;                       // 括号没闭合 ⇒ 坏输入
    const host = s.slice(0, close + 1).toLowerCase();
    const rest = s.slice(close + 1);
    if (rest === '') return { host, port: '' };
    if (!rest.startsWith(':')) return null;
    return { host, port: normPort(rest.slice(1)) };
  }
  const i = s.lastIndexOf(':');
  // ⚠️ `lastIndexOf` 对无括号的 IPv6（`::1`）会误切 —— 但那种 Host 头本身不合法，直接拒。
  if (i < 0) return { host: s.toLowerCase(), port: '' };
  if (s.indexOf(':') !== i) return null;              // 一个以上冒号 ⇒ 不是合法 IPv4/主机名
  return { host: s.slice(0, i).toLowerCase(), port: normPort(s.slice(i + 1)) };
}

/** 空端口和默认端口归一成同一个值（`http://x:80` 与 `http://x` 同源）。 */
function normPort(p) {
  const s = String(p ?? '').trim();
  if (s === '') return '';
  if (s === '80' || s === '443') return '';
  return s;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * 装上这个插件。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} config 见 `cordis.patch.yml`
 */
export function apply(ctx, config) {
  /**
   * ⚠️ **`workspaceRoot` 没有默认值**（2026-10-01 改的）。
   *
   * 原来这里有一句兜底：`?? '<某个写死的绝对路径>'` —— **那是开发者本机的路径**。
   * 那种兜底对别人**一定是错的**，而且**它不会报错**：
   * 面板会安静地去读一个不存在的目录，然后显示"读不到数据"，
   * **用户完全不知道为什么**。
   *
   * ⇒ 现在**没配就明确拒绝启动**。**宁可它装不上，也不要它安静地看错地方。**
   */
  const root = String(config?.workspaceRoot ?? '');
  if (root === '') {
    throw new Error(
      '[bulletin-panel] 没有配 `workspaceRoot` —— 它不知道去哪读公告和投递状态。\n'
      + '请在插件配置里填上你的工作区根目录（比如 `D:\\my-office`）。',
    );
  }
  const rel = (p, fallback) => {
    const v = String(p ?? fallback);
    return isAbsolute(v) ? v : join(root, v);
  };
  /**
   * ## ⭐⭐ **面板版本号：挂载时读一次，之后不再变**（2026-10-01 改，Claude 精修时指出）
   *
   * ### 原来错在哪
   *
   * 它写在 `readPayload()` 里 —— 而那是**每次 GET 都跑一遍**的。
   * **⇒ 它报的是"盘上的 `package.json` 写着哪一版"，不是"正在跑的代码是哪一版"。**
   *
   * ### 为什么那正好把这个字段的用处抵消掉了
   *
   * **这个版本号唯一的存在理由**，是回答"**我看的是哪一版**"（见 `docs\06` 二.7 那次）：
   * 那天后端算得对、界面全显示 0，而我**没有任何办法判断浏览器跑的是哪一版**。
   *
   * **⚠️ 而"现读磁盘"恰好在最需要它的那一刻撒谎**：
   * 改完文件**还没重启 DSH** 时 —— 盘上是新版、**跑的还是旧的** ——
   * 它却会和新前端一起显示"前后端一致"。
   * **⇒ 一个在最该报警的时候说"没事"的指示器。**
   *
   * ### 现在
   *
   * **挂载时读一次，存住。** 于是"盘上是什么"和"跑的是什么"能分开：
   * **装了新版但没重启 ⇒ 前端（新 `client.js`）和后端（旧代码）的版本号对不上** ——
   * **那正是要报警的那件事。**
   */
  const panelDir = (() => {
    try { return dirname(fileURLToPath(import.meta.url)); } catch { return ''; }
  })();
  const panelVersion = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(panelDir, 'package.json'), 'utf8'));
      return typeof pkg.version === 'string' ? pkg.version : '';
    } catch { return ''; }
  })();

  /**
   * ⭐⭐ **磁盘上那份 `client.js` 自己写着哪一版**（2026-10-04 加）。
   *
   * ## 为什么非要有它 —— 那块指示器原来会**指错药方**
   *
   * `panelVersion`（`package.json`）和前端写死的 `FE_VERSION` 对不上时，
   * **光凭这两个数分不清是哪一种，而两种的药方完全相反**：
   *
   * | 真实情况 | 该给的药方 |
   * |---|---|
   * | **浏览器还拿着旧的 `client.js`** | **硬刷新**（Ctrl+Shift+R）✓ |
   * | **发版时忘了把 `client.js` 顶部那个常量一起 +1** | **硬刷新没有任何用** ✗（盘上那份文件本身就是旧号）|
   *
   * ⚠️ **2026-10-04 真踩到第二种**：`0.3.29`~`0.3.31` 只改了 `package.json`，
   * 前端常量停在 `0.3.28` ⇒ 健康页一口咬定"浏览器多半还拿着旧的 client.js，硬刷新一下" ✗
   * —— 而那条建议**永远不可能生效**（文件本身就是 0.3.28）。
   *
   * ⇒ 所以把"**盘上那份文件里的常量**"也报出去：前端只要问一句
   * "**浏览器手里的，和盘上的是同一个吗**"，就能给对药方 ✓
   * （浏览器手里的 = 盘上的 ⇒ 不是缓存问题 ⇒ 是发版卫生问题）。
   *
   * ⚠️ 这里**故意每次请求现读**（和上面的 `panelVersion` 正好相反）——
   * 它要回答的本来就是"**盘上现在是什么**"；读失败报空串 ⇒ 前端退回"不知道"，不硬猜。
   */
  function readClientFileVersion() {
    try {
      const src = readFileSync(join(panelDir, 'client.js'), 'utf8');
      const found = /const FE_VERSION = '([^']+)'/u.exec(src);
      return found === null ? '' : found[1];
    } catch { return ''; }
  }

  const announcePath = rel(config?.announceFile, '00-通用\\公告.md');
  const statusPath = rel(config?.statusFile, '00-通用\\投递状态.md');
  /** 是否是"只读模式"（用户想彻底关掉写能力时用）。 */
  const readOnly = config?.allowWrite === false;

  /**
   * ⭐⭐ **"每条公告有几个会话见过" —— 问公告插件要，面板自己不算。**
   *
   * ## 为什么需要这个数字（2026-10-01 加的"删除公告"功能的一半）
   *
   * 规矩是"**AI 只能追加，用户可以删改**"（见 `docs\01` §五.二）——
   * 所以用户要能删。**而删除会留下一处"分歧"**：
   * 你说"那条我删了"，而某个会话**上下文里还留着它、还在按它做事**。
   * **⇒ 那删除就必须是"有据的"，不是"悄悄抹掉"** —— 这个数字就是"据"的一半。
   *
   * ## ⚠️⚠️ 2026-10-01：这一段整个换掉了 —— 原来面板**自己**算
   *
   * 而它为了算这个数字，要碰**四样不属于它的东西**：
   *
   * | 原来要碰的 | 为什么不对 |
   * |---|---|
   * | 写死的 `%APPDATA%\…\harness\storages` | ⚠️ **dispatch 优先用 `DSH_HOME`，这里不看** ⇒ 两个插件认的目录可能不是一个 |
   * | 平台的**磁盘格式** `{ unit, global, tables: { seen } }` | ⚠️ 那是**存储域后端自己的格式**，平台一改这里就瞎 |
   * | 公告插件的**私有游标文件** | ⚠️ 那是它的内部状态，不是接口 |
   * | **抄一份指纹算法** | ⚠️ **实测已经咬过一次**（行尾空格 ⇒ "见过数"变 0） |
   *
   * **⇒ 四样加起来，这个数字有四个独立的出错理由** —— 而它是**删除前唯一的提醒**。
   * **⚠️ 一个永远偏低甚至恒为 0 的数字，比没有这个数字更危险。**
   *
   * ### 现在：问公告插件的只读接口
   *
   * `GET /sidebar/api/announce/seen` ⇒ `{ ok, seen: { 指纹: 人数 }, filtered, sessions }`
   *
   * **⇒ 算这件事回到它该在的地方** —— 只有公告插件知道自己的指纹怎么算、
   * seen 存在哪、哪些会话算数。**面板一个字节的内部格式都不用碰。**
   *
   * ## ⚠️⚠️ 而"问不到"和"0 人见过"必须能分开 —— 那是这次改动的另一半价值
   *
   * | 情况 | `seenBy` | 界面 |
   * |---|---|---|
   * | 问到了，有人见过 | `N`（≥1） | "有 N 个会话见过这条" |
   * | 问到了，没人见过 | `0` | "没有任何会话的见过记录里有这条" |
   * | **问不到**（路由不在 / 超时 / 报错） | **`null`** | **"问不到"** |
   *
   * **⚠️ 原来这三档被压成两档**：问不到和"真的没人见过"**长得一模一样** ——
   * 而那正是"你会放心地删掉有人记得的东西"的那个局面。
   */
  /**
   * ⭐ **公告插件的只读接口地址**（可用配置覆盖，默认按它注册的路径）。
   *
   * ⚠️ **为什么拼绝对地址而不是用相对路径**：面板后端不是浏览器，
   * **没有"当前页面"这个概念** ⇒ 相对路径的 `fetch` 会直接失败。
   * 而端口**从请求自己的 `Host` 头拿**（不写死 —— 换个端口就不该坏）。
   */
  const announcedSeenUrl = (host) => {
    const configured = String(config?.seenUrl ?? '').trim();
    if (configured !== '') return configured;
    const h = typeof host === 'string' && host !== '' ? host : '127.0.0.1:43129';
    return `http://${h}/sidebar/api/announce/seen`;
  };

  /**
   * 问公告插件要"每条公告被几个会话见过"。
   *
   * @returns `{ seen, filtered, sessions }`；**`null` 表示问不到**
   *   （调用方据此显示"问不到"，**绝不是 0**）。
   */
  const fetchSeen = async (host) => {
    const url = announcedSeenUrl(host);
    const ctl = new AbortController();
    /** ⚠️ **超时要短**：这是给界面看的诊断数字，**不值得让面板转圈**。 */
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) return null;
      const body = await r.json();
      if (body === null || typeof body !== 'object' || body.ok !== true) return null;
      const seen = body.seen !== null && typeof body.seen === 'object' ? body.seen : {};
      return {
        seen,
        /** ⚠️ 它说的是"平台告没告诉我哪些会话还在" —— 面板只**透传**，不自己判断。 */
        filtered: body.filtered !== false,
        sessions: Number.isFinite(body.sessions) ? body.sessions : null,
      };
    } catch {
      /**
       * ⚠️ **一律当成"问不到"，绝不悄悄当成"没人见过"。**
       * （路由还没装、插件没启用、超时 —— 对界面来说都是同一件事：**我不知道**。
       * 而"我不知道"必须显示成"我不知道"。）
       */
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 组一份读响应（三个路由共用）。
   *
   * ⚠️ **它是 async 的** —— 因为 `seenBy` 要**问公告插件**（`fetchSeen`）。
   */
  const readPayload = async (host) => {
    const announceText = readTextOrNull(announcePath);
    const statusText = readTextOrNull(statusPath);
    const parsed = announceText === null ? null : parseAnnouncements(announceText);
    /**
     * ⭐ **先问一次公告插件**（整个响应共用一份映射，别每条公告问一遍）。
     * **`null` = 问不到** ⇒ 每条 `seenBy` 都是 `null` ⇒ 界面显示"问不到"。
     */
    const asked = await fetchSeen(host);
    return {
      ok: true,
      readAt: Date.now(),
      paths: { announce: announcePath, status: statusPath },
      // ⭐ 写能力是否开着（前端据此决定按钮显不显示"未上线"）
      canWrite: !readOnly,
      announce: {
        exists: announceText !== null,
        // ⭐ **乐观锁要带回去的指纹**
        revision: revisionOf(announceText),
        count: parsed?.entries.length ?? 0,
        noise: parsed?.noise ?? 0,
        malformed: parsed?.malformed ?? [],
        /**
         * ⭐⭐ **每条都带上"有几个会话的见过记录里有它"**（2026-10-01 为删除功能加的）。
         *
         * 它在界面上的用法只有一个：**删除确认框里那句警告**。
         * **⇒ 我们**不**用它来禁止删除**（用户的判断比一个数字准），
         * **只用来让他"不是不知道地删"。**
         *
         * ⚠️⚠️ **三种值，不是一个数**（这是 2026-10-01 改接口时定的）：
         *
         * | 值 | 意思 | 界面 |
         * |---|---|---|
         * | `≥1` | 问到了，有会话见过 | "有 N 个会话见过这条" |
         * | `0` | 问到了，**确实没人见过** | "没有任何会话的见过记录里有这条" |
         * | **`null`** | **问不到**（公告插件的接口没应答） | **"问不到"** |
         *
         * **⇒ 原来这里只会是 `0` 或 N** —— "问不到"和"真的没人见过"**长得一模一样**，
         * 而那正是"你会放心地删掉有人记得的东西"的那个局面。
         */
        entries: (parsed?.entries ?? []).map((e) => ({
          ...e,
          seenBy: asked === null ? null : (asked.seen[e.id] ?? 0),
        })),
      },
      status: { exists: statusText !== null, markdown: statusText ?? '' },
      /**
       * ⭐ **那个数字是不是"只数平台还认得的会话"**。
       *
       * `false` = 公告插件**没拿到会话名单**（`sessionQuery` 不可用）⇒
       * **那个数字是"历史记录数"，比现实大。** ⇒ 前端会说清这一点。
       *
       * ⚠️ **问不到接口时也是 `false`** —— 那两种情况的界面措辞不同
       * （一个说"这个数可能偏大"，一个说"根本问不到"），靠 `seenBy` 是不是 `null` 区分。
       */
      seenByFiltered: asked === null ? false : asked.filtered,
      /**
       * ⭐ **参与统计的会话数**（2026-10-01 加，排查用）。
       * **它突然变成 0 或 `null` 就说明名单出问题了** —— 那正是"见过数全 0"那类 bug 的信号。
       */
      seenSessions: asked === null ? null : asked.sessions,
      /**
       * ⭐⭐ **面板版本号** —— 前端把它显示在页脚，作为一个"我看的是哪一版"的水印。
       *
       * ## 为什么需要它（2026-10-01，排一个 bug 排了很久）
       *
       * 那天后端算得对（直接问这个接口能拿到正确的 `seenBy`），
       * **而界面上一律显示 0** ⇒ 唯一解释是**浏览器跑的旧 `client.js`**，
       * **但界面上没有任何地方能看出来。** ⇒ 只能靠猜。
       *
       * **⚠️ 读的是 `package.json`，但只在挂载时读一次**（不是每次请求现读）。
       * 现读的话，它报的就是"盘上是哪一版"，而不是"跑的是哪一版" ——
       * **那会把这个字段的用处整个抵消掉**（详见上面 `panelVersion` 那段注释）。
       */
      panelVersion,
      /**
       * ⭐ **盘上 `client.js` 里的那个常量**（2026-10-04 加，**每次现读**）。
       *
       * 它是 `panelVersion` 的**补充判据**：两个数对不上时，前端靠它分辨
       * "**浏览器缓存旧了**"（硬刷新 ✓）还是"**发版忘了同步前端常量**"（硬刷新没用 ✗）。
       * 理由与那次真踩到的坑写在上面 `readClientFileVersion()` 的注释里。
       */
      clientFileVersion: readClientFileVersion(),
    };
  };

  /**
   * ⚠️ 用 `inject`（不是 `ctx.get`）—— 这一条在本项目被误判过两次。
   * 用 `ctx.inject` 包住，**Web profile 之外没有这个服务时插件安静地不生效**，而不是抛错。
   *
   * ⚠️ 三个注册**平级**（别嵌套 `ctx.effect`）—— 这一条今天也踩过。
   */
  ctx.effect(() => ctx.inject(['webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/api/office',
    /**
     * ⚠️⚠️ **`async` + `await` 缺一不可**（2026-10-01 踩到）。
     *
     * `readPayload()` 改成 async 之后（因为 `seenBy` 要问平台"哪些会话活着"），
     * 这里如果还是 `sendJson(res, 200, readPayload())`，
     * **传进去的就是一个 Promise** ⇒ `JSON.stringify(Promise)` 是 `"{}"`
     * ⇒ **面板收到一个空响应** ⇒ 界面上所有数字变成 `undefined` ⇒ **全部显示 0。**
     *
     * **⚠️ 而且它不报错**：HTTP 是 200，JSON 是合法的 `{}`，
     * 前端只会觉得"数据都是空的"。**又一个"静默的失败看起来像在工作"**（见 `docs\06`）。
     */
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'method', message: '这个路由只读（GET）' });
        return;
      }
      /**
       * ⚠️ **`req.headers.host` 要传下去** —— `readPayload` 拿它拼公告插件那个接口的地址。
       * **不写死端口**（那台机器上换一次端口，`seenBy` 就会全变成"问不到"）。
       */
      sendJson(res, 200, await readPayload(req?.headers?.host));
    },
  })));

  /**
   * ## ⭐⭐ **`GET /sidebar/api/office/deletions`** —— 删除记录（2026-10-01 加）
   *
   * ### 为什么先做接口、不先做界面
   *
   * > **当时那句话是**：*"如果把删除记录也做成可视化呢？感觉可以给 Claude 再精修优化一下前端代码，
   * > **我们先给它做好接口**。"*
   *
   * **⇒ 所以界面**现在**是最朴素的样子**（一列"时间 · 当时见过数 · 被删的那一行"），
   * **而数据这一侧先说清、做稳** —— 改界面的人不该同时猜数据长什么样。
   *
   * ### 响应形状（**这是给前端用的契约**）
   *
   * ```jsonc
   * {
   *   "ok": true,
   *   "exists": true,            // false = 还没删过（**不是错误**）
   *   "path": "…\\公告-删除记录.md",
   *   "total": 12,               // 文件里一共有几条
   *   "entries": [               // **最近的在前**，最多 `limit` 条
   *     { "at": "2026-10-01 17:03:50", "seenBy": 3, "raw": "- 09-30｜用户｜…" }
   *   ]
   * }
   * ```
   *
   * ⚠️ **`seenBy` 可能是 `null`** —— 那是"**删的时候没问出来**"（记的是 `—`），
   * **不是 0**（"确实没人见过"）。**前端必须把这两档分开显示。**
   *
   * ⚠️ **记录文件本身也是"只追加"的**（它由删除操作写，一次一行）——
   * 所以这里**读全文、倒着给**，和公告那个"最新优先"同一个道理。
   */
  /**
   * ⭐ **本地时间 + 明确偏移**，形如 `2026-10-01 11:58:09-07:00`。
   *
   * ## 为什么不用 `toISOString()`
   *
   * 它给的是 **UTC 且不带标记** —— 读的人会以为那是本机时钟。
   * 这台机器是太平洋时间（UTC-7），于是**记录里的时间比人看到的快 7 小时**，
   * **跨日期时差一天**（下午 5 点删的，记录写成第二天）。
   *
   * ## 为什么也不写"本地时间但不带偏移"
   *
   * 那样**任何人解析时都得猜时区**（包括面板自己）——
   * **那比 UTC 更糟**：UTC 至少是确定的。
   *
   * ⇒ 两个都给：**人一眼能对上自己的钟，机器能无歧义地还原时刻。**
   */
  function localStamp(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const offMin = -d.getTimezoneOffset();
    const sign = offMin < 0 ? '-' : '+';
    const abs = Math.abs(offMin);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  /**
   * ⚠️ **`(\S+ \S+)` 是"日期 时间"两段，第三段（偏移）是可选的** ——
   * 因为**旧记录里没有偏移**（那是 UTC，见下面 `readDeletions` 那段说明）。
   * **⇒ 新旧记录都要读得出来**（不然升级那一刻，以前的记录全变成"读不懂的行"）。
   */
  const DELETION_RE = /^-\s+(\S+ \S+(?:[+-]\d{2}:\d{2})?)(?:Z)?｜删掉一行公告｜当时见过数\s+(\S+)｜(.*)$/u;

  const readDeletions = (limit = 50) => {
    const logPath = join(dirname(announcePath), '公告-删除记录.md');
    const text = readTextOrNull(logPath);
    /** ⚠️ **`exists: false` 是"还没删过"，不是错误** —— 前端据此说"删过之后这里会有记录"。 */
    if (text === null) return { ok: true, exists: false, path: logPath, total: 0, entries: [] };
    const rows = [];
    for (const line of text.split('\n')) {
      const m = DELETION_RE.exec(line.trim());
      if (m === null) continue;                       // 表头/说明/空行：**正常**，跳过
      const seenRaw = m[2];
      rows.push({
        at: m[1],
        /** ⚠️ **`—` 要还原成 `null`**（那是"没问出来"，不是 0）。 */
        seenBy: /^\d+$/u.test(seenRaw) ? Number.parseInt(seenRaw, 10) : null,
        raw: m[3],
      });
    }
    /** ⭐ **最近的在前**（文件是按时间追加的 ⇒ 倒过来就是最新优先）。 */
    const newestFirst = rows.reverse();
    return {
      ok: true,
      exists: true,
      path: logPath,
      total: newestFirst.length,
      entries: newestFirst.slice(0, limit),
    };
  };

  ctx.effect(() => ctx.inject(['webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/api/office/deletions',
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
        sendJson(res, 200, readDeletions());
      } catch (error) {
        ctx.logger?.warn?.(`[bulletin-panel] 删除记录读不了：${String(error?.message ?? error)}`);
        sendJson(res, 500, { ok: false, code: 'failed', message: String(error?.message ?? error) });
      }
    },
  })));

  /** ⭐ **发布**（追加一行）。 */
  ctx.effect(() => ctx.inject(['webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/api/office/announce',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'method', message: '要用 POST' }); return; }
      if (readOnly) { sendJson(res, 403, { ok: false, code: 'read-only', message: '这个面板被配成只读了' }); return; }
      if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, code: 'origin', message: '只接受本机同源的请求' }); return; }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'invalid', message: `请求体不是合法 JSON：${String(error?.message ?? error)}` });
        return;
      }

      const text = String(body?.text ?? '').trim();
      if (text === '') { sendJson(res, 400, { ok: false, code: 'invalid', message: '「一句话」不能为空' }); return; }
      if (text.includes('｜')) {
        sendJson(res, 400, { ok: false, code: 'invalid', message: '正文里不能有全角竖线 ｜（那是字段分隔符）' });
        return;
      }

      const current = readTextOrNull(announcePath);
      if (current === null) { sendJson(res, 404, { ok: false, code: 'not-found', message: `公告文件不存在：${announcePath}` }); return; }
      // ⭐ 乐观锁
      if (String(body?.revision ?? '') !== revisionOf(current)) {
        sendJson(res, 409, { ok: false, code: 'stale', message: '文件已被别处修改，请刷新后重试' });
        return;
      }

      const line = formatAnnounceLine({
        date: todayMmDd(),
        publisher: String(body?.publisher ?? '用户').trim() || '用户',
        text,
        source: body?.source,
        ttlDays: body?.ttlDays,
      });
      const next = `${current.replace(/\s*$/u, '')}\n${line}\n`;
      try {
        writeAnnounceChecked(announcePath, body?.revision, next);
      } catch (error) {
        /**
         * ⭐ **"刚被别人改了"是冲突（409），不是服务器错误（500）**（2026-10-05）——
         * 和上面那道前置检查一个待遇 ✓：让用户刷新重试，而不是告诉他"服务器写失败了" ✓。
         */
        if (error?.code === 'stale') {
          sendJson(res, 409, { ok: false, code: 'stale', message: '文件刚被别处改了（就在要写下去的那一刻），请刷新后重试' });
          return;
        }
        sendJson(res, 500, { ok: false, code: 'write-failed', message: `写文件失败：${String(error?.message ?? error)}` });
        return;
      }
      sendJson(res, 201, { ok: true, line, revision: revisionOf(next) });
    },
  })));

  /** ⭐ **编辑**（改已有的一行，**逐字核对原文**）。 */
  ctx.effect(() => ctx.inject(['webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/api/office/announce/edit',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'method', message: '要用 POST' }); return; }
      if (readOnly) { sendJson(res, 403, { ok: false, code: 'read-only', message: '这个面板被配成只读了' }); return; }
      if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, code: 'origin', message: '只接受本机同源的请求' }); return; }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'invalid', message: `请求体不是合法 JSON：${String(error?.message ?? error)}` });
        return;
      }

      const oldRaw = String(body?.oldRaw ?? '').trim();
      const text = String(body?.text ?? '').trim();
      if (oldRaw === '') { sendJson(res, 400, { ok: false, code: 'invalid', message: '必须给 `oldRaw`（要改的那一行原文）' }); return; }
      if (text === '') { sendJson(res, 400, { ok: false, code: 'invalid', message: '「一句话」不能为空' }); return; }
      if (text.includes('｜')) {
        sendJson(res, 400, { ok: false, code: 'invalid', message: '正文里不能有全角竖线 ｜（那是字段分隔符）' });
        return;
      }

      const current = readTextOrNull(announcePath);
      if (current === null) { sendJson(res, 404, { ok: false, code: 'not-found', message: `公告文件不存在：${announcePath}` }); return; }
      if (String(body?.revision ?? '') !== revisionOf(current)) {
        sendJson(res, 409, { ok: false, code: 'stale', message: '文件已被别处修改，请刷新后重试' });
        return;
      }

      /**
       * ⭐⭐ **逐字找那一行** —— 这是第二道乐观锁（比 `revision` 更精确）。
       *
       * `revision` 保证"整个文件没变过"；这里再保证"**我要改的那一行确实还是那一行**"。
       * ⇒ 两道都对上才写。**任何一道对不上都拒绝，绝不猜"大概是想改那一条吧"。**
       */
      const lines = current.split(/\r?\n/u);
      const at = lines.findIndex((l) => l.trim() === oldRaw);
      if (at === -1) {
        sendJson(res, 404, { ok: false, code: 'not-found', message: '找不到那一行（可能已被删除或改动），请刷新后重试' });
        return;
      }
      const kept = parseAnnouncements(oldRaw);
      const oldDate = kept.entries[0]?.date ?? todayMmDd();
      const newLine = formatAnnounceLine({
        date: oldDate,                                  // ⚠️ **日期保持原样**（改内容不等于改发布日期）
        publisher: kept.entries[0]?.publisher ?? (String(body?.publisher ?? '用户').trim() || '用户'),
        text,
        source: body?.source,
        ttlDays: body?.ttlDays,
      });
      lines[at] = newLine;
      const next = lines.join('\n');
      try {
        writeAnnounceChecked(announcePath, body?.revision, next);
      } catch (error) {
        /**
         * ⭐ **"刚被别人改了"是冲突（409），不是服务器错误（500）**（2026-10-05）——
         * 和上面那道前置检查一个待遇 ✓：让用户刷新重试，而不是告诉他"服务器写失败了" ✓。
         */
        if (error?.code === 'stale') {
          sendJson(res, 409, { ok: false, code: 'stale', message: '文件刚被别处改了（就在要写下去的那一刻），请刷新后重试' });
          return;
        }
        sendJson(res, 500, { ok: false, code: 'write-failed', message: `写文件失败：${String(error?.message ?? error)}` });
        return;
      }
      sendJson(res, 200, { ok: true, line: newLine, revision: revisionOf(next) });
    },
  })));

  /**
   * ## ⭐⭐ `POST /sidebar/api/office/announce/delete` —— **删掉一条公告**
   *
   * ### 为什么用户需要它（2026-10-01 提的）
   *
   * > *"有一些误发的公告和用来测试使用的公告，希望可以被我删掉，还不会污染到其他 ai。"*
   *
   * **原来只能打开文件手动删** —— 那对一个"给人用的界面"来说太糙了。
   *
   * ### ⭐ 它和规矩的关系：**删除属于"用户那一半"**（2026-10-01 正名）
   *
   * > **规矩**：AI 只能追加；**用户可以删改**（见 `docs\01` §五.二）。
   *
   * ⚠️ **这里原来写的是"它和'只增不改'的冲突，我们是知道的"** ——
   * 而那句话把删除说成了**例外**。**按角色写之后它不是例外**：
   * "用户能删改"**本来就在规矩里**，只是旧名字（"只增不改"）在描述文件、把它盖住了。
   *
   * **⚠️ 而它真正要付的代价是有的**（那一半不该藏）：
   * 删掉一行**不会给已经见过它的会话任何信号** ——
   * 你说"那条我删了"，而某个会话**上下文里还留着它、还在按它做事**。
   *
   * 我们一度想做成"**撤回**"（那一行留着、有效期栏写 `撤回`，这样
   * **已经见过它的会话还能收到一句"这条撤回了"**，历史也完整）。
   *
   * **⇒ 用户否掉了，理由很实在**：
   *
   * > *"真正有用的公告不会被撤回和删除，没用的公告也不会被留着几天之后才撤回和删除。"*
   *
   * **⇒ 也就是说："撤回"这个状态在现实中根本不会被用到** ——
   * **那就是一个多余的机制**（正是我们在 `docs\05` 里砍掉的那一类）。
   *
   * ### ⭐ 那"分歧"怎么办（B 方案缺的那半）
   *
   * 直接删掉一行的**真实代价**是：**已经见过它的会话不会收到任何信号**。
   * ⇒ 所以我们**不阻止删除，但让删除"有据"**：
   *
   * | 做什么 | 怎么做 |
   * |---|---|
   * | ⭐ **删之前告诉你"有几个会话的见过记录里有这条"** | **问公告插件的只读接口**（`GET /sidebar/api/announce/seen`）—— 见上面 `fetchSeen` 那段 |
   * | **界面上要你确认** | 前端弹确认框，把那个数字写进去 |
   * | ⭐ **删之后留一行记录** | 往 `公告-删除记录.md` 追一行（`当时见过数 ｜ 被删的那一行原文`） |
   *
   * **⇒ 你仍然可以删**（你的判断比一个数字准），**但你不会是"不知道"地删。**
   *
   * ### 两道锁、原子写 —— 和编辑那条**一模一样**
   *
   * 删除是**比编辑更彻底**的写操作，所以护栏只多不少。
   */
  ctx.effect(() => ctx.inject(['webServer'], (sctx) => sctx.webServer.register({
    kind: 'exact',
    path: '/sidebar/api/office/announce/delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'method', message: '要用 POST' }); return; }
      if (readOnly) { sendJson(res, 403, { ok: false, code: 'read-only', message: '这个面板被配成只读了' }); return; }
      if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, code: 'origin', message: '只接受本机同源的请求' }); return; }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'invalid', message: `请求体不是合法 JSON：${String(error?.message ?? error)}` });
        return;
      }

      const raw = String(body?.raw ?? '').trim();
      if (raw === '') { sendJson(res, 400, { ok: false, code: 'invalid', message: '必须给 `raw`（要删的那一行原文）' }); return; }

      const current = readTextOrNull(announcePath);
      if (current === null) { sendJson(res, 404, { ok: false, code: 'not-found', message: `公告文件不存在：${announcePath}` }); return; }
      /** ⭐ 第一道锁：整个文件没被别人动过。 */
      if (String(body?.revision ?? '') !== revisionOf(current)) {
        sendJson(res, 409, { ok: false, code: 'stale', message: '文件已被别处修改，请刷新后重试' });
        return;
      }

      /**
       * ⭐⭐ 第二道锁：**逐字找到那一行**，而且**只删这一行**。
       *
       * ⚠️ **不用 index，用内容匹配** —— 行号会随别的编辑漂移，
       * 而内容匹配在文件被改过时**会自己失败**（配合 `revision` 就是双保险）。
       *
       * ⚠️⚠️ **`findIndex` 只取第一个匹配** —— 如果文件里有两条一模一样的公告，
       * **只删掉先出现的那条**。（这是对的：**一次操作只删一条**，
       * 想两条都删就再点一次 —— 而点了之后 `revision` 变了，第二次会重新读文件。）
       */
      const lines = current.split(/\r?\n/u);
      const at = lines.findIndex((l) => l.trim() === raw);
      if (at === -1) {
        sendJson(res, 404, { ok: false, code: 'not-found', message: '找不到那一行（可能已被改动或删除），请刷新后重试' });
        return;
      }
      /** ⚠️ **只删那一行**，别的行**一个字节都不动**（包括空行和注释）。 */
      lines.splice(at, 1);
      const next = lines.join('\n');
      try {
        writeAnnounceChecked(announcePath, body?.revision, next);
      } catch (error) {
        /**
         * ⭐ **"刚被别人改了"是冲突（409），不是服务器错误（500）**（2026-10-05）——
         * 和上面那道前置检查一个待遇 ✓：让用户刷新重试，而不是告诉他"服务器写失败了" ✓。
         */
        if (error?.code === 'stale') {
          sendJson(res, 409, { ok: false, code: 'stale', message: '文件刚被别处改了（就在要写下去的那一刻），请刷新后重试' });
          return;
        }
        sendJson(res, 500, { ok: false, code: 'write-failed', message: `写文件失败：${String(error?.message ?? error)}` });
        return;
      }
      /**
       * ⭐⭐ **删除记录**（2026-10-01 重做的 —— 原来是"记一行日志"，那是错的）。
       *
       * ## 原来错在哪（Claude 复查时实测抓到的，两个错叠在一起）
       *
       * ```js
       * ctx.logger?.info?.(`…${seenByCount(sha1(raw))} 个会话还记得它`);
       * //                          ↑ 只传了一个参数 ⇒ live 是 undefined
       * //                            ⇒ `undefined !== null` 为真 ⇒ `undefined.has()`
       * //                            ⇒ **TypeError** ⇒ 抛在写成功之后 ⇒ **200 永远发不出去**
       * sendJson(res, 200, { ok: true, removed: raw, … });   // ← 走不到这里
       * ```
       *
       * **⇒ 症状**：**那一行真的被删掉了，而界面显示"删除没成功"**（或一直停在"删除中"）。
       * **⚠️ 而"删成功却报失败"比"报成功却没删"更危险** ——
       * 用户会**再点一次**，而第二次会删掉另一条（或在别处制造混乱）。
       *
       * ### 而且 `ctx.logger.info` 根本进不了日志文件
       *
       * **这一点我们自己写过**（`dsh-bulletin-dispatch/src/log.js` 第 5 行）：
       * *"`ctx.logger.info` 到不了 `%APPDATA%\dsh-desktop\logs\harness.log`"*。
       * **⇒ 所以就算它不抛错，"删除的痕迹"也从来没留下过。**
       *
       * ## 现在怎么做
       *
       * **往公告文件旁边的一个文件追加一行**（`公告-删除记录.md`）——
       * 那是**用户能翻、能 grep、不会被日志级别吞掉**的地方。
       *
       * ⚠️ **而且它整体包在 try 里**：**记录失败绝不能让一次已经完成的写操作变成失败。**
       * （这条是"承诺的顺序"：**先把事实做完、再记账；账记不上不能反过来否定事实。**）
       */
      const dir = dirname(announcePath);
      const logPath = join(dir, '公告-删除记录.md');
      /** ⭐ **记录记没记上** —— 要如实回给前端（见下面 `logged`）。 */
      let logged = false;
      try {
        /**
         * ## ⚠️⚠️ **时间要写"本地时间 + 偏移"**（2026-10-01 修，Claude 精修时指出）
         *
         * ### 原来错在哪
         *
         * ```js
         * new Date().toISOString().replace('T', ' ').slice(0, 19)   // ⚠️ 这是 UTC，而且不标
         * ```
         *
         * **⇒ 它写的是 UTC，可是读的人以为那是本机时钟。**
         *
         * | | |
         * |---|---|
         * | 这台机器（太平洋时间 UTC-7）**人看到的时钟** | `11:58:09` |
         * | **记录里写的** | `18:58:09` |
         * | 差 | **7 小时 —— 而且跨日期时会差一天**（下午 5 点删的，记录里是第二天） |
         *
         * ### 现在
         *
         * **`2026-10-01 11:58:09-07:00`** —— **本地时间 + 明确的偏移**，两件事都成立：
         * 人能直接对上自己的钟，机器能无歧义地还原成时刻。
         *
         * ⚠️ **不写"本地时间但不带偏移"** —— 那样任何人（包括面板自己）解析时都会
         * 按自己所在时区去猜，**那比 UTC 更糟**（UTC 至少是确定的）。
         */
        const stamp = localStamp();
        /**
         * ## ⭐ "当时见过数"是**前端带上来的**（2026-10-01 改的）
         *
         * ### 为什么不让服务端自己去问
         *
         * 我第一版是"这里再 `fetch` 一次公告插件那个接口" —— **而那是错的**：
         *
         * | 问题 | 说明 |
         * |---|---|
         * | **多一次往返、多一个失败点** | 而这个数字**本来就在手上** |
         * | **服务端猜不到自己的对外地址** | 它得从 `Host` 头推 —— 而那是一次**新的、可能挂掉的**网络调用 |
         * | ⚠️ **而且是同一个数字算两遍** | 前端刚显示过它（"有 N 个会话见过"），服务端再问一遍 —— **两次结果可能不同**，而记录里该写的是"**用户看到的那一个**" |
         *
         * **⇒ 谁已经知道，就让谁带上来。** 这也顺手把"删除记录和界面对不上"这类问题消灭了。
         *
         * ⚠️ **但不能盲信前端**（它是另一个半边）：
         * 只接受**非负整数**，别的值（`undefined` / 字符串 / 负数 / `NaN`）一律记 `—`。
         * **⇒ 一个记不准的数字，比一个如实说"没问出来"的 `—` 糟得多。**
         */
        const carried = body?.seenBy;
        const seen = (typeof carried === 'number' && Number.isInteger(carried) && carried >= 0)
          ? carried
          : '—';
        /**
         * ## ⚠️⚠️ 这一条 2026-10-03 **说清了一次**（原来那两句是自相矛盾的）
         *
         * ### 原来写的是
         *
         * > *"'追加'也要走原子写（不能用 `appendFileSync`）"* ——
         * > 而 `appendFileSync` **不是原子的**，写到一半崩了这个记录文件就成了半截的。
         *
         * ⚠️ **"追加不是原子的"这句是错的。** 真实的区别在**"追加"和"覆盖"**：
         *
         * | 动作 | 会不会写出半截文件 |
         * |---|---|
         * | **追加**（`appendFileSync` / `O_APPEND`） | ❌ **不会** —— 内核保证一次 `write` 落在文件末尾；**崩了也不会留半行** |
         * | **覆盖**（`writeFileSync` 直接写） | ✅ **会** —— 写一半崩了，原内容没了、新内容也不全 |
         *
         * **⇒ 所以规矩的准确说法是**（`docs\04 §八`）：**"要**覆盖**一个文件就原子写"** ——
         * **追加不在它管的范围。**
         *
         * ### ⭐ 而我们仓库里两种写法**并存，而且都对**
         *
         * | 谁 | 对哪个文件 | 怎么写 | 为什么对 |
         * |---|---|---|---|
         * | **公告插件** | `公告.md`（只追加） | `appendFileSync` | **追加是安全的**（见上表） |
         * | **面板（这里）** | `公告-删除记录.md` | **读全文 → 拼一行 → `writeAtomic` 整份写回** | ⚠️ **这里不是纯追加** —— 文件头那几行要**按需补**（见解析里那段），所以它是"读改写"，**必须原子** |
         *
         * **⇒ 一句话**：**不是"追加不能用 append"，而是"这次这个动作不是纯追加"。**
         *
         * ⚠️ **而这条是测试抓出来的** —— 第一版写的就是 `appendFileSync`，
         * 而探针里有一句老断言正好在守它。
         * **⇒ 那条断言写的时候还没有"删除记录"这个功能，它守的是另一件事，却正好命中了这次。**
         * （**而它当时给的理由是错的 —— 这次一并纠正。**）
         */
        /**
         * ⚠️⚠️ **这个变量名不能叫 `body`**（2026-10-01 踩到，而它极难发现）。
         *
         * ## 现场
         *
         * 这个 handler 上面已经有一个 `const body = JSON.parse(await readBody(req))`
         * —— 那是**请求体**。而我在这里又写了一次 `const body = …`（记录文件的内容）。
         *
         * **⇒ 变量名撞车。** 而因为是同一个作用域里的 `const`，
         * 那句 `existing === null ? header : existing` 之前**整个块都处在 `body` 的暂时性死区里**
         * ⇒ 抛 `Cannot access 'body' before initialization`。
         *
         * ## ⚠️ 而它被 try 吞了 —— 所以症状是"静默地什么都不记"
         *
         * ```
         * 删除记录写不进（删除本身已成功）：Cannot access 'body' before initialization
         * ```
         *
         * **每次删除都会打这一行，而删除本身成功、界面也显示成功。**
         * **⇒ 一个"每次都会失败的记账"，看起来和"记账成功"一模一样。**
         *
         * **⇒ 所以叫它 `logText`**（"这个记录文件的内容"）—— 名字说清它是什么，
         * 也就不会再和"请求体"撞车。
         */
        /**
         * ## ⚠️ 这个文件头 2026-10-03 改了两处（外部终审指出）
         *
         * | 原来 | 为什么不对 |
         * |---|---|
         * | *"公告文件本身**只增不改**"* | ⚠️ **那是我们改掉的旧名字** —— 现在的规矩是**按角色写**：AI 只能追加、**用户可以删改**。"只增不改"在描述**文件**，把"用户能删"那一半盖住了 |
         * | *"本文件**早先的记录**用的是 UTC"* | ⚠️ **新装的人根本没有"早先的记录"** —— 那是给从旧版升上来的人看的，**而它会被写进每一份新文件的头里** |
         *
         * **⭐ 判据**：**写进别人文件里的字，要能"对着陌生读者读通"** ——
         * 不能假设读者经历过我们的历史。
         */
        const header = '# 公告删除记录\n\n'
          + '> 面板上的"删除公告"每删一次，就往这里添一行。\n'
          + '> ⚠️ **这是删除唯一会留下的痕迹** —— 公告文件里那一行被真删掉了，不会留在那里。\n'
          + '> 「当时见过数」= 删的那一刻，**有几个会话的「见过」记录里有这条**（`—` 表示没问出来）。\n'
          + '> **时间是本机时间，后面带着时区偏移**（如 `-07:00`）—— 那是为了让人直接对上自己的钟。\n\n';
        const existing = readTextOrNull(logPath);
        const logText = existing === null ? header : existing;
        /**
         * ⚠️⚠️ **存整行，不截断**（2026-10-01 修，Claude 精修时指出）。
         *
         * 原来是 `raw.slice(0, 120)` —— 而**这条记录是"删除唯一留下的痕迹"**：
         * 一条长公告的后半句、「详见」「有效期」**都会没记下来**，
         * 想恢复的时候**贴回去是一行坏行**。
         *
         * **⇒ 而这个文件本来每次就是"整份重写"的** —— 多存几十个字没有任何代价。
         *
         * ⚠️ 面板前端**原来得靠猜**（"到 118 个字就标可能被截过"）；
         * 现在不截了，它那个标记**对新的记录不会再出现**（对旧记录仍然有用）。
         */
        writeAtomic(logPath, `${logText}`
          + `- ${stamp}｜删掉一行公告｜当时见过数 ${seen}｜${raw}\n`);
        /** ⭐ 走到这儿才算**真的记上了**（写文件没抛）。 */
        logged = true;
      } catch (error) {
        /** ⚠️ **只记不抛** —— 删文件已经成功了，账记不上不能反过来否定它。 */
        ctx.logger?.warn?.(`[bulletin-panel] 删除记录写不进（删除本身已成功）：${String(error?.message ?? error)}`);
      }
      /**
       * ⭐⭐ **如实告诉前端"记录记上了没有"**（2026-10-01 加，Claude 精修时提的）。
       *
       * ## 为什么这个字段值得加
       *
       * 删除接口的规矩是"**记账失败不否定删除**" —— 写不进记录**只打一行 warn**，
       * 接口照样回 `ok: true`。**⇒ 所以"删成功了"和"记上了"是两件事，而响应里原来只说前者。**
       *
       * **⚠️ 而它真的静默失败过**（`body` 变量名撞车那次：每次删除都抛、都被 try 吞掉）——
       * **那段时间"删除记录"这三个字是假的**，而接口一直回 `ok: true`。
       *
       * ## 前端拿它做什么
       *
       * 前端原来只能"刷新以后去记录里对一下有没有这一笔"（对得上才补一句"记在…里"）。
       * **有了这个字段就不用猜**：`true` ⇒ 直接说"记在「健康」页的删除记录里"；
       * `false` ⇒ 直接提醒"删掉了，但记录没写上 —— 看后台日志"。
       */
      sendJson(res, 200, {
        ok: true, removed: raw, revision: revisionOf(next), logged,
      });
    },
  })));

  ctx.effect(() => {
    ctx.logger?.info?.('[bulletin-panel] 路由已注册：GET /sidebar/api/office · GET …/deletions'
      + (readOnly ? '（只读模式）'
        : ' · POST …/announce · POST …/announce/edit · POST …/announce/delete'));
  });
}
