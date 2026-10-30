/**
 * 模型切换卡片(2026-10-30)：`/model`、`/bot-model` 不带参数**或参数不是已存在的模型**时，
 * 发一张带按钮的卡片让主人点选，而不是回一行干巴巴的"用法: /xxx provider/model"。
 *
 * 结构完全照 `features/preset-switcher.ts`（主人要求"参考扩展命令/子会话"那套）：
 *   · 每行 2 个按钮、最多 4 行 = 8 个/页，第 5 行留给翻页导航（QQ 按钮最多 5 行）
 *   · 按钮 data = `mdl:<page>:<idx>`
 *   · interaction（INTERACTION_CREATE type=11）解析后直接调 manager.setModelOverride
 *
 * ⚠️ 为什么要做这个（主人原话）：
 *   「参数不对，指的是没有对应的模型，以前没输入错误参数也能"换模型"，但实际上 api 报错」
 *   —— 以前 `setModelOverride` 不校验模型存不存在，传个瞎写的 model 也回"✅ 已切换"，
 *   直到下一句话真的去调 API 才炸。现在改成：**校验不通过就发卡片**，让用户点真实的模型。
 */
import type { QQBotSender } from '../transport/outbound-buffer.js';
import type { SessionManager } from '../session/session-manager.js';
type ModelCardImpl = (target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string, page?: number) => Promise<string>;
export declare function setModelCardImpl(ns: string, impl: ModelCardImpl | undefined): void;
/** 命令层调用：发模型选择卡片 */
export declare function sendModelCard(ns: string, target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string, page?: number): Promise<string>;
/** 解析按钮 data：`mdl:<page>:<idx|prev|next>` */
export declare function parseModelButton(data: string | undefined): {
    page: number;
    idx: number;
} | 'prev' | 'next' | null;
export declare class ModelSwitcherController {
    private readonly manager;
    private readonly sender;
    private readonly logger;
    /** 主人白名单（config.groupAdmin.owners）。按钮点击也要校验 —— 卡片可能被转发给别人 */
    private readonly owners;
    constructor(manager: SessionManager, sender: QQBotSender, logger: {
        info?: (m: string) => void;
        warn?: (m: string) => void;
    }, 
    /** 主人白名单（config.groupAdmin.owners）。按钮点击也要校验 —— 卡片可能被转发给别人 */
    owners?: () => string[]);
    /** 点击者是否有权（白名单为空 ⇒ 放行到"提示去配置"那一步，与命令侧一致） */
    private clickerAllowed;
    /** 发模型选择卡片（某页）。返回给人看的摘要文本。 */
    sendCard(target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string, page?: number): Promise<string>;
    /** interaction 回调：`mdl:<page>:<idx|prev|next>`。@returns true=已消费 */
    handleInteraction(event: unknown, target: Parameters<QQBotSender['sendMarkdownWithKeyboard']>[0], scope: 'group' | 'c2c', peerId: string): Promise<boolean>;
}
export {};
//# sourceMappingURL=model-switcher.d.ts.map