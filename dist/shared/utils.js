/**
 * 通用工具函数
 *
 * 纯函数与常量，供插件入口与其他模块复用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '../..');
/**
 * DSH 主目录（宿主配置/存储的根）。
 *
 * 2026-11-28（fork）：宿主支持 `DSH_HOME` 环境变量把主目录搬离 `~/.dsh`，
 * 但插件里有多处写死 `join(homedir(), '.dsh', ...)` —— 迁移后那些读取点
 * 永远读不到文件，表现为「设置面板改了没用」「实例 cwd 读不到」。
 * 统一从这里取，读配置的每一处都只认这个函数。
 */
export function resolveDshHome() {
    const env = (process.env.DSH_HOME ?? '').trim();
    return env || join(os.homedir(), '.dsh');
}
/** `{DSH_HOME}/<segments...>` —— 别自己拼 `join(homedir(), '.dsh', ...)` */
export function dshHomePath(...segments) {
    return join(resolveDshHome(), ...segments);
}
/** 插件包名（从 package.json 读取，随发布名自动对齐） */
const PLUGIN_NAME = readPluginName();
/**
 * 插件版本号（从 package.json 读取）。
 * 2026-10-12 起对外暴露：供**启动钩子**（features/ext-hooks.ts 的 `env.pluginVersion`）等扩展点读取
 * —— 扩展作者可以按版本做分支，而不是去猜包路径、自己读 package.json。
 */
export const PLUGIN_VERSION = readPluginVersion();
function readPluginName() {
    try {
        const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, 'package.json'), 'utf8'));
        return pkg.name ?? '';
    }
    catch {
        return '';
    }
}
function readPluginVersion() {
    try {
        const pkgPath = resolve(PLUGIN_ROOT, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        return pkg.version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
/**
 * 构造 User-Agent 头
 *
 * 格式: dsh-qqbot/{version} (Node/{nodeVersion}; {platform})
 */
export function buildUserAgent() {
    return `dsh-qqbot/${PLUGIN_VERSION} (Node/${process.versions.node}; ${os.platform()})`;
}
/**
 * 定位当前 dsh profile 目录（装本插件的那个 profile 根，如 …/profiles/web）
 *
 * 探测链（前两级对 pnpm link:/symlink/isolated 等任意安装形态都可靠，不依赖代码文件位置）：
 *   0) 环境变量 QQBOT_PROFILE_DIR 显式指定（安装脚本/高级用户）；
 *   1) 宿主扫描：遍历 ~/.dsh/profiles/<name>，找到「装着本插件」的 profile
 *      （node_modules/<scope>/<name> 存在，或 package.json 的 bundles/dependencies 提及本包名）；
 *   2) 兜底：从代码安装路径逐级向上找名为 node_modules 的目录并返回其父目录
 *      （仅实体安装/hoisted 布局有效）。
 *
 * @param baseDir - 起始目录，缺省为插件根（可注入便于测试）
 */
export function getProfileDir(baseDir = PLUGIN_ROOT) {
    // 0) 显式覆盖
    const override = (process.env.QQBOT_PROFILE_DIR ?? '').trim();
    if (override && existsSync(override))
        return override;
    // 1) 宿主扫描（link / symlink / isolated nodeLinker 都可靠）
    const scanned = scanDshProfiles();
    if (scanned)
        return scanned;
    // 2) 兜底：代码位置向上找 node_modules 的父目录
    return getProfileDirByLocation(baseDir);
}
/**
 * 纯「代码位置」法：从 `baseDir` 向上找 `node_modules`，返回它的父目录（= profile 根）。
 *
 * 为什么单独抽出来（2026-10-12）：本机 `~/.dsh/profiles/` 下**多个 profile 都装了本插件**
 * （实测 desktop / qqnew / qqtest / web 四个），`scanDshProfiles()` 返回的是 readdir 顺序里的
 * **第一个**，未必是当前正在跑的那个。而「本文件自己所在的位置」永远只指向**当前这份安装**，
 * 所以判断「我是哪个 profile」时应**优先用本法**，扫描只作兜底（见 `resolveProfileName`）。
 */
export function getProfileDirByLocation(baseDir = PLUGIN_ROOT) {
    let dir = baseDir;
    for (let i = 0; i < 32; i++) {
        if (basename(dir) === 'node_modules')
            return dirname(dir);
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/**
 * 从 profile 根目录名推出 profile 名；判据是该目录的**父目录必须叫 `profiles`**。
 *
 * 加这条判据是为了挡住「源码 checkout 目录」：开发态下 `getProfileDirByLocation()` 会返回
 * 仓库上层的普通目录（如 `.../aiwork/<某工作区>`），把它当 profile 名会写出一个莫名其妙的
 * `qqbot-settings/<工作区名>/`。父目录不是 `profiles` 就一律不认 → 回落 `_default`（旧行为）。
 */
export function profileNameFromDir(dir) {
    if (!dir)
        return '';
    try {
        return basename(dirname(dir)) === 'profiles' ? basename(dir) : '';
    }
    catch {
        return '';
    }
}
/**
 * 当前实例的 **profile 名** —— 设置按 profile 隔离（`qqbot-settings/<profile>/<ns>.json`）用。
 *
 * ⚠️ 2026-10-12 修的坑：v1.8.4 起 profile 名取自 `process.env.DSH_PROFILE`，但**宿主不会把这个
 * 变量放进自己的环境**：DSH 是通过 `ctx.get('profileContext').name` 提供 profile 名的，
 * `DSH_PROFILE` 只在**每次 shell / 工具调用**时由 harness 临时注入（见 `@deepseek-ai/dsh-shell-env`：
 * `values[DSH_PROFILE_KEY] = profile.name`，且该命名空间"每次 shell 调用重建、ambient DSH_* 被丢弃"）。
 * 结果：插件在宿主进程里读**永远是空** → **永远落 `_default/`**，"web 与 desktop 各写各的"根本没生效
 * （实测证据：`qqbot-settings/_default/<ns>.writer.json` 里记的是 `"profile": "unknown"`）。
 *
 * 现在改为复用既有的 profile 定位链，取**目录名**当 profile 名：
 *   ① `DSH_PROFILE` 环境变量（显式指定 / 宿主确实传了时优先尊重）
 *   ② 代码位置（实体安装时唯一确定：包根上溯到 `node_modules` 的父目录）
 *   ③ 宿主扫描（link / symlink 安装的兜底，多 profile 时有歧义风险）
 * 拿不到返回 `''`，调用方（`nsPathsOf` / `settings-host.js`）落 `_default` —— 与旧行为一致，不会更糟。
 */
export function resolveProfileName() {
    // 2026-10-22（issue #14 建议 1）：宿主通过 profileContext 直接给名字 —— 有就用，别猜。
    const fromCtx = globalThis.__dshProfileName;
    if (typeof fromCtx === 'string' && fromCtx.trim())
        return fromCtx.trim();
    const env = (process.env.DSH_PROFILE ?? '').trim();
    if (env)
        return env;
    const byLoc = profileNameFromDir(getProfileDirByLocation());
    if (byLoc)
        return byLoc;
    return profileNameFromDir(getProfileDir());
}
/** 遍历 ~/.dsh/profiles/<name>，返回装着本插件的 profile 根目录（找不到返回 null） */
function scanDshProfiles() {
    // 与宿主保持一致: 优先环境变量 DSH_HOME, 否则回落 ~/.dsh
    const dshHome = resolveDshHome(); // 与宿主一致: DSH_HOME 优先，否则 ~/.dsh
    const profilesRoot = join(dshHome, 'profiles');
    let entries;
    try {
        entries = readdirSync(profilesRoot);
    }
    catch {
        return null;
    }
    for (const name of entries) {
        const prof = resolve(profilesRoot, name);
        try {
            if (!statSync(prof).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        // 判据 1: node_modules/<scope>/<pkg> 已安装（实体目录或 link 都能命中）
        if (PLUGIN_NAME) {
            const scope = PLUGIN_NAME.startsWith('@') ? PLUGIN_NAME.split('/')[0] : '';
            const pkg = scope ? PLUGIN_NAME.slice(scope.length + 1) : PLUGIN_NAME;
            const installed = scope
                ? join(prof, 'node_modules', scope, pkg)
                : join(prof, 'node_modules', pkg);
            if (existsSync(installed))
                return prof;
        }
        // 判据 2: package.json 的 bundles / dependencies 提及本包名（尚未实体安装时）
        try {
            const pkg = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'));
            const blob = JSON.stringify(pkg.dsh?.profile?.bundles ?? []) + JSON.stringify(pkg.dependencies ?? {});
            if (PLUGIN_NAME && blob.includes(PLUGIN_NAME))
                return prof;
        }
        catch {
            /* 无 package.json 的目录跳过 */
        }
    }
    return null;
}
/**
 * 解析环境变量占位配置
 */
export function resolveEnv(configValue, envKey) {
    if (configValue && configValue !== '__FROM_ENV__' && !configValue.startsWith('process.env')) {
        return configValue;
    }
    return process.env[envKey] ?? '';
}
/**
 * 由 QQ 的 `sessionKey` 推出**派生 sessionId**。
 *
 * `SessionManager` 建档时若没有显式映射（普通建档路径就是这样），用的就是这个确定性派生值：
 * `sha256(sessionKey)` 的前 32 个 hex 按 UUID 分段。
 *
 * 为什么抽到公共层：`prefs-store` 的**反查**（`findKeyBySessionIdOrDerived`）要用**同一个公式**
 * 把 `sessionCfg` 里的 key 还原成会话 id —— 两边算得不一样就永远反查不到。
 * 纯函数，结果与进程无关（宿主侧 `SessionId(id)` 是恒等函数，不会规范化大小写或加前缀）。
 *
 * ⚠️ 实测佐证（2026-11-28）：本机有 2 个 QQ 会话没有 `sessionIds` 映射，
 * 按本公式算出的 id 在 `~/.dsh/sessions/<工作区>/` 下**都能找到对应会话目录** ⇒ 公式无误。
 *
 * ⚠️ 反查的**漏判边界**（都是"退回旧行为"，不会把纯 web 会话误判成 QQ）：
 * ① `prefs-store` 的四张表各有 `MAX_ENTRIES=300` 上限，单实例管超过 300 个 peer 时
 *    `sessionCfg` 会淘汰最旧的 ⇒ 派生兜底对最老的会话无声失效；
 * ② `cwd` 变更会 `clearSessionCfg(key)`，若紧接着建档 throw，该会话短时间内
 *    既无映射也无指纹 ⇒ 同一窗口内漏判。
 */
const DERIVED_SESSION_ID_CACHE = new Map();
/** 缓存上限。key 不只来自 `sessionCfg`（那有 300 上限）——`currentSessionId` 等路径会传任意 peer 的 key。 */
const DERIVED_SESSION_ID_CACHE_MAX = 4096;
export function deriveSessionIdFromKey(sessionKey) {
    const key = String(sessionKey ?? '');
    const hit = DERIVED_SESSION_ID_CACHE.get(key);
    if (hit)
        return hit;
    const hash = createHash('sha256').update(key).digest('hex');
    const out = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    // 纯函数缓存，满了直接清空重算即可 —— 正确性零风险（否则公共 bot 上一堆一次性 c2c peer 会只增不减）。
    if (DERIVED_SESSION_ID_CACHE.size >= DERIVED_SESSION_ID_CACHE_MAX)
        DERIVED_SESSION_ID_CACHE.clear();
    DERIVED_SESSION_ID_CACHE.set(key, out);
    return out;
}
/**
 * 格式化相对时间
 */
export function formatRelativeTime(ts) {
    if (!ts)
        return '—';
    const diff = Date.now() - ts;
    if (diff < 60_000)
        return `${Math.floor(diff / 1000)}s 前`;
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)}m 前`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)}h 前`;
    return `${Math.floor(diff / 86_400_000)}d 前`;
}
//# sourceMappingURL=utils.js.map