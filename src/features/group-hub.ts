/**
 * group-hub.ts — 群组管理器(Group Hub, M2, 2026-09-09)
 *
 * 需求(主人拍板): dock 把某"会话"设为群组管理器 → 该机器人各群的群事件
 * (入群申请 / 新成员加入 / 机器人被拉群)汇总注入那一个会话, 主人一处看全部。
 *
 * 注入姿势(主人指正 + 底层考证, 见用户级记忆"agent 消息 API 语义"):
 *   - **LLM 回合进行中严禁 session.append** —— 会把 tool_calls↔tool 结果拆散/污染组包,
 *     聊天记录坏(历史事故 INVALID_REQUEST insufficient tool messages)。
 *   - 安全序列 = agent.whenIdle() 等回合空闲(空闲立即返回) → session.append('user/message',
 *     createUserMessage source.kind='user', {surfaceOp:'append'})(web 流可见、不唤醒、
 *     等效"用户发消息后点停止")。宿主 agent 无 whenIdle → 降级 agent.inject(回合安全, 不唤醒);
 *     两者都无/等超时 → 放弃并返回原因(不硬塞)。
 *
 * 事件源(gateway/bootstrap rawEvent 分发, 见 group-join-request.ts 的 GROUP_JOIN_REQUEST):
 *   - GROUP_JOIN_REQUEST(intent 1<<24, 需 watchJoinRequests 订阅) → group-join-request.ts 处理,
 *     本模块负责 hub 转发;
 *   - GROUP_MEMBER_ADD(同 intent 1<<24): 新成员入群 → 记成员台账 + hub;
 *   - GROUP_ADD_ROBOT(intent 1<<25, 基础订阅): 机器人被拉进群 → 记群台账 + hub。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import { dataRootOf } from '../gateway/data-root.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
import type { SessionManager } from '../session/index.js';
import { skipSilentAppend } from '../session/surface-guard.js';
import { appendGroupMember, appendLedger } from './chat-ledger.js';

/** 等待回合空闲的最长时间(宿主 whenIdle 正常秒回; 超时按 busy 放弃, 防止事件处理挂起) */
const IDLE_WAIT_MS = 8_000;

export interface HubNotice {
  /** 事件类型(文案前缀/分类用) */
  kind: 'join_request' | 'member_add' | 'add_robot';
  /** 群 openid */
  gid: string;
  /** 群内成员/操作者 openid(有则给) */
  memberOpenid?: string;
  /** 昵称(join_request 有 username; member_add 事件不带) */
  name?: string;
  /** 额外说明(申请来源/验证/风险等) */
  extra?: string;
}

function tail(id: string | undefined, n = 6): string {
  return id && id.length > n ? '…' + id.slice(-n) : (id ?? '');
}

/**
 * 回合安全地把一条"模拟用户消息"append 进目标会话(web 流可见、不唤醒、不坏记录)。
 * 优先级: ①agent.whenIdle() 空闲后 session.append; ②无 whenIdle 时 agent.inject(宿主回合安全)。
 * @returns 'ok' | 'no-agent' | 'no-append' | 'busy' | 'fail'
 */
export async function safeAppendUserMessage(
  agent: unknown,
  text: string,
  logger: Logger,
): Promise<'ok' | 'no-agent' | 'no-append' | 'busy' | 'fail'> {
  if (!agent) return 'no-agent';
  const a = agent as {
    whenIdle?: () => Promise<void>;
    inject?: (m: unknown) => void;
    session?: { append?: (type: string, data: unknown, opts?: { surfaceOp?: string }) => unknown };
  };
  let msg: unknown;
  try {
    msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
  } catch {
    return 'fail';
  }
  // ① 等回合空闲再 append(主人硬约束: 回合中 append 坏记录)
  // ★ 2026-10-06: 人设未落盘的会话【不能】静默 append（会报废整份会话日志，见
  //   session/surface-guard.ts）。跳过时自然落到下面 ② 的宿主 inject 排队路径 ——
  //   那是回合内安全的，而且不唤醒。
  if (a.session && typeof a.session.append === 'function' && !skipSilentAppend(a, logger, 'group-hub')) {
    if (typeof a.whenIdle === 'function') {
      let idle = false;
      try {
        await Promise.race([
          a.whenIdle().then(() => { idle = true; }),
          new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS)),
        ]);
      } catch { /* whenIdle 异常按未空闲处理 */ }
      if (!idle) {
        // 回合未在等待窗口内空闲: 降级宿主 inject 排队(回合安全, 不唤醒), 而不是放弃丢消息。
        // inject = send(msg,'next-step',wakeup:false) → 排队到下一次 pre-step 组包, 不拆 tool_calls。
        logger.warn?.('[group-hub] 回合未空闲, 降级 inject 排队(避免坏记录且不丢消息)');
        if (typeof a.inject === 'function') {
          try {
            a.inject(msg);
            return 'ok';
          } catch (err) {
            logger.warn?.(`[group-hub] inject 兜底失败: ${err instanceof Error ? err.message : String(err)}`);
            return 'fail';
          }
        }
        return 'busy';
      }
    }
    try {
      a.session.append('user/message', msg, { surfaceOp: 'append' });
      return 'ok';
    } catch (err) {
      logger.warn?.(`[group-hub] session.append 失败: ${err instanceof Error ? err.message : String(err)}`);
      return 'fail';
    }
  }
  // ② 宿主回合安全注入(无 session.append 能力时)
  if (typeof a.inject === 'function') {
    try {
      a.inject(msg);
      return 'ok';
    } catch { return 'fail'; }
  }
  return 'no-append';
}

/**
 * 群事件 → 群组管理器会话(hub)注入。hubSessionId 空/hubNotify=false → 'no-hub'。
 * 会话寻址: manager.findBySessionId(hubSessionId)(宿主 QQ 会话 record, fork 后仍为当前 id)。
 * @returns 'ok' | 'no-hub' | 'no-session' | 其它见 safeAppendUserMessage
 */
export async function notifyGroupHub(
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
  ev: HubNotice,
): Promise<string> {
  const ga = config.groupAdmin;
  if (!ga?.hubNotify || !ga.hubSessionId) return 'no-hub';
  try {
    const lines = [`【群管·${ev.kind === 'join_request' ? '入群申请' : ev.kind === 'member_add' ? '新成员入群' : '机器人被拉入群'}】群 ${ev.gid}`];
    if (ev.kind === 'join_request') {
      lines.push(`申请人: ${ev.name ?? '(未知昵称)'}(${tail(ev.memberOpenid)})`);
      if (ev.extra) lines.push(ev.extra);
      lines.push('可回复我处理(如: 查看入群申请 / 通过 / 拒绝)');
    } else if (ev.kind === 'member_add') {
      lines.push(`新成员 openid: ${ev.memberOpenid ?? '(未知)'}${ev.extra ? ' · ' + ev.extra : ''}`);
    } else {
      lines.push(`操作者: ${tail(ev.memberOpenid)}${ev.extra ? ' · ' + ev.extra : ''}`);
      lines.push('群台账已自动登记, 之后该群消息会持续累积。');
    }
    const text = lines.join('\n');
    // ① 本插件 QQ 会话表(宿主 QQ 会话 record)
    const rec = manager.findBySessionId(ga.hubSessionId);
    if (rec) {
      const r = await safeAppendUserMessage(rec.agent, text, logger);
      logger.info(`[group-hub] ${ev.kind} → hub(${ga.hubSessionId.slice(0, 8)}…) ${r}`);
      return r;
    }
    // ② 宿主全局 registry(web/hub 非 QQ 会话) —— 2026-09-11 修复:
    //    之前只走 findBySessionId, hub 会话若在 QQ 会话表"未创建"则注入失败,
    //    事件驱动(GROUP_JOIN_REQUEST)就会 fallback 到"申请所在群群内提醒",
    //    导致「普通群」的 web 会话也收到【入群申请】(主人实测不一致)。
    //    与 wakeSessionAgent 同款三级 fallback: hub 注入成功即不再打扰普通群。
    const host = manager.findHostAgent(ga.hubSessionId);
    if (host) {
      const r = await safeAppendUserMessage(host.agent, text, logger);
      logger.info(`[group-hub] ${ev.kind} → hub-host(${ga.hubSessionId.slice(0, 8)}…) ${r}`);
      return r;
    }
    const resumed = await manager.resumeHostAgent(ga.hubSessionId);
    if (resumed) {
      const r = await safeAppendUserMessage(resumed.agent, text, logger);
      logger.info(`[group-hub] ${ev.kind} → hub-resumed(${ga.hubSessionId.slice(0, 8)}…) ${r}`);
      return r;
    }
    logger.warn?.(`[group-hub] hub 会话未找到且无法恢复: ${ga.hubSessionId.slice(0, 8)}…(该会话可能已重建/换绑, 请在 dock 重新设置)`);
    return 'no-session';
  } catch (err) {
    logger.warn?.(`[group-hub] 转发异常: ${err instanceof Error ? err.message : String(err)}`);
    return 'fail';
  }
}

/**
 * 判断某 scope/peer 是否就是群组管理器(hub)会话绑定的目标(2026-09-11):
 * 事件/poll 通知申请所在群前调用——申请群即 hub 群时, hub 注记已覆盖,
 * 再对同一会话 notifyGroup/wakeGroup 就是重复。返回 true=应跳过。
 */
export async function isHubPeerOf(
  manager: SessionManager,
  config: ImQQBotConfig,
  scope: 'group' | 'c2c',
  peerId: string,
): Promise<boolean> {
  const hubId = config.groupAdmin?.hubSessionId?.trim();
  if (!hubId || scope !== 'group') return false;
  try {
    // ① QQ 会话表: hub record 的 peer 就是申请群
    const hubRec = manager.findBySessionId(hubId);
    if (hubRec && hubRec.scope === 'group' && hubRec.peerId === peerId) return true;
    // ② 确定性派生: 申请群的 sessionId 就是 hub 会话 id(如 8DBA 群 ↔ hub 65279bec 同源)
    if (manager.sessionIdFor('group', peerId) === hubId) return true;
  } catch { /* 判定失败默认 false(保守: 宁可有提示不静默丢) */ }
  return false;
}

/**
 * 唤醒指定会话的 LLM: 把 text 作为"用户消息" followup 给该会话的 agent,
 * AI 开回合即可主动处理。可用于 hub 轮询唤醒, 也可跨会话发送+唤醒(工具用)。
 * @returns 'ok' | 'no-session' | 'no-followup' | 'fail'
 */
export async function wakeSessionAgent(
  manager: SessionManager,
  sessionId: string,
  logger: Logger,
  text: string,
): Promise<string> {
  if (!sessionId) return 'no-session';
  try {
    let msg: unknown;
    try {
      msg = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
    } catch {
      return 'no-followup';
    }
    // ① 本插件会话表(QQ 会话): 走完整语义(lastInboundAt/turnActive + followup)
    const rec = manager.findBySessionId(sessionId);
    if (rec) {
      const a = rec.agent as { followup?: (m: unknown) => void };
      if (typeof a.followup !== 'function') return 'no-followup';
      // 与 QQ 入站唤醒同语义(inbound.ts L203-206): 置回合活跃(消息聚合见忙攒消息) + followup 唤醒
      rec.lastInboundAt = Date.now();
      (rec as { turnActive?: boolean }).turnActive = true;
      a.followup(msg);
      logger.info(`[group-hub] 唤醒 agent(${sessionId.slice(0, 8)}…) ok`);
      return 'ok';
    }
    // ② 宿主全局 registry(web/hub 等非 QQ 会话): 进程内活 agent → 直接 followup
    const host = manager.findHostAgent(sessionId);
    if (host) {
      const a = host.agent as { followup?: (m: unknown) => void };
      if (typeof a.followup !== 'function') return 'no-followup';
      a.followup(msg);
      logger.info(`[group-hub] 唤醒宿主 agent(${sessionId.slice(0, 8)}…) ok`);
      return 'ok';
    }
    // ③ 宿主持久化恢复(重启后唤起): 会话持久化在宿主, resume 拉回内存再 followup
    //    —— 与入站 getOrCreate 的 resume 路径同源: 重启后第一条消息就是这么唤起对话的
    const resumed = await manager.resumeHostAgent(sessionId);
    if (resumed) {
      const a = resumed.agent as { followup?: (m: unknown) => void };
      if (typeof a.followup !== 'function') return 'no-followup';
      a.followup(msg);
      logger.info(`[group-hub] resume+唤醒 agent(${sessionId.slice(0, 8)}…) ok`);
      return 'ok';
    }
    logger.warn?.(`[group-hub] 会话未找到且无法恢复(唤醒): ${sessionId.slice(0, 8)}…`);
    return 'no-session';
  } catch (err) {
    logger.warn?.(`[group-hub] 唤醒异常: ${err instanceof Error ? err.message : String(err)}`);
    return 'fail';
  }
}

/**
 * 唤醒群组管理器会话的 LLM(轮询用): 把待审批摘要 followup 给 hub 会话的 agent,
 * AI 开回合即可主动处理(查列表/按主人指令批拒)。不依赖普通群会话。
 * @returns 'ok' | 'no-hub' | 'no-session' | 'no-followup'
 */
export async function wakeHubAgent(
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
  text: string,
): Promise<string> {
  const ga = config.groupAdmin;
  if (!ga?.hubSessionId) return 'no-hub';
  return wakeSessionAgent(manager, ga.hubSessionId, logger, text);
}

/** GROUP_MEMBER_ADD: 新成员入群 → 记成员台账(事件无 username, 只落 openid)+ hub 通知 */
export async function handleGroupMemberAddEvent(
  data: unknown,
  opts: { config: ImQQBotConfig; logger: Logger; manager: SessionManager },
): Promise<boolean> {
  const { config, logger, manager } = opts;
  const ev = (data ?? {}) as { group_openid?: string; member_openid?: string; user_openid?: string; timestamp?: number };
  const gid = ev.group_openid;
  const mid = ev.member_openid;
  if (!gid || !mid) {
    logger.warn?.(`[group-hub] member_add 事件缺字段: ${JSON.stringify(ev).slice(0, 200)}`);
    return false;
  }
  // 本地成员兜底名单与群消息同源: 记一条(名字留空, 之后群内发言会补上)
  try {
    const dataDir = joinDataDir(config);
    appendGroupMember(dataDir, { ts: Date.now(), gid, mid, name: undefined });
  } catch { /* 台账失败不阻断 */ }
  // ★ 2026-11-17：用官方 `GET /v2/users/{openid}/info` 补一次名字。
  //   官方成员列表（listMembers）还在内邀中，所以以前一个人必须**在群里发过言**
  //   才会有名字；这个新接口只要 openid 就能查 username，于是入群即可补全。
  //   之后他若改名，**发一次言台账就会更新**（读端后者覆盖前者），不用再管。
  try {
    const ga = manager.groupAdmin;
    if (ga) {
      // ★ 2026-11-17 CodeRabbit：加**有界等待**。
      //   `GroupAdminClient.call` 里的 fetch 没设 signal/超时，官方接口要是迟迟不回，
      //   这里会把入群通知一起拖住（补名字只是附加信息，不该阻塞主链）。
      //   3 秒拿不到就当没有，通知照常发。
      const r = await Promise.race([
        ga.getUserInfo(mid),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
      ]);
      if (r === undefined) {
        logger.debug?.(`[group-hub] member_add 查名字超时(3s)，跳过: ${mid}`);
      }
      const nm = r && r.ok === true ? String((r.data as { username?: string })?.username ?? '').trim() : '';
      if (nm) {
        appendGroupMember(joinDataDir(config), { ts: Date.now(), gid, mid, name: nm });
        logger.debug?.(`[group-hub] member_add 补名字: ${mid} → ${nm}`);
      } else if (r !== undefined) {
        logger.debug?.(`[group-hub] member_add 查名字无结果: ${mid} :: ${JSON.stringify((r as { err?: unknown })?.err ?? '').slice(0, 160)}`);
      }
    }
  } catch (e) {
    // 查名字失败不影响入群流程（台账里仍有 openid）
    logger.debug?.(`[group-hub] member_add 查名字异常: ${e instanceof Error ? e.message : String(e)}`);
  }
  await notifyGroupHub(manager, config, logger, {
    kind: 'member_add',
    gid,
    memberOpenid: mid,
    extra: ev.user_openid ? `user_openid ${ev.user_openid}` : undefined,
  });
  return true;
}

/** GROUP_ADD_ROBOT: 机器人被拉进新群 → 记群台账(known-chats group 首见)+ hub 通知 */
export async function handleGroupAddRobotEvent(
  data: unknown,
  opts: { config: ImQQBotConfig; logger: Logger; manager: SessionManager },
): Promise<boolean> {
  const { config, logger, manager } = opts;
  const ev = (data ?? {}) as { group_openid?: string; op_member_openid?: string; timestamp?: number };
  const gid = ev.group_openid;
  if (!gid) {
    logger.warn?.(`[group-hub] add_robot 事件缺 group_openid: ${JSON.stringify(ev).slice(0, 200)}`);
    return false;
  }
  try {
    const dataDir = joinDataDir(config);
    appendLedger(dataDir, { ts: Date.now(), scope: 'group', id: gid, name: undefined });
  } catch { /* 台账失败不阻断 */ }
  await notifyGroupHub(manager, config, logger, {
    kind: 'add_robot',
    gid,
    memberOpenid: ev.op_member_openid,
  });
  return true;
}

/** 与 chat-ledger 同 dataDir(表情包目录)的取法: **dataRootOf(config)** + 表情包
 *  ⚠️ 2026-09-12 补漏: 原来写的是 `config.dataRoot || config.cwd` —— 未配 dataRoot 的实例会落到工作目录,
 *  而且不会走新的默认数据根(`{cwd}/dshqqbot`), 与其它模块分裂成两份台账。 */
export function joinDataDir(config: ImQQBotConfig): string {
  return join(dataRootOf(config), '表情包');
}
