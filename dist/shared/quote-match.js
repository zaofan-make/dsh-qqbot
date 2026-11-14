/**
 * quote-match.ts —— 引用归属匹配用的纯函数（2026-11-14）
 *
 * 为什么单独放这里：这几个函数被**两处**同时需要 ——
 *   · `transport/inbound.ts`（拼引用块时补发送者）
 *   · `middleware/attribution.ts`（在 media-history 之前回填 `ctx.state.quote`）
 * 之前它们长在 `features/attribution-index.ts` 里，而那本**独立的 attribution 台账**
 * 已被主人否掉（"不能独立台账"）—— 归属查询现在统一走 `features/msg-history`。
 * 数据源撤了，但归一化/指纹这几个纯函数照样有用，于是挪到这里。
 *
 * ⚠️ 这些函数**不做 IO**，纯字符串运算，可放心在热路径调用。
 */
/** 32 位十六进制 = 图片内容 MD5（QQ 图片文件名的规则） */
const MD5_RE = /^[0-9a-f]{32}$/i;
/**
 * 从文件名里抠出内容 MD5（`7DB891….png` → `7db891…`）。
 * 不是 MD5 形态（比如 `photo.jpg`）就返回空串。
 */
export function md5OfFilename(filename) {
    const base = String(filename ?? '').trim().split(/[\\/]/).pop() ?? '';
    const stem = base.replace(/\.[0-9a-z]+$/i, '');
    return MD5_RE.test(stem) ? stem.toLowerCase() : '';
}
/** 从任意文本里抠出所有图片 MD5（兜住 `[image: xxx.png]`、`文件名:x.jpg` 这些形态） */
export function md5sInText(text) {
    const out = [];
    const re = /([0-9a-f]{32})\.(?:jpe?g|png|gif|webp|bmp)/gi;
    const src = String(text ?? '');
    let m;
    while ((m = re.exec(src)) !== null) {
        const v = String(m[1]).toLowerCase();
        if (!out.includes(v))
            out.push(v);
    }
    return out;
}
/**
 * 把一段正文归一化成"匹配用"形态：去图片/表情占位、去表情标签、去所有空白、转小写。
 *
 * 为什么要这么狠：被引原文可能是 `[image: xxx.png]`、可能带 `<faceType=…>`、
 * 可能因为平台截断只有前 60 字、还可能有全角空格。这些差异都跟"是谁说的"无关，
 * 只要**能认出是同一句**就够了。
 */
export function normQuoteText(s) {
    return String(s ?? '')
        .replace(/\[image:[^\]]*\]/gi, '')
        .replace(/\[(?:图片|image)[^\]]*\]/gi, '')
        .replace(/<faceType=[^>]*>/gi, '')
        .replace(/【表情:[^】]*】/g, '')
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}
/**
 * 两条正文是否算"同一句"（归一化后比）。
 * 规则：完全相等 / 任一方是另一方的前缀（平台会把被引原文截断到 60 字）。
 */
export function sameQuotedText(a, b) {
    const x = normQuoteText(a);
    const y = normQuoteText(b);
    if (!x || !y)
        return false;
    return x === y || x.startsWith(y) || y.startsWith(x);
}
//# sourceMappingURL=quote-match.js.map