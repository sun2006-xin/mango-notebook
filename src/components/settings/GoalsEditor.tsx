import { useCallback, useState } from 'react';
import { Icon } from '../common/Icon';
import { TEXT, TOAST_TIMEOUT } from '../../constants';
import { useToast } from '../../hooks/useToast';
import { diffDays, isValidDateKey } from '../../lib/date';
import { GOAL_NAME_MAX } from '../../lib/goal';
import { useAppDispatch, useAppState } from '../../store/StoreContext';
import type { DateKey } from '../../types';

/* ============================================================================
   目标倒计时（考试 / 截止日）—— 设置页里的一块

   从 SettingsView.tsx 搬出来的理由：这一块的**状态（草稿名 / 草稿日）、
   校验、两个处理器、渲染**全是自洽的，只依赖 goals 与 dispatch。
   留在那个 1400 行的文件里时，找"目标为什么加不进去"得先翻过云同步、
   备份、历史版本一大片无关代码。

   增 / 删都走 `SET_GOALS`（settings 字段更新，不是新业务实体）：
   UI 负责"算好下一份完整数组"，reducer 负责兜底（sanitizeGoals：非法项丢弃、
   同 id 去重、按日期升序）—— 增删改**只有一条数据路径**，
   不会出现三个 action 各写一份校验。
   ========================================================================= */

export interface GoalsEditorProps {
  /** 当前真实今天（倒计时以它为基准） */
  today: DateKey;
}

export function GoalsEditor({ today }: GoalsEditorProps) {
  const { settings } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  const [draftName, setDraftName] = useState('');
  const [draftDate, setDraftDate] = useState<DateKey>(today);

  const addGoal = useCallback(() => {
    const name = draftName.trim().slice(0, GOAL_NAME_MAX);
    if (!name) {
      toast.show('先给目标起个名字', null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    if (!isValidDateKey(draftDate)) {
      toast.show('请选择一个有效日期', null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    // 完全同名同日期的重复目标挡掉（多半是连点两下）
    if (settings.goals.some((goal) => goal.name === name && goal.date === draftDate)) {
      toast.show(`目标「${name}」已经在列表里了`, null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    dispatch({
      type: 'SET_GOALS',
      goals: [
        ...settings.goals,
        {
          id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          date: draftDate,
        },
      ],
    });
    setDraftName('');
    toast.show(`已添加目标「${name}」`, null, TOAST_TIMEOUT.info);
  }, [dispatch, draftDate, draftName, settings.goals, toast]);

  const removeGoal = useCallback(
    (id: string, name: string) => {
      dispatch({ type: 'SET_GOALS', goals: settings.goals.filter((goal) => goal.id !== id) });
      toast.show(`已删除目标「${name}」`, null, TOAST_TIMEOUT.info);
    },
    [dispatch, settings.goals, toast],
  );

  return (
    <div className="border-b border-line py-4">
      <div className="text-body font-semibold">{TEXT.goalsTitle}</div>
      <div className="mt-1 text-label text-ink-2">{TEXT.goalsHint}</div>

      {settings.goals.length === 0 ? (
        <p
          data-testid="goal-empty"
          className="mt-3 rounded-md border border-dashed border-line px-3 py-4 text-label text-ink-3"
        >
          {TEXT.goalsEmpty}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {settings.goals.map((goal) => {
            const days = diffDays(goal.date, today);
            return (
              <li key={goal.id} data-testid={`goal-item-${goal.id}`} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-body text-ink">{goal.name}</span>
                <span className="tnum shrink-0 text-label text-ink-2">{goal.date}</span>
                <span className={`shrink-0 text-label ${days < 0 ? 'text-ink-3' : 'text-accent'}`}>
                  {days === 0
                    ? TEXT.goalTodaySuffix
                    : days > 0
                      ? `${TEXT.goalCountdownMiddle} ${days} ${TEXT.goalCountdownSuffix}`
                      : TEXT.goalExpired}
                </span>
                <button
                  type="button"
                  data-testid={`goal-delete-${goal.id}`}
                  onClick={() => removeGoal(goal.id, goal.name)}
                  aria-label={`${TEXT.goalDelete}：${goal.name}`}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-danger/10 hover:text-danger"
                >
                  <Icon name="trash" size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          data-testid="goal-name-input"
          value={draftName}
          maxLength={GOAL_NAME_MAX}
          placeholder={TEXT.goalNamePlaceholder}
          aria-label={TEXT.goalNamePlaceholder}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addGoal();
            }
          }}
          className="h-11 min-w-0 flex-1 field px-3 text-body text-ink"
 />
 <input
 data-testid="goal-date-input"
 type="date"
 value={draftDate}
 aria-label={TEXT.goalDateLabel}
 onChange={(event) => setDraftDate(event.target.value as DateKey)}
 className="tnum h-11 shrink-0 field px-3 text-body-sm text-ink"
 />
 <button type="button" data-testid="goal-add" onClick={addGoal} className="btn btn-outlined shrink-0">
          {TEXT.goalAdd}
        </button>
      </div>
    </div>
  );
}
