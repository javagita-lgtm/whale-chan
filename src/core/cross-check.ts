/**
 * 多源交叉验证：把多个搜索词的结果合并、去重、排序、判断是否互相矛盾。
 *
 * 为什么需要（一直是已知短板）：
 *   现在只搜一次，拿回 5 条就交给模型。
 *   如果一条说"真"、一条说"假"，模型可能随便挑一个，
 *   而且没有任何信号告诉它"这次证据本身就不一致"。
 *
 * 设计：
 *   1. 用 2~3 个不同角度的搜索词分别搜（原查询 + 实体 + 质疑角度）
 *   2. 按 URL / 标题去重
 *   3. **按日期倒序排**，并标注"这是几个月前的报道"
 *   4. 统计「信源多样性」（不同站点数）和「时间跨度」
 *   5. 用关键词做粗粒度的立场判断：有没有明确否定/辟谣的说法
 *   6. 把"证据强度"明确写进上下文，让模型知道该谨慎还是该确信
 *
 * 注意：这里不做语义层面的真假判断，只做**证据质量评估**。
 *       真假判断交给模型，我们只负责把"这批证据可不可靠"说清楚。
 */

import type { SearchHit } from './web.js';

/** 一条带时间标注的命中。 */
export interface RankedHit extends SearchHit {
  /** 归一化后的日期（YYYY-MM-DD），没有则为 null */
  normalizedDate: string | null;
  /** 距今多少天（没有日期则为 null） */
  ageDays: number | null;
  /** 时效性标签，如「今天的报道」「1 个月前」 */
  freshness: string;
}

/** 一次交叉验证的结果。 */
export interface CrossCheckResult {
  /** 去重合并并按日期倒序排好后的命中 */
  hits: RankedHit[];
  /** 实际用到的搜索词 */
  queries: string[];
  /** 不同站点数 */
  siteCount: number;
  /** 最早的日期（YYYY-MM-DD），没有日期则为 null */
  earliest: string | null;
  /** 最晚的日期 */
  latest: string | null;
  /** 是否检测到互相矛盾的说法 */
  conflicting: boolean;
  /** 证据强度评估 */
  strength: 'strong' | 'medium' | 'weak';
  /** 给模型看的说明 */
  note: string;
}

/** 否定/辟谣类措辞（用于粗判是否有相反说法）。 */
const DENY_WORDS = /(辟谣|谣言|假的|不实|伪造|P图|合成|系伪造|并无此事|不属实|否认|澄清)/;

/** 权威来源特征（用于评估证据强度）。 */
const AUTHORITATIVE = /(gov\.cn|xinhuanet|people\.com\.cn|cctv|cri\.cn|chinanews|thepaper|caixin|reuters|bbc|apnews|nytimes|bloomberg)/i;

/** 低质量来源特征。 */
const LOW_QUALITY = /(tieba\.baidu|zhihu\.com\/question|weibo\.com|douban\.com|bilibili\.com\/video)/i;

/**
 * 从多条命中里提取日期。
 *
 * 日期格式不统一（2026-10-27 / 2026/10/27 / 2026年10月27日），
 * 统一转成 YYYY-MM-DD 便于比较。
 */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // 已经是 ISO 格式
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // 2026/10/27
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  if (slash) {
    return `${slash[1]}-${slash[2]!.padStart(2, '0')}-${slash[3]!.padStart(2, '0')}`;
  }
  // 2026年10月27日
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (cn) {
    return `${cn[1]}-${cn[2]!.padStart(2, '0')}-${cn[3]!.padStart(2, '0')}`;
  }
  return null;
}

/** 按 URL 和标题去重。 */
export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: SearchHit[] = [];

  for (const h of hits) {
    // URL 归一化：去掉协议和尾部斜杠/查询串
    const urlKey = h.url
      .replace(/^https?:\/\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
    const titleKey = h.title.trim().toLowerCase().slice(0, 40);

    if (urlKey.length > 0 && seenUrl.has(urlKey)) continue;
    if (titleKey.length > 0 && seenTitle.has(titleKey)) continue;

    if (urlKey.length > 0) seenUrl.add(urlKey);
    if (titleKey.length > 0) seenTitle.add(titleKey);
    out.push(h);
  }
  return out;
}

/** 取 URL 的站点域名（用于统计信源多样性）。 */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 把日期转成「多久以前」的标签。
 *
 * 为什么需要：只有 YYYY-MM-DD 的话，模型不一定能意识到
 * "2026-03-18" 是七个多月前的旧闻，可能当成最新消息引用。
 * 明确写成「7 个月前」它能立刻判断时效性。
 *
 * @param normalized YYYY-MM-DD
 * @param today 今天的 YYYY-MM-DD（便于测试注入）
 */
export function freshnessLabel(normalized: string | null, today?: string): string {
  if (!normalized) return '时间不详';

  const base = today ?? todayStr();
  const a = Date.parse(`${normalized}T00:00:00Z`);
  const b = Date.parse(`${base}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return '时间不详';

  const days = Math.round((b - a) / 86_400_000);

  if (days < 0) return '日期在未来，可能不可靠';
  if (days === 0) return '今天的报道';
  if (days === 1) return '昨天的报道';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;

  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months > 0 ? `${years} 年 ${months} 个月前` : `${years} 年前`;
}

/** 今天的 YYYY-MM-DD（本地时区）。 */
export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 计算「距今多少天」。
 */
export function ageInDays(normalized: string | null, today?: string): number | null {
  if (!normalized) return null;
  const base = today ?? todayStr();
  const a = Date.parse(`${normalized}T00:00:00Z`);
  const b = Date.parse(`${base}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 给人气加时效标签，并按日期倒序排。
 *
 * 排序规则：
 *   1. 有日期的排在前面（新鲜的先看）
 *   2. 日期相同的按原有顺序（保持搜索引擎的相关性排序）
 *   3. **没日期的排最后**——它们可能是常青页面，也可能是无法判断时效的内容，
 *      不该占最好的位置
 *
 * 为什么要这个顺序：搜索接口返回的是相关性排序，不是时间排序。
 * 实测搜「胡塞武装 沙特」时，2026-03 的旧闻和 2026-10 的新闻混在一起，
 * 如果模型引用旧闻当现状，结论就错了。
 */
export function rankByDate(hits: SearchHit[], today?: string): RankedHit[] {
  const ranked: RankedHit[] = hits.map((h) => {
    const normalizedDate = normalizeDate(h.date);
    return {
      ...h,
      normalizedDate,
      ageDays: ageInDays(normalizedDate, today),
      freshness: freshnessLabel(normalizedDate, today),
    };
  });

  return ranked.sort((a, b) => {
    // 有日期的优先
    if (a.normalizedDate && !b.normalizedDate) return -1;
    if (!a.normalizedDate && b.normalizedDate) return 1;
    if (!a.normalizedDate && !b.normalizedDate) return 0;
    // 都是日期：ageDays 越小越新，小的排前面
    return (a.ageDays ?? 0) - (b.ageDays ?? 0);
  });
}

/**
 * 评估一批命中的证据质量。
 *
 * 判定规则（保守）：
 *   strong: >=3 个不同站点，且至少 1 个权威来源，且没有互相矛盾的措辞
 *   weak:   <=1 个站点，或全部是低质量来源
 *   medium: 其他
 */
export function assessEvidence(hits: SearchHit[]): {
  siteCount: number;
  earliest: string | null;
  latest: string | null;
  conflicting: boolean;
  strength: 'strong' | 'medium' | 'weak';
} {
  const sites = new Set(hits.map((h) => siteOf(h.url)).filter((s) => s.length > 0));
  const siteCount = sites.size;

  const dates = hits
    .map((h) => normalizeDate(h.date))
    .filter((d): d is string => d !== null)
    .sort();
  const earliest = dates[0] ?? null;
  const latest = dates[dates.length - 1] ?? null;

  // 立场冲突：既要看有没有否定词，也要看否定词是不是只出现在辟谣标题里
  // （"辟谣：某某是假的" 其实是在支持"这是假的"这个结论）
  const allText = hits.map((h) => `${h.title} ${h.summary}`).join(' ');
  const denyCount = (allText.match(new RegExp(DENY_WORDS.source, 'g')) ?? []).length;
  // 只有否定词出现在少数命中里，才算"可能有相反说法"
  const conflicting = denyCount > 0 && denyCount < hits.length;

  const hasAuthoritative = hits.some((h) => AUTHORITATIVE.test(h.url));
  const lowQualityCount = hits.filter((h) => LOW_QUALITY.test(h.url)).length;
  const allLowQuality = hits.length > 0 && lowQualityCount === hits.length;

  let strength: 'strong' | 'medium' | 'weak';
  if (allLowQuality || siteCount <= 1) {
    strength = 'weak';
  } else if (siteCount >= 3 && hasAuthoritative && !conflicting) {
    strength = 'strong';
  } else {
    strength = 'medium';
  }

  return { siteCount, earliest, latest, conflicting, strength };
}

/** 生成给模型看的证据说明。 */
export function buildEvidenceNote(r: CrossCheckResult): string {
  const lines: string[] = [];

  if (r.strength === 'strong') {
    lines.push(
      `证据情况：${r.siteCount} 个不同来源，包含权威媒体，没有发现互相矛盾的说法。`,
      '可以较有把握地回答。',
    );
  } else if (r.strength === 'medium') {
    lines.push(
      `证据情况：${r.siteCount} 个不同来源。`,
      '有一定依据但不够充分，回答时用「据报道」「目前的消息是」这类措辞，不要把话说死。',
    );
  } else {
    lines.push(
      `证据情况：只有 ${r.siteCount} 个来源，或都来自论坛/自媒体这类非权威渠道。`,
      '证据薄弱。可以说"我搜到的多是网友讨论，没有权威信源"，不要据此下"真/假"的定论。',
    );
  }

  if (r.conflicting) {
    lines.push(
      '注意：搜索结果里出现了互相矛盾的说法（有辟谣/否认类内容）。',
      '要明确告诉对方"网上说法不一致"，并列出两边各是什么，不要只挑一边。',
    );
  }

  if (r.earliest && r.latest && r.earliest !== r.latest) {
    lines.push(`时间跨度：${r.earliest} ~ ${r.latest}。`);
  } else if (r.latest) {
    lines.push(`最新报道日期：${r.latest}。`);
  }

  return lines.join('\n');
}

/** 是否存在超过 60 天的旧报道。 */
export function hasStaleReports(hits: RankedHit[]): boolean {
  return hits.some((h) => h.ageDays !== null && h.ageDays > 60);
}

/**
 * 把交叉验证结果渲染成给模型看的上下文块。
 *
 * 每条都带时效标注（如「3 天前」「7 个月前」），并已按日期倒序排列。
 */
export function renderCrossCheck(r: CrossCheckResult): string {
  if (r.hits.length === 0) return '';

  const lines = r.hits.map((h, i) => {
    const parts = [`[${i + 1}] ${h.title}`];
    if (h.site) parts.push(` · ${h.site}`);

    // 日期 + 时效标签，两者都给：
    // 日期便于追溯，时效标签让模型一眼看出新鲜度
    if (h.normalizedDate) {
      parts.push(`（${h.normalizedDate}，${h.freshness}）`);
    } else {
      parts.push('（时间不详）');
    }

    parts.push(`\n    来源：${h.url}`);
    if (h.summary) parts.push(`\n    摘要：${h.summary}`);
    return parts.join('');
  });

  return [
    `【联网搜索结果】用了 ${r.queries.length} 组关键词交叉核实：${r.queries.join(' / ')}`,
    '（以下按发布时间从新到旧排列）',
    '',
    ...lines,
    '',
    '【证据评估】',
    r.note,
    // 时效性警告放在这里而不是 note 里：
    // note 由 buildEvidenceNote 生成，可能被外部覆写，
    // 而这条警告必须根据实际 hits 计算，不能依赖调用方。
    ...(hasStaleReports(r.hits)
      ? [
          '注意：结果里混有较早的报道（见每条后面的时效标注）。',
          '回答时优先用最新的那条；如果引用了旧报道，必须说明"这是 X 个月前的消息"，',
          '不要说成"最近"或"目前"。',
        ]
      : []),
    '【结果结束】',
    '这些是刚搜到的实时资料。请结合它们回答，不要编造搜索结果里没有的信息；',
    '如果结果与问题无关，就直说没查到有用的，不要硬凑。',
    '引用旧报道时务必说明时间，不要把几个月前的消息说成"最近"。',
  ].join('\n');
}
