import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { SCHEMA_VERSION, VIEW_ORDER } from '../../constants';
import { persistDeps } from '../../hooks/usePersist';
import { buildBackupPayload, migrate, sanitizeSettings } from '../storage';
import { createEmptyState } from '../../store/reducer';
import type { Note, PersistedPayload } from '../../types';
import { backupSource } from './support/backupSource';

/* ============================================================================
   v0.9 硬约束守卫（review-p2 / note-remind 两轮都必须守住的底线）

   本轮给 Note 加了 `remind`、给 NoteSr 加了 `last` —— 两个都是**挂在已有
   集合里的可选字段**，不是新的顶层集合。这条边界一旦被后人不小心越过
   （比如"闹钟记录也存进 payload 吧"），代价是：
   - 三端 SCHEMA 版本链要再加一步，旧端一律判成 future-version 拒绝同步；
   - 云同步 churn（响一次铃写一次盘）；
   - 备份文件的形状跟着变，老端的导入直接失败。

   所以这里把"不能变的东西"逐条钉成测试，改动它们必须先让这一组变红。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

/**
 * 把整个 `store/` 目录的源码拼起来（剥注释）。
 *
 * 为什么需要：reducer 已经按域拆成多个文件，"有哪些 action""某个域有没有
 * 偷偷加一条"这类契约必须扫全目录。只读单个文件的话，新增的 action 会漏检 ——
 * 守卫看着还在，实际已经失效。
 */
function readStoreDir(): string {
  const parts: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir));
        continue;
      }
      if (entry.name.endsWith('.ts')) {
        parts.push(stripComments(readFileSync(new URL(entry.name, dir), 'utf8')));
      }
    }
  };
  walk(new URL('../../store/', import.meta.url));
  return parts.join('\n');
}

/** 载荷的键集（顺序无关，用来断言"没有新增顶层字段"） */
function payloadKeys(payload: PersistedPayload): string[] {
  return Object.keys(payload).sort();
}

const EXPECTED_PAYLOAD_KEYS = [
  'diary',
  'focusSessions',
  'notes',
  'savedAt',
  'schemaVersion',
  'settings',
  'tasks',
  'tombstones',
];

describe('持久化形状不变', () => {
  it('SCHEMA_VERSION 仍是 5（加字段不加版本）', () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  it('PersistedPayload 仍只有 6 个集合 + schemaVersion/savedAt（无新增顶层字段）', () => {
    const state = createEmptyState();
    const payload = buildBackupPayload(state);
    expect(payloadKeys(payload)).toEqual(EXPECTED_PAYLOAD_KEYS);
    expect(Object.keys(payload)).toHaveLength(8);
  });

  it('persistDeps 仍是 6 元组（顺序与 buildPayload 逐一对应）', () => {
    const state = createEmptyState();
    const deps = persistDeps(state);
    expect(deps).toHaveLength(6);
    expect(deps[0]).toBe(state.tasks);
    expect(deps[1]).toBe(state.settings);
    expect(deps[2]).toBe(state.diary);
    expect(deps[3]).toBe(state.tombstones);
    expect(deps[4]).toBe(state.focusSessions);
    expect(deps[5]).toBe(state.notes);
  });

  it('设备本地的"已提醒记录"绝不进 payload', () => {
    const src = read('../storage.ts');
    expect(src).not.toContain('remind-log');
    expect(src).not.toContain('NOTE_REMIND_LOG_KEY');
    // storage 里没有"闹钟记录"这类字段被写进 PersistedPayload
    const state = createEmptyState();
    const payload = buildBackupPayload(state);
    expect(payloadKeys(payload)).not.toContain('remindLog');
  });

  it('migrate 链没有新增步骤（仍是 0→1 … 4→5 五个迁移函数）', () => {
    const src = read('../storage.ts');
    const steps = src.split(/^\s{2}\d: \(raw\)/gm).length - 1;
    expect(steps).toBe(5);
    // 从最老的 v1 载荷一路迁到当前版本，结果不会 null
    const migrated = migrate({ schemaVersion: 1, savedAt: '2026-10-24T00:00:00.000Z', tasks: [], settings: null });
    expect(migrated?.schemaVersion).toBe(5);
  });
});

describe('新字段经同步 / 备份 / 迁移保真', () => {
  const richNote: Note = {
    id: 'n1',
    title: '记得刷牙',
    content: '牙刷 + 牙线',
    category: '',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-24T09:00:00.000Z',
    remind: { at: '07:30', repeat: 'daily' },
  };
  const cardNote: Note = {
    id: 'n2',
    title: 'I2C 时序',
    content: '起始条件 = SCL 高时 SDA 下降',
    category: '',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    sr: { due: '2026-10-27', ivl: 3, reps: 1, last: '2026-10-24T10:00:00.000Z' },
  };

  it('remind 与 last 经过「备份 → 导入（migrate）」都原样存活', () => {
    const payload = buildBackupPayload(
      backupSource({ settings: createEmptyState().settings, notes: [richNote, cardNote] }),
    );
    const roundTrip = migrate(JSON.parse(JSON.stringify(payload)));
    const byId = new Map((roundTrip?.notes ?? []).map((note) => [note.id, note]));
    expect(byId.get('n1')?.remind).toEqual({ at: '07:30', repeat: 'daily' });
    expect(byId.get('n2')?.sr).toEqual({
      due: '2026-10-27',
      ivl: 3,
      reps: 1,
      last: '2026-10-24T10:00:00.000Z',
    });
  });

  it('闹钟与复习可以同时挂在一条记事上（互不干扰）', () => {
    const both: Note = {
      ...richNote,
      id: 'n3',
      sr: { due: '2026-10-27', ivl: 3, reps: 1, last: '2026-10-24T10:00:00.000Z' },
    };
    const json = JSON.stringify(
      buildBackupPayload(backupSource({ settings: createEmptyState().settings, notes: [both] })),
    );
    const roundTrip = migrate(JSON.parse(json));
    const note = roundTrip?.notes.find((item) => item.id === 'n3');
    expect(note?.remind).toEqual({ at: '07:30', repeat: 'daily' });
    expect(note?.sr?.ivl).toBe(3);
  });

  it('老载荷（v5 但没有 remind / last）迁移后不会凭空造字段', () => {
    const oldNote = { id: 'old', title: '旧记事', content: '正文', category: '', pinned: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
    const migrated = migrate({
      schemaVersion: 5,
      savedAt: '2026-10-01T00:00:00.000Z',
      tasks: [],
      settings: null,
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [oldNote],
    });
    const note = migrated?.notes[0];
    expect(note?.content).toBe('正文');
    expect(note && 'remind' in note).toBe(false);
    expect(note && 'sr' in note).toBe(false);
  });
});

describe('路由与装载入口不变', () => {
  it('VIEW_ORDER 仍不含 review（复习是临时会话，不可被记住）', () => {
    expect(VIEW_ORDER).toContain('notes');
    expect(VIEW_ORDER).not.toContain('review');
  });

  it('即使载荷里写着 lastView: review，也会回落默认视图（白名单兜底）', () => {
    const settings = sanitizeSettings({ lastView: 'review', defaultView: 'review' });
    expect(settings.lastView).not.toBe('review');
    expect(settings.defaultView).not.toBe('review');
  });

  it('hydrateFromPayload 仍是唯一装载入口（App 的云合并走它，没有手写 HYDRATE 字面量）', () => {
    const appSrc = read('../../App.tsx');
    /**
     * 不锁死某一行的写法（后台合并要保留本机视图，参数里多了一层 spread），
     * 锁死的是"装载这件事只发生一次、且只走 hydrateFromPayload"。
     */
    expect(appSrc.match(/hydrateFromPayload\(/g) ?? []).toHaveLength(1);
    // 用正则而不是整段字符串：行尾可能是 CRLF，写死 \n 会在 Windows 上假红
    expect(appSrc).toMatch(/dispatch\(\s*hydrateFromPayload\(/);
    expect(appSrc).not.toContain("type: 'HYDRATE'");
  });

  it('storage.ts 仍不 dispatch、不碰 React（装载/保存只做数据）', () => {
    const src = read('../storage.ts');
    expect(src).not.toContain('dispatch');
    expect(src).not.toContain('useEffect');
    expect(src).not.toContain("from 'react'");
  });
});

describe('没有新增 reducer action（两轮功能都复用既有 action）', () => {
  /**
   * reducer 自 v0.20 起按域拆成 `store/domains/*`，action 联合在 `store/actions.ts`。
   * 契约要扫**整个 store 目录**：只盯 reducer.ts 的话，域文件里新增一个 action
   * 这条测试照样绿 —— 那就等于把守卫自己拆掉了。
   */
  const reducerSrc = readStoreDir();

  /**
   * 全部 action 名字的**冻结清单**（从 reducer 的 type 字面量里扫出来）。
   *
   * v0.9 的两个功能（周报三档 + 笔记闹钟）都必须复用既有 action：
   * 周报写入 → DIARY_UPSERT；闹钟设置 → NOTE_UPSERT。
   *
   * v1.0 的唯一变化：新增了 `SET_GOALS`（目标倒计时）。
   * 它是**settings 里一个字段的更新**，与 SET_WEEK_START / SET_FOCUS_MINUTES /
   * SET_BREAK_MINUTES 完全同类 —— 不是新的业务实体、不新增持久化顶层字段、
   * 不动 PersistedPayload（goals 住在 settings 内部）。
   * 之所以单独开一个 action 而不是塞进通用 patch：
   * 这个项目的 settings 更新一律是"一字段一 action"，照现有风格做，
   * 并且 reducer 里要过 sanitizeGoals 兜底（增/删/改共用同一条路径）。
   * 除它之外清单必须原样不变 —— 再多一条就说明有人越过了那条边界。
   */
  const FROZEN_ACTIONS = [
    'ARCHIVE_DONE', 'CATEGORY_ADD', 'CATEGORY_REMOVE', 'CATEGORY_RENAME', 'CLOSE_DRAWER',
    'DATA_CLEAR_ALL', 'DATA_IMPORT_DEMO', 'DIARY_DELETE', 'DIARY_UPSERT', 'FOCUS_DELETE',
    'FOCUS_LOG', 'FOCUS_PRUNE', 'HYDRATE', 'NOTE_DELETE', 'NOTE_UPSERT', 'OPEN_DRAWER', 'SET_BREAK_MINUTES',
    'SET_DAILY_FOCUS_GOAL',
    'SET_DAILY_NEW_CARD_LIMIT', 'SET_DAY_START', 'SET_DEFAULT_VIEW', 'SET_FILTER', 'SET_FOCUS_MINUTES', 'SET_GOALS',
    'SET_MONTH', 'SET_REMIND_ENABLED', 'SET_SELECTED_DATE', 'SET_STRICT_FOCUS', 'SET_THEME', 'SET_VIEW',
    'SLEEP_LOG_SET',
    'SET_WEEK_START', 'SHIFT_DATE', 'SHIFT_WEEK', 'TASK_ADD', 'TASK_DELETE',
    'TASK_MOVE', 'TASK_MOVE_TO_TODAY', 'TASK_PATCH', 'TASK_RESTORE', 'TASK_TOGGLE', 'TASK_UNDO_MOVE',
    'WEEK_PLAN_ADD', 'WEEK_PLAN_APPLY', 'WEEK_PLAN_REMOVE', 'TOAST_DISMISS', 'TOAST_SHOW', 'TOGGLE_DONE_COLLAPSED', 'TOMBSTONE_CLEAR',
    'TOMBSTONE_RESTORE', 'UI_SAVE_STATE',
    'SET_HABITS', 'HABIT_TOGGLE_CHECK', 'SET_RECAP_SEEN', 'SET_AUTO_CONTINUE',
    'HABIT_TASK_GENERATE', 'SET_WEEKLY_AUTO_REPORT', 'WEEKLY_REPORT_LOG_ADD',
  ].sort();

  it('action 清单与冻结清单完全一致（没多也没少）', () => {
    // 只认 `type: 'XXX'` 的**声明**形态；`case 'XXX'` 是消费形态，不算新 action
    const found = [
      ...new Set((reducerSrc.match(/type: '([A-Z_]+)'/g) ?? []).map((hit) => hit.slice(7, -1))),
    ].sort();
    expect(found).toEqual(FROZEN_ACTIONS);
  });

  /**
   * 拆域之后最容易出的错：**某条 action 在两个域里都写了 case**（谁先谁赢，
   * 后者永远收不到）或者**谁都没写**（静默 no-op，点了没反应且不报错）。
   *
   * 这两条都不是类型错误，TS 抓不到；只有真的去数一遍才能发现。
   */
  it('每条 action **恰好**被一个域接住（没漏写、没重复认领）', () => {
    const cases = [...reducerSrc.matchAll(/case '([A-Z_]+)'/g)].map((hit) => hit[1]);
    const counts = new Map<string, number>();
    for (const name of cases) counts.set(name, (counts.get(name) ?? 0) + 1);

    const missing = FROZEN_ACTIONS.filter((name) => !counts.has(name));
    const duplicated = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name);

    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it('闹钟没有专属 action（走 NOTE_UPSERT）', () => {
    expect(reducerSrc).not.toContain('NOTE_REMIND');
    expect(reducerSrc).not.toContain('NOTE_ALARM');
    expect(reducerSrc).not.toContain('remindLog');
  });

  /**
   * v0.28.0 修订：原来这条断言是 `not.toContain('WEEKLY')`，语义是
   * "周报是纯派生的，没有任何专属 action"。长期迭代给自动周报加了
   * `WEEKLY_REPORT_LOG_ADD`，但它**只记日期**（防重复生成），
   * 正文仍然走 `DIARY_UPSERT`、统计仍然每次现算。
   * 所以这里改守真正重要的那件事：**没有任何字段把统计结果存下来**。
   * 存下来就会出现"上周的数字和现在我们算的对不上"，而那种不一致没法解释。
   */
  it('周报统计仍然是纯派生（只有"处理过哪些周"的日期流水，不存统计结果）', () => {
    expect(reducerSrc).not.toMatch(/weeklyStats|weekStats|stats:\s*WeeklyStats/i);
    expect(reducerSrc).not.toContain('REVIEWED');
    // 这条流水里只准出现日期，不准夹带正文
    expect(reducerSrc).not.toMatch(/weeklyReportLog:\s*\[\s*\{/);
  });

  it('三个计时 hook 的内部实现未被本轮触碰', () => {
    for (const file of ['useFocusTimer.ts', 'useStopwatch.ts', 'useReminder.ts']) {
      const src = read(`../../hooks/${file}`);
      expect(src).not.toContain('NoteRemind');
      expect(src).not.toContain('useNoteReminders');
      expect(src).not.toContain('weekOffset');
    }
  });
});
