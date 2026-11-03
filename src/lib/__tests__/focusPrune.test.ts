import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { sanitizeSettings } from '../storage';
import { mergeSnapshots } from '../cloudSync';
import { reducer } from '../../store/reducer';
import type { AppState, FocusSession, PersistedPayload } from '../../types';

/* ============================================================================
   2-6 专注记录清理 + 清理水位线

   核心矛盾：专注记录在云同步里是**按 id 取并集**的只增流水。
   光删本地数组，下一次同步会原样并回来 —— 用户会觉得"清理按钮没用"。
   所以清理必须同时推一个水位线（这个日期之前的我都不要了），
   合并时按水位线过滤，并且水位线只增不减。
   ========================================================================= */

function session(id: string, date: string): FocusSession {
  const start = `${date}T06:00:00.000Z`;
  const end = new Date(Date.parse(start) + 25 * 60_000).toISOString();
  return { id, taskId: null, date, startedAt: start, endedAt: end, durationMs: 25 * 60_000 };
}

function state(over: Partial<AppState['settings']> = {}, sessions: FocusSession[] = []): AppState {
  return {
    tasks: [],
    notes: [],
    diary: [],
    tombstones: [],
    focusSessions: sessions,
    settings: { ...createDefaultSettings('2026-10-29'), ...over },
    ui: { hydrating: false } as unknown as AppState['ui'],
  } as AppState;
}

function payload(
  savedAt: string,
  settings: Partial<AppState['settings']>,
  sessions: FocusSession[],
): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks: [{
      id: 't1', title: 'x', note: '', date: '2026-10-29', time: null, repeat: 'none',
      priority: 'medium', category: '学习', done: false, doneAt: null,
      createdAt: savedAt, updatedAt: savedAt, parentId: null,
    }] as unknown as PersistedPayload['tasks'],
    settings: { ...createDefaultSettings('2026-10-29'), ...settings },
    diary: [],
    tombstones: [],
    focusSessions: sessions,
    notes: [],
  };
}

describe('reducer：FOCUS_PRUNE', () => {
  it('删掉早于 before 的记录，并把水位线推过去', () => {
    const s0 = state({}, [session('old', '2025-01-01'), session('new', '2026-10-01')]);
    const s1 = reducer(s0, { type: 'FOCUS_PRUNE', before: '2026-01-01' });
    expect(s1.focusSessions.map((x) => x.id)).toEqual(['new']);
    expect(s1.settings.focusPrunedBefore).toBe('2026-01-01');
  });

  it('水位线只增不减（更早的 before 直接忽略）', () => {
    const s0 = state({ focusPrunedBefore: '2026-06-01' }, [session('a', '2026-05-01')]);
    expect(reducer(s0, { type: 'FOCUS_PRUNE', before: '2025-01-01' })).toBe(s0);
  });

  it('没有可删记录时也推进水位线（否则云端会把它并回来）', () => {
    const s0 = state({}, [session('keep', '2026-10-01')]);
    const s1 = reducer(s0, { type: 'FOCUS_PRUNE', before: '2026-01-01' });
    expect(s1).not.toBe(s0);
    expect(s1.settings.focusPrunedBefore).toBe('2026-01-01');
  });

  it('非法日期不动 state', () => {
    const s0 = state({}, [session('a', '2026-10-01')]);
    expect(reducer(s0, { type: 'FOCUS_PRUNE', before: '不是日期' })).toBe(s0);
  });
});

describe('mergeSnapshots：清理过的记录不会被云端并回来', () => {
  it('本机清理后，云端那份旧记录在合并结果里消失', () => {
    // 本机：只剩 10 月的记录，水位线 2026-01-01
    const local = payload('2026-10-29T10:00:00.000Z', { focusPrunedBefore: '2026-01-01' }, [
      session('new', '2026-10-01'),
    ]);
    // 云端：还有一条 2025 年的（清理前推上去的）
    const remote = payload('2026-10-29T09:00:00.000Z', {}, [
      session('new', '2026-10-01'),
      session('old', '2025-06-01'),
    ]);

    const merged = mergeSnapshots(local, remote);

    expect(merged.focusSessions.map((x) => x.id)).toEqual(['new']);
    expect(merged.settings.focusPrunedBefore).toBe('2026-01-01');
  });

  it('水位线取两台设备里较晚的那个（不能被旧设备改回去）', () => {
    const local = payload('2026-10-29T10:00:00.000Z', { focusPrunedBefore: '2026-01-01' }, []);
    const remote = payload('2026-10-29T09:00:00.000Z', { focusPrunedBefore: '2026-06-01' }, []);

    const merged = mergeSnapshots(local, remote);

    expect(merged.settings.focusPrunedBefore).toBe('2026-06-01');
  });
});

describe('sanitizeSettings：水位线能活过冷启动', () => {
  it('合法日期保留', () => {
    expect(sanitizeSettings({ focusPrunedBefore: '2026-01-01' }).focusPrunedBefore).toBe('2026-01-01');
  });

  it('非法/缺失 → null（不阻挡历史记录）', () => {
    expect(sanitizeSettings({}).focusPrunedBefore).toBeNull();
    expect(sanitizeSettings({ focusPrunedBefore: 'x' }).focusPrunedBefore).toBeNull();
  });
});
