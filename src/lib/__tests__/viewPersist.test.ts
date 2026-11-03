import { describe, expect, it } from 'vitest';
import { migrate } from '../storage';
import { SCHEMA_VERSION } from '../../constants';

/* ============================================================================
   视图记忆：新增视图必须进白名单，回收站必须不进

   两个方向都会出事故：
   - 漏加 'focus' → 用户切到专注页，刷新后弹回今日（"怎么又跳回去了"）
   - 多加 'trash' → 用户清完回收站关掉应用，下次打开直接落在回收站（"我数据没了？"）
   ========================================================================= */

function payloadWith(lastView: string, defaultView = 'today') {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: '2026-10-26T10:00:00.000Z',
    tasks: [],
    settings: { lastView, defaultView },
    diary: [],
    tombstones: [],
    focusSessions: [],
  };
}

describe('lastView 持久化白名单', () => {
  it('focus 能被记住（新加的视图必须进白名单）', () => {
    expect(migrate(payloadWith('focus'))?.settings.lastView).toBe('focus');
  });

  it('trash 不被记住，回落默认视图', () => {
    expect(migrate(payloadWith('trash'))?.settings.lastView).toBe('today');
  });

  it('老的四档照旧', () => {
    for (const view of ['today', 'week', 'calendar', 'diary', 'settings']) {
      expect(migrate(payloadWith(view))?.settings.lastView).toBe(view);
    }
  });

  it('defaultView 同样认 focus、不认 trash', () => {
    expect(migrate(payloadWith('today', 'focus'))?.settings.defaultView).toBe('focus');
    expect(migrate(payloadWith('today', 'trash'))?.settings.defaultView).toBe('today');
  });

  it('乱填的视图回落默认，不抛异常', () => {
    expect(migrate(payloadWith('nope'))?.settings.lastView).toBe('today');
  });

  /**
   * 复习会话（`review`）与回收站同款处理：**故意不进白名单**。
   * 记住它 = 用户下次冷启动直接落在复习页（那天可能一张卡都不该复习），
   * 看起来就像"应用打开了但什么都没有"。
   */
  it('review 不被记住，回落默认视图', () => {
    expect(migrate(payloadWith('review'))?.settings.lastView).toBe('today');
  });

  it('defaultView 同样不认 review', () => {
    expect(migrate(payloadWith('today', 'review'))?.settings.defaultView).toBe('today');
  });
});
