/**
 * NapCat 是否支持发送 record（语音消息）—— 技术验证脚本。
 *
 * 直接通过 OneBot WebSocket 连到 NapCat，
 * 发一条 send_group_msg，message 段里带 record，看返回。
 *
 * 用法：
 *   node scripts/test-record.ts <音频绝对路径> [群号]
 */

import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:3001';
const SELF_ID = 1000000001;

const file = process.argv[2];
const groupId = process.argv[3] ?? '100000001';

if (!file) {
  console.error('用法: node scripts/test-record.ts <音频路径> [群号]');
  process.exit(1);
}

// 确认文件存在
try {
  const st = readFileSync(file);
  console.log(`音频文件: ${file}  (${Math.round(st.length / 1024)} KB)`);
} catch {
  console.error(`读不到文件: ${file}`);
  process.exit(1);
}

const ws = new WebSocket(WS_URL);

const pending = new Map<number, (v: unknown) => void>();
let echo = 0;

ws.on('open', () => {
  console.log(`已连接 ${WS_URL}`);
});

ws.on('message', (raw: Buffer) => {
  let evt: { echo?: number; status?: string; retcode?: number; data?: unknown; message?: string };
  try {
    evt = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  if (typeof evt.echo === 'number') {
    const cb = pending.get(evt.echo);
    if (cb) {
      pending.delete(evt.echo);
      cb(evt);
    }
  }
});

function call(action: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++echo;
    pending.set(id, resolve);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`超时: ${action}`));
    }, timeoutMs);
    const wrapped = (v: unknown) => {
      clearTimeout(timer);
      resolve(v);
    };
    pending.set(id, wrapped);
    ws.send(JSON.stringify({ action, params, echo: id }));
  });
}

async function main() {
  await new Promise<void>((r) => {
    if (ws.readyState === WebSocket.OPEN) return r();
    ws.once('open', () => r());
  });

  // 先测基础连通
  const ping = (await call('get_status', {})) as { status?: string };
  console.log(`get_status: ${ping.status}`);

  // 方式 1：record 段（file 传本地绝对路径）
  console.log('\n=== 尝试 1：record 段 + 本地文件路径 ===');
  const r1 = (await call(
    'send_group_msg',
    {
      group_id: Number(groupId),
      message: [{ type: 'record', data: { file } }],
    },
    60000,
  )) as { status?: string; retcode?: number; data?: { message_id?: number }; message?: string };
  console.log(`  返回: status=${r1.status} retcode=${r1.retcode}`);
  if (r1.retcode === 0) {
    console.log(`  ✅ 发送成功 message_id=${r1.data?.message_id}`);
  } else {
    console.log(`  ❌ 失败: ${r1.message ?? JSON.stringify(r1).slice(0, 200)}`);
  }

  // 方式 2：record 段 + file:// 前缀
  if (r1.retcode !== 0) {
    console.log('\n=== 尝试 2：file:// 前缀 ===');
    const r2 = (await call(
      'send_group_msg',
      {
        group_id: Number(groupId),
        message: [{ type: 'record', data: { file: `file:///${file.replace(/\\/g, '/')}` } }],
      },
      60000,
    )) as { status?: string; retcode?: number; data?: { message_id?: number }; message?: string };
    console.log(`  返回: status=${r2.status} retcode=${r2.retcode}`);
    if (r2.retcode === 0) console.log(`  ✅ 成功 message_id=${r2.data?.message_id}`);
    else console.log(`  ❌ 失败: ${r2.message ?? ''}`);
  }

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('异常:', (e as Error).message);
  ws.close();
  process.exit(1);
});
