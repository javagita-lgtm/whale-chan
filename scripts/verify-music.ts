/** 验证音乐 API 客户端（真实网络调用）。 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../src/core/logger.js';
import { MusicClient, formatHit, parseLrc } from '../src/core/music.js';

const logger = createLogger('music-test');
logger.setLevel?.('info');

const client = new MusicClient({ logger, timeoutMs: 30_000 });

console.log('\n=== 1. 搜索 ===');
const hits = await client.search('春日影', { count: 5 });
console.log(`  结果 ${hits.length} 条`);
for (const h of hits.slice(0, 5)) {
  console.log(`    [${h.id}] ${formatHit(h)}`);
}

if (hits.length === 0) {
  console.log('  ❌ 搜索失败，终止');
  process.exit(1);
}

// 优先找 MyGO / CRYCHIC 的版本
const target =
  hits.find((h) => h.artists.some((a) => /mygo|crychic/i.test(a))) ??
  hits[0]!;

console.log(`\n=== 2. 取播放地址（${formatHit(target)}）===`);
const urlRes = await client.getUrl(target.id, { br: 320 });
if (!urlRes) {
  console.log('  ❌ 未取到地址');
  process.exit(1);
}
console.log(`  码率 ${urlRes.br} kbps  大小 ${(urlRes.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  URL 前缀 ${urlRes.url.slice(0, 80)}...`);

console.log('\n=== 3. 歌词 ===');
const lyric = await client.getLyric(target.id);
console.log(`  解析出 ${lyric.length} 行`);
for (const l of lyric.slice(0, 5)) {
  console.log(`    [${l.time.toFixed(2)}s] ${l.text.slice(0, 40)}`);
}

console.log('\n=== 4. 封面 ===');
if (target.picId) {
  const cover = await client.getCover(target.picId);
  console.log(`  ${cover ?? '未取到'}`);
}

console.log('\n=== 5. 下载音频 ===');
const dir = 'E:\\SoulX-Singer\\music-test';
mkdirSync(dir, { recursive: true });
const dest = join(dir, 'song.mp3');
const ok = await client.download(urlRes.url, dest);
if (ok && existsSync(dest)) {
  const mb = statSync(dest).size / 1024 / 1024;
  const dur = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dest,
  ]).toString().trim();
  console.log(`  ✅ ${mb.toFixed(1)} MB  时长 ${Number(dur).toFixed(1)}s`);
} else {
  console.log('  ❌ 下载失败');
}

console.log('\n=== 6. LRC 解析单测（纯函数）===');
const sample = `[00:15.045]悴んだ心
[01:03.421][01:30.500]重复行
[ar:测试歌手]`;
const parsed = parseLrc(sample);
console.log(`  解析 ${parsed.length} 行（应为 3：一行双时间标签展开成 2 行）`);
for (const p of parsed) console.log(`    ${p.time}s  ${p.text}`);
