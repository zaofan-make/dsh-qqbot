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
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scanExtFiles } from './ext-packs.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** 扩展文件允许的扩展名（与 extension-store 的 ALLOWED_EXT 同款） */
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs']);
/** 出站扩展子目录名（与 inbound / hooks / tools / botplay 并列的第六套） */
/**
 * ★ CodeRabbit #87（第 5 轮）：**当前正在执行的出站扩展名**。
 *
 * 为什么不用 `state.extension`：它是共享可变状态，只在中间件同步执行期有效；
 * `ctx.background()` 不阻塞链，后台任务真正跑的时候它早被恢复/被下一个扩展占了 ⇒
 * `ctx.store` 会写错文件。AsyncLocalStorage 跟着异步调用链走（`Promise.resolve().then`
 * 会自动继承），并发也安全 —— 与 `reasoning-bus.ts` 的 ownerStore 同一个套路。
 */
const extAls = new AsyncLocalStorage();
/** 当前异步上下文里的扩展对象（不在任何扩展里时是 undefined） */
function currentExt() {
    return extAls.getStore();
}
/** 当前异步上下文里的扩展名（不在任何扩展里时是空串） */
function currentExtName() {
    return extAls.getStore()?.name ?? '';
}
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
function ensureBucket(dataRoot, logger, apiCall) {
    const k = obKey(dataRoot);
    let b = buckets.get(k);
    if (!b) {
        b = { cfg: { dataRoot: String(dataRoot ?? ''), logger, ...(apiCall !== undefined ? { apiCall } : {}) }, loaded: [], breaker: new Map(), urls: new Map() };
        buckets.set(k, b);
    }
    else {
        b.cfg = { dataRoot: String(dataRoot ?? ''), logger, ...(apiCall !== undefined ? { apiCall } : {}) };
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
    ensureBucket(opts.dataRoot, opts.logger, opts.apiCall);
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
    return { total: 0, skipped: 0, middleware: [], extensions: [], files, cachedPaths: [], scannedPaths: [] };
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
    // ★ 2026-11-21（issue #78 / CodeRabbit #80）：装载期间标出"这批回调属于哪个实例"，
    //   这样 `/tools_reload` 只清掉本实例的思考回调（别的实例不重载，清了就再也回不来）。
    //
    //   ★ 第 2 轮复审：归属不能存全局变量 —— 装载是 `await import()`，两个实例并发装载会互相覆盖。
    //   改成 AsyncLocalStorage：归属跟着这次 `run()` 的异步调用链走。
    const rb = await import('./reasoning-bus.js').catch(() => undefined);
    const ownerRoot = String(dataRoot || '');
    for (const hit of hits) {
        const f = hit.name;
        const abs = hit.abs;
        try {
            const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
            // ★ CodeRabbit #80（第 3/4 轮）：URL 与上次相同 ⇒ ESM 缓存命中，模块**不会重新执行**。
            //   用**绝对路径**做 key：`scanExtFiles` 不按文件名去重，不同目录同名扩展会串。
            result.scannedPaths.push(abs);
            const cached = bucket?.urls.get(abs) === url;
            if (cached)
                result.cachedPaths.push(abs);
            // ★ 归属细化到"实例#文件"：这样恢复时可以只挑"命中缓存 / 这次没装载"的那些模块。
            const doImport = () => import(url);
            const mod = (rb && typeof rb.runWithReasoningOwner === 'function'
                ? await rb.runWithReasoningOwner(`${ownerRoot}#${abs}`, doImport)
                : await doImport());
            bucket?.urls.set(abs, url);
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
    // ★★ 2026-11-14 修（审查发现）：`resetOutboundBreaker()` 原来**全仓无调用点** ——
    //   扩展一旦被熔断（连续把消息改坏/抛错），只有重启插件才能恢复，/tools-reload 也没用。
    //   装载 = 复位，与入站扩展的"改文件后重载即恢复"保持一致。
    for (const e of result.extensions) {
        try {
            resetOutboundBreaker(e.name);
        }
        catch { /* ignore */ }
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
/** 单个出站扩展 onSent 的超时（超时只放弃它，不影响其它扩展与发送结果） */
const NOTIFY_TIMEOUT_MS = 3000;
/** 给单个 Promise 套超时；超时 reject，调用方自己吞 */
function withTimeoutSingle(p, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('onSent timeout')), ms);
        if (typeof t.unref === 'function')
            t.unref();
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
export async function notifyOutboundSent(result, owner) {
    const exts = bucketOf(owner)?.loaded ?? [];
    if (exts.length === 0)
        return;
    // ★★ 2026-11-14 修（审查发现）：注释一直写着「单次超时保护」，实现却只有 try/catch，
    //   而且是**串行 await** —— 一个扩展卡住（比如在 onSent 里做了网络请求）会拖住后面所有扩展，
    //   还会拖住调用方（发送完成后的收尾）。改成**并行 + 单个超时**：互不拖累。
    await Promise.allSettled(exts.filter((e) => typeof e.onSent === 'function').map(async (ext) => {
        try {
            // ★ 2026-11-24（子代理复核 Major）：这里**必须**包 ALS —— 发送完成后链早已退出，
            //   不包的话 `ctx.store` 会落进 shared 文件（实测两个扩展互相覆盖）。
            await withTimeoutSingle(extAls.run(ext, () => Promise.resolve(ext.onSent(result))), NOTIFY_TIMEOUT_MS);
        }
        catch { /* 扩展自己炸了/超时，不影响别人，也不影响发送结果 */ }
    }));
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
/**
 * 扩展调 `send(text)` **没给 target** 时，是否回落到"最近一次出站的会话"。
 *
 * ★ 2026-11-21（issue #78）：默认 **false（fail-closed）**。
 *   旧行为是回落 ⇒ 多会话并发/思考流这类"没有明确目标"的发送会串台
 *   （实测：私聊任务的思考草稿发进了无关的群）。业界主流（Slack/Telegram/Discord）
 *   也都是"没有 channel 就拒发"。真要旧行为，把配置 `outboundLastCtxFallback` 打开。
 *
 * ★ CodeRabbit #80：开关按**发送器实例**存（WeakMap），不是模块级单变量 ——
 *   否则后启动的实例（默认 false）会把先启动实例的 true 覆盖掉。
 */
const fallbackByOwner = new WeakMap();
/** 拒发告警节流：第一次必打，之后每 200 次打一次 */
let rejectedNoTarget = 0;
/** 由 bootstrap 按配置设置（每个实例各自一份，互不影响） */
export function setOutboundLastCtxFallback(owner, v) {
    if (owner && typeof owner === 'object')
        fallbackByOwner.set(owner, v === true);
}
/**
 * 记下"当前发送器"（bootstrap 建好 sender 时调），供设置页保存时热改开关 ——
 * 否则面板改了 `outboundLastCtxFallback` 只更新 config，发送侧读的仍是启动时那份 WeakMap。
 *
 * ★ CodeRabbit：**按实例（settingsNs）绑**，不能只留一个 —— 多实例时"最后启动的那个"会顶掉前面的，
 *   保存 A 的设置反而改到 B 的开关。
 */
const senderByNs = new Map();
export function setOutboundSender(ns, sender) {
    if (!sender || typeof sender !== 'object')
        return;
    senderByNs.set(String(ns || 'im-qqbot'), sender);
}
export function outboundSenderOf(ns) {
    return senderByNs.get(String(ns || 'im-qqbot')) ?? null;
}
/** 诊断用：该发送器是否允许回落 */
export function outboundLastCtxFallbackEnabled(owner) {
    if (!owner || typeof owner !== 'object')
        return false;
    return fallbackByOwner.get(owner) === true;
}
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
    /**
     * 造一份绑定到具体扩展名的 store。
     *
     * ★ CodeRabbit #87（第 5 轮）：
     *   - 文件名用 `outbound-<安全名>-<8位hash>.json`：纯替换会把 `扩展甲`/`扩展乙` 都压成 `_`（互相覆盖），
     *     加 8 位哈希保证唯一，同时保留可读前缀。
     *   - `save(obj)` 整表写也要先 `readAll().ok` —— 坏文件时不能覆盖。
     */
    // ★ 子代理复核 m2：getter 每次访问都新建对象 + 重算 sha1（实测 17.6µs/次），
    //   而且 `ctx.store !== ctx.store` 这种引用不稳定会让扩展的写法很别扭。按扩展名缓存。
    const storeCache = new Map();
    const storeForCached = (extensionName) => {
        let s = storeCache.get(extensionName);
        if (!s) {
            s = storeFor(extensionName);
            storeCache.set(extensionName, s);
        }
        return s;
    };
    const storeFor = (extensionName) => {
        const raw = String(extensionName || 'shared');
        const safe = raw.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'x';
        const hash = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8);
        const dir = join(String(opts.dataRoot ?? ''), '.qqbot-extensions', 'data');
        const file = join(dir, 'outbound-' + safe + '-' + hash + '.json');
        // ★ 子代理复核 m1：多一个 `existed` —— 用来区分"文件不存在"（load() 应返回 undefined，
        //   与 caps.store 一致）和"文件存在但是空表"（返回 {}）。
        const readAll = () => {
            const out = Object.create(null);
            if (!opts.dataRoot)
                return { ok: false, existed: false, data: out };
            let raw2 = '';
            try {
                raw2 = readFileSync(file, 'utf8');
            }
            catch (e) {
                const code = e?.code;
                return { ok: code === 'ENOENT', existed: false, data: out };
            }
            try {
                const v = JSON.parse(raw2);
                if (!v || typeof v !== 'object' || Array.isArray(v))
                    return { ok: false, existed: true, data: out };
                for (const k of Object.keys(v)) {
                    Object.defineProperty(out, k, {
                        value: v[k],
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
                }
                return { ok: true, existed: true, data: out };
            }
            catch {
                return { ok: false, existed: true, data: out };
            }
        };
        const writeAll = (all) => {
            if (!opts.dataRoot)
                return false;
            // ★ CodeRabbit 第 6 轮：根表上可调用的 `toJSON` 会被 JSON.stringify 当钩子调用，
            //   把整表换成它返回的值（比如 []）—— 数据直接没了还返回 true。拒绝写入，保留旧文件。
            //   非函数值（普通字符串等）当键名照常允许。
            if (typeof all.toJSON === 'function')
                return false;
            try {
                mkdirSync(dir, { recursive: true });
                const tmp = file + '.tmp-' + process.pid;
                writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
                renameSync(tmp, file);
                return true;
            }
            catch {
                return false;
            }
        };
        return {
            load: (k) => {
                const r = readAll();
                if (!r.ok)
                    return undefined;
                if (k === undefined) {
                    // ★ 子代理复核 m1：① 没文件 → undefined（与 caps.store 一致，别让扩展把 {} 当"有数据"）
                    //                  ② 返回**普通对象** —— 原来直接返回 Object.create(null) 的，
                    //                     扩展写 data.hasOwnProperty(x) / data.toString() 会直接 TypeError
                    if (!r.existed)
                        return undefined;
                    const plain = {};
                    for (const kk of Object.keys(r.data)) {
                        Object.defineProperty(plain, kk, {
                            value: r.data[kk],
                            enumerable: true,
                            configurable: true,
                            writable: true,
                        });
                    }
                    return plain;
                }
                const key = String(k);
                return Object.prototype.hasOwnProperty.call(r.data, key) ? r.data[key] : undefined;
            },
            save: (k, v) => {
                // ★ 整表写（`save(obj)`）也要拒绝覆盖坏文件
                if (k && typeof k === 'object') {
                    // 顺序：先验旧文件（坏文件不覆盖）→ 再复制（getter 抛错也不冒泡）→ 最后写
                    if (!readAll().ok)
                        return false;
                    const all = Object.create(null);
                    try {
                        for (const kk of Object.keys(k)) {
                            Object.defineProperty(all, kk, {
                                // ★ CodeRabbit 第 6 轮：取值可能触发 getter 抛错 —— 必须在 try 里，
                                //   否则调用方拿不到 false，异常直接冒到出站链。
                                value: k[kk],
                                enumerable: true,
                                configurable: true,
                                writable: true,
                            });
                        }
                    }
                    catch {
                        return false;
                    }
                    return writeAll(all);
                }
                const key = String(k ?? '');
                if (!key)
                    return false;
                const r = readAll();
                if (!r.ok)
                    return false;
                Object.defineProperty(r.data, key, { value: v ?? null, enumerable: true, configurable: true, writable: true });
                return writeAll(r.data);
            },
        };
    };
    const self = {
        text: state.text,
        segments: Array.isArray(opts.segments) ? opts.segments : [],
        kind: opts.kind ?? 'text',
        source: opts.source ?? 'unknown',
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
        // ★ 2026-11-24（社区补丁 Bemly/dsh-plug 指出）：由挂载点提供，缺则 undefined；异常一律 fail-soft
        ...(typeof opts.appendWake === 'function'
            ? {
                appendWake: async (text) => {
                    try {
                        const r = await opts.appendWake(String(text ?? ''));
                        // ★ 子代理复核 m6：原来 `r !== false` 会把 undefined/void 当成成功。
                        //   挂载点喂进来的是 Promise<boolean>，所以这里要求**明确 true**。
                        return r === true;
                    }
                    catch {
                        return false;
                    }
                },
            }
            : {}),
        // ★ 2026-11-24：静默注入 / 官方 API —— 由挂载点喂进来，缺则 undefined
        ...(typeof opts.appendSilent === 'function'
            ? {
                appendSilent: async (text) => {
                    try {
                        const r = await opts.appendSilent(String(text ?? ''));
                        return r === true;
                    }
                    catch {
                        return false;
                    }
                },
            }
            : {}),
        ...(typeof opts.apiCall === 'function'
            ? {
                // ★ CodeRabbit：apiCall 契约是 (method, path, body)；用 async+try/catch 才能同时接住
                //   同步抛错和 Promise 拒绝（只挂 .catch 接不住同步抛）
                api: async (path) => {
                    try {
                        return await opts.apiCall('GET', String(path ?? ''));
                    }
                    catch (err) {
                        return { ok: false, err: { code: 'THROWN', human: err instanceof Error ? err.message : String(err) } };
                    }
                },
            }
            : {}),
        // ★ 2026-11-24（主人要求补齐"契约承诺但没实现"）：出站扩展此前只有 send/sendMedia 两个动作，
        //   其余能力类型上留了口却一个都没接。这里按"能用现有通道实现的就地实现"补齐：
        //   emit/markdown/image/media 走 send/sendMedia；store 落 dataRoot；identity 从 opts 取。
        emit(text) {
            // ★ 2026-11-24（子代理复核 Major）：**走统一入口**，只多传一个 preferText。
            //   上一版在 ctx 里自己调 sender.sendText：① 绕过了 sendViaOutboundChannel 的空串校验
            //   ⇒ `emit('')` 会真的发出一条空消息还返回 true；② 生产 sender 根本没有 sendText，
            //   那段分支是死代码（测试还因此假通过）。现在：空串由统一入口拒掉，
            //   有 sendText 用 sendText，没有就降级 sendMarkdown。
            const ownTarget = (opts.target ?? self.target ?? undefined);
            return sendViaOutboundChannel({ text: String(text ?? '') }, { ...opts, target: ownTarget }, { preferText: true });
        },
        markdown(text) {
            // ★ CodeRabbit：直接复用 self.send —— 它内部就**优先走 sendMarkdown**，
            //   且自带"先被动后主动"（被动 msgId 失效时会摘掉 msgId 重发）。
            //   自己再实现一遍只会丢掉主动兜底：msgId 一死就永远发不出去。
            return self.send(String(text ?? ''));
        },
        image(src) {
            // ★ 子代理审查 M5：原来无条件 `{ url: src }` —— 本地路径和 `{localPath}` 对象都会变成畸形参数，
            //   失败还被 catch 吞成 false（无日志）。现在按 url/本地路径两种形态分别发。
            const s = src && typeof src === 'object'
                ? String(src.url ?? src.localPath ?? '')
                : String(src ?? '');
            if (!s)
                return Promise.resolve(false);
            const isUrl = /^https?:\/\//i.test(s) || s.startsWith('qqbot-media://');
            return self.sendMedia({ kind: 'image', ...(isUrl ? { url: s } : { path: s }) });
        },
        media(kind, source, text) {
            // ★ CodeRabbit：kind 必须一路带到发送通道，否则 video/voice/file 全被当图片发
            const src = String(source ?? '');
            if (!src)
                return Promise.resolve(false);
            const k = String(kind || 'image').toLowerCase();
            const isUrl = /^https?:\/\//i.test(src) || src.startsWith('qqbot-media://');
            const sent = self.sendMedia({
                kind: k,
                ...(isUrl ? { url: src } : { path: src }),
            });
            // ★ 子代理审查 M4：第三个参数以前是**假参数**（塞进 payload 但没人读）。
            //   现在媒体发出去后补一条配文；媒体失败就不补（避免只发文字）。
            if (!text)
                return sent;
            return sent.then(async (ok) => {
                // ★ 子代理复核 m4：配文属纯文本，走 emit（preferText）而不是 send（会优先 markdown）
                if (ok)
                    await self.emit(String(text));
                return ok;
            });
        },
        identity: {
            // ★ 子代理复核 m5：出站 ctx **没有"当前发送者"的概念**，但原来 identity.user 是 undefined、
            //   identity 本身恒为真值 ⇒ 扩展写 `if (ctx.identity) ctx.identity.user.x` 直接 TypeError。
            //   这里给一个明确的空值对象：字段都在、值都是"没有"。
            user: { openid: '', name: '', isOwner: false },
            owners: Array.isArray(opts.owners) ? opts.owners.map(String) : [],
            ...(t
                ? { peer: { scope: String(t.scope ?? ''), peerId: String(t.peerId ?? '') } }
                : {}),
        },
        /**
         * 出站扩展的 KV。**兼容两种写法**（M1）：`load()` 整对象 / `load(k)` 单键；
         * `save(obj)` 整表 / `save(k,v)` 单键。
         *
         * ★ CodeRabbit #87（第 5 轮）：改成 **getter** —— 每次访问按"当前正在执行的扩展"算文件名。
         *   原来在对象字面量里立即求值、闭包里读 `state.extension`，而 `ctx.background()` 不阻塞链，
         *   后台任务真正跑的时候 `state.extension` 早就被恢复/被下一个扩展占用了 ⇒ 会写错文件。
         *   现在访问时才取：扩展名由 AsyncLocalStorage 传递（`background` / `transform` / `onSent`
         *   都会继承或显式包一层），**不是**靠临时改 state.extension。
         */
        get store() {
            // ★ 子代理复核 m4：没有 dataRoot 就别给 store —— 原来会给一个"能拿到但永远存不上"的对象，
            //   扩展以为存成功了（save 返回 false 却容易被忽略）。直接 undefined，让 `if (ctx.store)` 就能判断。
            if (!opts.dataRoot)
                return undefined;
            // ★ 优先 ALS（后台任务里也能拿到正确的扩展名），其次才是同步执行期的 state
            return storeForCached(currentExtName() || state.extension?.name || 'shared');
        },
        rewrite(newText) {
            if (state.killed)
                return false;
            state.text = String(newText ?? '');
            self.text = state.text;
            return true;
        },
        transform(fn) {
            if (state.killed || self.phase !== 'send')
                return false;
            // ★ CodeRabbit 第 6 轮：用 ALS 里的扩展，而不是共享的 state.extension ——
            //   扩展调 next() 之后才登记变换时，state.extension 已指向下游扩展，
            //   记错归属会导致"变换抛错却熔断下游"。
            (state.transforms ??= []).push({ fn, extension: currentExt() ?? state.extension });
            return true;
        },
        annihilate(reason) {
            state.killed = true;
            state.reason = String(reason ?? '');
            return true;
        },
        async sendMedia(input) {
            // ★ 2026-11-24（CodeRabbit 第 6 轮 / CWE-200）：**只能用本 ctx 自己的 target**。
            //   上一版加了 `lastCtx?.target` 兜底 —— 那是**模块级、跨会话**的：扩展在后台任务里发消息时，
            //   若别的会话刚更新过 lastCtx，消息就发到别人那儿去了；而且它绕过 outboundLastCtxFallback 开关。
            //   `self.target` 就是"这条出站"的目标（= opts.target），足够覆盖多段回复；
            //   两者都空说明这条出站本就没有明确目标 ⇒ 交给 sendViaOutboundChannel 的 fail-closed 拒发。
            //   ⚠️ 例外：配置 `outboundLastCtxFallback` 打开时，sendViaOutboundChannel 内部仍会回落到 lastCtx
            //      （那是**全局开关**的语义，不属于 ctx 私自放宽）。
            const ownTarget = (opts.target ?? self.target ?? undefined);
            return sendViaOutboundChannel({ ...input }, { ...opts, target: ownTarget });
        },
        async send(text, o) {
            const ownTarget = (opts.target ?? self.target ?? undefined);
            return sendViaOutboundChannel({ text: String(text ?? '') }, { ...opts, target: ownTarget }, o);
        },
        /**
         * ★★ 丢后台（2026-10-16 主人定的架构）★★
         *   把"选图/算分/发媒体"这类重活踢出出站链 —— **立刻返回、绝不 await**，
         *   正文照常按原速发出去，补图在后台独立跑（走 sendMedia 的"先被动后主动"通道）。
         *   任何异常都吞掉：后台任务的失败绝不允许影响任何人。
         */
        background(task) {
            // ★ CodeRabbit #87（第 5 轮）：后台任务靠 AsyncLocalStorage 继承扩展名（见 currentExtName），
            //   **不要**在这里临时改 state.extension —— 那是共享可变状态，两个扩展的后台任务会互相覆盖。
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
        // ★ 2026-11-15：出站扩展也要能发**按钮卡片**、调官方 API（`/会话列表` 那种 msg_type:2），
        //   而 apiCall 原来只给了入站/命令/工具三套，出站这边漏了 ⇒ ctx.apiCall 恒为 undefined。
        ...(bucket?.cfg.apiCall ? { apiCall: bucket.cfg.apiCall } : {}),
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
            const previousExtension = state.extension;
            state.extension = ext;
            try {
                // ★ 用 ALS 标记"这段异步调用链属于哪个扩展"——ctx.store / background 都靠它
                await extAls.run(ext, () => ext.middleware(ctx, onceNext));
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
            finally {
                state.extension = previousExtension;
            }
        };
        await next();
        let messages;
        if (!state.killed && state.transforms?.length) {
            messages = [{ text: state.text, kind: ctx.kind, source: ctx.source }];
            for (const { fn, extension } of state.transforms) {
                if (extension && (breaker.get(extension.name) ?? 0) >= BREAKER_LIMIT)
                    continue;
                try {
                    // ★ CodeRabbit 第 6 轮：变换是**链尾**才执行的，那时早已退出该扩展的 ALS 作用域 ⇒
                    //   变换里调 ctx.store 会读到 shared 文件。这里用"登记它的扩展"重新建作用域。
                    const runTransform = (message) => {
                        const out = fn(message);
                        // ★ 2026-11-15（issue #62）：**返回值必须校验**。
                        //   扩展很容易把变换写成 `async (m) => ...`（想读个文件/查个词库），
                        //   而 `flatMap` 不会等待 Promise ⇒ 它会把这个 Promise 当成"一条消息"塞进列表，
                        //   transport 随后读 `msg.text` 得到 undefined ⇒ **整条消息变成空字符串发不出去**，
                        //   而且不进 catch（Promise 没 reject）、不计熔断、扩展自己也收不到失败回调。
                        //   这里把它变成一次**明确的异常**：走下面现成的 catch（warn + 熔断 + 保留原消息）。
                        if (out !== null && out !== undefined && typeof out.then === 'function') {
                            throw new Error('transform 必须同步返回，不能返回 Promise（去掉 async）');
                        }
                        if (out === null || out === undefined)
                            return [];
                        const list = Array.isArray(out) ? out : [out];
                        // 逐条校验：必须是对象且 text 是字符串 —— 否则 transport 那边同样会炸
                        return list.filter((m) => {
                            if (!m || typeof m !== 'object')
                                return false;
                            const text = m.text;
                            if (typeof text !== 'string')
                                return false;
                            return true;
                        });
                    };
                    messages = messages.flatMap((message) => (extension ? extAls.run(extension, () => runTransform(message)) : runTransform(message)));
                }
                catch (err) {
                    if (extension)
                        noteBreaker(extension.name, logger);
                    logger.warn(`[ext-outbound] ${extension?.name ?? 'transform'} 内容变换失败，保留本次变换前的消息: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        return { text: state.text, killed: state.killed, reason: state.reason, ran, ...(messages ? { messages } : {}) };
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
    const ownerObj = (opts.sender ?? lastCtx?.sender ?? null);
    const allowFallback = ownerObj ? fallbackByOwner.get(ownerObj) === true : false;
    // ★ CodeRabbit #80（第 2 轮）：**sender 始终可以回落** —— 它是"机器人的发送器"，不涉及"发给谁"，
    //   跨会话用同一个 sender 不会串台。只有 **target** 才必须 fail-closed。
    //   否则显式给了 target 的调用（如全局 send 包装只传 target 不传 sender）会因缺 sender 被拒发。
    const sender = (opts.sender ?? lastCtx?.sender ?? null);
    const target = (opts.target ?? (allowFallback ? lastCtx?.target : null) ?? null);
    if (!sender || !target) {
        // ★ 2026-11-21（issue #78）：没有明确 target 就**拒发**（除非显式开了回落）。
        //   以前这里静默回落到 lastCtx ⇒ 并发会话串台；现在至少留一行日志，便于发现"扩展少传了 target"。
        rejectedNoTarget += 1;
        if (rejectedNoTarget === 1 || rejectedNoTarget % 200 === 0) {
            const { logger } = opts;
            const warn = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : undefined;
            warn?.(`[ext-outbound] 拒绝发送：调用方没给 target（第 ${rejectedNoTarget} 次；outboundLastCtxFallback=${allowFallback}）`);
        }
        return false;
    }
    const body = String(payload.text ?? payload.path ?? payload.url ?? '');
    // ★ 子代理复核 m1：只判 `!body` 挡不住纯空白（`emit('   ')` 会真的发一条空格消息）。
    //   用 trim 判空，但**内容本身不 trim**（路径里可能有合法空格）。
    if (!body.trim())
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
            // ★ 2026-11-24（子代理复核 Major）：preferText 让"纯文本"语义走同一条入口；
            //   生产 sender 没有 sendText ⇒ 自动降级到下面的 sendMarkdown。
            if (sendOpts.preferText && typeof sender.sendText === 'function') {
                await sender.sendText(tg, String(payload.text ?? ''));
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