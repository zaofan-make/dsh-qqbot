/** 确保目录存在（带进程内缓存，重复调用近乎免费） */
export declare function ensureDir(dir: string): void;
/**
 * ★ 目录被**删除**之后必须调这个（2026-11-15，CodeRabbit 抓到）。
 * 不清缓存的话，`ensureDir` 会一直以为目录还在、直接跳过 mkdir →
 * 之后每次 append 都写进不存在的路径、失败、而且**静默重复下去**。
 */
export declare function forgetDirTree(dir: string): void;
/** 这个路径当前是否挂着写入流（= 有写入正在进行/已排队，目录不能删） */
export declare function hasActiveStream(file: string): boolean;
/** 关掉某个文件的流；**关之前先把内核缓冲刷到盘**（见函数内注释） */
export declare function closeFile(file: string): void;
/** 追加一行（自动补换行、自动建目录）。出错只丢这一条，不抛。 */
export declare function appendLine(file: string, line: string): void;
/** 全部冲刷关闭（进程退出前用；best effort，不强求 fsync） */
export declare function flushAll(): void;
//# sourceMappingURL=async-append.d.ts.map