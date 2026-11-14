/**
 * 由 middleware-setup 注册：重扫扩展目录并重建命令表（含基础命令）
 *
 * ★★ 2026-10-27 修（主人实测：3 号机敲 /tools-reload，日志却记在 2 号机名下）：
 *   原来是**模块级单例** `let reloader`，两个实例各 apply 一次 → 后 apply 的覆盖前一个
 *   ⇒ 任何实例执行热刷，实际重载的都是"最后注册的那个实例"的命令表。
 *   这是维护手册 §11.24「跨模块实例可见的状态绝不能存模块级变量」的同一个坑。
 *   改成按 dataRoot 分开存，各刷各的。
 */
const reloaders = new Map();
/** 归一化 dataRoot 作 key（Windows 大小写/斜杠不敏感） */
function rlKey(dataRoot) {
    // ★★ 2026-11-14（CodeRabbit）：反斜杠**只在 Windows 上**是分隔符；POSIX 上它是合法文件名字符。
    //   无条件折叠会让 /srv/bot\one 与 /srv/bot/one 比较成同一个，本该拒绝不同实例的分支就失效。
    const raw = String(dataRoot || '');
    if (process.platform !== 'win32')
        return raw.replace(/\/+$/, '');
    return raw.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
/** 注册/注销重建器（注销传 undefined；插件重载时调用方会覆盖为新的） */
export function registerExtCommandReloader(dataRoot, fn) {
    const k = rlKey(dataRoot);
    if (!k)
        return;
    if (fn)
        reloaders.set(k, fn);
    else
        reloaders.delete(k);
}
/**
 * 热重载扩展命令。
 * 返回 `{ error }` 表示"没装成"（比如插件还没启动完），由调用方决定怎么提示 —— 不抛错，
 * 因为热刷的主职是刷工具，命令刷不动也不该把整次热刷弄失败。
 */
export async function reloadExtCommands(dataRoot) {
    const k = rlKey(dataRoot);
    // 不传 dataRoot 时退回"唯一那个"（单实例场景仍能工作）
    const fn = k ? reloaders.get(k) : (reloaders.size === 1 ? Array.from(reloaders.values())[0] : undefined);
    if (!fn) {
        return { error: `扩展命令表尚未注册(插件还没完成启动? dataRoot=${k || '(未传)'}, 已注册 ${reloaders.size} 个)` };
    }
    try {
        return await fn();
    }
    catch (err) {
        return { error: `扩展命令重载失败: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/** 给回执文本用：把重载结果拼成一句人话（工具热刷的 summary 会带上它） */
export function describeExtCommandReload(r) {
    if ('error' in r)
        return `扩展命令: ${r.error}`;
    if (r.names.length === 0)
        return '扩展命令: 0 个(目录里没有 commands/*.js?)';
    return `扩展命令: ${r.names.length} 个已重载 → ${r.names.map((n) => '/' + n).join(', ')}`;
}
/** 由 middleware-setup 注册：重扫入站扩展目录并原地换掉生效列表 */
/**
 * ★★ 2026-11-14 修（审查发现）：**照抄上面命令表那条的形状，按 dataRoot 分桶**。
 *   原来是 `let inboundReloader` 单槽 —— 两个机器人同时跑时，后注册的覆盖前一个：
 *   A 敲 /tools-reload 实际重扫的是 B 的目录、换的是 B 的数组；
 *   更糟的是 A 卸载时 `registerExtInboundReloader(undefined)` 会把 **B 的入口一起摘掉**
 *   （B 之后再热刷就报"入站扩展表尚未注册"）。
 */
const inboundReloaders = new Map();
/** 注册/注销入站扩展重载器（注销必须带**自己的** dataRoot） */
export function registerExtInboundReloader(dataRoot, fn) {
    const k = rlKey(dataRoot);
    if (!k)
        return; // 缺 key 直接拒绝：宁可不注册，也不许猜
    if (fn)
        inboundReloaders.set(k, fn);
    else
        inboundReloaders.delete(k);
}
/**
 * 热重载入站扩展。
 * 返回 `{ error }` 表示"没装成"（比如插件还没启动完）—— 不抛错，理由同 {@link reloadExtCommands}。
 */
export async function reloadExtInbound(dataRoot) {
    const k = rlKey(dataRoot);
    // 不传 dataRoot 时只有"唯一一个"才退回（单实例兼容）；多实例必须显式传
    const fn = k ? inboundReloaders.get(k) : (inboundReloaders.size === 1 ? Array.from(inboundReloaders.values())[0] : undefined);
    if (!fn)
        return { error: `入站扩展表尚未注册(插件还没完成启动? dataRoot=${k || '(未传)'}, 已注册 ${inboundReloaders.size} 个)` };
    try {
        return await fn();
    }
    catch (err) {
        return { error: `入站扩展重载失败: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/** 给回执文本用：把入站扩展重载结果拼成一句人话 */
export function describeExtInboundReload(r) {
    if ('error' in r)
        return `入站扩展: ${r.error}`;
    if (r.count === 0)
        return '入站扩展: 0 个(目录里没有 inbound/*.mjs?)';
    return `入站扩展: ${r.count} 个已重载 → ${r.names.join(', ')}`;
}
/** 当前是否已注册入站扩展重载器（诊断用） */
export function hasExtInboundReloader() {
    return inboundReloaders.size > 0;
}
/**
 * ★ 2026-11-14：**删掉死单例** `outboundReloader` / `registerExtOutboundReloader` ——
 *   全仓无任何调用者（审查确认），出站热刷一直走下面的动态 import。
 *   但 `reloadExtOutbound()` 本身有活调用者（session-manager.reloadAllChannelTools），
 *   而且**它不传 dataRoot** ⇒ 在 A 上敲 /tools-reload 会刷到 B 的目录。现在补参数。
 */
export async function reloadExtOutbound(dataRoot) {
    try {
        const { reloadOutboundExtensions } = await import('./ext-outbound.js');
        // ★★ 2026-11-14（CodeRabbit 复审）：P1 之后 reloadOutboundExtensions 已按 dataRoot 取桶，
        //   这里不再需要「当前配置对比」—— 那个判断在配了 A、B 之后永远只返回最后一个，
        //   导致请求 A 反而报目录不匹配、A 永远热刷不了。直接下传 dataRoot 即可。
        const r = await reloadOutboundExtensions(dataRoot);
        return { count: r.total, names: r.extensions.map((e) => e.name) };
    }
    catch (err) {
        return { error: `出站扩展重载失败: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/** 给回执文本用：把出站扩展重载结果拼成一句人话 */
export function describeExtOutboundReload(r) {
    if ('error' in r)
        return `出站扩展: ${r.error}`;
    if (r.count === 0)
        return '出站扩展: 0 个(目录里没有 outbound/*.mjs?)';
    return `出站扩展: ${r.count} 个已重载 → ${r.names.join(', ')}`;
}
/** 当前是否已注册出站扩展重载器（诊断用） */
export function hasExtOutboundReloader() {
    return true; // 出站走动态 import，永远可用（保留函数只为兼容诊断调用）
}
//# sourceMappingURL=ext-reload.js.map