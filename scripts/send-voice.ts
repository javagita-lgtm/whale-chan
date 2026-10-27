/**
 * 把文件作为语音消息发到指定 QQ 私聊。
 *
 * 为什么单独写：test-record.ts 只发群，这里要发私聊。
 *
 * 用法：
 *   node scripts/send-voice.ts <音频路径> <QQ号>
 */

import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:3001';

const file = process.argv[2];
const userId = process.argv[3];

if (!file || !userId) {
  console.error('用法: node scripts/send-voice.ts <音频路径> <QQ号>');
  process.exit(1);
}

try {
  const st = readFileSync(file);
  console.log(`音频: ${file}  (${Math.round(st.length / 1024)} KB)`);
} catch {
  console.error(`读不到文件: ${file}`);
  process.exit(1);
}

const ws = new WebSocket(WS_URL);
const pending = new Map<number, (v: unknown) => void>();
let echo = 0;

ws.on('message', (raw: Buffer) => {
  let evt: { echo?: number };
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

function call(action: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++echo;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`超时: ${action}`));
    }, timeoutMs);
    pending.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    ws.send(JSON.stringify({ action, params, echo: id }));
  });
}

async function main() {
  await new Promise<void>((r) => {
    if (ws.readyState === WebSocket.OPEN) return r();
    ws.once('open', () => r());
  });

  const res = (await call('send_private_msg', {
    user_id: Number(userId),
    message: [{ type: 'record', data: { file } }],
  })) as { status?: string; retcode?: number; data?: { message_id?: number }; message?: string };

  console.log(`返回: status=${res.status} retcode=${res.retcode}`);
  if (res.retcode === 0) console.log(`✅ 已发送 message_id=${res.data?.message_id}`);
  else console.log(`❌ 失败: ${res.message ?? ''}`);

  ws.close();
  process.exit(res.retcode === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('异常:', (e as Error).message);
  ws.close();
  process.exit(1);
});
