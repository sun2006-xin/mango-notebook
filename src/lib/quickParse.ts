import { addDays } from './date';
import { clampEstimateMinutes } from './task';
import type { DateKey, Priority, Repeat, TimeKey } from '../types';

/* ============================================================================
   自然语言速记（滴答清单 / Todoist 的那一手）

   输入 `明天9点 高数第3章 p1 30分钟 #学习` →
     { title: '高数第3章', date: 明天, time: '09:00', priority: 'high',
       estimatedMinutes: 30, repeat: 'none', category: '学习' }

   设计原则（比"能解析"更重要）：**宁可少解析，绝不吞字**。
   ① 按固定顺序逐段匹配、匹配到就从文本里摘掉，最后剩下的才是标题；
   ② 摘完之后标题为空 → **整串当标题**、所有字段作废（用户可能就想打 "p1"）；
   ③ 任何一段解析失败都不抛异常，退化成"没写"。

   纯函数：`today` 由调用方传入（视图不读时钟是本项目纪律）。
   ========================================================================= */

export interface QuickParsed {
  title: string;
  date: DateKey | null;
  time: TimeKey | null;
  priority: Priority | null;
  /** 0 = 没写估时 */
  estimatedMinutes: number;
  repeat: Repeat | null;
  /** 分类名（`#学习` → 学习）；null = 没写 */
  category: string | null;
}

const WEEKDAY: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 从某个 dateKey 往后（含当天）最近的一个星期 w；得到的就是 dateKey */
function nextWeekdayKey(today: DateKey, w: number): DateKey {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const base = new Date(year, month - 1, day);
  const delta = (w - base.getDay() + 7) % 7;
  return addDays(today, delta);
}

/** 从文本里摘掉匹配片段（用空格占位，避免把两个词粘在一起） */
function cut(text: string, matched: string): string {
  const index = text.indexOf(matched);
  if (index < 0) return text;
  return `${text.slice(0, index)} ${text.slice(index + matched.length)}`;
}

export function parseQuickAdd(input: string, today: DateKey): QuickParsed {
  const raw = typeof input === 'string' ? input.trim() : '';
  const empty: QuickParsed = {
    title: raw,
    date: null,
    time: null,
    priority: null,
    estimatedMinutes: 0,
    repeat: null,
    category: null,
  };
  if (!raw) return empty;

  let text = raw;
  let date: DateKey | null = null;
  let time: TimeKey | null = null;
  let priority: Priority | null = null;
  let estimatedMinutes = 0;
  let repeat: Repeat | null = null;
  let category: string | null = null;

  /* 1) 重复：每天 / 每周三 */
  const weekly = text.match(/每(?:周|星期)([一二三四五六日天])/);
  if (weekly) {
    const w = WEEKDAY[weekly[1]];
    if (typeof w === 'number') {
      repeat = 'weekly';
      date = nextWeekdayKey(today, w);
      text = cut(text, weekly[0]);
    }
  }
  if (!repeat) {
    const daily = text.match(/每(?:天|日)/);
    if (daily) {
      repeat = 'daily';
      date = today;
      text = cut(text, daily[0]);
    }
  }

  /* 2) 日期：今天 / 明天 / 后天 / 大后天 / 10月28日 / 10/28 */
  if (!date) {
    const relative = text.match(/大后天|后天|明天|今天/);
    if (relative) {
      const offsets: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
      const delta = offsets[relative[0]];
      if (typeof delta === 'number') {
        date = addDays(today, delta);
        text = cut(text, relative[0]);
      }
    }
  }
  if (!date) {
    const cn = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
    const slash = text.match(/(\d{1,2})\/(\d{1,2})/);
    const hit = cn ?? slash;
    if (hit) {
      const month = Number(hit[1]);
      const day = Number(hit[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const year = Number(today.slice(0, 4));
        date = `${year}-${pad2(month)}-${pad2(day)}`;
        text = cut(text, hit[0]);
      }
    }
  }

  /* 3) 时间：9:30 / 9点 / 9点半 / 9点15 / 21点 */
  if (!time) {
    const colon = text.match(/(\d{1,2})[:：](\d{2})/);
    if (colon) {
      const h = Number(colon[1]);
      const m = Number(colon[2]);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        time = `${pad2(h)}:${pad2(m)}`;
        text = cut(text, colon[0]);
      }
    }
  }
  if (!time) {
    const cn = text.match(/(\d{1,2})点(半|\d{1,2}分?)?/);
    if (cn) {
      const h = Number(cn[1]);
      if (h >= 0 && h <= 23) {
        let m = 0;
        if (cn[2] === '半') m = 30;
        else if (cn[2]) m = Math.min(59, Number(cn[2].replace(/[分]/g, '')) || 0);
        time = `${pad2(h)}:${pad2(m)}`;
        text = cut(text, cn[0]);
      }
    }
  }

  /* 4) 优先级：p1 / p2 / p3（前后要有边界，避免把 "p10" 里的 p1 吃掉） */
  const prio = text.match(/(?:^|[\s#])p([123])(?=$|[\s])/i);
  if (prio) {
    priority = prio[1] === '1' ? 'high' : prio[1] === '2' ? 'medium' : 'low';
    text = cut(text, `p${prio[1]}`);
  }

  /* 5) 估时：30分钟 / 1小时 / 1.5h */
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|h|H)/);
  if (hours) {
    estimatedMinutes = clampEstimateMinutes(Math.round(Number(hours[1]) * 60));
    text = cut(text, hours[0]);
  } else {
    const minutes = text.match(/(\d{1,4})\s*(?:分钟|min)/i);
    if (minutes) {
      estimatedMinutes = clampEstimateMinutes(Number(minutes[1]));
      text = cut(text, minutes[0]);
    }
  }

  /* 6) 分类：#学习 */
  const tag = text.match(/#(\S+)/);
  if (tag) {
    category = tag[1];
    text = cut(text, tag[0]);
  }

  /* 7) 剩下的才是标题。空 → 整串回退（绝不吞字） */
  const title = text.replace(/\s+/g, ' ').trim();
  if (!title) return empty;

  return { title, date, time, priority, estimatedMinutes, repeat, category };
}
