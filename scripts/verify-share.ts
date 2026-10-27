/** 端到端：模拟 QQ 小程序卡片消息，验证机器人能识别并抓 B 站。 */
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
const dataDir = mkdtempSync(join(tmpdir(), 'wc-share-'));

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
    LOG_LEVEL_OVERRIDE: 'info',
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

// 构造一条 QQ 小程序卡片消息（B 站分享的真实结构）
const card = {
  app: 'com.tencent.miniapp_01',
  meta: {
    detail_1: {
      title: '我修复了Linux下无法激活Linux的bug',
      desc: '哔哩哔哩',
      qqdocurl: 'https://b23.tv/BV1cj8c6jE7f',
    },
  },
};

onebot.pushGroupMessage({
  messageId: 9001,
  groupId: 888,
  userId: 1001,
  nickname: '小明',
  text: '',
  atBot: true,
  // 用 segments 时 atBot 不生效，必须把 at 段一起写进 segments
  segments: [
    { type: 'at', data: { qq: '10000' } },
    { type: 'json', data: { data: JSON.stringify(card) } },
    { type: 'text', data: { text: ' 这个视频说了什么？' } },
  ],
});

const sends = await onebot.waitForSends(1, 180_000);
const last = sends[sends.length - 1];
const segs = (last?.params['message'] ?? []) as Array<{ type: string; data?: { text?: string } }>;
const reply = segs.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');

console.log('\n=== 卡片消息处理结果 ===');
console.log('回复长度:', reply.length);
console.log(reply.slice(0, 400));

const sawCard = logs.join('').includes('非文本段') || logs.join('').includes('B站信息抓取成功');
const gotBili = logs.join('').includes('B站信息抓取成功');
console.log('\n=== 判定 ===');
console.log(`  ${gotBili ? '✅' : '❌'} 卡片里的链接被解析（触发 B 站抓取）`);
console.log(`  ${reply.length > 20 ? '✅' : '❌'} 有实质回复（${reply.length} 字）`);

bot.kill();
await onebot.stop();
rmSync(dataDir, { recursive: true, force: true });
process.exit(gotBili && reply.length > 20 ? 0 : 1);
