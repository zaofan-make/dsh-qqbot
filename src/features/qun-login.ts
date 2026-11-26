/**
 * qun-login.ts — 免扫码登录 qun.qq.com（自带浏览器 + CDP，**零第三方依赖**）
 *
 * ── 原理（2026-10-02 实测结论，别再猜）──
 *   ① 「点头像授权登录」靠两个来源，任意一个在就能用：
 *        a) 浏览器 profile 里的 QQ 长期登录 cookie（ptui_loginuin / qlogin_uid / pt4_token / RK …）
 *        b) 本机 QQ 客户端的本地服务（https://localhost.ptlogin2.qq.com:4301/pt_get_uins）
 *      实测：QQ 客户端关掉后 (b) 立刻消失（端口无监听、页面只剩"扫码登录"），
 *            但只要 (a) 还在，登录页**照样显示头像**、点一下就能换新凭据。
 *   ② 因此本模块的核心价值：**只要 profile 活着，登录就是全自动的，永远不用再扫码**。
 *      第一次（profile 里还没有 QQ cookie）才需要扫码 —— 那时把二维码截图交给上层发给用户。
 *   ③ skey 约 1 天过期，但过期后不需要用户做任何事：重新打开登录页 → 自动点头像 → 换新的。
 *
 * ── 实现 ──
 *   启动系统 Edge/Chrome 的 headless + 独立 user-data-dir + 调试端口，
 *   用 Node 内置 WebSocket 连 CDP，执行 JS 点头像 / 读 cookie。
 *   用户零安装、插件零依赖。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadQunCookie, verifyQunCookieRaw } from './qun-admin.js';

/**
 * 两个入口页面，**必须分开用**（实测踩坑，卡了很久）：
 *
 * ① CHECK_URL —— 用来判断"profile 里是不是已经有有效登录态"。
 *    用 qun.qq.com 本体：已登录就直接进群管理页，读 cookie + 验证接口即可，一次都不用登。
 *
 * ② LOGIN_URL —— 用来"让人登录"（点头像 / 扫二维码）。
 *    用 xui.ptlogin2 的快捷登录面板页，因为：
 *    · **qun.qq.com 的登录面板是 iframe**（嵌的正是这个 xlogin 页）→ 在主文档里
 *      `document.querySelector('#qrlogin_img')` **永远查不到二维码**，头像同理 ✗
 *    · xlogin 页本身就是那个面板，二维码(#qrlogin_img)/头像(#qlogin_list) 都在**主文档**里 ✓
 *    · 但 xlogin 页只认 ptlogin2 域的身份 cookie（会忽略 qun.qq.com 已有的登录态），
 *      所以"检查是否已登录"这件事还是得交给 qun.qq.com。
 */
const CHECK_URL = 'https://qun.qq.com/';
const LOGIN_URL = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=715030901&daid=73&style=20'
  + '&hide_title_bar=1&low_login=0&qlogin_auto_login=1&no_verifyimg=1&link_target=blank'
  + '&proj_self_def=1&s_url=' + encodeURIComponent('https://qun.qq.com/');

/** 二维码元素的候选选择器（页面改版时在这里加就行） */
const QR_SELECTORS = [
  '#qrlogin_img',
  '#qrlogin_img_box img',
  '#qr_img',
  '.qrcode img',
  '#qlogin_qr img',
];

export interface QunCookie { uin: string; skey: string; p_skey?: string }

export interface StartResult {
  ok: boolean;
  msg: string;
  /** 需要扫码时给出二维码图片路径（上层用 send_media 发给用户） */
  qrPath?: string;
  /** 自动点头像成功时直接给出凭据 */
  cookie?: QunCookie;
}

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

// ───────────────────────── 找浏览器 ─────────────────────────

/** 找系统浏览器（Edge 优先：Windows 必装）。可用 QUN_BROWSER 环境变量覆盖。 */
export function findSystemBrowser(): string | null {
  const env = String(process.env['QUN_BROWSER'] ?? '').trim();
  if (env && existsSync(env)) return env;
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const lad = process.env['LOCALAPPDATA'] ?? '';
  const cands = [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of cands) {
    try { if (c && existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// ───────────────────────── 最小 CDP 客户端 ─────────────────────────

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

async function connectCdp(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 连接超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP 连接失败')); }, { once: true });
  });
  let seq = 0;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof m.id !== 'number') return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message ?? 'CDP error'));
      else p.res(m.result);
    } catch { /* ignore */ }
  });
  return {
    send(method, params) {
      const id = ++seq;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        try { ws.send(JSON.stringify({ id, method, params: params ?? {} })); }
        catch (e) { pending.delete(id); rej(e as Error); return; }
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function evalJs<T = unknown>(cdp: Cdp, expr: string): Promise<T | undefined> {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return (r as { result?: { value?: T } } | undefined)?.result?.value;
}

// ───────────────────────── 启动浏览器 ─────────────────────────

interface BrowserHandle { proc: ChildProcess; port: number; kill: () => void }

/** 清掉 profile 的进程锁（残留进程占用时，浏览器会以 code=21 立刻退出） */
function cleanProfileLocks(dir: string): void {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(dir, f), { force: true, recursive: true }); } catch { /* ignore */ }
  }
}

/**
 * 杀掉浏览器**整个进程树**。
 * ⚠️ 不能用 proc.kill()：它只杀主进程，渲染/GPU 子进程会活下来继续锁住 profile，
 *    下次启动就 code=21（实测踩坑）。
 */
function killTree(proc: ChildProcess): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
  } catch { /* 落到下面的兜底 */ }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
}

async function launchBrowser(exe: string, userDataDir: string, headless: boolean): Promise<BrowserHandle> {
  try { mkdirSync(userDataDir, { recursive: true }); } catch { /* ignore */ }
  cleanProfileLocks(userDataDir);
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=560,760',
    // 沙箱里跑的浏览器不需要额外权限；headless 下这几项能少很多噪音日志
    '--no-service-autorun',
    '--password-store=basic',
    CHECK_URL,   // 启动先开 qun.qq.com 判断是否已有登录态；需要人登录时再跳到 xlogin 面板
  ];
  // ⚠️ windowsHide 千万不能设 true：对 msedge 这类 GUI 程序，它会让浏览器主窗口**根本显示不出来**
  //   （实测：进程起来了、CDP 也通，但 11 个进程 MainWindowHandle 全为 0，用户看不到二维码）
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
  const port = await new Promise<number>((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('浏览器启动超时（没拿到调试端口）')), 25000);
    proc.stderr?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
      if (m && m[1]) { clearTimeout(t); res(Number(m[1])); }
    });
    proc.on('exit', (c) => { clearTimeout(t); rej(new Error('浏览器提前退出 code=' + String(c))); });
    proc.on('error', (e) => { clearTimeout(t); rej(e); });
  });
  const kill = () => { killTree(proc); };
  return { proc, port, kill };
}

/** 等页面目标出现，返回它的 debugger ws 地址 */
async function pageWsUrl(port: number, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await r.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* ignore */ }
    await sleep(300);
  }
  throw new Error('没找到浏览器页面目标');
}

// ───────────────────────── 登录会话（保持浏览器活着等扫码） ─────────────────────────

interface LoginSession {
  handle: BrowserHandle;
  cdp: Cdp;
  dataRoot: string;
  at: number;
  qrPath?: string;
  /** 头像点过了（等跳转） */
  clicked?: boolean;
  /**
   * 创建该会话的实例归属（2026-11-26，CodeRabbit #92）。
   * dispose 时只关掉**自己所属**的会话，避免多实例/热重载互相关掉对方正在等扫码的浏览器。
   * 未传 owner 的调用（历史外部调用）记为 undefined，只能被全局清理命中。
   */
  owner?: object;
}

const sessions = new Map<string, LoginSession>();

/**
 * 生命周期代次（2026-11-26，CodeRabbit #92；M3 修正为按 owner 分桶）。
 *
 * `disposeQunLogin()` 是同步的，而 `qunBrowserLoginStart()` 要过好几个 `await` 才会
 * `sessions.set()`。若卸载正好发生在这段 await 中间，旧调用醒来后仍会新建浏览器、
 * 重新装退出钩子、重启扫描器 —— 资源就复活了。
 *
 * ⚠️ 代次必须**按 owner 分开**：早先版本用一个全局计数器，导致
 *    「实例 B 卸载 → 全局 +1 → 实例 A 正在进行的登录醒来后误判自己过期，把自己 kill 掉」。
 *    这与"只清自己的"目标直接矛盾。
 *    owner === undefined 表示进程级全局清理（`disposeQunLogin()` 无参时使用）。
 */
const lifecycleGenerations = new Map<object | undefined, number>();

/**
 * 当前实例的归属 token（N1，2026-11-26 复审）。
 *
 * 为什么需要：生产唯一的登录入口 `channel-tools.ts` 调
 * `qunBrowserLoginStart(dataRoot, { headless: true })` 时**不传 owner**，
 * 而 dispose 端传的是 `instanceToken` —— 两者落在不同的桶里，
 * 于是 `stale()` 恒为 false，代次检查一次都不会触发（M3 白干）。
 *
 * 做法：由插件 `apply()` 通过 {@link setQunLoginOwner} 注入本实例 token，
 * `qunBrowserLoginStart` 取 `opts.owner ?? currentOwner` 兜底 ——
 * 这样外部扩展/内部命令不传 owner 也能归到当前实例，卸载时能被正确作废。
 */
let currentOwner: object | undefined;

/** 由插件 apply() 设置：本进程当前实例的归属 token（传 undefined = 清除） */
export function setQunLoginOwner(owner: object | undefined): void {
  currentOwner = owner;
}

function genOf(owner: object | undefined): number {
  return lifecycleGenerations.get(owner) ?? 0;
}

function bumpGen(owner: object | undefined): void {
  lifecycleGenerations.set(owner, genOf(owner) + 1);
}

/** 清理本次调用自己造的句柄（还没进 sessions，不能靠 closeSession） */
function closeOwned(handle: BrowserHandle, cdp?: Cdp | null): void {
  if (cdp) { try { cdp.close(); } catch { /* ignore */ } }
  try { handle.kill(); } catch { /* ignore */ }
}

function closeSession(dataRoot: string): void {
  const s = sessions.get(dataRoot);
  if (!s) return;
  try { s.cdp.close(); } catch { /* ignore */ }
  try { s.handle.kill(); } catch { /* ignore */ }
  sessions.delete(dataRoot);
}

// ── 进程兜底：绝不让浏览器进程攒着（2026-10-02 实测踩到：攒了 9 个同 profile 的 msedge）──

/** 会话空闲多久自动关掉（与 wait 的 5 分钟上限一致） */
const SESSION_IDLE_MS = 5 * 60 * 1000;

/**
 * 宿主退出或插件卸载时把所有浏览器会话一起清理，避免残留孤儿进程。
 * 不注册 SIGINT/SIGTERM 并调用 process.exit(0)，以免绕过 DSH 宿主优雅停机直接强杀宿主进程。
 */
let exitHookInstalled = false;
function killAllSessions(): void {
  for (const dr of Array.from(sessions.keys())) {
    try { closeSession(dr); } catch { /* ignore */ }
  }
}
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  try { process.once('exit', killAllSessions); } catch { /* ignore */ }
}

/**
 * 供插件 dispose 生命周期调用：清理登录浏览器会话与空闲定时扫描器。
 *
 * @param owner 传入时只关掉**该实例创建**的会话（多实例/热重载安全）；
 *              不传则全局清理（进程级退出、历史外部调用保持旧行为）。
 *
 * 扫描器与退出钩子是**模块级共享资源**：只有当清理后已经没有任何会话了才撤掉，
 * 否则会误伤其他实例仍在用的会话（CodeRabbit #92）。
 */
export function disposeQunLogin(owner?: object): void {
  if (owner === undefined) {
    // 进程级全局清理：所有会话 + 共享资源一起收
    for (const dr of Array.from(sessions.keys())) {
      try { closeSession(dr); } catch { /* ignore */ }
    }
    // ★ N2（复审）：只推 undefined 桶是不够的 —— 带 owner 的进行中登录醒来后
    //   仍会 sessions.set 并把刚撤掉的退出钩子重新装回去（全局清理之后资源又活了）。
    //   这里把所有桶一起推一遍（先快照 keys，避免边迭代边改 Map）。
    for (const k of Array.from(lifecycleGenerations.keys())) bumpGen(k);
    bumpGen(undefined);
    releaseSharedIfIdle();
    return;
  }

  // 单实例清理：只推进**自己这个桶**的代次（M3：不误杀别的实例正在进行的登录）
  bumpGen(owner);

  for (const [dr, sess] of Array.from(sessions.entries())) {
    // 自己的；以及**无主**的（M6：外部扩展建的会话没人认领，谁卸载谁顺手收掉，
    //   否则它们只会在进程退出时才被清 —— 热重载后浏览器进程一直挂着）
    if (sess.owner === owner || sess.owner === undefined) {
      try { closeSession(dr); } catch { /* ignore */ }
    }
  }

  releaseSharedIfIdle();
}

/** 没有任何会话了，才撤掉模块级共享资源（定时清扫器 + 退出钩子） */
function releaseSharedIfIdle(): void {
  if (sessions.size !== 0) return;
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  if (exitHookInstalled) {
    try { process.off('exit', killAllSessions); } catch { /* ignore */ }
    exitHookInstalled = false;
  }
}

/** 空闲清理：每分钟扫一次，超过 SESSION_IDLE_MS 没动静的会话连浏览器一起关掉 */
let sweeper: ReturnType<typeof setInterval> | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [dr, s] of Array.from(sessions.entries())) {
      if (now - s.at > SESSION_IDLE_MS) {
        try { closeSession(dr); } catch { /* ignore */ }
      }
    }
    // 没会话了就把定时器也停掉（别让空转的 timer 拖住进程退出）
    if (sessions.size === 0 && sweeper) { clearInterval(sweeper); sweeper = null; }
  }, 60 * 1000);
  try { (sweeper as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
}

/**
 * 杀掉占用指定 profile 的**残留**浏览器进程（历史泄漏的兜底清理；只在启动出问题时调用）。
 *
 * ⚠️ 必须用 spawnSync **同步等待**：异步 spawn 的话，调用方还没来得及重试、PowerShell 才刚启动，
 *   于是又撞一次 code=21（实测踩过：重试仍然失败，看着像"重试没用"，其实是清理没跑完）。
 */
function killByProfile(profileDir: string): void {
  if (process.platform !== 'win32') {
    // POSIX（Linux/Android/macOS）：按命令行里的 profile 路径杀残留进程。
    // 原来这里直接 return —— 残留浏览器会继续锁住 profile，下次启动仍是 code=21。
    try {
      spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore', timeout: 20000 });
    } catch { /* 没有 pkill 就放弃，不影响主流程 */ }
    return;
  }
  try {
    const safe = profileDir.replace(/'/g, "''");
    const cmd = 'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'"'
      + ` | Where-Object { $_.CommandLine -like '*${safe}*' }`
      + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    spawnSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  } catch { /* ignore */ }
}

export function qunLoginSessionAlive(dataRoot: string): boolean {
  return sessions.has(dataRoot);
}

export function qunLoginSessionClose(dataRoot: string): void {
  closeSession(dataRoot);
}

/** 从 document.cookie 串里抠出凭据 */
function parseCookie(raw: string): QunCookie | null {
  const pick = (k: string): string => {
    const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]*)').exec(raw);
    return m && m[1] ? m[1] : '';
  };
  const uinRaw = pick('uin') || pick('p_uin');
  const uin = (/(\d{5,12})/.exec(uinRaw) ?? [])[1] ?? '';
  const skey = pick('skey');
  const p_skey = pick('p_skey');
  if (!uin || !skey) return null;
  return { uin, skey, p_skey };
}

/** 页面还在登录页吗（用来判断是否已跳进 qun.qq.com） */
async function currentHref(cdp: Cdp): Promise<string> {
  try { return (await evalJs<string>(cdp, 'location.href')) ?? ''; } catch { return ''; }
}

/**
 * 尝试在页面上读凭据；读到**并且实测有效**才返回。
 *
 * ⚠️ 为什么要"实测"：页面只判断 cookie 在不在（skey 失效也不会跳登录页），
 *   所以会出现"看起来已登录、服务端却早就不认账"（`{"ec":4,"em":"no login"}`）。
 *   实测踩过：面板显示"已登录"、群列表却是空的 —— 就是因为读了这份**已被顶掉的** skey。
 *   不验证的话，登录流程会一直"复用"这份废凭据，永远等不到重新授权。
 */
async function tryReadCookie(cdp: Cdp): Promise<QunCookie | null> {
  try {
    const href = await currentHref(cdp);
    if (!/qun\.qq\.com/.test(href) || /\/login/.test(href)) return null;
    const raw = (await evalJs<string>(cdp, 'document.cookie')) ?? '';
    const c = parseCookie(String(raw));
    if (!c) return null;
    const ok = await verifyQunCookieRaw(c);
    return ok ? c : null;
  } catch { return null; }
}

/**
 * 找头像元素并点它；返回点了几个。
 * ⚠️ 不能只看容器存不存在 —— `#qlogin_list` 在"没有可授权账号"时也照样存在（空容器），
 *    必须要求里面有**可见的** a/img 才算真头像（实测踩过：误判导致日志说"点了头像但没跳转"）。
 */
async function clickAvatar(cdp: Cdp): Promise<number> {
  const expr = `(function(){
    const root = document.querySelector('#qlogin_list')
      || document.querySelector('.qlogin_list')
      || document.querySelector('#qlogin');
    if (!root) return 0;
    const cand = root.querySelectorAll('a, img, .face');
    for (const el of cand) {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 16 || r.height < 16) continue;   // 不可见的忽略
      const target = (el.tagName === 'IMG' && el.parentElement) ? el.parentElement : el;
      try { target.click(); } catch (e) { /* ignore */ }
      return 1;
    }
    return 0;
  })()`;
  try {
    const n = await evalJs<number>(cdp, expr);
    return Number(n) || 0;
  } catch { return 0; }
}

/**
 * 把二维码元素截图存盘。
 *
 * ⚠️ **找不到二维码就返回 undefined，绝不整页截图兜底** ——
 *   实测踩过：页面停在"假已登录"状态时没有二维码元素，整页截图把群管理页拍下来当二维码发了出去，
 *   主人拿到一张"已登录界面"的图，完全没法扫，还以为是登录成功了。
 *   宁可不给图，也不要给错图（上层可以据此提示"没拿到二维码"）。
 */
async function shotQr(cdp: Cdp, dataRoot: string): Promise<string | undefined> {
  const out = join(dataRoot, 'qun-login-qr.png');
  try {
    const sels = JSON.stringify(QR_SELECTORS);
    const box = await evalJs<{ x: number; y: number; w: number; h: number } | null>(cdp, `(function(){
      const sels = ${sels};
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.getBoundingClientRect) {
          const r = el.getBoundingClientRect();
          if (r.width > 40 && r.height > 40) return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      const img = Array.from(document.images || []).find(function(i){ return i.width > 80 && i.height > 80; });
      if (img) { const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
      return null;
    })()`);
    if (!box || box.w <= 40 || box.h <= 40) return undefined;   // 没二维码 → 不出图
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.w + 16, height: box.h + 16, scale: 1 },
    });
    const b64 = (r as { data?: string } | undefined)?.data;
    if (!b64) return undefined;
    try { mkdirSync(dataRoot, { recursive: true }); } catch { /* ignore */ }
    writeFileSync(out, Buffer.from(b64, 'base64'));
    return out;
  } catch { return undefined; }
}

/**
 * 第一步：开浏览器 → 有头像就自动点（免扫码），没头像就出二维码。
 * 拿到凭据就返回 cookie 并关掉浏览器；需要扫码则**保留浏览器**，让上层把 qrPath 发给用户，
 * 之后用 qunBrowserLoginWait 继续等。
 */
export async function qunBrowserLoginStart(
  dataRoot: string,
  opts: { headless?: boolean; profileDir?: string; owner?: object } = {},
): Promise<StartResult> {
  // 记下进场代次（按 owner 分桶）：后面每个 await 之后都可能已被卸载（CodeRabbit #92 / M3）
  // N1：外部调用方（channel-tools / 扩展）通常不传 owner —— 兜到当前实例，
  //     否则代次桶是 undefined，dispose 推进的是 instanceToken 桶，stale() 永远 false。
  const owner = opts.owner ?? currentOwner;
  const generation = genOf(owner);
  /** 本次调用是否已被卸载作废 */
  const stale = (): boolean => generation !== genOf(owner);
  const exe = findSystemBrowser();
  if (!exe) {
    return { ok: false, msg: '没找到系统浏览器（Edge/Chrome）。可设环境变量 QUN_BROWSER 指向浏览器可执行文件。' };
  }
  // ★ 已有活着的会话就**直接复用**，绝不"先杀掉再新建"：
  //   反复启停正是 code=21 的根源（短命进程持有长命 profile，Windows 的文件锁来不及释放）。
  const existing = sessions.get(dataRoot);
  if (existing) {
    try {
      const ck0 = await tryReadCookie(existing.cdp);
      if (ck0) {
        closeSession(dataRoot);
        return { ok: true, msg: `复用已有浏览器会话并拿到凭据，uin=${ck0.uin}`, cookie: ck0 };
      }
      // 会话还活着但没登录 → 试试点头像（本机 QQ 客户端/身份 cookie 可能已就绪）
      const n0 = await clickAvatar(existing.cdp);
      if (n0 > 0) {
        existing.clicked = true;
        await sleep(2500);
        const ck1 = await tryReadCookie(existing.cdp);
        if (ck1) {
          closeSession(dataRoot);
          return { ok: true, msg: `复用会话 + 点头像授权成功，uin=${ck1.uin}`, cookie: ck1 };
        }
      }
      // 还是没登录 → 就把上一次的二维码继续用（3 分钟内有效）
      if (existing.qrPath) {
        existing.at = Date.now();
        return { ok: true, qrPath: existing.qrPath, msg: '复用上一次的二维码（仍在有效期内）。请扫完调 wait。' };
      }
    } catch { /* 会话坏了 → 往下走，重新开一个 */ }
  }
  closeSession(dataRoot);   // 清掉可能残留的坏会话
  const profileDir = opts.profileDir ?? join(dataRoot, 'browser-profile');
  const headless = opts.headless !== false;
  // ★ 起新浏览器**之前**就把占用该 profile 的残留进程清掉。
  //   只在"失败后重试"里清是来不及的 —— 实测反复撞 code=21，就是因为清理（异步 PowerShell）
  //   还没跑完就重试了。走到这里说明没有可复用的活会话，所以清掉不会有副作用。
  killByProfile(profileDir);
  cleanProfileLocks(profileDir);
  await sleep(700);
  let handle: BrowserHandle;
  try {
    handle = await launchBrowser(exe, profileDir, headless);
  } catch {
    // code=21 = profile 被上次残留的进程占着
    //   → 先杀掉占用该 profile 的残留进程（历史泄漏兜底），再清锁、等一下、重试
    killByProfile(profileDir);
    cleanProfileLocks(profileDir);
    await sleep(1500);
    try {
      handle = await launchBrowser(exe, profileDir, headless);
    } catch (e2) {
      return { ok: false, msg: '启动浏览器失败：' + String((e2 as Error)?.message ?? e2).slice(0, 160) };
    }
  }
  let cdp: Cdp | null = null;
  try {
    const wsUrl = await pageWsUrl(handle.port);
    cdp = await connectCdp(wsUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // ★ M4（审核）：浏览器已经起来了，先确认这次调用还有效。
    //   否则后面几条"免扫码成功"会带着这对 handle/cdp 直接 return，
    //   而它们还没进 sessions（closeSession 查不到）→ 浏览器进程泄漏。
    if (stale()) {
      closeOwned(handle, cdp);
      return { ok: false, msg: '插件已卸载，本次登录已取消。' };
    }
    // 有头模式下把窗口顶到最前面（不然可能被别的窗口盖住，用户找不到二维码）
    if (opts.headless === false) { try { await cdp.send('Page.bringToFront'); } catch { /* ignore */ } }

    // ★ 关键一步：把插件保存的凭据注入浏览器。
    //   为什么必须这么做：浏览器 profile 里的 **session cookie 不会持久化**
    //   （Chromium 正常退出时会清掉它们，实测同一 profile 第二次打开 qun.qq.com 仍是未登录）。
    //   所以插件自己的 cookie 文件才是唯一真相源：每次启动都把凭据喂回浏览器，
    //   页面直接就是已登录状态；skey 若已过期，页面会落到登录页，那就走点头像/扫码。
    const saved = loadQunCookie(dataRoot);
    if (saved) {
      try {
        await cdp.send('Network.enable');
        const pairs: Array<[string, string]> = [
          ['uin', 'o' + saved.uin],
          ['p_uin', 'o' + saved.uin],
          ['skey', saved.skey],
        ];
        if (saved.p_skey) pairs.push(['p_skey', saved.p_skey]);
        for (const [name, value] of pairs) {
          if (!value) continue;
          try {
            await cdp.send('Network.setCookie', { name, value, domain: '.qq.com', path: '/', secure: true });
          } catch { /* 单个 cookie 失败不影响其它 */ }
        }
        await cdp.send('Page.navigate', { url: CHECK_URL });
        await sleep(1800);
        // ★★ 注入之后必须**验证**：这份凭据很可能早就被顶掉了（skey 失效但 cookie 还在）。
        //   不清掉的话，页面会一直停在"看起来已登录"的假状态（没有头像、也没有二维码），
        //   于是登录流程永远拿不到新凭据 —— 实测就是这么卡住的（面板"已登录"但群列表为空）。
        const stillOk = await verifyQunCookieRaw(saved as { uin: string; skey: string; p_skey?: string });
        if (!stillOk) {
          try {
            await cdp.send('Network.enable');
            for (const n of ['uin', 'skey', 'p_skey', 'p_uin', 'pt4_token', 'RK']) {
              for (const d of ['.qq.com', 'qun.qq.com']) {
                try { await cdp.send('Network.deleteCookies', { name: n, domain: d }); } catch { /* ignore */ }
              }
            }
            // ⚠️ 光删 cookie 不够！qun.qq.com 是 SPA，登录痕迹还在 localStorage/sessionStorage 里，
            //   不清它的话前端路由依然显示"已登录"，**登录面板（头像/二维码）根本不会出现**
            //   —— 实测就是这么卡死的：页面看着登着、接口说 no login、也出不了二维码。
            try { await evalJs(cdp, 'try{localStorage.clear();sessionStorage.clear();}catch(e){}'); } catch { /* ignore */ }
            // ⚠️ 同 URL 的 navigate 在 SPA（hash 路由）里可能只改 hash、**不会真的重新加载**，
            //   页面就永远停在"假已登录"（既没头像也没二维码）。所以：先 ignoreCache 强刷，
            //   再带时间戳导航一次，确保走的是全新的文档。
            try { await cdp.send('Page.reload', { ignoreCache: true }); } catch { /* ignore */ }
            await sleep(900);
            await cdp.send('Page.navigate', { url: LOGIN_URL + '?_t=' + Date.now() });
            await sleep(2600);
          } catch { /* 清不掉就照常走 */ }
        }
      } catch { /* 注入失败就照常走未登录流程 */ }
    }
    // 等页面就绪：**先看 profile 里还登着没**（登着就一次都不用登，直接拿走）
    let hit: QunCookie | null = null;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      const ready = await evalJs<string>(cdp, 'document.readyState');
      if (ready !== 'complete' && ready !== 'interactive') continue;
      // ① 最快路径：已有有效登录态
      hit = await tryReadCookie(cdp);
      if (hit) break;
      // ② 登录面板渲染出来了吗（头像/二维码都是 JS 动态塞的）
      const has = await evalJs<number>(cdp, `(function(){ return (document.querySelector('#qlogin_list') || document.querySelector('#qrlogin_img') || document.querySelector('#qr_login') || document.querySelector('.qlogin_list')) ? 1 : 0; })()`);
      if (Number(has) === 1 && i >= 3) break;
    }
    if (hit) {
      closeOwned(handle, cdp);
      return { ok: true, msg: `免扫码：profile 里的登录态还有效，直接取用（uin=${hit.uin}）`, cookie: hit };
    }
    // 再补一次（页面可能刚跳完）
    hit = await tryReadCookie(cdp);
    if (hit) {
      closeOwned(handle, cdp);
      return { ok: true, msg: `免扫码：profile 里的登录态还有效，直接取用（uin=${hit.uin}）`, cookie: hit };
    }
    // ★★ 需要人登录 → 必须**主动跳到 xlogin 面板页**。
    //   为什么不能留在 qun.qq.com：它的登录面板是 **iframe**，二维码(#qrlogin_img)/头像(#qlogin_list)
    //   都在 iframe 的主文档里，从外层 document 查不到 —— 会误判成"页面没有二维码"。
    //   （这段以前被包在 if (saved) 里，没有凭据文件时就整段跳过 ⇒ 卡在 qun.qq.com 出不了码）
    try {
      await cdp.send('Page.navigate', { url: LOGIN_URL + '&_t=' + Date.now() });
      await sleep(2800);
      hit = await tryReadCookie(cdp);
      if (hit) {
        closeOwned(handle, cdp);
        return { ok: true, msg: `登录态有效（uin=${hit.uin}）`, cookie: hit };
      }
    } catch { /* 跳不过去就继续走头像/二维码 */ }
    // ③ 尝试免扫码：点头像授权（profile 里或本机 QQ 客户端提供了账号）
    const n = await clickAvatar(cdp);
    if (n > 0) {
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        const ck = await tryReadCookie(cdp);
        if (ck) {
          closeOwned(handle, cdp);
          return { ok: true, msg: `免扫码登录成功（点头像授权），uin=${ck.uin}`, cookie: ck };
        }
      }
      // 点了但没跳过去：可能是环境校验，继续走扫码兜底
    }
    // ④ 兜底：出二维码
    //   出图前先打一行诊断（页面到底停在哪儿、有没有二维码元素）—— 这类"看起来登着却出不了码"的问题
    //   光看结果猜不出来，必须让页面自己说话。
    try {
      const diag = await evalJs<string>(cdp, `(function(){
        try {
          const imgs = Array.from(document.images || []);
          return JSON.stringify({
            href: String(location.href).slice(0, 120),
            title: document.title,
            qloginList: !!document.querySelector('#qlogin_list'),
            qrImg: !!document.querySelector('#qrlogin_img'),
            qrBox: !!document.querySelector('#qrlogin_img_box'),
            imgs: imgs.length,
            bigImgs: imgs.filter(function(i){ return i.width > 80 && i.height > 80; }).length,
            text: String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 150)
          });
        } catch (e) { return 'diag-err: ' + e; }
      })()`);
      console.log('[qun-login-diag] ' + diag);
    } catch { /* ignore */ }
    const qrPath = await shotQr(cdp, dataRoot);
    // ★ 卸载发生在上面的 await 之间 → 本次调用已经过期，自己把刚造的资源收干净再失败，
    //   绝不 sessions.set（否则就是 CodeRabbit 说的"资源复活"）。
    if (stale()) {
      closeOwned(handle, cdp);
      return { ok: false, msg: '插件已卸载，本次登录已取消。' };
    }
    sessions.set(dataRoot, { handle, cdp, dataRoot, at: Date.now(), qrPath, clicked: n > 0, ...(owner ? { owner } : {}) });
    installExitHook();   // 宿主退出时把浏览器一起带走（不然会成孤儿进程）
    ensureSweeper();     // 空闲超时自动关（不然扫码没扫成会一直挂着）
    if (!qrPath) {
      return {
        ok: true,
        msg: '没能拿到二维码：这个页面上没有二维码元素（可能卡在"假已登录"状态，或登录页结构变了）。'
          + '可以再调一次 login 重试。注意：宁可不给图也不给错图（曾经把整页截图当二维码发出去）。',
      };
    }
    return {
      ok: true,
      qrPath,
      msg: n > 0
        ? '点了头像但没跳转成功，已改出二维码。请把二维码发给用户，扫完后调 wait 继续。'
        : '这台机器没有可用的 QQ 登录态（浏览器 profile 里没有、本机也没有 QQ 客户端），已出二维码。请发给用户扫，扫完后调 wait 继续。',
    };
  } catch (e) {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    closeSession(dataRoot);
    handle.kill();
    return { ok: false, msg: '浏览器登录出错：' + String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/**
 * 第二步：在已开的会话上继续等（扫码 or 点头像跳转完成）。
 * budgetMs 默认 25 秒 —— 别让工具调用卡太久，用户可以多次调。
 */
export async function qunBrowserLoginWait(
  dataRoot: string,
  budgetMs = 25000,
): Promise<{ ok: boolean; done: boolean; msg: string; cookie?: QunCookie }> {
  const s = sessions.get(dataRoot);
  if (!s) return { ok: false, done: false, msg: '没有正在进行的登录会话，请重新调 start' };
  if (Date.now() - s.at > 5 * 60 * 1000) {
    closeSession(dataRoot);
    return { ok: false, done: false, msg: '登录会话超过 5 分钟已关闭，请重新调 start' };
  }
  const deadline = Date.now() + Math.max(3000, budgetMs);
  let last = '等待扫码/授权…';
  while (Date.now() < deadline) {
    const ck = await tryReadCookie(s.cdp);
    if (ck) {
      closeSession(dataRoot);
      return { ok: true, done: true, msg: `登录成功，uin=${ck.uin}`, cookie: ck };
    }
    // 用户可能扫码后卡在确认；顺带再看看头像（万一 QQ 客户端中途起来了）
    if (!s.clicked) {
      const n = await clickAvatar(s.cdp);
      if (n > 0) s.clicked = true;
    }
    const href = await currentHref(s.cdp);
    if (href) last = /xui\.ptlogin2/.test(href) ? '等待扫码/授权…' : '已跳转，正在取凭据…';
    await sleep(1500);
  }
  return { ok: true, done: false, msg: `${last}（这一轮没等到，可以再调 wait；二维码 3 分钟内有效）` };
}

/** 退出登录：清掉浏览器 profile 里的 QQ 登录态（一般不用，留着以后"切换账号"用） */
export function clearBrowserProfile(dataRoot: string): void {
  closeSession(dataRoot);
  try { rmSync(join(dataRoot, 'browser-profile'), { recursive: true, force: true }); } catch { /* ignore */ }
}
