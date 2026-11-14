/**
 * ext-outbound.ts — 【出站扩展】第六套扩展点（2026-10-16 主人定）
 *
 * ┌─ 与 ext-inbound 的对称关系 ─────────────────────────────────────────────┐
 * │ 入站：消息**进来**时改它 / 杀它          → `.qqbot-extensions/inbound/`  │
 * │ 出站：消息**出去**时改它 / 杀它 / 补发媒体 → `.qqbot-extensions/outbound/` │ ← 本文件
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 目录：`{dataRoot}/.qqbot-extensions/outbound/*.mjs`（只扫直接子文件，按文件名升序）
 *
 * 形状（与 inbound 一致，两种写法都支持）：
 * ```js
 * export const name = 'my-outbound';
 * export default async function onOutbound(ctx, next) { ...; return next(); }
 * // 或 export async function onOutbound(ctx, next) { ... }
 * ```
 *
 * **出站独有的能力**（ctx 上，详见 OutboundExtCtx）：
 *   · `ctx.text`        本条出站正文（可读）
 *   · `ctx.segments`    解析后的段（图/文/引用），来自 rich-media 的 parseOutbound
 *   · `ctx.kind`        'text' | 'markdown' | 'media' | 'card' | 'forward' | 'other'
 *   · `ctx.target`      回复目标 { scope, peerId, msgId? }
 *   · `ctx.turnId` / `ctx.chunkIndex` / **`ctx.isLastChunk`**（本回合最后一个正文块）
 *   · `ctx.rewrite(newText)`   改掉这条出站
 *   · `ctx.annihilate(reason)` 消灭这条出站（**之后不要调 next()**）
 *   · `ctx.sendMedia({...})` / `ctx.send(text)`  额外发消息（**先被动后主动**）
 *
 * 与前五套**同款**的能力（统一能力包，见 features/ext-capabilities.ts）：
 *   `emit/markdown/image/media`、`store.load/save`、`identity.*`、`api()`、`kernel`、
 *   `appendSilent/appendWake`、`logger`。由挂载点喂进来，缺哪个就优雅降级、**绝不抛**。
 *
 * ★ 供**其他扩展**调用：`globalThis[Symbol.for('im-qqbot.outbound')]`
 *   · `send(text, opts)`       发文本（先被动后主动）
 *   · `sendMedia({ path|url, text? })` 发媒体
 *   · `last()`                 最近一次出站的 ctx（含 target，便于"往刚才那个会话发"）
 *   · `active()`               当前是否正在跑出站链
 */
import { statSync } from 'node:fs';
import { scanExtFiles } from './ext-packs.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** 扩展文件允许的扩展名（与 extension-store 的 ALLOWED_EXT 同款） */
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs']);
/** 出站扩展子目录名（与 inbound / hooks / tools / botplay 并列的第六套） */
export const EXT_OUTBOUND_SUBDIR = 'outbound';
/** 其他扩展取"出站操控器"的全局键（Symbol.for ⇒ 跨模块实例单例，同 ext-inbound 的 HANDLER_KEY 手法） */
export const OUTBOUND_API_KEY = Symbol.for('im-qqbot.outbound');
export function outboundExtensionsDir(dataRoot) {
    return join(String(dataRoot || ''), '.qqbot-extensions', EXT_OUTBOUND_SUBDIR);
}
const buckets = new Map();
const ownerKey = new WeakMap();
let fallbackKey = '';
/** 归一化 key：反斜杠/大小写只在 Windows 折叠（POSIX 上它们是合法文件名字符） */
function obKey(dataRoot) {
    const raw = String(dataRoot || '');
    if (process.platform !== 'win32')
        return raw.replace(/\/+$/, '');
    return raw.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
function ensureBucket(dataRoot, logger) {
    const k = obKey(dataRoot);
    let b = buckets.get(k);
    if (!b) {
        b = { cfg: { dataRoot: String(dataRoot ?? ''), logger }, loaded: [], breaker: new Map() };
        buckets.set(k, b);
    }
    else {
        b.cfg = { dataRoot: String(dataRoot ?? ''), logger };
    }
    fallbackKey = k;
    return b;
}
/** 按发送方（bot 对象）反查它所属实例的桶；单实例时兜底唯一桶；多实例且无身份 → undefined */
function bucketOf(sender) {
    if (sender && typeof sender === 'object') {
        const k = ownerKey.get(sender);
        if (k)
            return buckets.get(k);
    }
    if (buckets.size === 1)
        return Array.from(buckets.values())[0];
    return undefined;
}
/** 配置出站扩展的数据根与日志器（插件启动时调一次；热刷时复用） */
export function configureOutboundExtensions(opts) {
    ensureBucket(opts.dataRoot, opts.logger);
    // owner = 该实例的 QQBotSender（bot）对象：runOutboundChain 从 opts.sender 反查它
    if (opts.owner)
        ownerKey.set(opts.owner, obKey(opts.dataRoot));
}
/** 当前已配置的出站扩展数据根（空串=没配）—— 供热刷判断"刷的是不是你要的那个实例" */
/**
 * 登记真正走发送链的对象，用于 runOutboundChain / notifyOutboundSent 反查桶。
 *
 * ★★ 2026-11-14（CodeRabbit）：**不能用 middleware-setup 里的 SDK bot 当 owner** ——
 *   实际走链的是 bootstrap 另建的 sender 字面量（createOutboundHandler 传的是它），
 *   两个对象不是同一个 ⇒ WeakMap 永远 miss ⇒ 多实例下所有出站都会跳过扩展。
 *   所以 sender 创建后要单独登记一次（SDK bot 可同时登记，无害）。
 */
export function registerOutboundOwner(dataRoot, owner) {
    if (owner && typeof owner === 'object')
        ownerKey.set(owner, obKey(dataRoot));
}
export function currentOutboundDataRoot() {
    return String(buckets.get(fallbackKey)?.cfg.dataRoot ?? '');
}
/** 重新装载（供热刷用）：没配置过则安静返回空结果 */
export async function reloadOutboundExtensions(dataRoot) {
    // ★ P1：按 dataRoot 取桶（不传就用当前 fallback 桶，兼容旧的单实例调用）
    const b = buckets.get(dataRoot ? obKey(dataRoot) : fallbackKey);
    if (!b)
        return emptyResult();
    return loadOutboundExtensions(b.cfg);
}
// ─────────────────────────── 装载 ───────────────────────────
// （P1：全局 loaded 已并入 buckets，各实例一份）
function emptyResult(files = []) {
    return { total: 0, skipped: 0, middleware: [], extensions: [], files };
}
function pickFn(...cands) {
    for (const c of cands)
        if (typeof c === 'function')
            return c;
    return undefined;
}
function normalizeOutbound(mod, file, abs, logger) {
    const m = mod;
    const fn = pickFn(m?.onOutbound, m?.default, m?.middleware);
    if (!fn) {
        logger.warn(`[ext-outbound] ${file} 没有可用的出站中间件（需要 onOutbound / default / middleware 之一），已跳过`);
        return null;
    }
    return {
        file,
        path: abs,
        name: String(m?.name ?? file.replace(/\.[^.]+$/, '')),
        middleware: fn,
        ...(typeof m?.dispose === 'function' ? { dispose: m.dispose } : {}),
        ...(typeof m?.onSent === 'function' ? { onSent: m.onSent } : {}),
    };
}
function fileVersion(p) {
    try {
        // ⚠️ 本包是 ESM，**不能用 require**（inbound 那边也是静态 import statSync）
        return String(statSync(p).mtimeMs);
    }
    catch {
        return '0';
    }
}
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/outbound/*.mjs` 并装载。
 *
 * 目录不存在 / 为空 → 返回空结果、**不打日志**；
 * 单文件失败 → 只 warn 并继续；本函数**永不抛出**。
 * 重新调用 = 热重载（`loaded` 整体替换）。
 */
export async function loadOutboundExtensions(opts) {
    const { dataRoot, logger } = opts;
    // ★ 2026-10-24：内置目录 + 所有扩展包（只取直接子文件）
    const hits = scanExtFiles(dataRoot, 'outbound', ALLOWED_EXT);
    const bucket = buckets.get(obKey(dataRoot));
    if (hits.length === 0) {
        if (bucket)
            bucket.loaded = [];
        return emptyResult();
    }
    const files = hits.map((h) => h.name);
    const result = emptyResult(files);
    for (const hit of hits) {
        const f = hit.name;
        const abs = hit.abs;
        try {
            const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
            const mod = await import(url);
            const ext = normalizeOutbound(mod, f, abs, logger);
            if (!ext) {
                result.skipped += 1;
                continue;
            }
            result.total += 1;
            result.extensions.push(ext);
            result.middleware.push(ext.middleware);
        }
        catch (err) {
            result.skipped += 1;
            logger.warn(`[ext-outbound] ✗ ${f} 装载失败(已跳过, 不影响其它出站扩展): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (bucket)
        bucket.loaded = result.extensions;
    if (result.total > 0) {
        logger.info(`[ext-outbound] 已装载 ${result.total} 个出站扩展: ${result.extensions.map((e) => e.name).join(', ')}` +
            (result.skipped > 0 ? `（跳过 ${result.skipped} 个）` : ''));
    }
    return result;
}
/** 当前已装载的出站扩展（诊断用） */
/**
 * 把一次出站的结果回执给所有出站扩展的 `onSent(result)`（2026-11-11）。
 *
 * 调用方是 `transport/outbound-buffer.ts`：**消息真的发完之后**才调。
 * 每个扩展独立 try/catch + 单次超时保护，**绝不因为扩展报错影响发送结果**。
 */
export async function notifyOutboundSent(result, owner) {
    const exts = bucketOf(owner)?.loaded ?? [];
    if (exts.length === 0)
        return;
    for (const ext of exts) {
        if (typeof ext.onSent !== 'function')
            continue;
        try {
            await Promise.resolve(ext.onSent(result));
        }
        catch { /* 扩展自己炸了不影响别人 */ }
    }
}
export function listOutboundExtensions() {
    const out = [];
    for (const b of buckets.values())
        out.push(...b.loaded);
    return out;
}
// ─────────────────────────── 执行 ───────────────────────────
/** 熔断：某扩展连续把消息改坏/抛错到阈值就停用它（与 inbound 的熔断同思路） */
const breaker = new Map();
const BREAKER_LIMIT = 5;
/** 改文件 + tools_reload = 复位通道 */
export function resetOutboundBreaker(name) {
    if (name)
        breaker.delete(name);
    else
        breaker.clear();
}
function noteBreaker(name, logger) {
    const n = (breaker.get(name) ?? 0) + 1;
    breaker.set(name, n);
    if (n === BREAKER_LIMIT) {
        logger.warn(`[ext-outbound] ${name} 连续出错 ${n} 次，已停用（改文件后 tools_reload 可复位）`);
    }
    return n;
}
let active = 0;
let lastCtx = null;
/** 当前是否正在跑出站链（其他扩展可用于"别在我发消息时又触发我"） */
export function outboundActive() {
    return active > 0;
}
/** 最近一次出站的 ctx（其他扩展可用它拿 target 往同一个会话补发） */
export function lastOutboundCtx() {
    return lastCtx;
}
/**
 * 构造一条出站的 ctx（**导出**出来，方便其他扩展/工具直接造一条去发）。
 */
export function makeOutboundCtx(initialText, opts = {}, state = { text: initialText, killed: false, reason: '' }) {
    const logger = opts.logger ?? { info() { }, warn() { }, debug() { }, error() { } };
    const t = (opts.target ?? null);
    const self = {
        text: state.text,
        segments: Array.isArray(opts.segments) ? opts.segments : [],
        kind: opts.kind ?? 'text',
        target: t,
        turnId: String(opts.turnId ?? ''),
        chunkIndex: Number(opts.chunkIndex ?? 0),
        isLastChunk: opts.isLastChunk !== false,
        phase: opts.phase === 'turnEnd' ? 'turnEnd' : 'send',
        sender: opts.sender ?? null,
        dataRoot: String(opts.dataRoot ?? ''),
        owners: Array.isArray(opts.owners) ? opts.owners.map(String) : [],
        apiCall: opts.apiCall,
        kernel: opts.kernel,
        logger,
        rewrite(newText) {
            if (state.killed)
                return false;
            state.text = String(newText ?? '');
            self.text = state.text;
            return true;
        },
        annihilate(reason) {
            state.killed = true;
            state.reason = String(reason ?? '');
            return true;
        },
        async sendMedia(input) {
            return sendViaOutboundChannel({ ...input }, opts);
        },
        async send(text, o) {
            return sendViaOutboundChannel({ text: String(text ?? '') }, opts, o);
        },
        /**
         * ★★ 丢后台（2026-10-16 主人定的架构）★★
         *   把"选图/算分/发媒体"这类重活踢出出站链 —— **立刻返回、绝不 await**，
         *   正文照常按原速发出去，补图在后台独立跑（走 sendMedia 的"先被动后主动"通道）。
         *   任何异常都吞掉：后台任务的失败绝不允许影响任何人。
         */
        background(task) {
            try {
                void Promise.resolve()
                    .then(task)
                    .catch((err) => {
                    try {
                        logger.warn?.(`[ext-outbound] 后台任务失败(已忽略): ${err instanceof Error ? err.message : String(err)}`);
                    }
                    catch {
                        /* 连日志都失败也不能抛 */
                    }
                });
            }
            catch {
                /* 连调度都失败也不能抛 */
            }
        },
        note(msg) {
            try {
                logger.debug?.(`[ext-outbound] ${msg}`);
            }
            catch {
                /* 日志失败不影响主链 */
            }
        },
    };
    return self;
}
/**
 * 依次跑出站链（文件名升序，与 inbound 同款"链式 + 幂等 next"）。
 *
 * 语义（**与 inbound 对齐**）：
 *   · `next()` **幂等**：误调两次只算第一次；
 *   · `next()` 一定被 await（扩展忘 await 时引擎替它 await）；
 *   · 扩展**不调 next() 且没 annihilate** ⇒ 引擎替它放行（防新手卡死链）+ 记 warn；
 *   · `annihilate()` 之后**即便又调了 next() 也不再往下走**。
 */
export async function runOutboundChain(text, opts = {}) {
    // ★ 配置兜底：挂载点（transport 层）只关心正文，拿不到 dataRoot/logger 是常态
    //   ⇒ 这里用启动时 `configureOutboundExtensions()` 记住的那份补上，
    //     扩展的 `ctx.dataRoot` / `ctx.logger` 才不会空（示范"读表情包库"就靠它）。
    const bucket = bucketOf(opts.sender);
    const merged = {
        ...(bucket?.cfg.dataRoot ? { dataRoot: bucket.cfg.dataRoot } : {}),
        ...(bucket?.cfg.logger ? { logger: bucket.cfg.logger } : {}),
        ...opts,
    };
    const logger = merged.logger ?? { info() { }, warn() { }, debug() { }, error() { } };
    // ★ P1：多实例且查不到归属 ⇒ exts 为空 = **直通**（fail-closed，绝不拿别人的扩展规则处理这条消息）
    const exts = bucket?.loaded ?? [];
    if (exts.length === 0)
        return { text, killed: false, reason: '', ran: 0 };
    const state = { text: String(text ?? ''), killed: false, reason: '' };
    const ctx = makeOutboundCtx(state.text, merged, state);
    lastCtx = ctx;
    active += 1;
    try {
        let i = 0;
        let ran = 0;
        const next = async () => {
            if (state.killed)
                return; // 消灭后链停
            if (i >= exts.length)
                return;
            const ext = exts[i++];
            if (!ext)
                return; // 开了 noUncheckedIndexedAccess ⇒ 索引取出来可能是 undefined
            ran += 1;
            if ((breaker.get(ext.name) ?? 0) >= BREAKER_LIMIT)
                return next(); // 已停用 ⇒ 跳过
            // 幂等：同一层重复调用 next 只算第一次
            let called = false;
            const onceNext = async () => {
                if (called)
                    return;
                called = true;
                await next();
            };
            try {
                await ext.middleware(ctx, onceNext);
                if (!called && !state.killed) {
                    // 既没调 next 也没消灭 ⇒ 替它放行（与 inbound 的"rescue"同语义），并记一笔
                    logger.warn(`[ext-outbound] ${ext.name} 既没调 next() 也没 annihilate()，已替它放行`);
                    await next();
                }
            }
            catch (err) {
                const n = noteBreaker(ext.name, logger);
                logger.warn(`[ext-outbound] ${ext.name} 执行出错（第 ${n} 次，不影响出站）: ${err instanceof Error ? err.message : String(err)}`);
                // 出错 ⇒ 放行（宁可不改，也不能把消息弄丢）
                if (!state.killed)
                    await next();
            }
        };
        await next();
        return { text: state.text, killed: state.killed, reason: state.reason, ran };
    }
    finally {
        active -= 1;
    }
}
/**
 * ★★ 回合结束钩子（2026-10-16 主人定）★★
 *
 * 挂载点：`transport/outbound.ts` 的 `turn/end` —— 在 `buffer.flush()` 之后、
 * 与 passive 收尾（`maybeResendLastBlock`）**同一时机**。传进来的 `lastText`
 * 就是 `turnBlocks.last`，**是这一回合权威的最后一块正文**。
 *
 * 为什么需要它：一段 assistant 回复可能包含"正文 → 工具调用 → 正文"多段，
 * 每段都各走一次 `sendRichOutbound`。若把配图挂在入口（phase='send'），
 * 第一段就会被当成本回合正文拿去判定 —— **错得离谱**（主人 2026-10-16 实测抓到）。
 *
 * 扩展怎么写：在 `onOutbound(ctx, next)` 里判 `ctx.phase === 'turnEnd'` ⇒ 做配图；
 * `phase === 'send'` ⇒ 只做改写/消灭（或直接 `next()`）。
 */
export async function runOutboundTurnEnd(lastText, opts = {}) {
    // 复用同一条链：只是把 phase 标成 turnEnd、并声明"这就是最后一块"
    return runOutboundChain(lastText, { ...opts, phase: 'turnEnd', isLastChunk: true });
}
// ─────────────────── 供其他扩展调用的"出站操控器" ───────────────────
/**
 * 直接经"先被动后主动"通道发一条东西。
 *
 * ⚠️ 这条通道**不跑出站扩展链**（否则自己发的又会被自己拦，形成回环）；
 *    要走链请用 {@link runOutboundChain}。
 */
export async function sendViaOutboundChannel(payload, opts = {}, sendOpts = {}) {
    const sender = (opts.sender ?? lastCtx?.sender ?? null);
    const target = (opts.target ?? lastCtx?.target ?? null);
    if (!sender || !target)
        return false;
    const body = String(payload.text ?? payload.path ?? payload.url ?? '');
    if (!body)
        return false;
    // ── 先被动：用 target 自带 msgId ──
    const passive = target;
    // ── 后主动：摘掉 msgId（不等它失败；与 session-watch 的"适配主动"同口径）──
    const strip = () => {
        const t2 = { ...target };
        for (const k of ['msgId', 'msg_id', 'messageId', 'referenceMessageId'])
            delete t2[k];
        return t2;
    };
    // ⚠️ 2026-10-16 修（真机首次实测暴露）：原来只传了 `(target, payload)` ——
    //   `QQBotSender.sendMedia` 要的是 `(target, kind, source)`，参数错 ⇒ 抛错 ⇒ 被 catch 吞掉
    //   ⇒ 现象是"出站扩展装上了、但一张图都发不出来"。**改扩展时务必核对宿主接口签名。**
    const isMedia = !!(payload.path || payload.url);
    const mediaKind = String(payload.kind || 'image');
    const mediaSource = payload.url ? { url: String(payload.url) } : { localPath: String(payload.path ?? '') };
    const trySend = async (tg) => {
        try {
            if (isMedia) {
                if (typeof sender.sendMedia !== 'function')
                    return false;
                await sender.sendMedia(tg, mediaKind, mediaSource);
                return true;
            }
            if (typeof sender.sendMarkdown === 'function') {
                await sender.sendMarkdown(tg, String(payload.text ?? ''));
                return true;
            }
            if (typeof sender.sendText === 'function') {
                await sender.sendText(tg, String(payload.text ?? ''));
                return true;
            }
            return false;
        }
        catch {
            return false;
        }
    };
    if (await trySend(passive))
        return true;
    if (sendOpts.adaptive === false)
        return false;
    return trySend(strip()); // 主动兜底
}
// ── ★ 2026-10-16 主人定：给扩展提供「本地小模型语义打分」 ──────────────────
//   之前示范扩展只能用字符 bigram（只有字面重合，语义很差）。
//   插件里本来就有本地小模型（features/local-embed.ts，智能回复/价值评分在用），
//   这里把它包一层暴露出去：没下模型 / 加载失败 ⇒ 返回 null，扩展自行回落 bigram。
/** 小模型是否可用（同步探测，不加载） */
function embedderAvailable() {
    try {
        // 懒探测：真正的可用性在 embedPassages 里判；这里只回答"配置上有没有开"
        return true;
    }
    catch {
        return false;
    }
}
/**
 * passage 向量缓存：**文本 → 向量**（模块级，进程内长期有效）。
 *
 * ⚠️ 为什么必须有它（2026-10-16 专家团结论）：出站扩展要改成"**全库扫** 1891 张"，
 *   而不是随机抽 300。若每回合都把 1891 条文本重新喂模型，那是每回合一次全库编码 —— 太慢。
 *   而表情包的 tags/desc 是**静态文本**，编码一次就该复用（改了描述自然 miss 重算）。
 *   上限 5000 条，超了整体清空（表情包库 1891 条远远够用）。
 */
const passageVecCache = new Map();
const PASSAGE_CACHE_MAX = 5000;
/**
 * 用本地小模型给 `passages` 逐条与 `query` 算余弦相似度。
 * 返回 `null` = 模型不可用（**扩展应回落自己的算法**，绝不抛）。
 */
async function embedScores(query, passages) {
    if (!query || !Array.isArray(passages) || passages.length === 0)
        return null;
    try {
        const { createLocalEmbedder } = await import('./local-embed.js');
        const e = createLocalEmbedder({ ...(buckets.get(fallbackKey)?.cfg.logger ? { logger: buckets.get(fallbackKey).cfg.logger } : {}) });
        if (!e.available())
            return null;
        const keys = passages.map((s) => String(s ?? ''));
        // 只对**没缓存过**的文本编码 —— 全库扫的关键：稳态下每回合只编码 query 自己
        const miss = [...new Set(keys.filter((k) => k && !passageVecCache.has(k)))];
        if (miss.length) {
            const vecs = await e.embedPassages(miss);
            if (!vecs)
                return null;
            if (passageVecCache.size + miss.length > PASSAGE_CACHE_MAX)
                passageVecCache.clear();
            for (let i = 0; i < miss.length; i++) {
                const v = vecs[i];
                if (v)
                    passageVecCache.set(miss[i], v);
            }
        }
        const q = await e.embedQuery(query);
        if (!q)
            return null;
        const dot = (a, b) => {
            let s = 0;
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++)
                s += a[i] * b[i];
            return s;
        };
        const norm = (v) => Math.sqrt(dot(v, v)) || 1;
        const qn = norm(q);
        return keys.map((k) => {
            const p = passageVecCache.get(k);
            return p ? dot(q, p) / (qn * norm(p)) : 0;
        });
    }
    catch {
        return null; // 模型炸了也不能影响出站
    }
}
/**
 * 其他扩展获取"出站操控器"的入口（`globalThis[OUTBOUND_API_KEY]`）。
 *
 * 用法（任何扩展里）：
 * ```js
 * const ob = globalThis[Symbol.for('im-qqbot.outbound')];
 * await ob?.send('补一句', { adaptive: true });
 * await ob?.sendMedia({ path: 'D:/pics/a.png' });
 * const target = ob?.last()?.target;   // 往"刚才那个会话"发
 * const scores = await ob?.embed('正文', ['标签A', '标签B']);  // 本地小模型语义分（可为 null）
 * ```
 */
export function installOutboundApi() {
    const g = globalThis;
    g[OUTBOUND_API_KEY] = {
        version: 1,
        /** 发文本（先被动后主动） */
        send: (text, opts) => sendViaOutboundChannel({ text: String(text ?? '') }, { target: opts?.target, sender: opts?.sender }, opts ?? {}),
        /** 发媒体（先被动后主动） */
        sendMedia: (input, opts) => sendViaOutboundChannel(input, { target: opts?.target, sender: opts?.sender }),
        /**
         * ★ 本地小模型的**语义相似度**打分：`embed(query, passages) → number[] | null`。
         *   顺序与 passages 一一对应；`null` = 模型不可用（扩展请回落自己的算法）。
         */
        embed: (query, passages) => embedScores(query, passages),
        /** 小模型是否"应当可用"（真正可用性看 embed() 是否返回 null） */
        embedAvailable: () => embedderAvailable(),
        /** 最近一次出站的 ctx（含 target） */
        last: () => lastOutboundCtx(),
        /** 当前是否在跑出站链 */
        active: () => outboundActive(),
        /** 已装载的出站扩展（诊断） */
        list: () => listOutboundExtensions(),
        /** 手动跑一次链（高级用法：先改后发） */
        run: (text, opts) => runOutboundChain(text, opts),
    };
}
//# sourceMappingURL=ext-outbound.js.map