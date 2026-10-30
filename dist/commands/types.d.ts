/**
 * 命令依赖类型
 *
 * 每个命令工厂函数接收 CommandDeps，由 commands/index.ts 统一注入。
 */
import type { SessionManager } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
export interface CommandDeps {
    manager: SessionManager;
    config: ImQQBotConfig;
    /** 2026-10-30：管理类命令的白名单拒绝要能留痕（真机上排查"为什么他被拒了"） */
    logger?: Logger;
}
//# sourceMappingURL=types.d.ts.map