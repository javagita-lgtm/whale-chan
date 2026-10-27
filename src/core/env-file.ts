/**
 * .env 文件的读写。
 *
 * 设计要点：
 *   - **保序**：按 config-schema 的分组顺序重写，注释也重新生成，
 *     避免历史上出现过的"注释和配置粘在一行"问题；
 *   - **密钥不回传**：读给前端时敏感字段只返回「是否已设置」，
 *     不会被浏览器拿走明文；
 *   - **原子写**：先写临时文件再重命名，避免写一半断电导致 .env 损坏。
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA, type FieldSpec } from './config-schema.js';

export type EnvMap = Record<string, string>;

/** 读取 .env 为键值对（不处理引号，保持与 Node 行为一致）。 */
export function readEnv(cwd = process.cwd()): EnvMap {
  const file = join(cwd, '.env');
  if (!existsSync(file)) return {};
  const out: EnvMap = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** 原子写入 .env（先写临时文件再重命名）。 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * 按 schema 分组顺序重写整个 .env。
 * 未在 schema 中登记的键会追加到末尾（避免丢配置）。
 */
export function writeEnv(values: EnvMap, cwd = process.cwd()): void {
  const lines: string[] = [
    '# Whale-chan 配置（由配置界面生成，也可手工编辑）',
    '# 注意：本文件含密钥，已在 .gitignore 中排除',
    '',
  ];

  const known = new Set<string>();
  for (const section of CONFIG_SCHEMA) {
    lines.push(`# ===== ${section.title} =====`);
    for (const f of section.fields) {
      known.add(f.key);
      const v = values[f.key] ?? f.default ?? '';
      lines.push(`${f.key}=${v}`);
    }
    lines.push('');
  }

  const extra = Object.keys(values).filter((k) => !known.has(k));
  if (extra.length > 0) {
    lines.push('# ===== 未在界面中登记的其他配置 =====');
    for (const k of extra) lines.push(`${k}=${values[k]}`);
    lines.push('');
  }

  writeAtomic(join(cwd, '.env'), lines.join('\n'));
}

/** 前端可见的值：密钥类字段返回占位，不返回明文。 */
export function toPublicValues(values: EnvMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of CONFIG_SCHEMA) {
    for (const f of section.fields) {
      const v = values[f.key] ?? f.default ?? '';
      out[f.key] = f.type === 'secret' ? (v.length > 0 ? '__SET__' : '') : v;
    }
  }
  return out;
}

export interface ValidationError {
  key: string;
  message: string;
}

/** 校验一组提交值；返回错误列表（空 = 通过）。 */
export function validateValues(input: Record<string, unknown>): {
  cleaned: EnvMap;
  errors: ValidationError[];
} {
  const cleaned: EnvMap = {};
  const errors: ValidationError[] = [];

  for (const section of CONFIG_SCHEMA) {
    for (const f of section.fields) {
      const raw = input[f.key];
      // 未提交的字段跳过（表示保持原值）
      if (raw === undefined) continue;

      const s = String(raw).trim();
      // 密钥占位符表示"不改动"，由调用方保留原值
      if (f.type === 'secret' && s === '__SET__') continue;

      switch (f.type) {
        case 'number': {
          if (s === '') break; // 留空表示用默认
          const n = Number(s);
          if (!Number.isFinite(n)) {
            errors.push({ key: f.key, message: '必须是数字' });
            break;
          }
          if (f.min !== undefined && n < f.min) {
            errors.push({ key: f.key, message: `不能小于 ${f.min}` });
            break;
          }
          if (f.max !== undefined && n > f.max) {
            errors.push({ key: f.key, message: `不能大于 ${f.max}` });
            break;
          }
          cleaned[f.key] = String(n);
          break;
        }
        case 'boolean': {
          const lower = s.toLowerCase();
          if (['1', 'true', 'yes', 'on'].includes(lower)) cleaned[f.key] = 'true';
          else if (['0', 'false', 'no', 'off'].includes(lower)) cleaned[f.key] = 'false';
          else errors.push({ key: f.key, message: '必须是 true 或 false' });
          break;
        }
        case 'list': {
          const parts = s
            .split(/[,，\s]+/)
            .map((x) => x.trim())
            .filter((x) => x.length > 0);
          cleaned[f.key] = parts.join(',');
          break;
        }
        default: {
          if (f.options && s !== '' && !f.options.includes(s)) {
            errors.push({ key: f.key, message: `必须是 ${f.options.join(' / ')} 之一` });
            break;
          }
          cleaned[f.key] = s;
          break;
        }
      }
    }
  }

  return { cleaned, errors };
}

/** 供界面展示：字段默认值 + 范围描述。 */
export function describeField(f: FieldSpec): string {
  const parts: string[] = [f.help];
  if (f.type === 'number' && (f.min !== undefined || f.max !== undefined)) {
    parts.push(`范围 ${f.min ?? '-∞'} ~ ${f.max ?? '∞'}`);
  }
  if (f.options) parts.push(`可选：${f.options.join(' / ')}`);
  if (f.default !== undefined && f.default !== '') parts.push(`默认 ${f.default}`);
  return parts.join('；');
}
