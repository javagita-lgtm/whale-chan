/**
 * 语音端到端验证：真实 TTS 服务 + 真实 NapCat 链路（用假 OneBot 拦截）。
 *
 * 链路：假 OneBot → 机器人 → TTS 服务 → wav → send_record
 */

import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { FakeOneBotServer } from '../test/fake-onebot/server.js';

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

const onebot = new FakeOneBotServer({ port: 0 });
const onebotPort = await onebot.start();
const dataDir = mkdtempSync(join(tmpdir(), 'wc-tts-'));

const bot: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
  env: {
    ...process.env,
    ...env,
    ONEBOT_WS_URL: `ws://127.0.0.1:${onebotPort}`,
    BOT_SELF_ID: '10000',
    DATA_DIR: dataDir,
    PERSONA_FILE: join(process.cwd(), 'config', 'persona.json'),
    LOG_LEVEL: 'info',
    TRIGGER_GROUP_COOLDOWN_MS: '0',
    TTS_ENABLED: 'true',
    IMAGE_GEN_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs: string[] = [];
bot.stdout?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
bot.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));

await new Promise<void>((resolve) => {
  const t = setInterval(() => {
    if (logs.join('').includes('已连接 OneBot')) { clearInterval(t); resolve(); }
  }, 200);
  setTimeout(() => { clearInterval(t); resolve(); }, 20_000);
});

console.log('\n=== 语音端到端验证 ===');

onebot.pushGroupMessage({
  messageId: 6001,
  groupId: 888,
  userId: 1001,
  nickname: '小明',
  text: '说一句你好呀，我是鲸鱼酱',
  atBot: true,
});

// 等 record 段发出
let recordSent = false;
let audioPath = '';
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const sends = onebot.calls.filter((c) => c.action.startsWith('send_'));
  const rec = sends.find((s) => {
    const segs = (s.params['message'] ?? []) as Array<{ type?: string }>;
    return Array.isArray(segs) && segs.some((x) => x.type === 'record');
  });
  if (rec) {
    recordSent = true;
    const segs = (rec.params['message'] ?? []) as Array<{ type: string; data?: { file?: string } }>;
    audioPath = segs.find((s) => s.type === 'record')?.data?.file ?? '';
    break;
  }
}

const joined = logs.join('');
const triggered = joined.includes('触发语音合成');
const synthesized = joined.includes('TTS 合成完成');
const sent = joined.includes('语音已发送');

console.log('\n=== 判定 ===');
console.log(`  ${triggered ? '✅' : '❌'} 触发词识别`);
console.log(`  ${synthesized ? '✅' : '❌'} TTS 合成成功`);
console.log(`  ${sent ? '✅' : '❌'} 日志记录已发送`);
console.log(`  ${recordSent ? '✅' : '❌'} 假 OneBot 收到 record 段`);
if (audioPath) {
  console.log(`  音频: ${audioPath}`);
  console.log(`  文件存在: ${existsSync(audioPath) ? '✅' : '❌'}`);
  if (existsSync(audioPath)) {
    const { statSync } = await import('node:fs');
    console.log(`  大小: ${Math.round(statSync(audioPath).size / 1024)} KB`);
  }
}

console.log('\n--- 关键日志 ---');
for (const l of joined.split('\n').filter((x) => /TTS|语音|触发/.test(x)).slice(-6)) {
  console.log('  ' + l.slice(0, 200));
}

bot.kill();
await onebot.stop();
rmSync(dataDir, { recursive: true, force: true });

process.exit(triggered && synthesized && sent && recordSent ? 0 : 1);
