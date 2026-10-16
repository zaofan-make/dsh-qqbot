/**
 * botplay.ts — botplay 互动事件装配器(2026-09-08, Phase1 MVP)
 *
 * 设计定稿见工作区 参考文档/botplay互动事件装配器_设计完整稿.md(唯一权威):
 * 一句话本质 = 自定义 bot 互动事件: ①bot(非LLM)发出什么交互卡片 →
 * ②用户点哪个按钮 → ③这件事要不要/怎么影响 LLM, 全部可配置。
 *
 * 本文件职责(参照 qq-approval.ts / qq-user-questions.ts 的注册表范式):
 *   - BotplayController: 发卡(trigger) + interaction 回调结算(handleInteraction)
 *     + append 三档(no_append / append_silent / append_wake)
 *   - 事件配置从 live config(config.botplayEvents, settings 同源热更)现读;
 *     dock「🎮 互动事件」装配器编辑后保存即热更, 无需重启。
 *   - /botplay 命令经 triggerBotplay() 模块级注册表触发(仿 outbound-mode-switch)。
 *
 * Phase1 MVP 范围: schema 最小集(id/name/buttons[label,botAction.reply_text,
 * llmEffect.mode]/maxClicks/expireSec); perm 默认 all, triggerer 推荐;
 * 行为类型 reply_text 落地, jump_url/callback 预留。
 */
import { join } from 'node:path';

/** 官方 group-admin 客户端的最小外形（只用到 getMemberInfo；避免与 api/group-admin 强耦合） */
type GroupAdminLike = {
  /** 带 token 的通用官方 API 调用（自定义事件模块的 ctx.api 就转调它） */
  apiCall?: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<
    { ok: true; data: unknown } | { ok: false; err: { code: string; human: string } }
  >;
  getMemberInfo?: (gid: string, memberOpenid: string) => Promise<{
    ok: boolean;
    data?: { username?: string };
    err?: { code?: string };
  }>;
};
import { statSync } from 'node:fs';
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/index.js';
import { skipSilentAppend } from '../session/surface-guard.js';
import type { Logger } from '../types.js';
import type { BotplayButtonConfig, BotplayEventConfig } from '../config.js';
import { readGroupMembers, readLedger } from './chat-ledger.js';
import {
  botplayExtDir, makeExtContext, appendExtDiag,
  type BotplayExtCardState, type BotplayExtContext, type BotplayExtModule, type BotplayExtLoaded,
} from './botplay-ext.js';
import { loadBotplayExtensionModule, safeBotplayFileName } from './extension-store.js';

/** 拼路径(仅用于展示/取键; 不 resolve, 免得 Windows 大小写/短名差异把缓存键搞散) */
function joinSafe(dir: string, file: string): string {
  return dir ? join(dir, file) : file;
}

/** 按钮回调数据前缀 + 编码: bp:<cardId>:<buttonId>(button_data 是回调唯一凭证) */
const BTN_PREFIX = 'bp:';

/** 单次发卡的实例记录(防刷/过期/归属校验用; Phase2 加事件快照: 配置热改不影响已发卡) */
interface ActiveCard {
  cardId: string;
  eventId: string;
  /** 发卡时的事件名快照(回调回复/提示用, 防改名漂移) */
  eventName: string;
  /** 发卡时的按钮定义快照(回调按快照执行, 配置热改后旧卡仍按旧配置走) */
  buttons: BotplayButtonConfig[];
  /** 发卡时的权限快照(防热改放权绕过; all/triggerer/owner/users) */
  perm: NonNullable<BotplayEventConfig['perm']>;
  /** triggerer=仅触发者本人时, 记录触发者 openid */
  triggererId?: string;
  /** maxClicks>0 时的剩余可点击数(点一次扣一) */
  remainClicks: number;
  /** 过期时间戳(ms) */
  expireAt: number;
  /** 卡片所在会话(自定义事件的 ctx.emit/刷新要能发回去; 2026-10-05) */
  target: ReplyTarget;
  /** 每行按钮数快照(刷新卡片要沿用) */
  buttonsPerRow: number;
  /** 自定义事件模块文件名(空=普通事件; 2026-10-05) */
  extFile?: string;
  /** 自定义事件的实例卡片状态(正文/按钮/dirty; 模块经 ctx.card() 读写) */
  extState?: BotplayExtCardState;
  /** 本次点击里, 自定义模块是否把卡片改脏 ⇒ 点完自动重发刷新按钮 */
  extDirty?: boolean;
  /** 自定义模块 onClick 返回的非空文本(回给点击者) */
  extReply?: string;
  /** 自定义模块执行异常(诊断; 面板可见) */
  extError?: string;
}

export interface BotplayTriggerResult {
  ok: boolean;
  msg: string;
}

/** 默认 append 记录文本模板(事件级 llmEffect.contextText 留空时用它) */
function defaultContextText(eventName: string, buttonLabel: string): string {
  return `[互动事件·${eventName}] bot 发送了互动卡片, 用户点击了「${buttonLabel}」`;
}

/** 按模板渲染: 支持 {name}(事件名) {label}(按钮文字) 占位; 末尾自动附加点击人身份(尽力带昵称) */
function renderContext(tpl: string | undefined, eventName: string, buttonLabel: string, clicker: string): string {
  let base = tpl && tpl.trim() ? String(tpl) : defaultContextText(eventName, buttonLabel);
  base = base.replace(/\{name\}/g, eventName).replace(/\{label\}/g, buttonLabel);
  // 点击人信息: 模板未显式包含时统一补一行(保证 AI 知道"谁点了")
  if (clicker && base.indexOf(clicker) < 0) {
    base += `\n(点击人: ${clicker})`;
  }
  return base;
}

/**
 * 构造事件卡片 keyboard(官方 msg_type=2 + keyboard)。
 * QQ 限制: rows ≤5 行 × 5 按钮/行; 默认每行1个(竖排, 字宽不截断),
 * 事件 buttonsPerRow(1~5)可设每行多个(Phase2)。
 * permission: 按事件 perm 决定 —— all→type2所有人 / triggerer→type0 指定触发者 /
 * owner→type0 主人白名单 / users→type0 指定 openid。
 * 按钮 action.type 按 botAction 区分(Phase2):
 *   reply_text/callback/command → 1 回调按钮(点击回后台, data=bp:card:btn)
 *   jump_url                      → 0 跳转按钮(data=http(s) 链接, 点击直接跳不走回调)
 */
export function botplayKeyboard(
  cardId: string,
  buttons: BotplayButtonConfig[],
  perm: NonNullable<BotplayEventConfig['perm']>,
  ownerIds: string[],
  triggererId?: string,
  buttonsPerRow = 1,
): { content: { rows: unknown[] } } {
  const perRow = Math.max(1, Math.min(5, Math.round(buttonsPerRow) || 1));
  const shown = buttons.slice(0, 5 * perRow); // QQ 上限 5行×每行按钮数
  let permission: Record<string, unknown>;
  const specify: string[] = [];
  if (perm.type === 'triggerer' && triggererId) specify.push(triggererId);
  else if (perm.type === 'owner') specify.push(...ownerIds);
  else if (perm.type === 'users') specify.push(...(perm.userIds ?? []));
  permission = specify.length > 0 ? { type: 0, specify_user_ids: specify } : { type: 2 };
  const mk = (b: BotplayButtonConfig) => {
    const isJump = (b.botAction?.type ?? 'reply_text') === 'jump_url';
    const url = String(b.botAction?.url ?? '').trim();
    const data = isJump
      ? (url || 'https://example.com') // type=0 跳转: data 放链接
      : `${BTN_PREFIX}${cardId}:${b.id}`; // type=1 回调: 编码 card::btn
    return {
      id: `${BTN_PREFIX}${cardId}:${b.id}`,
      render_data: {
        label: String(b.label ?? '').slice(0, 20),
        visited_label: String(b.visitedLabel || b.label || '').slice(0, 20),
        style: b.style === 0 ? 0 : 1,
      },
      action: {
        type: isJump ? 0 : 1, // 0跳转 1回调
        permission,
        data,
        unsupport_tips: '请在支持的客户端点击按钮',
      },
    };
  };
  const rows: Array<{ buttons: unknown[] }> = [];
  for (let i = 0; i < shown.length; i += perRow) {
    rows.push({ buttons: shown.slice(i, i + perRow).map(mk) });
  }
  return { content: { rows } };
}

/** 从 interaction button_data 解析 cardId + buttonId; 非 botplay 按钮返回 null */
export function parseBotplayButton(data: string | undefined): { cardId: string; buttonId: string } | null {
  if (!data || !data.startsWith(BTN_PREFIX)) return null;
  const rest = data.slice(BTN_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx >= rest.length - 1) return null;
  return { cardId: rest.slice(0, idx), buttonId: rest.slice(idx + 1) };
}

// ── 事件目录页(Phase2, 2026-09-08): /botplay 无参出翻页卡片, 点事件名直接触发 ──
// 编码: bpc:<page>:<key> —— key=事件id(触发该事件) | prev(上一页) | next(下一页) | close(关闭/忽略)
const CAT_PREFIX = 'bpc:';
/** 目录卡每行事件按钮数(QQ 每行上限5) */
const CAT_COLS = 2;
/** 每页事件数 = 事件最多4行×2列, 第5行留给翻页导航(QQ 行上限5) */
const CAT_PER_PAGE = 8;

export function parseCatalogButton(data: string | undefined): { page: number; key: string } | null {
  if (!data || !data.startsWith(CAT_PREFIX)) return null;
  const rest = data.slice(CAT_PREFIX.length);
  const idx = rest.indexOf(':');
  if (idx <= 0 || idx >= rest.length - 1) return null;
  const page = Number(rest.slice(0, idx));
  if (!Number.isFinite(page) || page < 0) return null;
  return { page, key: rest.slice(idx + 1) };
}

/** 目录页总数(0=无事件) */
function catalogPages(events: BotplayEventConfig[]): number {
  return Math.max(1, Math.ceil(events.length / CAT_PER_PAGE));
}

/** 构造事件目录卡 keyboard: 事件按钮(每行2个, 点击即触发) + 上一页/下一页 */
function catalogKeyboard(page: number, events: BotplayEventConfig[]): { content: { rows: unknown[] } } {
  const pages = catalogPages(events);
  const safePage = Math.min(page, pages - 1);
  const start = safePage * CAT_PER_PAGE;
  const pageEvents = events.slice(start, start + CAT_PER_PAGE);
  const btn = (label: string, key: string, style: number) => ({
    id: `${CAT_PREFIX}${safePage}:${key}`,
    render_data: { label: String(label).slice(0, 20), visited_label: String(label).slice(0, 20), style },
    action: {
      type: 1,
      permission: { type: 2 },
      data: `${CAT_PREFIX}${safePage}:${key}`,
      unsupport_tips: '请在支持的客户端点击',
    },
  });
  const rows: Array<{ buttons: unknown[] }> = [];
  // 事件按钮: 每行 CAT_COLS 个(最多4行, 第5行留给翻页导航 → 合计≤5行)
  // 2026-10-05: 自定义事件(file)加个 🤖 前缀 —— 群里一眼看出哪些是 AI 写的模块驱动的
  const maxRows = 4;
  for (let i = 0; i < pageEvents.length && rows.length < maxRows; i += CAT_COLS) {
    rows.push({ buttons: pageEvents.slice(i, i + CAT_COLS).map((ev) => btn(`${ev.file ? '🤖' : '🎮'}${ev.name}`, ev.id, 1)) });
  }
  // 翻页行: 上一页 + 页码 + 下一页
  const navBtns: Array<ReturnType<typeof btn>> = [];
  if (safePage > 0) navBtns.push(btn('◀ 上一页', 'prev', 0));
  if (safePage < pages - 1) navBtns.push(btn('下一页 ▶', 'next', 0));
  if (navBtns.length > 0) rows.push({ buttons: navBtns });
  return { content: { rows } };
}

export class BotplayController {
  private readonly cards = new Map<string, ActiveCard>();

  constructor(
    private readonly manager: SessionManager,
    private readonly sender: QQBotSender,
    private readonly logger: Logger,
    /** live 事件配置 getter(config.botplayEvents, 每次现读支持热更) */
    private readonly eventsGetter: () => BotplayEventConfig[],
    /** 主人 openid 白名单 getter(config.groupAdmin.owners; perm=owner 用) */
    private readonly ownersGetter: () => string[],
    /** 台账 dataDir getter(表情包目录; 点击人昵称反查, 与 dock 禁言面板同源) */
    private readonly ledgerDataDirGetter: () => string,
    /** 数据根 getter(2026-10-05: 自定义事件模块放 {dataRoot}/.qqbot-extensions/botplay/) */
    private readonly dataRootGetter: () => string = () => '',
  ) {}

  /** 指令型按钮执行器(bootstrap 注入: 执行斜杠命令并返回文本) */
  private commandExecutor: ((cmdName: string, target: ReplyTarget) => Promise<string>) | undefined;
  setCommandExecutor(fn: ((cmdName: string, target: ReplyTarget) => Promise<string>) | undefined): void {
    this.commandExecutor = fn;
  }

  // ── 昵称兜底（2026-10-05）─────────────────────────────────────────────
  /** API 兜底查到的昵称缓存：`${peerId}|${openid}` → name */
  private readonly memberNameApiCache = new Map<string, string>();
  /** 正在后台查的 key（防同一人并发重复查） */
  private readonly memberNameProbing = new Set<string>();
  /** 官方 group-admin 客户端 getter（bootstrap 注入；没注入就跳过兜底） */
  private groupAdminGetter: (() => GroupAdminLike | undefined) | undefined;
  setGroupAdminGetter(fn: (() => GroupAdminLike | undefined) | undefined): void {
    this.groupAdminGetter = fn;
  }
  /** bot 凭证 getter（卡片 = 代码，直接把 appId/appSecret 给它，让它自己调官方 API） */
  private credentialsGetter: (() => { appId: string; appSecret: string }) | undefined;
  setCredentialsGetter(fn: (() => { appId: string; appSecret: string }) | undefined): void {
    this.credentialsGetter = fn;
  }

  /**
   * 后台探测某人昵称（不阻塞调用方）。
   *   命中 → 写进 memberNameApiCache，下次同步调用就能拿到真名。
   *   未命中/无权限/网络错 → 静默（只记一行日志，避免刷屏）。
   */
  private probeMemberNameAsync(target: ReplyTarget, presser: string): void {
    if (target.scope !== 'group' || !presser) return;
    const key = `${target.targetId}|${presser}`;
    if (this.memberNameProbing.has(key)) return;
    const ga = (() => { try { return this.groupAdminGetter?.() } catch { return undefined } })();
    if (!ga || typeof ga.getMemberInfo !== 'function') return;
    this.memberNameProbing.add(key);
    void (async () => {
      try {
        const r = await ga.getMemberInfo!(target.targetId, presser);
        if (r && r.ok && r.data && r.data.username) {
          const nm = String(r.data.username);
          this.memberNameApiCache.set(key, nm);
          if (this.memberNameApiCache.size > 1000) {
            // 简易上限：满了清一半（昵称表不值得为它做 LRU）
            let n = 0;
            for (const k of this.memberNameApiCache.keys()) { this.memberNameApiCache.delete(k); if (++n >= 500) break; }
          }
          this.logger.info?.(`[botplay] 昵称兜底命中 ${presser} → ${nm}`);
        } else {
          this.logger.info?.(`[botplay] 昵称兜底未命中(code=${(r && r.err && r.err.code) || '?'}) ${presser}`);
        }
      } catch (err) {
        this.logger.info?.(`[botplay] 昵称兜底异常: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.memberNameProbing.delete(key);
      }
    })();
  }

  // ── 自定义事件模块(2026-10-05) ─────────────────────────────────────────
  /** 已加载模块缓存: 绝对路径 → 加载结果(按 mtime 判热重载; 不按时间戳刷 URL, 见 fileVersion 注释) */
  private readonly extModules = new Map<string, BotplayExtLoaded>();
  /** 每实例每按钮点击计数: `${cardId}|${buttonId}` → 次数(自定义事件的"是否点过"判据) */
  private readonly extClicks = new Map<string, number>();
  /** 加载失败原因: 文件名 → 错误(面板展示红色摘要) */
  private readonly extErrors = new Map<string, string>();

  /** 面板用: 每个自定义事件模块的状态(路径/是否存在/mtime/加载错误) —— settings-host 经此展示 */
  extStatus(): Array<{
    file: string; path: string; exists: boolean; mtime: number;
    loadedMtime: number; name: string; error: string; hooks: string[];
  }> {
    const dataRoot = (() => { try { return this.dataRootGetter() || ''; } catch { return ''; } })();
    const dir = dataRoot ? botplayExtDir(dataRoot) : '';
    const out: Array<{ file: string; path: string; exists: boolean; mtime: number; loadedMtime: number; name: string; error: string; hooks: string[] }> = [];
    const seen = new Set<string>();
    const push = (file: string): void => {
      if (!file || seen.has(file)) return;
      seen.add(file);
      const safe = safeBotplayFileName(file) ?? file;
      let exists = false; let mtime = 0;
      try {
        // 现读文件系统(面板要"文件是否存在/最后修改时间"); 不用 statSync 缓存, 主人可能随时改文件
        const st = this.statFile(dir, safe);
        exists = st.exists; mtime = st.mtime;
      } catch { /* 读不到就报不存在 */ }
      const cached = this.extModules.get(joinSafe(dir, safe));
      out.push({
        file: safe,
        path: joinSafe(dir, safe),
        exists,
        mtime,
        loadedMtime: cached?.mtime ?? 0,
        name: cached?.name ?? '',
        error: this.extErrors.get(safe) ?? '',
        hooks: cached ? Object.keys(cached.mod).filter((k) => typeof (cached.mod as Record<string, unknown>)[k] === 'function') : [],
      });
    };
    for (const ev of this.listEvents()) if (ev?.file) push(String(ev.file));
    // 目录里存在但事件没登记的模块也列出来(排查"写好了没生效"最常问的一句)
    for (const [, l] of this.extModules) push(l.file);
    return out;
  }

  /** 诊断日志(自定义事件加载/点击/报错都落这个文件; 面板可读) */
  private extDiag(line: string): void {
    const dataRoot = (() => { try { return this.dataRootGetter() || ''; } catch { return ''; } })();
    if (!dataRoot) return;
    appendExtDiag(dataRoot, line);
  }

  private statFile(dir: string, file: string): { exists: boolean; mtime: number } {
    try {
      const st = statSync(joinSafe(dir, file));
      return { exists: true, mtime: Math.floor(st.mtimeMs) };
    } catch {
      return { exists: false, mtime: 0 };
    }
  }

  /** 事件是否由自定义模块驱动(带 file 且文件名合法) */
  private extFileOf(ev: BotplayEventConfig): string | undefined {
    const f = String(ev?.file ?? '').trim();
    if (!f) return undefined;
    return safeBotplayFileName(f) ?? undefined;
  }

  /**
   * 取(或热重载)模块: mtime 没变就复用缓存实例(模块里的内存状态得以跨卡持有),
   * 变了就重新 import(`?v=<mtime>`)。加载失败**不抛**, 返回 {error}。
   */
  private async loadExt(file: string): Promise<{ loaded?: BotplayExtLoaded; error?: string }> {
    const dataRoot = (() => { try { return this.dataRootGetter() || ''; } catch { return ''; } })();
    if (!dataRoot) return { error: '数据根未就绪(dataRoot 为空, 自定义事件模块无法定位)' };
    const safe = safeBotplayFileName(file);
    if (!safe) return { error: `文件名不安全: ${file}(只允许纯文件名 + .mjs/.js/.cjs)` };
    const key = joinSafe(botplayExtDir(dataRoot), safe);
    // 先看 mtime: 文件没改 → 直接复用(避免每次点按钮都重新 import)
    let mtime = 0;
    try {
      mtime = Math.floor(statSync(key).mtimeMs);
    } catch { /* 不存在, 交给下面的加载器报错 */ }
    const cached = this.extModules.get(key);
    if (cached && mtime > 0 && cached.mtime === mtime) return { loaded: cached };
    const r = await loadBotplayExtensionModule(dataRoot, safe, this.logger);
    if (!r.ok) {
      this.extErrors.set(safe, r.error);
      this.extDiag(`加载失败 ${safe}: ${r.error}`);
      return { error: r.error };
    }
    this.extErrors.delete(safe);
    // 类型说明: extension-store 的加载器用 generic `BotplayModuleShape`(避免两模块互相 import),
    //   这里断言成真正的契约类型 —— 运行期是同一个对象, 只是编译期形状标注不同。
    const loaded = r.loaded as unknown as BotplayExtLoaded;
    this.extModules.set(key, loaded);
    this.extDiag(`已加载模块 ${safe} mtime=${loaded.mtime} hooks=${Object.keys(loaded.mod).filter((k) => typeof (loaded.mod as Record<string, unknown>)[k] === 'function').join(',')}`);
    return { loaded };
  }

  /** 热重载指定模块(文件名; 空=全部): 清缓存 → 下次解析卡片自动加载新版本 */
  reloadExt(file?: string): { ok: boolean; msg: string } {
    const target = String(file ?? '').trim();
    if (!target) {
      const n = this.extModules.size;
      this.extModules.clear();
      this.extErrors.clear();
      this.extDiag('热重载全部模块(缓存已清)');
      return { ok: true, msg: `已清空 ${n} 个模块缓存, 下次点击/发卡时重新加载` };
    }
    const safe = safeBotplayFileName(target);
    if (!safe) return { ok: false, msg: `文件名不安全: ${target}` };
    let removed = 0;
    for (const [k, v] of this.extModules) {
      if (v.file === safe) { this.extModules.delete(k); removed += 1; }
    }
    this.extErrors.delete(safe);
    this.extDiag(`热重载模块 ${safe}(清缓存 ${removed} 个)`);
    return { ok: true, msg: `已热重载 ${safe}(下次发卡/点击生效)` };
  }

  /** 列表(面板/命令共用): 带"是否自定义事件"标记 */
  listExtFiles(): string[] {
    const out: string[] = [];
    for (const ev of this.listEvents()) {
      const f = this.extFileOf(ev);
      if (f && !out.includes(f)) out.push(f);
    }
    return out;
  }


  /** 列出所有事件(公开, dock/命令共用) */
  listEvents(): BotplayEventConfig[] {
    return Array.isArray(this.eventsGetter()) ? this.eventsGetter() : [];
  }

  /** 按事件 id 精确查(live 现读) */
  findEvent(eventId: string): BotplayEventConfig | undefined {
    return this.listEvents().find((e) => e.id === eventId);
  }

  /**
   * 触发发卡(/botplay 事件名)。定位会话用命令上下文所在 scope/peerId,
   * 归属人 = 触发者本人 openid(group=c2c 同 senderId)。
   *
   * 2026-10-05 加: 事件带 `file`(自定义事件模块)时, 按钮/正文先问模块要(见 resolveExtCard),
   *   模块挂了也不挡发卡(回落到事件自带的按钮配置)。
   */
  async trigger(
    target: ReplyTarget,
    eventId: string,
    triggererId: string,
  ): Promise<BotplayTriggerResult> {
    const ev = this.findEvent(eventId);
    if (!ev) return { ok: false, msg: `事件不存在: ${eventId}(发 /botplay 查看列表)` };
    const extFile = this.extFileOf(ev);
    if (!extFile && (!Array.isArray(ev.buttons) || ev.buttons.length === 0)) {
      return { ok: false, msg: `事件「${ev.name}」没有配置按钮` };
    }
    const expireSec = Math.max(30, Number(ev.expireSec ?? 600) || 600);
    const maxClicks = Math.max(0, Number(ev.maxClicks ?? 0) || 0);
    const cardId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const perm = ev.perm ?? { type: 'all' };
    const ownerIds = this.ownersGetter();
    const perRow = Number(ev.buttonsPerRow ?? 1) || 1;

    // 自定义事件: 问模块拿按钮/正文(onInit 也在这条路上跑一次)
    let extState: BotplayExtCardState | undefined;
    let buttons: BotplayButtonConfig[] = Array.isArray(ev.buttons) ? ev.buttons : [];
    let cardContent: string | undefined;
    let extError: string | undefined;
    if (extFile) {
      const r = await this.resolveExtCard(ev, extFile, cardId, target, triggererId);
      extState = r.state;
      buttons = r.state.buttons as BotplayButtonConfig[];
      cardContent = r.state.contentText;
      extError = r.error;
      if (r.error) this.extDiag(`发卡期模块异常 event=${ev.id} file=${extFile}: ${r.error}`);
    }
    if (buttons.length === 0) {
      this.cards.delete(cardId);
      // 自定义事件没按钮 = 模块没起来(加载失败/没给按钮) 或事件没配 buttons。
      // ⚠️ 这里必须报出**模块的错误摘要**, 否则主人只会看到"没有可用按钮"一头雾水
      //    (2026-10-05 实测: 只报"没有可用按钮"时, 完全看不出是模块文件丢了)。
      if (extFile && extError) {
        return { ok: false, msg: `事件「${ev.name}」的模块没跑起来 → ${extError}` };
      }
      return { ok: false, msg: `事件「${ev.name}」没有可用按钮${extFile ? '(模块没给出按钮, 且事件里也没配 buttons)' : ''}` };
    }

    this.cards.set(cardId, {
      cardId,
      eventId: ev.id,
      eventName: ev.name,
      buttons: JSON.parse(JSON.stringify(buttons)),
      perm: JSON.parse(JSON.stringify(perm)),
      triggererId: perm.type === 'triggerer' ? triggererId : undefined,
      remainClicks: maxClicks > 0 ? maxClicks : 0,
      expireAt: Date.now() + expireSec * 1000,
      target,
      buttonsPerRow: perRow,
      extFile,
      extState,
    });

    // ★ c2c(私聊)修复: 私聊不认 type=0 指定人按钮(同 optionsKeyboard 的注释) →
    //   发出去的键盘用 all(全员可点); card.perm 仍存原 perm, 点击回来由 checkPerm 按快照校验。
    const kbPerm = target.scope === 'c2c' ? ({ type: 'all' } as typeof perm) : perm;
    const kb = botplayKeyboard(cardId, buttons, kbPerm, ownerIds, triggererId, perRow);
    // 卡片正文: 自定义模块给的(若模块没给就走事件模板) > 事件自定义模板 > 默认模板
    const tpl = String(cardContent ?? ev.contentText ?? '').trim();
    const prompt = tpl
      ? tpl.replace(/\{name\}/g, ev.name)
      : [
          `## 🎮 ${ev.name}`,
          '',
          '点下方按钮完成互动 👇',
          '',
          `⏱ 本卡片 ${expireSec} 秒内有效。`,
        ].join('\n');
    try {
      await this.sender.sendMarkdownWithKeyboard(target, prompt, kb);
      this.logger.info(`[botplay] 发卡 ok event=${ev.id} card=${cardId} target=${target.scope}:${target.targetId} perm=${perm.type}${extFile ? ` ext=${extFile}` : ''}`);
      return { ok: true, msg: `已发出「${ev.name}」互动卡片 🎮` };
    } catch (err) {
      this.logger.warn(`[botplay] 发卡失败 event=${ev.id}: ${err instanceof Error ? err.message : String(err)}`);
      this.cards.delete(cardId);
      return { ok: false, msg: `发卡失败: ${err instanceof Error ? err.message : String(err)}(可能未开通卡片权限)` };
    }
  }

  /**
   * 解析自定义事件卡片: 加载模块 → 跑 onInit → 收下模块给的按钮/正文。
   *
   * 为什么整条 fail-soft 到底: 模块是主人(或 AI)手写的代码, 语法错了/钩子抛错都不该
   * 让"发个卡片"这种小事炸掉, 更不该影响其它事件与 QQ 正常聊天 —— 一律记诊断 + 回落。
   * 返回 state.buttons 一定非空(模块没给就用事件自带按钮)。
   */
  private async resolveExtCard(
    ev: BotplayEventConfig,
    extFile: string,
    cardId: string,
    target: ReplyTarget,
    triggererId: string,
  ): Promise<{ state: BotplayExtCardState; error?: string }> {
    const base = Array.isArray(ev.buttons) ? ev.buttons : [];
    const state: BotplayExtCardState = {
      contentText: String(ev.contentText ?? ''),
      buttons: JSON.parse(JSON.stringify(base)) as BotplayButtonConfig[],
      buttonsPerRow: Number(ev.buttonsPerRow ?? 1) || 1,
      dirty: false,
    };
    const { loaded, error } = await this.loadExt(extFile);
    if (!loaded) {
      state.error = error;
      this.logger.warn?.(`[botplay] 自定义事件 ${ev.id} 模块加载失败: ${error}`);
      return { state, error };
    }
    state.filePath = loaded.path;
    const moduleForCard: BotplayExtModule = loaded.mod as BotplayExtModule;
    const ctx = this.buildExtCtx({ ev, extFile, cardId, target, state, moduleForCard, triggererId });
    if (typeof moduleForCard.onInit === 'function') {
      try {
        await moduleForCard.onInit(ctx);
        // onInit 里可能已改过按钮(label/顺序) → 立刻收下, 别等点击
        if (Array.isArray(state.buttons) && state.buttons.length > 0) {
          state.buttons = this.sanitizeExtButtons(state.buttons);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.error = `onInit 抛错: ${msg}`;
        this.extDiag(`onInit 抛错 ${extFile}: ${msg}`);
        this.logger.warn?.(`[botplay] ${extFile} onInit 抛错(已忽略): ${msg}`);
      }
    }
    if (!state.buttons || state.buttons.length === 0) state.buttons = JSON.parse(JSON.stringify(base)) as BotplayButtonConfig[];
    state.dirty = false; // onInit 期不算"脏"(那是初始状态, 不是点击后的变化)
    return { state };
  }

  /**
   * 构造自定义模块的 ctx(每个卡片实例一个)。
   * 说明: ctx.emit/markdown/image 都发往**该实例卡片所在的会话**(target), 不是点击人私聊 ——
   *   群里的签到统计就该发群里; 要私聊给某人可以 ctx.markdown 之外自己判断(本期不做)。
   */
  private buildExtCtx(args: {
    ev: BotplayEventConfig;
    extFile: string;
    cardId: string;
    target: ReplyTarget;
    state: BotplayExtCardState;
    moduleForCard: BotplayExtModule;
    triggererId: string;
    clickerId?: string;
    clickedBefore?: number;
  }): BotplayExtContext {
    const { ev, extFile, cardId, target, state, clickerId } = args;
    const dataRoot = (() => { try { return this.dataRootGetter() || ''; } catch { return ''; } })();
    return makeExtContext(
      {
        dataRoot,
        logger: this.logger as unknown as Logger,
        owners: this.ownersGetter(),
        // ★ 内核句柄：与扩展工具/命令对齐（卡片 ctx.kernel = 插件 cordis ctx）
        kernel: this._kernel,
        // 卡片 = 代码：直接把 bot 凭证给它，让它自己换 token 调官方 API（不经宿主/插件包能力）
        credentialsGetter: () => {
          try { return this.credentialsGetter?.() || { appId: '', appSecret: '' } } catch { return { appId: '', appSecret: '' } }
        },
        cardState: state,
        emit: async (text: string): Promise<boolean> => {
          try { await this.sender.sendMarkdown(target, text); return true; }
          catch (err) { this.logger.warn?.(`[botplay] ${extFile} emit 失败: ${err instanceof Error ? err.message : String(err)}`); return false; }
        },
        markdown: async (content: string): Promise<boolean> => {
          try { await this.sender.sendMarkdown(target, content); return true; }
          catch (err) { this.logger.warn?.(`[botplay] ${extFile} markdown 失败: ${err instanceof Error ? err.message : String(err)}`); return false; }
        },
        image: async (source: { url?: string; localPath?: string }): Promise<boolean> => {
          try { await this.sender.sendMedia(target, 'image', source); return true; }
          catch (err) { this.logger.warn?.(`[botplay] ${extFile} image 失败: ${err instanceof Error ? err.message : String(err)}`); return false; }
        },
        // ★ 2026-10-06 补齐：与扩展工具/命令统一的发送能力
        //   （text / 任意媒体 / 带键盘的 markdown）—— 三套扩展的能力面从此对齐。
        text: async (t: string): Promise<boolean> => {
          const s = this.sender as unknown as { sendText?: (tg: unknown, text: string) => Promise<unknown> };
          if (typeof s.sendText !== 'function') return false;
          try { await s.sendText(target, t); return true; }
          catch (err) { this.logger.warn?.(`[botplay] ${extFile} text 失败: ${err instanceof Error ? err.message : String(err)}`); return false; }
        },
        media: async (kind: 'image' | 'voice' | 'video' | 'file', source: { url?: string; localPath?: string }): Promise<boolean> => {
          try { await this.sender.sendMedia(target, kind, source); return true; }
          catch (err) { this.logger.warn?.(`[botplay] ${extFile} media(${kind}) 失败: ${err instanceof Error ? err.message : String(err)}`); return false; }
        },
        markdownCard: async (content: string, keyboard?: unknown): Promise<boolean> => {
          try { await this.sender.sendMarkdownWithKeyboard(target, content, keyboard as never); return true; }
          catch (err) { this.logger.warn?.(`[botplay] ${extFile} markdownCard 失败: ${err instanceof Error ? err.message : String(err)}`); return false; }
        },
        memberName: (openid: string) => this.memberName(target, openid),
        clickCount: (buttonId?: string) => {
          if (buttonId) return this.extClicks.get(`${cardId}|${buttonId}`) ?? 0;
          let n = 0;
          for (const [k, v] of this.extClicks) if (k.startsWith(`${cardId}|`)) n += v;
          return n;
        },
        reloadSelf: async () => this.reloadExt(extFile),
        diag: (line: string) => this.extDiag(line),
        /**
         * 带 token 的官方 API 调用：转调 GroupAdminClient.apiCall。
         *   模块自己 fetch 拿不到 access_token（没有 appSecret），这就是本能力的价值所在。
         */
        onApiCall: async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
          const ga = (() => { try { return this.groupAdminGetter?.() } catch { return undefined } })();
          if (!ga || typeof ga.apiCall !== 'function') {
            return { ok: false as const, err: { code: 'NO_CLIENT', human: '群管理客户端未就绪(检查 groupAdmin.enabled)' } };
          }
          try {
            return await ga.apiCall(method, path, body);
          } catch (err) {
            return { ok: false as const, err: { code: 'THROW', human: err instanceof Error ? err.message : String(err) } };
          }
        },
        /**
         * 影响 LLM 上下文：转调框架自己的 applyEffect（与事件级 llmEffect 同一套两档）。
         *   append_silent = 只落上下文不唤醒；append_wake = 落上下文并唤醒一轮 AI。
         */
        onLlmAppend: async (mode: 'append_silent' | 'append_wake', text: string): Promise<boolean> => {
          try {
            const presser = String(args.clickerId || args.triggererId || '');
            await this.applyEffect(mode, target, text, presser);
            return true;
          } catch (err) {
            this.logger.warn?.(`[botplay] ${extFile} append 失败: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        },
      },
      {
        id: ev.id,
        name: ev.name,
        file: extFile,
        maxClicks: ev.maxClicks,
        expireSec: ev.expireSec,
        scope: target.scope === 'group' ? 'group' : 'c2c',
        peerId: target.targetId,
      },
      cardId,
      clickerId ? { openid: clickerId, clickedBefore: args.clickedBefore ?? 0 } : undefined,
    );
  }

  /** 把模块给的按钮洗成合法形状(缺 id/label 的丢掉; 防止脏数据把 keyboard 生成搞炸) */
  private sanitizeExtButtons(buttons: unknown[]): BotplayButtonConfig[] {
    const out: BotplayButtonConfig[] = [];
    for (const raw of buttons) {
      const b = raw as Partial<BotplayButtonConfig>;
      const id = String(b?.id ?? '').trim();
      const label = String(b?.label ?? '').trim();
      if (!id || !label) continue;
      const actType = String(b?.botAction?.type ?? 'reply_text');
      out.push({
        id,
        label: label.slice(0, 20),
        visitedLabel: String(b?.visitedLabel ?? '').slice(0, 20),
        style: Number(b?.style ?? 1) === 0 ? 0 : 1,
        botAction: {
          // 只放行 reply_text/jump_url(自定义事件的按钮动作实际由模块 onClick 决定,
          // 这两个字段只是键盘渲染需要; command/callback 由模块自己用 ctx 表达)
          type: actType === 'jump_url' ? 'jump_url' : 'reply_text',
          text: String(b?.botAction?.text ?? ''),
          url: String(b?.botAction?.url ?? ''),
        },
      });
    }
    return out.slice(0, 25); // QQ 键盘上限 5行×5列
  }

  /** 点击后按钮变了 ⇒ 重发卡片刷新(QQ 没有现成的"改卡片"接口, 重发是可靠做法) */
  private async refreshCard(card: ActiveCard, content: string): Promise<void> {
    try {
      const kbPerm = card.target && card.target.scope === 'c2c' ? ({ type: 'all' } as typeof card.perm) : card.perm;
      const kb = botplayKeyboard(card.cardId, card.buttons, kbPerm, this.ownersGetter(), card.triggererId, card.buttonsPerRow);
      const body = content.trim() || `## 🎮 ${card.eventName}`;
      await this.sender.sendMarkdownWithKeyboard(card.target, body.replace(/\{name\}/g, card.eventName), kb);
      this.logger.info(`[botplay] 卡片刷新 card=${card.cardId} event=${card.eventId}`);
    } catch (err) {
      this.logger.warn?.(`[botplay] 卡片刷新失败 card=${card.cardId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 清理一个卡片实例的扩展资源(点击计数/模块 onDispose) */
  private async disposeCard(card: ActiveCard): Promise<void> {
    for (const k of [...this.extClicks.keys()]) if (k.startsWith(`${card.cardId}|`)) this.extClicks.delete(k);
    if (!card.extFile) return;
    try {
      const { loaded } = await this.loadExt(card.extFile);
      if (!loaded) return;
      const mod = loaded.mod as BotplayExtModule;
      if (typeof mod.onDispose === 'function') {
        const fallbackEv: BotplayEventConfig = { id: card.eventId, name: card.eventName, buttons: [] };
        const ctx = this.buildExtCtx({
          ev: this.findEvent(card.eventId) ?? fallbackEv,
          extFile: card.extFile,
          cardId: card.cardId,
          target: card.target,
          state: card.extState ?? { contentText: '', buttons: [], dirty: false },
          moduleForCard: mod,
          triggererId: card.triggererId ?? '',
        });
        await mod.onDispose(ctx);
      }
    } catch (err) {
      this.logger.warn?.(`[botplay] ${card.extFile} onDispose 抛错(已忽略): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 发送事件目录卡(/botplay 无参 或 目录卡翻页; 点事件名按钮 → handleInteraction 直接触发) */
  async sendCatalog(target: ReplyTarget, page = 0): Promise<BotplayTriggerResult> {
    const events = this.listEvents();
    if (events.length === 0) return { ok: false, msg: '🎮 还没有装配任何互动事件——到 dock「🎮 互动事件」装配保存后即可。' };
    const pages = catalogPages(events);
    const safePage = Math.max(0, Math.min(page, pages - 1));
    const kb = catalogKeyboard(safePage, events);
    const prompt = [
      '### 🎮 互动事件',
      '',
      `共 ${events.length} 个 · 第 ${safePage + 1}/${pages} 页`,
      '',
      '点下方事件名直接触发 👇',
    ].join('\n');
    try {
      await this.sender.sendMarkdownWithKeyboard(target, prompt, kb);
      this.logger.info(`[botplay] 目录卡 page=${safePage + 1}/${pages}(共${events.length}) target=${target.scope}:${target.targetId}`);
      return { ok: true, msg: '' }; // 目录卡已发, 不追加文本
    } catch (err) {
      return { ok: false, msg: `目录卡发送失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * interaction 回调结算(bootstrap interaction 分发转发; type=11 消息按钮)。
   * 流程: 解析 bp:<cardId>:<buttonId> → 查卡(过期/点满) → 查事件配置(live)
   * → 校验按钮存在与点击人权限 → 执行 botAction → 按 llmEffect.mode append/唤醒。
   * @returns true = 已被 botplay 消费(调用方无需其它处理)
   */
  async handleInteraction(event: unknown, replyTarget: ReplyTarget): Promise<boolean> {
    const e = event as {
      data?: { type?: number; resolved?: { button_data?: string } };
      group_member_openid?: string;
      user_openid?: string;
    };
    if (e?.data?.type !== 11) return false;
    // 目录卡按钮(Phase2): bpc:<page>:<key> —— key=事件id直接触发 / prev|next 翻页
    const cat = parseCatalogButton(e.data.resolved?.button_data);
    if (cat) {
      const presserId = e.group_member_openid ?? e.user_openid ?? '';
      if (cat.key === 'prev') { await this.sendCatalog(replyTarget, cat.page - 1); return true; }
      if (cat.key === 'next') { await this.sendCatalog(replyTarget, cat.page + 1); return true; }
      // 事件 id → 直接触发发卡(点击者本人为 triggerer, 权限由事件 perm 决定)
      const ev = this.findEvent(cat.key);
      if (!ev) { await this.safeReply(replyTarget, '该事件已被删除, 请刷新目录~'); return true; }
      await this.trigger(replyTarget, ev.id, presserId);
      return true;
    }
    const parsed = parseBotplayButton(e.data.resolved?.button_data);
    if (!parsed) return false;

    const card = this.cards.get(parsed.cardId);
    if (!card) {
      // 卡不存在(重启后内存清空/已失效) → 提示重发
      await this.safeReply(replyTarget, '这张互动卡片已失效, 请重新发 /botplay 触发~');
      return true;
    }
    // 过期校验(2026-10-05: 自定义事件也走一次 onExpire, 让模块知道卡片死了)
    if (Date.now() > card.expireAt) {
      this.cards.delete(parsed.cardId);
      await this.fireExtExpire(card);
      await this.safeReply(replyTarget, '这张互动卡片已超时失效, 请重新发 /botplay~');
      return true;
    }
    // 事件仍存在才受理(删除后旧卡失效提示重配); 按钮/权限/名称一律走【发卡时快照】,
    // 配置热改不会让已发卡"漂移"(Phase2 版本化语义)。
    const ev = this.findEvent(card.eventId);
    if (!ev) {
      this.cards.delete(parsed.cardId);
      await this.safeReply(replyTarget, '该互动事件已被删除, 请让管理员重新配置~');
      return true;
    }
    const btn = card.buttons.find((b) => b.id === parsed.buttonId);
    if (!btn) {
      await this.safeReply(replyTarget, '按钮配置已更新, 请重新触发这张卡片~');
      return true;
    }

    // 点击人权限校验(与发卡 permission 双保险; 按快照 perm, 群看 member_openid, c2c 看 user_openid)
    const presser = e.group_member_openid ?? e.user_openid ?? '';
    const allowed = this.checkPerm(card.perm, card, presser);
    if (!allowed) {
      await this.safeReply(replyTarget, '这个按钮只有指定的人能点哦~');
      return true;
    }

    // 连点防刷: maxClicks>0 时扣减, 点满失效
    if (card.remainClicks > 0) {
      card.remainClicks -= 1;
      if (card.remainClicks <= 0) {
        this.cards.delete(parsed.cardId);
      }
    }

    // ① bot(非LLM)行为(按快照)
    // ── 自定义事件(2026-10-05): 走模块的 onClick, 完全不碰下面的 botAction 分支 ──
    if (card.extFile && card.extState) {
      await this.runExtClick(card, btn, presser, replyTarget);
    } else {
      await this.runBuiltinAction(btn, replyTarget);
    }

    // ② LLM 影响三档(按快照; 注入文本带点击人身份: 昵称(openid), 台账/会话历史反查)
    //    自定义事件的 llmEffect 仍按事件快照生效(=模块写了 llmEffect 就照常影响 AI)。
    const mode = btn.llmEffect?.mode ?? 'no_append';
    if (mode !== 'no_append') {
      const clicker = this.clickerLabel(replyTarget, presser);
      const text = renderContext(btn.llmEffect?.contextText, card.eventName, btn.label ?? '', clicker);
      await this.applyEffect(mode, replyTarget, text, presser);
    }
    return true;
  }

  /** 内置三型按钮行为(reply_text / jump_url / command; 普通事件用) */
  private async runBuiltinAction(btn: BotplayButtonConfig, replyTarget: ReplyTarget): Promise<void> {
    const actionType = btn.botAction?.type ?? 'reply_text';
    if (actionType === 'reply_text') {
      const text = String(btn.botAction?.text ?? '').trim();
      if (text) {
        try {
          await this.sender.sendMarkdown(replyTarget, text);
        } catch (err) {
          this.logger.warn(`[botplay] reply_text 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (actionType === 'jump_url') {
      // jump_url 是官方 type=0 跳转按钮 → 点击时客户端直接跳, 不会走到回调;
      // 若仍收到回调(降级/不可跳)则提示用户直接点链接。
      const url = String(btn.botAction?.url ?? '').trim();
      await this.safeReply(replyTarget, url ? `跳转按钮: ${url}(如未自动跳转请手动打开)` : '该按钮是跳转按钮, 请在支持跳转的客户端点击');
    } else if (actionType === 'command') {
      // command 指令型(Phase2): 点击 → host 直接执行斜杠命令(不经 AI 文本)。
      // 命令名存 botAction.text(不带 /); 由 bootstrap 注入的 executor 执行并把结果发回。
      const cmdName = String(btn.botAction?.text ?? '').trim().replace(/^\//, '');
      if (cmdName && this.commandExecutor) {
        try {
          const text = await this.commandExecutor(cmdName, replyTarget);
          if (text && text.trim()) await this.safeReply(replyTarget, text);
        } catch (err) {
          this.logger.warn(`[botplay] command 执行失败 ${cmdName}: ${err instanceof Error ? err.message : String(err)}`);
          await this.safeReply(replyTarget, `指令执行失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        await this.safeReply(replyTarget, cmdName ? '指令执行器未就绪, 请稍后再试~' : '这个按钮没配置要执行的命令');
      }
    }
    // callback=仅结算, 无 bot 回复
  }

  /**
   * 跑自定义模块的 onClick(2026-10-05)。
   *
   * 顺序(为什么这么排):
   *   ① 计数先 ++, 让模块里的 ctx.clicked 立刻反映"这是第几次点"(签到判重的关键);
   *   ② 跑模块(它可能改按钮/正文/发消息/持久化);
   *   ③ 模块返回非空字符串 → 当普通文本回给点击者(比让模块自己 emit 更省事);
   *   ④ 模块把卡片改脏 → 重发卡片刷新按钮(QQ 没"改卡片"接口, 重发是可靠做法);
   *   ⑤ 模块抛错 → 回一句人话 + 落诊断, 绝不让一次点击把插件带崩(fail-soft)。
   */
  private async runExtClick(card: ActiveCard, btn: BotplayButtonConfig, presser: string, replyTarget: ReplyTarget): Promise<void> {
    const extFile = card.extFile ?? '';
    const state = card.extState!;
    const key = `${card.cardId}|${btn.id}`;
    const count = (this.extClicks.get(key) ?? 0) + 1;
    this.extClicks.set(key, count);
    const { loaded, error } = await this.loadExt(extFile);
    if (!loaded) {
      this.extDiag(`点击期模块加载失败 ${extFile}: ${error}`);
      // 加载失败时给用户一句人话(而不是静默无反应), 方便主人定位
      await this.safeReply(replyTarget, `⚠️ 这个事件的模块加载失败, 请到面板看看错误摘要(文件: ${extFile})`);
      return;
    }
    const mod = loaded.mod as BotplayExtModule;
    if (typeof mod.onClick !== 'function') {
      this.extDiag(`模块 ${extFile} 没有 onClick, 点击被忽略 button=${btn.id}`);
      await this.safeReply(replyTarget, '这个事件没有处理点击的逻辑(onClick)');
      return;
    }
    const ev = this.findEvent(card.eventId) ?? { id: card.eventId, name: card.eventName, buttons: [] };
    const ctx = this.buildExtCtx({
      ev: ev as BotplayEventConfig,
      extFile,
      cardId: card.cardId,
      target: card.target,
      state,
      moduleForCard: mod,
      triggererId: card.triggererId ?? '',
      clickerId: presser,
      clickedBefore: count - 1,
    });
    // 让按钮快照跟着模块的修改走(下一行点击/重发卡片都用最新按钮)
    const beforeButtons = JSON.stringify(state.buttons);
    try {
      const ret = await mod.onClick(ctx, { buttonId: btn.id, buttonLabel: btn.label ?? '', clickedBefore: count - 1 });
      if (state.buttons && JSON.stringify(state.buttons) !== beforeButtons) {
        state.buttons = this.sanitizeExtButtons(state.buttons);
      }
      if (Array.isArray(state.buttons) && state.buttons.length > 0) {
        card.buttons = JSON.parse(JSON.stringify(state.buttons)) as BotplayButtonConfig[];
      }
      if (typeof ret === 'string' && ret.trim()) await this.safeReply(replyTarget, ret.trim());
      card.extReply = typeof ret === 'string' ? ret : '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      card.extError = msg;
      state.error = `onClick 抛错: ${msg}`;
      this.extDiag(`onClick 抛错 ${extFile} button=${btn.id}: ${msg}`);
      this.logger.warn?.(`[botplay] ${extFile} onClick 抛错(已忽略): ${msg}`);
      await this.safeReply(replyTarget, `⚠️ 事件逻辑出错了(onClick): ${msg}`);
    }
    // 模块改过卡片(按钮 label style / 正文) → 重发刷新, 群里看到的就是最新状态
    if (state.dirty) {
      state.dirty = false;
      await this.refreshCard(card, state.contentText);
    }
  }


  /**
   * 点击人可读标签(与 dock 禁言面板/审批同源的昵称反查):
   *   ①群成员台账 group-members.jsonl(gid:mid → name, 由 chat-ledger 中间件持续记录)
   *   ②私聊台账 known-chats.jsonl(c2c:id → name)
   *   ③会话最近 user/message 消息壳 [昵称 (openid)] 兜底
   *   ④全 miss 回落 openid。
   */
  private clickerLabel(target: ReplyTarget, presser: string): string {
    if (!presser) return '未知用户';
    const name = this.memberName(target, presser);
    // 台账/会话里查到的是纯昵称 → 补个 openid 尾巴(诊断/排查用); 查不到就是 openid 本身
    return name === presser ? presser : `${name}(${presser.slice(0, 8)}…)`;
  }

  /**
   * 昵称反查(2026-10-05 从 clickerLabel 抽出来给自定义模块用): 只要**纯昵称**, 不带 openid 尾巴
   * (签到统计那种"列出所有签到者名字"的场景, 名字后面挂截断 openid 很难看)。
   * 数据源与 clickerLabel 同源(见其注释): 群成员台账 → 私聊台账 → 会话消息壳 → 回落 openid。
   */
  private memberName(target: ReplyTarget, presser: string): string {
    if (!presser) return '';
      // ⓪ 内存缓存（后台 API 兜底查到的；比台账更新，优先用）
      const _ck = `${target.targetId}|${presser}`;
      const _cc = this.memberNameApiCache.get(_ck);
      if (_cc) return _cc;
    // ① 台账(host 侧与 dock 禁言同源: dataDir=表情包目录, 同 group-members.jsonl)
    try {
      const dataDir = this.ledgerDataDirGetter();
      if (dataDir) {
        if (target.scope === 'group') {
          const members = readGroupMembers(dataDir, target.targetId);
          const hit = members.find((m) => m.mid === presser);
          if (hit && hit.name) return hit.name;
        } else {
          const chats = readLedger(dataDir);
          const hit = chats.filter((c) => c.scope === 'c2c' && c.id === presser).sort((a, b) => b.ts - a.ts)[0];
          if (hit && hit.name) return hit.name;
        }
      }
    } catch { /* 台账读取失败, 走下一步 */ }
    // ③ 会话消息壳兜底
    const record = this.manager.findByPeer(target.scope, target.targetId);
    try {
      const evs = record?.agent?.session?.events;
      if (Array.isArray(evs)) {
        const from = Math.max(0, evs.length - 80);
        for (let i = evs.length - 1; i >= from; i--) {
          const ev = evs[i] as { type?: string; data?: Record<string, unknown> } | undefined;
          if (!ev || ev.type !== 'user/message') continue;
          const data = ev.data && typeof ev.data === 'object' ? ev.data : (ev as unknown as Record<string, unknown>);
          const src = data.source as { kind?: string } | undefined;
          if (src && src.kind === 'plugin') continue;
          const content = Array.isArray(data.content) ? (data.content as Array<{ text?: string }>) : [];
          const text = content.map((b) => (b?.text ?? '')).join('\n');
          if (!text) continue;
          // 壳格式: [昵称 (openid32)] 正文 (inbound.ts buildUserMessage)
          const idx = text.indexOf(`(${presser})`);
          if (idx > 1) {
            const head = text.slice(0, idx).replace(/^\[+/, '').trim();
            if (head && !head.includes(presser)) return head;
          }
        }
      }
    } catch { /* 解析失败回落 */ }
      // ④ API 兜底（2026-10-05，主人定："兜底的时候用 api，其余的时候用台账"）
      //   ⚠️ 本函数是【同步】的（调用方很多，改异步要动一大片），所以做法是：
      //   本次仍回落 openid，**同时后台发起一次查询**；查到就写进内存缓存，
      //   下一次再问同一个人就有名字了（一场签到里通常只差几秒）。
      //   官方该接口标注「内邀接入中」（11253 = 无权限）⇒ 失败一律静默，只记一行日志。
      this.probeMemberNameAsync(target, presser);
    return presser;
  }

  /** 权限判定: all 放行 / triggerer=触发者本人 / owner=主人白名单 / users=指定 openid */
  private checkPerm(
    perm: NonNullable<BotplayEventConfig['perm']>,
    card: ActiveCard,
    presser: string,
  ): boolean {
    if (perm.type === 'all') return true;
    if (!presser) return false; // 无人身份不给点
    if (perm.type === 'triggerer') return !!card.triggererId && presser === card.triggererId;
    if (perm.type === 'owner') return this.ownersGetter().includes(presser);
    if (perm.type === 'users') return (perm.userIds ?? []).includes(presser);
    return false;
  }

  /**
   * append 三档落点: 往该 peer 的会话写上下文/唤醒 AI。
   * ⚠️ 会话不在内存(重启后未恢复/被 idle 回收)→ getOrCreate 恢复/重建(不触发回合),
   *    保证 append/injectToPeer 有 record 可挂 —— 这是"点击没反应"的常见根因。
   */
  /** ★ 内核句柄（遥控器）：bootstrap 构造本控制器后注入；卡片 ctx.kernel 就是它 */
  private _kernel?: unknown;
  setKernel(kernel: unknown): void { this._kernel = kernel; }

  private async applyEffect(mode: 'append_silent' | 'append_wake', target: ReplyTarget, text: string, presser: string): Promise<void> {
    let record = this.manager.findByPeer(target.scope, target.targetId);
    if (!record) {
      try {
        record = await this.manager.getOrCreate(target.scope, target.targetId, presser || 'unknown', target);
        this.logger.info(`[botplay] 会话不在, 已 getOrCreate 恢复 ${target.scope}:${target.targetId}`);
      } catch (err) {
        this.logger.warn(`[botplay] getOrCreate 失败: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (mode === 'append_silent') {
      // 记录不唤醒: 复用 group-hub safeAppendUserMessage 姿势 —— 先等回合空闲再 session.append 只落上下文
      // 🔒 硬约束(主人定 2026-09-09): LLM 回合进行中严禁 append(拆散 tool_calls 坏记录)
      const a = record.agent as unknown as {
        whenIdle?: () => Promise<void>;
        session?: { append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown };
      } | undefined;
      const sess = a?.session;
      if (!sess || typeof sess.append !== 'function') return;
      // ★ 2026-10-06: 人设未落盘 ⇒ 绝不能静默 append（会把会话日志写废，见 session/surface-guard.ts）
      if (skipSilentAppend(a, this.logger, 'botplay')) return;
      try {
        // 等回合结束(空闲立即返回; 活跃时宿主等 turn/end; 超时 60s 放弃, 不硬塞坏记录)
        if (typeof a.whenIdle === 'function') {
          try {
            await Promise.race([a.whenIdle(), new Promise((r) => setTimeout(r, 60_000))]);
          } catch { return; }
        }
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
        const msg = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
        sess.append('user/message', msg, { surfaceOp: 'append' });
        this.logger.info(`[botplay] append_silent ok ${target.scope}:${target.targetId}`);
      } catch (err) {
        this.logger.warn(`[botplay] append_silent 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // append_wake: 记录 + 唤醒 AI(走 injectToPeer followup, AI 开回合自然回应)
    try {
      const ok = await this.manager.injectToPeer(target.scope, target.targetId, text);
      this.logger.info(`[botplay] append_wake ${ok ? 'ok' : 'miss'} ${target.scope}:${target.targetId}`);
    } catch (err) {
      this.logger.warn(`[botplay] append_wake 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async safeReply(target: ReplyTarget, text: string): Promise<void> {
    try { await this.sender.sendMarkdown(target, text); } catch { /* 回复失败不致命 */ }
  }

  /**
   * 通知自定义模块"这张卡片过期了"(onExpire; 2026-10-05)。
   * 为什么要有: 签到类事件常要"到点自动结算/清场", 模块没有这个回调就只能等主人手点。
   * fail-soft: 模块抛错只记日志。
   */
  private async fireExtExpire(card: ActiveCard): Promise<void> {
    if (!card.extFile) return;
    try {
      const { loaded } = await this.loadExt(card.extFile);
      if (!loaded) return;
      const mod = loaded.mod as BotplayExtModule;
      if (typeof mod.onExpire !== 'function') return;
      const ev = (this.findEvent(card.eventId) ?? { id: card.eventId, name: card.eventName, buttons: [] }) as BotplayEventConfig;
      const ctx = this.buildExtCtx({
        ev, extFile: card.extFile, cardId: card.cardId, target: card.target,
        state: card.extState ?? { contentText: '', buttons: [], dirty: false },
        moduleForCard: mod, triggererId: card.triggererId ?? '',
      });
      await mod.onExpire(ctx);
      this.extDiag(`onExpire ok ${card.extFile} card=${card.cardId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.extDiag(`onExpire 抛错 ${card.extFile}: ${msg}`);
      this.logger.warn?.(`[botplay] ${card.extFile} onExpire 抛错(已忽略): ${msg}`);
    }
    await this.disposeCard(card);
  }

  /** 清理全部活动卡(dispose 用; 自定义事件会收到 onDispose) */
  clear(): void {
    const snapshot = [...this.cards.values()];
    this.cards.clear();
    // onDispose 是异步的, 但不能让 dispose 链路等它 —— 逐个 fire 并吞掉异常
    for (const c of snapshot) void this.disposeCard(c).catch(() => { /* 忽略 */ });
  }

  /** 扫掉过期卡(Phase2: 定期/触发时调用, 防内存积压; 2026-10-05 顺带通知模块 onExpire) */
  sweepExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, c] of this.cards) {
      if (now > c.expireAt) {
        this.cards.delete(id);
        n += 1;
        if (c.extFile) void this.fireExtExpire(c).catch(() => { /* 忽略 */ });
        else void this.disposeCard(c).catch(() => { /* 忽略 */ });
      }
    }
    if (n > 0) this.logger.info(`[botplay] 清理过期卡 ${n} 张(剩 ${this.cards.size})`);
    return n;
  }

  /** 活动卡数量(诊断用) */
  get cardCount(): number {
    return this.cards.size;
  }
}

// ── 按实例(ns)注册表 + 命令/触发共用入口(仿 outbound-mode-switch / qq-approval) ──
const botplayControllers = new Map<string, BotplayController>();

export function registerBotplayController(ns: string, c: BotplayController | undefined): void {
  if (c) botplayControllers.set(ns, c);
  else botplayControllers.delete(ns);
}

/** /botplay 命令触发入口: bootstrap 注册实现(带 sender/manager)。
 *  ⚠️ 2026-09-11 多实例修复: 原模块级单例会被多个实例互相覆盖(和 outbound writer 同款 bug,
 *  实测 /botplay 在 某实例会话执行却发卡到别的实例的群 86976C...)。改为按 ns 注册表。 */
type TriggerFn = (target: ReplyTarget, eventId: string, triggererId: string) => Promise<BotplayTriggerResult>;

const triggerImpls = new Map<string, TriggerFn>();

export function setBotplayTriggerImpl(ns: string, fn: TriggerFn | undefined): void {
  if (fn) triggerImpls.set(ns, fn);
  else triggerImpls.delete(ns);
}

export async function triggerBotplay(ns: string, target: ReplyTarget, eventId: string, triggererId: string): Promise<BotplayTriggerResult> {
  const impl = triggerImpls.get(ns);
  if (!impl) {
    // 兼容旧调用(未传 ns): 单实例兜底
    if (triggerImpls.size === 1) return (triggerImpls.values().next().value as TriggerFn)(target, eventId, triggererId);
    return { ok: false, msg: 'botplay 未就绪(插件未启动)' };
  }
  return impl(target, eventId, triggererId);
}

/** 事件目录卡入口: bootstrap 注册实现(带 sender/manager); /botplay 无参调用 */
type CatalogFn = (target: ReplyTarget, page: number) => Promise<BotplayTriggerResult>;

const catalogImpls = new Map<string, CatalogFn>();

export function setBotplayCatalogImpl(ns: string, fn: CatalogFn | undefined): void {
  if (fn) catalogImpls.set(ns, fn);
  else catalogImpls.delete(ns);
}

export async function botplayCatalog(ns: string, target: ReplyTarget, page = 0): Promise<BotplayTriggerResult> {
  const impl = catalogImpls.get(ns);
  if (!impl) {
    if (catalogImpls.size === 1) return (catalogImpls.values().next().value as CatalogFn)(target, page);
    return { ok: false, msg: 'botplay 未就绪(插件未启动)' };
  }
  return impl(target, page);
}

/** 取某 ns 的事件列表(dock 装配器读; settings value 里其实已有, 此出口备用) */
export function listBotplayEventsAny(): Array<BotplayEventConfig & { ns: string }> {
  const out: Array<BotplayEventConfig & { ns: string }> = [];
  for (const [ns, c] of botplayControllers) {
    for (const e of c.listEvents()) out.push({ ns, ...e });
  }
  return out;
}

// ── 自定义事件面板出口(2026-10-05): settings-host 经 channel-tools 读这些 ──
// host 半边不能直接拿 manager/controller, 只能走插件侧导出的模块级入口(与 triggerBotplay 同款)。

/** 取某 ns 的 botplay 控制器(未注册返回 undefined) */
export function botplayControllerOf(ns: string): BotplayController | undefined {
  return botplayControllers.get(ns);
}

/**
 * 面板用: 某实例的自定义事件模块状态(路径/是否存在/mtime/加载错误/hooks)。
 * 找不到实例时返回空数组(面板显示"未就绪"即可, 不报错)。
 */
export function botplayExtStatus(ns: string): Array<{
  file: string; path: string; exists: boolean; mtime: number;
  loadedMtime: number; name: string; error: string; hooks: string[];
}> {
  const c = botplayControllers.get(ns);
  if (!c) return [];
  try { return c.extStatus(); } catch { return []; }
}

/** 面板「🔄 重载模块」用: 热重载指定模块(空=全部); 不重启宿主 */
export function reloadBotplayExt(ns: string, file?: string): { ok: boolean; msg: string } {
  const c = botplayControllers.get(ns);
  if (!c) return { ok: false, msg: 'botplay 未就绪(插件未启动或该账号实例未加载)' };
  try { return c.reloadExt(file); } catch (err) { return { ok: false, msg: `重载异常: ${err instanceof Error ? err.message : String(err)}` }; }
}

/**
 * 取指定实例的事件列表(命令层 /botplay 用)。
 * ⚠️ 2026-09-10 修复: 事件存储自 M4.3 起已迁到 {dataRoot}/botplay-events.json, 但命令层仍在读
 *    config.botplayEvents(settings 层, 迁移后已被清空) → /botplay 永远报"还没有装配任何互动事件"。
 *    控制器 listEvents() 是现读文件的(支持热更), 这里直接复用其数据源, 单一真相源。
 * 控制器未注册(插件未就绪)时返回 undefined, 调用方回退 config.botplayEvents。
 */
export function listBotplayEventsOfNs(ns: string): BotplayEventConfig[] | undefined {
  const c = botplayControllers.get(ns);
  return c ? c.listEvents() : undefined;
}

/** 会话定位 → ReplyTarget(命令层用; senderId 即触发者) */
export function resolveCommandTarget(
  cmdCtx: { message?: { kind?: string; groupOpenid?: string; senderId?: string; messageId?: string } },
): { target: ReplyTarget; triggererId: string } {
  const msg = cmdCtx.message ?? {};
  const isGroup = msg.kind === 'group';
  const peerId = isGroup ? (msg.groupOpenid ?? msg.senderId ?? '') : (msg.senderId ?? '');
  return {
    target: { scope: isGroup ? 'group' : 'c2c', targetId: peerId, msgId: msg.messageId },
    triggererId: msg.senderId ?? '',
  };
}

