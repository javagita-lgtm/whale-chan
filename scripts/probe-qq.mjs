/** 通过 OneBot WS 查询小号的群/好友列表，用于确认机器人可聊的对象。 */
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:3001');
let id = 0;
const pending = new Map();

const call = (action, params = {}) =>
  new Promise((resolve, reject) => {
    const eid = ++id;
    pending.set(eid, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo: eid }));
    setTimeout(() => pending.delete(eid), 15000);
  });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.echo && pending.has(msg.echo)) {
    pending.get(msg.echo).resolve(msg);
    pending.delete(msg.echo);
  }
});

ws.on('open', async () => {
  try {
    const login = await call('get_login_info');
    console.log('登录:', JSON.stringify(login.data));

    const groups = await call('get_group_list');
    console.log('\n群列表:');
    if (!groups.data?.length) console.log('  （无群）');
    for (const g of groups.data ?? []) {
      console.log(`  ${g.group_id}  ${g.group_name}  成员 ${g.member_count}`);
    }

    const friends = await call('get_friend_list');
    console.log('\n好友列表:');
    if (!friends.data?.length) console.log('  （无好友）');
    for (const f of friends.data ?? []) {
      console.log(`  ${f.user_id}  ${f.nickname}  备注=${f.remark ?? ''}`);
    }
  } catch (e) {
    console.error('查询失败:', e.message);
  } finally {
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => { console.error('WS 错误:', e.message); process.exit(1); });
setTimeout(() => { console.error('超时'); process.exit(1); }, 40000);
