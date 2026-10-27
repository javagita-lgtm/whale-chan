/**
 * B 站深读端到端验证：抽帧 + 本地 ASR（真实调用）。
 *
 * 直接调 BiliMedia，不经过模型，先确认媒体层能跑通。
 *
 * 运行：npx tsx scripts/verify-media.ts
 */

import { readFileSync } from 'node:fs';
import { BiliMedia, pickStreams, planFrames } from '../src/core/media.js';
import { fetchStreams, BilibiliClient } from '../src/core/bilibili.js';
import { createLogger } from '../src/core/logger.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const logger = createLogger('verify');
logger.info && (logger as unknown as { setLevel?: (l: string) => void }).setLevel?.('debug');

async function main(): Promise<void> {
  const media = new BiliMedia({
    logger,
    ffmpegPath: config.web.ffmpegPath,
    pythonPath: config.web.biliAsrPython,
    transcribeScript: config.web.biliAsrScript,
    asrModel: config.web.biliAsrModel,
    timeoutMs: config.web.timeoutMs,
  });

  console.log('\n=== 环境自检 ===');
  console.log(`ffmpeg 可用: ${media.ffmpegAvailable}  (${config.web.ffmpegPath})`);
  console.log(`ASR 可用:    ${media.asrAvailable}`);
  console.log(`ASR 模型:    ${config.web.biliAsrModel}`);
  console.log(`python:      ${config.web.biliAsrPython}`);

  const bili = new BilibiliClient({ logger, timeoutMs: config.web.timeoutMs });

  // 用 106 秒的短视频测（抽帧 + 转写都够快）
  const bv = 'BV1cj8c6jE7f';
  console.log(`\n=== 目标视频: ${bv} ===`);

  const info = await bili.fetchVideo(`https://www.bilibili.com/video/${bv}`);
  if (!info) {
    console.error('❌ 视频信息获取失败');
    process.exit(1);
  }
  console.log(`标题: ${info.meta.title}`);
  console.log(`时长: ${info.meta.duration}s`);
  console.log(`弹幕: ${info.danmakuTotal} 条（选取 ${info.danmaku.length}）`);

  const streams = await fetchStreams(info.meta.cid, info.meta.bvid, config.web.timeoutMs);
  console.log(`\n音频流: ${streams.audioUrl ? `有 (${Math.round(streams.audioBandwidth / 1000)}kbps)` : '无'}`);
  console.log(`视频流: ${streams.videoUrl ? `有 (${streams.videoHeight}p)` : '无'}`);

  const plan = planFrames(info.meta.duration, config.web.biliMaxFrames);
  console.log(`抽帧计划: 每 ${plan.interval}s 一帧，共 ${plan.count} 帧`);

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  // ---- 抽帧 ----
  console.log('\n=== 抽帧测试 ===');
  if (!streams.videoUrl) {
    console.log('⚠️ 无视频流，跳过');
    results.push({ name: '抽帧', ok: false, detail: '无视频流' });
  } else {
    const t0 = Date.now();
    const frames = await media.extractFrames(
      streams.videoUrl,
      info.meta.duration,
      config.web.biliMaxFrames,
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`抽到 ${frames.length} 帧，耗时 ${elapsed}s`);
    if (frames.length > 0) {
      const kb = Math.round(frames.reduce((s, f) => s + f.bytes, 0) / 1024);
      console.log(`总大小 ${kb} KB，首帧时间 ${frames[0]!.time}s`);
      // 存一张出来给人看
      const first = frames[0]!;
      const b64 = first.dataUrl.split(',')[1]!;
      const { writeFileSync } = await import('node:fs');
      writeFileSync('frame-sample.jpg', Buffer.from(b64, 'base64'));
      console.log('已保存首帧到 frame-sample.jpg');
    }
    results.push({
      name: '抽帧',
      ok: frames.length > 0,
      detail: `${frames.length} 帧 / ${elapsed}s`,
    });
  }

  // ---- 转写 ----
  console.log('\n=== 转写测试 ===');
  if (!streams.audioUrl || !media.asrAvailable) {
    console.log('⚠️ 无音频流或 ASR 不可用，跳过');
    results.push({ name: '转写', ok: false, detail: '跳过' });
  } else {
    const t0 = Date.now();
    const tr = await media.transcribeAudio(streams.audioUrl, info.meta.duration);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (tr) {
      console.log(`转写成功，耗时 ${elapsed}s（${(info.meta.duration / Number(elapsed)).toFixed(1)}x 实时）`);
      console.log(`字符数 ${tr.text.length}，分段 ${tr.lines.length}`);
      console.log('\n--- 转录前 400 字 ---');
      console.log(tr.text.slice(0, 400));
    } else {
      console.log('❌ 转写失败');
    }
    results.push({
      name: '转写',
      ok: tr !== null,
      detail: tr ? `${tr.text.length} 字 / ${elapsed}s` : '失败',
    });
  }

  console.log('\n=== 结果 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\n=== 全部通过 ===' : `\n=== ${failed.length} 项失败 ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证异常：', e);
  process.exit(1);
});
