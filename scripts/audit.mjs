/**
 * 提交前安全审计：检查敏感信息与大文件。
 *
 * 为什么单独写脚本：Git 一旦提交，密钥就永久留在历史里。
 * 这个脚本在每次提交前跑一遍，成本极低。
 *
 * 用法：node scripts/audit.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

// 别名为避免与下面用到的 join 重名
const joinPath = join;

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
  // 本地真实值配置与 Gemini 凭据：它们**本来**就装着真实值，
  // 且都已被 gitignore，不会入库 —— 审计它们只会产生噪音。
  join(ROOT, 'scripts', '.sanitize-rules.json'),
  join(ROOT, 'scripts', 'gemini-cookies.json'),
]);

/** 真实值配置（与 sanitize.mjs 共用，且已被 gitignore）。 */
const RULES_FILE = joinPath(process.cwd(), 'scripts', '.sanitize-rules.json');

function loadRealValues() {
  try {
    if (!existsSync(RULES_FILE)) return {};
    return JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const realValues = loadRealValues();

/** 把真实值拼成正则；没有配置时该模式不生效。 */
function reFromReals() {
  const vals = Object.entries(realValues)
    .filter(([k]) => k !== '__USER_PATH__')
    .map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (vals.length === 0) return null;
  return new RegExp(`\\b(?:${vals.join('|')})\\b`);
}

/**
 * 敏感模式。任一命中都视为不合格。
 *
 * 【注意】真实 QQ 号不写死在这里——本仓库是公开的，
 * 写进源码等于把号暴露出去。改为从 `scripts/.sanitize-rules.json` 读，
 * 该文件已被 gitignore，只在本地存在。
 */
const SECRET_PATTERNS = [
  { name: 'DeepSeek/OpenAI 密钥', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub Token', re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: '明文密码赋值', re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { name: 'Gemini 凭据', re: /g\.a000[A-Za-z0-9_-]{20,}|sidts-[A-Za-z0-9_-]{20,}/ },
  // 真实账号：本地配置存在时才启用
  ...(reFromReals() ? [{ name: '真实 QQ 号', re: reFromReals() }] : []),
  { name: '本机用户名路径', re: /C:[\\/]Users[\\/]Administrator/ },
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
