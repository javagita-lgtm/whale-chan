/**
 * 端到端验证：链接阅读 + 联网搜索（真实接口，不模拟）。
 *
 * 链路：假 OneBot → 真实机器人进程 → DeepSeek Fetch/Search → 真实模型 → 回复。
 *
 * 运行：npx tsx scripts/verify-web.ts
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

  console.log('\n=== 网页能力端到端验证 ===\n');
  console.log(`模型: ${env0['LLM_MODEL']}`);
  console.log(`读链接: ${env0['WEB_LINK_ENABLED'] ?? '(默认 true)'}`);
  console.log(`联网搜索: ${env0['WEB_SEARCH_ENABLED'] ?? '(默认 true)'}\n`);

  const onebot = new FakeOneBotServer({ port: 0 });
  const onebotPort = await onebot.start();
  const dataDir = mkdtempSync(join(tmpdir(), 'wc-web-'));

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

  const ready = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (logs.join('').includes('已连接 OneBot')) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
    setTimeout(() => { clearInterval(timer); resolve(); }, 20_000);
  });
  await ready;

  let msgId = 1000;
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

  // ---- 1. 普通链接 ----
  console.log('【1】发一个普通网页链接');
  let reply = await ask('看看这个 https://api-docs.deepseek.com/zh-cn/guides/search 讲了啥');
  console.log(`   📨 ${reply.slice(0, 200)}`);
  results.push({
    name: '普通链接可读',
    ok: reply.length > 20 && /Search|抓取|搜索|网页/i.test(reply),
    detail: reply.slice(0, 100),
  });

  // ---- 2. B 站链接（视频页只能拿到标题） ----
  console.log('\n【2】发 B 站视频链接');
  reply = await ask('这个视频怎么样 https://www.bilibili.com/video/BV1GJ411x7h7');
  console.log(`   📨 ${reply.slice(0, 220)}`);
  results.push({
    name: 'B站链接拿到标题',
    ok: reply.length > 10,
    detail: reply.slice(0, 100),
  });

  // ---- 3. 联网搜索 ----
  console.log('\n【3】要求联网查询');
  reply = await ask('帮我查一下 DeepSeek V4 是什么时候发布的');
  console.log(`   📨 ${reply.slice(0, 250)}`);
  results.push({
    name: '联网搜索可用',
    ok: reply.length > 20,
    detail: reply.slice(0, 100),
  });

  // ---- 4. 坏链接不应崩 ----
  console.log('\n【4】发一个抓不到的链接');
  reply = await ask('看看 https://example.invalid/nothing-here 说啥');
  console.log(`   📨 ${reply.slice(0, 200)}`);
  results.push({
    name: '坏链接不崩',
    ok: reply.length > 0,
    detail: reply.slice(0, 100),
  });

  bot.kill();
  await onebot.stop();
  rmSync(dataDir, { recursive: true, force: true });

  console.log('\n=== 结果 ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);
  }

  const webLogs = logs.join('').split('\n').filter((l) => /抓取|搜索|网页/.test(l));
  console.log('\n--- 网页相关日志 ---');
  for (const l of webLogs) console.log('  ' + l.slice(0, 220));

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\n=== 全部通过 ===' : `\n=== ${failed.length} 项失败 ===`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证失败：', e);
  process.exit(1);
});
