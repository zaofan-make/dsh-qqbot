/**
 * quote-match 单测 —— 引用归属匹配的核心纯函数
 *
 * 守住的契约：
 *   · QQ 图片文件名 = 内容 MD5（这是"引用纯图也能认人"的根基）
 *   · 正文归一化要吃掉图片占位 / 表情标签 / 空白 / 大小写
 *   · 平台截断被引原文时（任一方是另一方前缀）仍算同一句
 */
import { describe, expect, it } from 'vitest';
import { md5OfFilename, md5sInText, normQuoteText, sameQuotedText } from './quote-match.js';

const MD5_A = '7db891f747aaab2386f57c9e7c17a45f';

describe('md5OfFilename', () => {
  it('从 QQ 图片名里抠出 MD5', () => {
    expect(md5OfFilename('7DB891F747AAAB2386F57C9E7C17A45F.png')).toBe(MD5_A);
  });
  it('带路径也能抠', () => {
    expect(md5OfFilename('D:\\pics\\7DB891F747AAAB2386F57C9E7C17A45F.jpg')).toBe(MD5_A);
  });
  it('不是 32 位十六进制一律不认', () => {
    expect(md5OfFilename('photo.jpg')).toBe('');
    expect(md5OfFilename('7DB891F7.png')).toBe('');
    expect(md5OfFilename(undefined)).toBe('');
  });
});

describe('md5sInText', () => {
  it('从 [image: xxx.png] 里抠出来', () => {
    expect(md5sInText('[image: 7DB891F747AAAB2386F57C9E7C17A45F.png]')).toEqual([MD5_A]);
  });
  it('多个去重、忽略大小写', () => {
    expect(md5sInText('a 7DB891F747AAAB2386F57C9E7C17A45F.jpg b 7db891f747aaab2386f57c9e7c17a45f.png')).toEqual([MD5_A]);
  });
  it('普通文本返回空', () => {
    expect(md5sInText('哈哈哈哈哈')).toEqual([]);
  });
});

describe('normQuoteText', () => {
  it('去掉空白与大小写差异', () => {
    expect(normQuoteText('  我是神吗 ')).toBe('我是神吗');
    expect(normQuoteText('Hello  World')).toBe('helloworld');
  });
  it('图片占位归一化成空串（纯图引用只能靠 MD5）', () => {
    expect(normQuoteText('[image: 7DB891F747AAAB2386F57C9E7C17A45F.png]')).toBe('');
  });
  it('表情标签不算内容', () => {
    expect(normQuoteText('【表情: 微笑】哈哈')).toBe('哈哈');
    expect(normQuoteText('<faceType=6,faceId="0",ext="">哈哈')).toBe('哈哈');
  });
});

describe('sameQuotedText', () => {
  it('完全相等', () => {
    expect(sameQuotedText('我是神吗', '我是神吗')).toBe(true);
  });
  it('引用方被平台截断（前缀）也算', () => {
    expect(sameQuotedText('这是一条很长很长的消息，长到平台只给了前面一小段', '这是一条很长很长的消息')).toBe(true);
  });
  it('空白/大小写差异不影响', () => {
    expect(sameQuotedText('Hello  World', ' helloworld ')).toBe(true);
  });
  it('不同的话不算', () => {
    expect(sameQuotedText('我是神吗', '你是神经')).toBe(false);
  });
  it('空的永不算命中', () => {
    expect(sameQuotedText('', '我是神吗')).toBe(false);
    expect(sameQuotedText('[image: abc.png]', '[image: def.png]')).toBe(false);
  });
});
