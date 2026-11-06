/**
 * contextless-trim.ts — 「无上下文模式」真正干活的部分（2026-09-27 重写 · 完整四事件版）
 *
 * 需求（主人）：开启后该会话**每轮丢掉更早的对话历史**，只留系统规则 + 最近 N 条；
 *              web 记录照旧保留（只多一行「上下文已压缩」）；**不调 LLM**。
 *
 * ── 走过的两条错路（都记在这里，别再踩）────────────────────────────
 * 错路①：在 `agent/pre-step` 里裁 `decision.messages`。
 *   dsh-agent 的 runtime-types 写得很清楚：
 *     `@param payload.messages - messages removed from the inbox for this step`
 *     `PreStepDecision = { kind:'enter'; messages: UserMessage[] }`
 *   即：pre-step 的 messages 是"本步从收件箱取出的**新消息**"，不是"发给模型的完整上下文"。
 *   在那儿裁剪 = 把用户刚发的话删掉（实测：模型只收到 system-reminder → 空转 → abort）。
 * 错路②：只 append 一条带 `surfaceOp: replace` 的 user/message。
 *   模型视野确实变小了，但 token-meter 的计费契约要求有一条**紧邻的**计费事件，
 *   否则压力账本记 0 delta（占用不降、自动压缩反复触发）。
 *
 * ── 正解：照 dsh 自己的 compaction 协议写**四事件** ────────────────
 *   ① compaction/start   { compactionId, turn }
 *   ② compaction/summary { compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model }
 *        ▲ 必须**紧邻**在下一步之前（中间不能插任何事件）
 *   ③ user/message       + surfaceOp{op:'replace',startSeq,endSeq} + sourceEventSeqs（含 start/summary/全部被影子节点）
 *   ④ compaction/end     { compactionId, turn }
 *
 * ── 证据（源码/实测）─────────────────────────────────────────────
 *  · dsh-session `types.d.ts:445-462`：replace 是"The node's sourceEventSeqs must include every
 *    shadowed surface node"，且 "Used by compaction; **any surface-replacing producer may use it**"
 *    → 第三方插件用 replace 是官方允许的。
 *  · dsh-compaction-basic `:888-902`：官方留了"模板/远端摘要器"的定制钩子
 *    → **非 LLM 摘要被明确支持**（类型 `llmStreamCall?: never`）。
 *  · dsh-token-meter `surface-projection.js:37-66` 的计费契约：
 *      ① summary 必须紧邻 replace；② shadowedRange 必须与 {startSeq,endSeq} 完全一致；
 *      ③ shadowedTokenCount 必须是**固定启发式价**之和（用错价会让压力账本永久漂移）。
 *  · dsh-session `surface.js:236-269`：sourceEventSeqs 非空、无重复、必须全部更早、
 *    且必须覆盖全部被 shadow 的 surface 节点。
 *  · `surface.js:388-397`：node0 若是 system/message，只能被"恰好 1 个 system/message"替换
 *    → 故范围一律**从第一个非 system 节点开始**，绝不碰 node0。
 *  · `session.append` 会对 data 做 JSON 快照，**任何 `undefined` 属性都会抛错**
 *    → provider/model 给空串；可选字段用条件展开。
 *
 * ── web 端行为（主人关心的）───────────────────────────────────
 *  surface 是"模型视野"，不是人类 transcript（surface.js:39-46 原文注释）。
 *  被 shadow 的原消息**仍留在会话日志**，web 上照样能翻；只多出一行可折叠的
 *  「上下文已压缩 · 约 N tokens」标记。**不存在"把历史从记录里删掉"的机制。**
 */
import { randomUUID } from 'node:crypto';
import { traceContextless } from './contextless-store.js';
/** 参与"保留最近 N 条"计数的消息型事件（与 dsh 的 SurfaceEventType 对齐） */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message']);
/** 替身文本（摘要器输出；web 的「上下文已压缩」折叠块显示它） */
const FIXED_SUMMARY_TEXT = '（更早的对话已按「无上下文模式」省略，仅保留最近若干条）';
/**
 * 幂等标记（2026-09-27 修）：记住每个 session **已压到哪个 seq**。
 *
 * ⚠️ 原实现用 replaceGeneration，被群聊 AI 抓到是 bug：
 *    replaceGeneration 在"压过一次"后就不变，于是"跳过: 同一 replaceGeneration 已压缩过"
 *    会在之后每一轮都命中 → **新攒的历史被永久跳过**（实测 22:44:32 起全部跳过）。
 * 改为按 seq 记账：只要本次要压的区间末尾 seq 比"上次压到的"更靠后，就允许再压。
 */
const lastTrimmedEndSeq = new WeakMap();
/** 双保险：记住每个 session 上一次压缩的 turn，同一 turn 内不再重复压（step 缺失时兜底） */
const lastTrimmedTurn = new WeakMap();
function newId() {
    try {
        return randomUUID();
    }
    catch { /* fallthrough */ }
    return 'ctxless-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}
/** 拿不到宿主 tokenMeter 时的粗估：≈ 字符数 / 4 */
function roughTokens(value) {
    try {
        if (value === null || value === undefined)
            return 0;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
    }
    catch {
        return 0;
    }
}
/** tool 相关事件（回退边界用，避免切断 tool-call/tool-result 配对） */
function isToolish(ev) {
    const t = String(ev?.type ?? '');
    return t === 'tool/result' || t === 'tool/call';
}
/** 从事件里读消息体（用于估价） */
function messageOf(sess, seq) {
    const ev = sess.eventAt?.(seq);
    try {
        if (typeof sess.deriveEventMessage === 'function')
            return sess.deriveEventMessage(ev) ?? ev;
    }
    catch { /* ignore */ }
    return ev;
}
/**
 * 把「最近 keepRecent 条消息」之前的历史整段替换成一句固定文本（四事件协议）。
 *
 * @param agent      目标 agent（取 agent.session）
 * @param keepRecent 保留最近多少条消息（面板里的"带 @ 前 N 条"；<=0 表示全清只留替身）
 * @param logger     可选日志
 * @param ctx        可选宿主上下文（用于拿 tokenMeter 估价）
 * @returns 本次是否真的替换了
 */
export async function trimHistoryForContextless(agent, keepRecent, logger, ctx, 
/** 当前打开的轮次号（来自 agent/pre-step 的 payload.turn）。
 *  ⚠️ 绝不能传 undefined/null：我们在 pre-step 里执行，回合是开着的，
 *  而 compaction/start、compaction/end 的 turn 必须与"开着的那个 turn"一致，
 *  否则会话日志会以 SessionFormatError 写坏（实测把两个群的会话都写崩了）。 */
turn, 
/**
 * **分段压缩**用（2026-11-06）：显式指定从 surface 的第几个节点开始压。
 * 不给 = 老行为（从 node1 起、保留全局最后 keep 条）。
 * 给了 = 只压 [startIdx, ...) 这一段，**更早的前缀一个字都不动**（缓存不受影响）。
 *
 * `protectSeqs`：这些 seq 永不进替换区间（@ 我 / 扩展 forceWake 的入站消息）。
 */
opts) {
    const sess = agent?.session;
    traceContextless('trim 被调用: keep=' + keepRecent + ' turn=' + String(turn) + ' agent=' + (agent ? 'yes' : 'no') + ' session=' + (sess ? 'yes' : 'no'));
    let started = false; // 是否已 append compaction/start（失败时要补 end）
    let compactionId = '';
    const log = logger ?? ctx?.logger;
    try {
        const nodes = sess?.surface?.nodes;
        if (!Array.isArray(nodes) || nodes.length === 0) {
            log?.debug?.('[contextless] 跳过: 会话无 surface.nodes');
            traceContextless('跳过: 无 surface.nodes');
            return false;
        }
        if (typeof sess?.eventAt !== 'function' || typeof sess?.append !== 'function') {
            log?.debug?.('[contextless] 跳过: session 缺 eventAt/append');
            traceContextless('跳过: 缺 eventAt/append');
            return false;
        }
        const keep = Math.max(0, Math.trunc(Number(keepRecent)) || 0);
        // ① node0 若是 system/message 则永不纳入范围（surface.js:388 的保护）
        const headSeq = nodes[0];
        const headEv = headSeq === undefined ? undefined : sess.eventAt(headSeq);
        // ⚠️⚠️ 2026-09-27 死保护：**绝不从 node0 开始**。
        //    dsh 的 surface node0 是"受保护的第一节点"（通常是 system/message）：
        //    surface.js:388 assertSystemHeadRewrite 规定它只能被"恰好一个 system/message"替换。
        //    人家原来写成 `headEv?.type === 'system/message' ? 1 : 0` —— 只要 node0 不是 system
        //    （例如它已经是上一次压缩的 checkpoint），firstIdx 就退化成 0，于是一次 replace 把
        //    受保护 head 换掉 → 会话日志变成
        //      SessionFormatError: system/message requires a protected first surface head
        //    实测把"月饼群"的会话写坏 5 次。现在无条件从 1 起，宁可少压一个节点，也绝不碰 node0。
        const _headIsSystem = headEv?.type === 'system/message';
        // 分段压缩：从调用方给的边界起压；否则沿用"从 1 起"的老行为。
        // 注意必须先夹到 [1, nodes.length]，否则会把 node0 也压掉（SessionFormatError）。
        let firstIdx = 1;
        if (typeof opts?.startIdxOverride === 'number' && Number.isFinite(opts.startIdxOverride)) {
            firstIdx = Math.max(1, Math.min(nodes.length, Math.trunc(opts.startIdxOverride)));
        }
        if (!_headIsSystem && headSeq !== undefined) {
            log?.debug?.('[contextless] 注意: node0 不是 system/message(而是 ' + String(headEv?.type) + ')，仍从 1 起以保护 head');
        }
        // ② 定位保留段起点（从尾往前数最近 keep 条对话消息）
        let keepIdxInNodes;
        if (keep <= 0) {
            if (nodes.length <= firstIdx + 1) {
                log?.debug?.('[contextless] 跳过: 节点数不足(' + nodes.length + ')');
                traceContextless('跳过: 节点数不足 ' + nodes.length);
                return false;
            }
            keepIdxInNodes = nodes.length; // 全清（只留替身）
        }
        else {
            const msgIdx = [];
            for (let i = firstIdx; i < nodes.length; i++) {
                const seqI = nodes[i];
                if (seqI === undefined)
                    continue;
                const ev = sess.eventAt(seqI);
                if (ev && MESSAGE_TYPES.has(String(ev.type)))
                    msgIdx.push(i);
            }
            if (msgIdx.length <= keep + 1) {
                log?.debug?.('[contextless] 跳过: 消息数 ' + msgIdx.length + ' <= 保留 ' + keep + '+1');
                traceContextless('跳过: 消息数 ' + msgIdx.length + ' <= 保留 ' + keep + '+1');
                return false;
            }
            const keepFromRaw = msgIdx[msgIdx.length - keep];
            if (keepFromRaw === undefined)
                return false;
            keepIdxInNodes = keepFromRaw;
        }
        // ②.5 保护段（分段压缩）：@ 我 / forceWake 的节点一律不压 ——
        //   做法是把保留段起点**往前挪到最早的那个受保护节点**，后面的就全留下了。
        if (opts?.protectSeqs && opts.protectSeqs.size > 0) {
            for (let i = firstIdx; i < keepIdxInNodes; i++) {
                const sq = nodes[i];
                if (sq === undefined)
                    continue;
                if (opts.protectSeqs.has(sq)) {
                    keepIdxInNodes = i;
                    break;
                }
            }
            if (keepIdxInNodes <= firstIdx) {
                log?.debug?.('[contextless] 跳过: 受保护节点就在区间开头');
                return false;
            }
        }
        // ③ 回退到 tool 配对平衡的边界（surface 层不查，但 provider 会因孤立 tool 调用报错）
        while (keepIdxInNodes > firstIdx + 1) {
            const seqAt = nodes[keepIdxInNodes];
            if (seqAt === undefined || !isToolish(sess.eventAt(seqAt)))
                break;
            keepIdxInNodes -= 1;
        }
        if (keepIdxInNodes <= firstIdx) {
            log?.debug?.('[contextless] 跳过: 保留段起点已到头部');
            traceContextless('跳过: 保留段起点已到头部');
            return false;
        }
        const startRaw = nodes[firstIdx];
        const endRaw = nodes[keepIdxInNodes - 1];
        if (startRaw === undefined || endRaw === undefined)
            return false;
        const start = startRaw;
        const end = endRaw;
        const shadowedSeqs = nodes.slice(firstIdx, keepIdxInNodes);
        if (shadowedSeqs.length === 0)
            return false;
        // ③.5 双保险：同一 turn 只压一次
        if (typeof turn === 'number') {
            const prevTurn = lastTrimmedTurn.get(sess);
            if (typeof prevTurn === 'number' && prevTurn === turn) {
                traceContextless('跳过: 同一 turn(' + turn + ') 已压缩过');
                return false;
            }
        }
        // ④ 幂等（按 seq）：本次要压到的 end 不晚于"上次压到的"→ 说明没有新历史 → 跳过。
        //    有新消息时 end 会变大 → 允许再压（这正是原 replaceGeneration 写法漏掉的情况）。
        const trimmedTo = lastTrimmedEndSeq.get(sess);
        if (typeof trimmedTo === 'number' && end <= trimmedTo) {
            traceContextless('跳过: 已压到 seq ' + trimmedTo + '，本次 end=' + end + ' 没有更新的历史');
            return false;
        }
        // ⑤ shadowedTokenCount = 固定启发式价之和（契约要求；用错价会让压力账本漂移）
        // ⚠️ 2026-09-27 修：插件的 ctx 未必 inject 了 tokenMeter，直接访问会抛
        //    "cannot get property \"tokenMeter\" without inject"（实测把整轮清理打挂）。
        //    所以整段包 try，拿不到就退回字符估算 —— 宁可价不准，也不能不干活。
        let estimateFn;
        try {
            const tm = ctx?.tokenMeter;
            if (tm && typeof tm.estimateMessage === 'function')
                estimateFn = tm.estimateMessage.bind(tm);
        }
        catch {
            estimateFn = undefined;
        }
        let shadowedTokenCount = 0;
        for (const seq of shadowedSeqs) {
            const msg = messageOf(sess, seq);
            let got = NaN;
            if (estimateFn) {
                try {
                    got = Number(estimateFn(msg));
                }
                catch {
                    got = NaN;
                }
            }
            shadowedTokenCount += Number.isFinite(got) && got > 0 ? Math.round(got) : roughTokens(msg);
        }
        if (!Number.isFinite(shadowedTokenCount) || shadowedTokenCount < 0)
            shadowedTokenCount = 0;
        compactionId = newId();
        // ⑥ ① 开括号（standalone：turn 为 null —— 本函数只在回合空闲后运行）
        const startEvent = sess.append('compaction/start', {
            compactionId,
            turn: typeof turn === 'number' ? turn : null,
        });
        started = true;
        // ⑦ ② 计费事件
        const summaryEvent = sess.append('compaction/summary', {
            compactionId,
            summary: [{ type: 'text', text: FIXED_SUMMARY_TEXT }],
            shadowedRange: { start, end },
            shadowedSeqs: [...shadowedSeqs],
            shadowedTokenCount,
            provider: '', // 类型必填 string；绝不能是 undefined（append 的 JSON 快照会抛）
            model: '',
        });
        // ⚠️ ⑧ ③ 替换（必须**紧邻** summary，中间不能插任何 append）
        const sources = [startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs]
            .filter((s) => typeof s === 'number' && Number.isFinite(s));
        sess.append('user/message', {
            id: newId(),
            role: 'user',
            content: [{ type: 'text', text: FIXED_SUMMARY_TEXT }],
            source: { kind: 'compact-checkpoint', compactionId },
        }, {
            surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
            sourceEventSeqs: sources,
        });
        // ⑨ ④ 闭括号
        sess.append('compaction/end', { compactionId, turn: typeof turn === 'number' ? turn : null });
        started = false;
        lastTrimmedEndSeq.set(sess, end); // 记账：已压到这个 seq
        if (typeof turn === 'number')
            lastTrimmedTurn.set(sess, turn);
        traceContextless('✅ 成功: 替换 seq ' + start + '..' + end + '（' + shadowedSeqs.length + ' 节点 / ' + shadowedTokenCount + ' tokens），保留 ' + keep);
        log?.info?.('[contextless] 已省略历史: 替换 seq ' + start + '..' + end
            + '（' + shadowedSeqs.length + ' 个节点 / 约 ' + shadowedTokenCount + ' tokens）→ 保留最近 ' + keep + ' 条消息');
        return true;
    }
    catch (err) {
        // 失败必须补一条 compaction/end（带 error），否则该会话后续压缩会被 compaction-basic 判 busy 挡死
        if (started && compactionId && typeof sess?.append === 'function') {
            try {
                sess.append('compaction/end', { compactionId, turn: typeof turn === 'number' ? turn : null, error: { message: err instanceof Error ? err.message : String(err) } });
            }
            catch { /* ignore */ }
        }
        traceContextless('❌ 失败: ' + (err instanceof Error ? (err.message + '\n' + (err.stack ?? '')) : String(err)));
        log?.debug?.('[contextless] 省略历史失败(已忽略): ' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}
/**
 * 回合空闲后执行清理（插件硬约束：回合中 append 会坏记录 —— inject.ts 的既有约定）。
 * fire-and-forget，不阻塞调用方。
 */
export function scheduleContextlessTrim(agent, keepRecent, logger, ctx) {
    const wait = typeof agent?.whenIdle === 'function'
        ? agent.whenIdle().catch(() => undefined)
        : Promise.resolve();
    void wait.then(() => trimHistoryForContextless(agent, keepRecent, logger, ctx)).catch(() => undefined);
}
//# sourceMappingURL=contextless-trim.js.map