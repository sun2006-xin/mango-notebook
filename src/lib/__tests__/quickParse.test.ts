import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from '../quickParse';

/* ============================================================================
   自然语言速记（滴答清单 / Todoist 那一手）

   最重要的一条不是"能解析"，而是**绝不吞字**：
   解析出来的片段都从文本里摘掉，剩下的才是标题；摘空了就整串回退。
   ========================================================================= */

// 2026-10-29 是周四
const TODAY = '2026-10-29';

describe('组合输入', () => {
  it('明天9点 高数第3章 p1 30分钟 #学习', () => {
    const out = parseQuickAdd('明天9点 高数第3章 p1 30分钟 #学习', TODAY);
    expect(out.title).toBe('高数第3章');
    expect(out.date).toBe('2026-10-30');
    expect(out.time).toBe('09:00');
    expect(out.priority).toBe('high');
    expect(out.estimatedMinutes).toBe(30);
    expect(out.category).toBe('学习');
  });

  it('顺序无关：p2 后天 14:30 写周报', () => {
    const out = parseQuickAdd('p2 后天 14:30 写周报', TODAY);
    expect(out.title).toBe('写周报');
    expect(out.date).toBe('2026-10-31');
    expect(out.time).toBe('14:30');
    expect(out.priority).toBe('medium');
  });
});

describe('日期', () => {
  it('今天 / 明天 / 后天 / 大后天', () => {
    expect(parseQuickAdd('今天 复习', TODAY).date).toBe('2026-10-29');
    expect(parseQuickAdd('明天 复习', TODAY).date).toBe('2026-10-30');
    expect(parseQuickAdd('后天 复习', TODAY).date).toBe('2026-10-31');
    expect(parseQuickAdd('大后天 复习', TODAY).date).toBe('2026-11-01');
  });

  it('10月28日 / 10/28 都认', () => {
    expect(parseQuickAdd('10月28日 交作业', TODAY).date).toBe('2026-10-28');
    expect(parseQuickAdd('10/28 交作业', TODAY).date).toBe('2026-10-28');
  });
});

describe('时间', () => {
  it('9点 / 9点半 / 9点15 / 21:05', () => {
    expect(parseQuickAdd('9点 开会', TODAY).time).toBe('09:00');
    expect(parseQuickAdd('9点半 开会', TODAY).time).toBe('09:30');
    expect(parseQuickAdd('9点15 开会', TODAY).time).toBe('09:15');
    expect(parseQuickAdd('21:05 开会', TODAY).time).toBe('21:05');
  });

  it('非法时间不解析，也不吞字', () => {
    const out = parseQuickAdd('25点 开会', TODAY);
    expect(out.time).toBeNull();
    expect(out.title).toBe('25点 开会');
  });
});

describe('估时', () => {
  it('30分钟 / 1小时 / 1.5小时', () => {
    expect(parseQuickAdd('30分钟 背单词', TODAY).estimatedMinutes).toBe(30);
    expect(parseQuickAdd('1小时 背单词', TODAY).estimatedMinutes).toBe(60);
    expect(parseQuickAdd('1.5小时 背单词', TODAY).estimatedMinutes).toBe(90);
  });
});

describe('重复', () => {
  it('每天 → daily，日期归今天', () => {
    const out = parseQuickAdd('每天 背单词', TODAY);
    expect(out.repeat).toBe('daily');
    expect(out.date).toBe(TODAY);
    expect(out.title).toBe('背单词');
  });

  it('每周三 → weekly，日期落到最近的那个周三（今天是周四）', () => {
    const out = parseQuickAdd('每周三 复习错题', TODAY);
    expect(out.repeat).toBe('weekly');
    expect(out.date).toBe('2026-11-04');
    expect(out.title).toBe('复习错题');
  });
});

describe('绝不吞字（最重要）', () => {
  it('只有关键字、没有标题 → 整串回退，一个字段都不生效', () => {
    const out = parseQuickAdd('p1', TODAY);
    expect(out.title).toBe('p1');
    expect(out.priority).toBeNull();
    expect(out.date).toBeNull();
  });

  it('p10 里的 p1 不能被吃掉', () => {
    const out = parseQuickAdd('p10 任务', TODAY);
    expect(out.title).toBe('p10 任务');
    expect(out.priority).toBeNull();
  });

  it('普通标题原样保留', () => {
    expect(parseQuickAdd('读 STM32 手册第 3 章', TODAY).title).toBe('读 STM32 手册第 3 章');
  });

  it('空串 / 纯空白 → 返回空标题', () => {
    expect(parseQuickAdd('', TODAY).title).toBe('');
    expect(parseQuickAdd('   ', TODAY).title).toBe('');
  });

  it('多个空格归一成一个（拿掉关键字后不留空档）', () => {
    const out = parseQuickAdd('明天   9点   高数', TODAY);
    expect(out.title).toBe('高数');
  });
});
