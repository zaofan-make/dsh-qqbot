/** 按钮回调数据前缀 */
const BTN_PREFIX = 'mdl:';
/**
 * 布局照 `/子会话` 的模型选择卡（主人 2026-10-30 指定参考）：
 *   每行 **5 个**，最多 **4 行**选项（=20 个/页），第 5 行留给翻页导航；
 *   按钮上显示**字母**（A/B/C…），列表正文里 `**A**. 模型名` 一一对应。
 *   这样一页能塞下 20 个模型，比原先每行 2 个省一半翻页。
 */
const MAX_ROWS = 4;
const COLS = 5;
const PER_PAGE = MAX_ROWS * COLS;
/** 按钮字母（与正文列表对应） */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'];
/** 按 ns 注册（多实例：不能只用模块级单例，否则实例间互相覆盖 —— preset-switcher 踩过） */
const modelCardImpls = new Map();
export function setModelCardImpl(ns, impl) {
    if (impl)
        modelCardImpls.set(ns, impl);
    else
        modelCardImpls.delete(ns);
}
/** 命令层调用：发模型选择卡片 */
export async function sendModelCard(ns, target, scope, peerId, page = 0) {
    const impl = modelCardImpls.get(ns);
    if (!impl) {
        if (modelCardImpls.size === 1)
            return modelCardImpls.values().next().value(target, scope, peerId, page);
        return '模型选择卡片未就绪（宿主未接线），可用 /model 手动指定 provider/model';
    }
    return impl(target, scope, peerId, page);
}
/** 解析按钮 data：`mdl:<page>:<idx|prev|next>` */
export function parseModelButton(data) {
    if (!data || !data.startsWith(BTN_PREFIX))
        return null;
    const parts = data.slice(BTN_PREFIX.length).split(':');
    if (parts.length !== 2)
        return null;
    const page = Number(parts[0]);
    if (!Number.isInteger(page) || page < 0)
        return null;
    const [, key] = parts;
    if (key === 'prev' || key === 'next')
        return key;
    const idx = Number(key);
    return Number.isInteger(idx) && idx >= 0 ? { page, idx } : null;
}
function pageOfData(data) {
    if (!data || !data.startsWith(BTN_PREFIX))
        return 0;
    const page = Number(data.slice(BTN_PREFIX.length).split(':')[0]);
    return Number.isInteger(page) && page >= 0 ? page : 0;
}
/** 构造键盘（每行 2 个 + 翻页行） */
function modelKeyboard(page, models, current) {
    const pages = Math.max(1, Math.ceil(models.length / PER_PAGE));
    const safePage = Math.min(page, pages - 1);
    const start = safePage * PER_PAGE;
    const shown = models.slice(start, start + PER_PAGE);
    const btn = (label, key, style) => ({
        id: `${BTN_PREFIX}${safePage}:${key}`,
        render_data: {
            label: String(label).slice(0, 24),
            visited_label: String(label).slice(0, 24),
            style,
        },
        action: {
            type: 1,
            // ⚠️ 2026-10-30：模型切换是管理动作 ⇒ 按钮只对**指定用户**可见可点
            //   （permission.type=2 表示"仅指定用户"；这里仍按群里所有人都能看见渲染，
            //     真正的门控在命令侧 authorized + 下面 handleInteraction 里的白名单校验）
            permission: { type: 2 },
            data: `${BTN_PREFIX}${safePage}:${key}`,
            unsupport_tips: '请直接回复 /model provider/model',
        },
    });
    const rows = [];
    for (let i = 0; i < shown.length && rows.length < MAX_ROWS; i += COLS) {
        rows.push({
            buttons: shown.slice(i, i + COLS).map((m, j) => {
                const isCur = !!current && current.provider === m.provider && current.model === m.id;
                // 按钮文字用字母（模型名太长会挤成省略号，正文里有对照表）
                return btn(LETTERS[i + j] ?? String(i + j), String(i + j), isCur ? 1 : 0);
            }),
        });
    }
    const nav = [];
    if (safePage > 0)
        nav.push(btn('◀ 上一页', 'prev', 0));
    if (safePage < pages - 1)
        nav.push(btn('下一页 ▶', 'next', 0));
    if (nav.length)
        rows.push({ buttons: nav });
    return { content: { rows } };
}
export class ModelSwitcherController {
    manager;
    sender;
    logger;
    constructor(manager, sender, logger) {
        this.manager = manager;
        this.sender = sender;
        this.logger = logger;
    }
    /** 发模型选择卡片（某页）。返回给人看的摘要文本。 */
    async sendCard(target, scope, peerId, page = 0) {
        const current = this.manager.getEffectiveModel(scope, peerId);
        const all = await this.manager.listAvailableModels();
        // 与 /model 原逻辑一致：只列当前 provider 的模型（点按钮只传模型名，provider 继承当前路由）
        const models = current?.provider ? all.filter((m) => m.provider === current.provider) : all;
        if (models.length === 0)
            return '宿主没提供可用模型列表，请用 /bot-model provider/model 手动指定';
        const pages = Math.max(1, Math.ceil(models.length / PER_PAGE));
        const safePage = Math.min(Math.max(0, page), pages - 1);
        const start = safePage * PER_PAGE;
        const shown = models.slice(start, start + PER_PAGE);
        const curLabel = (() => {
            if (!current)
                return '宿主默认配置';
            const hit = models.find((m) => m.provider === current.provider && m.id === current.model);
            return hit?.name ?? `${current.provider}/${current.model}`;
        })();
        const lines = [
            '### 🤖 切换模型',
            '',
            `**当前:** ${curLabel}`,
            '',
            ...shown.map((m, i) => {
                const isCur = !!current && current.provider === m.provider && current.model === m.id;
                return `**${LETTERS[i] ?? i + 1}**. ${m.name || `${m.provider}/${m.id}`}${isCur ? ' ⭐' : ''}`;
            }),
            '',
            pages > 1 ? `第 ${safePage + 1}/${pages} 页 · 点按钮立即切换（共 ${models.length} 个）` : `点按钮立即切换（共 ${models.length} 个）`,
            '',
            '⚠️ 刚才的参数没匹配到任何已存在的模型，避免切到一个会报错的 id，所以改发这张卡。',
        ];
        try {
            await this.sender.sendMarkdownWithKeyboard(target, lines.join('\n'), modelKeyboard(safePage, models, current));
            return `✅ 已发出模型切换卡片（第 ${safePage + 1}/${pages} 页）`;
        }
        catch (err) {
            this.logger.warn?.(`[model-switcher] 卡片发送失败: ${err instanceof Error ? err.message : String(err)}`);
            return '⚠️ 卡片发送失败，请直接用 /bot-model provider/model 指定';
        }
    }
    /** interaction 回调：`mdl:<page>:<idx|prev|next>`。@returns true=已消费 */
    async handleInteraction(event, target, scope, peerId) {
        const e = event;
        if (e?.data?.type !== 11)
            return false;
        const parsed = parseModelButton(e.data.resolved?.button_data);
        if (parsed === null)
            return false;
        try {
            const current = this.manager.getEffectiveModel(scope, peerId);
            const all = await this.manager.listAvailableModels();
            const models = current?.provider ? all.filter((m) => m.provider === current.provider) : all;
            const pages = Math.max(1, Math.ceil(models.length / PER_PAGE));
            if (parsed === 'prev') {
                await this.sendCard(target, scope, peerId, Math.max(0, pageOfData(e.data.resolved?.button_data) - 1));
                return true;
            }
            if (parsed === 'next') {
                await this.sendCard(target, scope, peerId, Math.min(pageOfData(e.data.resolved?.button_data) + 1, pages - 1));
                return true;
            }
            const pick = models[parsed.page * PER_PAGE + parsed.idx];
            if (!pick) {
                await this.sender.sendMarkdown(target, '这个模型已不在列表里了，重新发 /model 刷一下卡片~');
                return true;
            }
            await this.manager.setModelOverride(scope, peerId, { provider: pick.provider, model: pick.id });
            await this.sender.sendMarkdown(target, `✅ 模型已切换: ${pick.name || pick.provider + '/' + pick.id}\n立即生效，对话上下文保留。`);
            return true;
        }
        catch (err) {
            this.logger.warn?.(`[model-switcher] 回调异常: ${err instanceof Error ? err.message : String(err)}`);
            await this.sender.sendMarkdown(target, '⚠️ 切换异常，请重试或 /bot-model provider/model 手动切换');
            return true;
        }
    }
}
//# sourceMappingURL=model-switcher.js.map