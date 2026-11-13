import type { Logger } from '../types.js';
/**
 * 从 QQ 图片/文件 URL 里抠出**稳定的 fileid**(2026-09-13 主人定, 解决"老是重复收藏"):
 * QQ 多媒体 URL 形如
 *   https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhS…&rkey=…&spec=0
 * —— **fileid 同一张图恒定不变**, 而 rkey 每次都换(所以直接比 URL 永远查不到"收藏过没")。
 * 传完整 URL 或纯 fileid 都可以。
 */
export declare function extractQqFileId(input: string): string;
/**
 * 感知哈希 dHash(2026-09-13 主人定"又快又准"的图片去重):
 *   图片 → 缩成 9×8 灰度 → 逐行比较相邻像素明暗 → 64 位指纹(16 位 hex)。
 * 看的是**画面结构**而不是字节 → QQ 重压缩/改尺寸/转格式过的同一张图也能认出来。
 * 复用**宿主已装的 sharp**(零新增依赖); sharp 不可用 → 返回 undefined(调用方退化为逐字节 sha1 判重)。
 *
 * ⚠️ 2026-09-13 修(主人报启动刷屏 GLib-GObject-CRITICAL "value 32 ... property 'space' of type
 *    VipsInterpretation"): 根因是调了 sharp 的 `.grayscale()` —— 它会让 libvips 去设
 *    image.space=b-w, 某些 libvips/shar​p 版本组合下这个赋值触发 GLib critical 警告(不影响结果, 但刷屏)。
 *    改为 `.raw()` 直接拿 RGB 原始像素, **自己按亮度公式算灰度**(Y=0.299R+0.587G+0.114B),
 *    既绕开那次色彩空间赋值, 也少一步内部转换。同时设 VIPS_WARNING=0 兜底抑制 libvips 的非致命告警。
 */
export declare function computeDHash(buf: Buffer): Promise<string | undefined>;
/** 两个 dHash 的汉明距离(0~64); 任一为空或长度不等 → 999(视为完全不同) */
export declare function dhashDistance(a?: string, b?: string): number;
export type StickerLayer = 'candidate' | 'library' | 'negative' | 'trash';
export interface StickerMeta {
    id: string;
    layer: StickerLayer;
    hash: string;
    ext: string;
    size: number;
    sourceGroup?: string;
    senderId?: string;
    senderName?: string;
    msgText?: string;
    capturedAt: number;
    firstSeenAt: number;
    lastSeenAt: number;
    useCount: number;
    tags: string[];
    /** 详细描述(视觉自动生成/人工补; list_stickers 返回供挑选决策) */
    desc?: string;
    /** 是否等待整理(视觉打标失败/未打标) */
    needsDescribe?: boolean;
    /** 进回收站时间(trash 层超过回收期可物理删) */
    trashedAt?: number;
    /** 收藏前所在层(回收站还原用) */
    prevLayer?: StickerLayer;
    /** 来源图片 URL(群图 CDN 链接) —— agent 可用群消息里的 URL 反查本地文件 */
    sourceUrl?: string;
    /**
     * 感知哈希(dHash, 64 位 → 16 位 hex)。2026-09-13 主人定"要又快又准"的去重:
     * sha1 只认**逐字节相同**, QQ 重压缩/改尺寸/转格式过的同一张图就认不出;
     * dHash 看的是**画面明暗结构** → 汉明距离 ≤5 位即视为同一张图 ✓
     */
    dhash?: string;
}
export interface CaptureInput {
    sourceGroup?: string;
    senderId?: string;
    senderName?: string;
    msgText?: string;
    /** 可选: 主动收藏时附带的标签/描述 */
    tags?: string[];
    desc?: string;
    /** 来源图片 URL(群消息里能看到的那条链接) */
    sourceUrl?: string;
}
export interface StickerSearchOptions {
    q?: string;
    tag?: string;
    limit: number;
    /** true=含回收站(默认不含) */
    includeTrash?: boolean;
}
export interface StickerHit {
    id: string;
    layer: StickerLayer;
    path: string;
    tags: string[];
    desc?: string;
    sourceGroup?: string;
    msgText?: string;
    capturedAt: number;
    useCount: number;
}
export declare class StickerStore {
    private logger?;
    private items;
    private saveTimer;
    private dirty;
    readonly dataDir: string;
    constructor(dataDir: string, logger?: Logger | undefined);
    private indexPath;
    private loadIndex;
    /** 防抖落盘 index.json（写操作先改内存） */
    private save;
    /** 关闭时立即落盘（进程退出兜底） */
    flush(): void;
    /**
     * 老库自愈（2026-11-13，issue #47）：扩展名与真实字节不符的图按魔数改名，并回写 index 的 `ext`。
     *
     * 为什么必须做迁移：宿主 0.2.2 起严格校验声明类型（`IMAGE_TYPE_MISMATCH`），扩展名说谎的图
     * read_image / 发图全废；而**改名后必须回写 ext**，否则 `pathOf()` 还指着改名前那个不存在的路径。
     * 四层都扫（candidate / library / negative / trash）；目标文件已存在时只回写 ext，不覆盖。
     */
    private healExtensionMismatches;
    private filePathOf;
    /** 单条路径（给工具/发送用） */
    pathOf(id: string): string | undefined;
    /**
     * 收藏一张图：安全下载 → SHA-1 去重 → 存候选区 → 记 index。
     * 返回 'new' | 'dup' | 'error'。
     */
    capture(url: string, input: CaptureInput, contentType?: string): Promise<{
        status: 'new' | 'dup' | 'error';
        id?: string;
        error?: string;
    }>;
    /** 安全下载：仅 HTTPS + SSRF + 上限 + 超时 */
    private download;
    /** 从本地已有文件入库（后续升级/负样本用） */
    addLocalFile(srcPath: string, meta: Partial<StickerMeta> & {
        id: string;
        ext: string;
        layer: StickerLayer;
    }): void;
    /** 标记使用(候选→正式库并搬文件; 发送过=用过, 计入 useCount) */
    markUsed(id: string): void;
    /** 主动收藏/打标认可: 升级到正式区(不计数; 正式区不参与自动滚动清理) */
    promote(id: string): void;
    markReaction(id: string, kind: 'like' | 'dislike'): void;
    /** 查询：q/tag/描述命中 或 最近入库(默认不含回收站/负样本) */
    search(opts: StickerSearchOptions): StickerHit[];
    /** 更新一张图的标签与详细描述(tags/desc 传 undefined 表示不动该项; 自动去重) */
    setDescTags(id: string, tags?: string[], desc?: string): boolean;
    /** 把本地已有图片文件导入收藏(算hash去重, 复制进候选区); 返回 {status:'new'|'dup'|'error', id?} */
    importLocalFile(srcPath: string, input?: CaptureInput): Promise<{
        status: 'new' | 'dup' | 'error';
        id?: string;
        error?: string;
    }>;
    /** 送回收站(可逆; prevLayer 记原层用于还原) */
    markTrash(id: string): boolean;
    /** 从回收站还原(回到原层或候选区) */
    restore(id: string): boolean;
    /** 物理删除回收站中超过 ttlMs 的条目(含文件+index) */
    purgeTrashed(ttlMs?: number): number;
    /** 候选区超限清理: 超过 maxCandidates 时, 最久未见的滚进回收站(不物理删) */
    cleanupCandidates(maxCandidates: number): number;
    /**
     * 回收站物理清理：trash 层超过 maxItems 时，按"进回收站的时间"从旧到新**真删文件**。
     *
     * ⚠️ 2026-10-05 主人要求：回收站必须有上限，超过的旧图自动删。
     *   之前只有 markTrash（把候选区挤下来的旧图滚进回收站）而**从不物理删**，
     *   于是回收站一路涨到 4000 张。
     * 说明：只动 trash 层 —— candidate/library/negative 不受影响；
     *   没记 trashedAt 的老条目按 0 处理（视为最旧，优先清）。
     * @returns 实际物理删除的条数
     */
    cleanupTrash(maxItems: number): number;
    /** 清理损坏/空文件条目(文件缺失或 0 字节) */
    cleanupBroken(): number;
    /** 按层统计(整理/仪表盘用) */
    stats(): {
        total: number;
        candidate: number;
        library: number;
        trash: number;
        negative: number;
        untagged: number;
        totalBytes: number;
    };
    /** 按来源 URL 反查条目(agent 拿群消息里的 URL 定位本地图) */
    findBySourceUrl(url: string): StickerMeta | undefined;
    /**
     * 按 QQ 图片 fileid 反查条目(2026-09-13 主人: 解决"老是重复收藏")。
     * 关键: QQ 图片 URL **每次都换 rkey**(临时参数), 直接比 URL 永远查不到 → AI 每次又收藏一遍;
     * 而 URL 里的 `fileid=` **同一张图恒定不变** → 用它当去重键。
     */
    findByFileId(fileId: string): StickerMeta | undefined;
    /**
     * 按**感知哈希**查近似重复(2026-09-13 主人定, 又快又准):
     * 遍历已存 dhash 的条目取最小汉明距离, ≤ maxDist(默认 5)即视为同一张图。
     * ⚠️ 老记录若没有 dhash 会跳过(它们入库时还没这功能); 新入库的都会带。
     */
    findByDHash(dhash: string, maxDist?: number, layer?: StickerLayer): StickerMeta | undefined;
    /**
     * 后台惰性回填 dHash(2026-09-13): 从旧版本升级上来的库缺这个字段 → 去重会漏判。
     * 每次只补一小批(默认 20 张, 每张约 15ms), 不阻塞主流程; 返回本批补了几条(0 = 已补完)。
     */
    backfillDHash(batch?: number): Promise<number>;
    /** 全量查询(管理面板用): 可按层/关键词/未打标过滤, 默认不含回收站 */
    queryAll(opts?: {
        layer?: StickerLayer | 'all';
        q?: string;
        untagged?: boolean;
        includeTrash?: boolean;
    }): Array<{
        id: string;
        path: string;
        layer: StickerLayer;
        tags: string[];
        desc?: string;
        useCount: number;
        size: number;
        firstSeenAt: number;
    }>;
    get(id: string): StickerMeta | undefined;
    size(): number;
    private deleteFile;
    /** 层间移动文件到新路径(目录自动建) */
    private moveFile;
}
/**
 * 配置图库实例(启动期每账号按自己 dataDir 预初始化; 同目录幂等)。
 * ⚠️ 时序坑(线上踩坑)：必须启动早期按 config.cwd 解析的 dataDir 初始化，
 * 避免无参 getStickerStore 读到 process.cwd 的错目录(C盘幽灵库)。
 * ns: 实例标识(settingsNs), 多实例时用于无参调用精确取本实例库。
 */
export declare function configureStickerStore(dataDir: string, logger?: Logger, ns?: string): StickerStore;
/** 获取图库实例。带 dataDir → 按目录取(不在则容错新建); 带 ns → 按该实例的 primary 取;
 *  无参 → 全局 primary(兼容单账号旧调用)。 */
export declare function getStickerStore(dataDir?: string, logger?: Logger, ns?: string): StickerStore;
//# sourceMappingURL=sticker-store.d.ts.map