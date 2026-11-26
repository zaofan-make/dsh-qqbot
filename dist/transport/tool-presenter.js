/**
 * 工具调用结果 → Markdown 格式化
 *
 * 参考 dsh-TUI 的 presentResult 机制（channel.ts presentResultView），
 * 适配 QQ 消息通道：优先用工具自定义的 presentResult 视图，
 * fallback 到 raw text。错误始终展示，成功结果按 config 开关。
 */
const RESULT_PREVIEW_LIMIT = 1500;
/** 静默工具集: 这些工具"失败"(尤其被主动 abort)是**有意行为**, 不展示失败提示(如 reply_gate 判定不吃瓜→self-cancel, 应静默无痕) */
const SILENT_TOOLS = new Set(['reply_gate']);
/**
 * 将工具调用结果格式化为 Markdown 文本
 *
 * 返回 null 表示无需发送（无内容）。
 */
export function formatToolResult(name, rawArgs, data, toolsRegistry, agent) {
    // 1. 错误优先：始终展示（静默工具除外——其中止=有意静默，如 reply_gate 吃瓜 self-cancel）
    if (data.error) {
        // QQ 群不展示联网工具的凭据与网络内部错误（可能含 token / 内部 URL）。
        if (name === 'web_search' || name === 'web_fetch')
            return null;
        if (SILENT_TOOLS.has(name))
            return null;
        return `❌ 工具 \`${name}\` 执行失败\n\`${data.error.name}: ${data.error.code}\``;
    }
    // 2. 尝试工具自定义视图（presentResult）
    const view = presentResultView(name, rawArgs, data, toolsRegistry, agent);
    if (view) {
        const rendered = renderView(name, view);
        if (rendered)
            return rendered;
    }
    // 3. fallback raw text
    const block = data.message.content[0];
    const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : '';
    if (!result)
        return null;
    return `🔧 \`${name}\` 完成\n${truncate(result)}`;
}
/** 调用工具自定义 presentResult，失败/不可用时返回 undefined */
function presentResultView(name, rawArgs, data, toolsRegistry, agent) {
    if (!toolsRegistry)
        return undefined;
    try {
        const tool = toolsRegistry.get(name, agent);
        if (tool?.presentResult === undefined)
            return undefined;
        const block = data.message.content[0];
        const content = block !== undefined && block.type === 'tool-result' ? block.content : [];
        return tool.presentResult(JSON.parse(rawArgs), {
            content,
            isError: block?.isError === true,
            ...(data.meta !== undefined ? { meta: data.meta } : {}),
        });
    }
    catch {
        return undefined;
    }
}
/** 将结构化视图渲染为 Markdown */
function renderView(name, view) {
    const header = `🔧 \`${name}\` 完成`;
    switch (view.card) {
        case 'terminal': {
            const output = (view.output ?? '').trimEnd();
            if (!output)
                return null;
            const exit = view.exitCode !== undefined && view.exitCode !== 0 ? `\n退出码 ${view.exitCode}` : '';
            return `${header}\n\`\`\`\n${output}\n\`\`\`${exit}`;
        }
        case 'diff': {
            return `${header}\n\`\`\`diff\n${truncate(renderDiffs(view.diffs))}\n\`\`\``;
        }
        case 'read': {
            const content = view.content ? textOf(view.content) : '';
            if (!content)
                return null;
            const path = view.path ? ` (${view.path})` : '';
            return `${header}${path}\n\`\`\`\n${truncate(content)}\n\`\`\``;
        }
        case 'generic':
        default: {
            const content = view.content ? textOf(view.content) : '';
            if (!content)
                return null;
            return `${header}\n${truncate(content)}`;
        }
    }
}
/** 提取 content blocks 中的纯文本 */
function textOf(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .map((b) => {
        if (typeof b === 'object' && b !== null && b.type === 'text') {
            return b.text ?? '';
        }
        return '';
    })
        .filter(Boolean)
        .join('');
}
/** 渲染 diff hunks 为纯文本 */
function renderDiffs(diffs) {
    return diffs
        .map((d) => {
        if (typeof d === 'object' && d !== null) {
            const { path, hunks } = d;
            const body = (hunks ?? []).map((h) => h.text ?? '').join('\n');
            return path ? `--- ${path} ---\n${body}` : body;
        }
        return '';
    })
        .filter(Boolean)
        .join('\n');
}
/** 截断长文本，避免刷屏 */
function truncate(text) {
    if (text.length <= RESULT_PREVIEW_LIMIT)
        return text;
    return `${text.slice(0, RESULT_PREVIEW_LIMIT)}\n…（已截断）`;
}
//# sourceMappingURL=tool-presenter.js.map