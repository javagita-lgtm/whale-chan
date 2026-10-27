/**
 * 发语音到 QQ 私聊（指定 QQ 号）。
 *
 * 与 send-voice.ts 的区别：这个版本支持更大的文件、
 * 并且把长音频先压缩成 mp3 再发（QQ 语音对 wav 体积敏感）。
 *
 * 用法：
 *   node scripts/send-private-voice.ts <音频路径> <QQ号>
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:3001';

const file = process.argv[2];
const userId = process.argv[3];

if (!file || !userId) {
  console.error('用法: node scripts/send-private-voice.ts <音频路径> <QQ号>');
  process.exit(1);
}

let finalPath = file;
try {
  const st = statSync(file);
  console.log(`原始: ${file}  (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
} catch {
  console.error(`读不到文件: ${file}`);
  process.exit(1);
}

// 超过 8MB 就压成 mp3，避免 QQ 语音发送超时
const sizeMB = statSync(file).size / 1024 / 1024;
if (sizeMB > 8) {
  const out = join(tmpdir(), `voice-${Date.now()}.mp3`);
  console.log('压缩为 mp3 ...');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-b:a', '96k', '-ar', '24000', '-ac', '1', out]);
  finalPath = out;
  console.log(`压缩后: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
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

function call(action: string, params: Record<string, unknown>, timeoutMs = 300_000): Promise<unknown> {
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
    message: [{ type: 'record', data: { file: finalPath } }],
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
