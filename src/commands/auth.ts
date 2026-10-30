/**
 * auth.ts —— 管理类命令的**主人白名单**门控（2026-10-30）
 *
 * 主人要求（原话）：
 *   「/preset 和 /new 和 /bot-new、/bot-model、/model 这些只有白名单才能使用；
 *     /presets 不限制，因为 presets 是查看当前是什么人格的，无害。」
 *
 * 做法对齐上游 tencent-connect/dsh-qqbot 的 `0f050ec9 feat: allowlist-gated admin commands`
 * —— 给 SlashCommand 挂 `authorized` 回调（SDK 的 slash-command 中间件会调它），
 * 返回 `true` 放行、返回**字符串**表示拒绝并把这句话回给用户。
 *
 * 名单口径：`config.groupAdmin.owners`（就是审批卡片/踢人用的那份主人白名单），
 * 群聊里 sender 是 `member_openid`、私聊里是 `user_openid`，两边**不是同一个 id**，
 * 所以 owners 里通常要同时配两个（设置页「主人 openid」那一栏可以填多个）。
 *
 * ⚠️ 名单为空时：**拒绝并引导去配置**（2026-10-30 主人明确要求）。
 *   原话：「如果没有配置白名单，则那些命令会提醒用户去设置里配置」
 *   —— 不能默默放行（那样等于谁都能改模型/人格），也不能只回"无权限"（用户不知道去哪配）。
 *
 * ⚠️ **名单是 per 实例的**（同一 QQ 号对不同机器人 openid 不同）：
 *   `config` 就是本实例自己的配置（bootstrap 里 buildCommandList 传的是该实例的 config），
 *   所以每个机器人实例各有各的 owners —— 多实例部署时必须分别填，这是设计使然。
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';

const DENIED = '⚠️ 这个命令只有主人能用。';

/** 没配置白名单时的引导文案（要求用户去哪填） */
const NOT_CONFIGURED =
  '⚠️ 还没配置「允许操作的主人 openid」，所以这条管理命令暂时不能用。\n'
  + '① 先发 **/bot-me** 拿到你自己在本机器人下的 OpenID（直接复制那串）\n'
  + '② 到 **设置 → QQ 机器人 → 设置 → 群管理基础设置 →「允许操作的主人 openid」** 里填上'
  + '（多个用逗号分隔），保存后重试。\n'
  + '💡 每个机器人实例的 openid 不一样（同一个 QQ 号对不同 appId 的 openid 不同），'
  + '多实例要分别配置。';

/** 取主人白名单（去空、字符串化） */
export function ownerListOf(config: ImQQBotConfig | undefined): string[] {
  const raw = (config as { groupAdmin?: { owners?: unknown } } | undefined)?.groupAdmin?.owners;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * 构造 `authorized` 回调。
 * @param config 插件配置（读 groupAdmin.owners）
 * @param logger 拒绝时留痕（真机上排查"为什么他被拒了"）
 */
export function ownerOnlyAuth(
  config: ImQQBotConfig | undefined,
  logger?: Logger,
): (ctx: { message?: { senderId?: string } }) => boolean | string {
  return (ctx) => {
    const owners = ownerListOf(config);
    // 名单为空 ⇒ 没配过：拒绝 + 告诉用户去哪儿配（不默默放行，也不只丢一句"无权限"）
    if (owners.length === 0) {
      logger?.warn?.('[cmd-auth] 拒绝：主人白名单为空（groupAdmin.owners 未配置）');
      return NOT_CONFIGURED;
    }
    const sender = String(ctx?.message?.senderId ?? '').trim();
    if (!sender) {
      logger?.warn?.('[cmd-auth] 拒绝：拿不到 senderId（身份缺失，fail-closed）');
      return DENIED;
    }
    if (owners.includes(sender)) return true;
    logger?.warn?.(`[cmd-auth] 拒绝：sender=${sender.slice(0, 8)}… 不在主人白名单（${owners.length} 个）`);
    return DENIED;
  };
}

/** 给一个 SlashCommand 套上"仅主人"，返回新对象（不改原对象） */
export function withOwnerOnly<T extends SlashCommand>(cmd: T, config: ImQQBotConfig | undefined, logger?: Logger): T {
  return { ...cmd, authorized: ownerOnlyAuth(config, logger) } as T;
}
