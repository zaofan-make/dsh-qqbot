import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
/**
 * 当前是否跑在 DSH 桌面版（Electron 外壳托管的 host）。
 *
 * 判据（任一命中即认定，宁严勿松——误判成 web 会导致孤儿 Host）：
 *  - argv 里出现 `dsh-desktop-host`（桌面版的 host 入口，见 issue #38 的进程表）
 *  - 环境变量带 Electron / 桌面标识（`ELECTRON_RUN_AS_NODE` 是 Electron 用 node 跑脚本时的标准标记）
 */
export declare function isDesktopHost(): boolean;
/** 桌面版统一回执（别只说"失败"，要把"为什么"和"怎么"讲清楚） */
export declare function desktopRefusalText(): string;
/**
 * 触发自重启: 生成独立重启助手并脱手运行(当前宿主被杀也能继续拉起新宿主)。
 * 桌面版直接返回 false（调用方负责给出 `desktopRefusalText()` 的说明）。
 */
export declare function selfRestart(delayMs?: number, killWaitMs?: number): boolean;
export declare function botRestartCommand(): SlashCommand;
/** /bot-exit 旧命令兼容: 同样走自重启(杀+拉一条龙)；桌面版同样拒绝 */
export declare function botExitCommand(): SlashCommand;
//# sourceMappingURL=exit.d.ts.map