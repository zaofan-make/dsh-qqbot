/**
 * 思考档位的「校验 / 补档 / 丢弃」回归测试。
 *
 * 为什么需要这一份（2026-11-29）：
 *   这条链路连发三版才对，前两版**改完等于没改**，而且全靠人肉复现才发现：
 *     · 1.13.36 硬补 `'medium'` → 不支持的模型整个回合「本轮运行失败」；
 *     · 1.13.37 整个关掉 → 又完全不管了；
 *     · 1.13.38 第一稿读错了数据源（以为 `listModels()` 返回里有 `reasoningEfforts`，
 *       实际门面用白名单重建对象、字段到不了调用方）⇒ 运行时和 1.13.37 完全等价。
 *   每一版都是「测试全绿」，因为这个维度**一条断言都没有**。
 *
 * 这里钉住的是**行为契约**，不是实现细节：
 *   · 宿主说支持什么，就只能在那个范围内挑；
 *   · 已存的档位如果模型不认，必须丢掉（这是 1.13.36 写进用户 prefs 的存量止血点）；
 *   · 拿不到能力信息时，**一个档位都不许传**（宁可没思考，也不能整轮失败）。
 */
import { describe, expect, it } from 'vitest';
import { ModelResolver } from './model-resolver.js';
import type { ModelRoute } from './types.js';

/** 假 llm 服务：按 provider/model 给出 `reasoning.efforts`，并记录调用次数。 */
function mkResolver(info: (p: string, m: string) => unknown, calls?: { n: number }) {
  const llm = {
    resolveModelInfo: async (p: string, m: string) => {
      if (calls) calls.n += 1;
      return info(p, m);
    },
  };
  const ctx = { get: (k: string) => (k === 'llm' ? llm : undefined) };
  return new ModelResolver(ctx as never, {} as never, undefined);
}

/** 宿主 `resolveModelInfo` 的典型形状：`reasoning.efforts[].id`。 */
const supports = (...ids: string[]) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })) } });

const route = (effort?: string): ModelRoute => ({
  provider: 'prov',
  model: 'mod',
  ...(effort ? { effort } : {}),
});

describe('sanitizeRouteAsync — 缺档时按模型真实支持的挑', () => {
  it('支持 off/low/high/max（deepseek 形态）⇒ 补 low，**不能**补 medium/xhigh', async () => {
    const r = mkResolver(() => supports('off', 'low', 'high', 'max'));
    expect((await r.sanitizeRouteAsync(route())).effort).toBe('low');
  });

  it('支持 medium ⇒ 优先 medium（而不是 low）', async () => {
    const r = mkResolver(() => supports('off', 'low', 'medium', 'high'));
    expect((await r.sanitizeRouteAsync(route())).effort).toBe('medium');
  });

  it('只有 off ⇒ 不补（保持无档位）', async () => {
    const r = mkResolver(() => supports('off'));
    expect((await r.sanitizeRouteAsync(route())).effort).toBeUndefined();
  });
});

describe('sanitizeRouteAsync — 已存档位必须校验（1.13.36 存量止血）', () => {
  it('模型只支持 off/low，而路由带着 medium ⇒ **丢掉**（这就是那句报错的来源）', async () => {
    const r = mkResolver(() => supports('off', 'low'));
    const out = await r.sanitizeRouteAsync(route('medium'));
    expect(out.effort).toBeUndefined();
    expect(out.provider).toBe('prov');
    expect(out.model).toBe('mod');
  });

  it('模型支持 medium ⇒ 已存的 medium 保留', async () => {
    const r = mkResolver(() => supports('off', 'low', 'medium', 'high'));
    expect((await r.sanitizeRouteAsync(route('medium'))).effort).toBe('medium');
  });

  it('模型声明了别的档位、用户存的也支持 ⇒ 原样保留（尊重用户选择）', async () => {
    const r = mkResolver(() => supports('off', 'low', 'high'));
    expect((await r.sanitizeRouteAsync(route('high'))).effort).toBe('high');
  });
});

describe('sanitizeRouteAsync — 拿不到能力时一律不传（fail-safe）', () => {
  it('非思考模型（没有 reasoning 键）⇒ 不补也不清出别的东西', async () => {
    const r = mkResolver(() => ({}));
    expect((await r.sanitizeRouteAsync(route())).effort).toBeUndefined();
  });

  it('非思考模型 + 已存档位 ⇒ 丢掉', async () => {
    const r = mkResolver(() => ({}));
    expect((await r.sanitizeRouteAsync(route('high'))).effort).toBeUndefined();
  });

  it('resolveModelInfo 抛错 ⇒ 按"不支持"处理，不传档位', async () => {
    const r = mkResolver(() => { throw new Error('boom'); });
    expect((await r.sanitizeRouteAsync(route('medium'))).effort).toBeUndefined();
  });

  it('宿主没有 resolveModelInfo ⇒ 不传档位，也不抛', async () => {
    const ctx = { get: () => ({ /* 老宿主：没有 resolveModelInfo */ }) };
    const r = new ModelResolver(ctx as never, {} as never, undefined);
    expect((await r.sanitizeRouteAsync(route('high'))).effort).toBeUndefined();
  });

  it('efforts 是空数组 ⇒ 不传', async () => {
    const r = mkResolver(() => supports());
    expect((await r.sanitizeRouteAsync(route('low'))).effort).toBeUndefined();
  });

  it('efforts 里混了非字符串 id ⇒ 过滤掉，不影响其余判断', async () => {
    const r = mkResolver(() => ({ reasoning: { efforts: [{ id: 'low' }, { id: '' }, { id: null }, {}] } }));
    expect((await r.sanitizeRouteAsync(route())).effort).toBe('low');
  });
});

describe('能力缓存 — 去重与 TTL', () => {
  it('同一 provider/model 连续调用只拉一次（写路径会被高频调用）', async () => {
    const calls = { n: 0 };
    const r = mkResolver(() => supports('off', 'low'), calls);
    await r.sanitizeRouteAsync(route());
    await r.sanitizeRouteAsync(route('low'));
    await r.sanitizeRouteAsync(route());
    expect(calls.n).toBe(1);
  });

  it('不同模型各拉各的', async () => {
    const calls = { n: 0 };
    const r = mkResolver(() => supports('off', 'low'), calls);
    await r.sanitizeRouteAsync({ provider: 'prov', model: 'a' });
    await r.sanitizeRouteAsync({ provider: 'prov', model: 'b' });
    expect(calls.n).toBe(2);
  });

  it('★ 早退路径不能污染去重表：连续两次都该真的去拉（capsInflight 泄漏回归）', async () => {
    // 这是 CodeRabbit 2026-11-29 抓的那个洞：`.finally{delete}` 写在 async IIFE 内部时，
    // 早退分支会在 `set` 之前执行 delete ⇒ 留下一个早已 resolve 的 promise 永久占位
    // ⇒ 之后每次都在 `inflight` 上早退，**永远不再拉**（TTL 形同虚设）。
    // 判据：连续两次拿到的都必须是"新拉到的东西"。
    let n = 0;
    const llm = {
      resolveModelInfo: async () => {
        n += 1;
        // 第一次说支持 low，第二次说支持 high —— 若缓存被永久占位，第二次读到的还是 low
        return n === 1 ? supports('off', 'low') : supports('off', 'high');
      },
    };
    const ctx = { get: (k: string) => (k === 'llm' ? llm : undefined) };
    const r = new ModelResolver(ctx as never, {} as never, undefined);

    const first = await r.sanitizeRouteAsync({ provider: 'p', model: 'm' });
    expect(first.effort).toBe('low');

    // 手动让缓存过期（TTL 5 分钟），模拟"过一会儿配置被改过"
    const anyR = r as unknown as { modelCaps: Map<string, { levels: string[]; at: number }> };
    const rec = anyR.modelCaps.get('p/m');
    expect(rec).toBeDefined();
    rec!.at = 0;                       // 强制过期
    // 同时确认去重表是干净的（泄漏时这里会残留一条）
    const inflight = (r as unknown as { capsInflight: Map<string, Promise<void>> }).capsInflight;
    expect(inflight.size).toBe(0);

    const second = await r.sanitizeRouteAsync({ provider: 'p', model: 'm' });
    expect(n).toBe(2);                 // 真的重拉了
    expect(second.effort).toBe('high'); // 拿到了新能力
  });
});
