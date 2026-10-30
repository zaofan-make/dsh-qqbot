/**
 * 会话相关命令：/bot-reset /bot-clear /bot-new
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { CommandDeps } from './types.js';
/** /bot-reset /bot-clear — 重置当前会话 */
export declare function resetCommand({ manager }: CommandDeps): SlashCommand;
/** /bot-new — 开启新会话(真 fork: 旧会话存档可回看, 本会话开新档; 2026-09-08 修假实现)
 *  2026-09-11 补: 会话损坏(历史加载失败)导致无活跃记录时, 不再回「无需开新」,
 *  而是轮换 sessionId 直接另起新档 —— 主人可在 QQ 上弃掉炸掉的档重开。 */
export declare function newCommand({ manager }: CommandDeps): SlashCommand;
/** /new <preset> — 按会话切换 agent preset(2026-09-08, 学 DLive 社区版; fork 开新档用指定人格) */
export declare function newPresetCommand({ manager, config, logger }: CommandDeps): SlashCommand;
/** /preset <id> — 热切换当前会话的人格(preset), 不丢对话历史(2026-09-10) */
export declare function presetSwitchCommand({ manager, config }: CommandDeps): SlashCommand;
/** /presets — 列出全部可用 agent preset(2026-09-08, 配合 /new 切人格) */
export declare function presetsCommand({ manager }: CommandDeps): SlashCommand;
//# sourceMappingURL=session.d.ts.map