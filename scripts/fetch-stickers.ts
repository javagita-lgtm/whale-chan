/**
 * 表情包图库抓取与入库脚本。
 *
 * 数据来源：https://aigengtu.com/DeepSeek娘（梗鲸图库，2030 张 DeepSeek娘表情包）
 * 仅供个人测试使用，请勿二次分发。
 *
 * 流程：
 *   1. 抓列表页，解析出 id + 标题描述
 *   2. 下载原图（webp）到 data/stickers/raw/
 *   3. 用 sharp 转成 JPEG（QQ 对 webp 兼容性不稳）
 *   4. 写入 SQLite：stickers 表 + n-gram 倒排索引表
 *
 * 用法：
 *   pnpm stickers:fetch            # 抓取 + 下载 + 转码 + 入库（全量）
 *   pnpm stickers:fetch --limit 50 # 只处理前 N 张（试跑）
 */

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const LIST_URL = 'https://aigengtu.com/DeepSeek%E5%A8%98';
const IMG_HOST = 'https://img.aigengtu.com';
const IMG_BASE = `${IMG_HOST}/meme`;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const RAW_DIR = join(DATA_DIR, 'stickers', 'raw');
const JPG_DIR = join(DATA_DIR, 'stickers', 'jpg');

export interface StickerMeta {
  id: string;
  title: string;
}

/** 从列表页解析出全部表情包元数据。 */
export async function fetchCatalog(): Promise<StickerMeta[]> {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`列表页请求失败：HTTP ${res.status}`);
  const html = await res.text();

  const re = /href="\/zh\/meme\/(\d+)"[^>]*title="([^"]*)"/g;
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1] as string;
    // 标题里有 HTML 实体，简单反转义
    const title = decodeEntities(m[2] as string);
    if (!map.has(id)) map.set(id, title);
  }
  return [...map.entries()]
    .map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * 下载单张图片。
 *
 * 站点有两套地址：原图 /meme/NNN.webp、预览图 /0_preview/meme/NNN.webp。
 * 原图并非全部存在，所以原图失败时回退到预览图；预览图分辨率略低但够用。
 *
 * 注意：该站 CDN 对高频请求会临时返回 404（并非图片真的不存在），
 * 因此对同一个地址做少量重试，重试时退避等待。
 */
async function downloadRaw(id: string): Promise<Buffer> {
  for (const ext of ['webp', 'jpg', 'png']) {
    const dest = join(RAW_DIR, `${id}.${ext}`);
    if (existsSync(dest)) {
      const { readFile } = await import('node:fs/promises');
      return await readFile(dest);
    }
  }

  // 注意 IMG_BASE 已包含 /meme，预览图目录是站点根下的 0_preview
  const sources = [
    `${IMG_BASE}/${id}.webp`,
    `${IMG_HOST}/0_preview/meme/${id}.webp`,
  ];

  let lastError: Error | null = null;
  for (const url of sources) {
    const isOriginal = url.startsWith(IMG_BASE);
    // 原图大量缺失，404 直接回退到预览图，不做重试（重试只会拖慢整体速度）；
    // 网络类错误才退避重试。
    const maxAttempts = isOriginal ? 1 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 1024) {
            lastError = new Error(`响应过小（${buf.length} 字节）`);
            break;
          }
          await writeFile(join(RAW_DIR, `${id}.webp`), buf);
          return buf;
        }
        lastError = new Error(`HTTP ${res.status}`);
        if (res.status === 404) break; // 404 不会靠等待消失，直接换下一个源
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      } catch (error) {
        lastError = error as Error;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw new Error(`图片 ${id} 下载失败：${lastError?.message ?? '未知'}`);
}

/** webp → jpeg。统一缩放到最大边长 512（表情包够用，减小体积）。 */
async function convertToJpeg(id: string, raw: Buffer): Promise<void> {
  const dest = join(JPG_DIR, `${id}.jpg`);
  if (existsSync(dest)) return;
  await sharp(raw)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toFile(dest);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'aigengtu',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sticker_gram (
  g TEXT NOT NULL,
  sticker_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_gram ON sticker_gram (g);
`;

/**
 * 把文本切成 1~3 字的连续片段（含英文数字），用于倒排索引与查询。
 * 中文没有空格分词，n-gram 是零依赖下最实用的方案。
 */
export function ngrams(text: string, maxLen = 3): Map<string, number> {
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Map<string, number>();
  for (let len = 1; len <= maxLen; len++) {
    for (let i = 0; i + len <= clean.length; i++) {
      const g = clean.slice(i, i + len);
      if (!out.has(g)) out.set(g, len);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(JPG_DIR, { recursive: true });

  console.log('抓取目录...');
  let catalog = await fetchCatalog();
  console.log(`共解析到 ${catalog.length} 张`);
  if (Number.isFinite(limit)) {
    catalog = catalog.slice(0, limit);
    console.log(`按 --limit 限制为前 ${catalog.length} 张`);
  }

  const db = new DatabaseSync(join(DATA_DIR, 'whale-chan.sqlite'));
  db.exec(SCHEMA);

  const insertSticker = db.prepare(
    `INSERT INTO stickers (id, title, file, source, enabled, created_at)
     VALUES (?, ?, ?, 'aigengtu', 1, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, file = excluded.file`,
  );
  const insertGram = db.prepare('INSERT INTO sticker_gram (g, sticker_id) VALUES (?, ?)');
  const deleteGrams = db.prepare('DELETE FROM sticker_gram WHERE sticker_id = ?');

  let ok = 0;
  let failed = 0;
  const start = Date.now();

  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i] as StickerMeta;
    try {
      const raw = await downloadRaw(item.id);
      await convertToJpeg(item.id, raw);
      const file = join('data', 'stickers', 'jpg', `${item.id}.jpg`);

      insertSticker.run(item.id, item.title, file, Date.now());
      deleteGrams.run(item.id);
      for (const g of ngrams(item.title).keys()) insertGram.run(g, item.id);

      ok++;
    } catch (error) {
      failed++;
      console.warn(`  [${item.id}] 失败：${(error as Error).message}`);
    }

    if ((i + 1) % 50 === 0 || i === catalog.length - 1) {
      const pct = (((i + 1) / catalog.length) * 100).toFixed(1);
      const sec = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  进度 ${i + 1}/${catalog.length} (${pct}%) 成功 ${ok} 失败 ${failed} 用时 ${sec}s`);
    }
  }

  db.close();
  console.log(`\n完成：成功 ${ok}，失败 ${failed}`);
  console.log(`图片目录：${JPG_DIR}`);
}

// 仅在直接运行时执行
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/fetch-stickers.ts');
if (isMain) {
  void main().catch((error: unknown) => {
    console.error('抓取失败：', (error as Error).message);
    process.exit(1);
  });
}
