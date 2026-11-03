import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import {
  decideSyncAction,
  formatSyncTime,
  maskPhone,
  mergeSnapshots,
  mergeTasks,
  syncErrorMessage,
  type CloudSnapshotMeta,
} from '../cloudSync';
import type { PersistedPayload, Task } from '../../types';

/* ============================================================================
   decideSyncAction：纯函数，只比较两边 savedAt，不碰网络与存储
   ========================================================================= */

const LOCAL_TASK: Task = {
  id: 't1', title: '本地任务', note: '', date: '2026-10-24', time: '09:00',
  repeat: 'none',
  priority: 'high', category: '学习', done: false, doneAt: null, parentId: null, estimatedMinutes: 0,
  createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z',
};

function payloadAt(savedAt: string, tasks: Task[] = []): PersistedPayload {
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

function remoteAt(savedAt: string, tasks?: Task[]): CloudSnapshotMeta {
  const payload = payloadAt(savedAt, tasks);
  return { payload, savedAt, taskCount: payload.tasks.length };
}

describe('decideSyncAction', () => {
  it('云端无数据 → push-local（首次把本机数据放上去）', () => {
    expect(decideSyncAction(payloadAt('2026-10-24T10:00:00.000Z'), null)).toBe('push-local');
  });

  it('本地无数据 → pull-cloud（空机恢复）', () => {
    expect(decideSyncAction(null, remoteAt('2026-10-24T10:00:00.000Z'))).toBe('pull-cloud');
  });

  it('云端更晚 → merge（两边都有数据且内容有差异：任务级合并，不整包互盖）', () => {
    expect(
      decideSyncAction(
        payloadAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]),
        remoteAt('2026-10-24T11:00:00.000Z', [{ ...LOCAL_TASK, id: 'r1' }]),
      ),
    ).toBe('merge');
  });

  it('本地更晚 → merge（同上：方向不再由时间整包互盖决定）', () => {
    expect(
      decideSyncAction(
        payloadAt('2026-10-24T12:00:00.000Z', [LOCAL_TASK]),
        remoteAt('2026-10-24T11:00:00.000Z', [{ ...LOCAL_TASK, id: 'r1' }]),
      ),
    ).toBe('merge');
  });

  it('两边时间相同 → none（省掉无谓的一次写）', () => {
    const same = '2026-10-24T10:30:00.000Z';
    expect(decideSyncAction(payloadAt(same), remoteAt(same))).toBe('none');
  });

  it('两边都没有数据 → push-local（云端空优先）', () => {
    expect(decideSyncAction(null, null)).toBe('push-local');
  });

  it('时间字符串非法时退化为 0 比较，相同即 none', () => {
    expect(decideSyncAction(payloadAt(''), remoteAt('not-a-date'))).toBe('none');
  });
});

describe('syncErrorMessage', () => {
  it('42501（RLS 拒绝）→ 无权操作此数据', () => {
    expect(syncErrorMessage({ code: '42501', message: 'new row violates row-level security' })).toBe(
      '无权操作此数据',
    );
  });

  it('其它错误 → 同步失败，数据仍在本机', () => {
    expect(syncErrorMessage({ code: null, message: 'network error' })).toBe('同步失败，数据仍在本机');
  });
});

describe('maskPhone', () => {
  it('11 位号码中间四位打星号', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
  });

  it('带区号的号码同样只保留后 11 位', () => {
    expect(maskPhone('+86 13812345678')).toBe('138****5678');
  });

  it('空值 / 异常值不会泄漏', () => {
    expect(maskPhone(null)).toBe('***');
    expect(maskPhone('')).toBe('***');
  });
});

describe('formatSyncTime', () => {
  it('输出 HH:MM', () => {
    const iso = new Date(2026, 9, 24, 9, 5, 0, 0).toISOString();
    expect(formatSyncTime(iso)).toBe('09:05');
  });

  it('null 与非法值返回 null', () => {
    expect(formatSyncTime(null)).toBeNull();
    expect(formatSyncTime('not-a-date')).toBeNull();
  });
});

/* ============================================================================
   内容优先于时间：空数据绝不能因为"时间戳更新"盖掉有数据的一方
   —— 真实事故：手机存了 1 条并同步上云，电脑是空的且刚保存过，
      旧规则只比时间 → 电脑的空白把云端那条覆盖成了空。
   ========================================================================= */
describe('decideSyncAction：空数据不得覆盖有数据的一方', () => {
  it('本机为空 + 云端有数据 → pull-cloud（哪怕本机时间更新）', () => {
    const local = payloadAt('2026-10-24T23:00:00.000Z'); // 本机更晚，但是空的
    const remote = remoteAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]);
    expect(decideSyncAction(local, remote)).toBe('pull-cloud');
  });

  it('本机有数据 + 云端为空 → push-local（哪怕云端时间更新）', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]);
    const remote = remoteAt('2026-10-24T23:00:00.000Z'); // 云端更晚，但是空的
    expect(decideSyncAction(local, remote)).toBe('push-local');
  });

  it('两边都是空的 → none（不做无意义的写）', () => {
    expect(decideSyncAction(payloadAt('2026-10-24T10:00:00.000Z'), remoteAt('2026-10-24T11:00:00.000Z'))).toBe('none');
  });

  it('两边都有数据且内容有差异 → merge（按 id 合并，绝不整包互盖）', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]);
    const remote = remoteAt('2026-10-24T11:00:00.000Z', [{ ...LOCAL_TASK, id: 'r1', title: '云端任务' }]);
    expect(decideSyncAction(local, remote)).toBe('merge');
  });

  it('同 id 但 updatedAt 不同（一边编辑过）→ merge', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [
      { ...LOCAL_TASK, updatedAt: '2026-10-24T02:00:00.000Z' },
    ]);
    expect(decideSyncAction(local, remoteAt('2026-10-24T11:00:00.000Z', [LOCAL_TASK]))).toBe('merge');
  });

  it('两边内容一致但 savedAt 不同（本机刚保存过的稳态）→ none，不白写', () => {
    // 真实流程里本机每次保存都刷新 savedAt，与云端永不相等 —— 稳态只能按内容判
    expect(
      decideSyncAction(
        payloadAt('2026-10-24T12:00:00.000Z', [LOCAL_TASK]),
        remoteAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]),
      ),
    ).toBe('none');
  });

  it('任务一致但设置不同 → merge（设置的差异也要同步下去）', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]);
    local.settings = { ...local.settings, theme: 'dark' };
    expect(decideSyncAction(local, remoteAt('2026-10-24T11:00:00.000Z', [LOCAL_TASK]))).toBe('merge');
  });
});

/* ============================================================================
   任务级合并：按 id 取并集，updatedAt 新者胜
   —— 整包互盖是"一台设备新增的任务被另一台无声吞掉"的根源，合并才谁都不丢。
   ========================================================================= */

function task(id: string, updatedAt: string, title = id): Task {
  return {
    id, title, note: '', date: '2026-10-24', time: '09:00',
    repeat: 'none',
    priority: 'high', category: '学习', done: false, doneAt: null, parentId: null, estimatedMinutes: 0,
    createdAt: '2026-10-24T01:00:00.000Z', updatedAt,
  };
}

describe('mergeTasks：按 id 取并集，updatedAt 新者胜', () => {
  it('同 id：本地更新时间更晚 → 取本地版本', () => {
    const merged = mergeTasks(
      [task('t1', '2026-10-24T10:00:00.000Z', '本地版')],
      [task('t1', '2026-10-24T09:00:00.000Z', '云端版')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('本地版');
  });

  it('同 id：云端更新时间更晚 → 取云端版本', () => {
    const merged = mergeTasks(
      [task('t1', '2026-10-24T09:00:00.000Z', '本地版')],
      [task('t1', '2026-10-24T10:00:00.000Z', '云端版')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('云端版');
  });

  it('同 id 且 updatedAt 相等 → 取本机（保证确定性，两台设备收敛到同一份）', () => {
    const same = '2026-10-24T10:00:00.000Z';
    const merged = mergeTasks([task('t1', same, '本地版')], [task('t1', same, '云端版')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('本地版');
  });

  it('两边各有独有任务 → 并集一条不丢，云端在前、本机追加在后', () => {
    const merged = mergeTasks(
      [task('l1', '2026-10-24T10:00:00.000Z'), task('l2', '2026-10-24T10:00:00.000Z')],
      [task('r1', '2026-10-24T10:00:00.000Z')],
    );
    expect(merged.map((t) => t.id)).toEqual(['r1', 'l1', 'l2']);
  });

  it('updatedAt 非法 / 缺失退化为 0，不抛异常也不丢任务', () => {
    const merged = mergeTasks(
      [{ ...task('l1', '2026-10-24T10:00:00.000Z'), updatedAt: 'not-a-date' }],
      [{ ...task('r1', '2026-10-24T10:00:00.000Z'), updatedAt: '' }],
    );
    expect(merged.map((t) => t.id)).toEqual(['r1', 'l1']);
  });

  it('脏数据（null / 空 id）被跳过，不污染并集', () => {
    const merged = mergeTasks(
      [task('l1', '2026-10-24T10:00:00.000Z')],
      [null as unknown as Task, { ...task('', '2026-10-24T10:00:00.000Z') }],
    );
    expect(merged.map((t) => t.id)).toEqual(['l1']);
  });
});

/* ============================================================================
   整包合并：任务并集 + savedAt 取新侧 + 分类并集
   —— 分类必须按 id 取并集，否则合并进来的任务会引用悬空分类。
   ========================================================================= */

describe('mergeSnapshots：任务并集 + savedAt 取新侧 + 分类并集', () => {
  it('任务按 id 取并集，savedAt 取较新的一侧', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('l1', '2026-10-24T10:00:00.000Z')]);
    const remote = payloadAt('2026-10-24T11:00:00.000Z', [task('r1', '2026-10-24T10:00:00.000Z')]);

    const merged = mergeSnapshots(local, remote);

    expect(merged.tasks.map((t) => t.id)).toEqual(['r1', 'l1']);
    expect(merged.savedAt).toBe('2026-10-24T12:00:00.000Z');
    expect(merged.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('categories 按 id 取并集（两边新增的都保留、同 id 不重复），其余设置取较新侧', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('l1', '2026-10-24T10:00:00.000Z')]);
    local.settings = {
      ...local.settings,
      theme: 'dark',
      categories: [...createDefaultSettings('2026-10-24').categories, { id: 'c_local', name: '本机新增' }],
    };
    const remote = payloadAt('2026-10-24T11:00:00.000Z', [task('r1', '2026-10-24T10:00:00.000Z')]);
    remote.settings = {
      ...remote.settings,
      theme: 'light',
      categories: [...createDefaultSettings('2026-10-24').categories, { id: 'c_remote', name: '云端新增' }],
    };

    const merged = mergeSnapshots(local, remote);

    const ids = merged.settings.categories.map((c) => c.id);
    expect(ids).toContain('c_local');
    expect(ids).toContain('c_remote');
    expect(new Set(ids).size).toBe(ids.length); // 同 id 不重复
    // 其余设置整体取 savedAt 较新的一侧（本机 12:00 更新 → theme 跟随本机）
    expect(merged.settings.theme).toBe('dark');
  });
});

/* ============================================================================
   脏数据兜底：云端那一行的 payload 可能损坏（tasks / settings / categories
   缺失或类型不对）。合并绝不抛异常 —— 抛了自动推送会变成未处理的
   Promise rejection，同步静默停摆。
   ========================================================================= */

describe('mergeTasks / mergeSnapshots：脏数据不抛异常', () => {
  it('mergeTasks 容忍非数组入参', () => {
    expect(mergeTasks([LOCAL_TASK], null as unknown as Task[])).toHaveLength(1);
    expect(mergeTasks(null as unknown as Task[], [LOCAL_TASK])).toHaveLength(1);
    expect(mergeTasks(undefined as unknown as Task[], undefined as unknown as Task[])).toHaveLength(0);
  });

  it('mergeSnapshots 容忍云端 tasks / settings 缺失', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]);
    const corrupt = {
      schemaVersion: 1,
      savedAt: '',
      tasks: null,
      settings: null,
    } as unknown as PersistedPayload;

    const merged = mergeSnapshots(local, corrupt);

    expect(merged.tasks).toHaveLength(1); // 本机任务不丢
    expect(merged.savedAt).toBe('2026-10-24T10:00:00.000Z'); // 时间取本机
    expect(Array.isArray(merged.settings.categories)).toBe(true);
  });

  it('mergeSnapshots 容忍云端 categories 不是数组', () => {
    const local = payloadAt('2026-10-24T10:00:00.000Z', [LOCAL_TASK]);
    const remote = payloadAt('2026-10-24T11:00:00.000Z', [LOCAL_TASK]);
    (remote.settings as { categories: unknown }).categories = 'oops';

    const merged = mergeSnapshots(local, remote);

    expect(merged.tasks).toHaveLength(1);
    expect(Array.isArray(merged.settings.categories)).toBe(true);
    expect(merged.settings.categories.length).toBeGreaterThan(0); // 回落本机分类
  });
});
