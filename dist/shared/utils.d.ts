/**
 * DSH 主目录（宿主配置/存储的根）。
 *
 * 2026-11-28（fork）：宿主支持 `DSH_HOME` 环境变量把主目录搬离 `~/.dsh`，
 * 但插件里有多处写死 `join(homedir(), '.dsh', ...)` —— 迁移后那些读取点
 * 永远读不到文件，表现为「设置面板改了没用」「实例 cwd 读不到」。
 * 统一从这里取，读配置的每一处都只认这个函数。
 */
export declare function resolveDshHome(): string;
/** `{DSH_HOME}/<segments...>` —— 别自己拼 `join(homedir(), '.dsh', ...)` */
export declare function dshHomePath(...segments: string[]): string;
/**
 * 插件版本号（从 package.json 读取）。
 * 2026-10-12 起对外暴露：供**启动钩子**（features/ext-hooks.ts 的 `env.pluginVersion`）等扩展点读取
 * —— 扩展作者可以按版本做分支，而不是去猜包路径、自己读 package.json。
 */
export declare const PLUGIN_VERSION: string;
/**
 * 构造 User-Agent 头
 *
 * 格式: dsh-qqbot/{version} (Node/{nodeVersion}; {platform})
 */
export declare function buildUserAgent(): string;
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
export declare function getProfileDir(baseDir?: string): string | null;
/**
 * 纯「代码位置」法：从 `baseDir` 向上找 `node_modules`，返回它的父目录（= profile 根）。
 *
 * 为什么单独抽出来（2026-10-12）：本机 `~/.dsh/profiles/` 下**多个 profile 都装了本插件**
 * （实测 desktop / qqnew / qqtest / web 四个），`scanDshProfiles()` 返回的是 readdir 顺序里的
 * **第一个**，未必是当前正在跑的那个。而「本文件自己所在的位置」永远只指向**当前这份安装**，
 * 所以判断「我是哪个 profile」时应**优先用本法**，扫描只作兜底（见 `resolveProfileName`）。
 */
export declare function getProfileDirByLocation(baseDir?: string): string | null;
/**
 * 从 profile 根目录名推出 profile 名；判据是该目录的**父目录必须叫 `profiles`**。
 *
 * 加这条判据是为了挡住「源码 checkout 目录」：开发态下 `getProfileDirByLocation()` 会返回
 * 仓库上层的普通目录（如 `.../aiwork/<某工作区>`），把它当 profile 名会写出一个莫名其妙的
 * `qqbot-settings/<工作区名>/`。父目录不是 `profiles` 就一律不认 → 回落 `_default`（旧行为）。
 */
export declare function profileNameFromDir(dir: string | null | undefined): string;
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
export declare function resolveProfileName(): string;
/**
 * 解析环境变量占位配置
 */
export declare function resolveEnv(configValue: string, envKey: string): string;
export declare function deriveSessionIdFromKey(sessionKey: string): string;
/**
 * 格式化相对时间
 */
export declare function formatRelativeTime(ts?: number): string;
//# sourceMappingURL=utils.d.ts.map