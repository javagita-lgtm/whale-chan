/**
 * B 站视频理解端到端验证（真实接口 + 真实模型）。
 *
 * 链路：假 OneBot → 真实机器人 → B站弹幕/评论接口 → 真实模型 → 回复
 *
 * 运行：npx tsx scripts/verify-bili.ts
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
  if (!env0['LLM_API_KEY']) {
    console.error('❌ .env 中未配置 LLM_API_KEY');
    process.exit(1);
  }

  console.log('\n=== B 站视频理解端到端验证 ===\n');

  const onebot = new FakeOneBotServer({ port: 0 });
  const onebotPort = await onebot.start();
  const dataDir = mkdtempSync(join(tmpdir(), 'wc-bili-'));

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
      if (logs.join('').includes('已连接 OneBot')) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
    setTimeout(() => { clearInterval(timer); resolve(); }, 20_000);
  });

  let msgId = 2000;
  let expectedSends = 0;
  const ask = async (text: string, waitMs = 90_000): Promise<string> => {
    msgId++;
    expectedSends++;
    onebot.pushGroupMessage({
      messageId: msgId,
      groupId: 888,
      userId: 1001,
      nickname: '小明',
      text,
      atBot: true,
    });
    const sends = await onebot.waitForSends(expectedSends, waitMs);
    const last = sends[sends.length - 1];
    const segs = (last?.params['message'] ?? []) as Array<{ type: string; data?: { text?: string } }>;
    return segs.filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');
  };

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  // ---- 1. 经典 MV（弹幕多、有梗） ----
  console.log('【1】发 B 站视频链接（弹幕 1200 条）');
  let reply = await ask('看看这个 https://www.bilibili.com/video/BV1GJ411x7h7');
  console.log(`   📨 ${reply.slice(0, 260)}`);
  results.push({
    name: 'B站链接能聊内容',
    ok: reply.length > 20,
    detail: reply.slice(0, 100),
  });

  // ---- 2. b23 短链 ----
  console.log('\n【2】发 b23.tv 短链');
  reply = await ask('https://b23.tv/av170001 这个咋样');
  console.log(`   📨 ${reply.slice(0, 260)}`);
  results.push({
    name: '短链可解析',
    ok: reply.length > 20,
    detail: reply.slice(0, 100),
  });

  // ---- 3. 长视频（知识区，看弹幕是否足够支撑总结） ----
  console.log('\n【3】发 29 分钟知识区视频');
  reply = await ask('https://www.bilibili.com/video/BV1HWJa61E9M 讲了啥');
  console.log(`   📨 ${reply.slice(0, 300)}`);
  results.push({
    name: '长视频能给出概括',
    ok: reply.length > 30,
    detail: reply.slice(0, 100),
  });

  // ---- 4. 不存在的视频 ----
  console.log('\n【4】发一个不存在的视频号');
  reply = await ask('https://www.bilibili.com/video/BV1xxxxxxxxx');
  console.log(`   📨 ${reply.slice(0, 200)}`);
  results.push({
    name: '坏视频号不崩',
    ok: reply.length > 0,
    detail: reply.slice(0, 100),
  });

  bot.kill();
  await onebot.stop();
  rmSync(dataDir, { recursive: true, force: true });

  console.log('\n=== 结果 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);

  const biliLogs = logs.join('').split('\n').filter((l) => /B站|弹幕|bili/i.test(l));
  console.log('\n--- B站相关日志 ---');
  for (const l of biliLogs) console.log('  ' + l.slice(0, 240));

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\n=== 全部通过 ===' : `\n=== ${failed.length} 项失败 ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证失败：', e);
  process.exit(1);
});
