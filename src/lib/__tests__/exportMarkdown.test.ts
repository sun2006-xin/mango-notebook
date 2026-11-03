import { describe, expect, it } from 'vitest';
import { buildExportMarkdown, exportFileName } from '../exportMarkdown';
import type { DiaryEntry, FocusSession, Note, Task } from '../../types';

/* ============================================================================
   全量导出 Markdown（给人读的那一份，与 JSON 备份分工不同）

   断言落点：**用户拿到文件后能看懂** —— 分组顺序、勾选状态、子任务缩进、
   回收站记事不出现、专注当天的总时长。
   ========================================================================= */

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '高数：极限的定义',
    note: '',
    date: '2026-10-28',
    time: '09:00',
    repeat: 'none',
    priority: 'high',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-28T01:00:00.000Z',
    updatedAt: '2026-10-28T01:00:00.000Z',
    parentId: null,
    estimatedMinutes: 30,
    ...over,
  } as Task;
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: '错题：洛必达',
    content: '## 题目\n忘了验条件',
    category: '错题',
    pinned: false,
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    ...over,
  } as Note;
}

function session(over: Partial<FocusSession> = {}): FocusSession {
  return {
    id: 'f1',
    taskId: 't1',
    date: '2026-10-27',
    startedAt: '2026-10-27T06:00:00.000Z',
    endedAt: '2026-10-27T06:25:00.000Z',
    durationMs: 25 * 60_000,
    ...over,
  } as FocusSession;
}

function emptySource(over: Partial<Parameters<typeof buildExportMarkdown>[0]> = {}) {
  return { tasks: [], diary: [], notes: [], focusSessions: [], today: '2026-10-28', ...over };
}

describe('任务', () => {
  it('按日期倒序分组，未完成/已完成用复选框区分', () => {
    const md = buildExportMarkdown(
      emptySource({
        tasks: [
          task({ id: 'a', date: '2026-10-26', title: '旧的' }),
          task({ id: 'b', date: '2026-10-28', title: '新的' }),
          task({ id: 'c', date: '2026-10-28', title: '做完的', done: true, doneAt: 'x' }),
        ],
      }),
    );
    const i26 = md.indexOf('### 2026-10-26');
    const i28 = md.indexOf('### 2026-10-28');
    expect(i28).toBeGreaterThan(-1);
    expect(i28).toBeLessThan(i26); // 新的在前
    expect(md).toContain('- [ ] 新的');
    expect(md).toContain('- [x] 做完的');
  });

  it('时间与分类进元信息；「随时」的任务不写时间', () => {
    const md = buildExportMarkdown(
      emptySource({
        tasks: [task({ time: '09:00' }), task({ id: 'z', time: null, title: '随时做的' })],
      }),
    );
    expect(md).toContain('- [ ] 高数：极限的定义（09:00 · 学习 · 高优先级 · 预计 30 分钟）');
    expect(md).toContain('- [ ] 随时做的（学习 · 高优先级 · 预计 30 分钟）');
  });

  it('子任务缩进挂在父任务下面', () => {
    const md = buildExportMarkdown(
      emptySource({
        tasks: [
          task({ id: 'p', title: '父任务' }),
          task({ id: 'c', title: '子任务', parentId: 'p', time: null }),
        ],
      }),
    );
    const lines = md.split('\n');
    const parent = lines.findIndex((l) => l.startsWith('- [ ] 父任务'));
    const child = lines.findIndex((l) => l.startsWith('  - [ ] 子任务'));
    expect(parent).toBeGreaterThan(-1);
    expect(child).toBe(parent + 1);
  });

  it('备注缩进进下一行', () => {
    const md = buildExportMarkdown(emptySource({ tasks: [task({ note: '记得带草稿纸' })] }));
    expect(md).toContain('- [ ] 高数：极限的定义');
    expect(md).toContain('  记得带草稿纸');
  });
});

describe('日记与记事', () => {
  it('日记按日期倒序，空正文的不导出', () => {
    const diary: DiaryEntry[] = [
      { date: '2026-10-26', content: '二十六号' } as DiaryEntry,
      { date: '2026-10-28', content: '二十八号' } as DiaryEntry,
      { date: '2026-10-27', content: '   ' } as DiaryEntry,
    ];
    const md = buildExportMarkdown(emptySource({ diary }));
    expect(md.indexOf('### 2026-10-28')).toBeLessThan(md.indexOf('### 2026-10-26'));
    expect(md).toContain('二十八号');
    expect(md).not.toContain('### 2026-10-27');
  });

  it('回收站里的记事（软删除的空壳）不出现在导出里', () => {
    const md = buildExportMarkdown(
      emptySource({
        notes: [note({ id: 'alive', title: '还在' }), note({ id: 'gone', title: '删掉的', content: '' })],
      }),
    );
    expect(md).toContain('还在');
    expect(md).not.toContain('删掉的');
  });

  it('置顶的记事排在最前', () => {
    const md = buildExportMarkdown(
      emptySource({
        notes: [
          note({ id: 'a', title: '普通', updatedAt: '2026-10-28T10:00:00.000Z' }),
          note({ id: 'b', title: '置顶', pinned: true, updatedAt: '2026-10-20T10:00:00.000Z' }),
        ],
      }),
    );
    expect(md.indexOf('置顶')).toBeLessThan(md.indexOf('普通'));
    expect(md).toContain('📌');
  });
});

describe('专注记录', () => {
  it('按日分组 + 当天总时长 + 关联任务名', () => {
    const md = buildExportMarkdown(
      emptySource({
        tasks: [task()],
        focusSessions: [
          session(),
          session({ id: 'f2', durationMs: 10 * 60_000, startedAt: '2026-10-27T07:00:00.000Z', endedAt: '2026-10-27T07:10:00.000Z' }),
        ],
      }),
    );
    expect(md).toContain('共 35 分钟');
    expect(md).toContain('25 分钟 · 高数：极限的定义');
    expect(md).toContain('10 分钟');
  });

  it('不挂任务的自由专注只写时长，不写任务名', () => {
    const md = buildExportMarkdown(
      emptySource({ focusSessions: [session({ taskId: null })] }),
    );
    expect(md).toContain('25 分钟');
    expect(md).not.toContain('· 高数');
  });
});

describe('健壮性与文件名', () => {
  it('全空数据也有完整骨架，不抛异常', () => {
    const md = buildExportMarkdown(emptySource());
    expect(md).toContain('# 芒果本本 · 全量导出');
    expect(md).toContain('任务 0 条');
    expect(md).toContain('## 任务');
    expect(md).toContain('## 日记');
    expect(md).toContain('## 记事');
    expect(md).toContain('## 专注记录');
  });

  it('脏数据（null 项 / 缺字段）不抛、不写出 undefined', () => {
    const md = buildExportMarkdown(
      emptySource({
        tasks: [null, { id: 'x' }, undefined] as unknown as Task[],
        diary: [null] as unknown as DiaryEntry[],
        notes: [null] as unknown as Note[],
        focusSessions: [null] as unknown as FocusSession[],
      }),
    );
    expect(md).not.toContain('undefined');
    expect(md).toContain('# 芒果本本 · 全量导出');
  });

  it('文件名带紧凑日期戳（Windows 文件名不接受冒号）', () => {
    expect(exportFileName('2026-10-28')).toBe('芒果本本-导出-20261028.md');
  });
});
