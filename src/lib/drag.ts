import { addDays, diffDays } from './date';
import { sameFields } from './equal';
import { compareOpenTasks, taskOrder } from './task';
import type { DateKey, Task } from '../types';

/* ============================================================================
   拖拽（改日期 + 手动排序）—— 纯逻辑层

   这个文件里**没有 DOM、没有 React**：拖拽的"落点判定"和"改数据"都在纯函数里，
   组件只负责把矩形量出来、把指针坐标传进来。
   为什么这么拆：本项目的测试环境没有 DOM，交互层没法用 jsdom 验证；
   把真正会出错的部分（插到哪、编号怎么发）挪到纯函数里，就能被单测钉住。

   数据语义见 `Task.order` 的注释：**0 = 未手动排过**（走自动排序），
   一旦某天被拖过，那一天会被连续编号成 1..n。
   ========================================================================= */

/**
 * 新任务在这一天该拿的排序位。
 *
 * - 这天没排过（全是 0）→ 返回 0：**保持自动排序**，新任务按时间/优先级插进去。
 *   若在这里发 1，一个九点的任务会被塞到一堆"随时"任务后面，
 *   用户没拖过却看到了"手动顺序"，比不改更难解释。
 * - 这天排过（1..n）→ 返回 `max + 1`：排过序就是"我自己说了算"，新来的排队尾。
 */
export function nextOrderForDate(tasks: Task[], date: DateKey): number {
  let max = 0;
  for (const task of tasks) {
    if (task.date !== date || task.parentId) continue;
    const value = taskOrder(task);
    if (value > max) max = value;
  }
  return max > 0 ? max + 1 : 0;
}

/**
 * 落点的三种形态（判别联合，不用 `beforeId: string | null` 的三态）。
 *
 * - `day`：只改日期，目标日的排序方式不变（拖到周视图某一列就是这种）。
 * - `before`：插到某条之前 → 目标日**转为手动排序**并连续编号。
 * - `end`：放到目标日末尾 → 同样转为手动排序。
 */
export type DropTarget =
  | { kind: 'day'; date: DateKey }
  | { kind: 'before'; date: DateKey; beforeId: string }
  | { kind: 'end'; date: DateKey };

/**
 * 两个落点是否等价（用于"落点没变就不 setState"，避免每帧重渲）。
 *
 * 按结构比：`DropTarget` 是判别联合，将来加一种形态（比如"插到某条之后"）
 * 或给某种形态加字段（比如落点动画的持续时间），手写清单都会漏 ——
 * 而这里的漏法是**每帧都判"变了"**，拖拽一路掉帧，不会有任何报错。
 */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  return sameFields(a, b);
}

/** 撤销一条拖拽所需的「原位」快照 */
export interface DragUndoMove {
  id: string;
  /** 拖拽前归属的那一天 */
  from: DateKey;
  /** 拖拽前的排序位（改日期的移动不改排序位，所以原样带回来即可） */
  order: number;
  /** 拖拽前的结束日（多天任务必须一起还原，否则"撤销"会留下一个被平移过的区间） */
  endDate: DateKey | null;
}

export interface DragMovePlan {
  /** 落位后的任务数组；**与入参引用相同**表示"什么都没变" */
  tasks: Task[];
  /** 受影响的任务的原位快照（供撤销）。空数组 = 没有变化 */
  moves: DragUndoMove[];
}

/**
 * 算一次拖拽落位，同时给出撤销所需的快照。
 *
 * 为什么不先改数据、再由 UI 去反推"撤销要还原什么"：
 * 排序位在落位时会被**整段重新编号**（1..n），受影响的往往不止被拖的那一条 ——
 * 只记"被拖那条原来在哪"，撤销之后那一天会留下两个相同的编号，
 * 顺序退化成自动排序，等于"撤销了一半"。
 *
 * 三条必须同时成立的规则：
 * ① **子任务跟着父任务改日期** —— 渲染是按 `date` 分组的，父改了子不改，
 *    子任务会从父任务底下凭空消失（它还"在"，只是在别的日子里）。
 * ② **没变化就返回原数组引用** —— reducer 靠 `Object.is` 判断要不要写盘，
 *    每次拖拽都造一个新数组会让"拖到自己原位"也触发一次保存 + 一次云同步。
 * ③ **只重排目标日**，其余日子一概不动。
 *
 * `kind: 'day'` 不重排：拖到周视图某一列只是"挪到那天"，
 * 没有表达"放在第几位"，此时保持那天的自动排序才符合直觉。
 */
export function planTaskMove(
  tasks: Task[],
  id: string,
  target: DropTarget,
  now: string,
): DragMovePlan {
  const none: DragMovePlan = { tasks, moves: [] };
  if (!Array.isArray(tasks)) return none;
  const moving = tasks.find((t) => t.id === id);
  if (!moving) return none;
  if (typeof target?.date !== 'string' || !target.date) return none;

  /** 子任务跟着父走（规则①） */
  const childIds = new Set(tasks.filter((t) => t.parentId === id).map((t) => t.id));
  let dateChanged = false;

  /**
   * 目标日当前的最大编号（**不含**被拖的这条）。
   *
   * 用来决定"挪进一个已经手动排过序的日子时排在哪"：
   * 沿用原来的编号会出事 —— 一条 order=0（从未排过）的任务挪进 1..n 的一天，
   * 0 最小，它会**跳过队排到最前面**。用户只是想把它挪到周三，
   * 结果周三的整个顺序被它顶乱了。
   *
   * 所以：目标日排过序 → 拿 `max + 1`（队尾，与"新任务排队尾"同一口径）；
   * 目标日没排过（全是 0）→ 保持 0，让那天的自动排序去安排它。
   */
  const targetNextOrder = nextOrderForDate(
    tasks.filter((t) => t.id !== id && !childIds.has(t.id)),
    target.date,
  );

  /** 所有被拖动的元素（父 + 子）按**同一个位移**平移，相对跨度不变 */
  const delta = diffDays(target.date, moving.date);

  const moved: Task[] = tasks.map((task) => {
    if (task.id !== id && !childIds.has(task.id)) return task;
    if (task.date === target.date) return task;
    dateChanged = true;
    // `nextOrderForDate` 返回的已经是 max+1，别再加一次
    const order = task.id === id && targetNextOrder > 0 ? targetNextOrder : task.order;
    /**
     * 多天任务整体平移，**保持跨度**。
     * 只把开始日搬走、结束日留在原地的话，区间会被压扁甚至反转
     * （反转后 `taskCoversDate` 永不成立 = 任务凭空消失）。
     */
    const endDate = task.endDate ? addDays(task.endDate, delta) : null;
    return { ...task, date: target.date, endDate, order, updatedAt: now };
  });

  if (target.kind === 'day') return dateChanged ? snapshot(tasks, moved) : none;

  /** 目标日的顶层任务，按"当前视觉顺序"排好（order 参与比较，所以这就是用户看到的顺序） */
  const siblings = moved
    .filter((t) => t.date === target.date && !t.parentId && t.id !== id)
    .sort(compareOpenTasks);

  /** 空日不值得转手动排序：只有一条的时候编号毫无意义 */
  if (siblings.length === 0) return dateChanged ? snapshot(tasks, moved) : none;

  let index = siblings.length;
  if (target.kind === 'before') {
    const at = siblings.findIndex((t) => t.id === target.beforeId);
    // beforeId 不存在（已被删 / 筛掉了）→ 落末尾，而不是插到下标 -1
    if (at >= 0) index = at;
  }

  const self = moved.find((t) => t.id === id) as Task;
  const ordered = [...siblings.slice(0, index), self, ...siblings.slice(index)];

  /**
   * 「拖回原位」必须是**真·什么都没发生**。
   *
   * 不判这一下的话，把一条任务拖回它原来的位置也会触发：整段重新编号
   * （0 → 1..n，把这一天从"自动排序"翻成"手动排序"）+ 一次写盘 +
   * 一次云同步 + 一条"已调整顺序"的 toast。用户看到的是"我拖了一下又放回去，
   * 它弹了个提示"，而数据其实被悄悄改了性质 —— 这种"看不见的副作用"
   * 正是后面所有诡异 bug 的来源。
   */
  const beforeSeq = tasks
    .filter((t) => t.date === target.date && !t.parentId)
    .sort(compareOpenTasks)
    .map((t) => t.id);
  if (!dateChanged && sameSequence(beforeSeq, ordered.map((t) => t.id))) return none;

  const orderById = new Map<string, number>();
  ordered.forEach((task, i) => orderById.set(task.id, i + 1));

  let changed = dateChanged;
  const final = moved.map((task) => {
    const next = orderById.get(task.id);
    if (next === undefined || taskOrder(task) === next) return task;
    changed = true;
    return { ...task, order: next, updatedAt: now };
  });

  return changed ? snapshot(tasks, final) : none;
}

/** 两个 id 序列是否逐位相同 */
function sameSequence(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 逐位比对新旧数组，产出撤销快照。
 *
 * 两个数组**下标一一对应**（落位只改字段、不增删元素），所以按下标比对是安全的。
 * 判定口径是 `date` 或 `order` 变了 —— `updatedAt` 不算，
 * 否则撤销会把一次纯粹的时间戳刷新也当成"需要还原的移动"。
 */
function snapshot(before: Task[], after: Task[]): DragMovePlan {
  const moves: DragUndoMove[] = [];
  for (let i = 0; i < after.length; i += 1) {
    const prev = before[i];
    const next = after[i];
    if (!prev || !next) continue;
    if (
      prev.date !== next.date ||
      taskOrder(prev) !== taskOrder(next) ||
      (prev.endDate ?? null) !== (next.endDate ?? null)
    ) {
      moves.push({
        id: prev.id,
        from: prev.date,
        order: taskOrder(prev),
        endDate: prev.endDate ?? null,
      });
    }
  }
  return { tasks: after, moves };
}

/** 只要结果的便捷包装（reducer 用；撤销快照由视图自己算） */
export function applyTaskMove(
  tasks: Task[],
  id: string,
  target: DropTarget,
  now: string,
): Task[] {
  return planTaskMove(tasks, id, target, now).tasks;
}

/* ============================================================================
   落点判定（纯几何）
   ========================================================================= */

export interface DropBox {
  /** 任务 id（行）或日期（列） */
  key: string;
  date: DateKey;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface DropGeometry {
  /** 可接收落点的日容器 */
  days: DropBox[];
  /** 参与插入判定的行（调用方负责只放该放的：顶层、未完成） */
  rows: DropBox[];
  /** 被拖的那条：判定插入位时必须排除，否则"插到自己前面"永远成立 */
  draggedId: string;
}

/**
 * 由指针坐标算出落点。
 *
 * 流程：**先找列，再在列里找行**。
 * 顺序不能反 —— 只看行的话，指针落在两列之间的缝隙（或列底部空白）时会
 * 直接判定为 null，用户明明把卡片拖到了周三上方却松手无效，体感是"拖不动"。
 *
 * 插入位取"行的垂直中线"：指针越过某行的中线就算插到它前面，
 * 比用行的上沿更符合直觉（否则要精确到像素级贴着边才能插到第一行前面）。
 */
export function resolveDropTarget(
  geo: DropGeometry,
  x: number,
  y: number,
): DropTarget | null {
  const day = geo.days.find(
    (box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
  );
  if (!day) return null;

  const rows = geo.rows
    .filter((row) => row.date === day.date && row.key !== geo.draggedId)
    .sort((a, b) => a.top - b.top);

  if (rows.length === 0) return { kind: 'day', date: day.date };

  for (const row of rows) {
    if (y < (row.top + row.bottom) / 2) {
      return { kind: 'before', date: day.date, beforeId: row.key };
    }
  }
  return { kind: 'end', date: day.date };
}

/* ============================================================================
   边缘自动滚动

   为什么必须有：一次只能看见一屏。想把第 20 条拖到列表顶部，或者把任务拖到
   周视图里滚出屏幕的那一天，没有边缘滚动就只能"松手 → 滚动 → 再拖一遍"。
   这是所有拖拽实现里最容易被忘、也最影响体感的一条。
   ========================================================================= */

/** 触发区厚度：指针进入视口上下各这么宽的带子就开始滚 */
export const EDGE_SCROLL_ZONE = 72;
/** 每帧最大位移（px）。约 60fps 下 ≈ 720px/s，比人手滚动略快但不失控 */
export const EDGE_SCROLL_MAX_SPEED = 12;

/**
 * 这一帧该滚多少（**负数 = 向上滚**，正数 = 向下滚，0 = 不滚）。
 *
 * 速度随"进入触发区的深度"线性增长：贴到边缘那一刻满速，刚进触发区时很慢。
 * 一进区就给满速的话，指针只要稍微靠边一点页面就窜出去，落点会直接飞过头。
 *
 * 参数用视口坐标（clientY / innerHeight），不用页面坐标 ——
 * 页面坐标会随滚动变化，同一根手指停着不动速度也该是稳定的。
 */
export function edgeScrollVelocity(
  y: number,
  viewportTop: number,
  viewportBottom: number,
  zone: number = EDGE_SCROLL_ZONE,
  maxSpeed: number = EDGE_SCROLL_MAX_SPEED,
): number {
  const height = viewportBottom - viewportTop;
  if (!Number.isFinite(height) || height <= 0) return 0;
  const depth = Math.min(zone, height / 2);
  if (depth <= 0) return 0;

  const fromTop = y - viewportTop;
  const fromBottom = viewportBottom - y;

  // 贴边时 ratio → 1（满速），刚进触发区时 → 0
  if (fromTop <= depth) {
    const ratio = (depth - Math.max(0, fromTop)) / depth;
    // `|| 0` 把 -0 归一成 0：`-0` 在 === 上等于 0，但在 Object.is / 断言里不等，
    // 是个只会让人排查半天的假差异。
    return Math.round(-maxSpeed * ratio) || 0;
  }
  if (fromBottom <= depth) {
    const ratio = (depth - Math.max(0, fromBottom)) / depth;
    return Math.round(maxSpeed * ratio) || 0;
  }
  return 0;
}
