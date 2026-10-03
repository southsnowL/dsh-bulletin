#!/usr/bin/env node
/**
 * 一键：把本地改动提交并推到 GitHub。
 *
 * ## 怎么用
 *
 * **双击仓库根目录的 `推送.cmd`**（或者在本目录敲 `node 推送.mjs`）。
 * 它会问一句"这次改了什么"，回车后自动 `git add -A` → `commit` → `push`。
 *
 * **提交信息留空**会退化成一句自动的（`更新 10-03 14:22`）——
 * **但建议你自己写一句**，因为 GitHub 每个文件后面显示的就是它。
 *
 * ## ⚠️ 为什么不用"抓 git 输出"的写法
 *
 * 这台机器上的沙箱**不允许一个程序隔着管道抓另一个程序的输出**
 * （Node 的 `spawn` 默认就是这种抓法，会直接 `EPERM` 失败）。
 * **⇒ 所以下面一律用 `stdio: 'inherit'`** —— git 直接把字打到屏幕上，
 * 我们只在它**结束后**读一个退出码。
 *
 * ⚠️ **别把 `stdio` 改成 `'pipe'`** —— 那样在这台机器上会失败，
 * 而在别的机器上又能跑 ⇒ 换机器后很难查出原因。
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 说一句就换行 —— 顺便统一前缀，方便一眼看出是脚本在说还是 git 在说。 */
const say = (s = '') => process.stdout.write(`${s}\n`);

/**
 * 跑一条 git 命令。**输出直接进控制台**（见文件头的说明）。
 *
 * @param {string[]} args git 的参数，**不含 `git` 本身**
 * @param {{ allowFail?: boolean }} [opts] `allowFail` ⇒ 不因非零退出码中止
 * @returns {number} 退出码
 */
function git(args, opts = {}) {
  const r = spawnSync('git', args, { stdio: 'inherit', cwd: HERE, env: { ...process.env, GIT_PAGER: 'cat' } });
  if (r.error !== undefined && r.error !== null) {
    say(`\n⛔ 跑不起来 git：${r.error.message}`);
    say('   ⇒ 先确认装了 Git，并且 `git --version` 能跑。');
    process.exit(2);
  }
  const code = r.status ?? 1;
  if (code !== 0 && opts.allowFail !== true) {
    say(`\n⛔ git ${args.join(' ')} 失败（退出码 ${code}）—— 已停下，没继续往下做。`);
    process.exit(code);
  }
  return code;
}

/** 读一行（用 `readline`，比 `readFileSync(0)` 稳，也不会被沙箱的管道限制影响）。 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

if (!existsSync(join(HERE, '.git'))) {
  say('⛔ 这个目录里没有 .git —— 你是不是把这个文件复制到别处了？');
  say('   ⇒ 把它放回仓库根目录（有 README.md 和 plugins\\ 的那一层）再跑。');
  process.exit(1);
}

say('');
say('══ 推送本地改动 ══════════════════════════════════════════');
say(`   仓库：${HERE}`);
say('');

/** ① 先看有没有东西可提交 —— 没有就直接说清，别让你白推一次。 */
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: HERE, encoding: 'utf8' });
const changed = (dirty.stdout ?? '').trim();
if (changed === '') {
  say('   本地没有未提交的改动。');
  const ahead = spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: HERE, encoding: 'utf8' });
  const n = Number.parseInt((ahead.stdout ?? '0').trim(), 10) || 0;
  if (n === 0) {
    say('   远端也是最新的 —— 什么都不用做。');
    say('');
    process.exit(0);
  }
  say(`   但有 ${n} 个已提交、还没推上去的 —— 那就只推。`);
  say('');
  git(['push']);
  say('\n✅ 推完了。');
  process.exit(0);
}

const files = changed.split('\n');
say(`   要提交的改动：${files.length} 个文件`);
for (const line of files.slice(0, 12)) say(`     ${line.slice(0, 3).trim().padEnd(2)} ${line.slice(3).trim()}`);
if (files.length > 12) say(`     …还有 ${files.length - 12} 个`);
say('');
say('   ⚠️ 上面这些**全都会**提交上去 —— 有不该进的，现在按 Ctrl+C 停下。');
say('');

/** ② 问一句提交信息（留空就用自动的）。 */
const stamp = new Date().toLocaleString('sv-SE').slice(5, 16).replace('T', ' ');
const typed = await ask(`   这次改了什么？（直接回车 = "更新 ${stamp}"）\n   > `);
const message = typed === '' ? `更新 ${stamp}` : typed;
say('');
say(`   提交信息：${message}`);
say('');

/** ③ 三步：add → commit → push。 */
say('── git add ──────────────────────────────────────────────');
git(['add', '-A']);

say('\n── git commit ───────────────────────────────────────────');
git(['commit', '-m', message]);

say('\n── git push ─────────────────────────────────────────────');
git(['push']);

say('\n✅ 完成 —— GitHub 上已经是这一版了。');
say('   （网页刷新一下就能看到；每个文件后面显示的就是刚才那句提交信息。）');
say('');
