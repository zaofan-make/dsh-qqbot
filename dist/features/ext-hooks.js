/**
 * ext-hooks.ts — 启动钩子扩展点（2026-10-12，第四套用户扩展）
 *
 * ── 它是什么 ───────────────────────────────────────────────────────────────
 * 前三套扩展都要"有人来触发"才跑：
 *   · `commands/` 要用户敲 `/命令`；· `tools/` 要 LLM 主动调用；· `botplay/` 要有人点卡片。
 * 有些事**没人触发也得跑**：恢复上次没跑完的长期任务、注册监听、起定时器、预取数据。
 * 于是有了这一套 —— 放在 `{dataRoot}/.qqbot-extensions/hooks/*.mjs`，
 * **dsh 启动（插件 apply 链路）时自动执行一次**，不需要任何调用方。
 *
 * ── 契约（与 docs / README / examples/ext-hooks 三处保持一致）─────────────
 * ```js
 * // {dataRoot}/.qqbot-extensions/hooks/hello.mjs
 * export async function run(env) {          // 也接受 `export default { run }` / `export default async (env) => {}`
 *   env.logger.info('[hello-hook] 起来了');
 *   return 'ok';                            // 返回值只记日志，不参与控制流
 * }
 * export async function dispose(env) {      // 可选：插件卸载 / 宿主退出时调用
 *   env.logger.info('[hello-hook] 再见');
 * }
 * ```
 * `env` = `{ ctx, logger, dataRoot, config, registerDispose, pluginVersion, hookFile, caps, store }`：
 *   · `ctx`    —— 插件自己的 cordis Context（"遥控器"，同 `env.kernel` 语义；能 `ctx.on()` / `ctx.get()`）
 *   · `logger` —— 插件 logger（带 `[ext-hook]` 前缀建议）
 *   · `dataRoot` / `config` —— 数据根与当前实例配置（只读用；要改设置请走设置页）
 *   · `registerDispose(fn)` —— 注册一个清理函数（返回 Promise 也行）；与导出的 `dispose()` 一样，
 *     都在插件卸载时被调用，**逆序**执行
 *   · `pluginVersion` —— 插件包版本号（`1.8.9` 这种），可按需做版本分支
 *   · `store.load()/save()` —— 该钩子自己的持久化（落 `{dataRoot}/.qqbot-extensions/hooks/data/<文件名>.json`）
 *
 * ── 铁律（都是"绝不能影响启动"派生出来的）─────────────────────────────────
 *  ① **单钩子隔离**：每个钩子独立 try/catch，失败/超时只 log 警告并继续下一个；
 *  ② **超时保护**：默认单钩子 30s（`timeoutMs`），超时只告警、不中断启动；
 *     超时的钩子**不会被强杀**（Node 里没法安全 kill 一个 promise），只是从启动路径上放行；
 *  ③ **目录缺失/为空完全安静**：不报错、不打日志（连 info 都不打）；
 *  ④ **每个钩子的名字与结果都记账**（成功/失败/超时），日志可读、返回值可诊断。
 *
 * ── 与 extension-store 的分工 ─────────────────────────────────────────────
 * 扫描约定（目录名、允许的扩展名、`?v=<mtime>` 做 cache-bust）复用 extension-store 的常量，
 * 但"加载成 SlashCommand / ExtensionToolDef"的归一化完全不是一回事 —— 钩子是"启动就跑的模块"，
 * 归一到 `run()/dispose()` 就够了，所以单独一个文件，不往 extension-store 里塞第四种形状。
 */
import { statSync } from 'node:fs';
import { scanExtFiles } from './ext-packs.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT_HOOKS_SUBDIR } from './extension-store.js';
import { makeExtCaps } from './ext-capabilities.js';
import { PLUGIN_VERSION } from '../shared/utils.js';
/** 单钩子默认超时（ms）：超过就只告警放行，绝不拖住插件启动 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
/** 扩展文件允许的扩展名（与 extension-store 的 ALLOWED_EXT 同款；这里按需再声明一次避免反向导出） */
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs']);
/** 已注册的清理函数（模块级：dispose 可能在加载还没跑完时就被调用，所以放模块级而非闭包） */
/** 归一化 key（Windows 大小写不敏感；其它平台保持原样，避免把两个合法目录合并） */
function hk(dataRoot) {
    // ★★ 2026-11-14（CodeRabbit）：反斜杠**只在 Windows 上**是分隔符。
    //   POSIX 上它是合法文件名字符 —— 无条件折叠会把 /tmp/bot\a 与 /tmp/bot/a
    //   （两个不同目录）合并成同一个清理桶。大小写同理。
    const raw = String(dataRoot || '');
    if (process.platform !== 'win32')
        return raw.replace(/\/+$/, '');
    return raw.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
/**
 * ★★ 2026-11-14 修（CodeRabbit 指出我只接了参数没真分桶）：
 *   原来 `disposers` / `disposed` 都是**全局单例** ⇒ 实例 A 卸载会跑掉实例 B 登记的清理项，
 *   而且 `disposed=true` 之后 B 新注册的清理会被**立刻执行**（订阅刚建就被退订）。
 *   现在按 dataRoot 分桶：每个实例只排空、只复位自己那一桶。
 */
const disposersByKey = new Map();
const disposedByKey = new Map();
/** 扩展钩子目录（相对数据根） */
export function extHooksDir(dataRoot) {
    return join(dataRoot, EXT_HOOKS_SUBDIR);
}
/**
 * 登记一个清理函数。
 * ⚠️ 卸载**已经发生过**之后再注册的，说明它是在"启动钩子还没 await 完、插件就被卸载"这条竞态路上
 * 登记的 —— 那种情况下没人会再来跑清理，所以这里**立即执行**，杜绝"注册了却永远不清理"。
 */
function pushDisposer(file, fn, logger, dataRoot) {
    const k = hk(dataRoot);
    if (disposedByKey.get(k) !== true) {
        const arr = disposersByKey.get(k) ?? [];
        arr.push({ file, fn });
        disposersByKey.set(k, arr);
        return;
    }
    void (async () => {
        try {
            await fn();
        }
        catch (err) {
            logger.warn?.(`[ext-hook] ${file} 卸载后登记的清理失败(已忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
    })();
}
/**
 * 把一个动态 import 的结果归一化成钩子。
 * 接受三种写法（都在文档里写了，别只支持一种）：
 *   ① `export function run(env) {}`              （具名导出，最直白）
 *   ② `export default { name, run, dispose }`    （对象默认导出，与 tools 同风格）
 *   ③ `export default async (env) => {}`         （裸函数默认导出，最短）
 * 返回 null = 形状不合法（缺 run），由调用方按"跳过"记账。
 */
function normalizeHook(mod, file, logger) {
    try {
        const raw = mod;
        const dflt = raw?.default;
        const name = String((typeof dflt === 'object' && dflt !== null ? dflt.name : undefined) ?? raw?.name ?? '').trim() || file.replace(/\.(mjs?|cjs)$/i, '');
        // ③ 裸函数默认导出
        if (typeof dflt === 'function') {
            const obj = dflt;
            return { name, run: dflt, ...(typeof obj.dispose === 'function' ? { dispose: obj.dispose } : {}) };
        }
        // ② 对象默认导出（优先）与 ① 具名导出
        const src = (typeof dflt === 'object' && dflt !== null ? dflt : raw);
        if (typeof src?.run !== 'function') {
            logger.warn(`[ext-hook] ${file}: 没有可执行的 run —— 需 \`export function run(env)\` 或 \`export default { run }\`，已跳过`);
            return null;
        }
        return {
            name,
            run: src.run,
            ...(typeof src.dispose === 'function' ? { dispose: src.dispose } : {}),
        };
    }
    catch (err) {
        logger.warn(`[ext-hook] ${file}: 归一化失败 ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/**
 * 带超时的 await：超时**不 kill** 原 promise（Node 做不到安全强杀），只让启动路径放行。
 * ⚠️ 超时窗口关闭后原 promise 才 reject（钩子自己抛了异步错）也不能变成 unhandledRejection
 *    —— 先给它挂一个空 catch 观察者（`.catch()` 的返回值我们不 await，但它自己永不 reject）。
 */
async function withTimeout(p, ms) {
    let timer;
    // 空观察者：只负责"接住"迟到的 rejection，不改变下面 race 的结果
    void p.catch(() => undefined);
    try {
        return await Promise.race([
            p.then((value) => ({ ok: true, value })),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), Math.max(1, ms));
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/hooks/*.mjs` 并**逐个执行**。
 *
 * 目录不存在 / 目录为空 → 直接返回空汇总，**不打任何日志**（这是最常见的正常状态）。
 * 单个钩子失败或超时 → 只记 `warn`，继续下一个；本函数**永不抛出**。
 */
export async function runStartupHooks(opts) {
    const { dataRoot, logger } = opts;
    // ★ 2026-10-12 修（真 bug）：**新一轮生命周期开始，必须把 disposed 复位**。
    //   不重置的话，下面这条链会把刚起来的钩子当场拆掉：
    //     启动 → runStartupHooks（此时 disposed=false，正常）→ 保存连接设置触发网关重建
    //     → dispose 里调 disposeStartupHooks() ⇒ disposed=true → 重新 bootstrap
    //     → 再次 runStartupHooks，钩子调 registerDispose() 时看到 disposed===true
    //     ⇒ pushDisposer 走"卸载后登记 ⇒ 立即执行"分支 ⇒ 注册即被清理（刚订阅就退订）。
    //   `disposeStartupHooks` 已经把 disposers 清空，所以这里只补复位标志即可。
    disposedByKey.set(hk(dataRoot), false); // 只复位本实例：别的实例可能正在卸载，不能替它复位
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? Number(opts.timeoutMs)
        : DEFAULT_HOOK_TIMEOUT_MS;
    const empty = { total: 0, ok: 0, failed: 0, timedOut: 0, skipped: 0, results: [] };
    // ★ 2026-10-24：内置目录 + 所有扩展包（只取直接子文件）
    const hits = scanExtFiles(dataRoot, 'hooks', ALLOWED_EXT);
    if (hits.length === 0)
        return empty;
    const files = hits.map((h) => h.name);
    logger.info(`[ext-hook] 发现 ${files.length} 个启动钩子，开始执行（单钩子超时 ${timeoutMs}ms）`);
    const summary = { total: 0, ok: 0, failed: 0, timedOut: 0, skipped: 0, results: [] };
    for (const hit of hits) {
        const f = hit.name;
        const abs = hit.abs;
        const started = Date.now();
        try {
            // Windows 绝对路径必须转 file:// URL；cache-bust 用 mtime（与 extension-store 同款，别改回时间戳）
            const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
            const mod = await import(url);
            const hook = normalizeHook(mod, f, logger);
            if (!hook) {
                summary.skipped += 1;
                summary.results.push({ file: f, path: abs, name: f, status: 'skipped', ms: 0 });
                continue;
            }
            summary.total += 1;
            // 本钩子的清理收集器：registerDispose(fn) 与导出 dispose() 都进这里
            const registered = [];
            const caps = makeExtCaps({
                dataRoot,
                logger,
                kernel: opts.ctx,
                selfName: f,
                kind: 'hooks',
                // ── 2026-10-13：钩子也要能“自报家门 + 自己开口” ─────────────────
                //   凭证：钩子要发消息/换 token 时不该再让用户手填一份（与 bot 实例同一份）。
                //   owners：钩子判断“这条要不要送给主人”时要看。
                //   wakeTo：钩子没有“当前消息”，只能显式点名目标会话（见 RunStartupHooksOptions）。
                appId: opts.appId,
                appSecret: opts.appSecret,
                owners: opts.owners,
                wakeTo: opts.wakeTo,
            });
            const env = {
                ctx: opts.ctx,
                logger,
                dataRoot,
                config: opts.config,
                registerDispose: (fn) => {
                    if (typeof fn !== 'function')
                        return;
                    registered.push(fn);
                },
                pluginVersion: PLUGIN_VERSION,
                hookFile: abs,
                caps,
                store: caps.store,
            };
            // 清理登记**先做**：即使后面 run 超时/失败，它已经注册的清理函数也照样要跑
            pushDisposer(f, async () => {
                // registerDispose 逆序 → 后注册的先清理（与嵌套资源的习惯一致）
                for (const fn of [...registered].reverse()) {
                    try {
                        await fn();
                    }
                    catch (err) {
                        logger.warn?.(`[ext-hook] ${f} registerDispose 清理失败(已忽略): ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                if (hook.dispose) {
                    try {
                        await hook.dispose(env);
                    }
                    catch (err) {
                        logger.warn?.(`[ext-hook] ${f} dispose() 失败(已忽略): ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }, logger, dataRoot);
            const raced = await withTimeout(Promise.resolve(hook.run(env)), timeoutMs);
            const ms = Date.now() - started;
            if (!raced.ok) {
                summary.timedOut += 1;
                summary.results.push({ file: f, path: abs, name: hook.name, status: 'timeout', ms, error: `超过 ${timeoutMs}ms 未返回` });
                logger.warn(`[ext-hook] ${hook.name} (${f}) 超时 ${timeoutMs}ms —— 已放行继续启动（它仍在后台跑）`);
                continue;
            }
            summary.ok += 1;
            summary.results.push({ file: f, path: abs, name: hook.name, status: 'ok', ms });
            logger.info(`[ext-hook] ✓ ${hook.name} (${f}) ${ms}ms`);
        }
        catch (err) {
            const ms = Date.now() - started;
            const msg = err instanceof Error ? err.message : String(err);
            summary.failed += 1;
            summary.results.push({ file: f, path: abs, name: f, status: 'error', ms, error: msg });
            logger.warn(`[ext-hook] ✗ ${f} 执行失败(已跳过, 不影响启动与其它钩子): ${msg}`);
        }
    }
    if (summary.results.length > 0) {
        logger.info(`[ext-hook] 启动钩子执行完毕: 成功 ${summary.ok} / 失败 ${summary.failed} / 超时 ${summary.timedOut}` +
            (summary.skipped > 0 ? ` / 跳过 ${summary.skipped}` : ''));
    }
    return summary;
}
/**
 * 调用所有钩子登记的清理函数（导出 `dispose()` + `registerDispose(fn)`）。
 *
 * 由 `bootstrapGateway` 的 dispose 链路调用（插件卸载 / 宿主退出 / 保存连接设置后重建网关）。
 * 纪律：逆序执行（后启动的先清理）、**单个失败只告警**、整体永不抛出、幂等。
 */
export async function disposeStartupHooks(logger, dataRoot) {
    // ★★ 2026-11-14：只排空**本实例**那一桶。
    //   原来取全局 disposers 并置全局 disposed=true ⇒ A 卸载会跑掉 B 的清理项。
    const k = hk(dataRoot);
    disposedByKey.set(k, true);
    const list = disposersByKey.get(k) ?? [];
    disposersByKey.delete(k);
    let n = 0;
    for (const item of [...list].reverse()) {
        n += 1;
        try {
            await item.fn();
        }
        catch (err) {
            logger.warn?.(`[ext-hook] ${item.file} 清理异常(已忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (n > 0)
        logger.info?.(`[ext-hook] 已清理 ${n} 个启动钩子的注册项`);
    return n;
}
/** 重置模块级状态（仅供单元测试；生产不要调 —— 会把正在跑的钩子的清理登记丢掉） */
export function __resetStartupHooksForTest() {
    disposersByKey.clear();
    disposedByKey.clear();
}
/** 当前已登记清理函数的钩子数（诊断用） */
export function startupHooksDisposeCount() {
    let total = 0;
    for (const arr of disposersByKey.values())
        total += arr.length;
    return total;
}
/** 文件版本号（mtime，秒级取整）—— 与 extension-store.fileVersion 同款纪律，别改回时间戳 */
function fileVersion(p) {
    try {
        return String(Math.floor(statSync(p).mtimeMs));
    }
    catch {
        return String(Date.now());
    }
}
//# sourceMappingURL=ext-hooks.js.map