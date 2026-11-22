import { describe, expect, it } from 'vitest';
import { containsMedia, normalizeMediaMarkers, parseOutbound, stripDirectives } from './rich-media.js';

// issue #81：模型偶发把 [MEDIA:kind|src] 写成 <MEDIA:kind|src>，
// 出站只认方括号 → 整段（含本地图库路径）按纯文本发群。
describe('normalizeMediaMarkers（尖括号变体）', () => {
  it('把带路径的尖括号标记转回方括号', () => {
    const input = String.raw`<MEDIA:image|G:\sticker\lib\a.webp>`;
    expect(normalizeMediaMarkers(input)).toBe(String.raw`[MEDIA:image|G:\sticker\lib\a.webp]`);
  });

  it('不区分大小写、容忍标记内空白', () => {
    expect(normalizeMediaMarkers('< media : IMAGE | /tmp/a.png >')).toBe('[MEDIA:image|/tmp/a.png]');
  });

  it('kind 统一小写（否则绕过无 i 标志的去重正则）', () => {
    expect(normalizeMediaMarkers('<MEDIA:FILE|/tmp/report.pdf>')).toBe('[MEDIA:file|/tmp/report.pdf]');
  });

  it('无路径特征的正文讨论保持原样', () => {
    const input = '发图格式是 <MEDIA:image|你的图片路径>';
    expect(normalizeMediaMarkers(input)).toBe(input);
  });

  it('方括号标记与裸文本不受影响', () => {
    const input = '[MEDIA:image|/tmp/a.png] 和 MEDIA:image|/tmp/b.png';
    expect(normalizeMediaMarkers(input)).toBe(input);
  });
});

describe('parseOutbound 接住尖括号变体', () => {
  it('解析成 media 段，且文本段不残留路径', () => {
    const segs = parseOutbound(String.raw`看图 <MEDIA:image|C:\pics\x.png> 好`);
    const media = segs.filter((s) => s.type === 'media');
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'image', source: String.raw`C:\pics\x.png` });
    const text = segs
      .filter((s) => s.type === 'text')
      .map((s) => (s as { text: string }).text)
      .join('');
    expect(text).not.toContain('MEDIA');
    expect(text).not.toContain('pics');
  });
});

describe('containsMedia / stripDirectives', () => {
  it('containsMedia 认尖括号变体，但不认正文讨论', () => {
    expect(containsMedia('<MEDIA:image|/tmp/a.png>')).toBe(true);
    expect(containsMedia('正文里说 <MEDIA:image|图片路径> 而已')).toBe(false);
  });

  it('stripDirectives 不把尖括号标记残留成文本', () => {
    expect(stripDirectives('hi <MEDIA:image|/tmp/a.png> there')).toBe('hi  there');
  });
});

// ── CodeRabbit #83 的回归用例 ──
describe('路径里带方括号目录（CodeRabbit #83）', () => {
  it('尖括号规范化后能完整解析（不在第一个 ] 处截断）', () => {
    const input = String.raw`<MEDIA:image|C:\pics\[旅行]\a.png>`;
    const norm = normalizeMediaMarkers(input);
    expect(norm).toBe(String.raw`[MEDIA:image|C:\pics\[旅行]\a.png]`);
    const segs = parseOutbound(norm);
    const media = segs.filter((s) => s.type === 'media');
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'image', source: String.raw`C:\pics\[旅行]\a.png` });
    const text = segs.filter((s) => s.type === 'text').map((s) => (s as { text: string }).text).join('');
    expect(text).not.toContain('a.png');
  });

  it('方括号原生标记同样支持方括号目录', () => {
    const segs = parseOutbound(String.raw`[MEDIA:file|G:\[备份]\报告.pdf]`);
    const media = segs.filter((s) => s.type === 'media');
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ kind: 'file', source: String.raw`G:\[备份]\报告.pdf` });
  });

  it('多段相邻标记不会互相吞掉', () => {
    const segs = parseOutbound('[MEDIA:image|/tmp/a.png][MEDIA:image|/tmp/b.png]');
    expect(segs.filter((s) => s.type === 'media')).toHaveLength(2);
  });
});
