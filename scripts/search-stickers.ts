/**
 * 表情包检索命令行工具，用于调参与验证。
 *
 * 用法：
 *   pnpm stickers:search 好累
 *   pnpm stickers:search "开心得转圈" -n 10
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { StickerIndex } from '../src/core/stickers.js';

const args = process.argv.slice(2);
const limitIdx = args.findIndex((a) => a === '-n' || a === '--limit');
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 8;
const queryWords = limitIdx !== -1 ? args.filter((_, i) => i !== limitIdx && i !== limitIdx + 1) : args;
const query = queryWords.join(' ').trim();

if (!query) {
  console.error('用法：pnpm stickers:search <关键词> [-n 数量]');
  process.exit(1);
}

const db = new DatabaseSync(join(process.cwd(), 'data', 'whale-chan.sqlite'));
const index = new StickerIndex(db);

const total = index.count();
console.log(`图库共 ${total} 张表情包\n`);
if (total === 0) {
  console.log('图库为空，请先运行：pnpm stickers:fetch');
  process.exit(1);
}

const hits = index.search(query, limit, 0.2);
if (hits.length === 0) {
  console.log(`「${query}」没有匹配到表情包`);
} else {
  console.log(`「${query}」的检索结果：`);
  for (const h of hits) {
    console.log(`  [${h.id}] cov=${h.coverage.toFixed(2)} score=${h.score.toFixed(1)}  ${h.title}`);
    console.log(`        ${h.file}`);
  }
}

console.log('\n随机兜底示例：', index.random()?.title ?? '无');
