/** 事实核查：触发词 + 分段解析 + 渲染。 */

import { describe, expect, it } from 'vitest';
import { looksLikeFactCheck, renderImageFacts } from '../src/core/pipeline/fact-check.js';

describe('质疑真假触发词', () => {
  it('识别常见说法', () => {
    expect(looksLikeFactCheck('这是真的假的')).toBe(true);
    expect(looksLikeFactCheck('这条是不是真的')).toBe(true);
    expect(looksLikeFactCheck('这图八成是P的')).toBe(true);
    expect(looksLikeFactCheck('有这回事吗')).toBe(true);
    expect(looksLikeFactCheck('求证实一下')).toBe(true);
    expect(looksLikeFactCheck('这消息靠谱吗')).toBe(true);
    expect(looksLikeFactCheck('是不是假新闻')).toBe(true);
    expect(looksLikeFactCheck('帮我辟个谣')).toBe(true);
  });

  it('普通聊天不触发', () => {
    expect(looksLikeFactCheck('今天天气不错')).toBe(false);
    expect(looksLikeFactCheck('这图好看吗')).toBe(false);
    expect(looksLikeFactCheck('说一句你好')).toBe(false);
  });

  it('太短不触发', () => {
    expect(looksLikeFactCheck('真假')).toBe(false);
  });

  it('剥掉 @ 标记后判断', () => {
    expect(looksLikeFactCheck('[艾特你] 这是真的假的')).toBe(true);
  });
});

describe('核查结果渲染', () => {
  it('包含摘要和疑点', () => {
    const text = renderImageFacts({
      searchTerms: '胡塞 沙特',
      summary: '截图显示美国国防部长带着100亿美元访问德黑兰',
      redFlags: ['日期写的是未来时间', '信源署名不可辨认'],
    });

    expect(text).toContain('图片核查结果');
    expect(text).toContain('100亿美元');
    expect(text).toContain('可疑点');
    expect(text).toContain('日期写的是未来时间');
  });

  it('没有疑点时也正常渲染', () => {
    const text = renderImageFacts({
      searchTerms: 'x',
      summary: '图里是一张风景照',
      redFlags: [],
    });
    expect(text).toContain('风景照');
    expect(text).not.toContain('可疑点');
  });
});
