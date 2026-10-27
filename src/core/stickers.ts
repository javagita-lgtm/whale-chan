/**
 * 表情包检索。
 *
 * 方案：中文 n-gram 倒排索引（1~3 字连续片段）。
 * 为什么不用向量检索：实测本机 onnxruntime 创建会话会挂死（cpu/dml 都卡），
 * 在零运维前提下 n-gram 是最稳的落地方案；语义相近但字面不重合的查询会漏召，
 * 这是已知代价，可用 LLM 预先生成同义词来缓解（见 expandQuery）。
 *
 * 打分：命中的 gram 越长权越高（单字 0.3 / 双字 1.0 / 三字 1.5），
 * 再除以查询总权重得到覆盖率，低于阈值视为不相关。
 */

import type { DatabaseSync } from 'node:sqlite';

export interface Sticker {
  id: string;
  title: string;
  file: string;
}

export interface StickerHit extends Sticker {
  score: number;
  /** 覆盖率 0~1，越高越相关 */
  coverage: number;
}

const GRAM_WEIGHT: Record<number, number> = { 1: 0.3, 2: 1.0, 3: 1.5 };

/**
 * 表情包表结构。建表放在这里而不是只在抓取脚本里，
 * 否则换到新电脑（data 目录为空）时启动会直接崩在 count()。
 * 全部 IF NOT EXISTS，对已有库幂等。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'aigengtu',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sticker_gram (
  g TEXT NOT NULL,
  sticker_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_gram ON sticker_gram (g);
`;

/** 把文本切成 1~3 字片段，返回 Map<片段, 长度>。 */
export function queryGrams(text: string, maxLen = 3): Map<string, number> {
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Map<string, number>();
  for (let len = 1; len <= maxLen; len++) {
    for (let i = 0; i + len <= clean.length; i++) {
      const g = clean.slice(i, i + len);
      if (!out.has(g)) out.set(g, len);
    }
  }
  return out;
}

/** 常见口语 → 表情包里的书面说法，弥补纯字面匹配的语义缺口。 */
const SYNONYMS: Record<string, string[]> = {
  累: ['死掉了', '宕机', '摆烂', '躺平'],
  困: ['睡觉', 'deepsleep', '死掉了'],
  饿: ['吃白饭', '干饭', '吃饭'],
  开心: ['笑', '开心', '元气', 'Ciallo'],
  难过: ['哭', '落泪', '委屈'],
  生气: ['气鼓鼓', '暴怒', '愤怒'],
  无语: ['无语', '呆滞', '吐槽'],
  不解: ['疑惑', '问号', '不懂'],
  贵: ['涨价', '便宜货', '加钱'],
  没钱: ['哭穷', '余额', '借钱'],
  忙: ['打工', '加班', '摸鱼'],
  摸鱼: ['摸鱼', '偷懒', '摆烂'],
  可爱: ['可爱', '萌', '女仆'],
  害羞: ['害羞', '脸红', '羞涩'],
  震惊: ['震惊', '惊恐', '吓到'],
  得意: ['得意', '嚣张', '称王'],
  吐槽: ['吐槽', '毒舌', '吐槽'],
  尴尬: ['尴尬', '心虚', '慌'],
  思考: ['思考', 'deepsleep', '深度'],
  下班: ['下班', '摸鱼', '躺'],
};

/**
 * 用同义词扩展查询词：原词 + 每个同义短语各自成一段参与匹配。
 * 这样「累」也能命中「死掉了」这类标题。
 */
export function expandQuery(text: string): string[] {
  const base = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  if (base.length === 0) return [];
  const out = new Set<string>([base]);
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    if (base.includes(key)) {
      for (const s of syns) out.add(s);
    }
  }
  return [...out];
}

export class StickerIndex {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  /** 图库里是否有可用表情包。 */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM stickers WHERE enabled = 1')
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * 检索最相关的表情包。
   * @param query 查询文本（通常是「当前对话情绪/语境」）
   * @param limit 返回条数
   * @param minCoverage 最低覆盖率，低于此值视为不相关
   */
  search(query: string, limit = 5, minCoverage = 0.35): StickerHit[] {
    const variants = expandQuery(query);
    if (variants.length === 0) return [];

    // 汇总所有变体的 gram，原词权重更高
    const gramWeights = new Map<string, number>();
    variants.forEach((v, idx) => {
      const w = idx === 0 ? 1.0 : 0.7; // 同义词略降权
      for (const [g, len] of queryGrams(v)) {
        const score = (GRAM_WEIGHT[len] ?? 0.3) * w;
        gramWeights.set(g, Math.max(gramWeights.get(g) ?? 0, score));
      }
    });
    if (gramWeights.size === 0) return [];

    const grams = [...gramWeights.keys()];
    const placeholders = grams.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.file, GROUP_CONCAT(g.g) AS hitGrams
         FROM sticker_gram g
         JOIN stickers s ON s.id = g.sticker_id
         WHERE g.g IN (${placeholders}) AND s.enabled = 1
         GROUP BY s.id`,
      )
      .all(...grams) as Array<{ id: string; title: string; file: string; hitGrams: string }>;

    const totalWeight = [...gramWeights.values()].reduce((a, b) => a + b, 0);
    const hits: StickerHit[] = [];
    for (const row of rows) {
      const hit = new Set(String(row.hitGrams).split(','));
      let score = 0;
      for (const [g, w] of gramWeights) {
        if (hit.has(g)) score += w;
      }
      const coverage = score / totalWeight;
      if (coverage < minCoverage) continue;
      hits.push({ id: row.id, title: row.title, file: row.file, score, coverage });
    }

    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, limit);
  }

  /** 随机取一张（冷场救场/无关话题兜底用）。 */
  random(excludeIds: string[] = []): Sticker | null {
    const where = excludeIds.length > 0
      ? `WHERE enabled = 1 AND id NOT IN (${excludeIds.map(() => '?').join(',')})`
      : 'WHERE enabled = 1';
    const row = this.db
      .prepare(`SELECT id, title, file FROM stickers ${where} ORDER BY RANDOM() LIMIT 1`)
      .get(...excludeIds) as Sticker | undefined;
    return row ?? null;
  }

  /** 按 id 取。 */
  get(id: string): Sticker | null {
    const row = this.db
      .prepare('SELECT id, title, file FROM stickers WHERE id = ?')
      .get(id) as Sticker | undefined;
    return row ?? null;
  }
}
