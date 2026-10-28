/**
 * 提交前安全审计：检查敏感信息与大文件。
 *
 * 为什么单独写脚本：Git 一旦提交，密钥就永久留在历史里。
 * 这个脚本在每次提交前跑一遍，成本极低。
 *
 * 用法：node scripts/audit.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'logs', 'voicemodel', 'coverage', 'runtime']);
const EXTS = new Set(['.ts', '.js', '.mjs', '.ps1', '.json', '.md', '.html', '.bat', '.yaml', '.yml', '.example']);

/**
 * 排除审计/脱敏脚本自身。
 * 它们的规则表里必须写着"要匹配什么"，这是检测逻辑不是凭据。
 */
const SKIP_FILES = new Set([
  join(ROOT, 'scripts', 'audit.mjs'),
  join(ROOT, 'scripts', 'sanitize.mjs'),
]);

/**
 * 敏感模式。任一命中都视为不合格。
 *
 * 这里可以直接写真实值——因为 sanitize.mjs 已经显式跳过 audit.mjs，
 * 不会再把它替换掉。（早期没跳过时出过事故：审计正则被替换成占位符，
 * 从此把正常文件全部误报。）
 */
const SECRET_PATTERNS = [
  { name: 'DeepSeek/OpenAI 密钥', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub Token', re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: '明文密码赋值', re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { name: '真实 QQ 号', re: /\b1702996540\b|\b724585113\b|\b1107244005\b|\b2052827499\b/ },
  { name: '本机用户名路径', re: /C:[\\/]Users[\\/]Administrator/ },
  { name: '真实昵称', re: /爱造饭的/ },
];

/** 大文件阈值：超过 1 MB 的不该进代码仓库。 */
const MAX_FILE_BYTES = 1024 * 1024;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (!SKIP_FILES.has(p)) out.push({ path: p, size: st.size, ext: extname(name) });
  }
  return out;
}

const files = walk(ROOT);
const problems = [];

for (const f of files) {
  // 1) 大文件
  if (f.size > MAX_FILE_BYTES) {
    problems.push(`[大文件] ${f.path.replace(ROOT + '\\', '')}  ${(f.size / 1024 / 1024).toFixed(1)} MB`);
    continue;
  }
  // 2) 敏感内容
  if (!EXTS.has(f.ext) && !f.path.endsWith('.env.example')) continue;
  let text;
  try {
    text = readFileSync(f.path, 'utf8');
  } catch {
    continue;
  }
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`[${p.name}] ${f.path.replace(ROOT + '\\', '')}:${line}`);
    }
  }
}

if (problems.length === 0) {
  console.log(`✅ 审计通过：${files.length} 个文件，无敏感信息、无大文件`);
  process.exit(0);
}

console.log(`❌ 发现 ${problems.length} 个问题：`);
for (const p of problems) console.log('  ' + p);
process.exit(1);
