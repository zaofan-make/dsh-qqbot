import type { ModelRoute } from './types.js';
/** 日志回调（可选） */
type DebugFn = (msg: string) => void;
/** 会话创建时的配置指纹(2026-09-08, 响应上游 issue #43: cwd/preset 改了要能换新会话) */
export interface SessionCfgFingerprint {
    cwd?: string;
    preset?: string;
}
export declare class PrefsStore {
    /** per-peer 模型偏好（内存态） */
    private overrides;
    /** per-peer 最新 sessionId（fork 后更新，内存态） */
    private sessionIds;
    /** per-peer 会话配置指纹（内存态） */
    private sessionCfg;
    /** per-peer 会话 preset 覆盖（内存态, /new <preset> 用） */
    private sessionPresets;
    /** 隔离偏好文件路径 */
    private readonly prefsPath;
    private readonly debugLog?;
    /** 可见告警回调（读写失败升级为 warn —— 映射丢失在旧版是"静默"的，完全无从排查） */
    private readonly onError?;
    /**
     * 本进程**显式删除**的 key（四张表各一套）。
     * 写前合并磁盘时会把这些 key 压住，防止「删除被并发写复活」。
     */
    private readonly deleted;
    /** 损坏文件只备份一次（避免每次写入都产出新备份） */
    private corruptedBackedUp;
    /**
     * @param debugLog 调试日志回调
     * @param baseDir  存放目录。**强烈建议传 `{dataRoot}/.qqbot`** ——
     *   2026-09-24 修复：此前硬编码 `homedir()/.dsh-qqbot`，导致用户把 dataRoot 指到 D 盘后，
     *   这个偏好文件仍孤零零留在 C 盘用户目录（其他数据都在 dataRoot，就它漏了）。
     *   不传时回落到 `$DSH_HOME/.dsh-qqbot`（再退 `~/.dsh-qqbot`），保持向后兼容。
     */
    constructor(debugLog?: DebugFn, baseDir?: string, onError?: DebugFn);
    /** 把老位置(`~/.dsh-qqbot/model-prefs.json`)的偏好**搬到新位置**（新位置没有时才搬，搬完保留原文件改名 .migrated） */
    private migrateLegacy;
    /** 每个 Map 的条目上限 —— 只增不减会让文件无限膨胀（2026-09-24 主人反馈"越写越长"）。 */
    private static readonly MAX_ENTRIES;
    /**
     * 清理**孤儿 override**（2026-09-24 主人反馈"还是越写越多"）。
     *
     * override 的 key 是 `sessionKey@sessionId`，而每次新建会话（/new、cwd/preset 变更、
     * 重启后未 resume）都会产生**新 sessionId** → 新 key；`sessionIds` 只记该 key 的最新会话，
     * 于是旧 sessionId 的 override 永远没人删，一个群能攒出十几条。
     *
     * 判定：key 里的 sessionId ≠ `sessionIds` 记录的最新值 → 该 override 已失效（不可能再被读到）→ 删。
     * 老式 peer 级 key（不含 `@sessionId`）保持不动，避免误删兼容路径。
     */
    private pruneOrphanOverrides;
    /** 超出上限时按插入顺序淘汰最旧（Map 保序；用过的键重新 set 会排到末尾，近似 LRU） */
    private prune;
    getOverride(sessionKey: string): ModelRoute | undefined;
    setOverride(sessionKey: string, route: ModelRoute): void;
    clearOverride(sessionKey: string): boolean;
    hasOverride(sessionKey: string): boolean;
    /**
     * 取 sessionKey 对应的 sessionId（**带历史兼容**，2026-11-06）。
     *
     * ## 为什么要兼容
     *
     * sessionKey 形如 `qqbot:<appId>:<scope>:<peerId>`，appId 是隔离维度（一个群多机器人靠它区分）。
     * 但**appId 可能被改过**（换号/迁移）：历史 sessionIds 里的 key 仍是旧 appId 前缀，
     * 而新生成的 sessionKey 用新 appId ⇒ 精确匹配查不到 ⇒ 老会话彻底失联：
     *   · `findBySessionId` 命中不了 → web 回合里所有通道工具报「通道未就绪」
     *   · 会话被当成新会话重建 → 历史上下文接不上
     *
     * ## 做法（对齐维护手册 §16「同一个概念只能有一个真源」+ 第 66 行「不许顺手归一化」）
     *
     * 1. **精确匹配优先** —— 绝大多数情况走这条，零副作用；
     * 2. 不中时按 `(scope, peerId)` **兼容匹配**（忽略 appId 前缀），取**最后一个**（最新写入的）；
     * 3. 命中后**认领迁移**：把该映射写成当前 sessionKey 的形式（旧 key 先留着，不删）。
     *
     * ⚠️ 兼容匹配只在本 store 自己的数据根内做 —— 每个实例一个 prefs 文件，
     *    所以「一个群多机器人」天然隔离，绝不会把 A 机器人的会话认成 B 的。
     * ⚠️ 不做批量改写：只迁移**真正被读到**的那一条（手册：改形式 = 改语义，不能静默批量刷）。
     */
    /**
     * **反向查**：由 DSH 会话 id 找出它属于哪个 QQ peer（`qqbot:<appId>:<scope>:<peerId>`）。
     *
     * 2026-11-11（主人问「不是直接按 model-prefs.json 判断吗」）：对，这正是那份文件里
     * 的 `sessionIds` 映射（`key → sessionId`）反过来用 —— **纯内存 Map 遍历，不读盘**。
     * 用途：判断"某个 agent 到底是不是 QQ 会话"（web 里打开 QQ 会话时用得上）。
     * @returns sessionKey 或 undefined（= 不是我们管的会话）
     */
    findKeyBySessionId(sessionId: string): string | undefined;
    /**
     * **反查（含派生兜底）**：由 DSH 会话 id 找出它属于哪个 QQ peer。
     *
     * ⚠️ **返回值仍可能不匹配 `preferredAppId`**：没有匹配项时会**回落到第一个候选**，
     *   命不命中都返回一个 key。所以**调用方必须自己按 appId 校验**（不能 `if (const sk = ...)` 就当它是本实例的）
     *   —— `SessionManager.sessionKeyOfSession()` 就是干这道校验的。想让语义更"零思考"，
     *   可以改成"传了 appId 且无匹配 → undefined"，行为等价（上层本来也会拒）。
     *
     * 为什么需要它：`sessionIds` 只记「显式指定过」的会话（fork / forceNew / create 失败轮换
     * 才写），**普通建档路径不写** —— 那种会话的 id 是 `deriveSessionIdFromKey(key)` 算出来的。
     * 只查 `sessionIds` 就会漏掉它们，症状是「重启后在 web 里打开这个 QQ 会话，认不出它是
     * QQ 会话」⇒ 群守则等 QQ 专属提示全丢。
     *
     * 补的这一路走 `sessionCfg`：它的写入点**全在** QQ 的 `getOrCreate` 路径上
     * （`session-manager.ts` 里 6 处 `setSessionCfg`），纯 web 会话根本不经过
     * ⇒ 拿它当「这是 QQ 会话」的证据，比扫会话历史干净（历史里的块会被压缩影子掉）。
     *
     * 实测（2026-11-28）：本机 8 个 QQ 会话 = 6 条 `sessionIds` 映射 + 2 条派生，两路合计 8/8 全覆盖。
     *
     * ⚠️ `preferredAppId`（2026-11-28 · 复审 R5，**别删**）：同一个 sid 在文件里**可能挂着多个 key** ——
     * `getSessionId()` 的「认领迁移」在换号后会为**新 appId** 写一条，而**旧 key 故意保留不删**。
     * 只取"第一个命中"就永远拿到旧 appId 那条 ⇒ 调用方按 appId 校验时**永久**判空
     * （换过号的用户再也认不出自己的 QQ 会话）。所以这里收齐**所有候选**，
     * 优先返回 appId 匹配的那条；没有匹配的才回落到第一个（由调用方决定拒不拒）。
     */
    findKeyBySessionIdOrDerived(sessionId: string, preferredAppId?: string): string | undefined;
    getSessionId(sessionKey: string): string | undefined;
    setSessionId(sessionKey: string, sessionId: string): void;
    clearSessionId(sessionKey: string): boolean;
    getSessionCfg(sessionKey: string): SessionCfgFingerprint | undefined;
    setSessionCfg(sessionKey: string, cfg: SessionCfgFingerprint): void;
    /** 清 sessionId 时连带清指纹(重置会话 = 抛弃旧配置记录) */
    clearSessionCfg(sessionKey: string): boolean;
    getSessionPreset(sessionKey: string): string | undefined;
    setSessionPreset(sessionKey: string, preset: string): void;
    clearSessionPreset(sessionKey: string): boolean;
    private load;
    /**
     * 读磁盘当前状态（用于写前合并）。
     * 不存在 → null（首次写）；**损坏** → 先备份再返回 null（直接覆盖会把仍完好的
     * 条目一起丢掉，用户表现就是"QQ 里丢上下文"且无从恢复）。
     */
    private readDiskState;
    /** 损坏文件只备份一次；失败不阻断写入 */
    private backupCorrupted;
    /**
     * 合并内存与磁盘：**内存覆盖同 key**，磁盘独有的（别的写者写的）保留，
     * 墓碑里的 key 一律不写回（防止删除被复活）。
     */
    private mergeDisk;
    private write;
}
export {};
//# sourceMappingURL=prefs-store.d.ts.map