import { chunkMarkdownText } from './chunker.js';
import { StreamingWriter } from './streaming-writer.js';
import { containsRecall, collectRecallIndices, extractRefTag, parseOutbound, stripDirectives, resolveSource, } from './rich-media.js';
import { stickerPerTurnCtx } from '../features/sticker-gate.js';
import { rememberBotReply } from '../features/bot-reply-memo.js';
/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;
/**
 * 富媒体感知发送一段完整文本：
 *  1) 若整段为 [RECALL] 指令(去掉指令后无实质内容) → 触发 bot.recallLast
 *  2) 否则解析 [MEDIA:kind|src]，媒体段逐个 bot.sendMedia，文本段照常分块 sendMarkdown
 *  富媒体指令与 [RECALL] 从展示文本中剔除；任一失败不抛(逐项记录由调用方/logger)。
 *
 * resolveTarget(可选): 每次实际发送(每条媒体/每个文本分块)前调用一次, 返回该条的目标。
 * 用于「适配主动」出站: 同一条入站消息的连续回复数到限后自动切主动(去掉 msg_id)。
 * 注意: [RECALL] 撤回动作不消耗计数, 固定用传入 target。
 */
export async function sendRichOutbound(bot, target, text, limit, cwd, logError, resolveTarget, 
/** 逐文本块目标(2026-09-10 主人定 passive 收尾): 传 (块序号i, 总块数total)=>ReplyTarget,
 *  用于「正文块>5 时第 6 块起转主动发送」; undefined=所有块用 resolveTarget/固定 target */
chunkTarget, 
/** 每成功发出一个正文块后回调(2026-09-10 主人定 passive 收尾 A 方案): outbound.ts 用它统计
 *  「**同一个 msg_id 下**已发出几个正文块」, 回合结束时决定是否把最后一块复制一份主动补发。
 *  带上 target 是因为 QQ 的被动回复 5 条上限**按 msg_id 计** —— msg_id 一变(群友中途发言)
 *  配额即重置, 计数必须跟着归零, 否则会误补发(2026-09-10 主人指出)。 */
onBlockSent, 
/** 引用短号查表(2026-09-13 主人定): 传短号(如 0913a) → 完整 msg_id; 台账见 transport/msg-index.ts */
refLookup, 
/**
 * ★ 2026-11-07 主人要的：**正文被平台判违规时告知 AI**。
 *   每块发送失败都会回调 (`err`, `该块文本`)，由上层判断是不是"内容违规"并注入提示；
 *   这里只是把异常**吞掉继续发后续块**（原来一抛就整段中断，后面的正文也全丢了）。
 */
onSendError, 
/**
 * ★★ 2026-10-16 主人定：**出站扩展链**的上下文（第六套扩展点 `.qqbot-extensions/outbound/`）★★
 *
 * 挂在这里的原因：`sendRichOutbound` 是**所有出站**（AI 正文 / 媒体段 / 卡片文本）的必经之路，
 * 出站扩展才有机会"改正文、消灭这条、额外补发媒体"。
 *
 * 缺省（不传）也**照跑链** —— 扩展可能只想按文本/会话判断；`enabled:false` 才是显式关闭
 * （给内部回环调用用，避免"自己发的又被自己拦"）。
 */
extHook) {
    // ★★ 出站扩展链（2026-10-16）：先让扩展改 / 杀这条出站，再走原有发送逻辑 ★★
    //   · 动态 import：没装扩展时零开销，也避免 transport ↔ features 的循环依赖；
    //   · **绝不阻断出站**：链里任何异常都吞掉、按原文发（宁可不改，也不能把消息弄丢）。
    //
    //   ⚠️⚠️ 2026-10-16 事故（主人实测"正文都发不出去 / 第一条就卡"）：
    //     出站链是**同步挂在发送路径上**的 —— 扩展里一旦有重活（例如给全库 1892 条做向量编码），
    //     就会把整个 sendRichOutbound await 住 ⇒ **正文根本发不出去**。
    //     主人的判断是对的：**正文该照发，配图是"后补"的动作**，不该卡在正文前面。
    //     所以这里加**硬超时**兜底：超时就放弃扩展的改写/配图，照原文发出去。
    //     （更彻底的做法是把"补发媒体"挪到正文全部发完之后，见 features/ext-outbound.ts 的 TODO。）
    if (extHook?.enabled !== false) {
        try {
            const { runOutboundChain } = await import('../features/ext-outbound.js');
            // ★ 2026-10-26 修（外部作者 wuwo1979 用真机日志实测上报）：
            //   3 秒对**语音合成 / 拆条 / 表情包搜索**都太紧 —— TTS 走网络 1~3 秒，冷启动更容易压线。
            //   超时的后果是"放弃改写/配图、按原文发出"，用户看到的就是"她说要发语音，结果什么都没来"。
            //   改成可配：环境变量 QQBOT_EXT_HOOK_TIMEOUT_MS，默认 8000ms，夹在 [500, 30000]。
            //   （出站链里语音合成已经挪进 ctx.background() 不占这个预算，所以 8 秒是富余而不是更慢。）
            const EXT_HOOK_TIMEOUT_MS = (() => {
                const raw = Number(process.env.QQBOT_EXT_HOOK_TIMEOUT_MS);
                if (Number.isFinite(raw) && raw >= 500)
                    return Math.min(30000, Math.round(raw));
                return 8000;
            })();
            const chain = runOutboundChain(text, {
                ...(extHook ?? {}),
                target,
                sender: bot,
                logger: (extHook?.logger ?? undefined),
            });
            const r = await Promise.race([
                chain,
                new Promise((resolve) => setTimeout(() => resolve({ text, killed: false, reason: 'ext-hook-timeout', ran: 0 }), EXT_HOOK_TIMEOUT_MS)),
            ]);
            if (r.reason === 'ext-hook-timeout') {
                logError?.(`im-qqbot: 出站扩展链超时(${EXT_HOOK_TIMEOUT_MS}ms)，已放弃改写/配图、按原文发出`);
            }
            if (r.killed) {
                logError?.(`im-qqbot: 出站被扩展消灭（${r.reason || '未说明原因'}），本条未发送`);
                // 2026-11-11：告诉扩展"这条被谁杀掉了"（它们以前完全看不到这个结果）
                void (async () => {
                    try {
                        const m = await import('../features/ext-outbound.js');
                        await m.notifyOutboundSent({ ok: false, text, target, error: r.reason || 'killed', failedBlocks: 0, killed: true });
                    }
                    catch { /* ignore */ }
                })();
                return;
            }
            if (typeof r.text === 'string' && r.text !== text)
                text = r.text;
        }
        catch (err) {
            logError?.(`im-qqbot: 出站扩展链异常（已按原文发出）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // 引用消息(2026-09-13 主人定): 正文里的 [rf:短号] → 查本地台账还原完整 msg_id → 以"引用"形式发出
    const ref = extractRefTag(text);
    const refId = (() => {
        const idx = ref?.index;
        if (!idx)
            return '';
        if (refLookup) {
            try {
                const hit = refLookup(idx);
                if (hit)
                    return hit;
            }
            catch { /* 查表失败按无引用处理 */ }
        }
        // 兜底: AI 若直接写了完整 msg_id(ROBOT1.0_…)也接受
        if (/^ROBOT1\.0_/i.test(idx))
            return idx;
        logError?.(`im-qqbot: 引用短号 ${idx} 在台账里查不到, 本条按普通消息发出`);
        return '';
    })();
    // 叠加引用(2026-09-13 修): 保留 msgId(被动回复) + 加 referenceMessageId —— SDK send() 支持
    // body.msg_id 与 body.message_reference 并存。**所有**目标构造路径都要过这里。
    const withRef = (t) => refId ? { scope: t.scope, targetId: t.targetId, msgId: t.msgId, referenceMessageId: refId } : t;
    const eff = () => withRef(resolveTarget ? resolveTarget() : target);
    const hasRecall = containsRecall(text);
    const displayable = stripDirectives(text);
    // 只要含 [RECALL(:N)] 就执行，一条回复里多个 [RECALL] 逐个撤(可一次撤多条)；
    // 纯召回(去掉指令后无正文)且全未撤到 → 记录并停；否则继续发正文(正文已清所有指令，不会外显)
    if (hasRecall) {
        const indices = collectRecallIndices(text);
        let any = false;
        for (const idx of indices) {
            if (await bot.recallByIndex(target, idx))
                any = true;
        }
        if (!any && !displayable.trim()) {
            logError?.('im-qqbot: [RECALL] 无可撤回消息或已超时');
            return;
        }
    }
    else if (!displayable.trim()) {
        return;
    }
    // 用原始 text 解析(保留 [MEDIA])：媒体段单独发送，文本段各自剔除残留 [RECALL]
    // 2026-11-11：出站结果统计 —— 给扩展的 `onSent` 回执（以前扩展看不到 transport 的最终结果）
    const sentStat = { total: 0, ok: 0, failed: 0, lastError: '' };
    const segments = parseOutbound(text);
    // P1 表情包闸门: perTurn(每轮最多 N 张)。每轮=一次 sendRichOutbound(一轮 assistant 回复文本)。
    // 非表情包图(URL/库外文件/音视频)不计；真实闸门(禁群/频率/预算/去重/活性)在 sender.sendMedia 单点。
    const perTurn = stickerPerTurnCtx(cwd);
    let turnStickerSent = 0;
    for (const seg of segments) {
        if (seg.type === 'media') {
            const isStickerSeg = perTurn.isSticker(seg.kind, seg.source);
            if (isStickerSeg && perTurn.perTurnMax > 0 && turnStickerSent >= perTurn.perTurnMax) {
                // 本轮已达每轮上限：吞掉后续表情包图(不打扰正文/不回执, 防 LLM 换图重试刷闸)
                logError?.(`im-qqbot: 表情包闸门: 本轮已达每轮上限 ${perTurn.perTurnMax} 张, 已忽略后续表情包`);
                continue;
            }
            const src = resolveSource(seg.source, cwd);
            const sourceOpt = src.kind === 'url' ? { url: src.url } : { localPath: src.path };
            try {
                await bot.sendMedia(eff(), seg.kind, sourceOpt);
                if (isStickerSeg)
                    turnStickerSent += 1;
            }
            catch (err) {
                if (err instanceof Error && err.name === 'StickerGateDenied') {
                    logError?.(`im-qqbot: 表情包闸门拦截: ${err.message}`);
                }
                else {
                    logError?.(`im-qqbot: 富媒体发送失败(${seg.kind}): ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        else {
            const clean = stripDirectives(seg.text);
            if (!clean.trim())
                continue;
            // QQ 对同会话极短时间连发多条会吞/乱序: 文本分块之间加 ~500ms 间隔限速
            const chunks = chunkMarkdownText(clean, limit).map((c) => String(c || '')).filter((c) => c.trim());
            // 2026-11-11：给扩展的 onSent 用的计数（成功/失败块数 + 最后一条错误）
            sentStat.total += chunks.length;
            for (let ci = 0; ci < chunks.length; ci++) {
                const chunk = chunks[ci];
                if (!chunk.trim())
                    continue;
                // 逐块目标: passive 收尾(正文块>5 第6块起转主动)由 chunkTarget 决定; 缺省用 eff()
                // ⚠️ 2026-09-13 修: chunkTarget 分支必须同样叠加引用 —— 原实现直接 chunkTarget(...) 绕过 eff(),
                // passive 模式(当前实例)下 [reference:] 标签被 stripDirectives 剔掉却没附引用, 主人两次实测都看不到引用
                const tgt = withRef(chunkTarget ? chunkTarget(ci, chunks.length) : (resolveTarget ? resolveTarget() : target));
                // 记住她刚说的话(2026-09-13): 相关度信号 relReply 要用「当前消息 vs 她上一条发言」判断
                // "是不是有人在接她的话" —— 内存级, 不落盘, 失败也不影响发送
                try {
                    if (tgt.scope === 'group')
                        rememberBotReply(tgt.targetId, chunk);
                }
                catch { /* ignore */ }
                try {
                    await bot.sendMarkdown(tgt, chunk);
                    sentStat.ok += 1;
                    onBlockSent?.(chunk, tgt);
                }
                catch (err) {
                    sentStat.failed += 1;
                    sentStat.lastError = err instanceof Error ? err.message : String(err);
                    // 单块失败不中断整段：把错误交给上层（可能是"内容违规"），继续发后面的块
                    onSendError?.(err, chunk);
                    logError?.(`im-qqbot: 正文块发送失败: ${err instanceof Error ? err.message : String(err)}`);
                }
                if (ci < chunks.length - 1)
                    await new Promise((r) => setTimeout(r, 500));
            }
        }
    }
    // 2026-11-11：**发完之后**把结果回执给出站扩展的 `onSent`
    //   （fire-and-forget：扩展报错/超时绝不影响已经发出去的消息）
    void (async () => {
        try {
            const m = await import('../features/ext-outbound.js');
            await m.notifyOutboundSent({
                ok: sentStat.failed === 0 && sentStat.ok > 0,
                text,
                target,
                ...(sentStat.lastError ? { error: sentStat.lastError } : {}),
                failedBlocks: sentStat.failed,
                killed: false,
            });
        }
        catch { /* ignore */ }
    })();
}
/** 待发送缓冲超过这个长度就告警一次（不丢内容） */
const OUTBOUND_BUFFER_WARN_BYTES = 200_000;
export class OutboundBuffer {
    record;
    bot;
    limit;
    logger;
    cwd;
    resolveTarget;
    chunkTarget;
    onBlockSent;
    refLookup;
    buffer = '';
    /** 缓冲过大只告警一次（见 append 的注释） */
    warnedBig = false;
    flushing = false;
    writer;
    constructor(record, bot, limit, logger, streamingEnabled, cwd = undefined, resolveTarget, 
    /** 逐文本块目标(2026-09-10 passive 收尾; 正文块>5 第6块起转主动) */
    chunkTarget, 
    /** 每成功发出一个正文块后回调(见 sendRichOutbound 同名参数) */
    onBlockSent, 
    /** 引用短号查表(见 sendRichOutbound 同名参数; 2026-09-13 主人定) */
    refLookup) {
        this.record = record;
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
        this.cwd = cwd;
        this.resolveTarget = resolveTarget;
        this.chunkTarget = chunkTarget;
        this.onBlockSent = onBlockSent;
        this.refLookup = refLookup;
        this.writer = streamingEnabled
            ? new StreamingWriter({
                bot,
                target: record.replyTarget,
                // ★ 2026-11-06：把"逐条现算目标"也交给流式通道，
                //   否则它会一直拿 record.replyTarget 里那个可能早已过期的 msg_id 去被动回复。
                ...(resolveTarget ? { resolveTarget } : {}),
                logger,
                throttleMs: STREAM_THROTTLE_MS,
            })
            : null;
    }
    /**
     * 追加文本增量。
     *
     * 2026-11-12 性能观察：`flush()` 是串行的（`flushing` 锁），发送慢时这段时间新到的
     * 增量会全部堆在 `buffer` 里。正常情况只有几 KB，但极端情况（QQ 端卡住 + AI 狂输出）
     * 可能涨到几 MB，再一次性 `chunkMarkdownText` 会有明显 GC 停顿。
     * 这里**只加可见性、不丢内容**：超过阈值打一条 warn（便于事后从日志确认"是不是堆积了"）。
     * 真正的背压应该在 AI 侧（流式输出本身就受限于上一个 flush），不在传输层做丢弃。
     */
    append(text) {
        this.buffer += text;
        this.writer?.append(text);
        if (this.buffer.length > OUTBOUND_BUFFER_WARN_BYTES && !this.warnedBig) {
            this.warnedBig = true;
            try {
                this.logger.warn?.(`[outbound] 待发送缓冲已到 ${this.buffer.length} 字（flush 跟不上 or 发送变慢），不丢内容，仅告警一次`);
            }
            catch { /* ignore */ }
        }
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 发送所有累积文本：流式优先，降级静态 */
    async flush() {
        if (this.flushing || !this.buffer.trim())
            return;
        this.flushing = true;
        try {
            if (this.writer) {
                await this.writer.finish();
                // 流式成功（未降级）→ 直接返回
                if (!this.writer.shouldFallback)
                    return;
            }
            // 降级：静态发送（writer 不存在 or 流式失败）→ 富媒体感知发送
            await sendRichOutbound(this.bot, this.record.replyTarget, this.buffer, this.limit, this.cwd, (m) => this.logger.error(m), this.resolveTarget, this.chunkTarget, this.onBlockSent, this.refLookup);
        }
        catch (err) {
            this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            this.buffer = '';
            this.flushing = false;
        }
    }
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel() {
        this.writer?.abort();
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map