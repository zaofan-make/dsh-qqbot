import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _clearFaceCache, faceMapSize, replaceFacePlaceholders } from './face-placeholder.js';

let root: string;

/** 造一个最小可用的 qq-faces.json（真实格式：{名字: [charCode, …]}） */
function seedFaces(entries: Record<string, number[]>): void {
  const dir = join(root, '.qqbot-extensions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'qq-faces.json'), JSON.stringify(entries, null, 2));
}

beforeEach(() => {
  _clearFaceCache();
  root = mkdtempSync(join(tmpdir(), 'face-placeholder-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('replaceFacePlaceholders — 彩蛋：抄来的表情标记换成真表情', () => {
  it('表里有的名字 → 换成控制字符', () => {
    seedFaces({ 微笑: [20, 23] });
    const out = replaceFacePlaceholders('你好【表情: 微笑】', root);
    expect(out).toBe('你好' + String.fromCharCode(20, 23));
  });

  it('全角冒号也认（模型两种都写过）', () => {
    seedFaces({ 狂笑: [20, 99] });
    expect(replaceFacePlaceholders('【表情：狂笑】', root)).toBe(String.fromCharCode(20, 99));
  });

  it('句中多处一起换', () => {
    seedFaces({ 微笑: [1, 2], 大哭: [3, 4] });
    const out = replaceFacePlaceholders('【表情: 微笑】中间【表情: 大哭】', root);
    expect(out).toBe(String.fromCharCode(1, 2) + '中间' + String.fromCharCode(3, 4));
  });

  it('表里没有的名字 → 原样保留（交给 strip 决定删不删）', () => {
    seedFaces({ 微笑: [1, 2] });
    const s = '【表情: 不存在的表情】';
    expect(replaceFacePlaceholders(s, root)).toBe(s);
  });

  it('名字两边有空格也能匹配', () => {
    seedFaces({ 微笑: [7, 8] });
    expect(replaceFacePlaceholders('【表情:  微笑  】', root)).toBe(String.fromCharCode(7, 8));
  });

  it('没有表情标记的正文一个字都不动', () => {
    seedFaces({ 微笑: [1, 2] });
    const s = '普通一句话，带 [方括号] 和 引号"也不动';
    expect(replaceFacePlaceholders(s, root)).toBe(s);
  });

  it('超长内容不当占位符（防误伤）', () => {
    seedFaces({ 微笑: [1, 2] });
    const s = '【表情: 这是一个特别长的描述超过了二十四个字所以不该被当成占位符】';
    expect(replaceFacePlaceholders(s, root)).toBe(s);
  });
});

describe('replaceFacePlaceholders — 负数枚举（文件缺失/损坏/脏数据）', () => {
  it('**没装扩展也能用**（内置表兜底）—— 主人 2026-11-19 纠正的关键点', () => {
    // 空 dataRoot = 相当于别的用户没装 /face 扩展
    expect(faceMapSize(root)).toBeGreaterThan(100);
    const out = replaceFacePlaceholders('你好【表情: 微笑】', root);
    expect(out).not.toContain('【表情');
    expect(out).toContain('你好');
  });

  it('dataRoot 缺省 → 也走内置表', () => {
    const out = replaceFacePlaceholders('【表情: 微笑】', undefined);
    expect(out).not.toContain('【表情');
  });

  it('文件是坏 JSON → **仍走内置表**（不崩、也不退回原样）', () => {
    const dir = join(root, '.qqbot-extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'qq-faces.json'), '{ 这不是 json');
    expect(faceMapSize(root)).toBeGreaterThan(100);
    const out = replaceFacePlaceholders('【表情: 微笑】', root);
    expect(out).not.toContain('【表情');
  });

  it('跳过 _ 开头的元数据键（总数仍是内置那批）', () => {
    seedFaces({ _comment: [1, 2], 微笑: [3, 4] });
    expect(faceMapSize(root)).toBeGreaterThan(100);       // 内置 187
    expect(replaceFacePlaceholders('【表情: _comment】', root)).toBe('【表情: _comment】');
    // 扩展条目的值覆盖内置（同名以扩展为准）
    expect(replaceFacePlaceholders('【表情: 微笑】', root)).toBe(String.fromCharCode(3, 4));
  });

  it('值是脏数据（不是数字数组）→ 跳过该条，内置不受影响', () => {
    const dir = join(root, '.qqbot-extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'qq-faces.json'), JSON.stringify({ 坏: 'nope', 空: [], 好: [5, 6] }));
    expect(faceMapSize(root)).toBeGreaterThan(100);
    expect(replaceFacePlaceholders('【表情: 坏】', root)).toBe('【表情: 坏】');
    expect(replaceFacePlaceholders('【表情: 好】', root)).toBe(String.fromCharCode(5, 6));
  });

  it('空输入不崩', () => {
    expect(replaceFacePlaceholders('', root)).toBe('');
    expect(replaceFacePlaceholders(null as unknown as string, root)).toBe('');
  });
});


describe('缓存与 TTL（2026-11-19 性能优化配套）', () => {
  it('改了文件 + 清缓存后能读到新值（保证用户改表能生效）', () => {
    seedFaces({ 微笑: [1, 2] });
    expect(replaceFacePlaceholders('【表情: 微笑】', root)).toBe(String.fromCharCode(1, 2));

    seedFaces({ 微笑: [9, 9] });
    _clearFaceCache();     // 模拟过了 TTL 窗口
    expect(replaceFacePlaceholders('【表情: 微笑】', root)).toBe(String.fromCharCode(9, 9));
  });

  it('TTL 窗口内不重复 statSync（性能优化的核心）', () => {
    seedFaces({ 微笑: [1, 2] });
    faceMapSize(root);                    // 第一次：statSync + 读文件
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) faceMapSize(root);   // 后续都应命中 TTL 缓存
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
    // 1000 次平均应在微秒级；真去 statSync 会是几十微秒
    expect(ms).toBeLessThan(0.05);
  });
});


describe('超范围码点也能用（2026-11-20 主人实测纠正）', () => {
  // ★ 我一度以为「值 > 0xFF 就是乱码」，给它们加了过滤。**这是错的**：
  //   `狂笑 = [20, 283]` → `U+0014 U+011B` → QQ **正常渲染成狂笑小黄脸**。
  //   所以现在不做范围限制，只排除非法值（负数/小数/NaN）。

  it('超范围的码点照常替换（狂笑 [20,283]）', () => {
    _clearFaceCache();
    seedFaces({ 狂笑: [20, 283] });
    expect(replaceFacePlaceholders('【表情: 狂笑】', root)).toBe(String.fromCharCode(20, 283));
  });

  it('更大的值也照常替换（666 [20,356]）', () => {
    _clearFaceCache();
    seedFaces({ 666: [20, 356] });
    expect(replaceFacePlaceholders('【表情: 666】', root)).toBe(String.fromCharCode(20, 356));
  });

  it('负数 / 小数 / 非整数仍然拒绝（这些是真非法）', () => {
    _clearFaceCache();
    seedFaces({ 坏1: [20, -1], 坏2: [20, 1.5] });
    for (const n of ['坏1', '坏2']) {
      const s = `【表情: ${n}】`;
      expect(replaceFacePlaceholders(s, root)).toBe(s);
    }
  });

  it('扩展表里的超范围条目能覆盖内置', () => {
    _clearFaceCache();
    seedFaces({ 微笑: [20, 283] });
    expect(replaceFacePlaceholders('【表情: 微笑】', root)).toBe(String.fromCharCode(20, 283));
  });
});
