import { resetCommand, newCommand, newPresetCommand, presetSwitchCommand, presetsCommand } from './session.js';
import { modelCommand, modelAliasCommand } from './model.js';
import { statusCommand } from './status.js';
import { helpCommand } from './help.js';
import { pingCommand, versionCommand, stopCommand, toolsReloadCommand } from './misc.js';
import { outModeCommand } from './outmode.js';
import { answerCommand, answerAliasCommand } from './answer.js';
import { permissionCommand } from './permission.js';
import { botplayCommand } from './botplay.js';
import { injectCommand } from './inject.js';
import { botRestartCommand, botExitCommand } from './exit.js';
import { withOwnerOnly } from './auth.js';
/**
 * 构建标准命令列表
 */
export function buildCommandList(deps) {
    const commands = [
        // 会话
        resetCommand(deps),
        // ── 管理类命令：仅主人白名单（2026-10-30，对齐上游 0f050ec9）──────────
        //   /bot-new、/new、/preset、/bot-model、/model 都会改会话/人格/模型，
        //   等于改「AI 的人格与开销」，不能让群里任何人都能按。
        //   ⚠️ /presets 刻意**不限制**：它只是列出有哪些人格，无害（主人原话）。
        withOwnerOnly(newCommand(deps), deps.config, deps.logger),
        // 人格(preset): /preset <id> 热切换不丢历史, /new <id> 开新档, /presets 查看可用(2026-09-08/10)
        withOwnerOnly(newPresetCommand(deps), deps.config, deps.logger),
        withOwnerOnly(presetSwitchCommand(deps), deps.config, deps.logger),
        presetsCommand(deps), // 查看当前有哪些人格 —— 无害，放行
        // 模型
        withOwnerOnly(modelCommand(deps), deps.config, deps.logger),
        withOwnerOnly(modelAliasCommand(deps), deps.config, deps.logger), // /model 简写
        // 状态
        statusCommand(deps),
        // 出站模式(逃生通道: SDK 直通不经 LLM, nothink 也能唤醒)
        outModeCommand(deps),
        // 权限档位切换(宿主 permissionPresets)
        permissionCommand(deps),
        // 提问兜底(2026-09-11): /答 A 或 /ans A —— 提问卡片的文字回答通道
        // (必须带斜杠: 群聊裸文字被 @门控拦、私聊被 debounce 聚合层直接吞进 agent)
        answerCommand(deps),
        answerAliasCommand(deps),
        // botplay 互动事件(/botplay 列表/触发发卡)
        botplayCommand(deps),
        // 安全注入: /inject 文本 → 插入当前会话 LLM 回合(不打断当前回合)
        injectCommand(deps),
        // 自重启(杀旧+自动拉起 dsh web; /bot-exit 兼容同款)
        botRestartCommand(),
        botExitCommand(),
        // 杂项
        pingCommand(),
        versionCommand(deps),
        stopCommand(),
        // 开发: 工具热刷新
        toolsReloadCommand(deps),
    ];
    // help 需要访问完整列表（含自身），通过闭包惰性引用
    commands.push(helpCommand(deps, () => commands));
    return commands;
}
//# sourceMappingURL=index.js.map