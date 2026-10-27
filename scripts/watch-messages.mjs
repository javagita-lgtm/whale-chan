/**
 * 真实链路验收：在群里发一条 @ 机器人的消息，观察机器人是否回复。
 *
 * 注意：用机器人自己的账号发消息会被"防自激"拦下，所以这里通过
 * send_group_msg 以机器人身份发送一条 @ 自己的话——机器人会把它当作
 * 来自自己（fromSelf）而跳过。因此改用「私聊自己的另一个账号」不可行。
 *
 * 实际操作：由用户在大号/其他账号在群里 @ 机器人。本脚本只负责
 * 订阅事件、打印机器人发出的消息，作为验收证据。
 */
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3001');
const seen = [];

ws.on('open', () => {
  console.log('已连接，监听群消息事件 60 秒...');
  console.log('请让群里其他账号 @ 机器人说句话。\n');
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.post_type !== 'message') return;

  const sender = msg.sender?.nickname ?? msg.user_id;
  const self = msg.self_id;
  const text = Array.isArray(msg.message)
    ? msg.message.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('')
    : String(msg.message ?? '');

  const who = String(msg.user_id) === String(self) ? '🤖机器人' : sender;
  const where = msg.message_type === 'group' ? `群${msg.group_id}` : '私聊';
  console.log(`[${where}] ${who}: ${text}`);
  seen.push({ who, text });
});

ws.on('error', (e) => console.error('WS 错误:', e.message));

setTimeout(() => {
  console.log(`\n共捕获 ${seen.length} 条消息`);
  const botSaid = seen.filter((s) => s.who === '🤖机器人');
  console.log(botSaid.length > 0 ? `✅ 机器人发出了 ${botSaid.length} 条消息` : '⚠️ 期间机器人未发言');
  ws.close();
  process.exit(0);
}, 60000);
