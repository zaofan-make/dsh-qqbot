/**
 * Markdown 文本切分器
 *
 * QQ 单条消息有字符数限制（约 5000），需要在合适边界切分，
 * 并保持 GFM 表格、代码块的完整性。
 */
/**
 * 按 limit 硬切一段文本。
 *
 * ★ 2026-11-14 修（审查发现）：原来只按换行切，单行超过 limit 时整行原样输出 ⇒
 *   QQ 以"长度超限"拒收，该段正文**整块丢失**（只留一条日志）。
 *   典型输入：模型吐一行 6000 字的 base64 / 长 URL 列表（中途没有换行）。
 *   切分点回退一格避开代理对，防止把 emoji 劈成半个。
 */
function hardSplit(s, limit) {
    const out = [];
    const step = Math.max(1, limit);
    let i = 0;
    while (i < s.length) {
        let end = Math.min(i + step, s.length);
        if (end < s.length) {
            const code = s.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff)
                end -= 1; // 别切在高代理和低代理之间
        }
        out.push(s.slice(i, end));
        i = end;
    }
    return out;
}
const CODE_FENCE_OPEN = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;
/**
 * 按换行边界切分 Markdown 文本
 * - 不在代码块中间断开
 * - 不在 GFM 表格中间断开
 * - 优先在空行处断开
 */
export function chunkMarkdownText(text, limit) {
    if (text.length <= limit)
        return [text];
    const lines = text.split('\n');
    const chunks = [];
    let current = '';
    let inCodeBlock = false;
    let tableBuffer = [];
    const flushTable = () => {
        if (tableBuffer.length === 0)
            return;
        const block = tableBuffer.join('\n');
        tableBuffer = [];
        // ★ 表格整块比 limit 还长时，先按行排放、必要时硬切（否则一样会被 QQ 拒）
        if (!current && block.length > limit) {
            for (const piece of hardSplit(block, limit))
                chunks.push(piece);
            return;
        }
        if (!current) {
            current = block;
            return;
        }
        const candidate = `${current}\n${block}`;
        if (candidate.length > limit) {
            chunks.push(current);
            current = block;
        }
        else {
            current = candidate;
        }
    };
    const appendLine = (line) => {
        // ★ 2026-11-14：单行就超限 ⇒ 先冲掉当前块，再把这一行硬切成若干段
        if (line.length > limit) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            for (const piece of hardSplit(line, limit))
                chunks.push(piece);
            return;
        }
        if (!current) {
            current = line;
            return;
        }
        const candidate = `${current}\n${line}`;
        if (candidate.length > limit) {
            chunks.push(current);
            current = line;
        }
        else {
            current = candidate;
        }
    };
    for (const line of lines) {
        if (CODE_FENCE_OPEN.test(line)) {
            flushTable();
            inCodeBlock = !inCodeBlock;
            appendLine(line);
            continue;
        }
        if (inCodeBlock) {
            appendLine(line);
            continue;
        }
        if (GFM_TABLE_LINE.test(line)) {
            tableBuffer.push(line);
            continue;
        }
        flushTable();
        appendLine(line);
    }
    flushTable();
    if (current)
        chunks.push(current);
    return chunks.length > 0 ? chunks : [text];
}
//# sourceMappingURL=chunker.js.map