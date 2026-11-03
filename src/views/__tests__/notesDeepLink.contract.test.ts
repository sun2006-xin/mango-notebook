import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   Q2 第 6 点：NotesView 深链 + App 搜索点击笔记的跳转

   本环境无法渲染 React，采用「源码级契约扫描」三处联动验证：
   - NotesView：openNoteId 变化 → 找到该 note 并打开；onOpenNoteConsumed 清理。
   - App：onSearchOpenNote → 关浮层 + SET_VIEW 'notes' + 设置 pendingOpenNoteId；
          NotesView 收到 openNoteId / onOpenNoteConsumed。
   - SearchOverlay：把 onOpenNote 接到了笔记结果按钮上。
   ========================================================================= */

describe('P0 源码级：NotesView 深链', () => {
  function read(): string {
    return readFileSync(new URL('../NotesView.tsx', import.meta.url), 'utf8');
  }

  it('openNoteId 变化 → 找到该 note 并打开', () => {
    const src = read();
    expect(src).toContain('openNoteId');
    expect(src).toContain("notesRef.current.find((n) => n.id === openNoteId)");
    expect(src).toContain('openRef.current(target)');
  });

  it('消费完成回调被调用（清理 pending）', () => {
    const src = read();
    expect(src).toContain('onOpenNoteConsumed?.()');
  });
});

describe('P0 源码级：App 搜索点击笔记 → 关浮层 + 切 notes 视图 + 传 openNoteId', () => {
  function read(): string {
    return readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  }

  it('onSearchOpenNote：关浮层 + 切到 notes 视图 + 记下待打开 note id', () => {
    const src = read();
    const idx = src.indexOf('const onSearchOpenNote = useCallback(');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, src.indexOf('}, [dispatch]);', idx));
    expect(block).toContain('setSearchOpen(false)');
    expect(block).toContain("dispatch({ type: 'SET_VIEW', view: 'notes' })");
    expect(block).toContain('setPendingOpenNoteId(id)');
  });

  it('NotesView 收到 openNoteId 与 onOpenNoteConsumed（用完清 pending）', () => {
    const src = read();
    expect(src).toContain('openNoteId={pendingOpenNoteId}');
    expect(src).toContain('onOpenNoteConsumed={() => setPendingOpenNoteId(null)}');
  });

  it('SearchOverlay 的 onOpenNote 接到了 onSearchOpenNote', () => {
    const src = read();
    expect(src).toContain('onOpenNote={onSearchOpenNote}');
  });
});

describe('P0 源码级：SearchOverlay 笔记结果触发 onOpenNote', () => {
  function read(): string {
    return readFileSync(new URL('../../components/common/SearchOverlay.tsx', import.meta.url), 'utf8');
  }

  it('点笔记结果 → onOpenNote(note.id)', () => {
    const src = read();
    expect(src).toContain('onClick={() => onOpenNote(note.id)}');
  });

  it('浮层渲染「记事本 · N」分区', () => {
    const src = read();
    expect(src).toContain('记事本 · {result.notes.length}');
  });
});
