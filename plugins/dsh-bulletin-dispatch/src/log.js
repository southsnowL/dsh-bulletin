/**
 * 诊断日志：**任何失败都不许冒泡**。
 *
 * 为什么自己写 JSONL 而不是用 `ctx.logger.info`（2026-09-29 实测）：
 *   **`ctx.logger.info` 到不了** `%APPDATA%\dsh-desktop\logs\harness.log`
 *   —— 那边的桥只接 warn/error。于是"加了诊断却什么都看不到"。
 *   现在：`stderr`（进程控制台）+ 自己的 JSONL，两条都留。
 *
 * ⚠️ 本文件属于"**共享**"层 —— 每个功能都用它，但它**绝不能**让插件挂掉。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 把任意值变成可 JSON 化的东西；失败也给可读字符串（永不抛）。 */
export function safe(value) {
  try {
    if (value === undefined) return null;
    JSON.stringify(value);
    return value;
  } catch {
    try { return String(value); } catch { return '<unserializable>'; }
  }
}

/** 错误 → 一行文本（永不抛）。 */
export function errText(error) {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch { return '<unknown error>'; }
}

/** 截断长文本，保留头尾（命令文本的关键信息常常在两头）。 */
export function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…〔省略 ${s.length - max} 字符〕…\n${s.slice(-half)}`;
}

/**
 * 造一个 logger。
 *
 * @param {{ logPath?: string, tag?: string, version?: string }} options
 * @returns {{ log: (kind: string, payload?: object) => void, problems: string[] }}
 */
export function createLog(options = {}) {
  const logPath = typeof options.logPath === 'string' && options.logPath !== '' ? options.logPath : undefined;
  const tag = options.tag ?? 'dispatch';
  const startedAt = Date.now();
  /** 记录过的问题（给状态表/自检用）—— 不抛，只攒着。 */
  const problems = [];
  /** 日志坏掉之后只报一次，避免每步都刷。 */
  let broken = '';

  function log(kind, payload = {}) {
    if (broken !== '') return;
    try {
      if (logPath === undefined) return;
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({
        t: new Date().toISOString(),
        ms: Date.now() - startedAt,
        kind,
        ...payload,
      })}\n`, 'utf8');
    } catch (error) {
      broken = errText(error);
      problems.push(`日志写入失败：${broken}`);
      try { process.stderr.write(`[${tag}] 日志写入失败，之后不再记：${broken}\n`); } catch { /* 算了 */ }
    }
  }

  /** 出问题时要能在控制台看见（JSONL 只有排查时才看）。 */
  function warn(message, payload = {}) {
    problems.push(message);
    log('warn', { message, ...payload });
    try { process.stderr.write(`[${tag}] ${message}\n`); } catch { /* 算了 */ }
  }

  return { log, warn, problems };
}
