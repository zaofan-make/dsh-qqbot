/**
 * 被引用消息的内容台账（2026-10-01 主人实测：**引用纯图片**看不到是哪张图）。
 *
 * 为什么要自己记：
 *   QQ 引用一条**纯图片**消息时，`msg_elements` 里往往只有个文件名（`[image: x.jpg]`）甚至
 *   什么都没有 —— 拿不到 URL / 本地路径，AI 就不知道被引用的是哪张图（实测：群里引用表情包回话，她答非所问）。
 *   而这条消息**入站那一刻**我们手里是有图片本地路径的
 *   （表情包采集中间件已落盘 + image-path-cache 已缓存 URL→本地路径）。
 *   → 入站时把「QQ 的 msg_idx → { 文本, 图片本地路径 }」记进本地台账；解析引用时按 `refKey` 回查补齐。
 *
 * 落盘：`{dataRoot}/.qqbot/msg-content.jsonl`（一行一条；超过 {@link MAX_LINES} 行时只留尾部）。
 *   ⚠️ 只存消息索引与**本机路径**，不存任何凭据；与本机图库同生命周期。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 单个 peer 保留的台账行数上限（超出只留尾部，防文件无限膨胀） */
const MAX_LINES = 2000;
const NL = String.fromCharCode(10);

/** 台账里存的一条：被引用消息的文本 + 图片本地路径 */
export interface MsgContent {
  /** 文本（截断） */
  t?: string;
  /** 图片**本地路径**（入站时由 image-path-cache 解析得到；AI 能直接读） */
  imgs?: string[];
  /** QQ message_id（2026-10-20 撤回功能用；引用补全不需要） */
  m?: string;
  /** 发送者 openid（机器人自己发时 'self'） */
  s?: string;
  /** 昵称 */
  n?: string;
  /** 消息类型 text/image/voice/video/file */
  k?: string;
  /** 是否机器人自己发的 */
  me?: boolean;
}

interface Row {
  /** peer 键：`group:<openid>` / `c2c:<openid>` */
  p: string;
  /** 索引键：引用补全用 REFIDX；撤回台账用 `m:<message_id>`（见 msg-history.ts） */
  i: string;
  t?: string;
  imgs?: string[];
  /** QQ message_id（撤回用） */
  m?: string;
  /** 发送者 openid */
  s?: string;
  /** 昵称 */
  n?: string;
  /** 消息类型 */
  k?: string;
  /** 是否机器人自己发的 */
  me?: boolean;
  at: number;
}

/** 文件路径 → { mtimeKey, index, lines } */
const cache = new Map<string, { key: string; index: Map<string, MsgContent>; lines: number; list: Row[] }>();

function fileOf(dataRoot: string): string {
  return join(dataRoot, '.qqbot', 'msg-content.jsonl');
}

function indexKey(peerKey: string, msgIdx: string): string {
  return peerKey + '\u0000' + msgIdx;
}

function load(dataRoot: string): { index: Map<string, MsgContent>; lines: number; list: Row[] } {
  const file = fileOf(dataRoot);
  let key = 'missing';
  try {
    const st = statSync(file);
    key = st.mtimeMs + ':' + st.size;
  } catch { /* 还没有台账文件 */ }
  const hit = cache.get(file);
  // 'dirty' = 本进程刚写过，内存比文件新 → 直接用内存，别重读整个文件
  if (hit && (hit.key === key || hit.key === 'dirty')) return { index: hit.index, lines: hit.lines, list: hit.list };
  const index = new Map<string, MsgContent>();
  const list: Row[] = [];
  let lines = 0;
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      lines++;
      try {
        const r = JSON.parse(s) as Row;
        if (!r || !r.p || !r.i) continue;
        list.push(r);
        index.set(indexKey(r.p, r.i), {
          ...(r.t ? { t: r.t } : {}),
          ...(Array.isArray(r.imgs) && r.imgs.length ? { imgs: r.imgs } : {}),
          ...(r.m ? { m: r.m } : {}),
          ...(r.s ? { s: r.s } : {}),
          ...(r.n ? { n: r.n } : {}),
          ...(r.k ? { k: r.k } : {}),
          ...(r.me ? { me: true } : {}),
        });
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 没有文件 */ }
  cache.set(file, { key, index, lines, list });
  return { index, lines, list };
}

/**
 * 记一条：这条消息（msgIdx）的文本与图片本地路径。
 * 之后有人**引用它**时，就能靠 `refKey = msgIdx` 回查到"被引用的到底是哪张图"。
 */
export function rememberMsgContent(dataRoot: string, peerKey: string, msgIdx: string, rec: MsgContent): void {
  const idx = String(msgIdx ?? '').trim();
  if (!dataRoot || !peerKey || !idx) return;
  // 2026-10-20: 现在也承载"撤回台账"，只有 message_id 没有正文时同样要记
  if (!rec.t && !(rec.imgs && rec.imgs.length) && !rec.m) return;
  const { index, lines, list } = load(dataRoot);
  index.set(indexKey(peerKey, idx), rec);
  const file = fileOf(dataRoot);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const row = { p: peerKey, i: idx, ...rec, at: Date.now() } as Row;
    appendFileSync(file, JSON.stringify(row) + '\n');
    // ★★ 2026-11-14 修（审查发现）：新行原来只进 index、**不进 list**。
    //   list 既是 scanMsgContent 的唯一数据源，又是超上限重写的保留集 ——
    //   于是：①进程启动后写入的消息扫不到；②台账满时最新那条被 slice 掉、**物理删除**。
    list.push(row);
    const nextLines = lines + 1;
    if (nextLines > MAX_LINES) {
      // 超上限 → 重写成尾部 MAX_LINES 条（内存里已有的直接重建）
      // 用 list 重写(保留每行 at 与顺序); 旧实现按 index 重建会把 at 丢成 0, 按时间窗扫描会全判过期。
      const keep = list.slice(-MAX_LINES);
      writeFileSync(file, keep.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
      cache.set(file, { key: 'dirty', index, lines: keep.length, list: keep });
      return;
    }
    cache.set(file, { key: 'dirty', index, lines: nextLines, list });
  } catch { /* 落盘失败不影响主链（内存索引已经更新） */ }
}

/** 回查：这条被引用消息（msgIdx）我们记过什么 */
export function lookupMsgContent(dataRoot: string, peerKey: string, msgIdx: string): MsgContent | undefined {
  if (!dataRoot || !peerKey || !msgIdx) return undefined;
  try {
    return load(dataRoot).index.get(indexKey(peerKey, msgIdx));
  } catch {
    return undefined;
  }
}

export interface MsgScanQuery {
  /** 只看多少毫秒内（默认 2 小时） */
  withinMs?: number;
  /** 最多几条（默认 20，上限 200） */
  limit?: number;
  /** 关键词（子串，忽略大小写；匹配正文 t） */
  keyword?: string;
  /** 类型筛选 */
  kind?: string;
  /** true=只机器人自己发的；false=只别人发的；不填=都算 */
  fromSelf?: boolean;
  /** 只看某个发送者 */
  senderId?: string;
}

/**
 * 扫该 peer 的台账（2026-10-20 撤回功能/消息搜索用）。
 * ★ 严格按 peerKey 过滤 —— 群与群、群与私聊绝不串。
 * 返回新→旧（同一毫秒内按写入顺序倒序）。
 */
export function scanMsgContent(dataRoot: string, peerKey: string, q: MsgScanQuery = {}): Row[] {
  if (!dataRoot || !peerKey) return [];
  let list: Row[] = [];
  try {
    list = load(dataRoot).list;
  } catch {
    return [];
  }
  const now = Date.now();
  const within = q.withinMs ?? 2 * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(200, q.limit ?? 20));
  const kw = String(q.keyword ?? '').trim().toLowerCase();
  const out: Row[] = [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const r = list[i];
    if (!r || r.p !== peerKey) continue;
    if (now - Number(r.at ?? 0) > within) continue;
    if (q.fromSelf !== undefined && Boolean(r.me) !== q.fromSelf) continue;
    if (q.senderId && r.s !== q.senderId) continue;
    if (q.kind && (r.k ?? 'text') !== q.kind) continue;
    if (kw && !String(r.t ?? '').toLowerCase().includes(kw)) continue;
    out.push(r);
  }
  return out;
}
