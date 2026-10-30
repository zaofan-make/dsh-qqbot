/**
 * PrefsStore — per-peer 模型偏好持久化
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：~/.dsh-qqbot/model-prefs.json
 *
 * 2026-10-31 同步上游 e49dadf（tencent-connect/dsh-qqbot）：**并发安全**。
 *   这个文件是**多写者共享**的（同进程多实例、跨进程多 profile 同时跑），旧逻辑每次
 *   「读自己的内存 → 全量覆盖写盘」⇒ 谁最后写谁赢，别人的 `sessionIds` 映射直接被抹掉
 *   （表现：重启后会话绑定丢了 / QQ 里"上下文没了"）。
 *   现在三件事：
 *     · **原子写**：同目录临时文件 + rename；tmp 名带 pid+随机，多进程各自的临时文件互不覆盖
 *     · **写前合并**：重读磁盘，保留其他写者的条目，内存覆盖同 key
 *     · **删除墓碑**：本进程显式删掉的 key，合并不把它复活
 *
 * 2026-09-06 移植上游 tencent-connect/dsh-qqbot PR #41:
 *   - 写入改原子(先写 .tmp 再 renameSync 覆盖, 同卷 rename 由 OS 保证原子,
 *     避免写盘瞬间被 kill 留下半截 JSON);
 *   - load 解析失败不再静默吞掉: 损坏文件改名 .corrupt-<ts> 保留取证, 空偏好继续。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ModelRoute } from './types.js';

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;

/** 会话创建时的配置指纹(2026-09-08, 响应上游 issue #43: cwd/preset 改了要能换新会话) */
export interface SessionCfgFingerprint {
  cwd?: string;
  preset?: string;
}

/** 隔离偏好文件结构 */
interface PrefsFile {
  overrides: Record<string, ModelRoute>;
  /** sessionKey → 最新 sessionId（fork 后更新，用于重启后恢复到 fork 后的会话） */
  sessionIds: Record<string, string>;
  /** sessionKey → 该会话创建时的 cwd/preset 指纹(判断配置变更, 变了就不 resume 旧会话) */
  sessionCfg?: Record<string, SessionCfgFingerprint>;
  /** sessionKey → 该会话的 preset 覆盖(/new <preset> 指定, 重启后按此恢复) */
  sessionPresets?: Record<string, string>;
}

export class PrefsStore {
  /** per-peer 模型偏好（内存态） */
  private overrides = new Map<string, ModelRoute>();
  /** per-peer 最新 sessionId（fork 后更新，内存态） */
  private sessionIds = new Map<string, string>();
  /** per-peer 会话配置指纹（内存态） */
  private sessionCfg = new Map<string, SessionCfgFingerprint>();
  /** per-peer 会话 preset 覆盖（内存态, /new <preset> 用） */
  private sessionPresets = new Map<string, string>();
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;
  /** 可见告警回调（读写失败升级为 warn —— 映射丢失在旧版是"静默"的，完全无从排查） */
  private readonly onError?: DebugFn;
  /**
   * 本进程**显式删除**的 key（四张表各一套）。
   * 写前合并磁盘时会把这些 key 压住，防止「删除被并发写复活」。
   */
  private readonly deleted = {
    overrides: new Set<string>(),
    sessionIds: new Set<string>(),
    sessionCfg: new Set<string>(),
    sessionPresets: new Set<string>(),
  };
  /** 损坏文件只备份一次（避免每次写入都产出新备份） */
  private corruptedBackedUp = false;

  /**
   * @param debugLog 调试日志回调
   * @param baseDir  存放目录。**强烈建议传 `{dataRoot}/.qqbot`** ——
   *   2026-09-24 修复：此前硬编码 `homedir()/.dsh-qqbot`，导致用户把 dataRoot 指到 D 盘后，
   *   这个偏好文件仍孤零零留在 C 盘用户目录（其他数据都在 dataRoot，就它漏了）。
   *   不传时回落到 `$DSH_HOME/.dsh-qqbot`（再退 `~/.dsh-qqbot`），保持向后兼容。
   */
  constructor(debugLog?: DebugFn, baseDir?: string, onError?: DebugFn) {
    const root = (baseDir && baseDir.trim())
      || resolve(process.env.DSH_HOME?.trim() || homedir(), '.dsh-qqbot');
    this.prefsPath = resolve(root, 'model-prefs.json');
    this.debugLog = debugLog;
    this.onError = onError;
    this.migrateLegacy();
    this.load();
  }

  /** 把老位置(`~/.dsh-qqbot/model-prefs.json`)的偏好**搬到新位置**（新位置没有时才搬，搬完保留原文件改名 .migrated） */
  private migrateLegacy(): void {
    try {
      const legacy = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');
      if (legacy === this.prefsPath) return;              // 目标就是老位置 → 不用搬
      if (!existsSync(legacy) || existsSync(this.prefsPath)) return;
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      copyFileSync(legacy, this.prefsPath);
      try { renameSync(legacy, legacy + '.migrated'); } catch { /* 改不了名也无妨，反正已经复制 */ }
      this.debugLog?.(`prefs 已从旧位置迁移: ${legacy} → ${this.prefsPath}`);
    } catch (err) {
      this.debugLog?.(`prefs 迁移失败(不影响运行): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 每个 Map 的条目上限 —— 只增不减会让文件无限膨胀（2026-09-24 主人反馈"越写越长"）。 */
  private static readonly MAX_ENTRIES = 300;

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
  private pruneOrphanOverrides(): void {
    for (const key of [...this.overrides.keys()]) {
      const at = key.lastIndexOf('@');
      if (at < 0) continue;
      const sessionKey = key.slice(0, at);
      const sid = key.slice(at + 1);
      const latest = this.sessionIds.get(sessionKey);
      if (latest && latest !== sid) this.overrides.delete(key);
    }
  }

  /** 超出上限时按插入顺序淘汰最旧（Map 保序；用过的键重新 set 会排到末尾，近似 LRU） */
  private prune(): void {
    this.pruneOrphanOverrides();
    for (const m of [this.overrides, this.sessionIds, this.sessionCfg, this.sessionPresets]) {
      while (m.size > PrefsStore.MAX_ENTRIES) {
        const oldest = m.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    }
  }

  // ── Override 操作 ──

  getOverride(sessionKey: string): ModelRoute | undefined {
    return this.overrides.get(sessionKey);
  }

  setOverride(sessionKey: string, route: ModelRoute): void {
    this.overrides.set(sessionKey, route);
    this.deleted.overrides.delete(sessionKey);
    this.write();
  }

  clearOverride(sessionKey: string): boolean {
    const deleted = this.overrides.delete(sessionKey);
    if (deleted) {
      this.deleted.overrides.add(sessionKey);
      this.write();
    }
    return deleted;
  }

  hasOverride(sessionKey: string): boolean {
    return this.overrides.has(sessionKey);
  }

  // ── SessionId 操作 ──

  getSessionId(sessionKey: string): string | undefined {
    return this.sessionIds.get(sessionKey);
  }

  setSessionId(sessionKey: string, sessionId: string): void {
    this.sessionIds.set(sessionKey, sessionId);
    this.deleted.sessionIds.delete(sessionKey);
    this.write();
  }

  clearSessionId(sessionKey: string): boolean {
    const deleted = this.sessionIds.delete(sessionKey);
    if (deleted) {
      this.deleted.sessionIds.add(sessionKey);
      this.write();
    }
    return deleted;
  }

  // ── 会话配置指纹操作 ──

  getSessionCfg(sessionKey: string): SessionCfgFingerprint | undefined {
    return this.sessionCfg.get(sessionKey);
  }

  setSessionCfg(sessionKey: string, cfg: SessionCfgFingerprint): void {
    this.sessionCfg.set(sessionKey, cfg);
    this.deleted.sessionCfg.delete(sessionKey);
    this.write();
  }

  /** 清 sessionId 时连带清指纹(重置会话 = 抛弃旧配置记录) */
  clearSessionCfg(sessionKey: string): boolean {
    const deleted = this.sessionCfg.delete(sessionKey);
    if (deleted) {
      this.deleted.sessionCfg.add(sessionKey);
      this.write();
    }
    return deleted;
  }

  // ── 会话 preset 覆盖操作(/new <preset> 2026-09-08) ──

  getSessionPreset(sessionKey: string): string | undefined {
    return this.sessionPresets.get(sessionKey);
  }

  setSessionPreset(sessionKey: string, preset: string): void {
    this.sessionPresets.set(sessionKey, preset);
    this.deleted.sessionPresets.delete(sessionKey);
    this.write();
  }

  clearSessionPreset(sessionKey: string): boolean {
    const deleted = this.sessionPresets.delete(sessionKey);
    if (deleted) {
      this.deleted.sessionPresets.add(sessionKey);
      this.write();
    }
    return deleted;
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(content) as PrefsFile;
      if (data.overrides && typeof data.overrides === 'object') {
        for (const [key, route] of Object.entries(data.overrides)) {
          if (route.provider && route.model) {
            this.overrides.set(key, { provider: route.provider, model: route.model });
          }
        }
      }
      if (data.sessionIds && typeof data.sessionIds === 'object') {
        for (const [key, sessionId] of Object.entries(data.sessionIds)) {
          if (typeof sessionId === 'string' && sessionId) {
            this.sessionIds.set(key, sessionId);
          }
        }
      }
      if (data.sessionCfg && typeof data.sessionCfg === 'object') {
        for (const [key, cfg] of Object.entries(data.sessionCfg)) {
          if (cfg && typeof cfg === 'object') {
            this.sessionCfg.set(key, { cwd: cfg.cwd, preset: cfg.preset });
          }
        }
      }
      if (data.sessionPresets && typeof data.sessionPresets === 'object') {
        for (const [key, preset] of Object.entries(data.sessionPresets)) {
          if (typeof preset === 'string' && preset) this.sessionPresets.set(key, preset);
        }
      }
    } catch (err) {
      // 2026-09-06 (PR #41): 解析失败不静默 —— 损坏文件改名 .corrupt-<ts> 保留取证, 空偏好继续。
      // 旧行为只在 debug 时打一行日志然后以空偏好继续, 坏文件会被下次 write 覆盖, 无法事后排查。
      const msg = `loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`;
      // 解析失败意味着 sessionKey→sessionId 映射丢失（会话连续性受影响），必须可见
      this.onError?.(msg);
      this.debugLog?.(msg);
      try {
        if (existsSync(this.prefsPath)) {
          const quarantine = `${this.prefsPath}.corrupt-${Date.now()}`;
          renameSync(this.prefsPath, quarantine);
          this.debugLog?.(`prefs 文件损坏, 已隔离到 ${quarantine} 保留取证`);
        }
      } catch (qErr) {
        this.debugLog?.(`prefs 损坏文件隔离失败: ${qErr instanceof Error ? qErr.message : String(qErr)}`);
      }
    }
  }

  /**
   * 读磁盘当前状态（用于写前合并）。
   * 不存在 → null（首次写）；**损坏** → 先备份再返回 null（直接覆盖会把仍完好的
   * 条目一起丢掉，用户表现就是"QQ 里丢上下文"且无从恢复）。
   */
  private readDiskState(): PrefsFile | null {
    try {
      if (!existsSync(this.prefsPath)) return null;
      const raw = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== 'object') throw new Error('not an object');
      return data as PrefsFile;
    } catch (err) {
      // 读失败（权限/并发删除）→ 按首次写处理；解析失败 → 备份
      try {
        const raw2 = readFileSync(this.prefsPath, 'utf8');
        if (raw2.trim()) this.backupCorrupted(raw2);
      } catch { /* 读不到就不备份 */ }
      this.debugLog?.(`readDiskState 失败(按首次写处理): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 损坏文件只备份一次；失败不阻断写入 */
  private backupCorrupted(raw: string): void {
    if (this.corruptedBackedUp) return;
    this.corruptedBackedUp = true;
    const backupPath = `${this.prefsPath}.corrupted.${Date.now()}`;
    try {
      writeFileSync(backupPath, raw, 'utf8');
      this.onError?.(`model-prefs.json 损坏，已备份到 ${backupPath}（会话映射可能丢失，可从备份人工恢复）`);
    } catch (err) {
      this.onError?.(`model-prefs.json 损坏且备份失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 合并内存与磁盘：**内存覆盖同 key**，磁盘独有的（别的写者写的）保留，
   * 墓碑里的 key 一律不写回（防止删除被复活）。
   */
  private mergeDisk(disk: PrefsFile | null): PrefsFile {
    const pick = <T>(mem: Map<string, T>, diskMap: Record<string, T> | undefined, tomb: Set<string>): Record<string, T> => {
      const out: Record<string, T> = Object.fromEntries(mem.entries());
      if (diskMap && typeof diskMap === 'object') {
        for (const [key, value] of Object.entries(diskMap)) {
          if (key in out || tomb.has(key)) continue;
          out[key] = value;
        }
      }
      return out;
    };
    const cfg = pick(this.sessionCfg, disk?.sessionCfg, this.deleted.sessionCfg);
    const pre = pick(this.sessionPresets, disk?.sessionPresets, this.deleted.sessionPresets);
    return {
      overrides: pick(this.overrides, disk?.overrides, this.deleted.overrides),
      sessionIds: pick(this.sessionIds, disk?.sessionIds, this.deleted.sessionIds),
      ...(Object.keys(cfg).length > 0 ? { sessionCfg: cfg } : {}),
      ...(Object.keys(pre).length > 0 ? { sessionPresets: pre } : {}),
    };
  }

  private write(): void {
    try {
      this.prune();   // 防无限膨胀
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      // ★ 2026-10-31（同步上游 e49dadf）：写前**重读磁盘并合并** —— 这个文件是多写者共享的
      //   （同进程多实例 / 跨进程多 profile），旧逻辑拿内存全量覆盖 ⇒ 别人的映射被抹掉。
      const data = this.mergeDisk(this.readDiskState());
      // 原子写：同目录临时文件 + rename（同分区原子，崩溃不留半份文件）。
      // ⚠️ tmp 名**必须带 pid + 随机后缀**：固定名时两个进程会写同一个 tmp，
      //    A 的 rename 可能把 B 的内容落盘（上游踩过这个）。
      const tmpPath = `${this.prefsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        renameSync(tmpPath, this.prefsPath);
      } catch (err) {
        try { unlinkSync(tmpPath); } catch { /* 可能不存在 */ }
        throw err;
      }
    } catch (err) {
      const msg = `writePrefs failed: ${err instanceof Error ? err.message : String(err)}`;
      // 旧版只 debugLog（默认关）⇒ 写失败完全不可见。升级为可见告警。
      this.onError?.(msg);
      this.debugLog?.(msg);
    }
  }
}
