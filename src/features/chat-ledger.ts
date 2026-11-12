/**
 * chat-ledger.ts — 聊天台账(M3 v4, 2026-09-03 新增; 2026-09-05 加群成员维度)
 *
 * 定时唤醒/遥控台要"选一个聊天对象"却要主人手抄 openid——体验失败(主人已吐槽)。
 * 本模块把机器人见过的每个聊天(群/私聊)自动记台账：
 *   {dataDir}/known-chats.jsonl  append-only 一行一条
 *   {ts, scope:'group'|'c2c', id, name?}
 *     - c2c: id=用户 openid, name=用户昵称(QQ 平台给的 senderName)
 *     - group: id=group_openid, name=该群最近一条发言者昵称(群无群名, 用成员名帮主人辨认)
 * 同时按群记成员(官方"成员列表"未开放时的本地兜底名单, 供群管理面板选人禁言):
 *   {dataDir}/group-members.jsonl  {ts, gid, mid, name?}  append-only
 * host 半边读此文件聚合出"最近聊过的对象"下拉, ④区点选即填 targetId; 群管理读成员聚合出可选人。
 * 中间件挂在 mentionGate 之前(未@消息也流经), 与活性计数同位置。
 *
 * ⚠️ 本地手改功能（fork 新增）：维护清单见工作区根《插件改动维护注意事项.md》。
 */
import { appendFileSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// 台账自动去重(2026-09-07 主人定): append 照旧(简单并发安全), 文件每攒 COMPACT_EVERY 条自动压缩一次,
// 按对象(群/人 或 群成员)只保留最新一条 → "一个人只记一条", 文件不随发言膨胀; 读端聚合语义不变。
const COMPACT_EVERY = 200;
const NL = String.fromCharCode(10);
const appendCount = new Map<string, number>();
function ledgerKeyOf(o: { scope?: string; id?: string; gid?: string; mid?: string }): string {
  if (o.scope && o.id) return o.scope + ':' + o.id;
  if (o.gid && o.mid) return o.gid + ':' + o.mid;
  return '';
}
function compactLedgerFile(file: string): void {
  appendCount.set(file, 0);
  try {
    const raw = readFileSync(file, 'utf8');
    const map = new Map<string, unknown>();
    for (const l of raw.split(NL)) {
      const t = l.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as { ts?: number; scope?: string; id?: string; gid?: string; mid?: string };
        if (typeof o.ts !== 'number') continue;
        const key = ledgerKeyOf(o);
        if (!key) continue;
        const cur = map.get(key) as { ts?: number } | undefined;
        if (!cur || (o.ts as number) > (cur.ts || 0)) map.set(key, o);
      } catch { /* 坏行跳过 */ }
    }
    if (map.size === 0) return;
    // ★ 2026-11-12（外部 AI 审查启发）：**不再每次全表 sort**。
    //   压缩只需要"每个 key 留最新一条 + 稳定顺序"，而 jsonl 的物理顺序对读取方没有语义要求
    //   （读取方一律按 ts 自己排）。Map 的插入顺序天然稳定，直接用即可，
    //   省掉一次 O(n log n) —— 这条路径每 200 次追加会跑一次，人多的实例上能明显省。
    const out = [...map.values()].map((o) => JSON.stringify(o)).join(NL) + NL;
    const tmp = file + '.tmp-' + Date.now();
    writeFileSync(tmp, out, 'utf8');
    renameSync(tmp, file);
  } catch { /* 压缩失败不影响主链 */ }
}
function noteLedgerAppend(file: string): void {
  const n = (appendCount.get(file) || 0) + 1;
  appendCount.set(file, n);
  if (n >= COMPACT_EVERY) compactLedgerFile(file);
}
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

export interface KnownChatLine {
  ts: number;
  scope: 'group' | 'c2c';
  id: string;
  name?: string;
}

/** 群成员行(本地兜底名单: 官方成员列表未开放, 用"见过的发言者"近似) */
export interface KnownGroupMember {
  ts: number;
  gid: string;
  mid: string;
  name?: string;
}

/** 台账文件路径(与图库同 dataDir, host 侧可经 sticker store 推导) */
export function ledgerPath(dataDir: string): string {
  return join(dataDir, 'known-chats.jsonl');
}

/** 群成员台账路径(同 dataDir) */
export function groupMembersPath(dataDir: string): string {
  return join(dataDir, 'group-members.jsonl');
}

/** 由 dsh-qqbot 侧写入(中间件); host 侧只读聚合 */
export function appendLedger(dataDir: string, line: KnownChatLine): void {
  try {
    appendFileSync(ledgerPath(dataDir), JSON.stringify(line) + NL, 'utf8');
    noteLedgerAppend(ledgerPath(dataDir));
  } catch { /* 台账失败不影响主链 */ }
}

/** 由 dsh-qqbot 侧写入一条"群成员发言"(中间件); host 侧读聚合出可禁言名单 */
export function appendGroupMember(dataDir: string, line: KnownGroupMember): void {
  try {
    appendFileSync(groupMembersPath(dataDir), JSON.stringify(line) + NL, 'utf8');
    noteLedgerAppend(groupMembersPath(dataDir));
  } catch { /* 台账失败不影响主链 */ }
}

/** 读某群的本地成员清单(聚合: 每成员保留最近昵称/最近时间/发言次数, 按最近发言倒序) */
export function readGroupMembers(dataDir: string, gid?: string): Array<{ gid: string; mid: string; name?: string; lastSeen: number; count: number }> {
  try {
    const raw = readFileSync(groupMembersPath(dataDir), 'utf8');
    const map = new Map<string, { gid: string; mid: string; name?: string; lastSeen: number; count: number }>();
    for (const l of raw.split('\n')) {
      const t = l.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as KnownGroupMember;
        if (!o || typeof o.mid !== 'string' || !o.mid || typeof o.gid !== 'string' || !o.gid) continue;
        if (gid && o.gid !== gid) continue;
        const key = `${o.gid}:${o.mid}`;
        const cur = map.get(key);
        if (!cur) map.set(key, { gid: o.gid, mid: o.mid, name: o.name, lastSeen: o.ts, count: 1 });
        else {
          cur.count += 1;
          if (o.ts > cur.lastSeen) { cur.lastSeen = o.ts; if (o.name) cur.name = o.name; }
        }
      } catch { /* 坏行跳过 */ }
    }
    return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 300);
  } catch {
    return [];
  }
}

/** host 侧读台账文件(不存在/坏行容错), 返回按 ts 升序的行 */
export function readLedger(dataDir: string): KnownChatLine[] {
  try {
    const raw = readFileSync(ledgerPath(dataDir), 'utf8');
    const lines: KnownChatLine[] = [];
    for (const l of raw.split('\n')) {
      const t = l.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as KnownChatLine;
        if (o && typeof o.id === 'string' && (o.scope === 'group' || o.scope === 'c2c')) {
          lines.push({ ts: typeof o.ts === 'number' ? o.ts : 0, scope: o.scope, id: o.id, name: typeof o.name === 'string' ? o.name : undefined });
        }
      } catch { /* 坏行跳过 */ }
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * 聚合"最近聊过的对象"(供下拉): 每对象保留最近 ts/最近昵称 + 消息数。
 * c2c 优先展示昵称; group 无群名, name=该群最近发言者昵称。
 */
export function aggregateKnownChats(
  lines: KnownChatLine[],
  limit = 60,
): Array<{ scope: 'group' | 'c2c'; id: string; name?: string; lastSeen: number; count: number }> {
  const map = new Map<string, { scope: 'group' | 'c2c'; id: string; name?: string; lastSeen: number; count: number }>();
  for (const l of lines) {
    const key = `${l.scope}:${l.id}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { scope: l.scope, id: l.id, name: l.name, lastSeen: l.ts, count: 1 });
    } else {
      cur.count += 1;
      if (l.ts > cur.lastSeen) {
        cur.lastSeen = l.ts;
        if (l.name) cur.name = l.name; // group: 群名不可得, 用最近发言者昵称帮助辨认
      }
    }
  }
  return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
}

/** 台账文件大小(给 host 状态用; 不存在返回 0) */
export function ledgerSize(dataDir: string): number {
  try {
    return statSync(ledgerPath(dataDir)).size;
  } catch {
    return 0;
  }
}

/**
 * 移除某群某成员的本地记录(成员已退群/禁言无效时调用, 保持本地名单干净)。
 * 重写文件剔除该 gid+mid 的所有行; 文件不存在/无匹配则不动。
 */
export function removeGroupMember(dataDir: string, gid: string, mid: string): void {
  try {
    const p = groupMembersPath(dataDir);
    const raw = readFileSync(p, 'utf8');
    const kept: string[] = [];
    let removed = 0;
    for (const l of raw.split('\n')) {
      const t = l.trim();
      if (!t) { kept.push(''); continue; }
      try {
        const o = JSON.parse(t) as KnownGroupMember;
        if (o && o.gid === gid && o.mid === mid) { removed += 1; continue; }
      } catch { /* 坏行保留 */ }
      kept.push(l);
    }
    if (removed > 0) {
      writeFileSync(p, kept.join('\n').replace(/\n{2,}/g, '\n').trimEnd() + (kept.length ? '\n' : ''), 'utf8');
    }
  } catch { /* 忽略 */ }
}

/** (台账文件 → gid+mid → 昵称) 索引缓存（按 mtime/size 失效，避免每条消息重读整个文件） */
const memberNameCache = new Map<string, { key: string; index: Map<string, string> }>();

/** mid → 昵称（查群成员台账；查不到返回 undefined） */
export function lookupGroupMemberName(dataDir: string, gid: string, mid: string): string | undefined {
  const g = String(gid || '');
  const m = String(mid || '');
  if (!g || !m) return undefined;
  const file = groupMembersPath(dataDir);
  let key = 'missing';
  try {
    const st = statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch { /* 还没有台账 */ }
  const hit = memberNameCache.get(file);
  let index: Map<string, string>;
  if (hit && hit.key === key) {
    index = hit.index;
  } else {
    index = new Map<string, string>();
    try {
      for (const r of readGroupMembers(dataDir)) {
        if (r.gid && r.mid && r.name) index.set(`${r.gid}\u0000${r.mid}`, r.name);
      }
    } catch { /* 台账读不出就当空 */ }
    memberNameCache.set(file, { key, index });
  }
  return index.get(`${g}\u0000${m}`);
}

/**
 * 把正文里 @ **别人**的 `<@openid>` 换成 `@昵称`。
 *
 * 2026-10-01 主人实测：「别人 @ 别人怎么没转换成昵称，依然是 id」——
 *   群消息里 @ 别人时 content 带 32 位 openid，原样喂给 AI 谁也看不出 @ 的是谁（而且吃 token）。
 *   · 昵称查**群成员台账**（在群里发过言的人都有）；查不到退化成 `@` + id 前 6 位（与 dock 侧 chatDisplayClean 同口径）。
 *   · **省 token**：`<@07B470BDA5052489D2D0532C2CC2A2EB>`(35 字符) → `@难崩`(3 字符)。
 *   · @**我自己**的标记早被 `replaceBotMention` 换成了 `@bot`，这里不会再碰到。
 *   · 只在群聊（有 gid）生效；查不到台账就不动（宁可留 id 也别瞎猜）。
 */
export function resolveMentionNames(text: string, dataDir: string, gid?: string): string {
  const s = String(text ?? '');
  if (!s || s.indexOf('<@') < 0 || !gid) return s;
  return s.replace(/<@!?([A-Za-z0-9_-]{6,})>/g, (_all, id: string) => {
    const nm = lookupGroupMemberName(dataDir, gid, id);
    return nm ? `@${nm}` : `@${id.slice(0, 6)}`;
  });
}

/** 中间件: 记录见过的群/私聊 + 群内发言成员(放 mentionGate 之前, 未@消息也流经) */
export function chatLedgerRecorder(dataDir: string) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    try {
      const msg = ctx.message as { kind?: string; senderId?: string; senderName?: string; groupOpenid?: string };
      const now = Date.now();
      if (msg.kind === 'group' && msg.groupOpenid) {
        appendLedger(dataDir, { ts: now, scope: 'group', id: msg.groupOpenid, name: msg.senderName || undefined });
        // 群成员兜底名单(官方成员列表未开放): 每个发言者都记, 禁言面板按群聚合可"选人"
        if (msg.senderId) {
          appendGroupMember(dataDir, { ts: now, gid: msg.groupOpenid, mid: msg.senderId, name: msg.senderName || undefined });
        }
      } else if ((msg.kind === 'c2c' || msg.kind === 'direct') && msg.senderId) {
        appendLedger(dataDir, { ts: now, scope: 'c2c', id: msg.senderId, name: msg.senderName || undefined });
      }
    } catch { /* 记录失败不影响主链 */ }
    await next();
  };
}
