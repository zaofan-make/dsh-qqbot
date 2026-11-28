/**
 * gate-silence.test.ts — 回复闸门静默后的"干净收场"（2026-09-14 主人要求）
 *
 * 现场：她调 `reply_gate{reply:false}` 决定吃瓜，紧接着还想"顺手记一下群友喜好"
 *   （`people_memo`），但那批调用已被闸门的 `agent.cancel` 连带中止 → 聊天里刷出
 *   `❌ 工具 people_memo 执行失败 / Error: tool call aborted`。
 * 主人原话："能把回复闸门、写日记失败改成直接停止 llm 的回合吗，而不是报错"。
 *
 * 口径：**闸门一关，本回合剩下的工具一律不展示**（abort 是有意行为，不是故障）。
 */
import { describe, expect, it } from 'vitest';
import { isGateSilence } from './outbound.js';

describe('isGateSilence — 认得出"闸门判定静默"', () => {
  it('reply:false → 是静默（不管 reason 写什么）', () => {
    expect(isGateSilence(JSON.stringify({ reason: '群友继续聊重口题材，未@我，静默', reply: false }))).toBe(true);
  });

  it('reply:true → 不是静默（正常开口，工具结果照常展示）', () => {
    expect(isGateSilence(JSON.stringify({ reason: '被@需回复', reply: true }))).toBe(false);
  });

  // ★ 2026-11-28（1.13.34）：reason 与 reply 自相矛盾时不认静默 —— 不误吞 aborted
  it('reason 写着"要回复"却传 reply:false → 不是静默（矛盾，不当静默吞掉）', () => {
    expect(isGateSilence(JSON.stringify({ reason: '用户直接@我提问，需要回复', reply: false }))).toBe(false);
    expect(isGateSilence(JSON.stringify({ reason: '被@了，该回', reply: false }))).toBe(false);
  });

  it('真正静默的 reason 不含矛盾词 → 仍是静默', () => {
    expect(isGateSilence(JSON.stringify({ reason: '群友继续聊重口题材，未@我，静默', reply: false }))).toBe(true);
  });

  it('字段缺失 / 坏 JSON / 空 → 一律当"不是静默"（宁可多展示，不可误吞）', () => {
    expect(isGateSilence(JSON.stringify({ reason: '只写了理由' }))).toBe(false);
    expect(isGateSilence('not json')).toBe(false);
    expect(isGateSilence('')).toBe(false);
  });

  // ★ 2026-11-28（CodeRabbit Major）：**否定语境不能被当成"想回复"**
  //   「不需要回复」里同时含「需要回复」，只按关键词判就会把正常静默判成矛盾。
  it('reason 是否定语境 → 仍是静默', () => {
    expect(isGateSilence(JSON.stringify({ reason: '未@我，不需要回复', reply: false }))).toBe(true);
    expect(isGateSilence(JSON.stringify({ reason: '不用搭理他', reply: false }))).toBe(true);
    expect(isGateSilence(JSON.stringify({ reason: '没必要回', reply: false }))).toBe(true);
  });

  // 「已经有群友回答了」里含「回答」，同样不能判成"想回复"
  it('reason 是已答语境 → 仍是静默', () => {
    expect(isGateSilence(JSON.stringify({ reason: '已经有群友回答了', reply: false }))).toBe(true);
    expect(isGateSilence(JSON.stringify({ reason: '别人已经回了', reply: false }))).toBe(true);
  });

  // ★ 2026-11-28（CodeRabbit Major）：**私聊里闸门恒放行** —— 工具返回 stopped:false、
  //   也不会 agent.cancel，即"静默"根本没发生。这里若返回 true，调用方会记进 gateSilenced，
  //   后续工具结果与回合结束通知全被吞掉，而模型其实正在开口。
  it('私聊(c2c)：reply:false 也不算出站静默；同一 reason 在群里照旧静默', () => {
    const args = JSON.stringify({ reason: '只是别人在聊天', reply: false });
    expect(isGateSilence(args, 'c2c')).toBe(false);
    expect(isGateSilence(args, 'group')).toBe(true);
  });
});
