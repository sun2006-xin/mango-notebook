import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildMonthGrid,
  buildWeekDays,
  compareDateKey,
  dateKey,
  daysInMonth,
  diffDays,
  formatDateTitle,
  formatMonthTitle,
  formatRelativeDay,
  formatTime,
  formatWeekTitle,
  getWeekRange,
  isOverdue,
  isValidDateKey,
  monthOfKey,
  nowIso,
  parseDateKey,
  shiftMonth,
  startOfWeek,
  weekdayLabels,
} from '../date';

/* ============================================================================
   §4.1 日期纯函数
   两条禁令的回归点：dateKey 的 23:59 / 00:01 边界、addDays 跨月跨年。
   ========================================================================= */

describe('dateKey / parseDateKey（本地时区，禁 toISOString）', () => {
  it('23:59 仍属当天，00:01 属次日', () => {
    expect(dateKey(new Date(2026, 9, 24, 23, 59, 59))).toBe('2026-10-24');
    expect(dateKey(new Date(2026, 9, 25, 0, 1, 0))).toBe('2026-10-25');
  });

  it('月/日补零', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('parseDateKey 得到本地零点（不是 UTC）', () => {
    const d = parseDateKey('2026-10-24');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(24);
    expect(d.getHours()).toBe(0);
  });

  it('往返无损', () => {
    expect(dateKey(parseDateKey('2026-03-01'))).toBe('2026-03-01');
  });
});

describe('isValidDateKey', () => {
  it('拒绝不存在的日期', () => {
    expect(isValidDateKey('2026-02-30')).toBe(false);
    expect(isValidDateKey('2026-13-01')).toBe(false);
    expect(isValidDateKey('2026-00-10')).toBe(false);
  });

  it('接受闰日与正常日期', () => {
    expect(isValidDateKey('2028-02-29')).toBe(true);
    expect(isValidDateKey('2026-02-28')).toBe(true);
  });

  it('拒绝格式不符', () => {
    expect(isValidDateKey('2026-2-4')).toBe(false);
    expect(isValidDateKey('')).toBe(false);
  });
});

describe('addDays（禁 ts ± 86400000）', () => {
  it('跨月', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('跨年', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('闰年 2 月', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('n=0 恒等', () => {
    expect(addDays('2026-10-24', 0)).toBe('2026-10-24');
  });
});

describe('diffDays / compareDateKey / isOverdue', () => {
  it('同一天为 0，方向正确', () => {
    expect(diffDays('2026-10-24', '2026-10-24')).toBe(0);
    expect(diffDays('2026-10-25', '2026-10-24')).toBe(1);
    expect(diffDays('2026-10-23', '2026-10-24')).toBe(-1);
    expect(diffDays('2026-11-01', '2026-10-31')).toBe(1);
  });

  it('字典序比较', () => {
    expect(compareDateKey('2026-09-30', '2026-10-01')).toBe(-1);
    expect(compareDateKey('2026-10-01', '2026-10-01')).toBe(0);
    expect(compareDateKey('2026-10-02', '2026-10-01')).toBe(1);
  });

  it('逾期只看日期不看时间：当天不算逾期', () => {
    expect(isOverdue('2026-10-23', '2026-10-24')).toBe(true);
    expect(isOverdue('2026-10-24', '2026-10-24')).toBe(false);
    expect(isOverdue('2026-10-25', '2026-10-24')).toBe(false);
  });
});

describe('monthOfKey / shiftMonth / daysInMonth', () => {
  it('month0 为 0-11', () => {
    expect(monthOfKey('2026-10-24')).toEqual({ year: 2026, month: 9 });
  });

  it('平移跨年归一', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth({ year: 2026, month: 0 }, 13)).toEqual({ year: 2027, month: 1 });
  });

  it('当月天数', () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2026, 7)).toBe(31);
    expect(daysInMonth(2026, 11)).toBe(31);
  });
});

describe('startOfWeek', () => {
  it('weekStart=1（周一）：周日属上一周', () => {
    // 2026-10-25 是周日
    expect(startOfWeek('2026-10-25', 1)).toBe('2026-10-19');
    expect(startOfWeek('2026-10-19', 1)).toBe('2026-10-19');
  });

  it('weekStart=0（周日）：周日是本周首日', () => {
    expect(startOfWeek('2026-10-25', 0)).toBe('2026-10-25');
    expect(startOfWeek('2026-10-31', 0)).toBe('2026-10-25');
  });
});

describe('getWeekRange（跨月跨年不裁剪 + 幂等）', () => {
  it('跨年：2026-12-31 → 2026-12-28 ~ 2027-01-03', () => {
    expect(getWeekRange('2026-12-31', 1)).toEqual({
      startKey: '2026-12-28',
      endKey: '2027-01-03',
    });
  });

  it('同一周的两天必得同一组起止（幂等）', () => {
    // 2027-01-01 是周五，与 2026-12-31 同周
    expect(getWeekRange('2027-01-01', 1)).toEqual(getWeekRange('2026-12-31', 1));
    const range = getWeekRange('2027-01-01', 1);
    expect(getWeekRange(range.startKey, 1)).toEqual(range);
  });

  it('weekStart=0：2026-10-31（周六）属 10-25~10-31，不是 10-31~11-06', () => {
    expect(getWeekRange('2026-10-31', 0)).toEqual({
      startKey: '2026-10-25',
      endKey: '2026-10-31',
    });
    expect(getWeekRange('2026-10-25', 0)).toEqual(getWeekRange('2026-10-31', 0));
  });

  it('必然包含 key 本身', () => {
    const { startKey, endKey } = getWeekRange('2026-10-24', 1);
    expect(startKey <= '2026-10-24' && '2026-10-24' <= endKey).toBe(true);
  });

  it('闰日 2028-02-29 正常落在其所在周', () => {
    const { startKey, endKey } = getWeekRange('2028-02-29', 1);
    expect(startKey <= '2028-02-29' && '2028-02-29' <= endKey).toBe(true);
  });
});

describe('buildWeekDays', () => {
  it('固定 7 项且单调递增，首尾与 getWeekRange 一致', () => {
    const days = buildWeekDays('2026-10-24', 1);
    expect(days).toHaveLength(7);
    const range = getWeekRange('2026-10-24', 1);
    expect(days[0]).toBe(range.startKey);
    expect(days[6]).toBe(range.endKey);
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i]).toBe(addDays(days[i - 1] as string, 1));
    }
  });

  it('跨月周不裁剪（30 31 1 2 3 4 5 这种列是预期）', () => {
    const days = buildWeekDays('2026-10-28', 1);
    expect(days).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('weekStart=0 时列序为日…六', () => {
    const days = buildWeekDays('2026-10-25', 0);
    expect(days[0]).toBe('2026-10-25');
    expect(parseDateKey(days[0] as string).getDay()).toBe(0);
    expect(weekdayLabels(0)).toEqual(['日', '一', '二', '三', '四', '五', '六']);
  });

  it('非法 key 回落 todayKey 的 7 天（不抛）', () => {
    expect(() => buildWeekDays('not-a-date', 1)).not.toThrow();
    const days = buildWeekDays('', 1);
    expect(days).toHaveLength(7);
    expect(days.every((d) => isValidDateKey(d))).toBe(true);
  });
});

describe('buildMonthGrid（固定 42 格）', () => {
  it('2026-02（28 天，周一起）', () => {
    const cells = buildMonthGrid(2026, 1, 1, '2026-02-10');
    expect(cells).toHaveLength(42);
    expect(cells[0]?.key).toBe('2026-01-26');
    expect(parseDateKey(cells[0]?.key as string).getDay()).toBe(1);
    expect(cells.filter((c) => c.inMonth)).toHaveLength(28);
    expect(cells.find((c) => c.isToday)?.key).toBe('2026-02-10');
    expect(cells[6]?.weekday).toBe(0);
  });

  it('2026-08（31 天，8/1 是周六）', () => {
    const cells = buildMonthGrid(2026, 7, 1, '2026-08-01');
    expect(cells).toHaveLength(42);
    expect(cells[0]?.key).toBe('2026-07-27');
    expect(cells.filter((c) => c.inMonth)).toHaveLength(31);
    expect(cells[0]?.isToday).toBe(false);
    expect(cells.find((c) => c.isToday)?.day).toBe(1);
  });

  it('weekStart=0 时首格是周日，列头为日…六', () => {
    const cells = buildMonthGrid(2026, 9, 0, '2026-10-24');
    expect(cells).toHaveLength(42);
    expect(parseDateKey(cells[0]?.key as string).getDay()).toBe(0);
    expect(weekdayLabels(0)[0]).toBe('日');
  });

  it('5 行月份的第 6 行整行为下月补位', () => {
    // 2026-02 恰好 4 行整（1/26 ~ 3/1），第 5、6 行都是补位
    const cells = buildMonthGrid(2026, 1, 1, '2026-02-01');
    const lastRow = cells.slice(35);
    expect(lastRow.every((c) => c.inMonth === false)).toBe(true);
  });

  it('inMonth 与真实年月一致', () => {
    const cells = buildMonthGrid(2026, 11, 1, '2026-12-01');
    for (const cell of cells.filter((c) => c.inMonth)) {
      const d = parseDateKey(cell.key);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(11);
      expect(d.getDate()).toBe(cell.day);
    }
  });
});

describe('文案格式化', () => {
  it('formatDateTitle 不补零', () => {
    expect(formatDateTitle('2026-10-24')).toBe('10月24日 周六');
    expect(formatDateTitle('2026-10-04')).toBe('10月4日 周日');
  });

  it('formatMonthTitle 数字与汉字间留空格', () => {
    expect(formatMonthTitle(2026, 9)).toBe('2026 年 10 月');
  });

  it('formatRelativeDay 两天内用相对词，再远回落日期', () => {
    expect(formatRelativeDay('2026-10-24', '2026-10-24')).toBe('今天');
    expect(formatRelativeDay('2026-10-23', '2026-10-24')).toBe('昨天');
    expect(formatRelativeDay('2026-10-22', '2026-10-24')).toBe('前天');
    expect(formatRelativeDay('2026-10-25', '2026-10-24')).toBe('明天');
    expect(formatRelativeDay('2026-10-26', '2026-10-24')).toBe('后天');
    expect(formatRelativeDay('2026-10-20', '2026-10-24')).toBe('10月20日');
    expect(formatRelativeDay('2025-10-20', '2026-10-24')).toBe('2025年10月20日');
  });

  it('formatWeekTitle 同月 / 跨月 / 跨年三档（M1 区间写法，不用「第 N 周」）', () => {
    expect(formatWeekTitle('2026-10-19', '2026-10-25')).toBe('10月19日 – 25日');
    expect(formatWeekTitle('2026-10-26', '2026-11-01')).toBe('10月26日 – 11月1日');
    expect(formatWeekTitle('2026-09-28', '2026-10-04')).toBe('9月28日 – 10月4日');
    expect(formatWeekTitle('2026-12-28', '2027-01-03')).toBe('2026年12月28日 – 2027年1月3日');
  });

  it('formatTime：null → 随时', () => {
    expect(formatTime('09:00')).toBe('09:00');
    expect(formatTime(null)).toBe('随时');
  });

  it('weekdayLabels 与 buildWeekDays 同源', () => {
    expect(weekdayLabels(1)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    const days = buildWeekDays('2026-10-21', 1);
    days.forEach((key, i) => {
      const wd = parseDateKey(key).getDay();
      expect(weekdayLabels(1)[(wd + 6) % 7]).toBe(['一', '二', '三', '四', '五', '六', '日'][i]);
    });
  });

  it('nowIso 是合法 ISO', () => {
    expect(Number.isNaN(Date.parse(nowIso()))).toBe(false);
  });
});
