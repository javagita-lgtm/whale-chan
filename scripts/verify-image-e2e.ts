/**
 * 生图端到端验证：真实 ComfyUI + 真实模型 + 真实 QQ 协议链路。
 *
 * 链路：假 OneBot → 机器人 → LLM 翻译 tag → ComfyUI 生成 → 发图
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
const dataDir = mkdtempSync(join(tmpdir(), 'wc-img-'));

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
    IMAGE_GEN_ENABLED: 'true',
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

console.log('\n=== 生图端到端验证 ===');

// 发一条生图指令
onebot.pushGroupMessage({
  messageId: 7001,
  groupId: 888,
  userId: 1001,
  nickname: '小明',
  text: '画一只蓝色的鲸鱼，可爱风格',
  atBot: true,
});

// 等图片发送（send_group_msg 且含 image 段）
let imageSent = false;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const sends = onebot.calls.filter((c) => c.action.startsWith('send_'));
  const img = sends.find((s) => {
    const segs = (s.params['message'] ?? []) as Array<{ type?: string }>;
    return Array.isArray(segs) && segs.some((x) => x.type === 'image');
  });
  if (img) {
    imageSent = true;
    const segs = (img.params['message'] ?? []) as Array<{ type: string; data?: { file?: string } }>;
    const file = segs.find((s) => s.type === 'image')?.data?.file ?? '';
    console.log(`✅ 收到图片发送请求`);
    console.log(`   文件: ${file.slice(0, 100)}`);
    break;
  }
}

const joined = logs.join('');
const triggered = joined.includes('触发生图');
const translated = joined.includes('提示词翻译完成');
const generated = joined.includes('生图完成');
const sent = joined.includes('生图已发送');

console.log('\n=== 判定 ===');
console.log(`  ${triggered ? '✅' : '❌'} 触发词识别`);
console.log(`  ${translated ? '✅' : '❌'} 中文需求翻译成 tag`);
console.log(`  ${generated ? '✅' : '❌'} ComfyUI 生成成功`);
console.log(`  ${sent ? '✅' : '❌'} 图片已发送`);
console.log(`  ${imageSent ? '✅' : '❌'} 假 OneBot 收到 image 消息段`);

// 打印关键日志
console.log('\n--- 关键日志 ---');
for (const l of joined.split('\n').filter((x) => /生图|翻译|ComfyUI/.test(x)).slice(-8)) {
  console.log('  ' + l.slice(0, 200));
}

bot.kill();
await onebot.stop();
rmSync(dataDir, { recursive: true, force: true });

const allOk = triggered && translated && generated && sent && imageSent;
process.exit(allOk ? 0 : 1);
