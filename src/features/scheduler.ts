/**
 * scheduler.ts — 定时唤醒（M3, 2026-09-03 新增, v3 改造）
 *
 * 对应设计文档 M3「定时+互动召回」。
 *
 * 机制（v3，主人指正后重构）：
 *  - 配置按"目标分组"：config.schedule.targets[] = {id,name?,scope(group|c2c),
 *    targetId, tasks:[{id,time "HH:MM",enabled,prompt?}]} —— 号码只填一次, 下面挂多条时刻。
 *  - 每 30s 检查；当前本地时刻 HH:MM 命中某 target 下某条 enabled 任务且今天没触发 → 触发。
 *  - **触发 = 伪造一条"定时任务发来"的入站消息，直接喂 handleInbound**——
 *    与真实 QQ 消息走完全同一条链路：getOrCreate 用同 peerKey → 命中/resume 该聊天
 *    的**原 dsh 会话**（有群历史记忆/人格/工具上下文），mention 标记 (@you)；
 *    AI 的正常回复经既有 outbound 链路以 bot 身份主动推送到目标聊天。
 *    ✅ 不再另起游离对话、上下文连续、群/私聊都能看到。
 *  - 平台主动消息限制：群需开通"主动消息"权限(已开通, 有频控)；私聊需近 48h
 *    互动窗，窗外拒收 → bootstrap sendMarkdown 三级降级(markdown→text→wakeup)。
 *  - lastRun 落盘 {cwd}/schedule-state.json，触发瞬间乐观记账，每天至多一次；
 *    错过的时刻不补发(等明天)。lastError 留痕最近失败。
 *
 * ⚠️ 本地手改功能（fork 新增）：维护清单见工作区根《插件改动维护注意事项.md》。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImQQBotConfig, ScheduleTargetConfig } from '../config.js';
import { dataRootOf } from '../gateway/data-root.js';
import type { Logger } from '../types.js';
import type { SessionManager } from '../session/index.js';
import { handleInbound } from '../transport/inbound.js';

/** 轮询间隔: 30s(分钟级精度足够, 不会跳整分钟) */
const TICK_MS = 30_000;

interface ScheduleState {
  lastRun: Record<string, string>; // taskId -> YYYY-MM-DD
  lastError?: { taskId: string; at: string; message: string }; // 最近一次触发问题(留痕供主人查)
}

/** 本地 HH:MM */
function nowHHMM(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function todayKey(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 启动定时调度器。返回 stop()：停止轮询并落盘。
 * config 为 live 对象引用(schedule.targets 现读, Web 设置热更新即时生效)。
 */
export function startScheduler(
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): () => void {
  const stateFile = join(dataRootOf(config), 'schedule-state.json');
  const state: ScheduleState = { lastRun: {} };
  try {
    const raw = readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as ScheduleState;
    state.lastRun = parsed?.lastRun ?? {};
    state.lastError = parsed?.lastError;
  } catch {
    state.lastRun = {};
  }
  const inFlight = new Set<string>();

  function persist(): void {
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8');
    } catch (err) {
      logger.warn?.(`[scheduler] state 落盘失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 触发 = 伪造一条"主人发来"的入站消息, 走与真实 QQ 消息完全相同的链路 */
  async function fireTask(
    target: ScheduleTargetConfig,
    task: ScheduleTargetConfig['tasks'][number],
  ): Promise<void> {
    const scope = target.scope === 'c2c' ? 'c2c' : 'group';
    const key = `${scope}:${target.targetId}`;
    logger.info(`[scheduler] fire task=${task.id} (${target.name || target.id}) → ${key} @ ${task.time}`);
    try {
      // 伪造入站消息(与 SDK 消息同形; 无 messageId → 出站自动走主动推送)
      // - 本质仍是"伪造一条消息唤醒 AI 回合"(定时任务必须触发回合), 但内容自报家门:
      //   前缀带 [定时任务 + 系统日期时间], senderName 用中性名, 不打假 (@you) —— AI 干活照干,
      //   但不会把定时触发记成"主人真人发言/被真人点名"(防污染主人交互记忆)。
      // - group: peerId 取 groupOpenid(=target.targetId)
      // - c2c:   peerId 取 senderId —— 必须等于 target.targetId(该用户 openid), 才能命中原会话
      const now = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const rawPrompt = task.prompt?.trim() || '在吗~ 出来说说话吧';
      const trigger = `[定时任务 ${ts}] ${rawPrompt}`;
      const fakeMsg = {
        kind: scope,
        senderId: scope === 'c2c' ? target.targetId : 'master',
        senderName: '定时任务',
        content: trigger,
        messageId: '',
        timestamp: now.toISOString(),
        groupOpenid: scope === 'group' ? target.targetId : undefined,
        msgType: 0,
        attachments: undefined,
      };
      await handleInbound(
        fakeMsg,
        manager,
        config,
        logger,
        // ★ 2026-11-01（issue #37，作者 LLLCCKK 定位得很准）：
        //   以前这里传 `undefined` ⇒ 价值评分拿不到"强制入站"标记；而伪造消息又**故意不带 @**
        //   （避免污染"被点名"语义）⇒ `gate:'block'` 下"提醒大家该睡觉了"这类提醒句恒定低分
        //   （实测 0.11~0.14 < 0.5）→ 只 append 进上下文、群里一个字都不发，
        //   可 schedule-state.json 里 lastRun 已写 ⇒ 当天不再补发，用户只觉得"定时任务没生效"。
        //   定时任务是"主人自己排的闹钟"，值不值得回在配置那一刻就定了，不该再由价值评分二次裁决
        //   ⇒ 带上插件已有的强制入站标记（它**不伪造 @**，真实消息的评分与拦截不受影响）。
        {
          qqInboundForceWake: true,
          qqInboundForceWakeReason: 'scheduled-task',
        },
      );
      logger.info(`[scheduler] injected inbound → handleInbound: task=${task.id} key=${key}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.lastError = { taskId: task.id, at: new Date().toISOString(), message: msg };
      persist();
      logger.error(`[scheduler] fire failed: task=${task.id} ${msg}`);
    }
  }

  function tick(): void {
    let targets: ScheduleTargetConfig[] = [];
    try {
      targets = config.schedule?.targets ?? [];
    } catch { /* config 未就绪 */ }
    const tasksNow: Array<{ target: ScheduleTargetConfig; task: ScheduleTargetConfig['tasks'][number] }> = [];
    for (const target of targets) {
      if (!target?.id || !target.targetId) continue;
      for (const task of target.tasks ?? []) {
        if (!task?.id || !task.enabled) continue;
        tasksNow.push({ target, task });
      }
    }
    if (tasksNow.length === 0) return;

    const hhmm = nowHHMM();
    const today = todayKey();
    for (const { target, task } of tasksNow) {
      if ((task.time ?? '') !== hhmm) continue;
      if (state.lastRun[task.id] === today) continue; // 今天已触发
      if (inFlight.has(task.id)) continue; // 同分钟并发防重
      inFlight.add(task.id);
      // 触发瞬间即记账(乐观) —— 宁可漏发也不重复打扰
      state.lastRun[task.id] = today;
      persist();
      void fireTask(target, task).finally(() => inFlight.delete(task.id));
    }
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  // 启动后先跑一次: 若此刻正好命中某任务且今天没发过则触发;
  // 错过的时刻不补发(准点触发, 避免新设任务被立即补发打扰), 等明天同一时刻。
  tick();
  const targetCount = (config.schedule?.targets ?? []).length;
  logger.info(`[scheduler] started (${targetCount} targets, state=${stateFile})`);

  return () => {
    clearInterval(timer);
    persist();
    logger.info('[scheduler] stopped');
  };
}
