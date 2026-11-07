/**
 * image-offload.ts — **历史图片不重发**（2026-11-07 主人定）
 *
 * 问题：dsh 每轮都会把整段会话历史发给模型。图片一旦进了会话，
 *   之后**每一轮**都会被重新带上（重新算视觉 token，慢且贵）。
 *   `compaction-image-offload` 那类插件就是干这个的；我们这里自己实现一份。
 *
 * 目标（主人原话）：**历史里不能有 image block，只留「本次唤醒前带进来的那几张」**。
 *
 * 做法：
 *   1. 边界 = 最后一条 `assistant/message` 之后 —— 那之后就是本回合新来的消息；
 *   2. 边界**之前**的 user/message，只要含 ImageBlock，就换成「同一条消息的纯文字版」：
 *      图片块 → `[图片已省略：<路径/附件id>]`，其余文字原样保留；
 *   3. 用宿主认可的 **四事件协议**（compaction/start → summary → replace → end）做替换，
 *      这样不算"乱改历史"，token 账本也不会漂。
 *
 * 为什么不用 `trimHistoryForContextless`：那个是"整条消息压成一行占位"，会把文字也丢掉；
 * 这里要的是「留字、去图」。
 */
import { randomUUID } from 'node:crypto';
import { isOurAttachment } from './image-aggregate.js';
/** 估算一小段文本的 token（粗算即可，只为让账本有意义） */
function roughTokens(blocks) {
    let n = 0;
    for (const b of blocks) {
        if (b?.type === 'text')
            n += Math.ceil(String(b.text ?? '').length / 2);
        else
            n += 4;
    }
    return n;
}
/**
 * 这条消息是不是**本插件自己拼出来**的「聚合图消息」？
 *
 * ★ 2026-11-07 踩坑修正：原来用 `attachmentId` 台账匹配 ——
 *   dsh 的附件 id 是**内容寻址**的（`sha256:<hash>`），同一张图被不同途径引用时会撞上，
 *   结果把主人在 web 上手动上传的图也当成我们的给压掉了。
 *   改成认**我们自己写的那行说明文字**（`[图片聚合]` / `（↑ xxx 发的图）`）：
 *   只有我们注入的图块后面才会跟着这句，别的来源不可能有 ⇒ 不会误伤。
 */
function isOurAggregateMessage(content) {
    if (!Array.isArray(content))
        return false;
    const text = content
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join(String.fromCharCode(10));
    return text.includes('[图片聚合]') || text.includes('（↑');
}
/** 把一条消息里的图片块换成一个文字占位；没有图片就返回 null */
function stripImages(content) {
    if (!Array.isArray(content))
        return null;
    let removed = 0;
    const blocks = [];
    for (const b of content) {
        if (b?.type === 'image') {
            // ★ 2026-11-07 主人定：**只清理本插件自己聚合出来的图**，别的插件/功能塞的图一律不动。
            const aid = String(b.attachment?.attachmentId ?? '');
            if (!isOurAttachment(aid)) {
                blocks.push(b);
                continue;
            }
            const id = String(b.attachment?.attachmentId ?? '');
            const mt = String(b.attachment?.mediaType ?? '');
            blocks.push({ type: 'text', text: `[图片已省略${mt ? ` ${mt}` : ''}${id ? ` #${id.slice(0, 8)}` : ''}]` });
            removed += 1;
            continue;
        }
        blocks.push(b);
    }
    return removed > 0 ? { blocks, removed } : null;
}
/**
 * 把历史里的图片块全部换成文字占位。
 *
 * @param agent 目标会话的 agent
 * @param logger 日志
 * @param turn 当前打开的轮次号（compaction 事件必须与它一致，否则会写坏会话日志）
 * @returns 处理掉的图片块数量（0 = 没事可做）
 */
export async function offloadHistoryImages(agent, logger, turn) {
    const sess = agent?.session;
    if (!sess || typeof sess.eventAt !== 'function' || typeof sess.append !== 'function')
        return 0;
    const nodes = sess.surface?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 3)
        return 0;
    // 边界：最后一条 assistant/message 之后（= 本回合新来的消息，图片要留着）
    let boundary = nodes.length;
    for (let i = nodes.length - 1; i >= 1; i -= 1) {
        const sq = nodes[i];
        if (sq === undefined)
            continue;
        const ev = sess.eventAt(sq);
        if (ev && ev.type === 'assistant/message') {
            boundary = i + 1;
            break;
        }
    }
    let total = 0;
    let ranges = 0;
    for (let i = 1; i < boundary; i += 1) {
        const seq = nodes[i];
        if (seq === undefined)
            continue;
        const ev = sess.eventAt(seq);
        if (!ev || ev.type !== 'user/message')
            continue;
        const content = ev.data?.content;
        // 只动「我们自己聚合出来的」消息：认那行说明文字，别的一律不碰
        if (!isOurAggregateMessage(Array.isArray(content) ? content : []))
            continue;
        const stripped = stripImages(Array.isArray(content) ? content : []);
        if (!stripped)
            continue;
        const compactionId = randomUUID();
        let started = false;
        try {
            const startEv = sess.append('compaction/start', { compactionId, turn: typeof turn === 'number' ? turn : null });
            started = true;
            const summaryEv = sess.append('compaction/summary', {
                compactionId,
                summary: stripped.blocks,
                shadowedRange: { start: seq, end: seq },
                shadowedSeqs: [seq],
                shadowedTokenCount: roughTokens(content),
                provider: '',
                model: '',
            });
            const sources = [startEv?.seq, summaryEv?.seq, seq].filter((x) => typeof x === 'number' && Number.isFinite(x));
            sess.append('user/message', {
                id: randomUUID(),
                role: 'user',
                content: stripped.blocks,
                source: { kind: 'compact-checkpoint', compactionId },
            }, {
                surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
                sourceEventSeqs: sources,
            });
            sess.append('compaction/end', { compactionId, turn: typeof turn === 'number' ? turn : null });
            started = false;
            total += stripped.removed;
            ranges += 1;
        }
        catch (e) {
            logger?.debug?.(`[img-offload] 替换 seq=${seq} 失败: ${e instanceof Error ? e.message : String(e)}`);
            if (started) {
                try {
                    sess.append('compaction/end', { compactionId, turn: typeof turn === 'number' ? turn : null, error: { message: 'offload failed' } });
                }
                catch { /* ignore */ }
            }
        }
    }
    if (total > 0)
        logger?.info?.(`[img-offload] 历史图片已省略 ${total} 张（${ranges} 条消息），只保留本回合新来的图片`);
    else
        logger?.debug?.('[img-offload] 历史里没有需要省略的图片');
    return total;
}
//# sourceMappingURL=image-offload.js.map