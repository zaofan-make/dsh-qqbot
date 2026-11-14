/**
 * ext-inbound-state.ts — 入站扩展的「持久状态 / 审计 / 熔断」三件套（2026-10-12）
 *
 * 入站扩展（`{dataRoot}/.qqbot-extensions/inbound/*.mjs`）能对**每条入站消息**做四件事：
 * 消灭、改写、强制入站、禁言群友。前三件是"消息维"（过了就算），第四件是**用户维**——
 * "某人接下来 30 分钟别说话"必须**跨重启仍然有效**，所以需要落盘。
 *
 * ── 落盘在哪 ────────────────────────────────────────────────────────────────
 *   `{dataRoot}/.qqbot-extensions/inbound/.state/<扩展文件名>.json`
 *   `{dataRoot}/.qqbot-extensions/inbound/.state/audit.jsonl`（所有扩展**共用**一本审计账）
 *   ⚠️ `.state/` 是**子目录**：入站扩展扫描只看 `inbound/` 根下的直接子文件，所以它不会被当扩展装载。
 *
 * ── 三条纪律（都是"绝不能因为状态文件坏了就搞崩插件"派生出来的）────────────────
 *   ① **任何读写都不抛出**：坏文件 / 无权限 / 目录不存在 → 一律当空（并在可能时告警），
 *      `mutes: []`、`kv: {}`，插件与消息链照常跑；
 *   ② **惰性清理**：读名单时顺手剔掉过期项（`until` 已过），清理结果写回文件；
 *      `until === 0` 表示**永久**（`minutes <= 0` 时写入），永远不会被清掉；
 *   ③ **审计有轮转上限**：超过 `AUDIT_MAX_BYTES` 就改名成 `audit.jsonl.1`（只留 1 份旧账），
 *      绝不允许无限涨。
 *
 * ── 熔断（主人点名的保命件之一）─────────────────────────────────────────────
 * 按**扩展**统计"消灭/静默"的密度，异常就停掉**该扩展的破坏性动作**（消息照常放行）：
 *   · 比例：该扩展参与的最近 `BREAKER_WINDOW`(50) 条里，破坏性动作占比 > `BREAKER_RATIO`(50%) ⇒ 熔断；
 *   · 突发：同一扩展 `BURST_WINDOW_MS`(10s) 内破坏性动作 ≥ `BURST_MAX`(20) ⇒ 熔断。
 * 两种都只影响**后续**的破坏性动作（触发它的那一条已经发生了，追不回来），
 * 且**只放行不执行**：`annihilate`/`muteUser` 返回 false + warn，别的动作（rewrite/forceWake/decide）不受影响。
 * 复位：热重载（`/tools-reload`）或重启插件 —— 每次装载都会清掉该扩展的熔断记录。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_INBOUND_SUBDIR } from './extension-store.js';

/** 状态子目录名（挂在入站扩展目录下） */
export const EXT_INBOUND_STATE_SUBDIR = '.state';

/** 状态目录：`{dataRoot}/.qqbot-extensions/inbound/.state` */
export function inboundStateDir(dataRoot: string): string {
  return join(dataRoot, EXT_INBOUND_SUBDIR, EXT_INBOUND_STATE_SUBDIR);
}

/** 单个扩展的状态文件：`{dataRoot}/.qqbot-extensions/inbound/.state/<扩展文件名>.json` */
export function extStatePath(dataRoot: string, file: string): string {
  const safe = String(file || 'unknown').replace(/[\\/:*?"<>|]/g, '_') || 'unknown';
  return join(inboundStateDir(dataRoot), `${safe}.json`);
}

/** 审计账本（所有扩展共用一本）：`{dataRoot}/.qqbot-extensions/inbound/.state/audit.jsonl` */
export function auditPath(dataRoot: string): string {
  return join(inboundStateDir(dataRoot), 'audit.jsonl');
}

// ══════════════════════════════════════════════════════════════
// 一、持久状态（禁言名单 + 扩展自己的 kv）
// ══════════════════════════════════════════════════════════════

/** 一条禁言名单项 */
export interface ExtMute {
  /** 被禁言的 openid */
  id: string;
  /** 到期时间戳(ms)；**0 = 永久**（`minutes <= 0` 时写 0） */
  until: number;
  /** 为什么禁（写进审计，也方便主人回看） */
  reason?: string;
  /** 谁下的手：缺省 = 执行它的扩展名；也可以自己传（如触发人的昵称/命令） */
  by?: string;
  /** 写名单的时刻（展示用） */
  at?: number;
}

/** 状态文件形状（`mutes` 与 `kv` 同住一个文件，免得两个文件两套坏法） */
export interface ExtStateFile {
  mutes: ExtMute[];
  kv: Record<string, unknown>;
}

/** 名单项的展示形态：多带一个剩余时间 */
export interface ExtMuteView extends ExtMute {
  /** 是否永久（`until === 0`） */
  permanent: boolean;
  /** 剩余毫秒；永久时为 null */
  remainingMs: number | null;
  /** 剩余分钟（向上取整）；永久时为 null */
  remainingMinutes: number | null;
}

/** 空状态（每次新建，避免调用方互相污染） */
function emptyState(): ExtStateFile {
  return { mutes: [], kv: {} };
}

/** 是否仍未过期（`until === 0` = 永久） */
function alive(m: ExtMute, now: number): boolean {
  return m.until === 0 || m.until > now;
}

/** 把文件里读到的一条（形状不可信）归一化成名单项；不合法返回 null */
function normalizeMute(raw: unknown): ExtMute | null {
  try {
    const o = raw as { id?: unknown; until?: unknown; reason?: unknown; by?: unknown; at?: unknown };
    const id = String(o?.id ?? '').trim();
    if (!id) return null;
    // ★★ 2026-11-14（CodeRabbit）：**必须在校验前看原始类型** ——
    //   Number(null) / Number("") / Number(false) 全都是 0，而 0 = 永久禁言，
    //   于是手改或损坏的记录会静默变成永久。程序自己写的是数字（见本文件 :188），
    //   所以这里只认 number 类型；数字字符串("123") 会被拒（行为变化，但更安全）。
    const rawUntil = o?.until;
    if (typeof rawUntil !== "number" || !Number.isFinite(rawUntil) || rawUntil < 0) return null;
    const until = rawUntil;
    // ★★ 2026-11-14 修（审查发现）：原来非法/缺失的 until 被归一成 0，
    //   而 0 的语义是「**永久**禁言」（见本文件 :17/:60/:93，minutes <= 0 时写 0）。
    //   于是手改记录、旧版本写入、或文件被截断时，一条本该无效的记录会**静默升级成永久禁言**。
    //   ⚠️ 注意：0 本身是合法的永久，**不能**当成非法值丢掉；只丢 NaN / 负数。
    if (!Number.isFinite(until) || until < 0) return null;
    const out: ExtMute = { id, until };
    if (typeof o?.reason === 'string' && o.reason) out.reason = o.reason;
    if (typeof o?.by === 'string' && o.by) out.by = o.by;
    const at = Number(o?.at);
    if (Number.isFinite(at) && at > 0) out.at = at;
    return out;
  } catch {
    return null;
  }
}

/**
 * 读状态文件。**永不抛出**：
 *   · 目录/文件不存在 → 空状态；
 *   · JSON 坏了 / 形状不对 → 空状态（别让一个坏文件把插件搞崩）；
 *   · 读的时候**惰性清理**过期名单项，并把清理结果写回（写不回去也不影响本次返回值）。
 */
export function readExtState(dataRoot: string, file: string): ExtStateFile {
  let raw: unknown;
  try {
    const p = extStatePath(dataRoot, file);
    if (!existsSync(p)) return emptyState();
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return emptyState();
  }
  const o = (raw ?? {}) as { mutes?: unknown; kv?: unknown };
  const list = Array.isArray(o.mutes) ? o.mutes.map(normalizeMute).filter((m): m is ExtMute => m !== null) : [];
  const now = Date.now();
  const kept = list.filter((m) => alive(m, now));
  const kv = o.kv && typeof o.kv === 'object' && !Array.isArray(o.kv)
    ? (o.kv as Record<string, unknown>)
    : {};
  if (kept.length !== list.length) {
    // 惰性清理：过期项落盘时顺手删掉（失败就算了，下次读还会再清一遍）
    try { writeExtState(dataRoot, file, { mutes: kept, kv }); } catch { /* ignore */ }
  }
  return { mutes: kept, kv };
}

/** 写状态文件；返回是否写成功（**永不抛出**） */
export function writeExtState(dataRoot: string, file: string, st: ExtStateFile): boolean {
  try {
    // ⚠️ dataRoot 为空一律不写：否则会按相对路径在当前工作目录里造出 .qqbot-extensions/…
    if (!dataRoot) return false;
    const p = extStatePath(dataRoot, file);
    mkdirSync(inboundStateDir(dataRoot), { recursive: true });
    writeFileSync(p, JSON.stringify({ mutes: st.mutes ?? [], kv: st.kv ?? {} }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 名单项 → 展示形态（带剩余时间） */
export function muteView(m: ExtMute, now = Date.now()): ExtMuteView {
  const permanent = m.until === 0;
  const remainingMs = permanent ? null : Math.max(0, m.until - now);
  return {
    ...m,
    permanent,
    remainingMs,
    remainingMinutes: remainingMs === null ? null : Math.ceil(remainingMs / 60_000),
  };
}

/**
 * 写一条禁言。`minutes <= 0`（含缺省之外的负数/0）= **永久**。
 * 同一 id 重复禁言 → 覆盖（改期限/原因），不堆重复项。
 * 返回写入的名单项（读回时已做过期清理）；失败返回 false。
 */
export function muteUser(
  dataRoot: string,
  file: string,
  input: { id: string; minutes?: number; reason?: string; by?: string },
): ExtMute | false {
  try {
    const id = String(input?.id ?? '').trim();
    if (!id) return false;
    const minutes = Number(input?.minutes);
    const until = Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    const st = readExtState(dataRoot, file);
    const entry: ExtMute = { id, until };
    if (typeof input?.reason === 'string' && input.reason) entry.reason = input.reason;
    if (typeof input?.by === 'string' && input.by) entry.by = input.by;
    entry.at = Date.now();
    st.mutes = [...st.mutes.filter((m) => m.id !== id), entry];
    if (!writeExtState(dataRoot, file, st)) return false;
    return entry;
  } catch {
    return false;
  }
}

/** 解除禁言；返回是否真的解掉了一条 */
export function unmuteUser(dataRoot: string, file: string, id: string): boolean {
  try {
    const key = String(id ?? '').trim();
    if (!key) return false;
    const st = readExtState(dataRoot, file);
    const next = st.mutes.filter((m) => m.id !== key);
    if (next.length === st.mutes.length) return false;
    st.mutes = next;
    return writeExtState(dataRoot, file, st);
  } catch {
    return false;
  }
}

/** 查一条是否被禁言；命中返回展示形态（带剩余时间），否则 null */
export function isMuted(dataRoot: string, file: string, id: string): ExtMuteView | null {
  try {
    const key = String(id ?? '').trim();
    if (!key) return null;
    const st = readExtState(dataRoot, file);
    const now = Date.now();
    const hit = st.mutes.find((m) => m.id === key && alive(m, now));
    return hit ? muteView(hit, now) : null;
  } catch {
    return null;
  }
}

/** 读整份名单（已做过期清理，带剩余时间），按到期时间升序（永久排最后） */
export function mutedUsers(dataRoot: string, file: string): ExtMuteView[] {
  try {
    const now = Date.now();
    return readExtState(dataRoot, file)
      .mutes.filter((m) => alive(m, now))
      .map((m) => muteView(m, now))
      .sort((a, b) => (a.until === 0 ? Number.MAX_SAFE_INTEGER : a.until) - (b.until === 0 ? Number.MAX_SAFE_INTEGER : b.until));
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// 二、审计（可撤销 + 可回看）
// ══════════════════════════════════════════════════════════════

/**
 * 审计账本的单行上限：512KB。
 * 超了就 `audit.jsonl` → `audit.jsonl.1`（旧的 `.1` 被覆盖，只留一代）。
 * 为什么不按行数：行里带着截断后的文本摘要，字节数才是真正会撑爆磁盘的东西。
 */
export const AUDIT_MAX_BYTES = 512 * 1024;

/** 摘要字段截断长度（**别把整条消息塞进审计**） */
export const AUDIT_TEXT_CHARS = 120;
export const AUDIT_REASON_CHARS = 200;
export const AUDIT_TARGET_CHARS = 64;

/** 一条审计记录 */
export interface ExtAuditEntry {
  /** 扩展文件名（谁干的） */
  file?: string;
  /** 扩展展示名 */
  name?: string;
  /** 动作：annihilate / rewrite / forceWake / decide / muteUser / unmuteUser（+ 被拒时同名字段） */
  action: string;
  /** 目标（被禁言的 openid 等） */
  target?: string;
  /** 原因（用户传的 reason） */
  reason?: string;
  /** 文本摘要（**截断**） */
  text?: string;
  /** ok | ok-owner-ack（主人消息经 ownerAck 显式放行被消灭）| refused-owner | refused-breaker | refused-invalid ... */
  result?: string;
}

/** 安全截断：undefined 原样（JSON 里会消失），否则取字符串前 n 字符 */
function clip(v: unknown, n: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * 追加一行审计。**永不抛出**、失败静默返回 false。
 * 轮转：写之前先看大小，超过 {@link AUDIT_MAX_BYTES} 就改名成 `.1`。
 */
export function appendAudit(dataRoot: string, entry: ExtAuditEntry): boolean {
  try {
    // ⚠️ dataRoot 为空一律不写：否则会按相对路径在当前工作目录里造出 .qqbot-extensions/…
    if (!dataRoot) return false;
    mkdirSync(inboundStateDir(dataRoot), { recursive: true });
    const p = auditPath(dataRoot);
    try {
      if (existsSync(p) && statSync(p).size > AUDIT_MAX_BYTES) renameSync(p, `${p}.1`);
    } catch { /* 轮转失败不阻断本条审计 */ }
    const line = JSON.stringify({
      at: new Date().toISOString(),
      file: entry.file,
      name: entry.name,
      action: String(entry.action ?? ''),
      target: clip(entry.target, AUDIT_TARGET_CHARS),
      reason: clip(entry.reason, AUDIT_REASON_CHARS),
      text: clip(entry.text, AUDIT_TEXT_CHARS),
      result: entry.result,
    });
    appendFileSync(p, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读审计（诊断 / 测试用）：返回每行的**原始字符串**（含换行前的 JSON） */
export function readAudit(dataRoot: string, limit = 200): string[] {
  try {
    const p = auditPath(dataRoot);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
    return limit > 0 ? lines.slice(-limit) : lines;
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// 三、熔断（按扩展统计破坏性动作密度）
// ══════════════════════════════════════════════════════════════

/** 参与窗口（最近多少条"该扩展参与的消息"） */
export const BREAKER_WINDOW = 50;
/** 最小样本：参与不足这么多条不判比例（否则头两条全是消灭就熔断了，误伤太狠） */
export const BREAKER_MIN_SAMPLE = 10;
/** 比例阈值：破坏性动作占比 > 该值 ⇒ 熔断 */
export const BREAKER_RATIO = 0.5;
/** 突发窗口（ms）与窗口内允许的最大破坏性动作数 */
export const BURST_WINDOW_MS = 10_000;
export const BURST_MAX = 20;

/** 单个扩展的熔断状态 */
interface BreakerState {
  /** 最近若干条"参与记录"：true = 这条做了破坏性动作 */
  ring: boolean[];
  /** 最近破坏性动作的时刻（突发判定用） */
  burst: number[];
  /** 已熔断（带原因与时刻） */
  tripped?: { at: number; reason: string };
}

const breakers = new Map<string, BreakerState>();

/** 取（必要时新建）某扩展的熔断状态 */
function breakerOf(file: string): BreakerState {
  const k = String(file || '(unknown)');
  let s = breakers.get(k);
  if (!s) {
    s = { ring: [], burst: [] };
    breakers.set(k, s);
  }
  return s;
}

/** 当前熔断原因（没熔断返回 undefined） */
export function breakerTrippedReason(file: string): string | undefined {
  return breakerOf(file).tripped?.reason;
}

/** 熔断：幂等（已熔断时保留最早那次的原因与时刻） */
export function tripBreaker(file: string, reason: string): string {
  // ★ 2026-11-14：key 已改成绝对路径，但诊断/测试常传短名（breaker.mjs）。
  //   精确查不到时按「路径后缀」兜底匹配一次，避免为改 key 而改一堆调用点。
  let s = breakerOf(file);
  if (!s.tripped && s.ring.length === 0) {
    const short = String(file || "");
    for (const [k, v] of breakers) {
      if (k === short || k.endsWith("/" + short) || k.endsWith("\\" + short)) { s = v; break; }
    }
  }
  if (!s.tripped) s.tripped = { at: Date.now(), reason };
  return s.tripped.reason;
}

/** 清理突发窗口里的陈旧时刻（返回窗口内的时刻表） */
function freshBurst(s: BreakerState, now = Date.now()): number[] {
  s.burst = s.burst.filter((t) => now - t < BURST_WINDOW_MS);
  return s.burst;
}

/**
 * 执行破坏性动作**之前**问一句：现在允许吗？
 *   · 已熔断 → 拒绝；
 *   · 突发窗口里已经打满 {@link BURST_MAX} 次 → **当场熔断**并拒绝（第 21 次就被拦下）。
 * 任何异常都当"允许"（宁可放行，也不能因为统计代码坏了把扩展全废掉）。
 */
export function checkDestructiveAllowed(file: string): { ok: true } | { ok: false; reason: string } {
  try {
    const s = breakerOf(file);
    if (s.tripped) return { ok: false, reason: s.tripped.reason };
    const now = Date.now();
    const burst = freshBurst(s, now);
    if (burst.length >= BURST_MAX) {
      const reason = `突发熔断：${BURST_WINDOW_MS / 1000}s 内破坏性动作已达 ${burst.length} 次（上限 ${BURST_MAX}）`;
      tripBreaker(file, reason);
      return { ok: false, reason };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** 记一次破坏性动作（突发窗口用） */
export function noteDestructive(file: string): void {
  try {
    const s = breakerOf(file);
    freshBurst(s).push(Date.now());
  } catch { /* ignore */ }
}

/**
 * 记一次"该扩展参与了这条消息"（含这条做了什么）。
 * 比例超阈值时熔断，返回熔断原因（调用方负责 logger.warn 出来，好让人一眼看出是哪个扩展、为什么）。
 */
export function noteParticipation(file: string, destructive: boolean): string | undefined {
  try {
    const s = breakerOf(file);
    if (s.tripped) return undefined;
    s.ring.push(destructive === true);
    if (s.ring.length > BREAKER_WINDOW) s.ring.splice(0, s.ring.length - BREAKER_WINDOW);
    if (s.ring.length < BREAKER_MIN_SAMPLE) return undefined;
    const bad = s.ring.filter(Boolean).length;
    const ratio = bad / s.ring.length;
    if (ratio > BREAKER_RATIO) {
      const reason =
        `比例熔断：最近 ${s.ring.length} 条里消灭/静默 ${bad} 条（${Math.round(ratio * 100)}% > ${BREAKER_RATIO * 100}%）`;
      return tripBreaker(file, reason);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把"最近一次参与记录"升级成破坏性（早+晚两个挂点共用一份参与记录时用）。
 * 例：`onInbound` 什么都没干（记 false），`onDecide` 里禁言了某人 —— 那次参与应当算破坏性。
 */
export function upgradeLastParticipation(file: string): void {
  try {
    const s = breakerOf(file);
    const last = s.ring.length - 1;
    if (last >= 0) s.ring[last] = true;
  } catch { /* ignore */ }
}

/** 诊断：某扩展的熔断状态快照 */
export function breakerStatus(file: string): { tripped?: { at: number; reason: string }; participated: number; destructive: number } {
  // ★ 2026-11-14：熔断 key 已改成绝对路径，但诊断/测试常传短名（breaker.mjs）。
  //   精确查不到时按「路径后缀」兜底匹配一次，避免为改 key 而改一堆调用点。
  let s = breakerOf(file);
  if (!s.tripped && s.ring.length === 0) {
    const short = String(file || "");
    for (const [k, v] of breakers) {
      if (k === short || k.endsWith("/" + short) || k.endsWith("\\" + short)) { s = v; break; }
    }
  }
  const out: { tripped?: { at: number; reason: string }; participated: number; destructive: number } = {
    participated: s.ring.length,
    destructive: s.ring.filter(Boolean).length,
  };
  if (s.tripped) out.tripped = { ...s.tripped };
  return out;
}

/**
 * 复位熔断（**只**清熔断记录，不碰名单与 kv）。
 * 调用点：每次装载该扩展文件时（= 热重载/重启即复位，这是文档写明的恢复通道）。
 */
export function resetBreaker(file: string): void {
  try { breakers.delete(String(file || '(unknown)')); } catch { /* ignore */ }
}

/** 重置全部熔断状态（仅供单元测试） */
export function __resetBreakersForTest(): void {
  breakers.clear();
}

/** 状态目录自检（诊断用；返回是否存在） */
export function inboundStateDirExists(dataRoot: string): boolean {
  try { return existsSync(inboundStateDir(dataRoot)); } catch { return false; }
}
