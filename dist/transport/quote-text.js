/**
 * 引用文本清洗（2026-10-01 主人实测：「历史里包含引用的排版太乱了」+「引用的是表情包？」）。
 *
 * 两个数据源问题都在这里修：
 *   ① QQ 的引用在 `msg_elements` 里是一段**模板串**：
 *      `=== 消息 1 === [消息内容] A [消息类型] 引用消息 [关联消息] --- 第1条 --- [消息内容] B …`
 *      嵌套几层就重复几段，夹着一堆纯噪声 —— 原样喂给 AI 又长又乱。
 *   ② 引用一条**表情消息**时，内容是一个 QQ 表情标签：
 *      `<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">`（ext 是 base64 的 `{"text":""}`）。
 *      原样显示谁也看不懂 —— 这里转成 `【表情: 微笑】`；并顺手把 ext 里**可能藏着**的图片 URL
 *      （图片表情 / 收藏表情的其它端形态）挖出来当附件用。
 */
import { resolveFaceTags } from '../features/face-tags.js';
/** 判断是不是 QQ 的引用模板串 */
function looksLikeQqTemplate(s) {
    return /===+\s*消息|\[消息内容\]|\[消息类型\]|\[关联消息\]|引用消息|第\s*\d+\s*条/.test(s);
}
/**
 * 剥掉 QQ 引用模板的壳，返回各层正文（**最外层在前**，即"最近被引用的那句话"排第一）。
 * 不是模板串时，按行返回原文（保留原样，只 trim）。
 */
export function stripQqQuoteTemplate(s) {
    const raw = String(s ?? '');
    if (!looksLikeQqTemplate(raw)) {
        return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    let t = raw;
    // 每层的正文起点：`[消息内容]` 和 `--- 第N条 ---` 都切开
    t = t.replace(/\[消息内容\]/g, '\n');
    t = t.replace(/-{2,}\s*第\s*\d+\s*条\s*-{2,}/g, '\n');
    // 剩余的壳当空白
    t = t.replace(/\[(?:消息类型|关联消息|消息来源|消息序号)\]/g, ' ');
    t = t.replace(/[=]{2,}\s*消息\s*\d+\s*[=]{2,}/g, ' ');
    t = t.replace(/引用消息/g, ' ');
    return t
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}
/**
 * 从 QQ 表情标签里挖**图片线索**。
 *
 * 背景（2026-10-01 主人实测：「图片收藏进了表情里，依然是图片」）：
 *   QQ 的「图片表情 / 收藏表情」在消息里只给一个 `<faceType=…,ext="base64">` 标签。
 *   实测那条 ext = `eyJ0ZXh0IjoiIn0=` → `{"text":""}` —— **里面没有图**（QQ 官方文档也没定义 faceType，
 *   SDK 同样只解 ext.text），所以光靠标签解析不出图；真正的出路是"那条消息入站时的附件"
 *   （走本地台账回查，见 msg-content-cache.ts / quote-images.ts 的预取）。
 *   但不同端/版本的 ext 里**可能**带 url 之类字段 —— 这里全部扫一遍，挖到就当真图片附件用。
 */
export function extractFaceImageUrls(text) {
    const src = String(text ?? '');
    if (src.indexOf('<faceType=') < 0)
        return [];
    const out = [];
    const re = /<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const b64 = m[1] ?? '';
        if (!b64)
            continue;
        try {
            const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
            for (const v of Object.values(obj ?? {})) {
                if (typeof v === 'string' && /^https?:\/\//i.test(v) && !out.includes(v))
                    out.push(v);
            }
        }
        catch { /* ext 不是 JSON / 解不开 → 跳过 */ }
    }
    return out;
}
/**
 * 引用块正文瘦身：剥模板壳 → 表情标签转可读 → 压平水平空白 → 限长。
 *
 * ⚠️ 2026-10-11 修（主人实测：引用一条多行长消息，AI 只看到首行）：
 *   原来无条件取 `lines[0]`，本意是砍 QQ 的**嵌套引用链**（`[关联消息] --- 第1条 --- [消息内容] …`
 *   全是"这句话又引用了谁"，又长又乱，主人原话「不止是排版乱的问题，这是内容就乱了」）。
 *   但普通多行正文也被一起剁掉了 —— 那才是"他引用的内容"本身。现在分两种情况：
 *     · 模板串   → 只取最外层那一句（原行为，防嵌套噪声进上下文）
 *     · 普通文本 → 保留多行（限长仍交给调用方：当前消息走 trimQuoteBlock 的 60 字截断+缓存+提示）
 *
 * @param max 最大字数（默认 160；传 0 = 不限长）
 */
export function slimQuoteText(s, max = 160) {
    const raw = String(s ?? '');
    const lines = stripQqQuoteTemplate(raw);
    const isTemplate = looksLikeQqTemplate(raw);
    const body = isTemplate ? (lines[0] ?? '') : lines.join('\n');
    // 表情标签 → `【表情: 微笑】`（原来是 `<faceType=6,faceId="0",ext="…">` 这种谁也看不懂的串）
    // ⚠️ 只压**水平空白**，别把换行也压没 —— 多行正文靠它分段
    let out = resolveFaceTags(body)
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
    if (max > 0 && out.length > max)
        out = out.slice(0, max) + '…';
    return out;
}
/** 附件行（`📷 被引用的图片: <本地路径>` 等）—— 截断时必须豁免：那是"引用的是哪张图"的唯一线索
 *  ⚠️ 不能用字符类 `[📷🎵🎬📎]` —— emoji 是代理对，字符类里会被拆成单个 UTF-16 码元，**匹配不上**。
 *  ★ 2026-11-15（CodeRabbit 审查抓到，本 PR 引入的回归）：引用块首行现在会内联发送者，
 *    变成 `[做早饭]📷 被引用的图片: D:\…` —— 原来的 `^\s*(?:📷|🎵…)` 就匹配不上了，
 *    于是这行被当成**正文**参与限长截断，本地图片路径直接被切掉。
 *    这里允许行首有一个可选的 `[发送者]` 前缀（限长，防误伤长正文）。 */
const ATT_LINE_RE = /^(?:\s*\[[^\]\n]{1,32}\])?\s*(?:📷|🎵|🎬|📎)\s*被引用的/;
/**
 * 把整个 `[引]…[/引]` 块压成**一行**并限长（历史行用）。
 * 附件行不参与截断（否则路径被切掉 = 白记）。
 */
export function slimQuoteBlockOneLine(block, max = 140) {
    const raw = String(block ?? '').trim();
    if (!raw)
        return '';
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const isBegin = (l) => /^\[(?:引|Quoted message begins)\]$/i.test(l);
    const isEnd = (l) => /^\[\/(?:引|Quoted message ends)\]$/i.test(l);
    const hasBegin = lines.some(isBegin);
    const hasEnd = lines.some(isEnd);
    // ⚠️ 2026-10-01 主人实测抓到：附件行**必须留在 `[引]…[/引]` 里面**。
    //   原实现把「正文」和「附件」分成两段各自拼，附件被甩到 `[引] [/引]` **之后** →
    //   引用块看着是空的、图却挂在块外（`[引] [/引] 📷 被引用的图片: …`）。
    const att = lines.filter((l) => ATT_LINE_RE.test(l));
    const body = lines
        .filter((l) => !isBegin(l) && !isEnd(l) && !ATT_LINE_RE.test(l))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    const clipped = max > 0 && body.length > max ? body.slice(0, max) + '…' : body;
    const inner = [clipped, ...att].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!hasBegin && !hasEnd)
        return inner;
    // 老英文标记（[Quoted message begins]…）也归一成短标记
    return `[引] ${inner} [/引]`.replace(/\s+/g, ' ').trim();
}
//# sourceMappingURL=quote-text.js.map