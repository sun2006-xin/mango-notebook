import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { mergeSnapshots } from '../cloudSync';
import { migrate } from '../storage';
import type { PersistedPayload, Task } from '../../types';

/* ============================================================================
   合并结果与 hydrate 内容必须一致（churn 防线）
   —— 由 QA 对抗探针转化而来的回归：云端 payload 被污染（含空标题任务）时，
      mergeTasks 按 id 保留它，而 hydrate 走的 sanitizeTasks 会丢弃它。
      两者不对称会让 sameTaskSet 永远判不等 → 自动推送反复
      hydrate→保存→推送，churn 不自终止。合并输出过一次 migrate 即消除。
   ========================================================================= */

function task(id: string, title: string): Task {
  return {
    id, title, note: '', date: '2026-10-24', time: null,
    repeat: 'none',
    priority: 'medium', category: '学习', done: false, doneAt: null, parentId: null, estimatedMinutes: 0,
    createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z',
  };
}

function payloadAt(savedAt: string, tasks: Task[]): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks,
    settings: createDefaultSettings('2026-10-24'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

describe('合并结果与 hydrate 内容一致（churn 防线）', () => {
  it('云端含空标题坏任务 → 合并输出即 hydrate 后的内容，一条不多', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [task('g1', '好任务')]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('g1', '好任务'), task('b1', '')]);

    const merged = mergeSnapshots(local, remote);
    const hydrated = migrate(merged);

    expect(hydrated).not.toBeNull();
    // 推上去的（merged）与 hydrate 回本机的（hydrated）逐条一致 —— sameTaskSet 才能判等
    expect(merged.tasks.map((t) => t.id)).toEqual(hydrated ? hydrated.tasks.map((t) => t.id) : []);
    expect(merged.tasks).toHaveLength(1); // 坏任务不进入合并输出
  });

  it('正常数据下合并输出与 hydrate 内容一致', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [task('l1', '本机任务')]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('r1', '云端任务')]);

    const merged = mergeSnapshots(local, remote);
    const hydrated = migrate(merged);

    expect(merged.tasks.map((t) => t.id)).toEqual(hydrated ? hydrated.tasks.map((t) => t.id) : []);
    expect(merged.tasks.map((t) => t.id).sort()).toEqual(['l1', 'r1']);
  });
});
