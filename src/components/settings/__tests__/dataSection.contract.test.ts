import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   数据区（DataSection）：四个不可逆操作的护栏

   这一块 2026-10-31 从 `views/SettingsView.tsx` 整块搬出来，搬之前**零契约覆盖** ——
   冒烟脚本只验"按钮在不在"，点错了会发生什么没人管。而这里挤着四个回不去的操作：
   **本地备份恢复 / 导入备份 / 清空全部数据 / 归档删除 30 天前**。

   本环境不渲染这个组件（它直接依赖桌面桥 IPC），所以走源码级契约。
   每条断言都对着一种"用户真的会踩到"的场景，不是数行数。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

const src = stripComments(readFileSync(new URL('../DataSection.tsx', import.meta.url), 'utf8'));

describe('本地备份恢复：先把「现在这一份」落盘，再覆盖', () => {
  /**
   * `pre-restore.json` 是这条路径唯一的退路。顺序错了就等于没有：
   * 先 hydrate 再写快照 → 存下去的是"恢复后"的数据，用户点错了永远回不去。
   * 所以这里断言的是**顺序**，不是"有没有出现"。
   */
  it('writeDesktopBackup 在 hydrate 之前（快照存的是恢复前的数据）', () => {
    /**
     * 只锚 `writeDesktopBackup(` 这个调用开头，不锚整行 ——
     * v0.29.7 为了加"写失败就中止"把调用拆成多行，
     * 原来那种整行锚点立刻失效（契约绑排版，一改格式就假红）。
     */
    const snapshotAt = src.indexOf('writeDesktopBackup(');
    const hydrateAt = src.indexOf('hydrateFrom(payload)');
    expect(snapshotAt, '恢复前没写 pre-restore 兜底快照').toBeGreaterThan(-1);
    expect(hydrateAt, '恢复没有走唯一装载出口').toBeGreaterThan(-1);
    expect(snapshotAt, '快照写在 hydrate 之后 → 存的是恢复后的数据，退不回去了').toBeLessThan(
      hydrateAt,
    );
  });

  it('快照内容来自 buildBackupPayload(state)，不是手抄的对象字面量', () => {
    expect(src).toContain('const snapshot = buildBackupPayload(state);');
  });

  it('两段式：第一次只读出来 + 展示条数，第二次才真的覆盖', () => {
    // 点第二下才进 hydrate 分支
    expect(src).toContain('if (pendingRestore?.name === name) {');
    // 第一次只落 pendingRestore，等用户看清条数
    expect(src).toContain('setPendingRestore({ name, payload })');
    // 确认前把"这份里有什么"数给用户看
    expect(src).toContain('data-testid="backup-confirm-counts"');
  });

  it('文件读不出来 → 清掉待确认状态并提示，绝不放行装回', () => {
    // 注释已被 stripComments 剥掉，只能拿代码当锚点
    const start = src.indexOf('const text = await readDesktopBackup(name);');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 500);
    expect(block).toContain('if (!payload) {');
    expect(block).toContain('setPendingRestore(null);');
    expect(block, '文件坏了还往下走 = 用空载荷覆盖本机').not.toContain('hydrateFrom(');
  });
});

describe('从本地备份恢复：没有退路就不许覆盖', () => {
  /**
   * 恢复是不可逆操作，唯一的退路是恢复前写的那份 `pre-restore.json`。
   * 原来这里 `await` 了却**丢掉返回值**：磁盘满 / 无写权限 / 杀软拦截时，
   * 快照根本没写成，而恢复照常进行 —— 用户以为"点错了能回退"，实际退路不存在。
   */
  it('快照写失败 → 中止恢复并说明原因', () => {
    expect(src).toContain('if (!snapshotWritten)');
    const at = src.indexOf('if (!snapshotWritten)');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 600);
    // 必须提前返回：不能"提示一下然后照样覆盖"
    expect(block).toMatch(/return;/);
    expect(block).toContain('取消恢复');
    // 而且要在 hydrate 之前（顺序错了等于先毁后退）
    expect(at).toBeLessThan(src.indexOf('hydrateFrom(payload);'));
  });
});

describe('清空全部数据：确认交给 ConfirmButton（不再手写确认态）', () => {
  /**
   * v0.29.4 起，"点一下武装 / 再点一下执行 / 3 秒自动收回"统一由
   * `components/common/ConfirmButton` 负责 —— 这个文件里不再有
   * `confirmClear` 这类状态与定时器。
   *
   * 为什么要拆走：项目里四种不可逆操作原本各写一份，差别不只是外观，
   * **有的会自动收回、有的不会**（历史回滚就不会）。行为级守护搬到了
   * `ConfirmButton.dom.test.tsx`，这里只守"确实用了它、文案没改口"。
   */
  it('用的是 ConfirmButton，不是手写的二次点击状态', () => {
    expect(src).toContain('<ConfirmButton');
    expect(src).toContain('onConfirm={onClearConfirmed}');
    // 手写确认态的指纹：出现这几个就说明又抄回去了
    expect(src).not.toContain('confirmClear');
    expect(src).not.toContain('setTimeout(() => setConfirmClear');
  });

  it('文案保持原样（重构不改变用户熟悉的那句话）', () => {
    expect(src).toContain('清空全部数据');
    expect(src).toContain('确认清空？再点一次');
  });

  it('执行段仍然带 testid（冒烟与 e2e 靠它找按钮）', () => {
    expect(src).toContain('testId="data-clear"');
  });
});

describe('归档：只碰 30 天前**已完成**的', () => {
  it('计数条件是 done && date < archiveBefore（未完成的一条都不能少）', () => {
    expect(src).toContain('tasks.filter((task) => task.done && task.date < archiveBefore)');
  });

  it('没有可归档的就不派发（空动作不该进 undo 栈）', () => {
    expect(src).toContain('if (archiveCount === 0) return;');
  });

  it('派发的是有日期的分界，而不是"现在减 30 天"的重复计算', () => {
    expect(src).toContain('before: archiveBefore,');
  });
});

describe('清空全部数据：必须同时锁住云同步', () => {
  /**
   * 只清本机是不够的：`decideSyncAction` 里"本机空 + 云端有数据 = 空机恢复"
   * 是正确规则，但它分不清"新设备"与"用户刚清空" —— 不锁的话 60 秒轮询一到，
   * 整份数据原样长回来，用户会以为"清空了又自己回来了"。
   */
  it('派发 DATA_CLEAR_ALL 之后要调 noteLocalCleared()', () => {
    const start = src.indexOf('const onClearConfirmed = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1200);
    expect(block).toContain('noteLocalCleared()');
    // 顺序：先清本机，再上锁（反过来的话清空瞬间可能被一次同步抢先拉回来）
    expect(block.indexOf('DATA_CLEAR_ALL')).toBeLessThan(block.indexOf('noteLocalCleared()'));
  });
});

describe('回收站入口：墓碑数就是"删过多少条"', () => {
  it('有墓碑才显示数量（0 条时挂个「（0）」像坏了一样）', () => {
    expect(src).toContain("tombstones.length > 0 ? `（${tombstones.length}）` : ''");
  });
});
