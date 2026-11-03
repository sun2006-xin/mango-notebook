import { habitStreak } from './habits';
import { taskLastDate, taskSpanDays } from './task';
import { isNoteDeleted } from './note';
import type {
  DateKey,
  DiaryEntry,
  FocusSession,
  Habit,
  HabitCheck,
  Note,
  SleepEntry,
  Task,
} from '../types';

/* ============================================================================
   全量导出为 Markdown
   ----------------------------------------------------------------------------
   与「导出备份（JSON）」的分工：
   - JSON 备份是**给机器读的**：导入回来必须一字不差，所以它连墓碑、schema 一起带；
   - Markdown 导出是**给人读的**：打印出来复习、粘进 Notion / 发给别人、
     或者单纯留一份能看懂的存档。它不需要能被导回，也不需要带墓碑。

   所以这里刻意不复用 buildBackupPayload —— 两者的读者不同，格式就该不同。
   ========================================================================= */

export interface ExportSource {
  tasks: Task[];
  diary: DiaryEntry[];
  notes: Note[];
  focusSessions: FocusSession[];
  /**
   * 习惯打卡（F12）。
   *
   * 可选：`ExportSource` 是外部契约，早先的调用点只传四样东西。
   * 但导出**必须**带上它 —— 连续打卡天数是攒出来的，
   * Markdown 是"万一哪天不用这个应用了，还能带走的那份"，
   * 少了它就等于告诉用户"你的习惯记录带不走"。
   */
  habits?: Habit[];
  habitChecks?: HabitCheck[];
  /** 作息打卡（F5）：同上，属于用户产生的记录 */
  sleepLog?: SleepEntry[];
  /** 导出当天的日期键，用于文件名的日期戳 */
  today: DateKey;
}

function listOf<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** ISO → 'HH:MM'；解析不出来返回空串（绝不把 Invalid Date 写进导出文件） */
function clockOf(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || !iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 毫秒 → 分钟（四舍五入，至少 0） */
function minutesOf(ms: number | null | undefined): number {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  return Math.max(0, Math.round(value / 60_000));
}

/** 正文缩进成引用块/代码块之外的普通缩进文本：空行不缩进，避免产生多余空行 */
function indentLines(text: string, prefix: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${prefix}${line}`));
}

function taskLine(task: Task, indent: string): string[] {
  const box = task.done ? '[x]' : '[ ]';
  const meta: string[] = [];
  /**
   * 多天任务把区间写进括号：`（10-30 → 11-05 · 学习）`。
   * 只写开始日的话，导出文件里"这件事持续了几天"这条信息就永久丢了 ——
   * 而 Markdown 导出的定位正是"哪天不用这个应用了还能看懂的那份"。
   */
  const spanDays = taskSpanDays(task);
  if (spanDays > 1) meta.push(`${task.date} → ${taskLastDate(task)}（${spanDays} 天）`);
  if (task.time) meta.push(task.time);
  if (task.category) meta.push(task.category);
  if (task.priority === 'high') meta.push('高优先级');
  if (typeof task.estimatedMinutes === 'number' && task.estimatedMinutes > 0) {
    meta.push(`预计 ${task.estimatedMinutes} 分钟`);
  }
  const suffix = meta.length > 0 ? `（${meta.join(' · ')}）` : '';
  const lines = [`${indent}- ${box} ${task.title}${suffix}`];
  if (task.note && task.note.trim()) lines.push(...indentLines(task.note, `${indent}  `));
  return lines;
}

/**
 * 任务按日期分组（日期倒序），子任务缩进挂在父任务下面。
 * 子任务只取一层（数据模型就只支持一层），父任务已完成的也照实导出。
 */
function renderTasks(tasks: Task[]): string[] {
  const list = listOf(tasks);
  if (list.length === 0) return ['_（没有任务）_', ''];

  const byDate = new Map<string, Task[]>();
  for (const task of list) {
    if (!task || typeof task.date !== 'string') continue;
    const bucket = byDate.get(task.date);
    if (bucket) bucket.push(task);
    else byDate.set(task.date, [task]);
  }

  const out: string[] = [];
  const dates = [...byDate.keys()].sort().reverse();
  for (const date of dates) {
    const dayTasks = byDate.get(date) ?? [];
    const top = dayTasks
      .filter((task) => !task.parentId)
      .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
    /** 子任务挂到父任务下面，父任务不在同一天（理论上不会）时按顶层处理 */
    const childrenOf = new Map<string, Task[]>();
    for (const task of dayTasks) {
      if (!task.parentId) continue;
      const bucket = childrenOf.get(task.parentId);
      if (bucket) bucket.push(task);
      else childrenOf.set(task.parentId, [task]);
    }
    out.push(`### ${date}`, '');
    for (const task of top) {
      out.push(...taskLine(task, ''));
      for (const child of childrenOf.get(task.id) ?? []) out.push(...taskLine(child, '  '));
    }
    out.push('');
  }
  return out;
}

function renderDiary(diary: DiaryEntry[]): string[] {
  const list = listOf(diary)
    .filter((entry) => entry && typeof entry.date === 'string' && entry.content.trim())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (list.length === 0) return ['_（还没有日记）_', ''];

  const out: string[] = [];
  for (const entry of list) {
    out.push(`### ${entry.date}`, '', entry.content.trim(), '');
  }
  return out;
}

/**
 * 给人看的记事：回收站里的软删除空壳不算。
 *
 * 抽成函数是因为**列表渲染与头部计数都要用同一份判据** ——
 * 各写一遍过滤器的话，改了一处就会"计数说 8 篇、正文印出 9 篇"。
 */
function visibleNotes(notes: Note[]): Note[] {
  return listOf(notes).filter((note) => note && !isNoteDeleted(note));
}

function renderNotes(notes: Note[]): string[] {
  const list = visibleNotes(notes)
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  if (list.length === 0) return ['_（还没有记事）_', ''];

  const out: string[] = [];
  for (const note of list) {
    const title = note.title.trim() || '（无标题）';
    const meta = note.pinned ? '📌 ' : '';
    out.push(`### ${meta}${title}`, '');
    const body = note.content.trim();
    out.push(body || '_（空白）_', '');
  }
  return out;
}

function renderFocus(sessions: FocusSession[], tasks: Task[]): string[] {
  const list = listOf(sessions).filter((s) => s && typeof s.date === 'string');
  if (list.length === 0) return ['_（还没有专注记录）_', ''];

  const titleOf = new Map<string, string>();
  for (const task of listOf(tasks)) titleOf.set(task.id, task.title);

  const byDate = new Map<string, FocusSession[]>();
  for (const session of list) {
    const bucket = byDate.get(session.date);
    if (bucket) bucket.push(session);
    else byDate.set(session.date, [session]);
  }

  const out: string[] = [];
  const dates = [...byDate.keys()].sort().reverse();
  for (const date of dates) {
    const day = (byDate.get(date) ?? []).slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const total = day.reduce((sum, s) => sum + minutesOf(s.durationMs), 0);
    out.push(`### ${date} · 共 ${total} 分钟`, '');
    for (const session of day) {
      const start = clockOf(session.startedAt);
      const end = clockOf(session.endedAt);
      const span = start && end ? `${start}–${end} · ` : start ? `${start} · ` : '';
      const task = session.taskId ? titleOf.get(session.taskId) : undefined;
      const target = task ? ` · ${task}` : '';
      out.push(`- ${span}${minutesOf(session.durationMs)} 分钟${target}`);
    }
    out.push('');
  }
  return out;
}

/**
 * 习惯打卡（F12）。
 *
 * 一个习惯一行小结 + 一行日期流水。日期写**完整**的 `YYYY-MM-DD` 而不是 `MM-DD`：
 * 这份文件是长期存档，跨年后 `10-01` 到底是哪一年就说不清了，
 * 而"能带走且看得懂"正是它存在的理由。
 */
function renderHabits(habits: Habit[], checks: HabitCheck[], today: DateKey): string[] {
  const list = listOf(habits).filter((habit) => habit && habit.id && habit.name);
  if (list.length === 0) return ['_（还没有习惯）_', ''];

  const datesOf = new Map<string, string[]>();
  for (const check of listOf(checks)) {
    if (!check || typeof check.habitId !== 'string' || typeof check.date !== 'string') continue;
    const bucket = datesOf.get(check.habitId);
    if (bucket) bucket.push(check.date);
    else datesOf.set(check.habitId, [check.date]);
  }

  const out: string[] = [];
  for (const habit of list) {
    const dates = (datesOf.get(habit.id) ?? []).slice().sort();
    const archived = habit.archivedAt ? '（已归档）' : '';
    const streak = habitStreak(listOf(checks), habit.id, today);
    out.push(`### ${habit.name}${archived}`, '');
    if (dates.length === 0) {
      out.push('_（还没打过卡）_', '');
      continue;
    }
    out.push(`- 共 ${dates.length} 次 · 当前连续 ${streak} 天`);
    out.push(`- ${dates.join(', ')}`, '');
  }
  return out;
}

/** 作息打卡（F5）：一天一行，最近的在前面 */
function renderSleep(sleepLog: SleepEntry[]): string[] {
  const list = listOf(sleepLog).filter((entry) => entry && typeof entry.date === 'string');
  if (list.length === 0) return ['_（还没有作息记录）_', ''];

  const out: string[] = [];
  for (const entry of list.slice().sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const wake = entry.wakeAt ?? '—';
    const bed = entry.sleepAt ?? '—';
    out.push(`- ${entry.date}：起 ${wake} · 睡 ${bed}`);
  }
  out.push('');
  return out;
}

/** 生成整份 Markdown；纯函数，不碰 DOM、不读时钟以外的环境（时钟由 today 传入） */
export function buildExportMarkdown(source: ExportSource): string {
  const tasks = listOf(source.tasks);
  const diary = listOf(source.diary).filter((entry) => entry && entry.content.trim());
  const notes = visibleNotes(source.notes);
  const focus = listOf(source.focusSessions).filter((s) => s && typeof s.date === 'string');
  const totalMinutes = focus.reduce((sum, s) => sum + minutesOf(s.durationMs), 0);

  const head = [
    '# 芒果本本 · 全量导出',
    '',
    `> 导出日期：${source.today}`,
    `> 任务 ${tasks.length} 条 · 日记 ${diary.length} 篇 · 记事 ${notes.length} 篇 · 专注 ${focus.length} 段（共 ${totalMinutes} 分钟）`,
    '',
  ];

  return [
    ...head,
    '## 任务',
    '',
    ...renderTasks(tasks),
    '## 日记',
    '',
    ...renderDiary(diary),
    '## 记事',
    '',
    ...renderNotes(notes),
    '## 专注记录',
    '',
    ...renderFocus(focus, tasks),
    /**
     * 两个新章节**追加在最后**，不动上面四个的顺序 ——
     * 已经按顺序解析这份文件的人（脚本、模板）不会被打断。
     */
    '## 习惯',
    '',
    ...renderHabits(listOf(source.habits), listOf(source.habitChecks), source.today),
    '## 作息',
    '',
    ...renderSleep(listOf(source.sleepLog)),
  ].join('\n');
}

/** 导出文件名：`芒果本本-导出-20261028.md`（日期戳用紧凑格式，Windows 文件名不喜欢冒号） */
export function exportFileName(today: DateKey): string {
  return `芒果本本-导出-${String(today).replace(/-/g, '')}.md`;
}
