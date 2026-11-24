/**
 * 引用「表情消息」回归（2026-10-01 主人实测：
 *   `[引] <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0="> [/引]` —— 谁也看不懂那串标签）。
 *
 * 结论（实测 + 查文档）：
 *   · `faceType=6` 是**图片表情 / 收藏表情**（图片贴纸）：`ext` 解出来是 `{"text":""}`，
 *     `faceId` 常见 `"0"` 但**不是**经典表情 id —— 按经典表查会一律命中「微笑」，
 *     把贴纸误读成「她在笑」。所以 faceType=6 统一输出中性的 `【图片表情】`。
 *   · 其它 faceType 才走经典表情表（`ext.text` 优先）。
 *   QQ 官方文档没定义 faceType，SDK 也只解 ext.text。
 *   → 标签本身解析不出图（真正的出路是"那条消息入站时的附件"走本地台账回查）；
 *     但我们要做到：① 标签转成可读文本 ② ext 里**若**有图片 URL 就挖出来用。
 */
import { describe, expect, it } from 'vitest';
import { extractFaceImageUrls, slimQuoteText } from './quote-text.js';

/** 实测那条（faceId=0 → 微笑，ext 只有空 text） */
const REAL_TAG = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">';

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf-8').toString('base64');
}

describe('引用表情消息', () => {
  it('faceType=6（图片表情）→ 输出中性的 `【图片表情】`，不臆测情绪', () => {
    expect(slimQuoteText(REAL_TAG, 0)).toBe('【图片表情】');
  });

  it('ext 里带 text 时优先用官方名字', () => {
    expect(slimQuoteText(`<faceType=6,faceId="13",ext="${b64({ text: '呲牙' })}">`, 0)).toBe('【表情: 呲牙】');
  });

  it('非图片类型算不出的 faceId 也有兜底（不会漏成空）', () => {
    expect(slimQuoteText('<faceType=1,faceId="999",ext="eyJ0ZXh0IjoiIn0=">', 0)).toBe('【表情: id999】');
  });

  it('非图片类型仍按经典表情表命名', () => {
    expect(slimQuoteText('<faceType=1,faceId="14",ext="eyJ0ZXh0IjoiIn0=">', 0)).toBe('【表情: 惊讶】');
  });

  it('ext 里若带图片 URL → 能挖出来（图片表情的其它端形态）', () => {
    const raw = `<faceType=6,faceId="0",ext="${b64({ text: '', url: 'https://multimedia.example.com/face.png' })}">`;
    expect(extractFaceImageUrls(raw)).toEqual(['https://multimedia.example.com/face.png']);
  });

  it('实测那种空 ext：挖不到图，但文本照样可读', () => {
    expect(extractFaceImageUrls(REAL_TAG)).toEqual([]);
    expect(slimQuoteText(REAL_TAG, 0)).toBe('【图片表情】');
  });

  it('非表情文本不受影响', () => {
    expect(extractFaceImageUrls('普通一句话')).toEqual([]);
    expect(slimQuoteText('没啥足', 0)).toBe('没啥足');
  });
});
