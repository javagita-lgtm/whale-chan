/** 验证视频总结的回复长度是否放宽（真实模型）。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FakeOneBotServer } from '../test/fake-onebot/server.js';

function parseEnv(): Record<string, string> {
  const raw = readFileSync(join(process.cwd(), '.env'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

const env0 = parseEnv();
const onebot = new FakeOneBotServer({ port: 0 });
const onebotPort = await onebot.start();
const dataDir = mkdtempSync(join(tmpdir(), 'wc-len-'));

const env = {
  ...process.env,
  ...env0,
  ONEBOT_WS_URL: `ws://127.0.0.1:${onebotPort}`,
  BOT_SELF_ID: '10000',
  DATA_DIR: dataDir,
  PERSONA_FILE: join(process.cwd(), 'config', 'persona.json'),
  LOG_LEVEL: 'info',
  TRIGGER_GROUP_COOLDOWN_MS: '0',
  BOT_TYPING_DELAY_MAX_MS: '0',
};

const bot: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
  env,
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

let msgId = 5000;
let sends = 0;
const ask = async (text: string, waitMs = 180_000): Promise<string> => {
  msgId++; sends++;
  onebot.pushGroupMessage({
    messageId: msgId, groupId: 888, userId: 1001, nickname: '小明',
    text, atBot: true,
  });
  const all = await onebot.waitForSends(sends, waitMs);
  const last = all[all.length - 1];
  const segs = (last?.params['message'] ?? []) as Array<{ type: string; data?: { text?: string } }>;
  return segs.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');
};

console.log('\n=== 场景 1：视频总结（应放宽到 600）===');
const r1 = await ask('视频里说了什么？ https://www.bilibili.com/video/BV1cj8c6jE7f');
console.log(`长度: ${r1.length} 字`);
console.log(r1.slice(0, 400));
console.log(`\n结尾是否完整: ${/[。！？…）」』]$/.test(r1) ? '✅ 完整收尾' : '⚠️ 可能截断'}`);

console.log('\n=== 场景 2：普通闲聊（应保持 120 内）===');
const r2 = await ask('今天好累啊');
console.log(`长度: ${r2.length} 字`);
console.log(r2.slice(0, 200));

bot.kill();
await onebot.stop();
rmSync(dataDir, { recursive: true, force: true });

console.log('\n=== 判定 ===');
const okRecap = r1.length > 150;
const okChat = r2.length <= 130;
console.log(`  ${okRecap ? '✅' : '❌'} 视频总结放宽（${r1.length} 字 > 150）`);
console.log(`  ${okChat ? '✅' : '❌'} 闲聊保持简短（${r2.length} 字 ≤ 130）`);
process.exit(okRecap && okChat ? 0 : 1);
