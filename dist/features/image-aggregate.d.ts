import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/** 环形缓冲里的一张图 */
export interface AggImage {
    /** 本地绝对路径（图库里那张） */
    path: string;
    /** 发送者显示名 */
    sender: string;
    /** 到达时间戳（毫秒） */
    at: number;
    /** 是否已经被聚合进过某张长图（true = 不再重复聚合） */
    sent: boolean;
}
/** 装配期调用：把我们产出的附件 id 台账绑到数据根上（跨重启也认得） */
export declare function initAggregateRegistry(dataRoot: string): void;
/** 登记一个"我们做的"图片附件 */
export declare function noteOurAttachment(id: string): void;
/** 这个附件是不是"我们自己拼/发"的图 */
export declare function isOurAttachment(id: unknown): boolean;
/** 宿主注入：判断当前 agent 走的模型是否支持 image 输入 */
type ImageProbe = (agent: unknown) => Promise<boolean | undefined>;
/** 宿主注入：把合成图存成附件 */
type ImageSaver = (data: Uint8Array, mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif') => Promise<{
    attachment: unknown;
    width?: number;
    height?: number;
} | undefined>;
/** bootstrap 装配期注入（每次启动覆盖一次，幂等） */
export declare function setImageAggregateHooks(hooks: {
    probeImageInput?: ImageProbe;
    saveImage?: ImageSaver;
}): void;
/**
 * 把一条消息里的图片塞进环形缓冲。
 *
 * @param key 会话键（`group:<gid>` / `c2c:<openid>`）
 * @param path 本地图片路径
 * @param sender 发送者显示名
 * @param max 环形缓冲上限（1~8）
 * @returns 缓冲后的条数（0 = 没进去，比如路径不存在/重复）
 */
export declare function pushAggImage(key: string, path: string, sender: string, max: number): number;
/** 看某个会话还欠着哪些没聚合的图（按到达顺序，旧 → 新） */
export declare function pendingAggImages(key: string): AggImage[];
/** 把这几张标成"已聚合"，之后不再重复进长图 */
export declare function markAggSent(items: AggImage[]): void;
/** 记住这些路径已经拼过（缓冲被挤出去以后也照样不让它们回来） */
export declare function rememberAggSentPaths(key: string, paths: string[]): void;
/** 清空某会话的缓冲（重启/清屏用；正常流程不调） */
export declare function clearAggImages(key: string): void;
/**
 * 把若干张图**垂直拼成一张长图**（旧在上、新在下）。
 *
 * @param items 已按到达顺序排好的图片（旧 → 新）
 * @returns JPEG 字节 + 尺寸；全部读失败时返回 undefined
 */
export declare function stitchAggImages(items: AggImage[]): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
    used: AggImage[];
} | undefined>;
/**
 * 真正干活的那一步：**当前模型支持读图**时，把没聚合过的图拼成一张长图，
 * 返回要追加进消息的 content blocks（一条文字说明 + 一块 ImageBlock）。
 *
 * 任何一环不满足（没图 / 非多模态 / 只有 1 张 / 拼接失败 / 存档失败）都返回 undefined，
 * 调用方原样发原消息即可 —— 本功能**永远不该**让消息发不出去。
 *
 * @param key 会话键
 * @param agent 当前会话 agent（探测模型能力用）
 * @param logger 日志
 */
export declare function buildAggregateBlocks(key: string, agent: unknown, logger?: {
    debug?: (m: string) => void;
    warn?: (m: string) => void;
}): Promise<ContentBlock[] | undefined>;
export {};
//# sourceMappingURL=image-aggregate.d.ts.map