import { describe, expect, it } from 'vitest';
import { FRIENDLY_TURN_ERROR, resolveTurnErrorMessage } from './turn-error.js';

const CODE = 'INVALID_REQUEST';
const MSG = '400: {"message":"Invalid request parameters","code":10013}';

describe('resolveTurnErrorMessage — 四档模式（issue #73）', () => {
  it('notify（默认）：原文照发，与旧行为一致', () => {
    const out = resolveTurnErrorMessage({ turnErrorMode: 'notify' }, CODE, MSG);
    expect(out).toContain('本轮异常结束');
    expect(out).toContain(CODE);
    expect(out).toContain('400');
  });

  it('friendly：发一句人话，不带错误码', () => {
    const out = resolveTurnErrorMessage({ turnErrorMode: 'friendly' }, CODE, MSG);
    expect(out).toBe(FRIENDLY_TURN_ERROR);
    expect(out).not.toContain('400');
  });

  it('silent：完全不发', () => {
    expect(resolveTurnErrorMessage({ turnErrorMode: 'silent' }, CODE, MSG)).toBeNull();
  });

  it('regex 命中 → 静默', () => {
    expect(resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: '400' }, CODE, MSG,
    )).toBeNull();
  });

  it('regex 没命中 → 照常发原文', () => {
    const out = resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: '内容违规' }, CODE, MSG,
    );
    expect(out).toContain('本轮异常结束');
  });

  it('regex 不区分大小写', () => {
    expect(resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: 'invalid_request' }, CODE, MSG,
    )).toBeNull();
  });

  it('regex 能同时匹配 code 与 message 部分', () => {
    // 只出现在 message 里的 10013
    expect(resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: '10013' }, CODE, MSG,
    )).toBeNull();
    // 只出现在 code 里的 INVALID
    expect(resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: 'INVALID' }, CODE, MSG,
    )).toBeNull();
  });
});

describe('resolveTurnErrorMessage — 负数枚举（配置缺失/异常）', () => {
  it('配置整个 undefined → 等同 notify（老用户升级后行为不变）', () => {
    expect(resolveTurnErrorMessage(undefined, CODE, MSG)).toContain('本轮异常结束');
  });

  it('turnErrorMode 没填 → 等同 notify', () => {
    expect(resolveTurnErrorMessage({}, CODE, MSG)).toContain('本轮异常结束');
  });

  it('turnErrorMode 是空串 → 等同 notify', () => {
    expect(resolveTurnErrorMessage({ turnErrorMode: '' }, CODE, MSG)).toContain('本轮异常结束');
  });

  it('turnErrorMode 是脏值（手工改坏的配置文件）→ 回落 notify，不静默', () => {
    // fail-open：宁可多发，也不能因为配置手滑把所有异常吞掉
    expect(resolveTurnErrorMessage({ turnErrorMode: 'whatever' }, CODE, MSG))
      .toContain('本轮异常结束');
  });

  it('大小写/空格不敏感', () => {
    expect(resolveTurnErrorMessage({ turnErrorMode: ' SILENT ' }, CODE, MSG)).toBeNull();
  });

  it('regex 模式但正则留空 → 等同 notify（不拦截）', () => {
    expect(resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: '' }, CODE, MSG,
    )).toContain('本轮异常结束');
  });

  it('regex 写错语法 → fail-open，仍照常发（不静默吞错）', () => {
    expect(resolveTurnErrorMessage(
      { turnErrorMode: 'regex', turnErrorSilentPattern: '[unclosed' }, CODE, MSG,
    )).toContain('本轮异常结束');
  });
});
