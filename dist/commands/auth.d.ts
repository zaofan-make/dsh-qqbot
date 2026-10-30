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
 * ⚠️ 名单为空时的取舍：**放行**（fail-open）。
 *   理由：空名单意味着「主人从没配过」，此时若一律拒绝，主人自己也会被锁在外面，
 *   等于把插件做成砖头。真正的安全边界由「谁能让机器人进群 + @ 它」提供。
 *   想严格封闭就在设置里把主人 openid 填上（填了之后立即 fail-closed）。
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
/** 取主人白名单（去空、字符串化） */
export declare function ownerListOf(config: ImQQBotConfig | undefined): string[];
/**
 * 构造 `authorized` 回调。
 * @param config 插件配置（读 groupAdmin.owners）
 * @param logger 拒绝时留痕（真机上排查"为什么他被拒了"）
 */
export declare function ownerOnlyAuth(config: ImQQBotConfig | undefined, logger?: Logger): (ctx: {
    message?: {
        senderId?: string;
    };
}) => boolean | string;
/** 给一个 SlashCommand 套上"仅主人"，返回新对象（不改原对象） */
export declare function withOwnerOnly<T extends SlashCommand>(cmd: T, config: ImQQBotConfig | undefined, logger?: Logger): T;
//# sourceMappingURL=auth.d.ts.map