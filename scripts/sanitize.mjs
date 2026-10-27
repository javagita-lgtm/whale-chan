/**
 * 脱敏脚本：把文档和源码里的真实账号信息替换成占位符。
 *
 * 为什么要单独写脚本：涉及 6 个文件、多种写法（QQ 号、群号、本机用户名），
 * 手工改容易漏，而且以后新增文档时还能复用这一套规则。
 *
 * 用法：node scripts/sanitize.mjs [--check]
 *   --check  只报告，不改文件
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const CHECK_ONLY = process.argv.includes('--check');

/** 真实值 → 占位符。按长度降序替换，避免前缀冲突。 */
const RULES = [
  // 机器人自己的 QQ 号
  { from: '1702996540', to: '1000000001' },
  // 测试群号
  { from: '724585113', to: '100000001' },
  // 另一个群号
  { from: '1107244005', to: '100000002' },
  // 用户自己的 QQ
  { from: '2052827499', to: '1000000002' },
  // 昵称
  { from: '机器人账号', to: '机器人账号' },
  { from: '鲸鱼娘', to: '鲸鱼娘' },
  // 本机用户名（只替换出现在路径里的，避免误伤 "Administrator" 权限描述）
  { from: 'C:\\Users\\Administrator\\', to: 'C:\\Users\\<用户名>\\' },
  { from: 'C:/Users/<用户名>/', to: 'C:/Users/<用户名>/' },
];

/** 要处理的文件类型。 */
const EXTS = new Set(['.ts', '.js', '.mjs', '.ps1', '.json', '.md', '.html', '.bat', '.yaml', '.yml']);

/** 跳过这些目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'logs', 'voicemodel', 'coverage']);

/** 跳过本脚本自身：它必须保留真实值才能做替换。 */
const SELF = join(ROOT, 'scripts', 'sanitize.mjs');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name)) && p !== SELF) out.push(p);
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
