/** 确保目录存在（带进程内缓存，重复调用近乎免费） */
export declare function ensureDir(dir: string): void;
/** 追加一行（自动补换行、自动建目录）。出错只丢这一条，不抛。 */
export declare function appendLine(file: string, line: string): void;
/**
 * 关掉某个文件的写入流。
 * **重写 / 重命名 / 删除这个文件之前必须调**，否则数据会写进已经被替换的旧文件。
 */
export declare function closeFile(file: string): void;
/** 全部冲刷关闭（进程退出前用；best effort，不强求 fsync） */
export declare function flushAll(): void;
//# sourceMappingURL=async-append.d.ts.map