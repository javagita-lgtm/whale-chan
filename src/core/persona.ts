/**
 * 人设（Persona）加载。
 *
 * 一个机器人可以按群使用不同人设。人设文件是 JSON（零依赖解析），
 * 结构见 config/persona.example.json。支持热重载：context 每次请求前
 * 检查文件 mtime，改动后自动生效，无需重启。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Logger } from './logger.js';

export interface Persona {
  /** 人设 ID */
  id: string;
  /** 显示名 */
  name: string;
  /** 系统提示词正文 */
  systemPrompt: string;
  /** 单条回复期望长度上限（字符），闲聊时生效 */
  replyMaxChars?: number;
  /** 技术话题下的字数上限，通常更宽松；缺省取 max(replyMaxChars, 300) */
  replyTechMaxChars?: number;
  /**
   * 需要交代内容时（视频总结、长文摘要）的字数上限。
   * 缺省取 max(replyTechMaxChars, 600)——这类回复天生要铺开讲，
   * 用闲聊的 120 字会被截在半句话上。
   */
  replyRecapMaxChars?: number;
  /**
   * 用户明确要求「详细/完整/展开」时的字数上限。
   * 缺省取 max(replyRecapMaxChars * 2.5, 1500)——这类回复要分「总结 / 细节 / 分析」三段，
   * 600 字装不下，会被截断。
   */
  replyDetailMaxChars?: number;
  /** 是否允许在群里主动插话（覆盖全局配置） */
  allowInterject?: boolean;
  /** 允许使用的 QQ 号白名单（为空表示全部允许），用于把人设绑定到特定群/用户 */
  allowGroups?: string[];
}

export interface PersonaFile {
  /** 默认人设 ID */
  defaultPersonaId: string;
  personas: Persona[];
  /** 群号 → 人设 ID */
  groupBindings?: Record<string, string>;
}

export class PersonaStore {
  private data: PersonaFile | null = null;
  private loadedAt = 0;
  private fileMtime = 0;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  /** 获取人设；文件缺失时返回内置兜底人设。 */
  get(personaId?: string, groupId?: string): Persona {
    const data = this.current();
    const boundId = groupId ? data.groupBindings?.[groupId] : undefined;
    const targetId = personaId ?? boundId ?? data.defaultPersonaId;
    const found = data.personas.find((p) => p.id === targetId);
    if (found) return found;

    if (data.personas.length > 0) {
      this.logger.warn('未找到指定人设，使用第一个可用人设', { wanted: targetId });
      return data.personas[0] as Persona;
    }
    return FALLBACK_PERSONA;
  }

  /** 列出全部人设 ID，供管理命令使用。 */
  listIds(): string[] {
    return this.current().personas.map((p) => p.id);
  }

  private current(): PersonaFile {
    const now = Date.now();
    // 最多每 2 秒检查一次 mtime，避免高频 IO
    if (this.data && now - this.loadedAt < 2_000) return this.data;
    this.loadedAt = now;

    const path = resolve(this.filePath);
    if (!existsSync(path)) {
      this.logger.warn('人设文件不存在，使用内置兜底人设', { path });
      this.data = { defaultPersonaId: FALLBACK_PERSONA.id, personas: [FALLBACK_PERSONA] };
      return this.data;
    }
    try {
      const mtime = statSync(path).mtimeMs;
      if (this.data && mtime === this.fileMtime) return this.data;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersonaFile;
      if (!Array.isArray(parsed.personas) || parsed.personas.length === 0) {
        throw new Error('personas 不能为空');
      }
      this.fileMtime = mtime;
      this.data = parsed;
      this.logger.info('人设已加载', {
        file: basename(path),
        count: parsed.personas.length,
        default: parsed.defaultPersonaId,
      });
      return this.data;
    } catch (error) {
      this.logger.error('人设文件解析失败，使用内置兜底人设', {
        message: (error as Error).message,
      });
      this.data = { defaultPersonaId: FALLBACK_PERSONA.id, personas: [FALLBACK_PERSONA] };
      return this.data;
    }
  }
}

export const FALLBACK_PERSONA: Persona = {
  id: 'default',
  name: '鲸鱼酱',
  systemPrompt:
    '你是群聊里的普通成员「鲸鱼酱」，性格温和、偶尔调皮。说话简短口语化，不用书面语，不要暴露自己是 AI。',
  replyMaxChars: 120,
};
