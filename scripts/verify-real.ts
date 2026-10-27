/**
 * 真实模型端到端验证。
 *
 * 与前两个验证脚本不同：这里**不模拟 LLM**，直接调用 .env 中配置的真实端点。
 * 链路：假 OneBot（模拟 NapCat）→ 真实 dist/index.js 进程 → 真实 DeepSeek API → 回复回到假 OneBot。
 *
 * 用途：证明「收到群消息 → 调模型 → 回复」在真实模型上可用，而不只是协议层正确。
 *
 * 运行：pnpm verify:real
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

async function main(): Promise<void> {
  const env0 = parseEnv();
  if (!env0['LLM_API_KEY']) {
    console.error('❌ .env 中未配置 LLM_API_KEY');
    process.exit(1);
  }
  console.log('\n=== 真实模型端到端验证 ===\n');
  console.log(`端点 : ${env0['LLM_BASE_URL']}`);
  console.log(`模型 : ${env0['LLM_MODEL']}`);
  console.log(`Key  : ${env0['LLM_API_KEY'].slice(0, 6)}...（已隐藏）\n`);

  const onebot = new FakeOneBotServer({ port: 0 });
  const onebotPort = await onebot.start();
  const dataDir = mkdtempSync(join(tmpdir(), 'wc-real-'));

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
    LLM_MAX_TOKENS: '1024',
  };

  const bot: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  bot.stdout?.on('data', (d: Buffer) => logs.push(d.toString()));
  bot.stderr?.on('data', (d: Buffer) => logs.push(d.toString()));

  let ok = true;
  try {
    await onebot.waitForConnection(15_000);
    console.log('✅ 机器人已连接假 OneBot\n');

    // ---- 场景 1：@ 机器人闲聊 ----
    console.log('【1】群聊 @ 机器人：「今天好热啊」');
    onebot.pushGroupMessage({
      messageId: 1,
      groupId: 888,
      userId: 1001,
      nickname: '小明',
      text: '鲸鱼酱，今天好热啊',
      atBot: true,
    });
    const sends = await onebot.waitForSends(1, 90_000);
    const reply1 = extractText(sends[0]?.params['message']);
    console.log(`   📨 机器人回复：${reply1}\n`);
    if (!reply1 || reply1.length === 0 || /卡了一下|离线模式/.test(reply1)) {
      throw new Error('回复内容异常');
    }

    // ---- 场景 2：验证上下文记忆（承接上一轮）----
    console.log('【2】同群继续：「那我该干嘛」——验证是否记得上一轮');
    onebot.pushGroupMessage({
      messageId: 2,
      groupId: 888,
      userId: 1001,
      nickname: '小明',
      text: '那我该干嘛',
      atBot: true,
    });
    const sends2 = await onebot.waitForSends(2, 90_000);
    const reply2 = extractText(sends2[1]?.params['message']);
    console.log(`   📨 机器人回复：${reply2}\n`);

    // ---- 场景 3：人格一致性检查 ----
    console.log('【3】问：「你是不是AI」——检查人设约束是否生效');
    onebot.pushGroupMessage({
      messageId: 3,
      groupId: 888,
      userId: 1002,
      nickname: '小红',
      text: '鲸鱼酱你是不是AI啊',
      atBot: true,
    });
    const sends3 = await onebot.waitForSends(3, 90_000);
    const reply3 = extractText(sends3[2]?.params['message']);
    console.log(`   📨 机器人回复：${reply3}\n`);

    // ---- 场景 4：非 @ 消息不应触发 ----
    console.log('【4】未 @ 的消息不应触发回复');
    onebot.pushGroupMessage({
      messageId: 4,
      groupId: 888,
      userId: 1003,
      nickname: '路人',
      text: '我随口说一句',
    });
    await new Promise((r) => setTimeout(r, 2000));
    const countAfter = onebot.calls.filter((c) => c.action.startsWith('send_')).length;
    if (countAfter !== 3) throw new Error(`非 @ 消息误触发了回复（当前 ${countAfter} 条）`);
    console.log('   ✅ 未触发\n');

    console.log('=== 真实模型端到端验证通过 ===');
    console.log('\n--- 机器人关键日志 ---');
    console.log(
      logs
        .join('')
        .split('\n')
        .filter((l) => /登录身份|准备回应|LLM|失败/.test(l))
        .slice(0, 12)
        .join('\n'),
    );
  } catch (error) {
    ok = false;
    console.error(`\n❌ 验证失败：${(error as Error).message}`);
    console.error('\n--- 机器人日志 ---');
    console.error(logs.join('').slice(-2000));
  } finally {
    bot.kill();
    await onebot.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

function extractText(message: unknown): string {
  if (!Array.isArray(message)) return '';
  return message
    .filter((s: { type?: string }) => s.type === 'text')
    .map((s: { data?: { text?: string } }) => s.data?.text ?? '')
    .join('');
}

void main();
