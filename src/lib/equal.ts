/* ============================================================================
   结构化比较 —— 字段清单**不再手抄**
   ----------------------------------------------------------------------------
   为什么要有这个文件：

   `sameHabits` 曾经手写 `id / name / archivedAt / autoTask` 四个字段做幂等判断。
   加 `autoTask` 时忘了往清单里补一行，后果不是"多一次无谓渲染"，而是
   **那个开关再也点不动**：reducer 判"内容没变"→ 返回同一个 state → 按钮弹回原样，
   既不报错也不打日志。同一个形状的事故在 `sameGoals`、`sameSleepEntry`、
   五个 `same*Set` 上都可能重演 —— 手抄清单 vs 类型定义，两份代码必然会漂移。

   所以这里把比较按**结构**做：键从对象本身取，不写死。
   新增字段自动纳入，删字段自动退出，不可能漂移。

   代价与边界：`sameFields` 是**浅比较**（标量逐项比，嵌套对象/数组按引用比）。
   用在扁平记录上完全正确；用在带嵌套的记录上会退化成"引用变了就判不同"——
   方向是安全的（多同步一次），但会丢幂等性。所以**只给扁平记录用**，
   由 `__tests__/fieldCoverage.contract.test.ts` 逐个类型守住这一前提。
   ========================================================================= */

/** 值是否等价：`undefined` 与 `null` 视为同一态（老数据 / sanitize 常把空省掉） */
export function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 两条扁平记录是否等价 —— **键取两侧并集**，逐项比。
 *
 * 取并集而不是只取一侧：`{a:1}` 与 `{a:1,b:2}` 必须判为不同。
 * 只遍历左键会让"对端多了个字段"永远发现不了（正是 `autoTask` 那次事故的形状）。
 *
 * `null` 与 `undefined` 之间：入参任意一侧为空则返回两者引用相等，
 * 与旧的手写版本 `if (!a || !b) return a === b` 口径一致。
 */
export function sameFields(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  /**
   * 一侧是 `null` / `undefined` 时：两边都空才算相等。
   * 不能直接 `if (!a || !b) return false` —— 那样 `null` 与 `undefined`
   * 会被判成不同，而 sanitize 产物里这两种形态是混着出现的
   * （`archivedAt: null` vs 整个键省掉），判不同就会每次都比出差异。
   */
  if (a == null || b == null) return sameValue(a, b);
  const left = asRecord(a);
  const right = asRecord(b);
  if (!left || !right) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/** 数组归一：`null` / `undefined` 当空数组，其它非数组一律 null（表示"没法比"） */
function asList(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  return value == null ? [] : null;
}

/**
 * 两个数组是否**逐位**等价（元素按 `sameFields` 比）。
 *
 * 逐位而不是按 id 配对：调用方（习惯 / 考试目标）传进来的都是"顺序即语义"的
 * 列表，reducer 里也只做整体替换。按 id 配对会把"两条记录换了位置"判成相同，
 * 而列表顺序会原样渲染出去。
 */
export function sameRows(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  const left = asList(a);
  const right = asList(b);
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sameFields(left[i], right[i])) return false;
  }
  return true;
}

/**
 * 两个集合是否等价 —— 按**主键 + 版本戳**比，**不比内容**。
 *
 * 云同步的闸门只需要回答"两边数据是否同一份"，而任务是整条 LWW、
 * 靠 `updatedAt` 定胜负：内容变了 `updatedAt` 必变，比内容纯属多余。
 * 反过来说，**漏比版本戳**会让"另一台设备改了这条"永远同步不到本机
 * （`sameNoteSet` / `sameFocusSet` 的注释记的就是这次事故）。
 *
 * 于是把"主键从哪来、版本戳是哪个字段"作为参数传进来：
 * 五个调用点共用一套逻辑，不可能出现"三个比了时间戳、两个忘了"。
 *
 * 脏数据（非对象、主键缺失）**先剔除**再比 —— 它们既进不了合并，也不该让
 * 闸门判定翻转，更不能让比较抛异常（载荷来自云端，什么都可能。
 *
 * 非数组一律当空集：与各调用点原本的 `listOf` 口径一致，且两侧都空时判"无差异"
 * 是对的 —— 没有数据可同步，不该反复推空包。
 */
export function sameByIdentity<T>(
  a: readonly T[] | null | undefined,
  b: readonly T[] | null | undefined,
  keyOf: (item: T) => string | undefined,
  stampOf: (item: T) => string | undefined,
): boolean {
  const left = indexBy(a, keyOf, stampOf);
  const right = indexBy(b, keyOf, stampOf);
  /**
   * 元素**个数**与**主键个数**都要对得上。
   *
   * 只比主键个数会漏掉一种脏数据：一侧有两条主键相同的记录（手改备份能造出来），
   * 索引塌成一条，于是"两条"与"一条"被判成等价 —— 丢的那条永远同步不回来。
   */
  if (left.count !== right.count || left.byKey.size !== right.byKey.size) return false;
  // 个数相同、且右侧每个主键都能在左侧找到同值 → 两个集合等价
  for (const [key, stamp] of right.byKey) {
    if (!left.byKey.has(key) || left.byKey.get(key) !== stamp) return false;
  }
  return true;
}

interface Indexed {
  byKey: Map<string, string | undefined>;
  count: number;
}

function indexBy<T>(
  list: readonly T[] | null | undefined,
  keyOf: (item: T) => string | undefined,
  stampOf: (item: T) => string | undefined,
): Indexed {
  const byKey = new Map<string, string | undefined>();
  let count = 0;
  if (!Array.isArray(list)) return { byKey, count };
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = keyOf(item);
    if (typeof key !== 'string' || !key) continue;
    byKey.set(key, stampOf(item));
    count += 1;
  }
  return { byKey, count };
}
