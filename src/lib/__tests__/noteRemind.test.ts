import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  currentDateKey,
  currentTimeKey,
  dueNoteReminders,
  isRemindedAlready,
  markReminded,
  pruneRemindLog,
  readNoteRemindLog,
  writeNoteRemindLog,
  type NoteRemindLog,
} from '../../hooks/useNoteReminders';
import { sanitizeNotes, sanitizeRemind } from '../storage';
import { createEmptyState, reducer } from '../../store/reducer';
import { NOTE_REMIND_LOG_KEY, STORAGE_KEY, TEXT } from '../../constants';
import type { Note, NoteRemind } from '../../types';

/* ============================================================================
   笔记闹钟（v0.9 议题 1 的补充需求）

   用户原话：「他可能就是个提醒要刷牙的小事，不是知识点不需要复习，
   不过可以加个闹钟提醒类似事情」。
   所以这条能力与复习（SRS）是**两条独立的路**：闹钟到点响，但永不进复习队列。

   这里钉住四类行为：
   1. 字段兜底：非法 remind **只丢 remind**（不丢 note、不丢 sr）；
   2. 到点判定：已过点即提醒（30 秒轮询不会漏）、未到点不响、同一天不重复；
   3. 「仅一次 / 每天」的真实差异；
   4. 铁律：响铃只写**设备本地** log，一个字节都不碰主 payload。
   ========================================================================= */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  // 只桩浏览器全局：hook 的纯函数与被测的 log 读写都走它
  (globalThis as unknown as { localStorage: Storage }).localStorage = store;
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

const TODAY = '2026-10-24';
const YESTERDAY = '2026-10-23';

function plain(id: string, remind?: NoteRemind): Note {
  return {
    id,
    title: `${id} 标题`,
    content: `${id} 正文`,
    category: '',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(remind ? { remind } : {}),
  };
}

describe('sanitizeRemind：合法 / 非法', () => {
  it('合法的保留（缺 repeat 回落 none）', () => {
    expect(sanitizeRemind({ at: '07:30', repeat: 'daily' })).toEqual({ at: '07:30', repeat: 'daily' });
    expect(sanitizeRemind({ at: '00:00', repeat: 'none' })).toEqual({ at: '00:00', repeat: 'none' });
    expect(sanitizeRemind({ at: '23:59' })).toEqual({ at: '23:59', repeat: 'none' });
  });

  it('repeat 非法值回落 none（不整条丢弃：保守档比"闹钟消失"友好）', () => {
    expect(sanitizeRemind({ at: '07:30', repeat: 'weekly' })).toEqual({ at: '07:30', repeat: 'none' });
    expect(sanitizeRemind({ at: '07:30', repeat: 'DAILY' })).toEqual({ at: '07:30', repeat: 'none' });
    expect(sanitizeRemind({ at: '07:30', repeat: 123 })).toEqual({ at: '07:30', repeat: 'none' });
  });

  it('at 非法 → 整条 remind 丢弃（返回 null）', () => {
    expect(sanitizeRemind({ at: '7:30' })).toBeNull(); // 缺前导零
    expect(sanitizeRemind({ at: '24:00' })).toBeNull(); // 小时越界
    expect(sanitizeRemind({ at: '23:60' })).toBeNull(); // 分钟越界
    expect(sanitizeRemind({ at: '' })).toBeNull();
    expect(sanitizeRemind({ at: 730 })).toBeNull();
    expect(sanitizeRemind({})).toBeNull();
  });

  it('非对象 / null 一律 null（不抛）', () => {
    for (const raw of [null, undefined, 123, '07:30', [], true]) {
      expect(sanitizeRemind(raw)).toBeNull();
    }
  });
});

describe('sanitizeNotes：remind 只影响自己那一个字段', () => {
  it('合法 remind 原样保留', () => {
    const [note] = sanitizeNotes([plain('n1', { at: '07:30', repeat: 'daily' })]);
    expect(note?.remind).toEqual({ at: '07:30', repeat: 'daily' });
    expect(note?.content).toBe('n1 正文');
  });

  it('非法 remind → 只丢 remind：note 与 sr 都还在', () => {
    const dirty = {
      ...plain('n1', { at: '25:00', repeat: 'daily' } as NoteRemind),
      sr: { due: '2026-10-30', ivl: 3, reps: 1 },
    };
    const [note] = sanitizeNotes([dirty]);
    expect(note?.id).toBe('n1');
    expect(note?.content).toBe('n1 正文');
    expect(note?.sr).toEqual({ due: '2026-10-30', ivl: 3, reps: 1 });
    expect(note && 'remind' in note).toBe(false);
  });

  it('没有闹钟的记事不会凭空多出 remind 键（关闹钟=删键的前提）', () => {
    const [note] = sanitizeNotes([plain('n1')]);
    expect(note && 'remind' in note).toBe(false);
  });

  it('闹钟是脏值（数字 / 字符串）同样只丢闹钟', () => {
    for (const bad of [123, 'daily', [], null]) {
      const raw = { ...plain('n1'), remind: bad };
      const [note] = sanitizeNotes([raw]);
      expect(note?.id).toBe('n1');
      expect(note && 'remind' in note).toBe(false);
    }
  });

  it('加闹钟不会把记事变成复习卡（判据仍然是"有没有 sr 键"）', () => {
    const [note] = sanitizeNotes([plain('n1', { at: '07:30', repeat: 'daily' })]);
    expect(note && 'sr' in note).toBe(false);
  });
});

describe('NOTE_UPSERT 承载闹钟（存 / 删，不新增 action）', () => {
  it('能存：remind 落进 state，updatedAt 刷新', () => {
    const note = plain('n1', { at: '07:30', repeat: 'daily' });
    const state = reducer(createEmptyState(), {
      type: 'NOTE_UPSERT',
      note,
      now: '2026-10-24T09:00:00.000Z',
    });
    expect(state.notes[0]?.remind).toEqual({ at: '07:30', repeat: 'daily' });
    expect(state.notes[0]?.updatedAt).toBe('2026-10-24T09:00:00.000Z');
  });

  it('能删：解构掉 remind 再 upsert，note 上不再有 remind 键', () => {
    let state = reducer(createEmptyState(), {
      type: 'NOTE_UPSERT',
      note: plain('n1', { at: '07:30', repeat: 'daily' }),
      now: '2026-10-24T09:00:00.000Z',
    });
    const { remind, ...rest } = state.notes[0] as Note;
    void remind;
    state = reducer(state, { type: 'NOTE_UPSERT', note: rest, now: '2026-10-24T10:00:00.000Z' });
    expect(state.notes[0] && 'remind' in (state.notes[0] as Note)).toBe(false);
    expect(state.notes[0]?.content).toBe('n1 正文');
    expect(state.notes[0]?.updatedAt).toBe('2026-10-24T10:00:00.000Z');
  });

  it('删闹钟不影响同一篇的复习进度', () => {
    const withSr = { ...plain('n1', { at: '07:30', repeat: 'none' }), sr: { due: '2026-10-30', ivl: 3, reps: 1 } };
    let state = reducer(createEmptyState(), { type: 'NOTE_UPSERT', note: withSr, now: '2026-10-24T09:00:00.000Z' });
    const { remind, ...rest } = state.notes[0] as Note;
    void remind;
    state = reducer(state, { type: 'NOTE_UPSERT', note: rest, now: '2026-10-24T10:00:00.000Z' });
    expect(state.notes[0]?.sr).toEqual({ due: '2026-10-30', ivl: 3, reps: 1 });
  });
});

describe('到点判定（dueNoteReminders）', () => {
  const emptyLog: NoteRemindLog = {};

  it('已过点即提醒（30 秒轮询不会漏）', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'daily' })];
    expect(dueNoteReminders(notes, '07:31', TODAY, emptyLog, true).map((n) => n.id)).toEqual(['n1']);
    expect(dueNoteReminders(notes, '23:59', TODAY, emptyLog, true).map((n) => n.id)).toEqual(['n1']);
  });

  it('正好到点也提醒（>= 而不是 >）', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'daily' })];
    expect(dueNoteReminders(notes, '07:30', TODAY, emptyLog, true)).toHaveLength(1);
  });

  it('未到点不提醒', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'daily' })];
    expect(dueNoteReminders(notes, '07:29', TODAY, emptyLog, true)).toEqual([]);
    expect(dueNoteReminders(notes, '06:00', TODAY, emptyLog, true)).toEqual([]);
  });

  it('同一天不重复提醒（今天已记过就不再响）', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'daily' })];
    const log: NoteRemindLog = { [TODAY]: ['n1'] };
    expect(dueNoteReminders(notes, '07:31', TODAY, log, true)).toEqual([]);
    expect(dueNoteReminders(notes, '22:00', TODAY, log, true)).toEqual([]);
  });

  it('「仅一次」：窗口内响过一次就不再响（昨天响过 → 今天不响）', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'none' })];
    const log: NoteRemindLog = { [YESTERDAY]: ['n1'] };
    expect(isRemindedAlready(notes[0] as Note, TODAY, log)).toBe(true);
    expect(dueNoteReminders(notes, '09:00', TODAY, log, true)).toEqual([]);
  });

  it('「每天」：昨天响过，今天照样响（这就是两档的真实差异）', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'daily' })];
    const log: NoteRemindLog = { [YESTERDAY]: ['n1'] };
    expect(isRemindedAlready(notes[0] as Note, TODAY, log)).toBe(false);
    expect(dueNoteReminders(notes, '09:00', TODAY, log, true).map((n) => n.id)).toEqual(['n1']);
  });

  it('总开关关掉 → 一条都不提醒', () => {
    const notes = [plain('n1', { at: '00:01', repeat: 'daily' })];
    expect(dueNoteReminders(notes, '23:00', TODAY, emptyLog, false)).toEqual([]);
  });

  it('软删除的空壳不提醒（用户已经把它删了）', () => {
    const deleted = { ...plain('n1', { at: '07:30', repeat: 'daily' }), content: '' };
    expect(dueNoteReminders([deleted], '09:00', TODAY, emptyLog, true)).toEqual([]);
  });

  it('没有闹钟 / 闹钟是坏数据 → 跳过，不影响别的条目', () => {
    const notes = [
      plain('no-remind'),
      { ...plain('bad'), remind: { at: '早上七点', repeat: 'daily' } as NoteRemind },
      plain('good', { at: '07:30', repeat: 'daily' }),
    ];
    expect(dueNoteReminders(notes, '09:00', TODAY, emptyLog, true).map((n) => n.id)).toEqual(['good']);
  });

  it('脏入参不抛（notes 不是数组 / nowTime 非法 / 条目不是对象）', () => {
    const notes = [plain('n1', { at: '07:30', repeat: 'daily' })];
    expect(() => dueNoteReminders(null as unknown as Note[], '09:00', TODAY, emptyLog, true)).not.toThrow();
    expect(dueNoteReminders(null as unknown as Note[], '09:00', TODAY, emptyLog, true)).toEqual([]);
    expect(dueNoteReminders(notes, '9:0', TODAY, emptyLog, true)).toEqual([]);
    expect(dueNoteReminders([null as unknown as Note], '09:00', TODAY, emptyLog, true)).toEqual([]);
    expect(() =>
      dueNoteReminders(notes, '09:00', TODAY, null as unknown as NoteRemindLog, true),
    ).not.toThrow();
  });

  it('同一 tick 里同一条不会重复出现（notes 里意外重复也安全）', () => {
    const one = plain('n1', { at: '07:30', repeat: 'daily' });
    expect(dueNoteReminders([one, one], '09:00', TODAY, emptyLog, true)).toHaveLength(1);
  });
});

describe('设备本地 log：只留 2 天、脏数据不抛', () => {
  it('pruneRemindLog 只保留今天 + 昨天', () => {
    const log: NoteRemindLog = {
      '2026-10-24': ['a'],
      '2026-10-23': ['b'],
      '2026-10-22': ['c'],
      '2026-10-01': ['d'],
    };
    const pruned = pruneRemindLog(log, TODAY);
    expect(Object.keys(pruned).sort()).toEqual(['2026-10-23', '2026-10-24']);
    expect(pruned[TODAY]).toEqual(['a']);
    expect(pruned[YESTERDAY]).toEqual(['b']);
  });

  it('markReminded 幂等（同一天同一条只记一次），且不改入参', () => {
    const log: NoteRemindLog = {};
    const once = markReminded(log, TODAY, 'n1');
    const twice = markReminded(once, TODAY, 'n1');
    expect(once[TODAY]).toEqual(['n1']);
    expect(twice[TODAY]).toEqual(['n1']);
    expect(log).toEqual({}); // 入参没被改
  });

  it('读写往返（同一个 key）', () => {
    const log = markReminded({}, TODAY, 'n1');
    writeNoteRemindLog(log);
    expect(readNoteRemindLog()).toEqual(log);
    expect(store.getItem(NOTE_REMIND_LOG_KEY)).not.toBeNull();
  });

  it('脏 JSON / 非对象 / 坏的值一律回落空表，不抛', () => {
    store.setItem(NOTE_REMIND_LOG_KEY, '{ 不是 JSON');
    expect(readNoteRemindLog()).toEqual({});
    store.setItem(NOTE_REMIND_LOG_KEY, '"字符串"');
    expect(readNoteRemindLog()).toEqual({});
    store.setItem(NOTE_REMIND_LOG_KEY, JSON.stringify({ 坏键: ['n1'], [TODAY]: 'n1' }));
    expect(readNoteRemindLog()).toEqual({});
    store.setItem(NOTE_REMIND_LOG_KEY, JSON.stringify({ [TODAY]: ['n1', 123, null] }));
    expect(readNoteRemindLog()).toEqual({ [TODAY]: ['n1'] });
  });

  it('**铁律**：响铃只写设备本地 key，主 payload 一个字节都不动', () => {
    const log = markReminded({}, TODAY, 'n1');
    writeNoteRemindLog(log);
    // 主存储 key 完全没被创建 —— 写 Note 会刷 updatedAt，那是业务数据变更
    expect(store.getItem(STORAGE_KEY)).toBeNull();
    expect(store.getItem(NOTE_REMIND_LOG_KEY)).not.toBeNull();
  });

  it('存储不可用时不抛（隐私模式）', () => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    expect(() => writeNoteRemindLog({})).not.toThrow();
    expect(readNoteRemindLog()).toEqual({});
  });
});

describe('时间工具', () => {
  it('currentTimeKey 补零成 HH:mm', () => {
    expect(currentTimeKey(new Date(2026, 9, 24, 7, 5))).toBe('07:05');
    expect(currentTimeKey(new Date(2026, 9, 24, 23, 59))).toBe('23:59');
    expect(currentTimeKey(new Date(2026, 9, 24, 0, 0))).toBe('00:00');
  });

  it('currentDateKey 用本地自然日（不套日界，闹钟是墙上的钟）', () => {
    expect(currentDateKey(new Date(2026, 9, 24, 1, 30))).toBe('2026-10-24');
  });
});

/* ============================================================================
   源码契约：常驻 watcher 的几条硬约束
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

describe('useNoteReminders 的源码契约', () => {
  const hookSrc = read('../../hooks/useNoteReminders.ts');
  const appSrc = read('../../App.tsx');
  const notesViewSrc = read('../../views/NotesView.tsx');

  it('30 秒轮询 + effect cleanup 清定时器', () => {
    expect(hookSrc).toContain('const REMIND_POLL_MS = 30_000;');
    expect(hookSrc).toContain('setInterval(tick, REMIND_POLL_MS)');
    expect(hookSrc).toContain('return () => clearInterval(timer);');
  });

  it('开关关掉就不建定时器（不提醒）', () => {
    const guard = hookSrc.indexOf('if (!enabled) return;');
    const interval = hookSrc.indexOf('setInterval(tick, REMIND_POLL_MS)');
    expect(guard).toBeGreaterThan(-1);
    expect(interval).toBeGreaterThan(guard);
  });

  it('**铁律**：提醒只写设备本地 log；唯一写 Note 的是「仅一次」响完自我失效', () => {
    expect(hookSrc).toContain('writeNoteRemindLog(next)');
    // dispatch 全文恰好 1 次（只有「仅一次」那条路要写 Note）
    const dispatchCount = (hookSrc.match(/dispatch\(\{/g) ?? []).length;
    expect(dispatchCount).toBe(1);
    // 且必须落在 repeat === 'none' 的条件块之后（「每天」绝不写 Note）
    const noneGuard = hookSrc.indexOf("note.remind?.repeat === 'none'");
    const dispatchAt = hookSrc.indexOf('dispatch({');
    expect(noneGuard).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(noneGuard);
    expect(hookSrc).toContain('NOTE_UPSERT');
    // 写 Note 必须解构删键（不能留空对象，也不能伤 sr）
    expect(hookSrc).toContain('const { remind, ...rest } = note;');
  });

  it('提醒动作 = 系统通知 + Toast', () => {
    expect(hookSrc).toContain('showNotification(title,');
    expect(hookSrc).toContain('TEXT.remindNotificationSuffix');
    expect(hookSrc).toContain('toast.show(');
    expect(hookSrc).toContain('TEXT.remindDefaultTitle');
  });

  it('先记账再弹通知（通知抛异常也不会同轮反复响）', () => {
    const mark = hookSrc.indexOf('next = markReminded(next, today, note.id);');
    const notify = hookSrc.indexOf('showNotification(title,');
    expect(mark).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(mark);
  });

  it('App 挂载：复用 settings.remindEnabled 这一个总开关', () => {
    expect(appSrc).toContain('useNoteReminders(state.notes, settings.remindEnabled)');
    // 不新增开关（settings 里只有 remindEnabled 一处提醒开关）
    expect(appSrc).not.toContain('noteRemindEnabled');
  });

  it('NotesView：开关 + 时间 + 每天/仅一次，且改动都走 NOTE_UPSERT', () => {
    expect(notesViewSrc).toContain('data-testid="note-remind-toggle"');
    expect(notesViewSrc).toContain('data-testid="note-remind-at"');
    expect(notesViewSrc).toContain("type=\"time\"");
    expect(notesViewSrc).toContain('TEXT.remindOnce');
    expect(notesViewSrc).toContain('TEXT.remindDaily');
    // 三个 handler 都通过 saveDraft（→ NOTE_UPSERT）落库，不新增 action
    expect(notesViewSrc).toContain('const onToggleRemind = useCallback(');
    expect(notesViewSrc).toContain('saveDraft({ ...draft, remind: { at: DEFAULT_NOTE_REMIND_TIME, repeat: \'none\' } });');
    expect(notesViewSrc).toContain('onChange={onRemindRepeat}');
    expect(notesViewSrc).not.toContain('NOTE_REMIND_SET');
  });

  it('关掉闹钟 = 删键（不是置 null），否则会留下一个空闹钟', () => {
    expect(notesViewSrc).toContain('const { remind, ...rest } = draft;');
    expect(notesViewSrc).not.toContain('remind: null');
    expect(notesViewSrc).not.toContain('remind: undefined');
  });

  it('列表项显示小闹钟标记 + 时间', () => {
    expect(notesViewSrc).toContain('data-testid={`note-remind-badge-${note.id}`}');
    expect(notesViewSrc).toContain('note.remind.at');
    expect(notesViewSrc).toContain('name="bell"');
  });

  it('到点文案格式与需求一致（`07:30 的提醒`）', () => {
    expect(`${'07:30'} ${TEXT.remindNotificationSuffix}`).toBe('07:30 的提醒');
    expect(TEXT.remindDefaultTitle).toBe('笔记提醒');
  });
});
