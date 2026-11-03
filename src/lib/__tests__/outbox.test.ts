// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTBOX_KEY, OUTBOX_MAX_ENTRIES } from '../../constants';
import {
  clearOutbox,
  emptyOutbox,
  enqueueOutbox,
  getPendingCount,
  hasPendingOutbox,
  latestReason,
  pendingCount,
  readOutbox,
  recordUndelivered,
  sanitizeOutbox,
  writeOutbox,
} from '../outbox';

/* ============================================================================
   离线写入队列（⑦）
   ----------------------------------------------------------------------------
   这个队列不是"操作日志"，是"**还有东西没送达云端**"这件事的落盘凭据。
   所以测试集中在三件事上：
   ① 脏数据不能把队列变成炸弹（坏 JSON / 手改 / 旧格式 → 当空队列）；
   ② 折叠规则：同一段离线编辑不该刷出 20 条一模一样的记录，但顺序必须可靠；
   ③ 送达成功必须清干净（否则设置页永远挂着"N 条待上传"）。
   ========================================================================= */

const T = (seconds: number): string => new Date(Date.UTC(2026, 9, 24, 10, 0, seconds)).toISOString();

beforeEach(() => {
  localStorage.clear();
});

describe('sanitizeOutbox：脏数据一律降级，绝不抛', () => {
  it('合法队列原样保留', () => {
    const state = sanitizeOutbox({
      entries: [
        { at: T(0), reason: 'offline' },
        { at: T(30), reason: 'error' },
      ],
      dropped: 2,
    });
    expect(state.entries).toHaveLength(2);
    expect(state.dropped).toBe(2);
  });

  it('非对象 / 数组 / 字符串 → 空队列', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(sanitizeOutbox(raw)).toEqual(emptyOutbox());
    }
  });

  it('时间非法的条目被丢掉（它连"什么时候发生"都不知道了）', () => {
    const state = sanitizeOutbox({
      entries: [{ at: '不是时间', reason: 'offline' }, { at: T(0), reason: 'offline' }],
    });
    expect(state.entries).toEqual([{ at: T(0), reason: 'offline' }]);
  });

  it('reason 非法 → 回落 error（不丢条目：宁可疑，也别假装没发生）', () => {
    const state = sanitizeOutbox({ entries: [{ at: T(0), reason: '???' }] });
    expect(state.entries).toEqual([{ at: T(0), reason: 'error' }]);
  });

  it('乱序条目按时间重排（顺序是队列的语义，不能依赖写入顺序）', () => {
    const state = sanitizeOutbox({
      entries: [
        { at: T(30), reason: 'offline' },
        { at: T(0), reason: 'offline' },
      ],
    });
    expect(state.entries.map((e) => e.at)).toEqual([T(0), T(30)]);
  });

  it('超出上限的条目被截断（只留最近的 OUTBOX_MAX_ENTRIES 条）', () => {
    const entries = Array.from({ length: OUTBOX_MAX_ENTRIES + 5 }, (_, i) => ({
      at: T(i * 10),
      reason: 'offline' as const,
    }));
    const state = sanitizeOutbox({ entries });
    expect(state.entries).toHaveLength(OUTBOX_MAX_ENTRIES);
    expect(state.entries[state.entries.length - 1].at).toBe(T((OUTBOX_MAX_ENTRIES + 4) * 10));
  });

  it('dropped 非法（负数 / NaN）归零', () => {
    expect(sanitizeOutbox({ entries: [], dropped: -3 }).dropped).toBe(0);
    expect(sanitizeOutbox({ entries: [], dropped: '很多' }).dropped).toBe(0);
  });
});

describe('enqueueOutbox：入队与折叠', () => {
  it('第一次入队 → 一条', () => {
    const state = enqueueOutbox(emptyOutbox(), T(0), 'offline');
    expect(state.entries).toEqual([{ at: T(0), reason: 'offline' }]);
    expect(pendingCount(state)).toBe(1);
  });

  it('同原因、5 秒内 → 折叠成一条（时间推后）', () => {
    let state = enqueueOutbox(emptyOutbox(), T(0), 'offline');
    state = enqueueOutbox(state, T(2), 'offline');
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].at).toBe(T(2));
  });

  it('同原因但超过 5 秒 → 新的一条（离线太久就是两段经历）', () => {
    let state = enqueueOutbox(emptyOutbox(), T(0), 'offline');
    state = enqueueOutbox(state, T(30), 'offline');
    expect(state.entries).toHaveLength(2);
  });

  it('原因不同 → 立刻新起一条（离线→失败的切换是有意义的信息）', () => {
    let state = enqueueOutbox(emptyOutbox(), T(0), 'offline');
    state = enqueueOutbox(state, T(1), 'error');
    expect(state.entries.map((e) => e.reason)).toEqual(['offline', 'error']);
    expect(latestReason(state)).toBe('error');
  });

  it('超过上限：丢掉最旧的明细，但计入 dropped（"待上传"这个事实不能丢）', () => {
    let state = emptyOutbox();
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 3; i += 1) {
      // 每条间隔 10 秒，避免被折叠
      state = enqueueOutbox(state, T(i * 10), 'offline');
    }
    expect(state.entries).toHaveLength(OUTBOX_MAX_ENTRIES);
    expect(state.dropped).toBe(3);
    expect(pendingCount(state)).toBe(OUTBOX_MAX_ENTRIES + 3);
  });

  it('入队不修改原对象（纯函数：调用方可能还在用旧值）', () => {
    const base = emptyOutbox();
    enqueueOutbox(base, T(0), 'offline');
    expect(base.entries).toHaveLength(0);
  });
});

describe('设备本地读写', () => {
  it('写入后能读回来（刷新之后"还没送达"这件事还在）', () => {
    writeOutbox({ entries: [{ at: T(0), reason: 'offline' }], dropped: 0 });
    expect(getPendingCount()).toBe(1);
    expect(hasPendingOutbox()).toBe(true);
    expect(latestReason(readOutbox())).toBe('offline');
  });

  it('recordUndelivered 一步完成"读-入队-写"', () => {
    recordUndelivered(T(0), 'offline');
    recordUndelivered(T(60), 'error');
    expect(getPendingCount()).toBe(2);
  });

  it('清空之后回到"没有待上传"', () => {
    recordUndelivered(T(0), 'offline');
    clearOutbox();
    expect(hasPendingOutbox()).toBe(false);
    expect(getPendingCount()).toBe(0);
  });

  it('存的是坏 JSON → 当空队列，不抛（队列坏掉最多多同步一次）', () => {
    localStorage.setItem(OUTBOX_KEY, '{ 这不是 json');
    expect(readOutbox()).toEqual(emptyOutbox());
    expect(hasPendingOutbox()).toBe(false);
  });

  it('存储不可用（隐私模式 / 配额满）→ 静默降级，绝不影响保存链路', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeOutbox({ entries: [{ at: T(0), reason: 'offline' }], dropped: 0 })).not.toThrow();
    setItem.mockRestore();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readOutbox()).toEqual(emptyOutbox());
    getItem.mockRestore();
  });

  it('key 用常量，不散落字面量（换 key 只改一处）', () => {
    recordUndelivered(T(0), 'offline');
    expect(localStorage.getItem(OUTBOX_KEY)).toContain('offline');
  });
});
