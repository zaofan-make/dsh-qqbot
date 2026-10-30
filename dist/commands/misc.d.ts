/**
 * 杂项命令：/ping /version /stop
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { CommandDeps } from './types.js';
/** /bot-ping — 测试当前 dsh 与 QQ 连接的网络延迟(对齐上游 0.5.0) */
export declare function pingCommand(): SlashCommand;
/** /bot-version — 查看版本信息 */
export declare function versionCommand({ manager }: CommandDeps): SlashCommand;
/**
 * /bot-me — 查看**你自己在「这个机器人」视角下的 openid**（2026-10-30，对齐上游 96ad70a9）
 *
 * 为什么有用（主人原话）：
 *   「群友可以获取自己对于那个机器人的 openid，并在群聊里显示，以便告诉机器人的主人添加白名单」
 *
 * ⚠️ 关键认知：openid 是**按 appId 隔离**的 —— 同一个 QQ 号，对不同机器人实例的 openid **不同**。
 *   所以这里特意带上「机器人 AppID」，主人配白名单时就知道该填到哪个实例上。
 *
 * 不限制白名单：它只是查自己的 id，无害（和 /presets 同理）。
 */
export declare function meCommand({ config }: CommandDeps): SlashCommand;
/** /bot-stop — 中止当前生成（隐藏） */
export declare function stopCommand(): SlashCommand;
/** /tools-reload — 热刷新 QQ 通道工具与扩展命令(开发用, 2026-09-05): 新增工具即时生效, 无需重启宿主 */
export declare function toolsReloadCommand({ manager }: CommandDeps): SlashCommand;
//# sourceMappingURL=misc.d.ts.map