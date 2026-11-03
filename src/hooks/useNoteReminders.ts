import { useEffect, useRef } from 'react';
import {
  NOTE_REMIND_LOG_KEEP_DAYS,
  NOTE_REMIND_LOG_KEY,
  TEXT,
  TIME_PATTERN,
  TOAST_TIMEOUT,
} from '../constants';
import { addDays, dateKey } from '../lib/date';
import { isNoteDeleted } from '../lib/note';
import type { DateKey, Note, TimeKey } from '../types';
import { useAppDispatch } from '../store/StoreContext';
import { showNotification } from './useReminders';
import { useToast } from './useToast';

/* ============================================================================
   笔记闹钟（到点响铃，但**不进复习队列**）

   需求原话：「他可能就是个提醒要刷牙的小事，不是知识点不需要复习，
   不过可以加个闹钟提醒类似事情」。

   所以这条能力和「复习（SRS）」是**两条独立的路**：
   - `note.sr`   → 要背的东西，按间隔重复排期，进复习队列；
   - `note.remind` → 生活提醒，到点响一次，永远不进队列。
   给一条记事加闹钟不会把它变成复习卡（判据仍然是"有没有 sr 键"）。

   === 三条设计红线（改之前先读）===
   ① **到点提醒时绝对不能写 Note。**
      写 Note 会刷 `updatedAt` → 三端云同步 churn（每响一次铃就推一次数据），
      还会把"提醒"污染成"笔记被编辑过"（列表排序乱跳）。只写设备本地 log。
   ② **判定用「已过点即提醒」而不是「精确等于」。**
      轮询是 30 秒一次，写 `=== at` 的话，07:30:15 那一刻不在轮询点上就永远错过。
      用 `nowTime >= at` + "今天已提醒过" 两件套，既不漏也不重。
   ③ **"已提醒过"只存设备本地**（NOTE_REMIND_LOG_KEY），不进 payload ——
      手机上响过、电脑上还没到点，同步它会让另一端少响一次。
   ========================================================================= */

/** 轮询间隔：30 秒（与 useReminders 同款节奏，够准又不费电） */
const REMIND_POLL_MS = 30_000;

/**
 * 已提醒记录：`{ [dateKey: string]: noteId[] }`。
 *
 * 只保留最近 NOTE_REMIND_LOG_KEEP_DAYS 天（今天 + 昨天）：
 * 这份 log 纯粹是防重复响铃的短期记忆，留太长只是给脏数据留空间。
 */
export type NoteRemindLog = Record<string, string[]>;

/** 本地时间 'HH:mm'（24 小时制补零），与 NoteRemind.at 同格式，可直接字符串比较 */
export function currentTimeKey(now: Date = new Date()): TimeKey {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * 本地自然日 'YYYY-MM-DD'。
 *
 * ⚠️ 这里**故意不用 `todayKey(settings.dayStartHour)`**：
 * 闹钟是"墙上的钟"（早上七点半就该响），不是"学习日"。
 * 日界那条规则是给任务/专注归属日用的，套到闹钟上会变成
 * "凌晨 2 点还算昨天"，第二天早上的闹钟就会被误判成"昨天已经响过了"。
 */
export function currentDateKey(now: Date = new Date()): DateKey {
  return dateKey(now);
}

/** 把任意来路不明的值收敛成合法的 NoteRemindLog（坏的键 / 坏的值一律丢，绝不抛） */
function sanitizeLog(raw: unknown): NoteRemindLog {
  const out: NoteRemindLog = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!Array.isArray(value)) continue;
    const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) out[key] = ids;
  }
  return out;
}

/** 只留最近 N 天（含今天），其余日期键丢弃 —— 防止 log 无限增长 */
export function pruneRemindLog(log: NoteRemindLog, today: DateKey): NoteRemindLog {
  const keep = new Set<DateKey>();
  for (let i = 0; i < Math.max(1, NOTE_REMIND_LOG_KEEP_DAYS); i += 1) {
    keep.add(addDays(today, -i));
  }
  const out: NoteRemindLog = {};
  for (const [key, ids] of Object.entries(log)) {
    if (!keep.has(key)) continue;
    if (!Array.isArray(ids) || ids.length === 0) continue;
    out[key] = [...ids];
  }
  return out;
}

/** 记下"这条今天提醒过了"（返回新对象，不改入参） */
export function markReminded(log: NoteRemindLog, today: DateKey, noteId: string): NoteRemindLog {
  const ids = log[today] ?? [];
  if (ids.includes(noteId)) return log;
  return { ...log, [today]: [...ids, noteId] };
}

/**
 * 这条今天是否已经提醒过。
 *
 * - `daily`：**同一天内**最多一次（看 `log[today]`）；
 * - `none`（仅一次）：**log 窗口内**最多一次（任意一天出现过就算"已响过"）。
 *   这就是两档的真实差异 —— 否则「仅一次 / 每天」在行为上完全一样，
 *   用户设了"仅一次"却天天被响，等于没有这个选项。
 *   （log 只留 2 天，所以"仅一次"的实际记忆窗口是 2 天；想天天响请选"每天"。）
 */
export function isRemindedAlready(
  note: Note,
  today: DateKey,
  log: NoteRemindLog,
): boolean {
  const noteId = typeof note?.id === 'string' ? note.id : '';
  if (!noteId) return true;
  const safe: NoteRemindLog = log && typeof log === 'object' ? log : {};
  const todayIds = Array.isArray(safe[today]) ? (safe[today] as string[]) : [];
  if (todayIds.includes(noteId)) return true;
  if (note.remind?.repeat === 'none') {
    return Object.entries(safe).some(([key, ids]) => key !== today && Array.isArray(ids) && ids.includes(noteId));
  }
  return false;
}

/**
 * 本次 tick 该响哪几条（纯函数，便于单测 —— 副作用全在 hook 里）。
 *
 * 触发条件（缺一不可）：
 * 1. `enabled === true`（总开关关掉就一条都不提醒）；
 * 2. `note.remind` 存在且 `at` 合法；
 * 3. `!isNoteDeleted(note)`（软删除的空壳不动）；
 * 4. 当前本地时间 `>= remind.at`（已过点即提醒，见文件头红线 ②）；
 * 5. 今天还没提醒过这条（见 isRemindedAlready）。
 *
 * 入参一律当脏数据看：notes 不是数组 / remind 是坏对象 → 一律跳过，绝不抛。
 */
export function dueNoteReminders(
  notes: Note[],
  nowTime: TimeKey,
  today: DateKey,
  log: NoteRemindLog,
  enabled: boolean,
): Note[] {
  if (!enabled) return [];
  if (!Array.isArray(notes)) return [];
  if (typeof nowTime !== 'string' || !TIME_PATTERN.test(nowTime)) return [];

  const seen = new Set<string>();
  const due: Note[] = [];
  for (const note of notes) {
    if (!note || typeof note !== 'object') continue;
    const remind = note.remind;
    if (!remind || typeof remind !== 'object') continue;
    const at = typeof remind.at === 'string' ? remind.at : '';
    if (!TIME_PATTERN.test(at)) continue;
    if (isNoteDeleted(note)) continue;
    // 已过点（含正好到点）即提醒；字符串比较对零填充的 'HH:mm' 成立
    if (nowTime < at) continue;
    if (isRemindedAlready(note, today, log)) continue;
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    due.push(note);
  }
  return due;
}

/** 读设备本地的已提醒记录；存储不可用 / 脏数据 → 空表（永不抛） */
export function readNoteRemindLog(): NoteRemindLog {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return {};
    const raw = ls.getItem(NOTE_REMIND_LOG_KEY);
    if (!raw) return {};
    return sanitizeLog(JSON.parse(raw) as unknown);
  } catch {
    // JSON 坏了 / 隐私模式下 getItem 抛异常：当成"没提醒过"，最坏是多重响一次
    return {};
  }
}

/** 写设备本地的已提醒记录；失败静默（配额满 / 隐私模式）——绝不因此影响响铃 */
export function writeNoteRemindLog(log: NoteRemindLog): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return;
    ls.setItem(NOTE_REMIND_LOG_KEY, JSON.stringify(log));
  } catch {
    /* 忽略：写不进去最多导致下一轮重复响一次 */
  }
}

/**
 * 笔记闹钟 watcher（App 级，常驻）。
 *
 * `enabled` 复用设置里现有的「到期提醒」总开关（`settings.remindEnabled`），
 * 不新增开关 —— 两个开关管同一件事（要不要打扰我），分开放只会让用户困惑。
 *
 * ⚠️ notes 用 ref 读取，不进 effect 依赖：
 * 用户打一个字 notes 就是新数组，若进依赖，30 秒的定时器会被键盘不断重置
 * （边打字边提醒就永远不响）。ref 里永远是最新一份，效果等价且稳。
 */
export function useNoteReminders(notes: Note[], enabled: boolean): void {
  const toast = useToast();
  const dispatch = useAppDispatch();
  const notesRef = useRef(notes);
  notesRef.current = notes;

  useEffect(() => {
    // 关掉开关 → 不建定时器（停表），一条都不提醒
    if (!enabled) return;

    const tick = (): void => {
      try {
        const nowTime = currentTimeKey();
        const today = currentDateKey();
        const log = pruneRemindLog(readNoteRemindLog(), today);
        const due = dueNoteReminders(notesRef.current, nowTime, today, log, enabled);
        if (due.length === 0) return;

        let next = log;
        for (const note of due) {
          // 先记账再弹：通知构造抛异常也不会让同一轮反复响
          next = markReminded(next, today, note.id);
          const at = note.remind?.at ?? '';
          const title = note.title || TEXT.remindDefaultTitle;
          showNotification(title, `${at} ${TEXT.remindNotificationSuffix}`);
          toast.show(
            `${TEXT.remindAtLabel} ${at} · ${title}`,
            null,
            TOAST_TIMEOUT.info,
            'warn',
          );
          /**
           * 「仅一次」的闹钟响完即失效：删掉 remind 键（解构，不留空对象）。
           *
           * 为什么必须这么做：防重复的 log 只保留 2 天，不删的话第 3 天会再响一次；
           * 而用户选的就是"仅一次"，再响就是 bug。
           * 「每天」绝不写 Note —— 每天响都刷 updatedAt 会让云同步持续 churn。
           */
          if (note.remind?.repeat === 'none') {
            const { remind, ...rest } = note;
            void remind;
            dispatch({ type: 'NOTE_UPSERT', note: rest, now: new Date().toISOString() });
          }
        }
        writeNoteRemindLog(next);
      } catch {
        /* 任何意外都不能让常驻 watcher 崩掉（崩了就不再响铃，且用户看不到报错） */
      }
    };

    tick();
    const timer = setInterval(tick, REMIND_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, toast, dispatch]);
}
