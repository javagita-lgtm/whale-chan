import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2] || 'data/whale-chan.sqlite');
const q = (s) => { try { return db.prepare(s).all(); } catch (e) { return [{ ERR: e.message }]; } };
console.log('tables   :', q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name).join(', '));
console.log('messages :', q('SELECT COUNT(*) n FROM messages')[0].n);
console.log('seen     :', q('SELECT COUNT(*) n FROM seen')[0].n);
console.log('stickers :', q('SELECT COUNT(*) n FROM stickers')[0].n, '| enabled:', q('SELECT COUNT(*) n FROM stickers WHERE enabled=1')[0].n);
console.log('grams    :', q('SELECT COUNT(*) n FROM sticker_gram')[0].n);
console.log('kv       :', JSON.stringify(q('SELECT key, value FROM kv')));
console.log('peers    :');
for (const r of q('SELECT peer_id, scene, COUNT(*) c, datetime(MAX(recorded_at)/1000, "unixepoch", "localtime") last FROM messages GROUP BY peer_id, scene ORDER BY c DESC LIMIT 10')) {
  console.log('   ', JSON.stringify(r));
}
console.log('sample   :');
for (const r of q('SELECT nickname, substr(text,1,40) t, from_self FROM messages ORDER BY id DESC LIMIT 5')) console.log('   ', JSON.stringify(r));
