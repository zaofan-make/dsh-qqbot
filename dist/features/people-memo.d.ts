/** 归档阈值(天): 小传最后修改超过这么久 → 沉底(仍在文件里, 只是不再优先召回) */
export declare const MEMO_ARCHIVE_DAYS = 30;
export declare function peopleDirOf(dataRoot: string): string;
export declare function memoPathOf(dataRoot: string, key: string): string;
export declare function readMemo(dataRoot: string, key: string): string | undefined;
/** 列出全部小传(按最后修改时间新→旧) */
export declare function listMemos(dataRoot: string): Array<{
    key: string;
    path: string;
    bytes: number;
    mtime: number;
    archived: boolean;
}>;
/** 今天已经记了几条（含栏位条目） */
export declare function countWroteToday(key: string, now?: number): number;
/** 兼容旧签名：今天是否已经记过（旧版按文件 mtime 判断，一天一条） */
export declare function wroteToday(_dataRoot: string, key: string, now?: number): boolean;
/**
 * 追加一条。两种落法：
 *   · 带栏目前缀（"喜好：…"）→ 归到八栏（该栏已有一行 → 行尾用"；"并进去，保持"每栏一行"的摘要形态）
 *   · 不带前缀 → 进「## 记事」区（带日期，现状不变）
 * 节流：**同一人一天最多 3 条**（2026-09-14 放宽；原为 1 条，"只记一条怎么记得完"）。
 */
export declare function appendMemoLine(dataRoot: string, key: string, line: string, opts?: {
    name?: string;
    force?: boolean;
}): {
    ok: boolean;
    msg: string;
};
/**
 * 取该小传里最适合注入的 1~2 行: 有嵌入器就按"与当前消息最相关"排, 没有就取最近两条。
 * 若整份小传已归档(30 天没更新) → 不注入(沉底)。
 */
export declare function recallLines(dataRoot: string, key: string, query: string, embed?: {
    available(): boolean;
    embedQuery(t: string): Promise<number[] | undefined>;
    embedPassages(t: string[]): Promise<number[][] | undefined>;
}, topN?: number): Promise<{
    lines: string[];
    archived: boolean;
}>;
/** 删掉整段小传(群里一句"别记人家" → 立刻执行 + 回执) */
export declare function deleteMemo(dataRoot: string, key: string): {
    ok: boolean;
    msg: string;
};
/**
 * inbound 算好"候选小传行"后调用（按会话 key 暂存，90 秒内有效）。
 *
 * ★ 2026-11-10 主人指正：**不能把拼好的整段文本拿来判重** ——
 *   前 40 字符里基本只有 `[人家记得的 昵称:` 和第一条，后面换行了也判不出来，
 *   于是"之后新想起来的条目永远被去重掉"。
 *   所以这里只存**原始行数组 + 昵称**，由 pre-step 逐行判"这一条在不在上下文里"。
 */
export declare function setPendingMemo(key: string, name: string, lines: string[]): void;
/** 供 pre-step 调用：只取**本会话**那一份候选；过期/为空返回 undefined */
export declare function takePendingMemo(key: string): {
    name: string;
    lines: string[];
} | undefined;
//# sourceMappingURL=people-memo.d.ts.map