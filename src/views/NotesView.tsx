import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { useDebouncedCommit } from '../hooks/useDebouncedCommit';
import {
  AUTO_ENROLL_ON_CREATE,
  DEFAULT_NOTE_REMIND_TIME,
  TEXT,
  TIME_PATTERN,
  VIEW_META,
} from '../constants';
import type { DateKey, Note, NoteRemind } from '../types';
import { nowIso } from '../lib/date';
import { renderMarkdown, stripMarkdown } from '../lib/markdown';
import { isNoteDeleted } from '../lib/storage';
import { enroll, isCard, isDue, isNewCard, unenroll } from '../lib/srs';
import {
  createBlankNote,
  createMistakeNote,
  mistakeCaretIndex,
} from '../lib/noteTemplate';
import { TOAST_TIMEOUT } from '../constants';
import { Icon } from '../components/common/Icon';
import { useToast } from '../hooks/useToast';
import { compressImage } from '../lib/image';
import { Segmented } from '../components/common/Segmented';

/* ============================================================================
   记事本 —— 与日记的分工
   ----------------------------------------------------------------------------
   日记：按天组织，一天一篇，回答"今天过得怎样"。
   记事本：不绑日期，自由标题 + 分类，回答"我知道什么" ——
   配置片段、报错与解法、点子、考点。这些内容塞进某天的日记里，回头找不到。

   结构：左侧列表（置顶优先，按 updatedAt 倒序）+ 右侧编辑器。
   窄屏退化为单列：点列表项进编辑，返回键回列表。
   ========================================================================= */

const NOTE_TITLE_MAX = 120;
const NOTE_CONTENT_MAX = 20000;

function newNote(now: string): Note {
  return createBlankNote(crypto.randomUUID(), now);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface NotesViewProps {
  /** 当前真实今天（App 统一传入）：决定"新卡入队日"与"是否到期"的判定 */
  today: DateKey;
  /** 全局搜索深链：打开此 id 的记事（打开后由 onOpenNoteConsumed 清除） */
  openNoteId?: string | null;
  /** 深链消费完成回调（清掉 pending） */
  onOpenNoteConsumed?: () => void;
}

export function NotesView({ today, openNoteId, onOpenNoteConsumed }: NotesViewProps) {
  const { notes, settings } = useAppState();
  const dispatch = useAppDispatch();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'pinned' | string>('all');
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const contentRef = useRef<HTMLTextAreaElement>(null);

  /** 编辑中的记事（本地草稿，失焦/切走时落库；防抖见下） */
  const [draft, setDraft] = useState<Note | null>(null);

  /**
   * 正文 / 标题**防抖提交**（350ms）：只有它俩是"每键都写"的长文本。
   *
   * 分类、置顶、提醒、复习开关这类是**离散动作**，必须立刻落库 —— 它们走
   * `saveDraft`（立即 dispatch），并且会 `cancel()` 掉待提交的文本，
   * 否则 350ms 后那个旧快照会把"刚改的分类"覆盖回去。
   */
  const noteCommit = useDebouncedCommit<Note>({
    commit: (note) => dispatch({ type: 'NOTE_UPSERT', note, now: nowIso() }),
  });

  /**
   * 预览态的 HTML **必须** useMemo（与 DiaryView 同款理由）。
   *
   * 记事正文上限 NOTE_CONTENT_MAX（2 万字），`renderMarkdown` 是渲染期同步求值的 ——
   * 不缓存的话，预览模式下敲一个字就要把整篇重新解析一遍。
   */
  const previewHtml = useMemo(
    () => (preview ? renderMarkdown(draft?.content ?? '') : ''),
    [preview, draft?.content ?? ''],
  );

  const categories = settings.categories;

  /** 未被软删除的记事（content 为空的空壳 = 已删除，用户视角等于没有） */
  const alive = useMemo(() => notes.filter((note) => !isNoteDeleted(note)), [notes]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes.filter((note) => {
      // 软删除的空壳不显示；但**正在编辑的那条例外** —— 刚点「新建」还没打字
      // 时它也是空内容，直接过滤掉会让用户以为没建出来。
      if (isNoteDeleted(note) && note.id !== selectedId) return false;
      if (filter === 'pinned' && !note.pinned) return false;
      if (filter !== 'all' && filter !== 'pinned' && note.category !== filter) return false;
      if (!q) return true;
      return (
        note.title.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q)
      );
    });
  }, [notes, query, filter, selectedId]);

  /**
   * 列表每行的"显示用摘要"提前算好：分类名 + 正文首段纯文本。
   *
   * 原来在 JSX 里对每行做 `categories.find`（线性）×1 和 `stripMarkdown` ×2 ——
   * 60 条 × 1500 字实测约 1.9ms/次渲染，100 条 × 2000 字约 3.8ms。
   * 这些内容只在 note 或分类变化时才需要变，没必要每次渲染重算。
   * 索引化之后 `find` 也一并消失。
   *
   * ⚠️ 输入正文时仍会重算（`notes` 换了新数组），真正的解法是把"每键 dispatch"
   * 改成防抖提交 —— 见 docs/REVIEW-2026-10-31.md 的待办，不是这里能顺手改的。
   */
  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const rows = useMemo(
    () =>
      visible.map((note) => ({
        note,
        /**
         * 分类名的兜底：记事里 category 存的是分类 id，但**错题模板**写的是
         * 分类名「错题」（刻意的，见 lib/noteTemplate.ts）。匹配不到就把原值
         * 当"自定义分类"显示 —— 否则一条错题笔记在列表里看不出它是什么分类。
         */
        catLabel: categoryById.get(note.category)?.name ?? note.category,
        previewText: stripMarkdown(note.content),
      })),
    [visible, categoryById],
  );

  const selected = useMemo(
    () => (selectedId ? (draft && draft.id === selectedId ? draft : notes.find((n) => n.id === selectedId) ?? null) : null),
    [selectedId, draft, notes],
  );

  const open = useCallback(
    (note: Note) => {
      /**
       * 切换前**必须 flush**：待提交的正文是"上一条"的，
       * 不送出去就等于用户敲完最后一句立刻点另一条 → 那几个字永远丢了。
       */
      noteCommit.flush();
      setSelectedId(note.id);
      setDraft(note);
      setConfirmDelete(false);
      setPreview(false);
    },
    [noteCommit],
  );

  // 深链：openNoteId 变化时，找最新 notes 里那条并打开；
  // 用 ref 取最新 notes / open，避免闭包拿到旧引用（open 的依赖是空数组，本身稳定）。
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!openNoteId) return;
    const target = notesRef.current.find((n) => n.id === openNoteId);
    if (target) openRef.current(target);
    onOpenNoteConsumed?.();
  }, [openNoteId, onOpenNoteConsumed]);

  const create = useCallback(() => {
    const now = nowIso();
    const note = newNote(now);
    /**
     * 新建时**默认不入队**（AUTO_ENROLL_ON_CREATE = false）。
     * 记事本里大部分是配置片段 / 点子，自动全变成复习卡会把队列灌满噪音。
     * 要复习就在编辑器里点「加入复习」—— 显式动作，用户知道自己在安排什么。
     */
    const created = AUTO_ENROLL_ON_CREATE ? enroll(note, today, now) : note;
    dispatch({ type: 'NOTE_UPSERT', note: created, now });
    setSelectedId(created.id);
    setDraft(created);
    setPreview(false);
    setConfirmDelete(false);
    // 等编辑器挂出来再聚焦标题
    setTimeout(() => titleRef.current?.focus(), 50);
  }, [dispatch, today]);

  /**
   * 「记错题」：模板 + 分类 + **自动入复习**，一次点击全部就位。
   *
   * 为什么值得单独开一个入口：手写错题的固定动作是
   * "新建 → 打四个小标题 → 点加入复习"，三步里漏掉任何一步，这条错题
   * 就永远不会回到复习队列（记了但不背 = 没记）。
   *
   * 走的是同一个 `NOTE_UPSERT`（**没有新增 reducer action**）：
   * 新建和对现有记事点「加入复习」本来就是同一条数据路径。
   */
  const createMistake = useCallback(() => {
    const now = nowIso();
    const created = createMistakeNote(crypto.randomUUID(), now, today);
    dispatch({ type: 'NOTE_UPSERT', note: created, now });
    setSelectedId(created.id);
    setDraft(created);
    setPreview(false);
    setConfirmDelete(false);
    /**
     * 光标落在「## 题目」之后：用户点完这个按钮的第一件事就是写题目，
     * 再让他自己挪光标就会出现"在模板标题前面开始打字"的惨案。
     * 用 setTimeout 而不是 rAF：等 textarea 挂载完（与 create 的聚焦同一套时序）。
     */
    setTimeout(() => {
      const editor = contentRef.current;
      if (!editor) return;
      const caret = mistakeCaretIndex(created.content);
      editor.focus();
      editor.setSelectionRange(caret, caret);
    }, 50);
  }, [dispatch, today]);

  /**
   * 立即保存（离散动作专用）。
   *
   * ⚠️ 先 cancel：`next` 里已经带着最新的正文（调用方从 draft 拼的），
   * 若让待提交的旧快照再跑一次，就会把这次改动盖掉。
   */
  const saveDraft = useCallback(
    (next: Note) => {
      noteCommit.cancel();
      setDraft(next);
      dispatch({ type: 'NOTE_UPSERT', note: next, now: nowIso() });
    },
    [dispatch, noteCommit],
  );

  /** 输入态保存：立刻更新本地草稿（光标不跳），落库交给防抖 */
  const saveTyping = useCallback(
    (next: Note) => {
      setDraft(next);
      noteCommit.schedule(next);
    },
    [noteCommit],
  );

  /* ---------- 插入图片（F4 错题拍照） ---------- */

  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageBusy, setImageBusy] = useState(false);

  /**
   * 拍/选一张纸质错题，压缩后插进正文。
   *
   * 三道闸，都是为了防止"插图把存储撑爆"：
   * ① canvas 压缩（长边 1024 / q0.72，通常 80–150 KB）；
   * ② 单图上限 300 KB，超了直接拒绝（而不是压完才发现）；
   * ③ 失败一律只提示、不改草稿 —— 插图失败绝不能影响记笔记本身。
   */
  const onPickImage = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !draft) return;
      /**
       * ⚠️ 记下"是哪一条"，但**不能**在 await 之后继续用闭包里的 `draft`。
       *
       * 压缩一张 1024 长边的图要几百毫秒，这段时间用户完全可能：
       * ① 继续在正文里打字 —— 用旧快照拼回去，刚打的那段直接消失；
       * ② 点列表切到另一条 —— 此时 `draft` 还指着旧记事，之后每次输入
       *    都会被 `onContent` 写进**旧那条**，等于把 A 的正文写进 B。
       * 两者都不报错、不打日志，只在事后发现"字少了"或"两条串了"。
       * 所以：先记 id，await 回来再用**最新**的那一条拼。
       */
      const noteId = draft.id;
      setImageBusy(true);
      try {
        const compressed = await compressImage(file);
        if (!compressed) {
          toast.show('这张图读不出来，换一张试试', null, TOAST_TIMEOUT.info, 'warn');
          return;
        }
        if (compressed.bytes > 300 * 1024) {
          toast.show('图片压完还是太大（超过 300 KB），拍小一点或裁一下', null, TOAST_TIMEOUT.error, 'warn');
          return;
        }
        const kb = Math.round(compressed.bytes / 1024);
        /**
         * ⚠️ 压缩那几百毫秒里用户可能继续打字，而那些字还在防抖队列里。
         * 先 flush，再读 store —— 否则拼出来的正文缺最后几个字，插入图片会把它覆盖掉。
         */
        noteCommit.flush();
        const latest = notesRef.current.find((item) => item.id === noteId);
        if (!latest) {
          // 压缩期间这条记事被删了：不写回，避免把墓碑里的东西复活
          toast.show('这条记事已经不在了，图片没有插入', null, TOAST_TIMEOUT.info, 'warn');
          return;
        }
        const next: Note = {
          ...latest,
          content: `${latest.content.trimEnd()}\n\n![错题](${compressed.dataUrl})\n`,
        };
        dispatch({ type: 'NOTE_UPSERT', note: next, now: nowIso() });
        // 只在用户还停在这一条时刷新编辑区；已经切走了就别把他拽回来
        setDraft((cur) => (cur && cur.id === noteId ? next : cur));
        toast.show(`图片已插入（约 ${kb} KB），已存在本机`, null, TOAST_TIMEOUT.info);
      } finally {
        setImageBusy(false);
      }
    },
    [dispatch, draft, toast],
  );

  const onTitle = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!draft) return;
      saveTyping({ ...draft, title: e.target.value.slice(0, NOTE_TITLE_MAX) });
    },
    [draft, saveTyping],
  );

  const onContent = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      if (!draft) return;
      saveTyping({ ...draft, content: e.target.value.slice(0, NOTE_CONTENT_MAX) });
    },
    [draft, saveTyping],
  );

  const onCategory = useCallback(
    (id: string) => {
      if (!draft) return;
      saveDraft({ ...draft, category: id });
    },
    [draft, saveDraft],
  );

  const onPin = useCallback(() => {
    if (!draft) return;
    saveDraft({ ...draft, pinned: !draft.pinned });
  }, [draft, saveDraft]);

  /**
   * 「加入复习」开关（F1 的唯一入口，主理人裁定：显式开关，不自动入队）。
   *
   * 关掉时走 `unenroll` —— 它是**删掉 sr 键**，不是把它置 undefined/null：
   * "有没有 sr 键"就是"它是不是卡片"的判据，留着键等于没退出。
   * 两种动作都复用 NOTE_UPSERT，不新增 reducer action。
   */
  const onToggleReview = useCallback(() => {
    if (!draft) return;
    const now = nowIso();
    const next = isCard(draft) ? unenroll(draft, now) : enroll(draft, today, now);
    saveDraft(next);
  }, [draft, saveDraft, today]);

  const onDelete = useCallback(() => {
    if (!draft) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    /**
     * 软删除：reducer 只把 content 置空并打时间戳，条目仍留在载荷里 ——
     * 这条空壳是"它被删过"的唯一凭据，必须能同步到别的设备，
     * 否则一台还留着正文的设备一合并，删掉的记事就复活了。
     */
    // 删除前 cancel：否则 350ms 后定时器到点，又把内容写回一条已删的记录
    noteCommit.cancel();
    dispatch({ type: 'NOTE_DELETE', id: draft.id, now: nowIso() });
    setSelectedId(null);
    setDraft(null);
    setConfirmDelete(false);
  }, [confirmDelete, dispatch, draft]);

  /* ---------- 闹钟（笔记提醒，不进复习队列） ---------- */

  /**
   * 开关：有 remind 键 ↔ 没有。
   *
   * 关掉时**删掉这个键**（解构 + 还原），不是置 null ——
   * "有没有 remind 键"就是"有没有闹钟"的判据，留着键会得到一个空闹钟。
   * 与 srs.ts::unenroll 对 sr 的处理完全同款。
   *
   * 走 `saveDraft` → `NOTE_UPSERT`，会刷 `updatedAt`：这是**对的**，
   * 闹钟设置本身就是业务数据（要同步到另外两台设备）。
   * （对比：到点响铃时绝对不能写 Note，见 hooks/useNoteReminders.ts。）
   */
  const onToggleRemind = useCallback(() => {
    if (!draft) return;
    if (draft.remind) {
      const { remind, ...rest } = draft;
      void remind;
      saveDraft({ ...rest });
      return;
    }
    saveDraft({ ...draft, remind: { at: DEFAULT_NOTE_REMIND_TIME, repeat: 'none' } });
  }, [draft, saveDraft]);

  const onRemindAt = useCallback(
    (value: string) => {
      if (!draft?.remind) return;
      // <input type="time"> 被清空时给的是 ''；非法值不落库（否则会把闹钟写坏）
      if (!TIME_PATTERN.test(value)) return;
      saveDraft({ ...draft, remind: { ...draft.remind, at: value } });
    },
    [draft, saveDraft],
  );

  const onRemindRepeat = useCallback(
    (repeat: NoteRemind['repeat']) => {
      if (!draft?.remind) return;
      saveDraft({ ...draft, remind: { ...draft.remind, repeat } });
    },
    [draft, saveDraft],
  );

  const close = useCallback(() => {
    setSelectedId(null);
    setDraft(null);
    setConfirmDelete(false);
  }, []);

  /* ---------- 列表 ---------- */
  const list = (
    <div className={selected ? 'hidden md:block md:w-72 md:shrink-0' : 'w-full'}>
      {/*
        头部两行：① 标题 + 两个按钮 ② 说明文字。
        以前是「标题+说明」一列、按钮一列挤在一行里：左列只有 288px，
        两个按钮占掉近 200px，说明文字被压到 80px 宽、硬换行成三行
        （截图里"配置片段 / 报错 / 解法、点子，都 / 放这里"）。
        说明单独占一行就能整句横排。
      */}
      <div className="mb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-h2 font-bold">记事本</div>
          <div className="flex shrink-0 items-center gap-2">
          {/* 「记错题」与「新建」并列：新建是空白的，记错题是带模板的 */}
          <button
            type="button"
            data-testid="note-create-mistake"
            onClick={createMistake}
            title="预填错题模板并加入复习"
            className="btn btn-outlined shrink-0"
          >
            <Icon name="book" size={16} className="shrink-0" />
            {TEXT.noteMistake}
          </button>
          <button type="button" data-testid="note-create" onClick={create} className="btn btn-primary shrink-0">
            <Icon name="plus" size={16} className="shrink-0" />
            新建
            </button>
          </div>
        </div>
        <div className="mt-1 text-label text-ink-2">
          {alive.length > 0 ? `${alive.length} 条 · 不绑日期，随手记` : '配置片段、报错解法、点子，都放这里'}
        </div>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜标题或内容"
            aria-label="搜索记事"
            className="h-10 w-full field pl-8 pr-3 text-body-sm text-ink "
 />
 </div>
 </div>
 <div className="mb-3">
        <Segmented
          ariaLabel="按分类筛选记事"
          value={filter}
          onChange={(v) => setFilter(v)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'pinned', label: '置顶' },
            ...categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-8 text-center text-body-sm text-ink-3">
          {alive.length === 0 ? '还没有记事，点「新建」记一条' : '没有匹配的记事'}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ note, catLabel, previewText }) => {
            return (
              <li key={note.id}>
                <button
                  type="button"
                  data-testid={`note-item-${note.id}`}
                  onClick={() => open(note)}
                  className={`row-hover w-full rounded-md border px-3 py-2.5 text-left ${
                    selectedId === note.id ? 'border-accent/40 bg-accent-soft' : 'border-line bg-surface'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {note.pinned ? <span className="text-label text-highlight" aria-label="已置顶">★</span> : null}
                    <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink">
                      {note.title || '（无标题）'}
                    </span>
                    {/* 复习状态小标：到期 > 已入队（新卡） > 已排期 */}
                    {isCard(note) ? (
                      <span
                        data-testid={`note-review-badge-${note.id}`}
                        className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-label text-accent"
                      >
                        {isDue(note, today)
                          ? TEXT.reviewDueBadge
                          : isNewCard(note)
                            ? TEXT.reviewJoined
                            : TEXT.reviewScheduled}
                      </span>
                    ) : null}
                    {catLabel ? (
                      <span className="chip shrink-0">
                        {catLabel}
                      </span>
                    ) : null}
                    {/* 闹钟标记：`07:30 每天` —— 与复习徽章并列（两者可以同时存在） */}
                    {note.remind ? (
                      <span
                        data-testid={`note-remind-badge-${note.id}`}
                        className="tnum flex shrink-0 items-center gap-1 rounded-full bg-surface-sunk px-2 py-0.5 text-label text-ink-2"
                        aria-label={`${TEXT.remindAtLabel} ${note.remind.at} ${
                          note.remind.repeat === 'daily' ? TEXT.remindDaily : TEXT.remindOnce
                        }`}
                      >
                        <Icon name="bell" size={11} className="shrink-0" />
                        {note.remind.at}{' '}
                        {note.remind.repeat === 'daily' ? TEXT.remindDaily : TEXT.remindOnce}
                      </span>
                    ) : null}
                  </div>
                  {previewText ? (
                    <p className="mt-1 line-clamp-2 text-body-sm leading-relaxed text-ink-2">
                      {previewText}
                    </p>
                  ) : null}
                  <p className="mt-1 text-label text-ink-3">{formatDate(note.updatedAt)}</p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  /* ---------- 编辑器 ---------- */
  const editor = draft ? (
    <div className="min-w-0 flex-1">
      {/*
        ⚠️ 顶部这一行**只放操作按钮**。
        以前时间戳在这里且是 flex-1：桌面端没有"返回"按钮时它独占整行左侧，
        于是"10月29日 13:38"孤零零飘在页面中间、和左列的搜索框平齐 ——
        视觉上像是排版错位（用户报的"排布是乱的"就是这个）。
        时间戳属于"这条笔记的元信息"，应该紧贴标题。
      */}
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={close} className="btn btn-text shrink-0 md:hidden">
          <Icon name="chevron-left" size={16} className="shrink-0" />
          返回
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onPin}
            aria-pressed={draft.pinned}
            title={draft.pinned ? '取消置顶' : '置顶'}
            className={`btn px-2.5 ${draft.pinned ? 'btn-primary' : 'btn-outlined'}`}
          >
            <span className={draft.pinned ? 'text-highlight' : ''}>★</span>
            {draft.pinned ? '已置顶' : '置顶'}
          </button>
          <button
            type="button"
            data-testid="note-delete"
            onClick={onDelete}
            className={`btn ${confirmDelete ? 'btn-danger' : 'btn-outlined text-danger'}`}
          >
            {confirmDelete ? '确认删除？再点一次' : '删除'}
          </button>
        </div>
      </div>

      {/* 标题：给一条下边框，让它读起来是"标题"而不是一行散落的字 */}
      <input
        ref={titleRef}
        type="text"
        value={draft.title}
        onChange={onTitle}
        placeholder="标题"
        aria-label="记事标题"
        className="w-full border-b border-line bg-transparent px-0.5 pb-1 text-h2 font-bold text-ink placeholder:font-normal focus:border-accent focus:outline-none"
      />

      {/* 元信息：紧贴标题，不再浮在页面中间 */}
      <div className="mb-3 mt-1.5 text-label text-ink-3">{formatDate(draft.updatedAt)}</div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          value={draft.category}
          onChange={(e) => onCategory(e.target.value)}
          aria-label="记事分类"
          className="h-9 field px-2 text-body-sm text-ink "
 >
 <option value="">未分类</option>
 {categories.map((c) => (
 <option key={c.id} value={c.id}>{c.name}</option>
 ))}
 {/* 错题模板写的是分类名「错题」，而 settings.categories 里**可能没有**同名分类
 （刻意不静默新增分类，见 lib/noteTemplate.ts）。这里把它当"自定义分类"
 显式渲染出来，否则下拉框会因为 value 匹配不到任何 option 而看起来是空的。 */}
 {draft.category && !categories.some((c) => c.id === draft.category) ? (
 <option value={draft.category}>
 {draft.category}（{TEXT.noteCustomCategory}）
 </option>
 ) : null}
 </select>
 <Segmented
 ariaLabel="切换编辑或预览"
 value={preview ? 'preview' : 'edit'}
 onChange={(v) => setPreview(v === 'preview')}
 options={[
 { value: 'edit', label: '编辑' },
 { value: 'preview', label: '预览' },
 ]}
 />
 {/* 插图片（F4）：拍纸质错题，压缩后内嵌进正文，不上传任何地方 */}
 <button
 type="button"
 data-testid="note-image"
 onClick={() => imageInputRef.current?.click()}
 disabled={imageBusy}
 className="btn btn-outlined shrink-0 px-2.5 disabled:opacity-50"
          title="插入图片（会先压缩到长边 1024）"
        >
          <Icon name="image" size={14} className="shrink-0" />
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => void onPickImage(event)}
        />
        <button
          type="button"
          data-testid="note-review-toggle"
          aria-pressed={isCard(draft)}
          title={TEXT.reviewJoinHint}
          onClick={onToggleReview}
          className={`btn shrink-0 px-2.5 ${isCard(draft) ? 'btn-tonal' : 'btn-outlined'}`}
        >
          <Icon name="book" size={14} className="shrink-0" />
          {isCard(draft) ? TEXT.reviewJoined : TEXT.reviewJoin}
        </button>
      </div>

      {/* ---------- 闹钟（到点响铃，但**不进复习队列**） ----------
          「要不要背」和「要不要提醒我」是两件事：刷牙提醒不是知识点，
          进度条与复习队列都不该被它污染。任何修改都走 NOTE_UPSERT。 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="note-remind-toggle"
          aria-pressed={Boolean(draft.remind)}
          title={TEXT.remindHint}
          onClick={onToggleRemind}
          className={`btn shrink-0 px-2.5 ${draft.remind ? 'btn-tonal' : 'btn-outlined'}`}
        >
          <Icon name="bell" size={14} className="shrink-0" />
          {draft.remind ? TEXT.remindOn : TEXT.remindTitle}
        </button>
        {draft.remind ? (
          <>
            <input
              type="time"
              data-testid="note-remind-at"
              aria-label={TEXT.remindAtLabel}
              value={draft.remind.at}
              onChange={(e) => onRemindAt(e.target.value)}
              className="tnum h-9 field px-2 text-body-sm text-ink "
 />
 <Segmented
 ariaLabel={TEXT.remindTitle}
 variant="plain"
 value={draft.remind.repeat}
 onChange={onRemindRepeat}
 options={[
 { value: 'none', label: TEXT.remindOnce },
 { value: 'daily', label: TEXT.remindDaily },
 ]}
 />
 </>
 ) : null}
 <span className="text-label text-ink-3">{TEXT.remindHint}</span>
      </div>

      {preview ? (
        // renderMarkdown 内部**先转义再渲染**，输出里不可能出现用户写的标签（防 XSS）
        <div
          data-testid="note-preview"
          className="diary-md min-h-64 field px-4 py-3"
 dangerouslySetInnerHTML={{ __html: previewHtml }}
 />
 ) : (
 <textarea
 ref={contentRef}
 data-testid="note-editor"
 value={draft.content}
 onChange={onContent}
 placeholder={'记点什么…\n\n支持 Markdown：# 标题、**粗体**、- 列表、`代码`'}
 rows={14}
 className="w-full resize-y field px-3 py-2.5 text-body leading-relaxed text-ink "
 />
 )}
 <p className="mt-2 text-label text-ink-3">
        自动保存 · {draft.content.length}/{NOTE_CONTENT_MAX} 字
      </p>
    </div>
  ) : null;

  return (
    <section aria-labelledby="notesTitle" className="flex flex-col">
      <h1 id="notesTitle" className="sr-only">{VIEW_META.notes.label}</h1>
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        {list}
        {selected ? editor : null}
      </div>
    </section>
  );
}
