import { describe, expect, it } from 'vitest';
import { DIARY_MAX, createDefaultSettings } from '../../constants';
import { buildPersistedPayload } from '../../hooks/usePersist';
import { createEmptyState } from '../../store/reducer';
import { parseBackupJson } from '../backup';
import { buildBackupPayload, migrate } from '../storage';
import type { DiaryEntry, PersistedPayload, Settings, Task } from '../../types';
import { backupSource } from './support/backupSource';

/* ============================================================================
   导出备份的往返一致性

   这条链路的意义：用户在一台设备上「导出备份」，换机 / 升级 / 重装后「导入备份」。
   只要往返途中少带一个字段，那部分数据就是**不可逆地没了** —— 没有第二次机会。

   曾经踩过的坑：导出载荷只写了 tasks + settings，漏了 diary。
   表现是「导出再导入，日记全部消失」，而任务还在，所以极难察觉。
   下面第一个用例就是钉这件事的，删掉 diary 字段必须变红。
   ========================================================================= */

function settings(): Settings {
  return {
    // 基底用默认设置：以后新增字段不用再回来补这个字面量
    ...createDefaultSettings('2026-10-24'),
    schemaVersion: 1,
    theme: 'light',
    defaultView: 'today',
    weekStart: 1,
    categories: [{ id: 'c_learn', name: '学习' }],
    lastSelectedDate: '2026-10-24',
    lastView: 'today',
    filterMode: 'all',
    filterCategory: null,
    doneCollapsed: true,
    remindEnabled: false,
    dayStartHour: 0,
    focusMinutes: 25,
    breakMinutes: 5,
    goals: [],
    strictFocus: false,
    dailyNewCardLimit: 20,
    sleepLog: [],
    focusPrunedBefore: null,
    weekPlanTemplate: null,
  };
}

function task(id: string, title: string): Task {
  return {
    id,
    title,
    note: '',
    date: '2026-10-24',
    time: null,
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    repeat: 'none',
    parentId: null,
    estimatedMinutes: 0,
  };
}

function entry(date: string, content: string, updatedAt: string): DiaryEntry {
  return { date, content, createdAt: updatedAt, updatedAt };
}

/**
 * 完整走一遍真实链路：构造载荷 → 序列化成文件 → 读回解析 → 迁移。
 * 导入时的入口正是 migrate()，所以往返终点必须落在这里，不能只测构造。
 */
function roundTrip(tasks: Task[], diary: DiaryEntry[]): PersistedPayload | null {
  const json = JSON.stringify(
    buildBackupPayload(backupSource({ tasks, settings: settings(), diary })),
  );
  return migrate(JSON.parse(json));
}

describe('导出备份 → 导入备份 往返', () => {
  it('日记一篇都不丢', () => {
    const source = [
      entry('2026-10-24', '今天把 I2C 时序调通了', '2026-10-24T10:00:00.000Z'),
      entry('2026-10-23', '高数看到定积分', '2026-10-23T10:00:00.000Z'),
    ];
    const result = roundTrip([task('t1', '复习')], source);
    expect(result).not.toBeNull();
    expect(result?.diary).toHaveLength(2);
    expect(result?.diary.map((d) => d.content)).toEqual([
      '今天把 I2C 时序调通了',
      '高数看到定积分',
    ]);
  });

  it('任务与设置同样不丢', () => {
    const result = roundTrip([task('t1', '别丢了我'), task('t2', '还有我')], []);
    expect(result?.tasks.map((t) => t.title)).toEqual(['别丢了我', '还有我']);
    expect(result?.settings.lastSelectedDate).toBe('2026-10-24');
    expect(result?.settings.categories).toHaveLength(1);
  });

  it('正文被清空的墓碑必须一起走，否则删掉的日记会在别的设备复活', () => {
    const result = roundTrip(
      [task('t1', '复习')],
      [
        entry('2026-10-24', '', '2026-10-24T20:00:00.000Z'),
        entry('2026-10-23', '有内容的', '2026-10-23T10:00:00.000Z'),
      ],
    );
    expect(result?.diary).toHaveLength(2);
    const tombstone = result?.diary.find((d) => d.date === '2026-10-24');
    expect(tombstone?.content).toBe('');
  });

  it('版本号钉死为 1：旧版 APK 只认 v1，写死才能向下兼容', () => {
    expect(buildBackupPayload(backupSource({ settings: settings() })).schemaVersion).toBe(1);
    // 若哪天改成 SCHEMA_VERSION，旧版将无法读取新导出的备份
    expect(buildBackupPayload(backupSource({ settings: settings() })).schemaVersion).not.toBe(2);
  });

  it('超长正文按上限截断后仍可往返，不会整条消失', () => {
    const long = 'x'.repeat(DIARY_MAX + 500);
    const result = roundTrip([task('t1', '复习')], [entry('2026-10-24', long, 't')]);
    expect(result?.diary).toHaveLength(1);
    expect(result?.diary[0].content).toHaveLength(DIARY_MAX);
  });

  it('空数据往返不炸，返回空集合而不是 null', () => {
    const result = roundTrip([], []);
    expect(result).not.toBeNull();
    expect(result?.tasks).toEqual([]);
    expect(result?.diary).toEqual([]);
  });
});

/* ============================================================================
   备份载荷的**字段集**必须与持久化载荷一致
   ----------------------------------------------------------------------------
   为什么单独一条：「新增持久化字段要改四处」的纪律里，
   `buildBackupPayload` 是**最容易漏**的那一处 —— 漏了不报错、不崩，
   只在用户「导出再导入」时安静地把那部分数据抹掉（日记那次就是这样丢的）。

   这里不点名具体字段，而是拿两份载荷的键集直接对撞：
   以后往 `PersistedPayload` 加第 7 个集合，只要忘了往备份里拷，这条必然红。
   比"记得在测试里再加一行"可靠得多。
   ========================================================================= */
describe('备份载荷与持久化载荷：字段集必须一致', () => {
  it('键集完全对得上（不点名，防止加字段时漏改）', () => {
    const persistedKeys = Object.keys(buildPersistedPayload(createEmptyState())).sort();
    const backupKeys = Object.keys(buildBackupPayload(createEmptyState())).sort();
    expect(backupKeys).toEqual(persistedKeys);
  });

  it('版本号可以是 1（向下兼容），但字段一个都不能少', () => {
    const backup = buildBackupPayload(createEmptyState());
    const persisted = buildPersistedPayload(createEmptyState());
    expect(backup.schemaVersion).toBe(1);
    for (const key of Object.keys(persisted)) {
      expect(backup, `备份缺字段 ${key}`).toHaveProperty(key);
    }
  });
});

/* ============================================================================
   导入路径的形状校验（P0 回归）

   曾经设置页的「导入备份」是 `JSON.parse(text)` 后直接 `migrate`：
   `migrate({})` 会补出一份"合法但全空"的载荷，于是**随手选一个 package.json
   就能把任务 / 日记 / 记事 / 专注 / 墓碑全部清空**，而且没有二次确认。

   修法是让导入走 `parseBackupJson`（先过 looksLikePayload 形状校验）。
   下面这些用例钉的是"不像载荷的文件必须被挡在门外" —— 少一道闸就是丢数据。
   ========================================================================= */
describe('导入：不像备份的文件一律挡在门外', () => {
  it('空对象 {} 不是备份（它会被 migrate 补成一份全空载荷）', () => {
    expect(parseBackupJson('{}')).toBeNull();
  });

  it('空数组 [] 不是备份', () => {
    expect(parseBackupJson('[]')).toBeNull();
  });

  it('随手选到的 package.json 不是备份', () => {
    const pkg = JSON.stringify({ name: 'mango', version: '0.11.0', dependencies: {} });
    expect(parseBackupJson(pkg)).toBeNull();
  });

  it('空文件 / 纯文本 / 坏 JSON 都不是备份', () => {
    expect(parseBackupJson('')).toBeNull();
    expect(parseBackupJson('这不是 JSON')).toBeNull();
    expect(parseBackupJson('{')).toBeNull();
  });

  it('真正导出的备份仍然读得回来（挡错方向比漏挡更糟）', () => {
    const json = JSON.stringify(
      buildBackupPayload(
        backupSource({
          tasks: [task('t1', '复习')],
          settings: settings(),
          diary: [entry('2026-10-24', '今天', 't')],
        }),
      ),
    );
    const parsed = parseBackupJson(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.tasks).toHaveLength(1);
    expect(parsed?.tasks[0].title).toBe('复习');
  });
});
