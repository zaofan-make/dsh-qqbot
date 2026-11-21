/** 单条备忘 */
export interface MemoItem {
    id: string;
    text: string;
    /** 写入时间戳(ms) */
    at: number;
}
/** 由插件配置设置（config.contextMemoMaxItems）；越界自动夹紧 */
export declare function setMemoMaxItems(n: unknown): void;
export declare function getMemoMaxItems(): number;
/** 列全部备忘（旧→新） */
export declare function listMemo(dataRoot: string, sessionKey: string): MemoItem[];
/** 追加一条备忘；返回新条目（文本为空则返回 undefined） */
export declare function appendMemo(dataRoot: string, sessionKey: string, text: string): MemoItem | undefined;
/** 改写某条（id 命中才改；返回是否改到） */
export declare function editMemo(dataRoot: string, sessionKey: string, id: string, text: string): boolean;
/** 删除某条（返回是否删到） */
export declare function deleteMemo(dataRoot: string, sessionKey: string, id: string): boolean;
/** 清空（返回清掉的条数） */
export declare function clearMemo(dataRoot: string, sessionKey: string): number;
/** 供注入：拼成一段 system 侧文本（空备忘返回空串）。超出上限从**最旧**开始丢。 */
export declare function memoTextForInject(dataRoot: string, sessionKey: string): string;
/**
 * 注入用：**文本 + 读取是否成功**。
 *
 * CodeRabbit：注入侧要区分「成功读到空」（用户清空了备忘，要补一条作废标记）
 * 与「读取失败」（EACCES 等，绝不能当作清空去覆盖现有备忘）。
 */
export declare function memoForInject(dataRoot: string, sessionKey: string): {
    ok: boolean;
    text: string;
};
/** 诊断：当前备忘条数与文件大小 */
export declare function memoStats(dataRoot: string, sessionKey: string): {
    count: number;
    bytes: number;
    file: string;
};
//# sourceMappingURL=context-memo.d.ts.map