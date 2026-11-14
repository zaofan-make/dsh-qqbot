import { existsSync } from 'node:fs';
/**
 * image-path-cache.ts — QQ 图片 URL → 本地文件路径 的小缓存
 *
 * 背景(2026-09-13 主人要求): 入站消息里原来只给 QQ 的临时下载 URL
 * (`https://multimedia.nt.qq.com.cn/download?fileid=…&rkey=…` —— 又长又会过期),
 * 结果 AI 要"看图"时还得再下一次(而且它下不动); 现在收藏插件本来就会把图落盘,
 * 于是**直接把本地路径写进消息**, token 更短、看图直接读盘。
 *
 * 为什么用模块级缓存而不是 ctx.state:
 *   - 聚合/连发(debounce)路径 flush 时会**新建 state** 再调 handleInbound,
 *     中间件阶段挂在 ctx.state 上的东西到那时就丢了;
 *   - 同一张图在"中间件阶段"与"消息组装阶段"用的 key 就是那个 URL 本身, 直接按 URL 查最稳。
 *
 * 失效: TTL 1 小时(候选区会滚动清理, 过期后回退用原始 URL) + 容量上限 800 条(超出淘汰最旧)。
 */
import type { Logger } from '../types.js';

interface Entry {
  /** 本地绝对路径 */
  p: string;
  /** 写入时间戳(ms) */
  t: number;
}

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 800;

const cache = new Map<string, Entry>();

/**
 * QQ 图片 URL 的"稳定键"（2026-09-24 修）。
 *
 * 实测：同一张图两次推送的 URL 里 `rkey`(临时凭证) 会变，**连 fileid 的后半段也不同**，
 * 只有 **前 40 字符**稳定：
 *   ...fileid=EhSNej89…FIP8KK[JXGg_SEhpcDMgRwcm9k]…&rkey=CAISONPs…
 *   ...fileid=EhSNej89…FIP8KK[PDVtrGFhpcDMgRwcm9k]…&rkey=CAQSODOc…
 * 只按完整 URL 缓存 → 每次都是 miss → 消息里只能显示长 URL（AI 还得自己下载、通常下不动）。
 */
function stableKey(u: string): string | undefined {
  try {
    const parsed = new URL(String(u));
    const fid = parsed.searchParams.get('fileid');
    if (fid) return 'fid:' + fid.slice(0, 40);
  } catch { /* 非标准 URL */ }
  return undefined;
}

/** 记一条 URL → 本地路径(下载成功时调用) */
export function rememberImagePath(url: string, localPath: string): void {
  if (!url || !localPath) return;
  const e = { p: localPath, t: Date.now() };
  cache.set(url, e);
  // 同时按稳定键存一份：URL 变了(新 rkey)也能命中
  const k = stableKey(url);
  if (k) cache.set(k, e);
  if (cache.size > MAX_ENTRIES) {
    // Map 保留插入顺序 → 最旧的就是第一个
    const over = cache.size - MAX_ENTRIES;
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= over) break;
    }
  }
}

/** 查本地路径(没有/过期 → undefined, 调用方回退原始 URL) */
export function lookupImagePath(url: string | undefined, logger?: Logger): string | undefined {
  if (!url) return undefined;
  // 先按完整 URL 查，miss 再按稳定键(fileid 前缀)查 —— 后者能跨 rkey/fileid 尾部变化命中
  const k = stableKey(url);
  const e = cache.get(url) ?? (k ? cache.get(k) : undefined);
  if (!e) return undefined;
  if (Date.now() - e.t > TTL_MS) {
    cache.delete(url);
    logger?.debug(`[img-path] 缓存过期, 回退 URL: ${url.slice(0, 60)}…`);
    return undefined;
  }
    // ★★ 2026-11-14（CodeRabbit）：缓存命中也要**确认文件还在** ——
    //   quote-images 的定期回收会删掉超过 KEEP_DAYS 的文件，而缓存时间没到，
    //   这里就会把一个已删除的路径返回给上层（AI 读图直接失败，还查不出原因）。
    if (!existsSync(e.p)) {
      cache.delete(url);
      if (k) cache.delete(k);
      logger?.debug(`[img-path] 缓存指向的文件已不存在, 回退 URL: ${String(e.p).slice(0, 80)}`);
      return undefined;
    }
  return e.p;
}

/** 当前缓存条数(诊断用) */
export function imagePathCacheSize(): number {
  return cache.size;
}
