/**
 * quote-cache.ts — 引用消息原文缓存（省 token 用）
 *
 * 背景（2026-09-13 主人定）: 引用消息会把**被引用的原文**整段塞进上下文, 引用一长就很吃 token。
 * 现在入站只给**前 N 字**（inbound 里 QUOTE_KEEP, 默认 60), 完整原文落到本地缓存
 * （**每个会话最多 10 条**, 超出丢最旧), AI 需要时用 `quote_view` 工具取（默认最新一条）。
 *
 * 存储: `{dataRoot}/.qqbot/quote-cache.json`
 *   `{ seq: 自增编号, map: { "group:<gid>" | "c2c:<openid>": [{id,text,sender,at}, …] } }`
 * 编号全局自增（人也能在文件里直接看/对号), 每个会话各自留最近 10 条。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 每个会话保留的条数（主人定: 最多 10 条） */
export const QUOTE_CACHE_MAX = 10;

export interface QuoteEntry {
  /** 编号（全局自增, 引用块里会标出来, 如 `引用#12`） */
  id: number;
  /** 被引用的完整原文 */
  text: string;
  /** 引用者昵称(有就给) */
  sender?: string;
  /** 入站时间戳(ms) */
  at: number;
}

interface CacheFile {
  /** 旧的全局自增编号（兼容老文件；新逻辑改用 day/count） */
  seq: number;
  /**
   * ★ 2026-11-01（主人定）：编号改成**当天内累加、第二天重置**。
   *
   * 为什么不是 1~10 循环：缓存只留 10 条，循环编号会在淘汰后**指向别的条目** ——
   * 同一天里 `#3` 今天指 A、明天指 B，引用直接错乱。
   * 为什么不是全局自增：号会越涨越大（已经到 #4407），看着像"缓存里有几千条"，
   * 实际只有 10 条，纯噪音。
   * 折中就是按天重置：**当天内唯一且单调**（不会错乱），第二天从 1 重新开始（不会无限涨）。
   */
  day?: string;
  count?: number;
  map: Record<string, QuoteEntry[]>;
}

const cache = new Map<string, CacheFile>();

function fileOf(dataRoot: string): string {
  return join(dataRoot, '.qqbot', 'quote-cache.json');
}

function load(dataRoot: string): CacheFile {
  const hit = cache.get(dataRoot);
  if (hit) return hit;
  let data: CacheFile = { seq: 0, map: {} };
  try {
    const raw = JSON.parse(readFileSync(fileOf(dataRoot), 'utf8')) as CacheFile;
    if (raw && typeof raw === 'object' && raw.map && typeof raw.map === 'object') {
      data = { seq: Number(raw.seq) || 0, map: raw.map };
    }
  } catch { /* 首次/损坏 → 空缓存 */ }
  cache.set(dataRoot, data);
  return data;
}

function save(dataRoot: string, data: CacheFile): void {
  try {
    const p = fileOf(dataRoot);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data), 'utf8');
  } catch { /* 缓存写失败不影响主链 */ }
}

/** 本地日期键 YYYY-MM-DD（编号按天重置的判据） */
function todayKey(): string {
  const d = new Date();
  const p = (n: number): string => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 取下一个编号：当天内累加，跨天重置为 1 */
function nextId(data: CacheFile): number {
  const today = todayKey();
  if (data.day !== today) {
    data.day = today;
    data.count = 0;
  }
  data.count = (Number(data.count) || 0) + 1;
  return data.count;
}

/** 存一条引用原文, 返回它的编号（超上限丢最旧） */
export function pushQuote(dataRoot: string, key: string, text: string, sender?: string): QuoteEntry {
  const data = load(dataRoot);
  const entry: QuoteEntry = { id: nextId(data), text: String(text || ''), sender, at: Date.now() };
  const list = Array.isArray(data.map[key]) ? data.map[key] : [];
  list.push(entry);
  data.map[key] = list.slice(-QUOTE_CACHE_MAX);
  save(dataRoot, data);
  return entry;
}

/** 某会话的引用列表（新→旧） */
export function listQuotes(dataRoot: string, key: string): QuoteEntry[] {
  const list = load(dataRoot).map[key];
  return Array.isArray(list) ? [...list].reverse() : [];
}

/** 按编号取; 不传 id = 最新一条; 传了但不在本会话 = undefined */
export function getQuote(dataRoot: string, key: string, id?: number): QuoteEntry | undefined {
  const list = load(dataRoot).map[key];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  if (typeof id === 'number' && Number.isFinite(id)) return list.find((x) => x.id === id);
  return list[list.length - 1];
}
