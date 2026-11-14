/**
 * group-admin.ts — QQ 普通群管理 API 客户端(2026-09-05, 设计见 参考文档/群管理实现设计.md)
 *
 * 背景: QQ 官方 api-v2 已发布"群聊管理"接口, 但开放度分档(2026-09-05 官方社区核实):
 *   🔴 未开放(内邀中): 成员列表 / 批量移除(踢人) —— 调用会得到 11253(仅白名单/未开放);
 *   🟡 门槛=机器人是群管理员(文档未标内邀): 入群申请列表/审批、群禁言查询/设置 —— 先行实现。
 * SDK(@tencent-connect/qqbot-nodejs) 未封装这些接口 → 本文件自建 REST 层;
 * token 走官方 https://bots.qq.com/app/getAppAccessToken, 内置 per-appId 缓存+并发单飞(不依赖 SDK)。
 *
 * 统一返回: { ok:true, data } | { ok:false, err:{ code, human } }
 *   code = 官方错误码或 FEATURE_NOT_OPEN; human = 面向用户的一句话(人话), UI/工具直接展示。
 *
 * ⚠️ 本地手改功能: 同步纪律同 middleware-setup(改完保持 src 与部署 dist 一致)。
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** 官方 access_token 端点(与 SDK token.ts 同源) */
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.bot.qq.com';

/** 已知官方未开放(内邀中)的能力门控元数据 —— UI 据此渲染红条/灰态; 开放后删除对应项即可点亮 */
export const FEATURE_GATES: Record<string, { open: boolean; human: string }> = {
  listMembers: { open: false, human: '获取群成员列表: 官方尚未开放(内邀中), 等待公测后自动可用' },
  // 2026-10-20 主人实测: QQ 开放平台后台「权限」页已可勾选「移除群成员」，群管理员里也能给机器人开这项。
  //   → 不再硬关；调用失败会带回平台错误码，按错误信息判断即可。
  removeMembers: { open: true, human: '踢人: 需要平台勾选「移除群成员」+ 机器人是群管理员' },
  listJoinRequests: { open: true, human: '入群申请列表: 机器人需为群管理员' },
  approveJoinRequest: { open: true, human: '入群申请审批: 机器人需为群管理员' },
  getMemberInfo: { open: false, human: '获取群成员信息(含昵称): 官方标注「内邀接入中」, 申请到白名单后自动可用' },
  getMuteState: { open: true, human: '群禁言状态查询: 机器人需为群管理员' },
  setMute: { open: true, human: '设置禁言: 机器人需为群管理员' },
};

export interface MemberInfo {
  member_openid: string;
  username?: string;
  member_role?: string;
}

export interface JoinRequest {
  join_request_id: string;
  risk_tips?: string;
  union_openid?: string;
  member_openid: string;
  username?: string;
  apply_at?: string;
  apply_source?: 'self_apply' | 'invited';
  invited_by?: string;
  bot?: boolean;
  verify_info?: { method?: string; verify_message?: string; review_qa_list?: Array<{ question: string; answer: string }> };
}

/** 官方 verify_info.method 枚举 → 中文(用户可见)。未知枚举回落原文 */
const VERIFY_METHOD_HUMAN: Record<string, string> = {
  admin_review_qa: '问题验证(需管理员审核)',
  admin_review: '管理员审核',
  free_join: '自由进群',
  qa: '问题验证',
};

/**
 * 入群申请的"验证信息"人话化:
 *   - review_qa_list 有内容 → 逐条「问题:xxx / 答案:yyy」;
 *   - 否则 verify_message 有值 → 直接显示用户填的答案(如「我是小号」);
 *   - 否则 method 有值 → 翻译成中文(admin_review_qa 这类英文枚举不该露给用户);
 *   - 都没有 → ''(无验证, 调用方显示 '-' 或不显示)。
 */
export function verifyHuman(vi?: { method?: string; verify_message?: string; review_qa_list?: Array<{ question?: string; answer?: string }> }): string {
  const qa = vi?.review_qa_list?.filter((x) => x && (x.question || x.answer));
  if (qa && qa.length) {
    return qa.map((x) => `${x.question ?? '问题'}「${x.answer ?? '(未填)'}」`).join('；');
  }
  if (vi?.verify_message) return vi.verify_message;
  if (vi?.method) return VERIFY_METHOD_HUMAN[vi.method] ?? `验证方式:${vi.method}`;
  return '';
}

export interface MuteState {
  global_rule?: { mode?: 'none' | 'always' | 'schedule'; schedule_rules?: unknown[]; recurring_rules?: unknown[] };
  members?: Array<{ member_openid: string; mute_expire_at?: string; username?: string; union_openid?: string }>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; err: { code: string; human: string } };

/**
 * 官方错误码 → 人话(可扩充; code 映射不到时回落通用文案)。
 * 2026-09-12 增强(主人要求"错误人话化"): 不只说"哪里错了", 还要给**可执行的下一步** ——
 * 之前只覆盖群管理类码, 发消息类的报错会把裸码抛给用户/AI(如"被动回复时间或次数超过限制"),
 * 以致 AI 得自己猜怎么绕。
 */
export function mapErrHuman(code: string | number, gateHuman?: string): string {
  const c = String(code);
  const table: Record<string, string> = {
    // ── 群管理/权限类 ──
    '11253': gateHuman || '该能力官方尚未开放/未授权(内邀中或需白名单), 请联系平台运营',
    '11703': gateHuman || '机器人无该接口权限: 需为该群管理员, 或该能力尚未对应用开放(探针实测 2026-09-05)',
    '40103004': '不能操作该成员: 群主/管理员/机器人不可被禁言(只能禁普通成员)',
    '11202': '接口调用异常, 请稍后重试',
    '11201': '机器人不在该群或参数错误',
    '40101': '频控: 请求太快, 稍等再试',
    '403': '机器人缺少群管理员身份或未授权',
    '401': '访问凭证无效, 请刷新后重试',
    '11001': '接口或参数不正确(实测: 调用的 API 路径/字段写错时会返回它) —— 检查 URL 与参数, 不是网络问题',
    // ── 消息发送类(2026-09-12 补: 每条都给"怎么办") ──
    '304103': '被动回复的 msg_id 已过期(窗口 5 分钟): 去掉 msg_id 改**主动消息**, 或等群里有人先说一句',
    '40034005': '回复的 msg_id 已过期(被动回复 5 分钟内有效): 改**主动消息**发送, 或让群里先有人说话',
    '304036': '机器人没有 Markdown 模板权限: 改用 `type=text` 纯文本(或去 QQ 开放平台申请 Markdown 模板)',
    '40034008': 'markdown 参数里有空值: 每个模板参数都要有值',
    '40034009': 'markdown 参数里有换行符: 去掉参数中的换行',
    '40034010': '模板参数里不能含 markdown 语法: 参数用纯文本',
    '40034006': '内容违规: 改一下措辞(去掉敏感词/可疑链接)',
    '40034029': '键盘按钮超限(最多 5 行 × 每行 5 个): 减少按钮数量',
    '304004': '无权限使用该 ARK 模板',
    '305007': 'keyboard 结构不对: 检查 rows/buttons 层级',
    '340069': 'msg_type 无效: 只能 0=文本 / 2=markdown / 7=富媒体',
    '22006': '消息类型与内容不匹配: msg_type 要和实际内容字段对应',
    '40034004': '富媒体转存失败(平台没能下载你的 URL): 换可直连的直链, 或改用本地文件上传后重试',
    '304080': 'file_info 无效/已过期: 重新上传文件再发(带 ttl)',
    '304064': '订阅消息未授权: 需用户先授权订阅',
  };
  const hit = table[c] ?? table[String(Number(c))];
  if (hit) return hit;
  // 有些错误不是数字码而是官方 message 文本(如"被动回复时间或次数超过限制") → 关键词兜底, 同样给下一步
  if (!/^\d+$/u.test(c)) {
    if (/被动|回复.*(超|限)/u.test(c)) {
      return `被动回复超限(同一条 msg_id 最多回 ~5 条 / 5 分钟窗口): 去掉 msg_id 改主动消息, 或隔 5 秒重试 · 原文: ${c}`;
    }
    if (/频|限流|太快|too\s*many/iu.test(c)) return `触发频控, 等 5～10 秒再试 · 原文: ${c}`;
    if (/过期|expire/iu.test(c)) return `引用的消息已过期(被动回复 5 分钟窗口): 改用主动消息 · 原文: ${c}`;
    if (/markdown|模板/iu.test(c)) return `Markdown 模板问题: 改用 type=text 纯文本最稳 · 原文: ${c}`;
  }
  return `调用失败(错误码 ${c}), 请稍后重试`;
}

/** per-appId token 缓存(带过期提前刷新与并发单飞) */
class TokenCache {
  private cache = new Map<string, { token: string; expireAt: number }>();
  private inflight = new Map<string, Promise<string>>();

  async get(appId: string, appSecret: string): Promise<string> {
    const hit = this.cache.get(appId);
    if (hit && Date.now() < hit.expireAt - 30_000) return hit.token;
    let p = this.inflight.get(appId);
    if (!p) {
      p = (async () => {
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: appSecret }),
        });
        const j = (await res.json()) as { access_token?: string; expires_in?: number; code?: number; message?: string };
        if (!j.access_token) {
          throw new Error(`getAppAccessToken 失败: ${j.code ?? res.status} ${j.message ?? ''}`);
        }
        this.cache.set(appId, { token: j.access_token, expireAt: Date.now() + (j.expires_in ?? 7200) * 1000 });
        return j.access_token;
      })().finally(() => this.inflight.delete(appId));
      this.inflight.set(appId, p);
    }
    return p;
  }
}

/** 本实例诊断日志(与 channel-tools 同款: 设 QQBOT_DIAG_FILE 才写) */
const DIAG = process.env.QQBOT_DIAG_FILE || '';
function diag(line: string): void {
  if (!DIAG) return;
  try { appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
}

export interface GroupAdminOptions {
  appId: string;
  appSecret: string;
  /** 非官方能力门控覆盖(测试/开放后置 true), 默认读 FEATURE_GATES */
  featureOverrides?: Record<string, boolean>;
  logDir?: string;
}

export class GroupAdminClient {
  private readonly tokens = new TokenCache();
  private readonly gates: Record<string, boolean>;

  constructor(private readonly opts: GroupAdminOptions) {
    this.gates = Object.fromEntries(
      Object.entries(FEATURE_GATES).map(([k, v]) => [k, opts.featureOverrides?.[k] ?? v.open]),
    );
  }

  private gate(name: string): { ok: false; err: { code: string; human: string } } | null {
    if (this.gates[name] !== false) return null;
    const g = FEATURE_GATES[name];
    return { ok: false, err: { code: 'FEATURE_NOT_OPEN', human: g?.human ?? '该能力官方尚未开放, 等待公测' } };
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
    const token = await this.tokens.get(this.opts.appId, this.opts.appSecret);
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { code?: number | string; message?: string; data?: unknown } & Record<string, unknown>;
    diag(`[group-admin] ${method} ${path} → ${res.status} code=${j.code ?? '-'} ${res.ok ? 'ok' : j.message ?? ''}`);
    if (res.ok && (j.code === undefined || j.code === 0)) {
      return { ok: true, data: (j.data ?? j) as T };
    }
    const code = String(j.code ?? res.status);
    return { ok: false, err: { code, human: mapErrHuman(code) } };
  }

  /**
   * 获取【单个】群成员信息 —— 重点是它返回 `username`（昵称）。
   *
   * ⚠️ 2026-10-05：官方文档对该接口标注「该能力正在内邀接入中，敬请期待」，
   *   错误码 11253 = 应用无接口访问权限（仅白名单机器人可用）。
   *   所以它只适合当**兜底**：调用方拿到 FEATURE_NOT_OPEN / 11253 就静默回落，别报错。
   *   一旦申请到权限，把 FEATURE_GATES.getMemberInfo.open 改 true 即自动生效。
   */
  /**
   * 【给自定义事件模块用】带 token 的**通用**官方 API 调用。
   *
   * 价值：框架负责 access_token 的获取与缓存（per-appId + 并发单飞）—— 这是模块自己做不到的
   *   （它拿不到 appSecret）。模块只管给 path，就能调任意官方接口：查成员、发消息、撤回、
   *   上传媒体、禁言、入群审批……
   *
   * @param method GET/POST/PATCH/DELETE
   * @param path   不含 host 的路径，形如 /v2/groups/{group_openid}/members/{member_openid}
   * @param body   可选 JSON body
   * @returns { ok:true, data } | { ok:false, err:{ code, human } }（human 已是人话）
   *
   * ⚠️ 2026-10-05：**不做**能力门控（FEATURE_GATES 是给"已知未开放"的主流程用的）；
   *   未开放的接口会走官方错误码（如 11253），调用方自己看 err.code 判定。
   *   path 也不做白名单（模块是主人自己写的代码，沙箱边界不在这一层）。
   */
  async apiCall(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<unknown>> {
    const p = String(path || '').trim();
    if (!p.startsWith('/')) {
      return { ok: false, err: { code: 'BAD_PATH', human: 'path 必须以 / 开头（不含 host），例如 /v2/groups/{gid}/members/{mid}' } };
    }
    return this.call<unknown>(method, p, body);
  }

  async getMemberInfo(gid: string, memberOpenid: string): Promise<ApiResult<MemberInfo>> {
    const blocked = this.gate('getMemberInfo')
    if (blocked) return blocked
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(memberOpenid)}`)
  }

  /** 获取群成员列表(🔴 未开放, 完整实现保留, 开放即用) */
  async listMembers(gid: string, cursor = ''): Promise<ApiResult<{ members: MemberInfo[]; next_cursor: string }>> {
    const blocked = this.gate('listMembers');
    if (blocked) return blocked;
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/members${q}`);
  }

  /** 批量移除成员(踢人, 🔴 未开放) */
  async removeMembers(
    gid: string,
    memberOpenids: string[],
    addToBlacklist = false,
  ): Promise<ApiResult<{ remove_members_result: string; add_to_member_blacklist_fail_openids: string[] }>> {
    const blocked = this.gate('removeMembers');
    if (blocked) return blocked;
    return this.call('POST', `/v2/groups/${encodeURIComponent(gid)}/batch_remove_members`, {
      member_openids: memberOpenids,
      add_to_member_blacklist: addToBlacklist,
    });
  }

  /** 入群申请列表(🟡 群管理员) */
  async listJoinRequests(gid: string, cursor = '', limit = 20): Promise<ApiResult<{ list: JoinRequest[]; next_cursor: string }>> {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (limit && limit !== 20) q.set('limit', String(limit));
    const qs = q.toString() ? `?${q}` : '';
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/join_request_list${qs}`);
  }

  /** 审批入群申请(🟡 群管理员; op: approve | decline) */
  async approveJoinRequest(
    gid: string,
    memberOpenid: string,
    op: 'approve' | 'decline',
    opts?: { join_request_id?: string; reject_reason?: string; add_to_blacklist?: boolean },
  ): Promise<ApiResult<Record<string, never>>> {
    return this.call('POST', `/v2/groups/${encodeURIComponent(gid)}/approval_join_request/${encodeURIComponent(memberOpenid)}`, {
      op,
      ...(opts?.join_request_id ? { join_request_id: opts.join_request_id } : {}),
      ...(op === 'decline' && opts?.reject_reason ? { reject_reason: opts.reject_reason } : {}),
      ...(opts?.add_to_blacklist ? { add_to_member_blacklist: true } : {}),
    });
  }

  /** 查询群禁言状态(🟡 群管理员) */
  async getMuteState(gid: string): Promise<ApiResult<MuteState>> {
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/restrict_chat_setting`);
  }

  /** 获取群基本信息(群名/人数等; 11255=群不存在或已注销, 用于注册表有效性校验与显示群名) */
  async getGroupInfo(gid: string): Promise<ApiResult<{
    group_openid?: string; group_name?: string; group_finger_memo?: string;
    group_class_text?: string; group_tags?: string[]; group_member_num?: number;
  }>> {
    return this.call('GET', `/v2/groups/${encodeURIComponent(gid)}/info`);
  }

  /**
   * 设置群成员禁言(🟡 群管理员; 单次≤20 人; 只能操作普通成员, 不能禁群主/管理员/机器人; 最长 30 天)
   * @param memberOpenid 目标成员
   * @param muteExpireAt RFC3339 到期时间(如 '2026-08-05T11:23:05+08:00'); 传 null = 立即解除禁言(del)
   */
  async setMemberMute(
    gid: string,
    memberOpenid: string | string[],
    muteExpireAt: string | null,
  ): Promise<ApiResult<Record<string, never>>> {
    // 2026-09-12: 支持**批量**(官方单次 ≤20 人) —— 一次 request 带多条 members, 避免 N 次调用
    const ids = (Array.isArray(memberOpenid) ? memberOpenid : [memberOpenid])
      .map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
    const members = ids.map((id) => (muteExpireAt
      ? { op: 'add', member_openid: id, mute_expire_at: muteExpireAt }
      : { op: 'del', member_openid: id, mute_expire_at: '' }));
    const url = `/v2/groups/${encodeURIComponent(gid)}/restrict_chat_setting`;
    // ⚠️ 2026-09-12 实测: **禁言(add)** 一次放多个成员会报 50015013(只传 1 个正常), 而**解除(del) 支持批量** ——
    // 官方文档写的是数组, 线上只吃单个 → add **逐条发**(≤20 次, 远低于 100 QPS), del 一次发完(见下)。
    if (ids.length === 0) return this.call('POST', url, { members: [] });
    if (!muteExpireAt) return this.call('POST', url, { members }); // del(解除): 支持一次多个, 直接发
    let last: ApiResult<Record<string, never>> = { ok: true, data: {} };
    for (let k = 0; k < ids.length; k++) {
      last = await this.call('POST', url, { members: members.slice(k, k + 1) });
      if (!last.ok) return last;
    }
    return last;
  }

  /**
   * 以机器人身份向群发送消息(面板"代发消息"用; 官方被动消息接口, 建议群内先有交互)。
   * 自动选通道: 内容含 QQ 交互标签 → markdown 通道(msg_type:2, QQ 端才会渲染成可点标签;
   *   实测 2026-09-06: 高亮 @ 格式 = `<@openid>`(无斜杠) 或 `<qqbot-at-user id="openid" />`;
   *   纯文本 msg_type:0 会原样显示标签); 否则纯文本(msg_type:0)。
   */
  async sendGroupText(gid: string, content: string): Promise<ApiResult<{ id?: string }>> {
    // ★★ 2026-11-14 修（审查发现）：原来只取'秒数 % 1e6' —— **同一秒内两次发送会拿到同一个 msg_seq**，
    //   官方按重复消息拒收/去重 ⇒ 丢消息（注释里自己写了'防同秒重复可加余数'却没实现）。
    //   现在用进程内单调递增计数器：同秒内 +1，跨秒以时间戳为基数，保证严格递增且不重复。
    const msgSeq = nextMsgSeq();
    const hasTag = /<@[A-Za-z0-9]+>|<qqbot-at-user|<qqbot-at-everyone|<qqbot-cmd-|<emoji:|<#/.test(content);
    const body: Record<string, unknown> = hasTag
      ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }
      : { content, msg_type: 0, msg_seq: msgSeq };
    return this.call('POST', `/v2/groups/${encodeURIComponent(gid)}/messages`, body);
  }

  /**
   * 向群发送自定义 markdown 卡片(带可选 keyboard 按钮)(2026-09-10 主人实测验证:
   * markdown 嵌网络图+按钮可渲染, 按钮 type:2 点击后 data 以指令消息回到群里)。
   * keyboard 结构: { content: { rows: [{ buttons: [{ id, render_data:{label,style}, action:{type,permission,data,enter} }] }] } }
   * 官方限制: 最多 5 行 × 每行 5 按钮 = 25 个; 超限报 40034029。
   * @returns 消息 id
   */
  async sendGroupCard(
    gid: string,
    markdown: string,
    keyboard?: Record<string, unknown>,
  ): Promise<ApiResult<{ id?: string }>> {
    const msgSeq = nextMsgSeq();   // ★ 与 sendGroupText 共用同一个生成器，避免两条路径撞号
    const body: Record<string, unknown> = { msg_type: 2, markdown: { content: markdown }, msg_seq: msgSeq };
    if (keyboard && keyboard.content) body.keyboard = keyboard;
    return this.call('POST', `/v2/groups/${encodeURIComponent(gid)}/messages`, body);
  }

  /** 以机器人身份向用户发私聊文本(c2c 主动消息; 同 sendGroupText 的通道选择逻辑) */
  async sendC2cText(userOpenid: string, content: string): Promise<ApiResult<{ id?: string }>> {
    const msgSeq = nextMsgSeq();   // ★ 与 sendGroupText 共用同一个生成器，避免两条路径撞号
    const hasTag = /<@[A-Za-z0-9]+>|<qqbot-at-user|<qqbot-at-everyone|<qqbot-cmd-|<emoji:|<#/.test(content);
    const body: Record<string, unknown> = hasTag
      ? { markdown: { content }, msg_type: 2, msg_seq: msgSeq }
      : { content, msg_type: 0, msg_seq: msgSeq };
    return this.call('POST', `/v2/users/${encodeURIComponent(userOpenid)}/messages`, body);
  }

  /**
   * 向私聊(c2c)发送 markdown 卡片 + 可选 keyboard(2026-09-10 主人要求卡片支持私聊)。
   * 官方 c2c 与群共用同一套 markdown/keyboard 结构, 仅 base path 不同。
   */
  async sendC2cCard(
    userOpenid: string,
    markdown: string,
    keyboard?: Record<string, unknown>,
  ): Promise<ApiResult<{ id?: string }>> {
    const msgSeq = nextMsgSeq();   // ★ 与 sendGroupText 共用同一个生成器，避免两条路径撞号
    const body: Record<string, unknown> = { msg_type: 2, markdown: { content: markdown }, msg_seq: msgSeq };
    if (keyboard && keyboard.content) body.keyboard = keyboard;
    return this.call('POST', `/v2/users/${encodeURIComponent(userOpenid)}/messages`, body);
  }

  /**
   * 撤回机器人自己发的消息(官方撤回窗口 2 分钟, 仅能撤自己发的)。
   * ⚠️ 2026-09-12 修(主人实测报 **11001**): 原实现打的是 `/v2/messages/{id}` —— **官方没有这个路径**,
   * 正确路径按场景分(官方文档已核对):
   *   群聊 DELETE `/v2/groups/{group_openid}/messages/{message_id}`
   *   单聊 DELETE `/v2/users/{user_openid}/messages/{message_id}`
   * @param peerId 群 openid(scope=group) 或 用户 openid(scope=c2c)
   * @param msgId  发送成功时返回的 message_id
   */
  async recallMessage(peerId: string, msgId: string, scope: 'group' | 'c2c' = 'group'): Promise<ApiResult<Record<string, unknown>>> {
    const base = scope === 'c2c' ? '/v2/users' : '/v2/groups';
    return this.call('DELETE', `${base}/${encodeURIComponent(peerId)}/messages/${encodeURIComponent(msgId)}`);
  }

}

/** 工厂: 每实例一个 client(配置来自各 bot config.appId/appSecret) */
export function createGroupAdmin(opts: GroupAdminOptions): GroupAdminClient {
  return new GroupAdminClient(opts);
}

/** 取本 bot 的群注册表路径(事件累积+绑群, UI 选群用) */
export function groupRegistryPath(cwd: string | undefined): string {
  return join(cwd || process.cwd(), '.qqbot', 'groups.json');
}

/**
 * msg_seq 生成器：进程内单调递增，避免同秒撞车。
 *
 * ★★ 2026-11-14（CodeRabbit 复审）：**不要取模** ——
 *   取模会让序号在 999999 之后回落，既可能被时间基超越、也可能和后续值重复，
 *   而"严格递增"正是官方对同一 msg_id 被动回复的要求。
 *   这里用 9 位时间基（约 11.5 天回绕一次），回绕瞬间靠 `+1` 追平后继续递增。
 */
let __msgSeq = 0;
function nextMsgSeq(): number {
  const base = Date.now() % 1_000_000_000;
  __msgSeq = base > __msgSeq ? base : __msgSeq + 1;
  return __msgSeq;
}
