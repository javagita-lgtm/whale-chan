/** 验证唱歌端到端：曲库命中 + 指定音色提示。 */
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
const dd = mkdtempSync(join(tmpdir(), 'wc-sing-'));

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

const cases = [
  { text: '唱《春日影》', expect: 'record', desc: '曲库命中 → 直接发音频' },
  { text: '唱一首不存在的歌xyz', expect: 'text', desc: '曲库没有 → 提示会说哪些' },
];

let pass = 0;
for (const [i, c] of cases.entries()) {
  const before = ob.calls.filter((x) => x.action.startsWith('send_')).length;
  ob.pushGroupMessage({
    messageId: 9200 + i,
    groupId: 888,
    userId: 1001,
    nickname: 'x',
    text: c.text,
    atBot: true,
  });

  // 等发送
  let got: { action: string; params: Record<string, unknown> } | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const sends = ob.calls.filter((x) => x.action.startsWith('send_'));
    if (sends.length > before) {
      got = sends[sends.length - 1] as { action: string; params: Record<string, unknown> };
      break;
    }
  }

  if (!got) {
    console.log(`  ❌ ${c.text}: 没有发送`);
    continue;
  }

  const segs = (got.params['message'] ?? []) as Array<{ type?: string; data?: { text?: string; file?: string } }>;
  const hasRecord = segs.some((s) => s.type === 'record');
  const hasText = segs.some((s) => s.type === 'text');
  const actual = hasRecord ? 'record' : hasText ? 'text' : 'other';
  const ok = actual === c.expect;
  if (ok) pass++;

  console.log(`  ${ok ? '✅' : '❌'} ${c.text}`);
  console.log(`     ${c.desc}`);
  console.log(`     期望 ${c.expect}，实际 ${actual}`);
  if (hasText) {
    const txt = segs.find((s) => s.type === 'text')?.data?.text ?? '';
    console.log(`     文字: ${txt.slice(0, 80)}`);
  }
}

console.log(`\n=== ${pass}/${cases.length} 通过 ===`);

bot.kill();
await ob.stop();
rmSync(dd, { recursive: true, force: true });
process.exit(pass === cases.length ? 0 : 1);
