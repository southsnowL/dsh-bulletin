/**
 * 办公室桌位表（`00-通用\桌位表.md`）的解析与读取 —— 2026-10-21 加。
 *
 * ## 为什么桌名从配置搬到办公室文件
 *
 * 原来桌名在 profile 的 `cordis.patch.yml`（`deskNames`）里，有三个毛病：
 *
 * 1. 它是**机器配置**，不是办公室的东西 —— 换台机器就没了，别的桌也看不到。
 * 2. 让 AI 去改它很危险：YAML 写坏一行，应用直接起不来。
 * 3. 它在**挂载时**被读进局部变量（`setup(api)` 里 `const { config } = api`），
 *    改完必须重启 —— 2026-10-20 用户为了一个桌名被迫重启了一次。
 *
 * ⇒ 桌名是**办公室的事实**，和公告、投递状态放在一起，由各桌自己登记。
 * 插件**每次生成状态表时现读**，所以登记完下一次刷新就能看到，不用重启。
 *
 * ## 表格格式（只认这一种）
 *
 * ```
 * | 桌号 | 桌名 | 文件夹 | 职责 |
 * |------|------|--------|------|
 * | 01   | UnityDev | 01-UnityDev | Unity 侧的开发执行 |
 * ```
 *
 * 解析规则很朴素：**以 `| NN |` 开头的行**（NN 两位数字），按 `|` 切列取前四列。
 * 表头、分隔行、说明文字都不会命中。
 *
 * ⚠️ **读不懂不许炸**：文件缺失 / 行不合法 ⇒ 跳过并计数，
 * 让调用方退回默认写法（"桌 NN" —— 那是**准确**的：我们确实不知道它叫什么）。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 一格：去掉首尾空白和包着的反引号。 */
function cell(text) {
  return String(text ?? '').trim().replace(/^`|`$/gu, '').trim();
}

/**
 * 解析桌位表 markdown。
 *
 * @param {string|null|undefined} text
 * @returns {{ rows: Array<{desk:string,name:string,folder:string,duty:string}>, skipped: number }}
 */
export function parseDeskRoster(text) {
  const rows = [];
  let skipped = 0;
  if (typeof text !== 'string') return { rows, skipped };
  for (const line of text.split(/\r?\n/u)) {
    // 只认「| NN |」，两位数字是桌号的约定写法
    if (!/^\s*\|\s*`?\s*\d{2}\s*`?\s*\|/u.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(cell);
    if (cells.length < 2 || cells[1] === '') { skipped += 1; continue; }
    rows.push({ desk: cells[0], name: cells[1], folder: cells[2] ?? '', duty: cells[3] ?? '' });
  }
  return { rows, skipped };
}

/** 桌号 → 桌名（`'05'` → `'私厨经营微信小程序'`）。 */
export function deskNamesOf(rows) {
  const map = {};
  for (const row of rows ?? []) {
    if (row && typeof row.desk === 'string' && row.desk !== '' && typeof row.name === 'string' && row.name !== '') {
      map[row.desk] = row.name;
    }
  }
  return map;
}

/**
 * 把"配置里的桌名"和"桌位表"合起来：**表优先**。
 *
 * 桌位表是办公室的登记（各桌自己加行）；配置里的 `deskNames` 只用来补
 * 表里没有的桌（例如某台机器还没建这张表时的过渡）。
 *
 * @param {Record<string,string>|undefined} configNames
 * @param {Array<{desk:string,name:string}>} rosterRows
 * @returns {Record<string,string>}
 */
export function mergeDeskNames(configNames, rosterRows) {
  return { ...(configNames ?? {}), ...deskNamesOf(rosterRows) };
}

/**
 * 读桌位表。**永远不抛**（状态表不能因为一个 markdown 文件读不了就整份失败）。
 *
 * @param {string} file
 * @returns {{ exists:boolean, rows:Array, skipped:number, error:string|null }}
 */
export function readDeskRoster(file) {
  if (typeof file !== 'string' || file === '') {
    return { exists: false, rows: [], skipped: 0, error: '没有配置桌位表路径' };
  }
  try {
    if (!existsSync(file)) return { exists: false, rows: [], skipped: 0, error: `桌位表不存在：${file}` };
    const parsed = parseDeskRoster(readFileSync(file, 'utf8'));
    return { exists: true, rows: parsed.rows, skipped: parsed.skipped, error: null };
  } catch (error) {
    return { exists: false, rows: [], skipped: 0, error: `桌位表读不了：${String(error?.message ?? error)}` };
  }
}
