/**
 * 扩展 UI 的「自动铺设」（2026-10-27 主人要求）
 *
 * 背景：UI 卡片分两个源 ——
 *   slot=settings（全局设置页）必须放 `{PROFILE_ROOT}/.qqbot-extensions/ui/<id>/`
 *   slot=dock    （悬浮球）   必须放 `{dataRoot}/.qqbot-extensions/ui/<id>/`
 * 但扩展作者和示例不该手动往这两个地方复制。所以这里做一次自动铺设：
 *
 *   ① 源码自带示例（examples/ext-ui/<name>/settings|dock/）
 *      → 铺到 profile / dataRoot
 *   ② 已安装的扩展包（{dataRoot}/extension-packs/<pack>/ui/）
 *      → 里面 slot=settings 的卡片铺到 profile（dock 的本来就在 dataRoot，不用动）
 *
 * 原则：**只补不改** —— 目标已存在就跳过，绝不动用户改过的内容。
 */
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXT_UI_FILES = ['card.html', 'card.css', 'card.js'] as const;

/** 从 card.html 前 2KB 读元信息 */
function parseMeta(html: string): { id?: string; slot?: string; title?: string; order?: number } {
  try {
    const head = html.slice(0, 2048);
    const m = head.match(/<!--\s*qqbot-ui:\s*(\{[\s\S]*?\})\s*-->/);
    if (!m) return {};
    const j = JSON.parse(m[1] ?? '{}') as { id?: string; slot?: string; title?: string; order?: number };
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function readMetaOf(dir: string): { id?: string; slot?: string } {
  try {
    const f = join(dir, 'card.html');
    if (!existsSync(f)) return {};
    return parseMeta(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

/** 把一个卡片目录复制到目标（目标已存在就跳过） */
function seedOne(srcDir: string, dstDir: string, out: SeedResult): void {
  try {
    if (existsSync(dstDir)) {
      out.skipped.push(dstDir);
      return;
    }
    mkdirSync(dstDir, { recursive: true });
    let n = 0;
    for (const f of EXT_UI_FILES) {
      const s = join(srcDir, f);
      if (existsSync(s)) {
        cpSync(s, join(dstDir, f));
        n++;
      }
    }
    if (n > 0) out.installed.push(dstDir);
    else out.skipped.push(dstDir + '（没有可复制的文件）');
  } catch (e) {
    out.errors.push(dstDir + ': ' + (e instanceof Error ? e.message : String(e)));
  }
}

export interface SeedResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}

export interface SeedOpts {
  dataRoot: string;
  profileRoot?: string;
  /** 源码 examples/ext-ui 的绝对路径（通常是插件包根/examples/ext-ui） */
  examplesDir?: string;
  /**
   * 额外要铺的数据根（2026-10-27 主人要求：**只铺前两个实例**）。
   *
   * 为什么不铺全部：用户可能建几十个实例，全铺会造成大量目录和无谓 IO。
   * 取前 2 个足够测试 —— 没铺到的实例只是 dock 里少一个扩展页签，不影响任何功能。
   */
  extraDataRoots?: string[];
  /** 最多铺几个数据根（含 dataRoot 自己），默认 2 */
  maxDataRoots?: number;
}

/** 候选数据根：去重 + 限流 */
function pickRoots(opts: SeedOpts): string[] {
  const max = Math.max(1, Math.min(10, opts.maxDataRoots ?? 2));
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (r: string | undefined) => {
    const s = String(r ?? '').trim();
    if (!s) return;
    // ★★ 2026-11-14 修（审查发现）：去重键原来只折 `/`、且**无条件 toLowerCase**。
    //   Windows 上 D:\a\b 与 D:/a/b 是同一个目录，但 key 不同 ⇒ 同一份数据根被扫两遍；
    //   POSIX 上大小写是区分的，无条件小写又会把两个真实目录合并。
    //   统一成：反斜杠/大小写只在 Windows 折叠。
    const plain = s.replace(/[\\/]+/g, "/");
    const key = process.platform === "win32" ? plain.toLowerCase() : s.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  push(opts.dataRoot);
  for (const r of opts.extraDataRoots ?? []) push(r);
  return out.slice(0, max);
}

/**
 * 执行一次铺设。幂等：重复调用不会覆盖已有内容。
 */
export function installExtUi(opts: SeedOpts): SeedResult {
  const out: SeedResult = { installed: [], skipped: [], errors: [] };
  const { profileRoot, examplesDir } = opts;
  // ★ 2026-10-27 主人要求：**只铺前 2 个实例**（用户可能建几十个，全铺太铺张）。
  const roots = pickRoots(opts);
  const dataRoot = roots[0] ?? String(opts.dataRoot ?? '');
  const uiRootOfProfile = profileRoot ? join(profileRoot, '.qqbot-extensions', 'ui') : '';
  const uiRootsOfData = roots
    .map((r) => (r ? join(r, '.qqbot-extensions', 'ui') : ''))
    .filter(Boolean);

  // ── ① 源码示例：examples/ext-ui/<name>/{settings,dock}/ ────────────────
  if (examplesDir && existsSync(examplesDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(examplesDir).filter((n) => {
        try { return statSync(join(examplesDir, n)).isDirectory(); } catch { return false; }
      });
    } catch { names = []; }

    for (const name of names) {
      if (!EXT_ID_RE.test(name)) continue;
      // settings → profile
      const sSrc = join(examplesDir, name, 'settings');
      if (uiRootOfProfile && existsSync(sSrc)) {
        seedOne(sSrc, join(uiRootOfProfile, name + '-settings'), out);
      }
      // dock → 每个候选数据根（最多 maxDataRoots 个）
      const dSrc = join(examplesDir, name, 'dock');
      if (existsSync(dSrc)) {
        for (const ur of uiRootsOfData) seedOne(dSrc, join(ur, name + '-dock'), out);
      }
    }
  }

  // ── ② 已装扩展包：{dataRoot}/extension-packs/<pack>/ui/ ─────────────────
  //    包里 slot=settings 的卡片要铺到 profile（dock 的已经在 dataRoot，不用动）
  if (uiRootOfProfile && dataRoot) {
    const packsRoot = join(dataRoot, 'extension-packs');
    let packs: string[] = [];
    try {
      if (existsSync(packsRoot)) {
        packs = readdirSync(packsRoot).filter((n) => {
          try { return statSync(join(packsRoot, n)).isDirectory(); } catch { return false; }
        });
      }
    } catch { packs = []; }

    for (const pack of packs) {
      const uiDir = join(packsRoot, pack, 'ui');
      if (!existsSync(uiDir)) continue;
      let cards: string[] = [];
      try {
        cards = readdirSync(uiDir).filter((n) => {
          try { return statSync(join(uiDir, n)).isDirectory(); } catch { return false; }
        });
      } catch { cards = []; }

      for (const card of cards) {
        const src = join(uiDir, card);
        const meta = readMetaOf(src);
        if (meta.slot !== 'settings') continue;          // 只搬 settings；dock 无需搬
        const id = EXT_ID_RE.test(String(meta.id ?? '')) ? String(meta.id) : card;
        if (!EXT_ID_RE.test(id)) continue;
        seedOne(src, join(uiRootOfProfile, id), out);
      }
    }
  }

  return out;
}
