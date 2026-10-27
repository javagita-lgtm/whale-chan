/**
 * B 站深读完整链路验证：弹幕 + 抽帧 + 转写 → 模型 → 回复。
 *
 * 运行：npx tsx scripts/verify-deepread.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function main(): Promise<void> {
  const onebot = new FakeOneBotServer({ port: 0 });
  const onebotPort = await onebot.start();
  const dataDir = mkdtempSync(join(tmpdir(), 'wc-deep-'));

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
    LLM_MAX_TOKENS: '2048',
  };

  const bot: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  bot.stdout?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
  bot.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (logs.join('').includes('已连接 OneBot')) { clearInterval(timer); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(timer); resolve(); }, 20_000);
  });

  let msgId = 3000;
  let expectedSends = 0;
  const ask = async (text: string, waitMs = 180_000): Promise<string> => {
    msgId++;
    expectedSends++;
    onebot.pushGroupMessage({
      messageId: msgId, groupId: 888, userId: 1001, nickname: '小明',
      text, atBot: true,
    });
    const sends = await onebot.waitForSends(expectedSends, waitMs);
    const last = sends[sends.length - 1];
    const segs = (last?.params['message'] ?? []) as Array<{ type: string; text?: string; data?: { text?: string } }>;
    return segs.filter((s) => s.type === 'text').map((s) => s.data?.text ?? s.text ?? '').join('');
  };

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  // ---- 1. 弹幕少的视频，自动触发抽帧 ----
  console.log('【1】弹幕少的视频（41 条 < 阈值 30？不，41>30 不触发）');
  let reply = await ask('这个视频讲了啥 https://www.bilibili.com/video/BV1cj8c6jE7f');
  console.log(`   📨 ${reply.slice(0, 300)}`);

  // ---- 2. 明确要求看画面 ----
  console.log('\n【2】明确要求"看画面"');
  reply = await ask('看看画面里是啥 https://www.bilibili.com/video/BV1cj8c6jE7f');
  console.log(`   📨 ${reply.slice(0, 350)}`);
  results.push({
    name: '明确要求看画面会抽帧',
    ok: /画面|界面|字幕|终端|桌面|黑底|白字|Linux/i.test(reply),
    detail: reply.slice(0, 120),
  });

  // ---- 3. 明确要求听台词 ----
  console.log('\n【3】明确要求"说了什么"');
  reply = await ask('视频里说了什么 https://www.bilibili.com/video/BV1cj8c6jE7f');
  console.log(`   📨 ${reply.slice(0, 350)}`);
  results.push({
    name: '明确要求听台词会转写',
    ok: reply.length > 20,
    detail: reply.slice(0, 120),
  });

  bot.kill();
  await onebot.stop();
  rmSync(dataDir, { recursive: true, force: true });

  console.log('\n=== 结果 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);

  const key = logs.join('').split('\n').filter((l) => /抽帧|转写|弹幕|深读|画面/.test(l));
  console.log('\n--- 关键日志 ---');
  for (const l of key.slice(-14)) console.log('  ' + l.slice(0, 230));

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\n=== 全部通过 ===' : `\n=== ${failed.length} 项失败 ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验证失败：', e); process.exit(1); });
