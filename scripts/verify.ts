/**
 * 协议合规性验证脚本（真实进程、真实 HTTP、真实 WebSocket）。
 *
 * 与 test/ 下的单测不同，这里启动的是**编译后的 dist/index.js 真实进程**，
 * 经由假 OneBot 服务端推送消息，再通过一个**严格校验协议**的假 LLM 服务端
 * 验证：
 *   - 请求体是否符合 OpenAI Chat Completions 规范（model/messages/参数）
 *   - 多轮上下文是否真的按预期携带
 *   - 回复是否被正确清洗后发出、发送格式是否为 OneBot array 格式
 *
 * 用途：在你拿到真实 API Key 之前，先把「协议层」的正确性钉死；
 * 换成真实端点时应只剩配置问题，而不再是代码问题。
 *
 * 运行：pnpm verify
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeOneBotServer } from '../test/fake-onebot/server.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(condition: boolean, name: string, detail?: string): void {
  check(name, condition, detail);
  if (!condition) throw new Error(`断言失败：${name}`);
}

const LLM_REPLY = '**是挺热的**，"你也觉得吧"';

async function main(): Promise<void> {
  const llmRequests: Array<Record<string, unknown>> = [];

  // ---- 严格校验协议的假 LLM 服务 ----
  const llm = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as Record<string, unknown>;
        llmRequests.push(body);

        // 协议校验：端点、鉴权、必填字段
        const authOk = req.headers['authorization'] === 'Bearer test-key-123';
        const pathOk = req.url === '/v1/chat/completions';
        const hasModel = typeof body['model'] === 'string' && (body['model'] as string).length > 0;
        const msgs = body['messages'];
        const msgsOk =
          Array.isArray(msgs) &&
          msgs.length >= 2 &&
          (msgs[0] as Record<string, unknown>)['role'] === 'system' &&
          typeof (msgs[0] as Record<string, unknown>)['content'] === 'string';

        if (!authOk || !pathOk || !hasModel || !msgsOk) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'protocol violation' } }));
          return;
        }

        // 模拟真实上游：首轮返回 429，验证重试链路
        if (llmRequests.length === 1) {
          res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limited' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            model: body['model'],
            choices: [{ index: 0, message: { role: 'assistant', content: LLM_REPLY }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
          }),
        );
      } catch {
        res.writeHead(500).end('{}');
      }
    });
  });

  const llmPort = await new Promise<number>((resolve) => {
    llm.listen(0, '127.0.0.1', () => {
      const addr = llm.address();
      resolve(typeof addr === 'object' && addr !== null ? (addr.port as number) : 0);
    });
  });

  // ---- 假 OneBot ----
  const onebot = new FakeOneBotServer({ port: 0 });
  const onebotPort = await onebot.start();

  const dataDir = mkdtempSync(join(tmpdir(), 'wc-verify-'));
  console.log('\n=== Whale-chan 协议合规性验证 ===\n');
  console.log(`假 OneBot: ws://127.0.0.1:${onebotPort}`);
  console.log(`假 LLM   : http://127.0.0.1:${llmPort}/v1`);
  console.log(`数据目录  : ${dataDir}\n`);

  const env = {
    ...process.env,
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    LLM_API_KEY: 'test-key-123',
    LLM_MODEL: 'deepseek-v4.1-flash',
    LLM_MAX_RETRIES: '2',
    LLM_RETRY_BASE_DELAY_MS: '50',
    ONEBOT_WS_URL: `ws://127.0.0.1:${onebotPort}`,
    BOT_SELF_ID: '10000',
    DATA_DIR: dataDir,
    PERSONA_FILE: join(process.cwd(), 'config', 'persona.json'),
    LOG_LEVEL: 'warn',
    TRIGGER_GROUP_COOLDOWN_MS: '0',
  };

  const bot: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let botErr = '';
  bot.stderr?.on('data', (d: Buffer) => (botErr += d.toString()));

  try {
    // 等待连接
    await onebot.waitForConnection(10_000);

    console.log('【1】群聊中 @ 机器人，且上游首次返回 429');
    onebot.pushGroupMessage({
      messageId: 1,
      groupId: 888,
      userId: 1001,
      nickname: '小明',
      text: '今天好热啊',
      atBot: true,
    });
    const sends = await onebot.waitForSends(1, 8_000);

    assert(llmRequests.length >= 2, '429 后自动重试（LLM 收到 ≥2 次请求）', `实际 ${llmRequests.length} 次`);
    assert(llmRequests[0]?.['model'] === 'deepseek-v4.1-flash', '模型 ID 正确传递');
    assert(
      typeof llmRequests[0]?.['temperature'] === 'number' &&
        typeof llmRequests[0]?.['max_tokens'] === 'number',
      '采样参数按规范传递',
    );

    const systemMsg = (llmRequests[0]?.['messages'] as Array<Record<string, string>>)?.[0];
    const userMsg = (llmRequests[0]?.['messages'] as Array<Record<string, string>>)?.[1];
    assert(systemMsg?.['role'] === 'system', 'system 消息在首位');
    assert(
      (systemMsg?.['content'] ?? '').includes('鲸鱼酱'),
      '人设已注入 system 提示词',
    );
    assert(
      (userMsg?.['content'] ?? '').includes('小明: 今天好热啊'),
      '当前消息进入 user 提示词',
    );
    assert(
      !(userMsg?.['content'] ?? '').includes('[艾特你]'),
      '@ 标记未污染消息正文',
    );

    assert(sends.length === 1, '仅发送一条群消息', `实际 ${sends.length} 条`);
    const sent = sends[0];
    assert(sent?.action === 'send_group_msg', '使用 send_group_msg 动作');
    assert(sent?.params['group_id'] === 888, '群号正确');

    const sentText = JSON.stringify(sent?.params['message']);
    assert(sentText.includes('是挺热的'), '回复内容已送达');
    assert(!sentText.includes('**'), 'Markdown 粗体已清洗');
    assert(!sentText.includes('\\"'), '包裹引号已清洗');

    // ---- 第二轮：验证上下文累积 ----
    console.log('\n【2】同群第二条 @，验证上下文累积');
    onebot.pushGroupMessage({
      messageId: 2,
      groupId: 888,
      userId: 1001,
      nickname: '小明',
      text: '那开空调吧',
      atBot: true,
    });
    await onebot.waitForSends(2, 8_000);
    const secondReq = llmRequests[llmRequests.length - 1];
    const secondUser = (secondReq?.['messages'] as Array<Record<string, string>>)?.[1]?.['content'] ?? '';
    assert(secondUser.includes('那开空调吧'), '第二条当前消息正确');
    assert(secondUser.includes('今天好热啊'), '上一轮用户消息进入历史');
    assert(secondUser.includes('是挺热的'), '机器人自己的回复进入历史');

    // ---- 第三个场景：非 @ 消息不触发 ----
    console.log('\n【3】未 @ 的群消息不应触发');
    const before = llmRequests.length;
    onebot.pushGroupMessage({
      messageId: 3,
      groupId: 888,
      userId: 1002,
      nickname: '小红',
      text: '路过',
    });
    await new Promise((r) => setTimeout(r, 800));
    assert(llmRequests.length === before, '未 @ 消息未调用模型');

    // ---- 第四个场景：私聊 ----
    console.log('\n【4】私聊直接回复');
    onebot.push({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 4,
      user_id: 1001,
      message: [{ type: 'text', data: { text: '悄悄问一句' } }],
      raw_message: '悄悄问一句',
      sender: { user_id: 1001, nickname: '小明' },
    });
    const allSends = await onebot.waitForSends(3, 8_000);
    const priv = allSends.find((c) => c.action === 'send_private_msg');
    assert(priv !== undefined, '私聊使用 send_private_msg');
    assert(priv?.params['user_id'] === 1001, '私聊目标正确');

    console.log('\n=== 全部通过 ===');
  } catch (error) {
    console.error(`\n验证中断：${(error as Error).message}`);
    if (botErr.trim()) console.error(`\n机器人 stderr:\n${botErr}`);
  } finally {
    bot.kill();
    await onebot.stop();
    await new Promise<void>((r) => llm.close(() => r()));
    rmSync(dataDir, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n结果：${passed}/${checks.length} 项检查通过`);
  process.exit(passed === checks.length && checks.length > 0 ? 0 : 1);
}

void main();
