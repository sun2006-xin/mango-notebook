import { FALLBACK_CATEGORY_NAME } from '../../constants';
import { addDays, diffDays, monthOfKey } from '../../lib/date';
import { applyTaskMove, nextOrderForDate } from '../../lib/drag';
import { dueHabitTasks, sanitizeHabitTaskLog } from '../../lib/habits';
import { applyTaskToggle, createTask, normalizeParentId } from '../../lib/task';
import type { AppAction } from '../actions';
import { patchTask, withoutId } from '../helpers';
import type { AppState, HabitTaskLogEntry, Task } from '../../types';

/* ============================================================================
   任务域：增删改、勾选、拖拽落位、回收站（墓碑）、归档

   约束：本文件的每个 case 都只改 `tasks` / `tombstones`，
   以及"任务变了之后必须跟着变的 ui.stickyDoneIds / drawerTaskId"。
   跨界改 settings 只有三处（TASK_RESTORE 恢复后把选中日切回去，
   TOMBSTONE_RESTORE 读 categories 拿默认分类，HABIT_TASK_GENERATE 写
   习惯的生成流水）—— 都写了理由。
   ========================================================================= */

/** 处理任务域 action；返回 null 表示"不是我管的" */
export function reduceTasks(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case 'TASK_ADD': {
      /**
       * 子任务只准挂一层。UI 层已经这么做了，这里再兜一次：
       * 数据会经云同步从别的设备过来，对端的规则未必和我们一致。
       */
      const parentId = normalizeParentId(state.tasks, action.task.parentId);
      const base: Task =
        parentId === action.task.parentId ? action.task : { ...action.task, parentId };
      /**
       * 排序位在这里补发（createTask 看不到同日的其它任务，只能给 0）。
       *
       * - 这天**没手动排过** → `nextOrderForDate` 返回 0 → 保持自动排序，
       *   新任务按时间/优先级插进去（与加排序功能前完全一致）。
       * - 这天**排过** → 返回 `max + 1` → 新任务排队尾。
       *   不补发的话它会拿到 0，而 0 比 1..n 都小 → 一出生就跳到列表最上面，
       *   用户刚排好的顺序被一条新任务顶掉。
       *
       * 子任务恒为 0：它只在父任务底下与兄弟排序，不参与当天的顶层序列。
       */
      const task: Task = {
        ...base,
        order: base.parentId ? 0 : nextOrderForDate(state.tasks, base.date),
      };
      return {
        ...state,
        tasks: [...state.tasks, task],
        ui: { ...state.ui, stickyDoneIds: withoutId(state.ui.stickyDoneIds, task.id) },
      };
    }

    case 'TASK_PATCH': {
      const tasks = patchTask(state.tasks, action.id, action.patch, action.now);
      if (tasks === state.tasks) return state;
      return { ...state, tasks };
    }

    case 'TASK_TOGGLE': {
      /**
       * 勾选走 applyTaskToggle：父子联动。
       * 只勾自己会出现"父任务已完成、子任务还绿着"或"5/5 完成、父任务还站着"，
       * 两者都会让进度数字和界面互相打脸。
       */
      const previous = state.tasks.find((t) => t.id === action.id);
      if (!previous) return state;
      const tasks = applyTaskToggle(state.tasks, action.id, action.now);
      const done = !previous.done;

      // sticky 只记录被直接点击的那条；被级联带动的子任务不该粘在待办区
      const cascadeIds = new Set(
        state.tasks.filter((t) => t.parentId === action.id).map((t) => t.id),
      );
      const sticky = done
        ? [...withoutId(state.ui.stickyDoneIds, action.id), action.id]
        : withoutId(state.ui.stickyDoneIds, action.id);

      return {
        ...state,
        tasks,
        ui: {
          ...state.ui,
          stickyDoneIds: sticky.filter((id) => !cascadeIds.has(id)),
        },
      };
    }

    case 'TASK_DELETE': {
      const exists = state.tasks.some((t) => t.id === action.id);
      if (!exists) return state;
      const ui = {
        ...state.ui,
        stickyDoneIds: withoutId(state.ui.stickyDoneIds, action.id),
      };
      if (ui.drawerTaskId === action.id) {
        ui.drawerTaskId = null;
        ui.drawerReturnFocusId = null;
      }
      /**
       * 墓碑是"删除"这个动作唯一的载体：合并是按 id 取并集的，
       * 没有墓碑 → 对端数组里那份还在 → 一合并就原地复活。
       *
       * 级联：删父任务时子任务也要各留一条墓碑，否则同步后子任务会集体复活。
       * 墓碑带上 title / date / index，回收站才能显示"删了什么"并原位恢复。
       */
      const target = state.tasks.find((t) => t.id === action.id);
      const children = state.tasks.filter((t) => t.parentId === action.id);
      const gone = [target, ...children].filter((t): t is Task => Boolean(t));

      const goneIds = new Set(gone.map((t) => t.id));
      const fresh = gone.map((task) => ({
        id: task.id,
        title: task.title,
        date: task.date,
        index: state.tasks.findIndex((t) => t.id === task.id),
        deletedAt: action.now,
      }));
      const keptStones = state.tombstones.filter((t) => !goneIds.has(t.id));

      return {
        ...state,
        tasks: state.tasks.filter((t) => !goneIds.has(t.id)),
        tombstones: [...keptStones, ...fresh],
        ui,
      };
    }

    case 'TASK_RESTORE': {
      // 撤销删除：按 index 插回（超界则 append），id 与其余字段原样
      const tasks = [...state.tasks];
      const index = action.index;
      /**
       * **updatedAt 必须刷成 now**（唯一不能"原样"的字段）。
       * 沿用删除前的旧时间戳 → 早于墓碑的 deletedAt → 下一次云同步
       * 被 `applyTombstones` 判成"已删"再删一次，撤销形同无效。
       * 与 `TOMBSTONE_RESTORE`（从回收站恢复）保持同一口径。
       */
      const restored: Task = { ...action.task, updatedAt: action.now };
      if (Number.isInteger(index) && index >= 0 && index <= tasks.length) {
        tasks.splice(index, 0, restored);
      } else {
        tasks.push(restored);
      }
      // U5：撤销始终恢复到任务原日期，并把选中日切回该日期
      return {
        ...state,
        tasks,
        /**
         * 撤销删除 = 这条不该再是墓碑。
         * 留着墓碑，下次合并会把刚恢复的任务又删一次（对端看到墓碑就跟着删）。
         */
        tombstones: state.tombstones.filter((t) => t.id !== action.task.id),
        settings: { ...state.settings, lastSelectedDate: action.task.date },
        ui: { ...state.ui, monthCursor: monthOfKey(action.task.date) },
      };
    }

    case 'TASK_MOVE': {
      const tasks = applyTaskMove(state.tasks, action.id, action.target, action.now);
      if (tasks === state.tasks) return state;
      return { ...state, tasks };
    }

    case 'TASK_MOVE_TO_TODAY': {
      const idSet = new Set(action.ids);
      if (!state.tasks.some((t) => idSet.has(t.id))) return state;
      return {
        ...state,
        tasks: state.tasks.map((task) => {
          if (!idSet.has(task.id)) return task;
          /** 多天任务整体平移，跨度不变（与拖拽同一口径） */
          const delta = diffDays(action.targetDate, task.date);
          const endDate = task.endDate ? addDays(task.endDate, delta) : null;
          return { ...task, date: action.targetDate, endDate, updatedAt: action.now };
        }),
      };
    }

    case 'TASK_UNDO_MOVE': {
      /** 整条 move 存进 map（撤销要同时拿 `from` 和 `order`，只存日期不够） */
      const map = new Map(action.moves.map((m) => [m.id, m]));
      if (!state.tasks.some((t) => map.has(t.id))) return state;
      return {
        ...state,
        tasks: state.tasks.map((task) => {
          const from = map.get(task.id);
          if (!from) return task;
          return {
            ...task,
            date: from.from,
            /** 只有拖拽撤销会带 order（`??` 不能写成 `||`，0 是合法值） */
            order: typeof from.order === 'number' ? from.order : task.order,
            /**
             * `endDate` 用 `in` 判断：缺省 = 这次不动它；`null` = 还原成单天任务。
             * 写成 `from.endDate ?? task.endDate` 的话，null 会被当成"没传"，
             * 于是"撤销回单天"永远生效不了。
             */
            endDate: 'endDate' in from ? (from.endDate ?? null) : task.endDate,
            updatedAt: action.now,
          };
        }),
      };
    }

    case 'ARCHIVE_DONE': {
      const kept = state.tasks.filter((task) => !(task.done && task.date < action.before));
      const removed = state.tasks.length - kept.length;
      // 没有可归档的 → 原样返回同一对象，避免一次无谓的保存
      if (removed === 0) return state;
      /**
       * 归档本质也是删除，一样要留墓碑 ——
       * 否则同步之后，刚归档掉的历史任务会整批复活回来。
       */
      const gone = state.tasks.filter((task) => task.done && task.date < action.before);
      const goneIds = new Set(gone.map((task) => task.id));
      const tombstones = [
        ...state.tombstones.filter((t) => !goneIds.has(t.id)),
        ...gone.map((task) => ({
          id: task.id,
          deletedAt: action.now,
          title: task.title,
          date: task.date,
          index: state.tasks.findIndex((t) => t.id === task.id),
        })),
      ];
      return { ...state, tasks: kept, tombstones };
    }

    case 'DATA_IMPORT_DEMO':
      return { ...state, tasks: action.tasks, ui: { ...state.ui, stickyDoneIds: [] } };

    /**
     * 习惯 → 当天任务（长期迭代）。
     *
     * 为什么放在任务域：这个 action 的**产出是任务**，主体逻辑（标题校验、
     * 发排序位、追加数组）与 TASK_ADD / WEEK_PLAN_APPLY 完全同构。
     * 顺带写 `settings.habitTaskLog` 是本域唯一"越界"的地方，理由很硬：
     * **任务和流水必须一起写**。分两个 action 的话，中间任何一次中断
     * （用户关页面 / 崩溃）都会留下"任务建了但没记流水"，下次启动再建一遍 ——
     * 用户看到的是一天的任务变成两份。
     *
     * 幂等由流水保证：`dueHabitTasks` 只会返回"今天还没派过"的习惯，
     * 全部派过就返回同一个 state（不写盘、不推送）。
     */
    case 'HABIT_TASK_GENERATE': {
      const due = dueHabitTasks({
        habits: state.settings.habits,
        habitTaskLog: state.settings.habitTaskLog,
        date: action.date,
      });
      if (due.length === 0) return state;

      const category = state.settings.categories[0]?.name ?? FALLBACK_CATEGORY_NAME;
      const created: Task[] = [];
      /** 只记**真的建成了**的那些：标题被清空导致创建失败时，不该把这个习惯记成"已派过" */
      const fresh: HabitTaskLogEntry[] = [];

      for (const item of due) {
        try {
          const task = createTask(
            { title: item.title, date: action.date, category },
            action.now,
            action.date,
          );
          /**
           * 排序位按"已经加上这一批"的现状算（与 WEEK_PLAN_APPLY 同一口径）：
           * 同一天可能一次落好几条，用 state.tasks 算的话它们会拿到同一个号，
           * 之后谁在前全看 id —— 顺序变成随机的。
           */
          created.push({
            ...task,
            order: nextOrderForDate([...state.tasks, ...created], task.date),
          });
          fresh.push({ habitId: item.habitId, date: action.date });
        } catch {
          /* 单条失败（习惯名被清空）不该挡住其余习惯 */
        }
      }
      if (created.length === 0) return state;

      return {
        ...state,
        tasks: [...state.tasks, ...created],
        settings: {
          ...state.settings,
          habitTaskLog: sanitizeHabitTaskLog(
            [...state.settings.habitTaskLog, ...fresh],
            state.settings.habits,
          ),
        },
      };
    }

    /**
     * 从回收站恢复一条已删任务。
     * 关键：恢复的同时**移除墓碑** —— 墓碑留着，下次合并会把刚恢复的任务又删掉。
     */
    case 'TOMBSTONE_RESTORE': {
      const stone = state.tombstones.find((t) => t.id === action.id);
      if (!stone) return state;
      const tombstones = state.tombstones.filter((t) => t.id !== stone.id);
      // 对端可能又建了同 id 的任务：那就只清墓碑，不再插一条，避免重复
      if (state.tasks.some((task) => task.id === stone.id)) {
        return { ...state, tombstones };
      }
      const restored: Task = {
        id: stone.id,
        title: stone.title,
        note: '',
        date: stone.date,
        time: null,
        repeat: 'none',
        priority: 'medium',
        category: state.settings.categories[0]?.name ?? FALLBACK_CATEGORY_NAME,
        done: false,
        doneAt: null,
        createdAt: action.now,
        updatedAt: action.now,
        parentId: null,
        /**
         * 回收站恢复的任务 `estimatedMinutes` 恒为 0（= 未估时）。
         *
         * 这是**已知且刻意**的取舍，不是遗漏：`TaskTombstone` 只存
         * `id / title / date / index`（见 types.ts），priority / repeat / note
         * 在恢复时同样回落默认值 —— 墓碑是"这条被删过"的凭据，不是任务快照。
         * 要把估时也留住，就得给墓碑加字段，那是**另一个决策**（涉及体积与迁移），
         * 本轮明确不动墓碑。
         */
        estimatedMinutes: 0,
        /**
         * 排序位按"这一天当前的现状"补发（与 TASK_ADD 同一口径）。
         * 不补 = 0，而 0 比 1..n 都小 → 从回收站恢复出来的任务会跳到列表最前面，
         * 把用户排好的顺序顶掉；而"恢复"在语义上就是"这条任务重新出现了"，
         * 和新建一条没有区别。
         */
        order: nextOrderForDate(state.tasks, stone.date),
      };
      const tasks = [...state.tasks];
      const safeIndex =
        Number.isInteger(stone.index) && stone.index >= 0 && stone.index <= tasks.length
          ? stone.index
          : tasks.length;
      tasks.splice(safeIndex, 0, restored);
      return { ...state, tasks, tombstones };
    }

    /**
     * 清空回收站。
     * ⚠️ 这一步是不可逆的：墓碑没了，被删任务在对端就再也不会被删，
     * 下次同步时若对端还留着旧副本，它们会复活 —— 所以只清"确认不要"的。
     */
    case 'TOMBSTONE_CLEAR': {
      if (state.tombstones.length === 0) return state;
      return { ...state, tombstones: [] };
    }

    default:
      return null;
  }
}
