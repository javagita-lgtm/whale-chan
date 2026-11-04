/**
 * 脱敏脚本：把文档和源码里的真实账号信息替换成占位符。
 *
 * 为什么要单独写脚本：涉及 6 个文件、多种写法（QQ 号、群号、本机用户名），
 * 手工改容易漏，而且以后新增文档时还能复用这一套规则。
 *
 * 用法：node scripts/sanitize.mjs [--check]
 *   --check  只报告，不改文件
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const CHECK_ONLY = process.argv.includes('--check');

/**
 * 真实值从 `scripts/.sanitize-rules.json` 读（该文件已被 gitignore）。
 *
 * 为什么不写在代码里：本仓库是公开的，把真 QQ 号写进 `RULES` 等于
 * 直接暴露在 GitHub 上——脱敏脚本自己成了泄露源。
 *
 * 本地准备（一次性）：
 *   echo '{"1702996540":"1000000001","724585113":"100000001"}' \
 *     > scripts/.sanitize-rules.json
 */
const RULES_FILE = join(ROOT, 'scripts', '.sanitize-rules.json');

/** 读规则；没有文件时返回空（脚本仍可运行，只是没东西可替换）。 */
function loadRealValues() {
  if (!existsSync(RULES_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  } catch (e) {
    console.error(`读取 ${RULES_FILE} 失败：${e.message}`);
    return {};
  }
}

const realValues = loadRealValues();

/** 真实值 → 占位符。按长度降序替换，避免前缀冲突。 */
const RULES = [
  // 账号/群号：来自本地配置，不写死在代码里
  ...Object.entries(realValues).map(([from, to]) => ({ from, to })),
  // 本机用户名（只替换出现在路径里的，避免误伤 "Administrator" 权限描述）
  // 用户名本身也从配置读，键名写 FULL_USER_PATH
  ...(realValues.__USER_PATH__
    ? [{ from: realValues.__USER_PATH__, to: 'C:\\Users\\<用户名>\\' }]
    : []),
].sort((a, b) => b.from.length - a.from.length);

/** 要处理的文件类型。 */
const EXTS = new Set(['.ts', '.js', '.mjs', '.ps1', '.json', '.md', '.html', '.bat', '.yaml', '.yml']);

/** 跳过这些目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'logs', 'voicemodel', 'coverage']);

/**
 * 跳过脚本自身：它们的规则表里必须写着真实值才能做替换和检测。
 *
 * 【踩过的坑】最初只跳过了 sanitize.mjs 自己，结果 audit.mjs 里的检测正则
 * 被一起替换成了占位符（`/\b1000000001\b/`），审计从此变成误报机器。
 * 两个脚本必须互相排除。
 */
const SKIP_SELF = new Set([
  join(ROOT, 'scripts', 'sanitize.mjs'),
  join(ROOT, 'scripts', 'audit.mjs'),
  // 本地真实值配置：它本来就装着真实值，替换它没意义，
  // 而且它已被 gitignore，不会入库。
  join(ROOT, 'scripts', '.sanitize-rules.json'),
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name)) && !SKIP_SELF.has(p)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let changed = 0;
const report = [];

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  let text = original;
  const hits = [];

  for (const rule of RULES) {
    if (!text.includes(rule.from)) continue;
    const count = text.split(rule.from).length - 1;
    hits.push(`${rule.from} ×${count}`);
    text = text.split(rule.from).join(rule.to);
  }

  if (hits.length === 0) continue;

  const rel = file.replace(ROOT + '\\', '');
  report.push(`  ${rel}\n    ${hits.join('\n    ')}`);

  if (!CHECK_ONLY) {
    writeFileSync(file, text, 'utf8');
    changed++;
  }
}

if (report.length === 0) {
  console.log('✅ 没有发现需要脱敏的内容');
} else {
  console.log(CHECK_ONLY ? '=== 待处理 ===' : '=== 已脱敏 ===');
  console.log(report.join('\n'));
  if (!CHECK_ONLY) console.log(`\n共修改 ${changed} 个文件`);
}
