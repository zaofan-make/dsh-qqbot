/**
 * session-kind.ts —— 「当前是什么渠道 + 对方/群叫什么」（issue #79，2026-11-21）
 *
 * 问题：私聊消息注入格式（`[昵称 #ref]: "正文"`）与群聊几乎同构，插件全程没有
 * 任何"这是私聊/群聊"的显式标注 ⇒ 模型只能靠猜，实测把私聊判成群聊（按群规矩回复）。
 *
 * 名字来源（主人 2026-11-21 定：**直接走官方 API，不读台账**）：
 *   · 群聊：`GET /v2/groups/{group_openid}/info` → `group_name`
 *     （`api/group-admin.ts` 已有 `getGroupInfo`；30 QPM、需白名单权限，11253 = 无权限）
 *   · 私聊：`GET /v2/users/{user_openid}/info` → `username`
 *     （2026-11-17 官方新增的 `getUserInfo`，唯一一条还开着的"拿名字"的路）
 * 两者都**缓存 + 后台预取**：注入是同步回调，绝不能在回合里等网络；
 * 拿不到就只写"群聊/私聊"，不编名字。
 *
 * 注入方式：由 `session-manager` 以**独立 user/message 事件**注入
 * （`source.kind = 'qqbot:session-kind'`；带 `qqbot:` 前缀是维护手册 §11.21 的硬要求，
 * 否则 dock 聊天视图会把注入内容当成对方说的话）。不拼进真实用户消息的 content。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';


/** `getGroupInfo` / `getUserInfo` 的最小形状（只用到这两个） */
export interface SessionKindClient {
  getGroupInfo?: (gid: string) => Promise<{ ok?: boolean; data?: { group_name?: string } } | undefined>;
  getUserInfo?: (openid: string) => Promise<{ ok?: boolean; data?: { username?: string } } | undefined>;
}

interface CacheEntry { name: string; at: number }

/** 群名缓存：gid → name */
const groupNameCache = new Map<string, CacheEntry>();
/** 缓存 key 必须带 **bot 身份(appId)** —— 同一进程里可能跑多个实例(im-qqbot-2/3)，
 * 只按 gid 存会串：A 拉到的名字被 B 读到，B 拉失败的空值又能污染 A。 */
const botKey = (botId: string): string => (String(botId || '').trim() || '_') + '|';
/** 使用者昵称缓存：openid → name（来自入站 senderName 或 getUserInfo） */
const userNameCache = new Map<string, CacheEntry>();
/** 在途请求（避免同一目标并发打点） */
const inflight = new Set<string>();

/** 成功缓存 30 分钟（群名/用户名很少变）；失败只缓存 60 秒，别把一次失败钉死 */
const TTL_OK_MS = 30 * 60 * 1000;
const TTL_FAIL_MS = 60 * 1000;

function fresh(hit: CacheEntry | undefined): CacheEntry | undefined {
  if (!hit) return undefined;
  return Date.now() - hit.at > (hit.name ? TTL_OK_MS : TTL_FAIL_MS) ? undefined : hit;
}

/** 同步读群名缓存（注入时用）：未命中返回空串 */
export function cachedGroupName(botId: string, gid: string): string {
  return fresh(groupNameCache.get(botKey(botId) + String(gid || '')))?.name || '';
}

/** 同步读使用者昵称缓存（注入时用） */
export function cachedUserName(botId: string, openid: string): string {
  return fresh(userNameCache.get(botKey(botId) + String(openid || '')))?.name || '';
}

/** 记下入站消息自带的昵称（私聊 `senderName`、群名片），比 API 快且免费 */
export function rememberUserName(botId: string, openid: string, name: string): void {
  const id = String(openid || '').trim();
  const nm = String(name || '').trim();
  if (!id || !nm) return;
  const key = botKey(botId) + id;
  const old = fresh(userNameCache.get(key));
  // 已有更好/同等的值就不覆盖；只有空或过期才更新
  if (old && old.name) return;
  userNameCache.set(key, { name: nm, at: Date.now() });
}

/** 手动写入群名（别处已经拿到时用，例如群名接口的调用方） */
export function rememberGroupName(botId: string, gid: string, name: string): void {
  const id = String(gid || '').trim();
  if (!id) return;
  groupNameCache.set(botKey(botId) + id, { name: String(name || '').trim(), at: Date.now() });
}

/**
 * 后台拉群名并缓存（**不阻塞**当前回合）。没有缓存时，这一轮注入只能写"群名未取到"，
 * 下一轮就有了。失败也写空串（短 TTL），免得对着没权限的群每轮打接口。
 */
export function prefetchGroupName(client: SessionKindClient | undefined, botId: string, gid: string): void {
  const id = String(gid || '').trim();
  // ★ CodeRabbit #80：判"有没有**未过期**的缓存条目"，而不是判名字非空 ——
  //   失败缓存的是空串，用 cachedGroupName() 判会永远当"没缓存"，无权限的群会一直重打接口（30 QPM）。
  const key = botKey(botId) + id;
  if (!id || fresh(groupNameCache.get(key)) || inflight.has('g:' + key)) return;
  if (!client || typeof client.getGroupInfo !== 'function') return;
  inflight.add('g:' + key);
  const startedAt = Date.now();
  void (async () => {
    let name = '';
    try {
      const r = await client.getGroupInfo!(id);
      if (r && r.ok !== false) name = String(r.data?.group_name ?? '').trim();
    } catch { name = ''; } finally {
      // ★ CodeRabbit #80：请求期间若别处写入了更新的名字，别用（可能是空的）结果覆盖它
      const prev = groupNameCache.get(key);
      if (!(prev && prev.at > startedAt && prev.name)) {
        groupNameCache.set(key, { name, at: Date.now() });
      }
      inflight.delete('g:' + key);
    }
  })();
}

/** 后台拉用户名并缓存；已有未过期缓存时跳过（省一次接口调用） */
export function prefetchUserName(client: SessionKindClient | undefined, botId: string, openid: string): void {
  const id = String(openid || '').trim();
  const key = botKey(botId) + id;
  if (!id || fresh(userNameCache.get(key)) || inflight.has('u:' + key)) return;
  if (!client || typeof client.getUserInfo !== 'function') return;
  inflight.add('u:' + key);
  const startedAt = Date.now();
  void (async () => {
    let name = '';
    try {
      const r = await client.getUserInfo!(id);
      if (r && r.ok !== false) name = String(r.data?.username ?? '').trim();
    } catch { name = ''; } finally {
      // ★ CodeRabbit #80：入站消息可能在请求期间写入了 senderName，旧请求失败不能拿空串盖掉它
      const prev = userNameCache.get(key);
      if (!(prev && prev.at > startedAt && prev.name)) {
        userNameCache.set(key, { name, at: Date.now() });
      }
      inflight.delete('u:' + key);
    }
  })();
}

export interface SessionKindInfo {
  /** `group` = QQ 群聊；`c2c` = QQ 私聊 */
  kind: 'group' | 'c2c';
  /** 群名 / 对方昵称；取不到为空串 */
  name: string;
  /** 群 openid / 用户 openid */
  peerId: string;
}

/**
 * **兜底**：从插件自己的历史目录里取名字（同步、零网络、必然有）。
 *
 * ★ 2026-11-21 主人指路：`msg-history/<scope>_<openid>/` 里
 *   · 群聊：有个 `<群名>.txt` 文件（文件名就是群名，见 msg-history.ts 的 writeNameMarker）
 *   · 私聊：`<日期>.jsonl` 每条记录带 `n`（发送者昵称）
 * 所以 API 拿不到时读这里，不要再引入"台账/注册表"那套。
 */
function nameFromHistory(dataRoot: string, scope: 'group' | 'c2c', peerId: string): string {
  const root = String(dataRoot || '');
  if (!root || !peerId) return '';
  const dir = join(root, '.qqbot', 'msg-history', `${scope}_${peerId}`);
  try {
    if (!existsSync(dir)) return '';
    const files = readdirSync(dir);
    if (scope === 'group') {
      // 群名文件形如 `今天一起包饺子.txt`（不含日期/下划线的才算）
      const txt = files.find((f) => f.endsWith('.txt') && f !== '_索引.txt' && !/^\d{4}-\d{2}-\d{2}/.test(f));
      return txt ? txt.slice(0, -4).trim() : '';
    }
    // 私聊：最后两个 jsonl 里最近一条"不是机器人自己"的 n
    const jsonls = files.filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, 2);
    for (const f of jsonls) {
      const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i -= 1) {
        try {
          const j = JSON.parse(String(lines[i] ?? '{}')) as { s?: string; n?: string; me?: boolean };
          if (j && j.me !== true && j.s && j.s !== 'self' && j.n) return String(j.n).trim();
        } catch { /* 单行坏掉就继续 */ }
      }
    }
  } catch { /* 读不到就算了 */ }
  return '';
}

/**
 * 描述当前会话的渠道与名字（**同步**：缓存 → 历史文件兜底，绝不在回合里等网络）。
 *
 * @param dataRoot 数据根（读 `{dataRoot}/.qqbot/msg-history/…` 兜底用）
 * @param scope    `group` / `c2c`
 * @param peerId   群 openid / 用户 openid
 * @param peerName 入站消息自带的昵称（私聊 senderName / 群名片），优先级最高
 */
export function describeSessionKind(
  dataRoot: string,
  botId: string,
  scope: string,
  peerId: string,
  peerName?: string,
): SessionKindInfo {
  const kind: 'group' | 'c2c' = String(scope) === 'c2c' ? 'c2c' : 'group';
  const pid = String(peerId || '');
  if (kind === 'group') {
    return { kind, name: cachedGroupName(botId, pid) || nameFromHistory(String(dataRoot || ''), 'group', pid), peerId: pid };
  }
  const inline = String(peerName || '').trim();
  const name = inline || cachedUserName(botId, pid) || nameFromHistory(String(dataRoot || ''), 'c2c', pid);
  return { kind, name, peerId: pid };
}

/** 注入正文里 openid 只给尾号：够核对，省 token */
function tail(id: string): string {
  const s = String(id || '');
  return s.length > 8 ? s.slice(-8) : s;
}

/**
 * 拼注入正文（调用方包进 `<system-reminder>`，放进**独立**的 user/message 事件）。
 *
 * 只陈述事实 + 一句用途提醒，不写"请按群规矩回复"这种指令 ——
 * 宿主实测：框架文本容易被模型当成模板复述出来。
 */
export function buildSessionKindHint(info: SessionKindInfo): string {
  const NL = String.fromCharCode(10);
  if (info.kind === 'group') {
    const namePart = info.name ? `群名「${info.name}」` : '群名未取到';
    return `[当前会话] 渠道=QQ 群聊 · ${namePart} · 群 openid 尾号 ${tail(info.peerId)}`
      + NL
      + '这是群聊：发言会被群里所有人看到，别按私聊口吻假设。';
  }
  const namePart = info.name ? `对方「${info.name}」` : '对方昵称未取到';
  return `[当前会话] 渠道=QQ 私聊 · ${namePart} · 用户 openid 尾号 ${tail(info.peerId)}`
    + NL
    + '这是私聊：只有对方看得到，不等于群里有人围观。';
}
