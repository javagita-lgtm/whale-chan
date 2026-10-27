/**
 * 端到端：先发卡片（不 @），再单独 @ 问「上面那个视频说了什么」。
 * 验证能沿用历史里的链接。
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
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
const dataDir = mkdtempSync(join(tmpdir(), 'wc-ref-'));

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

const card = {
  app: 'com.tencent.miniapp_01',
  meta: {
    detail_1: {
      title: '我修复了Linux下无法激活Linux的bug',
      desc: '哔哩哔哩',
      qqdocurl: 'https://b23.tv/380HNJD',
    },
  },
};

// 第 1 步：单独发卡片，不 @ 机器人
onebot.pushGroupMessage({
  messageId: 8001,
  groupId: 888,
  userId: 1001,
  nickname: '小明',
  text: '',
  segments: [{ type: 'json', data: { data: JSON.stringify(card) } }],
});
console.log('已发送卡片（不 @）');
await new Promise((r) => setTimeout(r, 2000));

// 第 2 步：@ 机器人，用指代说法提问（本条无链接）
onebot.pushGroupMessage({
  messageId: 8002,
  groupId: 888,
  userId: 1001,
  nickname: '小明',
  text: '上面卡片里的这个视频说了什么？',
  atBot: true,
});
console.log('已发送指代提问（@ 机器人，无链接）');

const sends = await onebot.waitForSends(1, 180_000);
const last = sends[sends.length - 1];
const segs = (last?.params['message'] ?? []) as Array<{ type: string; data?: { text?: string } }>;
const reply = segs.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');

console.log('\n=== 回复 ===');
console.log(`长度: ${reply.length}`);
console.log(reply.slice(0, 400));

const inherited = logs.join('').includes('沿用最近历史里的链接');
const gotBili = logs.join('').includes('B站信息抓取成功');

console.log('\n=== 判定 ===');
console.log(`  ${inherited ? '✅' : '❌'} 沿用了历史里的链接`);
console.log(`  ${gotBili ? '✅' : '❌'} 抓到 B 站信息`);
console.log(`  ${reply.length > 20 ? '✅' : '❌'} 有实质回复`);

bot.kill();
await onebot.stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(inherited && gotBili && reply.length > 20 ? 0 : 1);
