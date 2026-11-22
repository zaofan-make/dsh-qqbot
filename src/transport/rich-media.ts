/**
 * rich-media.ts — agent 富媒体出站 / 撤回 的结构化标记解析与来源解析
 *
 * agent 在回复文本里输出以下标记即可触发发送/撤回（发送层把指令从展示文本中剔除）：
 *   [MEDIA:image|<url|本地路径>]
 *   [MEDIA:video|<url|本地路径>]
 *   [MEDIA:voice|<url|本地路径>]
 *   [MEDIA:file|<url|本地路径>]
 *   [RECALL]                // 撤本 bot 发给该 peer 的最近一条(= [RECALL:1])
 *   [RECALL:2]              // 撤倒数第 2 条；[RECALL:N] 撤倒数第 N 条
 *
 * 仅纯函数/正则，便于单测；发送动作由调用方(outbound)根据 Segment 分派到 QQBotSender。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type MediaKind = 'image' | 'video' | 'voice' | 'file';

/**
 * 富媒体标记：支持单个或多段连续出现。
 *
 * ★ CodeRabbit #83：src 允许出现成对的 `[...]` —— Windows 路径常带方括号目录
 *   （`C:\pics\[旅行]\a.png`），原来的 `[^\]]+` 会在第一个 `]` 处截断，把 `\a.png]` 当正文残留。
 */
const MEDIA_RE = /\[MEDIA:(image|video|voice|file)\|((?:[^\[\]]|\[[^\[\]]*\])+)\]/g;

/**
 * 尖括号容错（issue #81）：模型偶发把方括号标记写成尖括号变体，
 * 而出站全线只认方括号 —— 整段（含本地图库路径）会按纯文本发到群里，路径泄漏、图也没发出去。
 *
 * 规则：
 *   - 不区分大小写、容忍标记内空白；
 *   - src 必须带路径特征（反斜杠或正斜杠）才转换：正文里讨论格式的字样
 *     （如「发图格式是 <MEDIA:image|你的图片路径>」）保持原样，不误伤；
 *   - kind 统一小写：present 去重正则 /\[MEDIA:file\|...\]/g 没有 i 标志，
 *     保留大写变体会绕过去重，造成同一文件发两遍。
 */
const ANGLE_MEDIA_RE = /<\s*MEDIA\s*:\s*(image|video|voice|file)\s*\|\s*([^<>]*?)\s*>/gi;

/** 把带路径的尖括号媒体标记规范化成方括号形式；其余文本原样返回。 */
export function normalizeMediaMarkers(text: string): string {
  if (typeof text !== 'string' || text.indexOf('<') === -1) return text;
  return text.replace(ANGLE_MEDIA_RE, (whole, kind: string, src: string) => {
    if (!/[\\/]/.test(src)) return whole;
    return '[MEDIA:' + kind.toLowerCase() + '|' + src + ']';
  });
}
/** 撤回标记：支持 [RECALL] 或 [RECALL:N]（N=撤倒数第 N 条，默认 1） */
const RECALL_RE = /\[RECALL(?::\s*(\d+))?\]/;
/** 全局版：一次性清除/收集文本里所有撤回指令 */
const RECALL_G_RE = /\[RECALL(?::\s*(\d+))?\]/g;
/** 引用消息标记：[rf:短消息号] — 出站时这条消息以"引用回复"形式发出(2026-09-13 主人定:
 *  短号(如 0913a)省 token, 台账查表还原完整 msg_id, 见 transport/msg-index.ts) */
const REF_TAG_RE = /\[rf:([^\]\s]{1,32})\]/gi;

/** 是否含撤回指令 */
export function containsRecall(text: string): boolean {
  RECALL_RE.lastIndex = 0;
  return RECALL_RE.test(text);
}

/** 收集文本里出现的所有撤回指令序号(按出现顺序)。[RECALL]→1。无则返回空数组。 */
export function collectRecallIndices(text: string): number[] {
  RECALL_G_RE.lastIndex = 0;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = RECALL_G_RE.exec(text)) !== null) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    out.push(Number.isFinite(n) && n >= 1 ? n : 1);
  }
  return out;
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: MediaKind; source: string };

/** 是否含富媒体指令 */
export function containsMedia(text: string): boolean {
  MEDIA_RE.lastIndex = 0;
  return MEDIA_RE.test(normalizeMediaMarkers(text));
}

/**
 * 把一段 agent 文本拆成 Segment[]：文本段与富媒体段交替。
 * 富媒体标记被剔除；[RECALL] 不在此拆分（由调用方单独处理，避免污染文本段）。
 */
export function parseOutbound(text: string): Segment[] {
  const normalized = normalizeMediaMarkers(text);
  const segments: Segment[] = [];
  MEDIA_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_RE.exec(normalized)) !== null) {
    if (m.index > last) {
      const t = normalized.slice(last, m.index);
      if (t.trim()) segments.push({ type: 'text', text: t });
    }
    const kind = m[1] as MediaKind;
    const source = (m[2] ?? '').trim();
    if (source) segments.push({ type: 'media', kind, source });
    last = m.index + m[0].length;
  }
  if (last < normalized.length) {
    const t = normalized.slice(last);
    if (t.trim()) segments.push({ type: 'text', text: t });
  }
  return segments;
}

/**
 * 把标记文本清理成"仅剩要展示的纯文本"（去掉富媒体/撤回/引用指令），供降级/预览。
 */
export function stripDirectives(text: string): string {
  return normalizeMediaMarkers(text).replace(MEDIA_RE, '').replace(RECALL_G_RE, '').replace(REF_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 提取引用消息标记：[rf:短消息号]（2026-09-13 主人定）。
 * 命中返回 { index, rest }；rest 为剔除该标记后的剩余文本。无标记返回 undefined。
 * 同一段文本只取第一个标记（一条消息只能引用一条）。
 */
export function extractRefTag(text: string): { index: string; rest: string } | undefined {
  REF_TAG_RE.lastIndex = 0;
  const m = REF_TAG_RE.exec(text);
  if (!m) return undefined;
  const index = (m[1] ?? '').trim();
  if (!index) return undefined;
  const rest = text.replace(REF_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { index, rest };
}

/**
 * 把 agent 给出的 source 解析为可直接喂给底层 sendImage/sendFile 的来源。
 * 规则：
 *   http(s)://  → 原样(URL)
 *   file://     → 本地绝对路径
 *   Windows 盘符/绝对路径 → 原样
 *   其余(相对) → 相对 cwd 解析为绝对路径
 * 返回 { kind: 'url', url } | { kind: 'localPath', path }，便于底层分发。
 */
export function resolveSource(source: string, cwd: string | undefined): { kind: 'url'; url: string } | { kind: 'localPath'; path: string } {
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
  if (s.startsWith('file://')) {
    try { return { kind: 'localPath', path: fileURLToPath(s) }; }
    catch { return { kind: 'localPath', path: s.replace(/^file:\/\//, '') }; }
  }
  // Windows 盘符或绝对路径
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) return { kind: 'localPath', path: s };
  // 相对 → 相对 cwd
  return { kind: 'localPath', path: cwd ? path.resolve(cwd, s) : s };
}
