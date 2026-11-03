import { describe, expect, it } from 'vitest';
import { buildExportMarkdown } from '../exportMarkdown';

/* ============================================================================
   F7：导出文件的**结构冻结**

   Obsidian 的经验：数据归用户、纯本地 Markdown、随时可迁出 —— 这是信任底座。
   而"能迁出"的前提是**格式稳定**：用户可能写脚本解析这份文件，
   也可能把它当长期存档。章节名或顺序一改，别人的解析就断了。

   所以这里把四个章节的标题与顺序钉死。改结构 = 这条测试必须变红。
   ========================================================================= */

const EMPTY = { tasks: [], diary: [], notes: [], focusSessions: [], today: '2026-10-29' };

describe('导出结构冻结（对外契约）', () => {
  it('首行是固定标题', () => {
    expect(buildExportMarkdown(EMPTY).split('\n')[0]).toBe('# 芒果本本 · 全量导出');
  });

  it('六个章节按固定顺序出现：任务 → 日记 → 记事 → 专注记录 → 习惯 → 作息', () => {
    const md = buildExportMarkdown(EMPTY);
    /**
     * v0.20.0 追加了「习惯」「作息」两章（**追加在最后**，不动前四个的顺序）——
     * 原先这四个的顺序仍是契约，改了照样要红。
     */
    const order = ['## 任务', '## 日记', '## 记事', '## 专注记录', '## 习惯', '## 作息'].map(
      (h) => md.indexOf(h),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('标题行带统计摘要（人一眼能看出这份里有什么）', () => {
    const md = buildExportMarkdown({
      ...EMPTY,
      tasks: [
        {
          id: 't1', title: '高数', note: '', date: '2026-10-29', time: null, repeat: 'none',
          priority: 'medium', category: '学习', done: false, doneAt: null,
          createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
          parentId: null,
        },
      ] as never,
    });
    expect(md).toContain('任务 1 条');
  });
});

/* ============================================================================
   习惯 / 作息 也必须在导出里（v0.20.0）

   为什么值得单独立用例：这两个是"用户产生、丢了重建不出来"的记录。
   Markdown 导出是"哪天不用这个应用了还能带走的那份" —— 少了它们，
   连续打卡天数就真的只存在于应用的 localStorage 里了。
   ========================================================================= */
describe('习惯 / 作息 不丢', () => {
  const WITH_HABITS = {
    ...EMPTY,
    habits: [
      { id: 'h1', name: '背单词', createdAt: '2026-10-01T00:00:00.000Z', archivedAt: null },
      { id: 'h2', name: '跑步', createdAt: '2026-10-01T00:00:00.000Z', archivedAt: '2026-10-20T00:00:00.000Z' },
    ],
    habitChecks: [
      { habitId: 'h1', date: '2026-10-28' },
      { habitId: 'h1', date: '2026-10-29' },
    ],
    sleepLog: [{ date: '2026-10-29', wakeAt: '11:05', sleepAt: '02:10' }],
  };

  it('习惯：名字、次数、连续天数、每一天的日期都写进去', () => {
    const md = buildExportMarkdown(WITH_HABITS);
    expect(md).toContain('### 背单词');
    expect(md).toContain('共 2 次');
    expect(md).toContain('当前连续 2 天');
    expect(md).toContain('2026-10-28, 2026-10-29');
  });

  it('归档的习惯标出来，但记录照样导出', () => {
    const md = buildExportMarkdown({ ...WITH_HABITS, habitChecks: [
      { habitId: 'h1', date: '2026-10-29' },
      { habitId: 'h2', date: '2026-10-10' },
    ] });
    expect(md).toContain('### 跑步（已归档）');
    expect(md).toContain('2026-10-10');
  });

  it('作息：一天一行，起 / 睡 都写', () => {
    const md = buildExportMarkdown(WITH_HABITS);
    expect(md).toContain('2026-10-29：起 11:05 · 睡 02:10');
  });

  it('空态有占位文案，不会出现空章节', () => {
    const md = buildExportMarkdown(EMPTY);
    expect(md).toContain('_（还没有习惯）_');
    expect(md).toContain('_（还没有作息记录）_');
  });
});
