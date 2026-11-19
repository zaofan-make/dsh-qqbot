/**
 * QQ face 是**双字符**编码（`U+0014` + id），彩蛋把 `【表情: 微笑】` 换成了它。
 *
 * 分块时如果边界正好落在两者之间，QQ 侧会收到两个畸形半截编码
 * （一个孤立控制符 + 一个孤立字符）—— 2026-11-19 CodeRabbit 抓到的真 bug。
 */
import { describe, expect, it } from 'vitest';
import { chunkMarkdownText } from './chunker.js';

const LEAD = String.fromCharCode(20);         // U+0014，face 的前导字节
const FACE = String.fromCharCode(20, 23);     // 【表情: 微笑】
const SHY = String.fromCharCode(20, 20);      // 【表情: 害羞】—— 两个 0x14，第二个是 id

describe('hardSplit / chunkMarkdownText — 不切断 QQ face 双字符编码', () => {

  it('正文末尾紧跟表情时，没有块以 U+0014 结尾', () => {
    const s = 'a'.repeat(4499) + FACE;
    const parts = chunkMarkdownText(s, 4500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.endsWith(LEAD)).toBe(false);
    expect(parts.join('')).toBe(s);          // 不丢字符
  });

  it('多个表情连续时也不切断', () => {
    const s = 'b'.repeat(4495) + FACE + FACE + FACE;
    const parts = chunkMarkdownText(s, 4500);
    for (const p of parts) expect(p.endsWith(LEAD)).toBe(false);
    expect(parts.join('')).toBe(s);
  });

  it('正好卡在 0x14 前一位（最险的边界）', () => {
    const s = 'c'.repeat(4500) + FACE;
    const parts = chunkMarkdownText(s, 4500);
    for (const p of parts) expect(p.endsWith(LEAD)).toBe(false);
    expect(parts.join('')).toBe(s);
  });

  it('没有表情的普通文本分块行为不变', () => {
    const s = 'd'.repeat(10000);
    const parts = chunkMarkdownText(s, 4500);
    expect(parts.join('')).toBe(s);
    expect(parts.length).toBeGreaterThan(1);
  });

  it('limit=1 的极端情况不死循环（2026-11-14 那条老雷）', () => {
    // 表情 + 单字符限制：回退保护必须保底前进，否则会卡死进程
    const s = FACE + 'x';
    const parts = chunkMarkdownText(s, 1);
    expect(parts.join('')).toBe(s);
  });
});

describe('按编码边界识别前导符（2026-11-19 审查第二轮）', () => {
  // ⚠️ 内置「害羞」的编码是 [20, 20] —— **第二个 0x14 是 id，不是另一个前导符**。
  //    只判"块尾字符是不是 0x14"会把"切在完整表情之后"误判成"切在中间"，反而拆散它。

  /** 每个块里 0x14 都必须成对（前导符 + id），不能以孤立前导符结尾 */
  const noBrokenFace = (parts: string[]): boolean =>
    parts.every((p) => {
      let k = 0;
      while (k < p.length) {
        if (p.charCodeAt(k) === 20) {
          if (k + 1 >= p.length) return false;
          k += 2;
        } else k++;
      }
      return true;
    });

  it('害羞 [20,20]：切点正好在完整表情之后时 **不能**误回退', () => {
    // 4498 a + 害羞 + x，limit=4500 ⇒ 原切点 4500 刚好把整个表情包含在内，是正确的
    const s = 'a'.repeat(4498) + SHY + 'x';
    const parts = chunkMarkdownText(s, 4500);
    expect(noBrokenFace(parts)).toBe(true);
    expect(parts.join('')).toBe(s);
  });

  it('害羞 [20,20]：卡在 4499 / 4500 也都不拆散', () => {
    for (const n of [4499, 4500]) {
      const s = 'a'.repeat(n) + SHY + 'x';
      const parts = chunkMarkdownText(s, 4500);
      expect(noBrokenFace(parts)).toBe(true);
      expect(parts.join('')).toBe(s);
    }
  });

  it('害羞与微笑混排时都不拆散', () => {
    const s = 'b'.repeat(4490) + SHY + FACE + SHY + FACE;
    const parts = chunkMarkdownText(s, 4500);
    expect(noBrokenFace(parts)).toBe(true);
    expect(parts.join('')).toBe(s);
  });
});
