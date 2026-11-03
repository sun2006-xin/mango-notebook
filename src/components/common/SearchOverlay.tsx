import { useEffect, useMemo, useRef, useState } from 'react';
import { TEXT } from '../../constants';
import { formatDateTitle } from '../../lib/date';
import { stripMarkdown } from '../../lib/markdown';
import { countHits, searchAll } from '../../lib/search';
import type { DateKey, DiaryEntry, Note, Task } from '../../types';
import { Icon } from './Icon';

export interface SearchOverlayProps {
  open: boolean;
  tasks: Task[];
  diary: DiaryEntry[];
  /** 记事本（搜索扩展）：标题或正文命中 */
  notes: Note[];
  onClose: () => void;
  /** 点任务结果 → 打开该任务抽屉 */
  onOpenTask: (id: string) => void;
  /** 点日记结果 → 跳到日记视图并选中那天 */
  onOpenDiary: (date: DateKey) => void;
  /** 点记事结果 → 跳到记事本并打开该条 */
  onOpenNote: (id: string) => void;
}

/** ISO 时间戳 → 可读的「M月D日 HH:mm」 */
function formatNoteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 取纯文本前 2 行（去掉 Markdown 标记后），作为 React 文本节点渲染（防 XSS） */
function notePreview(content: string): string {
  const plain = stripMarkdown(content);
  if (!plain) return '';
  return plain.split('\n').slice(0, 2).join('\n');
}

/**
 * 全局搜索浮层：任务（标题 + 备注）、日记（正文）与记事本（标题 + 正文）一起搜。
 *
 * 为什么是浮层而不是一个独立 tab：搜索是"想到才用一下"的动作，
 * 单独占一个 tab 会让底部 5 个 tab 变成 6 个、且绝大多数时间空着。
 * Esc / 点遮罩关闭；打开时清空上次关键词并自动聚焦。
 */
export function SearchOverlay({
  open,
  tasks,
  diary,
  notes,
  onClose,
  onOpenTask,
  onOpenDiary,
  onOpenNote,
}: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即清空 + 聚焦；关闭不在这里动 query（避免收起动画里闪一下空态）
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Esc 关闭（浮层开着时不该让它去触发抽屉的 Esc 处理）
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const result = useMemo(() => searchAll(query, tasks, diary, notes), [query, tasks, diary, notes]);
  const total = countHits(result);
  const trimmed = query.trim();

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="搜索"
      data-testid="search-overlay"
      className="fixed inset-0 z-40 flex items-start justify-center bg-ink/20 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-content overflow-hidden rounded-lg border border-line bg-paper shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            data-testid="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={TEXT.searchPlaceholder}
            aria-label="搜索任务、日记和记事"
            className="h-12 min-w-0 flex-1 bg-transparent text-body text-ink outline-none"
          />
          <button
            type="button"
            data-testid="search-close"
            onClick={onClose}
            className="shrink-0 text-label text-ink-2 hover:text-ink"
          >
            关闭
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-2">
          {!trimmed ? (
            <p className="px-2 py-6 text-center text-label text-ink-2">{TEXT.searchHint}</p>
          ) : total === 0 ? (
            <p className="px-2 py-6 text-center text-label text-ink-2">
              {TEXT.emptySearch}「{trimmed}」{TEXT.emptySearchTail}
            </p>
          ) : (
            <>
              {result.tasks.length > 0 ? (
                <>
                  <div className="px-2 pt-1 text-label font-semibold tracking-[0.06em] text-ink-2">
                    任务 · {result.tasks.length}
                  </div>
                  <ul className="mt-1 flex flex-col">
                    {result.tasks.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          data-testid={`search-task-${task.id}`}
                          onClick={() => onOpenTask(task.id)}
                          className="w-full rounded-md px-2 py-2 text-left hover:bg-surface"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-body text-ink">{task.title}</span>
                            {task.done ? (
                              <span className="text-label text-ink-3">已完成</span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-label text-ink-3">{formatDateTitle(task.date)}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {result.diary.length > 0 ? (
                <>
                  <div className="mt-2 px-2 pt-1 text-label font-semibold tracking-[0.06em] text-ink-2">
                    日记 · {result.diary.length}
                  </div>
                  <ul className="mt-1 flex flex-col">
                    {result.diary.map((item) => (
                      <li key={item.date}>
                        <button
                          type="button"
                          data-testid={`search-diary-${item.date}`}
                          onClick={() => onOpenDiary(item.date)}
                          className="w-full rounded-md px-2 py-2 text-left hover:bg-surface"
                        >
                          <div className="text-label text-ink-3">{formatDateTitle(item.date)}</div>
                          <p className="mt-0.5 line-clamp-2 text-body text-ink">{item.content}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {result.notes.length > 0 ? (
                <>
                  <div className="mt-2 px-2 pt-1 text-label font-semibold tracking-[0.06em] text-ink-2">
                    记事本 · {result.notes.length}
                  </div>
                  <ul className="mt-1 flex flex-col">
                    {result.notes.map((note) => (
                      <li key={note.id}>
                        <button
                          type="button"
                          data-testid={`search-note-${note.id}`}
                          onClick={() => onOpenNote(note.id)}
                          className="w-full rounded-md px-2 py-2 text-left hover:bg-surface"
                        >
                          <div className="text-body font-semibold text-ink">
                            {note.title || '（无标题）'}
                          </div>
                          {notePreview(note.content) ? (
                            // 纯文本预览：作为 React 文本子节点渲染，绝不用 dangerouslySetInnerHTML（XSS 红线）
                            <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-body-sm text-ink-2">
                              {notePreview(note.content)}
                            </p>
                          ) : null}
                          <div className="mt-0.5 text-label text-ink-3">
                            {formatNoteTime(note.updatedAt)}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
