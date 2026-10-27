/** 验收：直接调用 OneBot 往群里发一条消息，确认群发送通道可用。 */
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3001');
let id = 0;
const pending = new Map();
const call = (action, params = {}) =>
  new Promise((resolve) => {
    const eid = ++id;
    pending.set(eid, resolve);
    ws.send(JSON.stringify({ action, params, echo: eid }));
    setTimeout(() => resolve({ error: 'timeout' }), 15000);
  });

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.echo && pending.has(m.echo)) { pending.get(m.echo)(m); pending.delete(m.echo); }
});

ws.on('open', async () => {
  const groupId = process.argv[2] ?? '100000001';
  const text = process.argv[3] ?? '【链路测试】鲸鱼酱已上线，群通道正常 🐋';
  console.log(`发送到群 ${groupId} ...`);
  const r = await call('send_group_msg', {
    group_id: Number(groupId),
    message: [{ type: 'text', data: { text } }],
  });
  console.log(JSON.stringify(r));
  ws.close();
  process.exit(r.status === 'ok' ? 0 : 1);
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => process.exit(1), 30000);
