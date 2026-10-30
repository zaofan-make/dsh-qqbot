/**
 * c2c-name.ts —— 私聊昵称兜底：用 openid 反查群成员台账（2026-10-30）
 *
 * 背景（主人实测纠正后的结论）：
 *   · **同一机器人实例内，私聊的 openid 与群里的 member_openid 是一致的**
 *     （例：主人在鲸鱼娘的群里和私聊都是 `E9020753...`）。
 *   · 但 SDK 的 C2C 事件解析**漏读了 `author.username`**（见
 *     qqbot-nodejs/dist/protocol/gateway/event-dispatcher.js 的 C2C_MESSAGE_CREATE 分支：
 *     只有 `senderId: ev.author.user_openid`，没有 `senderName`），于是私聊里 senderName 是空，
 *     显示成了 openid，AI 也就不知道在和谁说话。
 *
 * 做法：拿私聊的 senderId 去插件自己维护的群成员台账
 *   `{dataRoot}/表情包/group-members.jsonl`（每行 {ts,gid,mid,name}）里按 `mid` 匹配，
 *   命中就用最近一次的 `name` 当 senderName。
 *
 * 限制（如实记录，别以后又当成 bug）：
 *   台账只收「在群里发过言 / 申请过入群」的人。所以
 *   ① 在群里说过话 + 私聊 → 能反查到昵称 ✅
 *   ② 从没在群里说过话、直接私聊 → 台账里没有他，仍显示 openid（这是数据缺失，不是 bug）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface LedgerEntry {
  mid?: string;
  name?: string;
}

/** 台账缓存（按文件 mtime+size 失效，避免每条私聊都全量解析） */
let cache: { key: string; map: Map<string, string> } | null = null;

function ledgerPath(dataRoot: string): string {
  return join(dataRoot, '表情包', 'group-members.jsonl');
}

/** openid → 昵称（台账里同名多条时取后出现的那个）。查不到返回空串。 */
export function c2cNameOf(dataRoot: string, openid: string): string {
  const id = String(openid ?? '').trim();
  const root = String(dataRoot ?? '').trim();
  if (!id || !root) return '';

  const file = ledgerPath(root);
  if (!existsSync(file)) return '';

  try {
    const st = statSync(file);
    const key = `${root}|${st.mtimeMs}|${st.size}`;
    if (!cache || cache.key !== key) {
      const map = new Map<string, string>();
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as LedgerEntry;
          const mid = String(o.mid ?? '').trim();
          const name = String(o.name ?? '').trim();
          // 后出现的覆盖前面的（台账 append-only，越靠后越新）
          if (mid && name) map.set(mid, name);
        } catch { /* 坏行跳过 */ }
      }
      cache = { key, map };
    }
    return cache.map.get(id) ?? '';
  } catch {
    return '';
  }
}
