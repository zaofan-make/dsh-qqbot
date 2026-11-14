/**
 * ext-inbound.ts — 入站中间件扩展点（2026-10-12，第五套用户扩展）
 *
 * ── 它是什么 ───────────────────────────────────────────────────────────────
 * 前四套扩展里，没有一套能**影响入站消息本身**：
 *   · `commands/`（用户敲命令）、`tools/`（LLM 调工具）、`botplay/`（有人点卡片）都要"有人触发"；
 *   · `hooks/` 只在**启动时跑一次**，那时消息还没来。
 * 可有些规则必须**每条入站消息都过一遍**，而且要能左右这条消息的命运：
 *   "这个人在禁言名单里 → 整条别进来"、"这条先过一层敏感词改写"、"求助关键词来了必须叫醒她"、
 *   "这条虽然 @ 了我，但它是引用子会话转发 → 别当 @ 处理"。
 * 于是有了这一套 —— 放在 `{dataRoot}/.qqbot-extensions/inbound/*.mjs`。
 *
 * ── 两个挂点（2026-10-12 扩成两个；位置是硬要求，别挪）─────────────────────
 *
 * ```
 * … → quoteRef → ★onInbound（早）★ → 引用图预取 → 群历史缓冲 → 表情/台账
 *   → mentionGate（@ 门控）→ ★默认导出 / onDecide（晚，原有）★
 *   → contentSanitizer → debounce（延迟聚合）→ 命令 → 冷却 → 并发合并 → envelope → AI
 * ```
 *
 * | | **早：`onInbound`** | **晚：`onDecide` / `export default`** |
 * |---|---|---|
 * | 链上位置 | quoteRef 之后、**记群历史之前** | mentionGate 之后、contentSanitizer 之前 |
 * | 读得到 | `ctx.message` / `ctx.state.quote` / `ctx.platform.mentioned` | 上面这些 **+ `ctx.state.mention`**（门控判定） |
 * | 做得了 | **消灭**（不进历史/不进上下文/不占冷却）、**改写**（历史里就是改后文本）、**强制入站**、查/写禁言名单 | **覆盖 @ 判定**（`ctx.decide`）、改写、强制入站、查/写禁言名单 |
 * | 做不了 | `ctx.decide`（`ctx.state.mention` 还没写出来）；除"不调 next()"外没有别的拦截手段 | **消灭**（群历史已经记了；`ctx.annihilate` 会明确拒绝并告警） |
 *
 * 一个文件可以**同时导出两个挂点**（互不影响）；只导出默认导出 = 旧契约，语义等同 `onDecide`。
 *
 * ```js
 * // {dataRoot}/.qqbot-extensions/inbound/my-rule.mjs
 * export async function onInbound(ctx, next) {   // 早：消灭/改写/强制入站/查禁言
 *   if (isSpam(ctx.text)) { ctx.annihilate({ reason: '广告' }); return; }   // 不调 next = 整条消失
 *   ctx.rewrite({ text: ctx.text.replace(/敏感词/g, '***') });               // 记历史之前生效
 *   return next();
 * }
 * export default async function onDecide(ctx, next) {  // 晚：@ 覆盖（原有契约，语义一个字没变）
 *   if (ctx.state?.mention?.wasMentioned === true && isChildSessionQuote(ctx.state.quote?.text)) {
 *     ctx.decide({ mention: 'ignore', reason: '引用子会话转发' });
 *   }
 *   return next();
 * }
 * export function dispose() { … }   // 可选：插件卸载时清理（本模块起了定时器/监听才需要）
 * ```
 * 也接受 `export const onInbound = …` / `export const middleware = …` / `export async function middleware(ctx, next) {}` /
 * `export default { name, onInbound, onDecide, middleware, dispose }`；`name` 只用于日志展示。
 *
 * ── 与 `hooks/` 的区别（最容易混的一处）──────────────────────────────────
 *   · `hooks/`  = **启动时跑一次**（没人触发也跑），给它的是 `env`，管"起定时器/注册监听/恢复任务"；
 *   · `inbound/` = **每条入站消息都过一遍**，给它的是 `(ctx, next)`，管"这条消息怎么处理"。
 *   两者不通用：入站扩展写成 `run(env)` 不会被装载，钩子写成 `(ctx, next)` 也不会被装载。
 *
 * ── 动作 API（用户看到的就是这些；实现在 features/ext-inbound-context.ts）──
 * ```js
 * // 消息维（早挂点）：消灭 / 改写 / 强制入站
 * ctx.annihilate({ reason })   // 消灭：不进历史、不进上下文、不占冷却（内部=不 next）
 * ctx.rewrite({ text, reason })// 替换文本（早挂点在记历史之前 ⇒ 群历史里也是改后文本）
 * ctx.forceWake({ reason })    // 强制入站：跳过价值评分/@门控/冷却等一切"值不值得回"的判断
 * // 消息维（晚挂点）：ctx.decide({ mention: 'ignore' | 'force', reason }) —— 覆盖 @ 判定
 * // 用户维（两个挂点都能用）：ctx.muteUser({ id?, minutes, reason }) / ctx.unmuteUser({ id? })
 * //                          ctx.isMuted(id?) / ctx.mutedUsers()（带剩余时间；minutes<=0 = 永久）
 * // 通用：ctx.text / ctx.scope / ctx.sender / ctx.senderName / ctx.isOwner / ctx.groupId / ctx.mentions
 * //       ctx.quoted({text,fromSelf}) / ctx.platform({mentioned}) / ctx.logger / ctx.dataRoot
 * //       ctx.kv.get(key) / ctx.kv.set(key, value)   ← 每个扩展自己的持久化
 * ```
 * 每个动作**内部 try/catch，任何情况下都不抛到链上**；出错只 warn 并返回 false。
 *
 * ── 铁律（都是"绝不能因为用户脚本坏了就吞消息"派生出来的）──────────────────
 *  ① **单扩展隔离**：每个扩展独立 try/catch，抛错只 `warn` 并**继续往下走**（该消息照常派发给 AI）；
 *  ② **next() 一定被 await**：扩展忘了 await，引擎替它 await —— 否则下游没跑完，中间件链的顺序保证就断了；
 *  ③ **next() 幂等**：扩展误调两次只算第一次（SDK 的 `next() called multiple times` 会直接炸整条链）；
 *  ④ **消灭 = 不调 next()**：早挂点里置位 `annihilate` 后，**即便又调了 next() 也不再往下走**
 *     （链停在这里 ⇒ 连群历史都不会记）；
 *  ⑤ **目录缺失/为空完全安静**：不报错、不打日志（这是最常见的正常状态）；
 *  ⑥ 只扫**根下直接子文件**、扩展名 `.js/.mjs/.cjs`、按文件名排序、`?v=<mtime>` 做 cache-bust
 *     —— 全部与 `hooks/`、`tools/` 的既有约定一致（`.state/` 这类子目录不会被当扩展装载）。
 *
 * ── 四条保命件（实现在 ext-inbound-context.ts + ext-inbound-state.ts）──────
 *   · **白名单最高优先**：主人（`config.groupAdmin.owners`）永不可被消灭/静默 ——
 *     拒执行 + warn + 消息照常放行（`annihilate`/`muteUser` 都拦）。
 *     ⚠️ 光"拒绝动作"不够：扩展最常见的写法是 `if (该消灭) { ctx.annihilate(); return; }`，
 *     那个 `return`（=不调 next）仍然会把链停住 ⇒ **引擎会替它放行**（见下"兜底放行"）。
 *   · **强唤醒优先于静默**：`forceWake` 不被 `annihilate` 以外的东西抵消（顺序由扩展自己排，
 *     文档里写明"求助关键词判断要写在黑名单判断之前"）；
 *   · **熔断**：按扩展统计消灭/静默密度（比例 >50% 或 10s 内 >20 次），异常就**停用该扩展的破坏性动作**
 *     并 logger.warn（带扩展名与原因）—— 消息照常放行（同样靠"兜底放行"落地）；
 *   · **审计 + 可撤销**：每个动作一行 `{dataRoot}/.qqbot-extensions/inbound/.state/audit.jsonl`
 *     （时间/扩展名/动作/目标/原因/**截断后的**文本摘要，512KB 轮转），`muteUser` 能 `unmuteUser`。
 *
 * ── 兜底放行（让上面两条承诺真的成立）──────────────────────────────────────
 * 扩展**既没调 next()、也没有一次成功的消灭**时，引擎分两种情形处理：
 *   ① 它请求过消灭但**被拒**（发送者是主人 / 已熔断 / 挂在晚挂点）⇒ **替它放行** + warn；
 *   ② 发送者是**主人**且这次没有成功的消灭 ⇒ **替它放行** + warn（白名单最高优先）。
 * 其余情况（普通群友、扩展自己有意 `return`）保持老契约：**链停在这里**（这条消息不进后续任何环节）。
 *
 * ── 装载时机 / 热重载 ─────────────────────────────────────────────────────
 *   启动（网关 bootstrap → setupMiddlewares）时扫描装载，**至少重启生效**；
 *   另外 `SessionManager.reloadAllChannelTools()`（= `/tools-reload`、`tools_reload` 工具）
 *   会经 `features/ext-reload.ts` 顺带重扫一次 → **不重启也能生效**（挂载点是个读可变列表的代理，
 *   换代只是换内容，不用重挂中间件）。每次装载都**复位该扩展的熔断记录**（熔断的恢复通道）。
 */
import { statSync } from 'node:fs';
import { scanExtFiles } from './ext-packs.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXT_INBOUND_SUBDIR } from './extension-store.js';
import { registerExtInboundReloader } from './ext-reload.js';
import { enterExtension, ensureExtSession, sessionOf, } from './ext-inbound-context.js';
import { noteParticipation, resetBreaker, upgradeLastParticipation } from './ext-inbound-state.js';
import { destructiveCountOf } from './ext-inbound-context.js';
/** 扩展文件允许的扩展名（与 extension-store 的 ALLOWED_EXT 同款） */
const ALLOWED_EXT = new Set(['.js', '.mjs', '.cjs']);
/** 入站扩展目录（相对数据根） */
export function inboundExtensionsDir(dataRoot) {
    return join(dataRoot, EXT_INBOUND_SUBDIR);
}
/**
 * 当前装载的那一批（热重载时整体替换）。
 * ⚠️ 挂载点（middleware-setup）持有的是**自己的**可变数组，换代时内容被换掉；
 *    这里这份只是给诊断/dispose 用。
 */
/**
 * 卸载时要清理的扩展，**按中间件函数身份去重**（Map key = middleware）。
 * 为什么要去重、且要留住旧版：热重载后同一个文件会产生**新的模块对象**（`?v=<mtime>`），
 * 旧版模块若起过定时器/监听，也得有人来收 —— 但同一个模块被重复装载（多实例/重复重载）
 * 不该 dispose 两次，所以用模块内稳定的中间件函数引用当身份。
 */
// ★★ 2026-11-14 修（CodeRabbit）：`known` / `loaded` 原来是**模块级全局** ——
//   同进程两个机器人时，dispose 实例 A 会把实例 B 的扩展一起 dispose 掉（B 还在跑！），
//   诊断计数也是两份混在一起。改成按 dataRoot 分桶，各实例只动自己那一桶。
const knownByRoot = new Map();
const loadedByRoot = new Map();
/** 归一化 dataRoot 作桶 key：反斜杠/大小写只在 Windows 折叠 */
function ik(dataRoot) {
    const raw = String(dataRoot || "");
    if (process.platform !== "win32")
        return raw.replace(/\/+$/, "");
    return raw.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}
/** 取（必要时建）某实例的 known 桶 */
function knownOf(dataRoot) {
    const k = ik(dataRoot);
    let m = knownByRoot.get(k);
    if (!m) {
        m = new Map();
        knownByRoot.set(k, m);
    }
    return m;
}
/** 装载结果为空时的返回值（每次新建，避免调用方互相污染） */
function emptyResult(files = []) {
    return { total: 0, skipped: 0, middleware: [], early: [], extensions: [], files };
}
/** 挑第一个是函数的候选当 dispose（模块具名导出优先于 default 上的属性） */
function pickDispose(...cands) {
    for (const c of cands) {
        if (typeof c === 'function')
            return c;
    }
    return undefined;
}
/** 挑第一个是函数的候选当挂点（用于"具名导出优先，其次对象属性"这类归一化） */
function pickFn(...cands) {
    for (const c of cands) {
        if (typeof c === 'function')
            return c;
    }
    return undefined;
}
/** 只导出早挂点时的占位晚挂点（直接放行；也保证 `middleware` 字段永远是函数） */
const passThrough = async (_ctx, next) => { await next(); };
/**
 * 把一个动态 import 的结果归一化成入站扩展。
 *
 * 早挂点（可选）：具名 `onInbound` / 对象默认导出的 `onInbound`
 * 晚挂点（二者必有其一）：
 *   具名 `onDecide` > **裸函数默认导出**（旧契约） > 对象默认导出的 `onDecide` > 对象默认导出的 `middleware` > 具名 `middleware`
 *   ⚠️ `export default async (ctx,next)=>{}` **语义等同 `onDecide`**（既有的示例与用户契约一个字没变）。
 *
 * 返回 null = 形状不合法（两个挂点一个都没有），由调用方按"跳过"记账（只告警）。
 */
function normalizeInbound(mod, file, abs, logger) {
    try {
        const raw = mod;
        const dflt = raw?.default;
        const dfltObj = typeof dflt === 'object' && dflt !== null ? dflt : undefined;
        // ⚠️ 名字只从**对象** default 上取：`export default function () {}` 的函数名会被规范设成 "default"，
        //    直接拿 dflt.name 会得到字面量 "default"（ext-hooks 也是这么绕开的）。
        const name = String(dfltObj?.name ?? raw?.name ?? '').trim() || file.replace(/\.(mjs?|cjs)$/i, '');
        // 早挂点：具名导出优先，其次对象默认导出上的属性
        const onInbound = pickFn(raw?.onInbound, dfltObj?.onInbound);
        // 晚挂点
        const middleware = pickFn(raw?.onDecide, typeof dflt === 'function' ? dflt : undefined, dfltObj?.onDecide, dfltObj?.middleware, raw?.middleware);
        if (!middleware && !onInbound) {
            logger.warn(`[ext-inbound] ${file}: 没找到中间件 —— 需 \`export default async (ctx, next) => {…}\`、` +
                '`export async function onDecide(…)` 或 `export async function onInbound(…)`，已跳过');
            return null;
        }
        // 只导出早挂点时补一个直通的晚挂点（引擎两处都跑，行为等价"没有晚挂点"）
        const dispose = pickDispose(dfltObj?.dispose, raw?.dispose);
        return {
            file, path: abs, name,
            middleware: middleware ?? passThrough,
            ...(onInbound ? { onInbound } : {}),
            ...(dispose ? { dispose } : {}),
        };
    }
    catch (err) {
        logger.warn(`[ext-inbound] ${file}: 归一化失败 ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
/** 文件版本号（mtime，秒级取整）—— 与 extension-store / ext-hooks 同款纪律，别改回时间戳 */
function fileVersion(p) {
    try {
        return String(Math.floor(statSync(p).mtimeMs));
    }
    catch {
        return String(Date.now());
    }
}
/**
 * 扫描 `{dataRoot}/.qqbot-extensions/inbound/*.mjs` 并装载。
 *
 * 目录不存在 / 为空 → 返回空结果，**不打任何日志**。
 * 单个文件 import 失败或形状不合法 → 只记 `warn`，继续下一个；本函数**永不抛出**。
 * 重新调用 = 热重载：`loaded` 被整体替换成新一批（旧版模块留给 dispose 收尾），
 * 并**复位每个文件的熔断记录**（这是文档写明的熔断恢复通道）。
 */
export async function loadInboundExtensions(opts) {
    const { dataRoot, logger } = opts;
    // ★ 2026-10-24：内置目录 + 所有扩展包（只取直接子文件）
    const hits = scanExtFiles(dataRoot, 'inbound', ALLOWED_EXT);
    if (hits.length === 0) {
        loadedByRoot.set(ik(dataRoot), []);
        return emptyResult();
    }
    const files = hits.map((h) => h.name);
    const result = emptyResult(files);
    for (const hit of hits) {
        const f = hit.name;
        const abs = hit.abs;
        try {
            // Windows 绝对路径必须转 file:// URL；cache-bust 用 mtime（改了才重新 import，别改回时间戳）
            const url = pathToFileURL(abs).href + `?v=${fileVersion(abs)}`;
            const mod = await import(url);
            const ext = normalizeInbound(mod, f, abs, logger);
            if (!ext) {
                result.skipped += 1;
                continue;
            }
            result.total += 1;
            result.extensions.push(ext);
            result.middleware.push(ext.middleware);
            if (ext.onInbound)
                result.early.push(ext.onInbound);
            // 装载 = 熔断复位（改文件后 /tools-reload 就是文档里的"恢复通道"）
            // ★★ 2026-11-14 修（审查发现）：熔断 key 用**绝对路径**而不是文件名 ——
            //   两个目录下的同名扩展（各自 pack 里的 breaker.mjs）原本共享一份熔断计数：
            //   A 被熔断会连带停掉 B 的消灭/静默能力，诊断里还看不出是谁。
            resetBreaker(ext.path || ext.file);
            // 身份 = 中间件函数引用（同一模块重复装载时是同一个引用 → 不会重复 dispose）
            {
                const km = knownOf(dataRoot);
                if (!km.has(ext.middleware))
                    km.set(ext.middleware, ext);
            }
        }
        catch (err) {
            result.skipped += 1;
            logger.warn(`[ext-inbound] ✗ ${f} 装载失败(已跳过, 不影响其它入站扩展): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    loadedByRoot.set(ik(dataRoot), result.extensions);
    if (result.total > 0) {
        const earlyCount = result.extensions.filter((e) => e.onInbound).length;
        logger.info(`[ext-inbound] 已装载 ${result.total} 个入站中间件: ${result.extensions.map((e) => e.name).join(', ')}` +
            (earlyCount > 0 ? `（其中 ${earlyCount} 个含早挂点 onInbound）` : '') +
            (result.skipped > 0 ? `（跳过 ${result.skipped} 个）` : ''));
    }
    return result;
}
/** 运行器环境（缺 dataRoot 时动作 API 的名单/kv/审计一律降级为空操作，绝不往相对路径写盘） */
function runEnvOf(opts, logger) {
    return {
        dataRoot: String(opts?.dataRoot ?? ''),
        owners: Array.isArray(opts?.owners) ? opts.owners.map(String) : [],
        logger,
        ...(opts?.appId ? { appId: String(opts.appId) } : {}),
        // ★ 2026-10-12 能力面对齐：统一能力包（与 silentInto）要的输入**原样透传**。
        //   用 `!== undefined` 判据（不是真值判据）：sender 之类可能是对象/函数，别被布尔化吃掉。
        ...(opts?.sender !== undefined ? { sender: opts.sender } : {}),
        ...(opts?.replyTarget !== undefined ? { replyTarget: opts.replyTarget } : {}),
        ...(opts?.appSecret ? { appSecret: String(opts.appSecret) } : {}),
        ...(opts?.apiCall !== undefined ? { apiCall: opts.apiCall } : {}),
        ...(opts?.kernel !== undefined ? { kernel: opts.kernel } : {}),
        ...(opts?.resolveAgent ? { resolveAgent: opts.resolveAgent } : {}),
    };
}
/** 记一次"该扩展参与了这条消息"，返回熔断原因（有的话由调用方告警） */
function noteHook(s, ext, destructiveBefore, logger) {
    const key = ext.path || ext.file;
    const destructive = destructiveCountOf(s, key) > destructiveBefore; // ★ 按路径比较，别用总数
    // ★ 2026-11-14：参与/熔断的 key 一律用**绝对路径**（与 resetBreaker 对齐）
    if (s.noted.has(key)) {
        // 早+晚两个挂点：同一条消息只记一次参与；但晚挂点又做了破坏性动作 → 把那条记录升级成 true
        if (destructive) {
            try {
                upgradeLastParticipation(key);
            }
            catch { /* ignore */ }
        }
        return;
    }
    s.noted.add(key);
    const reason = noteParticipation(key, destructive);
    if (reason) {
        logger.warn?.(`[ext-inbound] ⚠ 熔断「${ext.name}」(${ext.file}): ${reason} —— ` +
            '该扩展的消灭/静默动作已停用（消息照常放行）；改文件后 /tools-reload 或重启插件可复位');
    }
}
/** 主人 openid 白名单判定（只读 ctx.message.senderId） */
function isOwnerSender(ctx, env) {
    try {
        const id = String(ctx.message?.senderId ?? '');
        return id !== '' && env.owners.includes(id);
    }
    catch {
        return false;
    }
}
/**
 * 扩展**既没调 next()、也没有一次成功的消灭**时，引擎要不要替它放行？
 *
 * 这条兜底是"白名单最高优先 / 熔断后只放行"能不能真正成立的**关键一半**：
 * 扩展最常见的写法是 `if (该消灭) { ctx.annihilate(); return; }` —— 只调动作、不调 next。
 * 一旦 `annihilate` 被拒（发送者是主人 / 已熔断 / 挂点不允许），那个 `return` 仍然会把链停住，
 * 结果就是"插件说拒绝了，消息还是被吞了"。所以：
 *   · 请求过消灭但**被拒** ⇒ 引擎替它放行（记一条 warn）；
 *   · 发送者是**主人**且这次没有成功的消灭 ⇒ 同样替它放行（白名单最高优先）。
 * 两种情况之外（普通群友、扩展自己有意 `return`）⇒ 保持老契约：链停在这里。
 */
function rescueReason(ctx, env, s) {
    if (s?.annihilateRefused)
        return s.annihilateRefused.reason;
    if (isOwnerSender(ctx, env))
        return '发送者是主人（白名单最高优先：主人的消息永远不被入站扩展吞掉）';
    return undefined;
}
/**
 * 跑一遍**早**挂点（`onInbound`）：挂载点在 quoteRef 之后、**记群历史之前**。
 *
 * 与晚挂点共用同一套兜底（单扩展 try/catch、next() 幂等且一定被 await、下游异常原样上抛），
 * 外加一条：`ctx.annihilate()` 置位后，**即便扩展又调了 next() 也不再往下走**
 * （消灭的语义是"不进历史、不进上下文、不占冷却"，只能靠"链停在这里"实现）。
 * 没导出 `onInbound` 的扩展自动跳过（不占一层 next）。
 */
export async function runEarlyInboundExtensions(exts, ctx, finalNext, logger, opts) {
    const env = runEnvOf(opts, logger);
    const step = async (i) => {
        const ext = exts[i];
        if (!ext) {
            await finalNext();
            return;
        }
        const hook = ext.onInbound;
        if (!hook) {
            await step(i + 1);
            return;
        }
        /** 该扩展是否已经往下走过（next() 幂等：误调两次只算第一次） */
        let onward;
        const innerNext = () => {
            if (onward) {
                logger.debug?.(`[ext-inbound] ${ext.file} 调了多次 next()（只算第一次）`);
                return onward;
            }
            // ★ 消灭：已请求消灭 ⇒ 这里直接"吃掉" next，链到此为止（连群历史都不会记）
            if (sessionOf(ctx)?.annihilate) {
                onward = Promise.resolve();
                return onward;
            }
            onward = step(i + 1);
            return onward;
        };
        const s = enterExtension(ctx, env, ext, 'inbound');
        // ★★ 2026-11-14（CodeRabbit）：下游扩展在 next() 里会把 s.current 改成自己，
        //   返回本扩展时必须恢复，否则它随后的 silentInto / muteUser 会记到下游头上。
        const prevCur = s.current;
        const prevPhase = s.phase;
        const before = destructiveCountOf(s, ext.path || ext.file); // ★ 按路径取基线
        try {
            await hook(ctx, innerNext);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (onward) {
                // 已经往下走过：先等下游（它自己抛的错要原样上抛），再判断这条异常属于谁
                await onward;
                logger.warn?.(`[ext-inbound] ${ext.file} 在 next() 之后抛异常(已忽略): ${msg}`);
            }
            else {
                logger.warn?.(`[ext-inbound] ✗ ${ext.file} 执行异常(已忽略, 本条消息继续往下走): ${msg}`);
                onward = step(i + 1);
            }
        }
        // 扩展忘了 await next() 也由引擎兜住；短路（压根没调 next / 已消灭）时这里为空操作
        if (!onward) {
            // ★ 兜底放行（见 rescueReason 注释）：消灭被拒 / 发送者是主人 ⇒ 主人的消息与"被拒的消灭"
            //   都不允许真的把链停住，否则白名单与熔断只是"纸面承诺"。
            const rescue = rescueReason(ctx, env, sessionOf(ctx));
            if (rescue) {
                logger.warn?.(`[ext-inbound] ${ext.file} 没有放行这条消息（${rescue}）→ 引擎替它放行：` +
                    '白名单最高优先 / 熔断后只放行，都不会因为"忘了调 next()"而失效');
                onward = step(i + 1);
            }
        }
        if (onward)
            await onward;
        // ★★ 2026-11-14（CodeRabbit）：恢复上游归属 —— 下游在 next() 里覆盖了 s.current，
        //   不回填的话本扩展接下去的动作会被算到下游那条路径的账上（熔断 key 已按路径分桶）。
        s.current = prevCur;
        s.phase = prevPhase;
        noteHook(s, ext, before, logger);
    };
    await step(0);
}
/**
 * 跑一遍**晚**挂点（`onDecide` / 默认导出）：挂载点在 mentionGate 之后、contentSanitizer 之前。
 *
 * 这是本扩展点自 2026-10-12 起的原有契约（洋葱模型：ext0 → ext1 → … → finalNext），
 * 挂载点与单元测试都直接调它（不依赖 SDK 的 `runMiddlewareChain`）。
 *
 * 三条兜底（见文件头"铁律"）：
 *   · 扩展抛错且**还没往下走** ⇒ 告警 + 替它 `next()`（用户脚本坏了，消息也绝不能被吞掉）；
 *   · 扩展抛错但**已经往下走** ⇒ 原样把下游的异常上抛（那是下游的错，不能记成"扩展坏了"）；
 *   · 扩展忘了 await `next()` ⇒ 引擎替它 await（保证中间件链的顺序语义）。
 * 扩展**不调** `next()` ⇒ 整条链到此为止（这是合法用法：这条消息被拦掉；但群历史**已经**记过）。
 */
export async function runInboundExtensions(exts, ctx, finalNext, logger, opts) {
    const env = runEnvOf(opts, logger);
    const step = async (i) => {
        const ext = exts[i];
        if (!ext) {
            await finalNext();
            return;
        }
        /** 该扩展是否已经往下走过（next() 幂等：误调两次只算第一次） */
        let onward;
        const innerNext = () => {
            if (!onward)
                onward = step(i + 1);
            else
                logger.debug?.(`[ext-inbound] ${ext.file} 调了多次 next()（只算第一次）`);
            return onward;
        };
        const s = enterExtension(ctx, env, ext, 'decide');
        // ★★ 2026-11-14（CodeRabbit）：同上，进下游前保存、出来后恢复归属
        const prevCur = s.current;
        const prevPhase = s.phase;
        const before = destructiveCountOf(s, ext.path || ext.file); // ★ 按路径取基线
        try {
            await ext.middleware(ctx, innerNext);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (onward) {
                // 已经往下走过：先等下游（它自己抛的错要原样上抛），再判断这条异常属于谁
                await onward;
                logger.warn?.(`[ext-inbound] ${ext.file} 在 next() 之后抛异常(已忽略): ${msg}`);
            }
            else {
                logger.warn?.(`[ext-inbound] ✗ ${ext.file} 执行异常(已忽略, 本条消息继续往下走): ${msg}`);
                onward = step(i + 1);
            }
        }
        // 扩展忘了 await next() 也由引擎兜住；短路（压根没调 next）时这里为空操作
        if (!onward) {
            // ★ 与早挂点同款兜底：晚挂点调 annihilate 会被拒（历史已记），若扩展就此 return，
            //   那条"拒绝"就变成空话 ⇒ 这里替它放行（主人消息同理）。
            const rescue = rescueReason(ctx, env, sessionOf(ctx));
            if (rescue) {
                logger.warn?.(`[ext-inbound] ${ext.file} 没有放行这条消息（${rescue}）→ 引擎替它放行：` +
                    '白名单最高优先 / "消灭只在早挂点有效"，都不会因为"忘了调 next()"而失效');
                onward = step(i + 1);
            }
        }
        if (onward)
            await onward;
        // ★★ 2026-11-14（CodeRabbit）：恢复上游归属 —— 下游在 next() 里覆盖了 s.current，
        //   不回填的话本扩展接下去的动作会被算到下游那条路径的账上（熔断 key 已按路径分桶）。
        s.current = prevCur;
        s.phase = prevPhase;
        noteHook(s, ext, before, logger);
    };
    await step(0);
}
/**
 * 把已装载的扩展组合成一个中间件（等价于 {@link runInboundExtensions} 的中间件写法）。
 * 挂载点用的是"可变列表 + runInboundExtensions"（为了热重载），这个组合版给需要固定列表的场景用。
 */
export function composeInboundExtensions(exts, logger, opts) {
    return async (ctx, next) => { await runInboundExtensions(exts, ctx, next, logger, opts); };
}
/**
 * 只把 ctx 的动作 API 提前挂上（不跑任何扩展）。
 * 正常使用不必调 —— 两个运行器都会自动挂；需要它的场景是调用方自己写了
 * "早挂点之后、晚挂点之前"的中间件，想读 `ctx.state.qqInboundForceWake` 之类由动作设置的标记。
 */
export function attachExtContext(ctx, logger, opts) {
    ensureExtSession(ctx, runEnvOf(opts, logger));
}
/**
 * 调用所有入站扩展的 `dispose()`（插件卸载 / 宿主退出 / 保存连接设置后重建网关）。
 *
 * 纪律：**逆序**执行（后装载的先清理）、单个失败只告警、整体永不抛出、幂等、清空登记。
 * 返回本次真正调用成功的 dispose 数量（没有导出的 dispose 就不算）。
 * 同时把 ext-reload 里的热重载入口摘掉 —— 否则它会一直指向这个已经死掉的实例。
 */
export async function disposeInboundExtensions(logger, dataRoot) {
    const km = knownOf(dataRoot);
    const list = [...km.values()].reverse();
    km.clear();
    loadedByRoot.set(ik(dataRoot), []);
    registerExtInboundReloader(dataRoot, undefined); // ★ 必须带自己的 key，否则会把别人的入口一起摘掉
    let n = 0;
    for (const ext of list) {
        if (typeof ext.dispose !== 'function')
            continue;
        n += 1;
        try {
            await ext.dispose();
        }
        catch (err) {
            logger.warn?.(`[ext-inbound] ${ext.file} dispose() 失败(已忽略): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (n > 0)
        logger.info?.(`[ext-inbound] 已清理 ${n} 个入站扩展`);
    return n;
}
/** 重置模块级状态（仅供单元测试；生产不要调 —— 会把正在生效的扩展登记丢掉） */
export function __resetInboundExtensionsForTest() {
    loadedByRoot.clear();
    knownByRoot.clear();
}
/** 当前登记在册的扩展数（诊断用） */
export function inboundExtensionsCount() {
    let total = 0;
    for (const m of knownByRoot.values())
        total += m.size;
    return total;
}
/** 当前生效的那一批（诊断用；返回副本，防外部改动） */
export function currentInboundExtensions() {
    const all = [];
    for (const arr of loadedByRoot.values())
        all.push(...arr);
    return all;
}
//# sourceMappingURL=ext-inbound.js.map