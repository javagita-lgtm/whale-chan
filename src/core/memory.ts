/**
 * 会话记忆存储（SQLite，走 Node 24 内置的 node:sqlite）。
 *
 * 表设计：
 *   messages   最近消息原文，用于拼装上下文
 *   seen       消息 ID 去重（防平台重推导致重复回复）
 *   kv         键值表，存每群最后回复时间等小状态
 *
 * 只用同步 API（DatabaseSync）：机器人单进程、消息量不大，
 * 同步写入反而避免复杂的并发问题。每个写操作都很短，不会阻塞事件循环。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';

export interface StoredMessage {
  scene: string;
  peerId: string;
  userId: string;
  nickname: string;
  text: string;
  mentionsBot: boolean;
  fromSelf: boolean;
  timestamp: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  scene TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  text TEXT NOT NULL,
  mentions_bot INTEGER NOT NULL DEFAULT 0,
  from_self INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages (platform, scene, peer_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_peer_rec ON messages (platform, scene, peer_id, recorded_at);

CREATE TABLE IF NOT EXISTS seen (
  message_key TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen (ts);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
`;

export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly logger: Logger) {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'whale-chan.sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.logger.info('记忆库已就绪', { file });
  }

  /**
   * 幂等登记一条消息：首次见到返回 true，重复返回 false。
   * 去重键用 platform:scene:peerId:messageId，避免不同群消息 ID 冲突。
   */
  markSeen(key: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO seen (message_key, ts) VALUES (?, ?)');
    const result = stmt.run(key, now);
    return Number(result.changes) > 0;
  }

  /** 清理过期的去重记录（默认保留 1 天）。 */
  pruneSeen(olderThanMs = 24 * 3600_000): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare('DELETE FROM seen WHERE ts < ?');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  /** 追加一条消息，返回其行号（可用于后续精确排除）。 */
  appendMessage(platform: string, msg: StoredMessage): number {
    const stmt = this.db.prepare(
      `INSERT INTO messages
       (platform, scene, peer_id, user_id, nickname, text, mentions_bot, from_self, ts, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      platform,
      msg.scene,
      msg.peerId,
      msg.userId,
      msg.nickname,
      msg.text,
      msg.mentionsBot ? 1 : 0,
      msg.fromSelf ? 1 : 0,
      msg.timestamp,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * 读取某会话最近的消息（按时间升序返回）。
   *
   * 时间窗口基于 recorded_at（本机入库时间）而非平台时间戳：
   * 平台时间戳可能缺失、为 0 或与本地时钟偏差很大，用它会误删正常上下文。
   *
   * @param sinceMs 只取该时间之后入库的记录（毫秒时间戳）
   * @param excludeRowId 需要排除的行号（通常是刚写入的当前消息）
   */
  recentMessages(
    platform: string,
    scene: string,
    peerId: string,
    limit: number,
    sinceMs: number,
    excludeRowId?: number,
  ): StoredMessage[] {
    const stmt = this.db.prepare(
      `SELECT id AS rowId, scene, peer_id AS peerId, user_id AS userId, nickname, text,
              mentions_bot AS mentionsBot, from_self AS fromSelf, ts AS timestamp
       FROM messages
       WHERE platform = ? AND scene = ? AND peer_id = ? AND recorded_at >= ?
         AND (? IS NULL OR id <> ?)
       ORDER BY recorded_at DESC, id DESC
       LIMIT ?`,
    );
    // node:sqlite 不接受 undefined 作为绑定值（报 parameter 7 无法绑定），
    // 调用方不传 excludeRowId 时必须显式给 null。
    const exclude = excludeRowId ?? null;
    const rows = stmt.all(
      platform,
      scene,
      peerId,
      sinceMs,
      exclude,
      exclude,
      limit,
    ) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        scene: String(row['scene']),
        peerId: String(row['peerId']),
        userId: String(row['userId']),
        nickname: String(row['nickname']),
        text: String(row['text']),
        mentionsBot: Number(row['mentionsBot']) === 1,
        fromSelf: Number(row['fromSelf']) === 1,
        timestamp: Number(row['timestamp']),
      }))
      .reverse();
  }

  /** 读取 KV。 */
  getKV(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    const row = stmt.get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  /** 写入 KV。 */
  setKV(key: string, value: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO kv (key, value, updated_ts) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts`,
    );
    stmt.run(key, value, Date.now());
  }

  /** 关闭数据库（进程退出时调用）。 */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}
