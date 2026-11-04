/**
 * 交叉验证的执行器：生成多组搜索词 → 并发搜 → 合并去重 → 评估 → 渲染。
 *
 * 和 cross-check.ts 的分工：
 *   cross-check.ts  纯函数（去重/评估/渲染），可单测
 *   这个文件        有副作用（发网络请求），负责编排
 */

import type { Logger } from '../logger.js';
import type { SearchHit, WebTools } from '../web.js';
import {
  assessEvidence,
  buildEvidenceNote,
  dedupeHits,
  rankByDate,
  renderCrossCheck,
  type CrossCheckResult,
} from '../cross-check.js';

export interface CrossCheckOptions {
  web: WebTools;
  logger: Logger;
  /** 每路搜几条 */
  perQuery: number;
  /** 最多用几路 */
  maxQueries: number;
}

/**
 * 生成多角度的搜索词。
 *
 * 思路：
 *   1. 原查询本身
 *   2. 去掉质疑词、留纯实体（"这消息真的假的" → "这消息"没意义，
 *      但如果查询里有具体实体，单独拎出来搜更容易命中新闻）
 *   3. 加"官方/通报/辟谣"角度，专门找反面证据
 *
 * 不用 LLM：这一步要快且零成本，规则够用。
 */
export function expandQueries(primary: string): string[] {
  const q = primary.trim();
  if (q.length === 0) return [];

  const out: string[] = [q];

  // 剔除质疑/求证类措辞，留纯实体
  const entityOnly = q
    .replace(/(真的假的|是不是真的|是不是假新闻|这消息|这图|靠谱吗|可信吗|求证|辟谣|核实|有没有这回事|发生过吗)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (entityOnly.length >= 2 && entityOnly !== q) {
    out.push(entityOnly);
  }

  // 反面证据角度：专门找辟谣/官方通报
  const base = entityOnly.length >= 2 ? entityOnly : q;
  if (base.length >= 2) {
    out.push(`${base} 官方 通报`);
  }

  // 去重且限制数量
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  return uniq;
}

/**
 * 对一个问题做多源交叉验证。
 *
 * @param primary 主搜索词（已由 buildSearchQuery 提炼过）
 */
export async function crossCheck(
  opts: CrossCheckOptions,
  primary: string,
): Promise<CrossCheckResult | null> {
  const { web, logger, perQuery, maxQueries } = opts;
  const queries = expandQueries(primary).slice(0, maxQueries);
  if (queries.length === 0) return null;

  logger.info('开始交叉验证', { queries: queries.join(' / ') });

  const settled = await Promise.allSettled(
    queries.map((q) => web.search(q, perQuery)),
  );

  const all: SearchHit[] = [];
  const usedQueries: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === 'fulfilled' && r.value.length > 0) {
      all.push(...r.value);
      usedQueries.push(queries[i]!);
    }
  }

  if (all.length === 0) {
    logger.info('交叉验证无结果', { queries: queries.length });
    return null;
  }

  const hits = dedupeHits(all);
  const assess = assessEvidence(hits);
  // 按日期倒序（新的在前，无日期的排最后），并给每条算时效标签
  const ranked = rankByDate(hits);

  const result: CrossCheckResult = {
    hits: ranked,
    queries: usedQueries,
    ...assess,
    note: '',
  };
  result.note = buildEvidenceNote(result);

  logger.info('交叉验证完成', {
    原始条数: all.length,
    去重后: hits.length,
    信源数: result.siteCount,
    证据强度: result.strength,
    有冲突: result.conflicting,
    最新: result.latest,
  });

  return result;
}

/** 交叉验证 + 渲染，一步到位。 */
export async function crossCheckAndRender(
  opts: CrossCheckOptions,
  primary: string,
): Promise<string> {
  const r = await crossCheck(opts, primary);
  return r ? renderCrossCheck(r) : '';
}
