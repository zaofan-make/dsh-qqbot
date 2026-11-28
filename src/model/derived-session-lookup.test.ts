/**
 * 派生 sessionId 公式 + 反查（`findKeyBySessionIdOrDerived`）的回归测试。
 *
 * 为什么需要这一份：`isQqBoundSession`、ctx-smart、备忘、会话类型这几处判据
 * **扛不扛得住进程重启**，全靠这条反查 —— 而普通建档的 QQ 会话**不写** `sessionIds` 映射
 * （只有 fork / forceNew / create 失败轮换写），只能靠 `sessionCfg` + 派生 id 认出来。
 * 在加这份测试之前，这个结论是靠手工实测撑着的（本机 8 个会话 = 6 条映射 + 2 条派生），
 * 下次谁重构一下 `deriveSessionId` 就没人守了。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrefsStore } from './prefs-store.js';
import { deriveSessionIdFromKey } from '../shared/utils.js';

/**
 * 固定的 key → id 对照（**全是虚构的 appId / openid**，只为把公式钉死）。
 * 一旦有人改了派生公式（比如换成 md5、改切片位置、加前缀），这里会先炸。
 * 公式与真实会话一致性另行实测核对过（见 CHANGELOG 1.13.30 的说明），不在测试里放真实 id。
 */
const GOLDEN: ReadonlyArray<readonly [string, string]> = [
  ['qqbot:1234567890:group:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '17801090-7a4d-065a-29ba-1edd9ba6e310'],
  ['qqbot:1234567890:group:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '1782460d-6dce-b313-b464-d22e1e988064'],
  ['qqbot:1234567890:c2c:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'ef9f9194-6020-1106-0fc0-b03a1f65081b'],
];

describe('deriveSessionIdFromKey（派生 sessionId 公式）', () => {
  it('golden：固定 sessionKey 必须得到固定 id —— 改公式这里会先炸', () => {
    for (const [key, want] of GOLDEN) expect(deriveSessionIdFromKey(key)).toBe(want);
  });

  it('同输入恒等；空串也不抛（返回形状合法的 uuid）', () => {
    expect(deriveSessionIdFromKey(GOLDEN[0][0])).toBe(deriveSessionIdFromKey(GOLDEN[0][0]));
    expect(deriveSessionIdFromKey('')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('findKeyBySessionIdOrDerived（映射 + 派生两路反查）', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  /** 造一个只有两张表的 prefs 文件（注意：必须**先写盘再构造**，构造里会 load） */
  function makeStore(ids: Record<string, string>, cfgKeys: string[]): PrefsStore {
    dir = mkdtempSync(join(tmpdir(), 'qqbot-prefs-'));
    writeFileSync(
      join(dir, 'model-prefs.json'),
      JSON.stringify({
        overrides: {},
        sessionIds: ids,
        sessionCfg: Object.fromEntries(cfgKeys.map((k) => [k, { cwd: 'x' }])),
        sessionPresets: {},
      }),
      'utf8',
    );
    return new PrefsStore(undefined, dir);
  }

  const MAPPED_KEY = 'qqbot:1234567890:group:AAA';
  const MAPPED_ID = '11111111-2222-3333-4444-555555555555';
  const DERIVED_KEY = 'qqbot:1234567890:group:BBB';

  it('有映射的会话：直查命中（fork / forceNew 轮换过的那种）', () => {
    const store = makeStore({ [MAPPED_KEY]: MAPPED_ID }, [MAPPED_KEY, DERIVED_KEY]);
    expect(store.findKeyBySessionIdOrDerived(MAPPED_ID)).toBe(MAPPED_KEY);
  });

  it('普通建档（没有映射）：靠 sessionCfg + 派生 id 也要认出来 —— 这是本改动的核心', () => {
    const store = makeStore({ [MAPPED_KEY]: MAPPED_ID }, [MAPPED_KEY, DERIVED_KEY]);
    const derivedId = deriveSessionIdFromKey(DERIVED_KEY);
    // 新增能力：能认出来
    expect(store.findKeyBySessionIdOrDerived(derivedId)).toBe(DERIVED_KEY);
    // 回归保护：证明这个测试确实在测**新加的那一路** —— 旧 API 对同一条 id 是查不到的。
    // （如果哪天有人把两级查合回一级、或把派生兜底删掉，这一行会先失败。）
    expect(store.findKeyBySessionId(derivedId)).toBeUndefined();
  });

  it('无关 id / 空值 → undefined（纯 web 会话必须判成"不是 QQ 会话"）', () => {
    const store = makeStore({}, ['qqbot:1234567890:group:CCC']);
    expect(store.findKeyBySessionIdOrDerived('99999999-8888-7777-6666-555555555555')).toBeUndefined();
    expect(store.findKeyBySessionIdOrDerived('')).toBeUndefined();
    expect(store.findKeyBySessionIdOrDerived('   ')).toBeUndefined();
  });

  it('sessionCfg 为空时不会抛，按"查不到"处理', () => {
    const store = makeStore({}, []);
    expect(store.findKeyBySessionIdOrDerived(deriveSessionIdFromKey(DERIVED_KEY))).toBeUndefined();
  });
});
