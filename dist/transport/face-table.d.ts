/**
 * face-table.ts — **内置** QQ face 表情表（彩蛋用，2026-11-19）
 *
 * 为什么不读扩展那份：`/face` 扩展是**可选的**，别的用户没装 ⇒ 读文件会拿到空表 ⇒ 彩蛋对所有人失效。
 * 所以内置一份兜底；用户若装了扩展并改了表，运行时**覆盖/追加**到这份之上（见 face-placeholder.ts）。
 *
 * 格式：`名字 → [charCode, …]`。这是 QQ 私有协议的控制字符（`0x14` + face id），
 * `String.fromCharCode(...)` 拼出来就是真表情。
 *
 * ⚠️ 新增表情请**同时**加到扩展那份 `qq-faces.json`，两边保持一致（内置是兜底，扩展是用户可改的覆盖层）。
 */
export declare const BUILTIN_FACE_TABLE: Readonly<Record<string, readonly number[]>>;
//# sourceMappingURL=face-table.d.ts.map