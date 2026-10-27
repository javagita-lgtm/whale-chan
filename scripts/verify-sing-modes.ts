/**
 * 验证三种唱歌模式 + 结语。
 *
 * 关键：结语有 1.2 秒延迟，如果只用固定等待窗口，
 * 上一条的结语会落进下一条的采集范围，造成误判。
 * 所以这里给每条消息留足时间（音频 + 1.2s 延迟 + 结语）。
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
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

const ob = new FakeOneBotServer({ port: 0 });
const port = await ob.start();
const dd = mkdtempSync(join(tmpdir(), 'wc-sm2-'));

const bot: ChildProcess = spawn(process.execPath, ['dist/index.js'], {
  env: {
    ...process.env,
    ...env,
    ONEBOT_WS_URL: `ws://127.0.0.1:${port}`,
    BOT_SELF_ID: '10000',
    DATA_DIR: dd,
    PERSONA_FILE: join(process.cwd(), 'config', 'persona.json'),
    LOG_LEVEL: 'info',
    TRIGGER_GROUP_COOLDOWN_MS: '0',
    SING_ENABLED: 'true',
    SING_AFTERWORD: 'true',
    IMAGE_GEN_ENABLED: 'false',
    TTS_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs: string[] = [];
bot.stdout?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
bot.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));

await new Promise<void>((r) => {
  const t = setInterval(() => {
    if (logs.join('').includes('已连接 OneBot')) { clearInterval(t); r(); }
  }, 200);
  setTimeout(() => { clearInterval(t); r(); }, 20_000);
});

interface Sent { types: string[]; text: string }

/** 读到「数量不再增加」为止（最多等 12 秒）。 */
async function collect(before: number, quietMs = 6000, maxMs = 15_000): Promise<Sent[]> {
  const start = Date.now();
  let lastCount = 0;
  let lastChange = Date.now();

  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 300));
    const n = ob.calls.slice(before).filter((c) => c.action.startsWith('send_')).length;
    if (n !== lastCount) {
      lastCount = n;
      lastChange = Date.now();
    }
    if (n > 0 && Date.now() - lastChange > quietMs) break;
  }

  return ob.calls
    .slice(before)
    .filter((c) => c.action.startsWith('send_'))
    .map((c) => {
      const segs = (c.params['message'] ?? []) as Array<{ type?: string; data?: { text?: string } }>;
      return {
        types: segs.map((s) => String(s.type ?? '')),
        text: segs.map((s) => s.data?.text ?? '').join(''),
      };
    });
}

const cases = [
  {
    text: '唱《春日影》',
    expectRecord: true,
    expectAfterword: /唱完|嗓子|评价|唱好/,
    desc: '片段模式 → 曲库音频 + 结语',
  },
  {
    text: '唱完整的春日影',
    expectRecord: true,
    expectAfterword: /唱完|嗓子|评价|唱好/,
    desc: '整首模式 → 曲库够长则直接发 + 结语',
  },
  {
    text: '我想听春日影',
    expectRecord: true,
    expectAfterword: /原唱|好听|听完|播完/,
    desc: '原唱模式 → 原曲 + 结语',
  },
];

let pass = 0;
for (const [i, c] of cases.entries()) {
  const before = ob.calls.length;
  ob.pushGroupMessage({
    messageId: 9400 + i,
    groupId: 888,
    userId: 1001,
    nickname: 'x',
    text: c.text,
    atBot: true,
  });

  const got = await collect(before);
  const flat = got.flatMap((g) => g.types);
  const hasRecord = flat.includes('record');
  const allText = got.map((g) => g.text).join(' ');
  const hasAfterword = c.expectAfterword.test(allText);

  const ok = hasRecord === c.expectRecord && hasAfterword;
  if (ok) pass++;

  console.log(`\n  ${ok ? '✅' : '❌'} ${c.text}`);
  console.log(`     ${c.desc}`);
  console.log(`     发送 ${got.length} 条: ${got.map((g) => g.types.join('+') || '(空)').join(' | ')}`);
  console.log(`     音频=${hasRecord} 结语=${hasAfterword}`);
  if (allText.trim()) console.log(`     文字: ${allText.slice(0, 90)}`);
}

console.log(`\n=== ${pass}/${cases.length} ===`);

bot.kill();
await ob.stop();
rmSync(dd, { recursive: true, force: true });
process.exit(0);
