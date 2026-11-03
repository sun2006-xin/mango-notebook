import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { mergeSnapshots } from '../cloudSync';
import type { PersistedPayload, Settings } from '../../types';

/* ============================================================================
   合并时的 settings 语义（v0.12 修正）

   原来 `mergeSnapshots` 的 settings 是**整包取较新一方**，于是一台设备改了
   任何东西，另一台的「主题 / 最后停留页 / 提醒开关」就会被静默替换成对方的。
   v0.11.0 起后台每 60 秒同步一次，这条路径被放大到几乎必然发生
   （体感："我在电脑上用深色，手机改了点东西电脑变浅色"）。

   现在分两类：
   - **设备级**（theme / lastView / remindEnabled）：永远保留本机
   - **账号级**（categories / goals / dayStartHour / defaultView / weekStart）：随云端
   ========================================================================= */

function make(
  savedAt: string,
  patch: Partial<Settings> = {},
  tasks: PersistedPayload['tasks'] = [],
): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks,
    settings: { ...createDefaultSettings('2026-10-28'), ...patch },
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

const ONE_TASK = [
  {
    id: 't1',
    title: '高数',
    note: '',
    date: '2026-10-28',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    parentId: null,
  },
] as unknown as PersistedPayload['tasks'];

describe('设备级设置：云端更新也不抢', () => {
  it('本机深色 + 日记页 + 关提醒，云端是浅色 + 专注页 + 开提醒 → 全保留本机', () => {
    const local = make(
      '2026-10-28T09:00:00.000Z',
      { theme: 'dark', lastView: 'diary', remindEnabled: false },
      ONE_TASK,
    );
    const remote = make(
      '2026-10-28T10:00:00.000Z', // 云端更新
      { theme: 'light', lastView: 'focus', remindEnabled: true },
      ONE_TASK,
    );

    const merged = mergeSnapshots(local, remote);

    expect(merged.settings.theme).toBe('dark');
    expect(merged.settings.lastView).toBe('diary');
    expect(merged.settings.remindEnabled).toBe(false);
  });

  it('本机比较旧时也一样（设备级不按时间戳判胜负）', () => {
    const local = make('2026-10-28T08:00:00.000Z', { theme: 'dark' }, ONE_TASK);
    const remote = make('2026-10-28T12:00:00.000Z', { theme: 'light' }, ONE_TASK);
    expect(mergeSnapshots(local, remote).settings.theme).toBe('dark');
  });
});

describe('账号级设置：仍然随云端', () => {
  it('日界 / 默认视图 / 周起始日取较新一方（云端更新 → 用云端的）', () => {
    const local = make(
      '2026-10-28T09:00:00.000Z',
      { dayStartHour: 0, defaultView: 'today', weekStart: 1 },
      ONE_TASK,
    );
    const remote = make(
      '2026-10-28T10:00:00.000Z',
      { dayStartHour: 4, defaultView: 'week', weekStart: 0 },
      ONE_TASK,
    );

    const merged = mergeSnapshots(local, remote);

    expect(merged.settings.dayStartHour).toBe(4);
    expect(merged.settings.defaultView).toBe('week');
    expect(merged.settings.weekStart).toBe(0);
  });

  it('分类仍取并集（旧行为不能回退）', () => {
    const local = make(
      '2026-10-28T09:00:00.000Z',
      { categories: [{ id: 'c_a', name: 'A' }] },
      ONE_TASK,
    );
    const remote = make(
      '2026-10-28T10:00:00.000Z',
      { categories: [{ id: 'c_b', name: 'B' }] },
      ONE_TASK,
    );

    const ids = mergeSnapshots(local, remote).settings.categories.map((c) => c.id);
    expect(ids).toContain('c_a');
    expect(ids).toContain('c_b');
  });
});
