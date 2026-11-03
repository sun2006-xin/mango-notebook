import { useState } from 'react';
import { HABIT_MAX, HABIT_NAME_MAX, normalizeHabitName } from '../../lib/habits';
import type { Habit } from '../../types';
import { Icon } from '../common/Icon';

export interface HabitsEditorProps {
  habits: Habit[];
  /** 整表替换（与 SET_HABITS 一致：UI 只负责算出"改完之后的那份数组"） */
  onChange: (habits: Habit[]) => void;
  /** 取当前时间做 createdAt / archivedAt；由调用方传，reducer 之外不读时钟 */
  now: () => string;
}

/** crypto.randomUUID 不可用时降级（与 lib/task 的 createId 同一策略） */
function newHabitId(): string {
  const maybeCrypto = globalThis.crypto as Crypto | undefined;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return `h_${maybeCrypto.randomUUID()}`;
  }
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 习惯管理（F12）。
 *
 * 交互上只有一条纪律：**删除要两步**。
 * 先「归档」（今日页不再出现、历史打卡保留），复核之后再「删除」（连同打卡记录）。
 * 直接给一个删除按钮的话，攒了 60 天的连续记录一次误点就没了 ——
 * 而这类数据是重建不出来的。
 */
export function HabitsEditor({ habits, onChange, now }: HabitsEditorProps) {
  const [draft, setDraft] = useState('');

  const active = habits.filter((habit) => !habit.archivedAt);
  const archived = habits.filter((habit) => habit.archivedAt);

  const add = (): void => {
    const name = normalizeHabitName(draft);
    if (!name) return;
    if (active.length >= HABIT_MAX) return;
    // 同名直接忽略：两个「背单词」在今日页上根本分不清
    if (active.some((habit) => habit.name === name)) {
      setDraft('');
      return;
    }
    onChange([
      ...habits,
      { id: newHabitId(), name, createdAt: now(), archivedAt: null },
    ]);
    setDraft('');
  };

  const rename = (id: string, value: string): void => {
    const name = normalizeHabitName(value);
    onChange(habits.map((habit) => (habit.id === id ? { ...habit, name: name || habit.name } : habit)));
  };

  const setArchived = (id: string, archived: boolean): void => {
    onChange(
      habits.map((habit) =>
        habit.id === id ? { ...habit, archivedAt: archived ? now() : null } : habit,
      ),
    );
  };

  const remove = (id: string): void => {
    onChange(habits.filter((habit) => habit.id !== id));
  };

  /**
   * 「每天生成任务」开关（长期迭代）。
   *
   * 仍然是整表替换（与 SET_HABITS 一致），所以不需要新的 action ——
   * 这里只是算出"改完之后的那份数组"。默认关：不请自来地往用户清单里
   * 塞任务是越权，这条在 `Habit.autoTask` 的注释里写死了。
   */
  const setAutoTask = (id: string, value: boolean): void => {
    onChange(habits.map((habit) => (habit.id === id ? { ...habit, autoTask: value } : habit)));
  };

  return (
    <div data-testid="habits-editor">
      <div className="text-body font-semibold">习惯打卡</div>
      <div className="mt-1 text-label text-ink-2">
        每天在「今日」页勾一下；最多 {HABIT_MAX} 个。归档不会丢历史，删除才会。
      </div>
      {/*
        这条说明只写一次（原来跟在每个习惯后面，8 个习惯就是 8 遍）。
        两个要点必须说清：任务从哪来（每天自动派一条）、勾了任务不算打卡 ——
        后者是联动方向单一，不说清会让人以为"勾了就该算做过"。
      */}
      <div className="mt-1 text-label text-ink-3">
        「每天生成任务」打开后，每天会在「今日」多出一条同名任务；勾完任务不会替你打卡。
      </div>

      {active.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {active.map((habit) => (
            <li key={habit.id} className="flex flex-col gap-1.5" data-habit-id={habit.id}>
              <div className="flex items-center gap-2">
                <input
                  value={habit.name}
                  aria-label={`习惯名称：${habit.name}`}
                  maxLength={HABIT_NAME_MAX}
                  onChange={(event) => rename(habit.id, event.target.value)}
                  className="h-9 min-w-0 flex-1 field px-2 text-body-sm text-ink"
 />
 <button
 type="button"
 onClick={() => setArchived(habit.id, true)}
 className="btn btn-text h-9 shrink-0 px-2 text-label"
                >
                  归档
                </button>
              </div>
              {/*
                说明只写在顶部一次，不跟每一行重复。
                （原来每行都带一句同样的话，8 个习惯就是 8 遍，翻起来全是噪音。）
              */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="habit-auto-task"
                  aria-pressed={habit.autoTask === true}
                  aria-label={`每天为「${habit.name}」生成任务`}
                  onClick={() => setAutoTask(habit.id, habit.autoTask !== true)}
                  className={`btn h-8 shrink-0 px-2.5 text-label ${
                    habit.autoTask === true ? 'btn-primary' : 'btn-outlined'
                  }`}
                >
                  每天生成任务：{habit.autoTask === true ? '开' : '关'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-label text-ink-3">还没有习惯。加一个：背单词 / 跑步 / 早睡。</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={draft}
          data-testid="habit-draft"
          placeholder="新习惯，如「背单词」"
          aria-label="新习惯名称"
          maxLength={HABIT_NAME_MAX}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          className="h-9 min-w-0 flex-1 field px-2 text-body-sm text-ink"
 />
 <button
 type="button"
 data-testid="habit-add"
 onClick={add}
 disabled={!normalizeHabitName(draft) || active.length >= HABIT_MAX}
 className="btn btn-outlined h-9 shrink-0 px-3 text-label disabled:opacity-40"
        >
          <Icon name="plus" size={13} />
          添加
        </button>
      </div>

      {archived.length > 0 ? (
        <div className="mt-4">
          <div className="text-label font-semibold text-ink-2">已归档</div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {archived.map((habit) => (
              <li key={habit.id} className="flex items-center gap-2" data-habit-id={habit.id}>
                <span className="min-w-0 flex-1 truncate text-body-sm text-ink-3">{habit.name}</span>
                <button
                  type="button"
                  onClick={() => setArchived(habit.id, false)}
                  className="btn btn-text h-8 shrink-0 px-2 text-label"
                >
                  恢复
                </button>
                <button
                  type="button"
                  onClick={() => remove(habit.id)}
                  className="btn btn-text h-8 shrink-0 px-2 text-label text-danger"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
