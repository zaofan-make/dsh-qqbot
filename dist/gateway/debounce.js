import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { dataRootOf } from './data-root.js';
import { handleInbound } from '../transport/inbound.js';
import { getHistoryStore, historyGroupKey, clearGroupHistory } from '../features/history-store.js';
import { lookupImagePath } from '../features/image-path-cache.js';
import { appendFileSync } from 'node:fs';
import { stripLeadingMentions } from '../shared/mention-clean.js';
import { join } from 'node:path';
const DEFAULTS = {
    enabled: true,
    silenceSec: 3,
    maxMsgs: 10,
    mentionDelayed: true,
    busySendMode: 'queue',
};
/**
 * 「回合忙」最多等多久（ms）—— 超时强制放行。
 *
 * 3 分钟：正常回合（哪怕连着调十几个工具、跑长命令）都够；超过基本可以认定是异常卡死。
 * ⚠️ 这条兜底的意义不在"性能"，而在**可用性**：宁可偶尔让两条消息挤进同一个回合，
 *    也不能让一个卡住的回合把整个会话的消息通道永久堵住。
 */
const BUSY_MAX_WAIT_MS = 3 * 60_000;
/** 解析消息服务器时间戳(ISO 字符串或 ms 数字; 解析失败回落"到达时刻"兜底) */
function msgTs(msg) {
    const raw = msg.timestamp;
    const n = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
    return Number.isFinite(n) ? n : Date.now();
}
function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}
/**
 * 把「store 群历史」与「当前窗口条目」合并去重、按服务器时间序排好。
 *
 * ⚠️ 这里是"到底算不算被 @ 了"的**最终裁定点**（2026-10-12 为此单独抽成可单测的纯函数）：
 *   · store 条目上的 `mentioned` 是链上**第 4 步**（media-history，在 mentionGate **之前**）
 *     按**平台原始信号**写进去的；
 *   · 窗口条目上的 `wasMentioned` 是**晚于 mentionGate**（可能已被用户入站扩展改写）的判定。
 * 后者才是最终判定 ⇒ 命中同一条时**以窗口条目为准**。
 *
 * 反面教训（原实现 `if (e.wasMentioned) hit.wasMentioned = true;`，**只升不降**）：
 *   入站扩展把 `ctx.state.mention.wasMentioned` 压成 false 也没用 —— 会被 store 的
 *   `mentioned:true` 顶回来 ⇒ 静默 X 秒后照样强制唤醒；该条还会带着 mentioned 进历史行，
 *   被 inbound 的聚合加权聚成 `aggMentioned=true`。即"看起来拦住了，其实是假动作"。
 * 真 @ 时两个来源同源同值（都是平台信号）⇒ 改成"以窗口为准"没有任何回归。
 */
export function mergeWindowWithStore(storeHist, entries) {
    const merged = storeHist.map(h => ({
        messageId: h.messageId,
        ts: h.timestamp || 0,
        content: h.content,
        senderId: h.senderId,
        senderName: h.senderName,
        // 2026-09-15 修: store 条目上的[@过bot]标记要接过来(media-history 写入的 mentioned),
        //   否则只有[当前还在窗口里]的那条能靠 entries 循环补上, store 来源的会丢。
        wasMentioned: h.mentioned === true,
    }));
    for (const e of entries) {
        const id = String(e.msg.messageId ?? '');
        // ⚠️ 空 messageId(合成消息, 如 /资源 求助)不参与去重 —— 否则同一窗口里的第二条会被当"重复"吞掉
        const hit = id ? merged.find(m => m.messageId === id) : undefined;
        if (hit) {
            // ★ 2026-10-12 修（入站扩展点配套的真 bug）：**以窗口条目为准**，不能只升不降。
            //   窗口条目 = 链上实时判定（mentionGate 之后、可能已被 .qqbot-extensions/inbound/*.mjs 改写）；
            //   store 条目 = 链第 4 步的原始平台信号。分歧只可能出现在"被入站扩展压掉 @ 判定"的那种。
            hit.wasMentioned = e.wasMentioned === true;
            // ⚠️ 2026-09-10 去重(主人实测: "图片链接重复两次, 那不是又回原来的长上下文咯?"):
            //   store 条目只带 foldMedia 折叠文本(`[图片: url]` / `[语音: url]`), **窗口条目才带
            //   原始 content + attachments**。命中时若不给 hit 补 msg, current 就会取 store 版本,
            //   于是附件 URL 在上下文里出现两次: 折叠文本一次 + Layer4 的 `- Image: 名 → url` 一次。
            //   补上后: current 走 cur.msg(原始 content, 附件交给 Layer4 描述), history 仍用折叠文本。
            if (!hit.msg)
                hit.msg = e.msg;
        }
        else {
            merged.push({
                messageId: id, ts: e.ts, msg: e.msg, wasMentioned: e.wasMentioned,
                // 从 msg 提上来: 合成消息(如 /资源 求助)的 senderName 只在 msg 里, 不带上历史行会渲染成 []
                senderId: String(e.msg.senderId ?? ''), senderName: String(e.msg.senderName ?? ''),
            });
        }
    }
    merged.sort((a, b) => a.ts - b.ts);
    return merged;
}
/** 现读设置(live 热更): 回合中消息策略。缺省/未知值一律当 queue(排队=现状, 最安全) */
function busySendModeOf(config) {
    const raw = config.behavior?.debounce?.busySendMode;
    return raw === 'interject' ? 'interject' : 'queue';
}
/**
 * 插话提示 —— ★ 2026-10-10 主人定：**不再显示任何提示**（插话只注入群友消息本身）。
 *
 * 演变史（供以后想改回时参考）：
 *   · 2026-10-07 主人定"每句都提示"（原话："还是每句都提示(插话, 不要轻易改变当前任务)"）；实为
 *     `'[插话] 你思考/输出期间群友新发的消息(非对你的回应): 先做完当前任务, 再按需回应。'`；
 *   · 2026-10-09 追加"同回合第二次以后继续缩短省 token"（三级递减）；
 *   · 2026-10-10 主人定**全部去掉** —— 这些提示本身也要进上下文、白占 token，而"先做完当前任务"
 *     这层语义模型本来就知道（配合 `reply_gate` 一起用更没必要）。
 *
 * ⚠️ 结构保留：想恢复提示，只要把对应的句子填回 INTERJECT_NOTES 即可（空数组 = 不带任何前缀）。
 */
const INTERJECT_NOTES = [
    // ★ 2026-10-29（issue #28）：2026-10-10 曾把提示**整段删光**（省 token），
    //   代价是插话内容变成**裸的 `[昵称] 内容`** 追加在工具调用之后 —— 没有任何"这是别人在说话、
    //   不是等你接的台词"的标记，正好是"续写聊天记录/代写台词"最直接的燃料。
    //   这里恢复成一个**极短**标记（4 个字符），只当格式锚，不再带任何指令句。
    '(插话)',
];
/**
 * 「本回合是被意外中止的」标记（2026-10-10 主人定）。
 *
 * 背景：插话前缀（"[插话]…先做完当前任务"）只在**回合确实还在跑**时才有意义。
 * 但"停止生成"、闸门 self-cancel、崩溃恢复这些路径收尾后，宿主那边这一步是 aborted/interrupted，
 * 而会话记录的 `turnActive` 未必立刻翻掉 ⇒ 之后插进来的消息会被**误标**成"[插话]"，
 * 面板上就冒出一串"[插话] 又有群友新消息…"（主人实测）。
 * ⇒ 由 session-manager 在收到 aborted/interrupted 决策时打点；TTL 内这类消息**不带任何前缀**。
 *   （正常跑着的回合：照旧带前缀，行为不变。）
 */
const ABORTED_TTL_MS = 5 * 60 * 1000;
const abortedAt = new Map();
export function markTurnAborted(sessionId) {
    try {
        const k = String(sessionId || '');
        if (k)
            abortedAt.set(k, Date.now());
    }
    catch { /* ignore */ }
}
function turnAbortedRecently(sessionId) {
    const k = String(sessionId || '');
    if (!k)
        return false;
    const t = abortedAt.get(k);
    if (!t)
        return false;
    if (Date.now() - t > ABORTED_TTL_MS) {
        abortedAt.delete(k);
        return false;
    }
    return true;
}
/** 按"本回合已插话次数"取提示；**该会话刚被中止** ⇒ 返回空串（那批消息不是"插话"） */
function interjectNoteFor(seq, sessionId) {
    if (turnAbortedRecently(sessionId))
        return '';
    const i = Math.min(Math.max(0, Math.floor(Number(seq) || 0)), INTERJECT_NOTES.length - 1);
    return INTERJECT_NOTES[i] ?? INTERJECT_NOTES[0];
}
function shortSender(v) {
    const s = String(v ?? '').trim();
    if (!s)
        return '群友';
    return s.length > 8 ? '…' + s.slice(-6) : s;
}
/** 从中间件处理结果里取语音转写(插话走纯文本通道, 语音必须转成字才看得到) */
function voiceTextOf(processed) {
    if (!Array.isArray(processed))
        return '';
    const parts = [];
    for (const pa of processed) {
        const o = pa;
        if (String(o?.type ?? '') === 'voice' && typeof o.voiceText === 'string' && o.voiceText.trim()) {
            parts.push(o.voiceText.trim());
        }
    }
    return parts.join(' / ');
}
/** 附件摘要: 图片优先给本地路径(收藏中间件已落盘, 省 token 且 AI 能直接读盘) */
function attachmentNote(atts, processed) {
    if (!Array.isArray(atts) || atts.length === 0)
        return '';
    const out = [];
    for (const raw of atts) {
        // ★★ 2026-10-15 修：**真实字段是 `content_type`（snake_case）** ★★
        //   证据：`src/types.ts` 的 `RawAttachment`（注释明写"snake_case 字段，来自 QQ 网关
        //   C2C_MESSAGE_CREATE"）字段为 `content_type` / `filename` / `url` / `asr_refer_text`。
        //   这里原来只读 `a.type` ⇒ 恒为空串 ⇒ 所有分支都进不去 ⇒ 插话正文只剩 "(无文字内容)"，
        //   群里发的图/文件在插话模式下**完全看不到链接**（主人实测踩到）。
        //   三种命名都读（content_type / contentType / type），向后兼容。
        const a = raw;
        const t = String(a?.content_type ?? a?.contentType ?? a?.type ?? '');
        const url = String(a?.url ?? '');
        if (t.includes('image')) {
            const local = url ? lookupImagePath(url) : undefined;
            out.push(`[图片: ${local ?? (url || '（无链接）')}]`);
        }
        else if (t === 'voice' || t.includes('audio')) {
            const vt = voiceTextOf(processed);
            out.push(vt ? `[语音] ${vt}` : '[语音]');
        }
        else if (t.includes('video')) {
            // ★ 原来只有 "[视频]"、丢了链接 ⇒ 补上
            out.push(url ? `[视频: ${url}]` : '[视频]');
        }
        else if (t.includes('file') || t.includes('application') || t.includes('zip') || t.includes('octet')) {
            // ★ 原来只有文件名、丢了链接 ⇒ 补上（群友发压缩包时最关键）
            out.push(`[文件: ${String(a?.filename ?? '') || '未知'}${url ? ' ' + url : ''}]`);
        }
        else if (t) {
            // 兜底：认不出的类型也把原始类型 + 链接带出去，别再静默丢
            out.push(`[附件(${t}): ${String(a?.filename ?? '') || ''}${url ? ' ' + url : ''}]`.replace(/\s+/g, ' '));
        }
    }
    return out.join(' ');
}
/** 把窗口这批消息拼成一条插话文本(带发送者标签; 当时 @ 过她的补 (@you), 与正常派发同款事实标注) */
function buildInterjectText(entries, note) {
    const lines = [];
    for (const e of entries) {
        const m = e.msg;
        const atts = attachmentNote(m.attachments, e.processed);
        const body = [String(m.content ?? '').trim(), atts].filter(Boolean).join(' ') || '(无文字内容)';
        lines.push(`[${shortSender(m.senderName ?? m.senderId)}] ${body}${e.wasMentioned ? ' (@you)' : ''}`);
    }
    if (lines.length === 0)
        return '';
    return `${note}\n${lines.join('\n')}`;
}
/**
 * 插话注入: agent.inject = dsh 底层 `send(msg,'next-step',wakeup:false)`
 * (不唤醒、不拆 tool_calls → 宿主在下个 step 组包时带上, 她本轮就读到了)。
 * @returns true=已插进去(调用方清窗口); false=没有注入能力 / 注入抛错(调用方回落原排队逻辑, 消息不丢)
 */
function interjectBatch(rec, entries, logger) {
    const a = rec.agent;
    if (!a || typeof a.inject !== 'function')
        return false;
    // 逐次缩短提示(2026-10-09): 本回合第 n 次插话就用第 n 档; 注入成功后才 +1（失败回落排队，不算插过）
    const seq = Number(rec.interjectSeq) || 0;
    const text = buildInterjectText(entries, interjectNoteFor(seq, rec.sessionId));
    if (!text)
        return false;
    try {
        a.inject(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        }));
        rec.interjectSeq = seq + 1;
        return true;
    }
    catch (err) {
        logger.warn?.(`[debounce] 插话注入失败(回落排队): ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}
const INJECTORS = [];
export function injectSynthetic(scope, peerId, text, opts, owner) {
    for (const fn of INJECTORS) {
        try {
            if (fn(scope, peerId, text, opts, owner))
                return true;
        }
        catch { /* 单个实例失败不影响其它 */ }
    }
    return false;
}
export function debounceLayer(config, manager, logger, cooldownAt) {
    const windows = new Map();
    /** 调序调试日志(排查官方帧序用): 默认**关闭** —— 需要时设环境变量 `DSH_QQBOT_DEBOUNCE_DBG=1` 才写
     *  → {dataRoot}/.qqbot/debounce-dbg.log。(2026-09-12: 该文件曾涨到 3.8MB, 改用开关按需开) */
    const dbgOn = !!process.env.DSH_QQBOT_DEBOUNCE_DBG && process.env.DSH_QQBOT_DEBOUNCE_DBG !== '0';
    const dbgFile = join(dataRootOf(config), '.qqbot', 'debounce-dbg.log');
    function dbg(line) {
        if (!dbgOn)
            return;
        try {
            appendFileSync(dbgFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
        }
        catch { /* ignore */ }
    }
    const cfg = () => {
        const d = config.behavior?.debounce;
        return d ?? DEFAULTS;
    };
    function clearTimer(w) {
        if (w.timer) {
            clearTimeout(w.timer);
            w.timer = null;
        }
    }
    /** 尝试派发一批(窗口内全部消息 → AI 一次综合回复)。
     *  群普通(无@)受 60s 冷却约束: 未过冷却 → 窗口保留、重排计时器, 冷却结束再整批按时间序派发。
     *  @ 消息(窗口含@)/私聊: 随时派发。 */
    async function flush(key, w) {
        const pre = w.entries;
        if (pre.length === 0) {
            clearTimer(w);
            windows.delete(key);
            return;
        }
        const f0 = pre[0];
        if (!f0) {
            clearTimer(w);
            windows.delete(key);
            return;
        }
        const fKind = String(f0.msg.kind ?? '');
        const hasMention = pre.some(e => e.wasMentioned);
        // ★ 2026-10-12：窗口里只要有一条被**入站扩展强制入站**（`ctx.forceWake()`），
        //   这一批就按"必须进站"处理 —— 下面是**群冷却等待**（"冷却到没到"那一步）不再拦它。
        //   注意：forceWake **不伪造 @**（不写 wasMentioned），所以 (@you) 标注、聚合加权都不受影响。
        const hasForceWake = pre.some(e => e.forceWake === true);
        // ── LLM 回合中聚合(2026-09-07 主人定, 2026-09-11 主人改): 我正在思考/输出时, 新消息全攒着,
        //    不派发不入站 —— 无时间限制, 必须等 turn/end(record.turnActive=false)后窗口才批量 flush;
        //    只受条数约束(窗口防御上限 + maxMsgs 攒满尝试派发)。──
        {
            const recPeer = fKind === 'group'
                ? String(f0.msg.groupOpenid ?? f0.msg.senderId ?? '')
                : String(f0.msg.senderId ?? '');
            if (recPeer) {
                const busyRec = manager.findByPeer(fKind === 'group' ? 'group' : 'c2c', recPeer);
                if (busyRec?.turnActive) {
                    // ★★ 插话模式(2026-10-07 主人定, 设置项 behavior.debounce.busySendMode) ——
                    //   排队(默认/现状) vs 插话。插话 = 消息**照样先聚合**(静默秒数/条数上限都不变),
                    //   但不等这轮回合结束 —— 聚合好就经 agent.inject 塞进当前回合的**下一个轮次边界**
                    //   (宿主 send(msg,'next-step',wakeup:false): 不唤醒、不拆 tool_calls), 她本轮就能读到。
                    //   即宿主「繁忙时的发送行为 → 插话发送」的插件版。
                    //   ⚠️ 语义边界: 若她这一步是纯文字收尾(后面没有 step), 注入会留在队列里等下次唤醒才被消费,
                    //      效果等同排队 —— 这是宿主 inject 的固有语义, 不是 bug。
                    //   ⚠️ 插话是"即时补料"不是"派发回复": 不唤醒 ⇒ 不消耗群冷却, 也不在这里走冷却判断。
                    if (busySendModeOf(config) === 'interject') {
                        if (interjectBatch(busyRec, pre, logger)) {
                            clearTimer(w);
                            windows.delete(key);
                            // 与正常派发同款: 清群历史缓存 —— 免得这批消息这轮插过、下轮又被当 [历史] 打包一遍
                            if (fKind === 'group') {
                                try {
                                    clearGroupHistory(config.appId, String(f0.msg.groupOpenid ?? f0.msg.senderId ?? ''));
                                }
                                catch { /* ignore */ }
                            }
                            logger.debug(`[debounce] 插话成功(回合中, 不等 turn/end) key=${key} n=${pre.length}`);
                            dbg(`flush 插话 inject(回合中) key=${key} n=${pre.length}`);
                            return; // 已插进当前回合, 窗口清空
                        }
                        dbg(`flush 插话不可用(无 inject 能力) → 回落排队 key=${key} n=${pre.length}`);
                    }
                    // 回合忙：本来"一直等到 turn/end"。2026-09-15 起加**超时兜底** ——
                    //   卡死的回合会把该会话的消息通道永久堵住（主人实测"发完语音后消息全不进"），
                    //   超过 BUSY_MAX_WAIT_MS 就强制放行（warn 留痕），宁可挤一点也不能哑掉。
                    const since = w.busySince ?? (w.busySince = Date.now());
                    const waitedMs = Date.now() - since;
                    if (waitedMs < BUSY_MAX_WAIT_MS) {
                        w.turnDeferred = true; // 本次窗口因回合忙被 defer → 派发时带系统时间提示
                        clearTimer(w);
                        w.timer = setTimeout(() => void flush(key, w), 800); // 回合中: 800ms 后重查(等到回合结束或超时)
                        w.timer.unref?.();
                        dbg(`flush 回合忙 defer(等 turn/end, 已等 ${Math.round(waitedMs / 1000)}s) key=${key} n=${pre.length}`);
                        return; // 窗口保留, 不派发
                    }
                    logger.warn(`[debounce] 回合忙等超时(${Math.round(waitedMs / 1000)}s ≥ ${BUSY_MAX_WAIT_MS / 1000}s) → 强制放行 ` +
                        `key=${key} n=${pre.length}（该会话的回合疑似卡死，消息不能一直堵着）`);
                    w.busySince = undefined; // 放行后复位，下一轮重新计时
                    // 不 return —— 落到下面照常走冷却/派发链
                }
                else {
                    w.busySince = undefined; // 回合已结束 → 复位计时
                }
            }
        }
        if (fKind === 'group' && !hasMention && !hasForceWake) {
            // 群普通消息: 距上次普通派发不足 freeIntervalSec → 冷却中, 窗口保留继续攒
            // （★ 被入站扩展 forceWake 的批次不走这里：定义就是"跳过冷却到没到"）
            const gid = String(f0.msg.groupOpenid ?? f0.msg.senderId ?? '');
            const freeSec = Math.max(0, num(config.behavior?.freeIntervalSec, 0));
            if (gid && freeSec > 0) {
                const nowMs = Date.now();
                const lastAt = cooldownAt.get(gid) ?? 0;
                const passedMs = nowMs - lastAt;
                if (passedMs < freeSec * 1000) {
                    clearTimer(w);
                    const retryMs = Math.max(500, freeSec * 1000 - passedMs);
                    w.timer = setTimeout(() => void flush(key, w), retryMs);
                    w.timer.unref?.();
                    dbg(`flush 冷却中 defer ${Math.round(retryMs / 1000)}s key=${key} n=${pre.length}`);
                    return; // 窗口保留, 不派发
                }
            }
        }
        clearTimer(w);
        windows.delete(key);
        const entries = w.entries;
        if (entries.length === 0)
            return;
        // QQ 官方推送可能乱序: 派发前统一按服务器时间戳升序排(旧→新)
        entries.sort((a, b) => a.ts - b.ts);
        // 触发消息形状(仅取 kind/gid 参考; 真正的 current 在群分支按时间序从 merged 里取)
        const trigger = entries[entries.length - 1];
        if (!trigger)
            return;
        const kind = String(trigger.msg.kind ?? '');
        dbg(`flush key=${key} n=${entries.length} sorted-order=[${entries.map(e => JSON.stringify(String(e.msg.content ?? '').slice(0, 24))).join(',')}] hasMention=${hasMention}`);
        try {
            if (kind === 'group') {
                const gid = String(trigger.msg.groupOpenid ?? trigger.msg.senderId ?? '');
                if (!gid)
                    return;
                // 群冷却吞掉的消息也已被 mediaHistoryBuffer(链第4步, 冷却/debounce 之前)记录进 store。
                // 因此以 store 为权威全量: 与窗口合并去重、按服务器时间序排列后,
                // current 取"时间上真正最后一条"(窗口含@时取最后一条被@的), 其余按序进 history ——
                // 避免 current 取成"群冷却放行的第一条"导致上下文整体倒序。
                let storeHist = [];
                try {
                    storeHist = await getHistoryStore(config.appId).list(historyGroupKey(config.appId, gid), num(config.historyLimit, 20));
                }
                catch (err) {
                    logger.warn?.(`[debounce] 拉群历史失败: ${err instanceof Error ? err.message : String(err)}`);
                }
                dbg(`  store-raw=[${storeHist.map(h => JSON.stringify(String(h.content).slice(0, 24))).join(',')}]`);
                // 合并去重 + "@ 判定以窗口条目为准" 的裁定逻辑抽在 mergeWindowWithStore()（可单测，见文件上部）
                const merged = mergeWindowWithStore(storeHist, entries);
                // current 恒取时间序最后一条(纯时间序, 上下文永不倒置)。
                // ⚠️ 2026-10-01 修（主人实测：引用块挂到上一条消息上）：
                //   cur 必须是**触发本次派发的那条**（= 窗口最后入队的那条），不能拿"时间最大"的 ——
                //   同批两条时间戳相同/乱序时它可能选错，于是 A 的附件(- Image:) 和 B 的引用被拼进同一条消息。
                const lastEntry = entries[entries.length - 1];
                const lastMid = String(lastEntry?.msg?.messageId ?? '');
                const cur = (lastMid ? merged.find((m) => String(m.messageId) === lastMid) : undefined) ?? merged[merged.length - 1];
                if (!cur)
                    return;
                // 忠实还原 store 原文进 history; 窗口内曾 @ 机器人的消息(时间上早于 current)
                // 补 " (@you)" 标注 —— 与 current 的 (@you) 同款格式, 还原"这条@了bot"的事实,
                // 由 AI 按自身守则决定是否开口(插件不注入回复指令, 保持通用)。
                // 忠实还原 store 原文进 history; 窗口内曾 @ 机器人的消息(时间上早于 current)
                // 补 " (@you)" 标注 —— 与 current 的 (@you) 同款格式, 还原"这条@了bot"的事实,
                // 由 AI 按自身守则决定是否开口(插件不注入回复指令, 保持通用)。
                //
                // ⚠️ 2026-09-15 修(主人实测「聚合里 @ 了她也不回话」):
                //   "这条 @ 了 bot" 不能只打成文本 (@you) 给 AI 看, **还得作为结构化标记 mentioned 随条目传下去** ——
                //   inbound 的聚合加权(AGG_MENTION_BOOST)与点名豁免(!aggMentioned)读的就是它。
                //   此前只打文本没带标记 ⇒ 评分链路里"窗口里 @ 了她"认不出来 ⇒ 低分被拦、点名不回。
                const hist = merged
                    .filter(m => m !== cur) // 用引用比较: 空 messageId 的合成消息彼此相等, 按 id 比会把它们全滤掉
                    .map(m => {
                    const baseContent = m.content ?? String(m.msg?.content ?? '');
                    return {
                        senderId: m.senderId ?? '',
                        senderName: m.senderName,
                        content: m.wasMentioned ? `${baseContent} (@you)` : baseContent,
                        timestamp: m.ts,
                        messageId: m.messageId,
                        ...(m.wasMentioned ? { mentioned: true } : {}),
                    };
                });
                // current 消息: 窗口条目有完整 msg; store 来源的只有 HistoryEntry 字段,
                // 从群窗口消息继承 kind/groupOpenid/attachments 等再补齐本人字段。
                const curMsg = cur.msg ?? {
                    ...(entries[entries.length - 1] ?? trigger).msg,
                    messageId: cur.messageId,
                    content: cur.content ?? '',
                    senderId: cur.senderId,
                    senderName: cur.senderName,
                    timestamp: new Date(cur.ts).toISOString(),
                };
                // 系统时间提示只在「LLM 回合中 defer 攒批」时带; 普通连发聚合(等用户停口)不带
                const state = { history: hist, aggregated: w.turnDeferred === true };
                // ⚠️ 2026-10-01 修：原来这里新建 state 只带 history/aggregated → 上游解析好的
                //   `ctx.state.quote` 被丢掉，**当前消息的引用块因此永远是空的**（历史行反而有，
                //   因为那是 media-history 在中间件链里记的）。踩了很久，勿删。
                // ⚠️ 2026-10-01: 引用要按**当前这条**的消息 id 取，不能用"窗口最后一次见到的 quote"
                //   （那可能是上一条消息的 → 引用块挂到别人头上）。
                const curQuote = lastMid && w.quoteByMsg ? w.quoteByMsg.get(lastMid) : undefined;
                if (curQuote)
                    state.quote = curQuote;
                else if (w.quote)
                    state.quote = w.quote;
                if (cur.wasMentioned) {
                    // current 本身就是 @ 消息 → 走正常 mention, AI 见 (@you)
                    state.mention = { wasMentioned: true };
                }
                else {
                    state.batchDispatch = true;
                }
                // ★ 2026-10-12：把"入站扩展强制入站"的标记**带给下游**（handleInbound 的
                //   `mwState.qqInboundForceWake`）—— 上游挂在 ctx.state 上的东西到这里是新 state，
                //   不带就丢；丢了的话价值评分照样会因为低分把这条拦掉（forceWake 就白写了）。
                if (hasForceWake)
                    state.qqInboundForceWake = true;
                dbg(`  merged-order=[${merged.map(m => JSON.stringify(String(m.content ?? m.msg?.content ?? '').slice(0, 16))).join(',')}] cur=${JSON.stringify(String(cur.content ?? cur.msg?.content ?? '').slice(0, 16))} hasMention=${hasMention}`);
                // 群普通(无@)批派发 → 记冷却(与群冷却中间件共享 lastDispatchAt, 防刷屏语义保留)
                // ⚠️ 2026-09-13(主人要求): 冷却要"**真产生回复**才算消耗" —— 批派发只是一次尝试,
                //    下游可能因价值评分低分而不唤醒(没回复) → 把回滚回调一并交下去, 让它还这枚冷却。
                if (!hasMention) {
                    const prev = cooldownAt.get(gid);
                    cooldownAt.set(gid, Date.now());
                    state.qqCooldownRollback = {
                        prev,
                        restore: () => { if (prev === undefined)
                            cooldownAt.delete(gid);
                        else
                            cooldownAt.set(gid, prev); },
                    };
                }
                logger.debug(`[debounce] flush(group ${gid}) 窗口${entries.length}条/store${storeHist.length}条 → handleInbound`);
                await handleInbound(curMsg, manager, config, logger, state);
            }
            else {
                // 私聊: 无群历史缓冲, 窗口自缓冲 → 文本按序拼接 + 合并附件成一条合成消息
                const textLines = entries
                    .map(e => String(e.msg.content ?? '').trim())
                    .filter(Boolean);
                const allAtts = [];
                for (const e of entries) {
                    const a = e.msg.attachments;
                    if (Array.isArray(a) && a.length > 0)
                        allAtts.push(...a);
                }
                const lastEntry = entries[entries.length - 1];
                const base = (lastEntry ?? trigger).msg;
                const merged = {
                    ...base,
                    content: textLines.join('\n'),
                    attachments: allAtts.length > 0 ? allAtts : undefined,
                };
                logger.debug(`[debounce] flush(c2c ${String(base.senderId ?? '')}) ${entries.length}条 → handleInbound`);
                await handleInbound(merged, manager, config, logger, {
                    aggregated: w.turnDeferred === true,
                    ...(w.quote ? { quote: w.quote } : {}),
                    // ★ 2026-10-12：私聊同样把 forceWake 带下去（私聊本来就每条都进站，这里只是不丢标记）
                    ...(hasForceWake ? { qqInboundForceWake: true } : {}),
                });
            }
        }
        catch (err) {
            logger.error(`[debounce] flush 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // 注册"合成消息入窗"能力(2026-09-12): 与真人消息同一窗口, 自动参与聚合/冷却/回合忙 defer
    INJECTORS.push((scope, peerId, text, opts, owner) => {
        // ⚠️ 多实例同进程共享本模块(INJECTORS 是模块级) → **只接自己那实例的请求**,
        //    否则会把 A 实例的群消息塞进 B 实例的窗口 → 会话会建到 B 的**工作区**(2026-09-12 实测踩到)。
        if (owner !== undefined && owner !== manager)
            return false;
        const c = cfg();
        const silenceMs = Math.max(0, num(c.silenceSec, DEFAULTS.silenceSec)) * 1000;
        const key = `${scope}:${peerId}`;
        const fake = {
            kind: scope,
            senderId: opts?.senderId || '', // 留空: 历史行渲染成 [资源助手] xxx, 不带难看的 (system)
            senderName: opts?.senderName || '资源助手',
            content: text,
            messageId: '',
            timestamp: new Date().toISOString(),
            groupOpenid: scope === 'group' ? peerId : undefined,
            msgType: 0,
        };
        if (c.enabled && silenceMs > 0) {
            // 聚合启用 → 塞进同一窗口(标 wasMentioned 以绕过"无@冷却"推迟, 保证这批能派发)
            let w = windows.get(key);
            if (!w) {
                w = { entries: [], timer: null };
                windows.set(key, w);
            }
            const ts = Date.now();
            w.entries.push({ msg: fake, wasMentioned: opts?.wasMentioned !== false, ts });
            clearTimer(w);
            w.timer = setTimeout(() => void flush(key, w), silenceMs);
            w.timer.unref?.();
            dbg(`inject ${key} n=${w.entries.length} text=${JSON.stringify(text.slice(0, 30))}`);
            logger.debug(`[debounce] 合成消息入窗 ${key}(窗口${w.entries.length}条): ${text.slice(0, 40)}`);
            return true;
        }
        // 聚合未启用 → 退化: 立即唤醒一轮(不再聚合)
        void handleInbound(fake, manager, config, logger, { mention: { wasMentioned: true } });
        logger.debug(`[debounce] 合成消息(聚合未启用) → handleInbound 立即唤醒: ${text.slice(0, 40)}`);
        return true;
    });
    return async (ctx, next) => {
        // 完全不思考(nothink, 2026-09-07 主人定): QQ 入站不唤醒 LLM, 但消息要照常进入上下文。
        // 这里直接交 handleInbound —— 它的 nothink 分支会把组装好的 user/message append 进会话
        // (不 followup 不唤醒), 下次 web/真人唤醒时 AI 看到完整记录。不走下方群冷却/派发链(防丢)。
        const outMode = config.outboundMode || 'adaptive';
        if (outMode === 'nothink') {
            const nm = ctx.message;
            const kind0 = String(nm.kind ?? '');
            // ★ 2026-10-31（issue #36）：先剥行首 @ 再判 `/`（群里 @bot 后正文以 <@id> 开头）
            const content0 = stripLeadingMentions(String(nm.content ?? ''));
            // 斜杠命令(/outmode 等)放行 → 走下方 slash 层(逃生通道: 主人可随时唤醒 nothink)
            if (content0.startsWith('/'))
                return next();
            if (kind0 === 'group' || kind0 === 'c2c') {
                try {
                    await handleInbound(nm, manager, config, logger, ctx.state);
                }
                catch (err) {
                    logger.error(`[nothink] handleInbound(append) 异常: ${err instanceof Error ? err.message : String(err)}`);
                }
                return; // 吞掉本消息(已 append 记录), 不触发任何回合
            }
            return next();
        }
        const c = cfg();
        if (!c.enabled)
            return next();
        const msg = ctx.message;
        const kind = String(msg.kind ?? '');
        if (kind !== 'group' && kind !== 'c2c')
            return next();
        // 斜杠命令不聚合: 保 /approve、/bot-stop、/help 等即时响应
        // ★ 2026-10-31（issue #36）：先剥行首 @ 再判（否则 "@bot /stop" 会被当普通消息聚合）
        const content = stripLeadingMentions(String(msg.content ?? ''));
        if (content.startsWith('/'))
            return next();
        const wasMentioned = ctx.state?.mention?.wasMentioned === true;
        // @ 可配置为不走延迟(秒回)
        if (wasMentioned && c.mentionDelayed === false)
            return next();
        const peerId = kind === 'group'
            ? (msg.groupOpenid ?? msg.senderId)
            : msg.senderId;
        if (!peerId)
            return next();
        const key = `${kind}:${String(peerId)}`;
        const silenceMs = Math.max(0, num(c.silenceSec, DEFAULTS.silenceSec)) * 1000;
        const maxMsgs = Math.max(1, Math.floor(num(c.maxMsgs, DEFAULTS.maxMsgs)));
        if (silenceMs <= 0)
            return next(); // 0=不停顿: 保持原链路立即派发
        let w = windows.get(key);
        if (!w) {
            w = { entries: [], timer: null };
            windows.set(key, w);
        }
        // 防御: 窗口保留等冷却期间可能持续进消息 → 超上限丢最老(只留最近 100 条)
        if (w.entries.length >= 100) {
            w.entries.splice(0, w.entries.length - 80);
        }
        const ts = msgTs(msg);
        const arrivedAt = Date.now();
        // 到达日志: 记录"到达本中间件的时刻"+"服务器时间戳", 用于对比官方帧序与真实发送序
        dbg(`arrive key=${key} at=${arrivedAt} ts=${String(msg.timestamp ?? '')} parsedTs=${ts} id=${String(msg.messageId ?? '').slice(0, 14)} mention=${wasMentioned} content=${JSON.stringify(content.slice(0, 30))}`);
        // 只有"比窗口现有消息更新"的消息才算最近说话者继续开口 → 重置静默计时;
        // 乱序补到的旧消息(服务器时间更早)只入窗口, 不延长等待。
        let maxTs = 0;
        for (let i = 0; i < w.entries.length; i++) {
            const e = w.entries[i];
            if (e && e.ts > maxTs)
                maxTs = e.ts;
        }
        const isNewer = ts >= maxTs;
        w.entries.push({
            msg: { ...msg }, wasMentioned, ts,
            // 2026-10-07: 插话只有文本通道 → 把中间件处理结果(语音转写)一起存着, 拼插话文本时用
            processed: ctx.state?.processed,
            // ★ 2026-10-12: 入站扩展的 forceWake 必须**随条目**存下来（flush 时会新建 state，见 hasForceWake）
            forceWake: ctx.state?.qqInboundForceWake === true,
        });
        // 2026-10-01: 把上游 quoteRef 解析好的引用存到窗口上（flush 时用）
        const _q = ctx.state.quote;
        if (_q) {
            w.quote = _q;
            // 2026-10-01: 同时按本条消息 id 绑一份 —— flush 时只认"当前这条"的引用
            const _mid = String(msg.messageId ?? '');
            if (_mid) {
                if (!w.quoteByMsg)
                    w.quoteByMsg = new Map();
                w.quoteByMsg.set(_mid, _q);
            }
        }
        dbg(`  win=${w.entries.length} new=${isNewer} order=[${w.entries.map(e => JSON.stringify(String(e.msg.content ?? '').slice(0, 16))).join(',')}]`);
        if (isNewer) {
            // 最近说话者(按服务器时间)刚又开口 → 重新等 ta 停口 silenceMs
            clearTimer(w);
            w.timer = setTimeout(() => void flush(key, w), silenceMs);
            w.timer.unref?.();
        }
        // 攒满上限立即发, 不等对方停
        if (w.entries.length >= maxMsgs) {
            void flush(key, w);
            return;
        }
        // 吞掉本消息(不调 next): 群消息已被链第4步 mediaHistoryBuffer 记录, 延迟到 flush 直连派发
    };
}
//# sourceMappingURL=debounce.js.map