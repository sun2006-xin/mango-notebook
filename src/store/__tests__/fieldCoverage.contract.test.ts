import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPersistedPayload } from '../../hooks/usePersist';
import { sameDropTarget } from '../../lib/drag';
import { sameSleepEntry } from '../../lib/sleep';
import { sameGoals } from '../helpers';
import { createEmptyState, reducer } from '../reducer';
import type { AppState, DateKey, ExamGoal, Habit, SleepEntry } from '../../types';
import type { DropTarget } from '../../lib/drag';

/* ============================================================================
   字段覆盖契约：四个"整行相等"的比较点，**不许漏字段**

   为什么需要这份测试：
   `sameHabits` 曾经手写 `id / name / archivedAt / autoTask` 四行比较，
   加 `autoTask` 时漏了那一行 —— 后果是设置页那个开关**点了没反应**：
   reducer 判"内容没变"→ 返回同一个 state → 按钮弹回原样，不报错、不打日志。
   同一形状的风险还在 `sameGoals` / `sameSleepEntry` / `sameDropTarget` 上。

   三条断言口径，从弱到强：

   ① **逐字段翻转必须被发现** —— 防"清单漏一项"；
   ② **多出一个未知字段必须被发现** —— 防有人改回手写清单
      （手写清单天然忽略不认识的键，结构比较不会）；
   ③ 相等时仍要返回 true —— 防矫枉过正成"永远判不同"，
      那样每次改数据都会多写一次盘、多推一次云。

   第 ② 条是这份文件的核心：它不依赖任何字段名单，
   所以**将来给类型加字段不用改这里**，但它照样会红 —— 因为漏字段的写法无法通过它。
   ========================================================================= */

describe('sameGoals（SET_GOALS 的幂等判断）', () => {
  const base: ExamGoal = { id: 'g1', name: '转本', date: '2027-04-01' as DateKey };

  it('内容相同 → 相等', () => {
    expect(sameGoals([base], [{ ...base }])).toBe(true);
  });

  it('逐字段翻转都能发现', () => {
    for (const key of ['id', 'name', 'date'] as const) {
      const changed = { ...base, [key]: `${base[key]}-changed` };
      expect(sameGoals([base], [changed]), `字段 ${key} 变化没被发现`).toBe(false);
    }
  });

  it('多出一个未知字段 → 必须判为不同（证明不是按清单比）', () => {
    expect(sameGoals([base], [{ ...base, futureField: 1 } as never])).toBe(false);
  });

  it('长度不同 / 顺序互换 → 不等', () => {
    const other: ExamGoal = { id: 'g2', name: '四级', date: '2027-05-01' as DateKey };
    expect(sameGoals([base], [base, other])).toBe(false);
    expect(sameGoals([base, other], [other, base])).toBe(false);
  });
});

describe('sameSleepEntry（作息打卡的幂等判断）', () => {
  const base: SleepEntry = { date: '2026-10-31' as DateKey, wakeAt: '11:05', sleepAt: '02:10' };

  it('内容相同 → 相等', () => {
    expect(sameSleepEntry(base, { ...base })).toBe(true);
  });

  it('逐字段翻转都能发现', () => {
    for (const key of ['date', 'wakeAt', 'sleepAt'] as const) {
      const changed = { ...base, [key]: null };
      expect(sameSleepEntry(base, changed), `字段 ${key} 变化没被发现`).toBe(false);
    }
  });

  it('多出一个未知字段 → 必须判为不同', () => {
    expect(sameSleepEntry(base, { ...base, futureField: 1 } as never)).toBe(false);
  });

  it('一侧为空时的口径', () => {
    expect(sameSleepEntry(undefined, undefined)).toBe(true);
    expect(sameSleepEntry(base, undefined)).toBe(false);
  });
});

describe('sameDropTarget（拖拽落点的每帧比较）', () => {
  const before: DropTarget = { kind: 'before', date: '2026-10-31' as DateKey, beforeId: 't9' };

  it('内容相同 → 相等', () => {
    expect(sameDropTarget(before, { ...before })).toBe(true);
  });

  it('逐字段翻转都能发现', () => {
    for (const key of ['kind', 'date', 'beforeId'] as const) {
      const changed = { ...before, [key]: '__changed__' } as unknown as DropTarget;
      expect(sameDropTarget(before, changed), `字段 ${key} 变化没被发现`).toBe(false);
    }
  });

  it('多出一个未知字段 → 必须判为不同', () => {
    expect(sameDropTarget(before, { ...before, futureField: 1 } as never)).toBe(false);
  });

  it('换一种形态（before → end）→ 不等', () => {
    expect(sameDropTarget(before, { kind: 'end', date: before.date })).toBe(false);
  });
});

describe('sameHabits（SET_HABITS 的幂等判断）· 通过 reducer 验', () => {
  /** `sameHabits` 是模块内私有函数，只能经 reducer 观察它的判定结果 */
  const habit: Habit = {
    id: 'h1',
    name: '背单词',
    createdAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
    autoTask: true,
  };

  function stateWith(list: Habit[]): AppState {
    const base = createEmptyState();
    return { ...base, settings: { ...base.settings, habits: list } };
  }

  function dispatchHabits(state: AppState, list: Habit[]): AppState {
    return reducer(state, { type: 'SET_HABITS', habits: list });
  }

  it('内容相同 → 返回同一个 state 引用（幂等，不写盘不推送）', () => {
    const state = stateWith([habit]);
    expect(dispatchHabits(state, [{ ...habit }])).toBe(state);
  });

  it('逐字段翻转都必须让 state 变化', () => {
    const state = stateWith([habit]);
    const flips: Record<string, Habit> = {
      id: { ...habit, id: 'h2' },
      name: { ...habit, name: '跑步' },
      createdAt: { ...habit, createdAt: '2026-09-01T00:00:00.000Z' },
      archivedAt: { ...habit, archivedAt: '2026-10-30T00:00:00.000Z' },
      /** ⚠️ 这条是真实事故：漏比 autoTask 时开关点了没反应 */
      autoTask: { ...habit, autoTask: false },
    };
    for (const [field, next] of Object.entries(flips)) {
      expect(dispatchHabits(state, [next]), `字段 ${field} 的变化被吞掉了`).not.toBe(state);
    }
  });

  it('把 autoTask 从「有」改成「没有」（键整个消失）→ 也要被发现', () => {
    const state = stateWith([habit]);
    const { autoTask: _drop, ...withoutKey } = habit;
    expect(dispatchHabits(state, [withoutKey as Habit])).not.toBe(state);
  });
});

/* ============================================================================
   云同步闸门的集合覆盖：`IDENTITY_SPECS` 必须有每一个集合的一条
   ----------------------------------------------------------------------------
   `snapshotDiffers` 决定"要不要推送 / 要不要把合并结果 hydrate 回本机"。
   它按集合逐个比，**少写一个集合 = 给那一组上"永不同步"的锁**：
   只要其它集合没变，这一组的任何改动都会被判成稳态而跳过 —— 界面上完全看不出坏。

   这里不靠人眼核对：把 `PersistedPayload` 的集合钥匙一个个拿出来，
   去 `IDENTITY_SPECS` 里点名。将来加第 7 个集合忘了配 → 这条立刻红。
   ========================================================================= */
describe('云同步闸门：每个持久化集合都要有一条 IDENTITY_SPEC', () => {
  const SRC = readFileSync(new URL('../../lib/syncDecision.ts', import.meta.url), 'utf8');

  /** payload 里除元信息与 settings 之外的集合（settings 走 JSON 整体比较） */
  function collectionKeys(): string[] {
    const payload = buildPersistedPayload(createEmptyState());
    return Object.keys(payload)
      .filter((key) => !['schemaVersion', 'savedAt', 'settings'].includes(key))
      .sort();
  }

  function specKeys(): string[] {
    const block = SRC.slice(
      SRC.indexOf('const IDENTITY_SPECS = {'),
      SRC.indexOf('} as const satisfies'),
    );
    expect(block, '找不到 IDENTITY_SPECS').not.toBe('');
    return [...block.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((match) => match[1]).sort();
  }

  it('两边集合名一一对应', () => {
    expect(specKeys()).toEqual(collectionKeys());
  });

  it('每条 spec 都指定了主键与版本戳（页码不能是空配置）', () => {
    const block = SRC.slice(
      SRC.indexOf('const IDENTITY_SPECS = {'),
      SRC.indexOf('} as const satisfies'),
    );
    const specs = [...block.matchAll(/key:\s*'(\w+)',\s*stamp:\s*'(\w+)'/g)];
    expect(specs).toHaveLength(collectionKeys().length);
  });

  /**
   * 配置齐了还不够 —— `snapshotDiffers` 里还得**逐个用上**。
   *
   * 漏掉一行的症状极隐蔽：那条集合的任何改动都判成"稳态"→ 既不推送、
   * 也不把合并结果 hydrate 回本机，界面上完全看不出坏（东西明明改了啊）。
   */
  it('snapshotDiffers 里每个 spec 都被真正用到', () => {
    const body = SRC.slice(
      SRC.indexOf('function snapshotDiffers('),
      SRC.indexOf('function isSameSnapshot('),
    );
    expect(body, '找不到 snapshotDiffers').not.toBe('');
    for (const key of collectionKeys()) {
      expect(body, `snapshotDiffers 里没有用到 IDENTITY_SPECS.${key}`).toContain(
        `IDENTITY_SPECS.${key}`,
      );
    }
  });
});
