/**
 * 预设切换卡片(2026-09-10): /preset 无参时发一张带按钮的卡片,
 * 每个可选人格一个按钮, 点击即热切换(宿主 agentPresets.recompose)。
 *
 * 交互设计仿 botplay 目录卡翻页(参考 features/botplay.ts catalogKeyboard):
 *   - 每行 2 个按钮, 最多 4 行 = 8 个/页, 第 5 行留翻页导航(◀上一页/下一页▶);
 *   - 按钮 data = `ps:<page>:<idx>`(page=页码, idx=该页内序号);
 *   - interaction 回调(INTERACTION_CREATE type=11)解析后直接调 manager.switchPreset。
 */
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/session-manager.js';
type PresetCardImpl = (target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string, page?: number) => Promise<string>;
/** bootstrap 接线: 注入真实实现(按实例 ns) */
export declare function setPresetCardImpl(ns: string, impl: PresetCardImpl | undefined): void;
/** 命令层调用: 发预设选择卡片(带当前实例 ns) */
export declare function sendPresetCard(ns: string, target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string, page?: number): Promise<string>;
/**
 * 解析 preset 按钮数据: `ps:<page>:<idx>` → {page, idx}; 非本卡片按钮返回 null。
 * prev/next 为翻页导航(同前缀, idx 用字符串区分)。
 */
export declare function parsePresetButton(data: string | undefined): {
    page: number;
    idx: number;
} | 'prev' | 'next' | null;
export declare class PresetSwitcherController {
    private readonly manager;
    private readonly sender;
    private readonly logger;
    /**
     * 主人白名单（config.groupAdmin.owners）。
     *
     * ★ 2026-10-30 补（主人小号实测报的洞）：
     *   「我怎么点击切换人格，照样生效了，人格卡片发出来，点击按钮没有做 openid 校验」
     *   —— 以前只有 model 卡片校验了点击者，preset 卡片**谁点都算**，
     *   于是群里任何人（哪怕只是转发的卡）都能把主人切好的人格再切回去。
     *   切人格 = 改 AI 行为，属于管理动作，同样只能白名单点。
     */
    private readonly owners;
    constructor(manager: SessionManager, sender: QQBotSender, logger: {
        info?: (m: string) => void;
        warn?: (m: string) => void;
    }, 
    /**
     * 主人白名单（config.groupAdmin.owners）。
     *
     * ★ 2026-10-30 补（主人小号实测报的洞）：
     *   「我怎么点击切换人格，照样生效了，人格卡片发出来，点击按钮没有做 openid 校验」
     *   —— 以前只有 model 卡片校验了点击者，preset 卡片**谁点都算**，
     *   于是群里任何人（哪怕只是转发的卡）都能把主人切好的人格再切回去。
     *   切人格 = 改 AI 行为，属于管理动作，同样只能白名单点。
     */
    owners?: () => string[]);
    /** 点击者是否有权（名单为空 ⇒ 交给命令侧那套"去配置"提示，这里不额外拦） */
    private clickerAllowed;
    /** 发预设选择卡片(某页)。返回给人看的摘要文本(命令 handler 用)。 */
    sendCard(target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string, page?: number): Promise<string>;
    /** interaction 回调: 解析 ps:<page>:<idx|prev|next> → 切换或翻页。@returns true=已消费 */
    handleInteraction(event: unknown, target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string): Promise<boolean>;
}
export {};
//# sourceMappingURL=preset-switcher.d.ts.map