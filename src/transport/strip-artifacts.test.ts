import { describe, expect, it } from 'vitest';
import { stripOutboundArtifacts } from './strip-artifacts.js';

const ON = { stripTimeHead: true, stripFacePlaceholder: true };

describe('stripOutboundArtifacts — 行首时间头（issue #72）', () => {
  it('删掉行首 [YYYY-MM-DD 周四 HH:MM]', () => {
    expect(stripOutboundArtifacts('[2026-11-19 周四 09:52]\n啊呜', ON)).toBe('啊呜');
  });

  it('删掉行首 [HH:MM] 短格式', () => {
    expect(stripOutboundArtifacts('[09:52]\n啊呜', ON)).toBe('啊呜');
  });

  it('多行里夹着的时间头也删（gm 逐行匹配）', () => {
    expect(stripOutboundArtifacts('[2026-11-19 周四 09:52]\n第一句\n[11:37]\n第二句', ON))
      .toBe('第一句\n第二句');
  });

  it('时间头后紧跟正文（同一行）不误伤正文', () => {
    expect(stripOutboundArtifacts('[09:52] 啊呜', ON)).toBe('啊呜');
  });

  it('不含 HH:MM 的方括号**不动**（正常引用）', () => {
    const s = '[2026-11-19 更新版已发] 看看这个';
    expect(stripOutboundArtifacts(s, ON)).toBe(s);
  });

  it('正文中间的时间样式文本不动（只删行首）', () => {
    const s = '我约了 09:52 的会';
    expect(stripOutboundArtifacts(s, ON)).toBe(s);
  });
});

describe('stripOutboundArtifacts — 【表情: XX】（issue #72）', () => {
  it('删掉中文冒号形态', () => {
    expect(stripOutboundArtifacts('哈哈哈【表情: 狂笑】', ON)).toBe('哈哈哈');
  });

  it('删掉全角冒号形态', () => {
    expect(stripOutboundArtifacts('嗯【表情：微笑】', ON)).toBe('嗯');
  });

  it('句中多处一起删', () => {
    expect(stripOutboundArtifacts('【表情: 微笑】你好【表情: 大哭】', ON)).toBe('你好');
  });

  it('超长内容不当占位符（防止误伤正常方括号）', () => {
    const s = '【表情: 这是一个特别长的描述超过了二十四个字所以不该被当成占位符】';
    expect(stripOutboundArtifacts(s, ON)).toBe(s);
  });
});

describe('stripOutboundArtifacts — 开关与边界', () => {
  it('两个开关都关 → 一个字都不动', () => {
    const s = '[2026-11-19 周四 09:52]\n啊呜【表情: 微笑】';
    expect(stripOutboundArtifacts(s, { stripTimeHead: false, stripFacePlaceholder: false })).toBe(s);
  });

  it('只关时间头 → 表情照样洗', () => {
    const s = '[09:52]\n啊呜【表情: 微笑】';
    expect(stripOutboundArtifacts(s, { stripTimeHead: false, stripFacePlaceholder: true }))
      .toBe('[09:52]\n啊呜');
  });

  it('配置缺省（undefined）→ **默认关**，一个字都不动（用户没勾就不洗）', () => {
    const s = '[09:52]\n啊呜【表情: 微笑】';
    expect(stripOutboundArtifacts(s, undefined)).toBe(s);
  });

  it('配置对象存在但字段没给 → 同样默认关', () => {
    const s = '[09:52]\n啊呜';
    expect(stripOutboundArtifacts(s, {})).toBe(s);
  });

  it('整条只剩时间头 → 返回空串（调用方据此跳过发送）', () => {
    expect(stripOutboundArtifacts('[2026-11-19 周四 09:52]', ON)).toBe('');
  });

  it('空输入不崩', () => {
    expect(stripOutboundArtifacts('', ON)).toBe('');
    expect(stripOutboundArtifacts(null as unknown as string, ON)).toBe('');
  });

  it('没改动时原样返回（不 trim 掉用户自己的首尾空格）', () => {
    const s = '  前后都有空格  ';
    expect(stripOutboundArtifacts(s, ON)).toBe(s);
  });
});
