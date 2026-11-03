import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { mergeSnapshots, mergeTasks, applyTombstones } from '../merge';
import { sanitizeTasks } from '../sanitize';
import { migrate } from '../storage';
import type { PersistedPayload, Task } from '../../types';

/* ============================================================================
   字段级 LWW（云同步 ⑥）
   ----------------------------------------------------------------------------
   要守住的那件事：两台设备**同时改同一条任务的不同字段**，两边的改动都要活下来。
   在此之前是"整条任务 updatedAt 新者胜"，只有一个赢家，另一方的改动无声消失。

   这批用例逐条对应真实场景（电脑改标题 / 手机改备注 / 一边勾完成一边改分类），
   并且特意覆盖三条容易踩空的边界：
   ① 老数据（没有 fieldAt）必须退回整条 LWW —— 不能"猜"对端改了什么；
   ② `doneAt` 必须跟 `done` 同源，不能拼出"已完成但没有完成时间"；
   ③ 合并要**可交换、幂等**：两台设备各自算一遍必须收敛到同一份，
      否则自动同步会永远 churn（推上去再拉下来又变成另一份）。
   ========================================================================= */

const EARLY = '2026-10-24T09:00:00.000Z';
const LATE = '2026-10-24T11:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: '2026-10-24',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    parentId: null,
    estimatedMinutes: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: EARLY,
    ...overrides,
  };
}

function payload(tasks: Task[], savedAt = EARLY): PersistedPayload {
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

describe('mergeTasks · 字段级：两台设备改不同字段，两边都保留', () => {
  it('电脑改标题（晚）+ 手机改备注（早）→ 标题取电脑、备注取手机', () => {
    const phone = task({ note: '错题第 3 题', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const laptop = task({ title: '数学真题（二刷）', updatedAt: LATE, fieldAt: { title: LATE } });

    const [merged] = mergeTasks([phone], [laptop]);
    expect(merged.title).toBe('数学真题（二刷）');
    expect(merged.note).toBe('错题第 3 题');
    // 结果不能比任一侧旧 —— 墓碑复活判定任务.updatedAt > deletedAt 依赖这一点
    expect(merged.updatedAt).toBe(LATE);
  });

  it('交换入参得到同样的内容（合并可交换，否则两端永远收敛不了）', () => {
    const a = task({ note: '手机写的备注', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const b = task({ title: '电脑改的标题', updatedAt: LATE, fieldAt: { title: LATE } });

    const [ab] = mergeTasks([a], [b]);
    const [ba] = mergeTasks([b], [a]);
    expect(ab.title).toBe(ba.title);
    expect(ab.note).toBe(ba.note);
    expect(ab.updatedAt).toBe(ba.updatedAt);
  });

  it('合并是幂等的：再合一遍同一侧不改变结果（自动同步不能 churn）', () => {
    const a = task({ note: '备注', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const b = task({ title: '标题', updatedAt: LATE, fieldAt: { title: LATE } });
    const [once] = mergeTasks([a], [b]);
    const [twice] = mergeTasks([once], [b]);
    const [thrice] = mergeTasks([once], [a]);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });

  it('一边勾完成（晚）+ 一边改分类（早）→ 完成态取晚、doneAt 同源、分类取早', () => {
    const phone = task({ category: '工作', updatedAt: EARLY, fieldAt: { category: EARLY } });
    const laptop = task({
      done: true,
      doneAt: LATE,
      updatedAt: LATE,
      fieldAt: { done: LATE },
    });

    const [merged] = mergeTasks([phone], [laptop]);
    expect(merged.done).toBe(true);
    expect(merged.doneAt).toBe(LATE);
    expect(merged.category).toBe('工作');
  });

  it('一边取消完成 → doneAt 必须一起清空（不能留"未完成却有完成时间"）', () => {
    const done = task({ done: true, doneAt: EARLY, updatedAt: EARLY, fieldAt: { done: EARLY } });
    const undone = task({ done: false, doneAt: null, updatedAt: LATE, fieldAt: { done: LATE } });

    const [merged] = mergeTasks([done], [undone]);
    expect(merged.done).toBe(false);
    expect(merged.doneAt).toBeNull();
  });

  it('拖拽换日期（晚）+ 改标题（早）→ 日期取晚、标题取早', () => {
    const titled = task({ title: '改过的标题', updatedAt: EARLY, fieldAt: { title: EARLY } });
    const moved = task({
      date: '2026-10-26',
      order: 3,
      updatedAt: LATE,
      fieldAt: { date: LATE, order: LATE },
    });

    const [merged] = mergeTasks([titled], [moved]);
    expect(merged.title).toBe('改过的标题');
    expect(merged.date).toBe('2026-10-26');
    expect(merged.order).toBe(3);
  });

  it('createdAt 取更早的那个（与入参顺序无关）', () => {
    const a = task({ createdAt: '2026-09-01T00:00:00.000Z', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const b = task({ createdAt: '2026-10-20T00:00:00.000Z', updatedAt: LATE, fieldAt: { title: LATE } });
    const [ab] = mergeTasks([a], [b]);
    const [ba] = mergeTasks([b], [a]);
    expect(ab.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(ba.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('合并结果的时钟表覆盖清单里的每个字段（下一轮才能继续按字段比）', () => {
    const a = task({ note: '备注', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const b = task({ title: '标题', updatedAt: LATE, fieldAt: { title: LATE } });
    const [merged] = mergeTasks([a], [b]);
    expect(merged.fieldAt?.title).toBe(LATE);
    expect(merged.fieldAt?.note).toBe(EARLY);
    // 两侧都没单独改过的字段 → 时钟是 createdAt（"至少从建任务起没动过"）
    expect(merged.fieldAt?.priority).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('mergeTasks · 一侧有 fieldAt 但没这项记录', () => {
  it('没记录的字段按 createdAt 算（不能按 updatedAt 算，否则会偷走对端的改动）', () => {
    // 手机 09:00 改了备注；电脑 11:00 改了标题 —— 电脑**没动过备注**
    const phone = task({ note: '错题第 3 题', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const laptop = task({ title: '二刷', updatedAt: LATE, fieldAt: { title: LATE } });
    const [merged] = mergeTasks([phone], [laptop]);
    expect(merged.note).toBe('错题第 3 题');
  });
});

describe('mergeTasks · 老数据回落（没有 fieldAt）', () => {
  it('两侧都没有时钟 → 退回整条 LWW：晚的整条胜', () => {
    const early = task({ title: '旧标题', note: '旧备注' });
    const late = task({ title: '新标题', updatedAt: LATE });
    const [merged] = mergeTasks([early], [late]);
    expect(merged.title).toBe('新标题');
    // 老口径就是整条覆盖，备注跟着晚的那条走（哪怕看起来像"丢改动"）
    expect(merged.note).toBe('');
  });

  it('只有一侧有时钟 → 同样退回整条 LWW，并给胜者补齐时钟（自愈）', () => {
    const legacy = task({ title: '老端改的标题', updatedAt: LATE });
    const modern = task({ note: '新端改的备注', updatedAt: EARLY, fieldAt: { note: EARLY } });

    const [merged] = mergeTasks([modern], [legacy]);
    expect(merged.title).toBe('老端改的标题');
    expect(merged.fieldAt).toBeDefined();
    expect(merged.fieldAt?.title).toBe(LATE);
  });

  it('补齐后的时钟让后续合并变成"按字段"而不是每次整条重来（不 churn）', () => {
    const legacy = task({ updatedAt: LATE });
    const modern = task({ note: '新端改的备注', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const [first] = mergeTasks([modern], [legacy]);
    // 第一次整条 LWW：晚的那条（legacy）赢，并被补齐时钟 —— 这是**有损**的，
    // 但只在"对端还没升级"时发生一次，之后两端都有时钟
    expect(first.fieldAt).toBeDefined();
    // 再合一遍不能再变（否则自动同步会永远推→拉→推）
    const [again] = mergeTasks([first], [legacy]);
    expect(again).toEqual(first);
    // 之后任何一侧的**新改动**都按字段正常参与合并
    const edited = task({
      ...first,
      title: '之后改的标题',
      updatedAt: '2026-10-24T12:00:00.000Z',
      fieldAt: { ...first.fieldAt, title: '2026-10-24T12:00:00.000Z' },
    });
    const [next] = mergeTasks([first], [edited]);
    expect(next.title).toBe('之后改的标题');
  });
});

describe('mergeSnapshots · 字段级结果要能穿过 sanitize / migrate 活下来', () => {
  it('合并后的 fieldAt 不被 sanitizeTasks 丢掉（逐字段重建的经典陷阱）', () => {
    const phone = task({ note: '错题第 3 题', updatedAt: EARLY, fieldAt: { note: EARLY } });
    const laptop = task({ title: '二刷', updatedAt: LATE, fieldAt: { title: LATE } });

    const merged = mergeSnapshots(payload([phone], EARLY), payload([laptop], LATE));
    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0].fieldAt?.note).toBe(EARLY);
    expect(merged.tasks[0].fieldAt?.title).toBe(LATE);
    expect(merged.tasks[0].note).toBe('错题第 3 题');
    expect(merged.tasks[0].title).toBe('二刷');
  });

  it('往返 migrate（冷启动 / 云同步装载）之后字段级信息仍在', () => {
    const merged = mergeSnapshots(
      payload([task({ note: '手机备注', updatedAt: EARLY, fieldAt: { note: EARLY } })], EARLY),
      payload([task({ title: '电脑标题', updatedAt: LATE, fieldAt: { title: LATE } })], LATE),
    );
    const reloaded = migrate(JSON.parse(JSON.stringify(merged)));
    expect(reloaded?.tasks[0].fieldAt?.note).toBe(EARLY);
    expect(reloaded?.tasks[0].fieldAt?.title).toBe(LATE);
  });

  it('sanitizeTasks 丢弃清单外的时钟键（云端可能带脏数据）', () => {
    const [clean] = sanitizeTasks([
      task({ fieldAt: { title: LATE, doneAt: LATE } as unknown as Task['fieldAt'] }),
    ]);
    expect(clean.fieldAt).toEqual({ title: LATE });
  });
});

describe('字段级合并与墓碑的配合', () => {
  it('合并结果保留较晚的 updatedAt → 删除后又被编辑过仍然复活', () => {
    const deletedAt = '2026-10-24T10:00:00.000Z';
    const revived = mergeTasks(
      [task({ note: '手机上救回来的备注', updatedAt: EARLY, fieldAt: { note: EARLY } })],
      [task({ updatedAt: LATE, fieldAt: { title: LATE } })],
    );
    const alive = applyTombstones(revived, [{ id: 't1', deletedAt, title: '数学真题', date: '2026-10-24', index: 0 }]);
    expect(alive).toHaveLength(1);
    expect(alive[0].note).toBe('手机上救回来的备注');
  });

  it('两侧都早于删除时间 → 仍然按删除处理（字段级不能把已删任务救活）', () => {
    const deletedAt = '2026-10-24T12:00:00.000Z';
    const kept = mergeTasks(
      [task({ note: 'x', updatedAt: EARLY, fieldAt: { note: EARLY } })],
      [task({ updatedAt: LATE, fieldAt: { title: LATE } })],
    );
    const alive = applyTombstones(kept, [{ id: 't1', deletedAt, title: '数学真题', date: '2026-10-24', index: 0 }]);
    expect(alive).toHaveLength(0);
  });
});
