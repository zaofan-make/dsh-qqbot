import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faceMapSize, replaceFacePlaceholders } from './face-placeholder.js';

let root: string;

/** 造一个最小可用的 qq-faces.json（真实格式：{名字: [charCode, …]}） */
function seedFaces(entries: Record<string, number[]>): void {
  const dir = join(root, '.qqbot-extensions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'qq-faces.json'), JSON.stringify(entries, null, 2));
}

beforeEach(() => {
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
  it('没装扩展（文件不存在）→ 原样返回，不崩', () => {
    const s = '你好【表情: 微笑】';
    expect(replaceFacePlaceholders(s, root)).toBe(s);
    expect(faceMapSize(root)).toBe(0);
  });

  it('dataRoot 缺省 → 原样返回', () => {
    const s = '【表情: 微笑】';
    expect(replaceFacePlaceholders(s, undefined)).toBe(s);
  });

  it('文件是坏 JSON → 原样返回，不崩', () => {
    const dir = join(root, '.qqbot-extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'qq-faces.json'), '{ 这不是 json');
    const s = '【表情: 微笑】';
    expect(replaceFacePlaceholders(s, root)).toBe(s);
  });

  it('跳过 _ 开头的元数据键', () => {
    seedFaces({ _comment: [1, 2], 微笑: [3, 4] });
    expect(faceMapSize(root)).toBe(1);
    expect(replaceFacePlaceholders('【表情: _comment】', root)).toBe('【表情: _comment】');
  });

  it('值是脏数据（不是数字数组）→ 跳过该条', () => {
    const dir = join(root, '.qqbot-extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'qq-faces.json'), JSON.stringify({ 坏: 'nope', 空: [], 好: [5, 6] }));
    expect(faceMapSize(root)).toBe(1);
    expect(replaceFacePlaceholders('【表情: 坏】', root)).toBe('【表情: 坏】');
    expect(replaceFacePlaceholders('【表情: 好】', root)).toBe(String.fromCharCode(5, 6));
  });

  it('空输入不崩', () => {
    expect(replaceFacePlaceholders('', root)).toBe('');
    expect(replaceFacePlaceholders(null as unknown as string, root)).toBe('');
  });
});
