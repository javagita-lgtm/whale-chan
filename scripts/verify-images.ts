/** 验证 ComfyUI 生图（真实调用，出图并计时）。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyClient } from '../src/core/comfy.js';
import { createLogger } from '../src/core/logger.js';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const logger = createLogger('comfy-test');
logger.setLevel?.('info');

const client = new ComfyClient({
  baseUrl: env['IMAGE_BASE_URL'] ?? 'http://127.0.0.1:8188',
  outputDir: env['COMFY_OUTPUT_DIR'] ?? 'E:\\comfyUI\\output',
  defaultCheckpoint: env['IMAGE_CHECKPOINT'] ?? 'dreamshaper_8.safetensors',
  logger,
});

console.log('\n=== ComfyUI 连接自检 ===');
const online = await client.ping();
console.log(`  服务在线: ${online ? '✅' : '❌'}`);
if (!online) process.exit(1);

const st = await client.stats();
if (st) {
  console.log(`  版本: ${st.version}`);
  console.log(`  GPU: ${st.gpu}`);
  console.log(`  显存: ${st.vramFreeMB}/${st.vramTotalMB} MB 空闲`);
}

// ---- 基础出图 ----
console.log('\n=== 测试 1：512×512 基础出图 ===');
const t1 = Date.now();
const r1 = await client.generate({
  prompt:
    'masterpiece, best quality, 1girl, solo, blue hair, whale tail, cute anime style, ' +
    'chibi, pastel colors, soft lighting, looking at viewer, upper body',
  negative: 'worst quality, low quality, bad anatomy, bad hands, extra fingers, watermark, text',
  width: 512,
  height: 512,
  steps: 20,
  cfg: 7,
  sampler: 'dpmpp_2m',
  scheduler: 'karras',
});
console.log(`  结果: ${r1 ? '✅ ' + r1.filename : '❌ 失败'}  耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

if (r1) {
  const buf = await client.fetchImage(r1);
  if (buf) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('gen-test-1.png', buf);
    console.log(`  已保存 gen-test-1.png (${Math.round(buf.length / 1024)} KB)`);
  }
}

// ---- 显存占用（生成后） ----
const st2 = await client.stats();
if (st2) console.log(`\n  生成后显存空闲: ${st2.vramFreeMB} MB（占用 ${st2.vramTotalMB - st2.vramFreeMB} MB）`);

// ---- 释放显存 ----
console.log('\n=== 测试 2：释放显存 ===');
const freed = await client.free(true);
await new Promise((r) => setTimeout(r, 3000));
const st3 = await client.stats();
console.log(`  释放请求: ${freed ? '✅' : '❌'}`);
if (st3) console.log(`  释放后显存空闲: ${st3.vramFreeMB} MB（占用 ${st3.vramTotalMB - st3.vramFreeMB} MB）`);

process.exit(r1 ? 0 : 1);
