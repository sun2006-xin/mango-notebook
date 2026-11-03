import { useCallback, useMemo, useState } from 'react';
import { Icon } from '../common/Icon';
import { FALLBACK_CATEGORY_NAME, TOAST_TIMEOUT } from '../../constants';
import { useToast } from '../../hooks/useToast';
import { countByCategory } from '../../lib/task';
import { useAppDispatch, useAppState } from '../../store/StoreContext';

/* ============================================================================
   分类管理 —— 设置页里的一块

   从 SettingsView.tsx 搬出来的理由：三个处理器（新增 / 重命名 / 删除）+
   一份草稿状态 + 列表渲染，只依赖 `settings.categories` 与 dispatch，
   与页面上其它 1400 行没有任何耦合。搬出来之后"分类删除为什么归入其他"
   这种问题在一个文件里就能读完。

   重命名是**受控失败**的写法：DOM 里的值先改掉，校验不过再写回去
   （`input.value = currentName`）—— 所以这里必须拿到真实 input 元素，
   不能只靠 `value` 受控，否则用户敲了个重名，光标位置和内容会一起被 React 重置。
   ========================================================================= */

export function CategoriesEditor() {
  const { tasks, settings } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  const [draft, setDraft] = useState('');

  const counts = useMemo(
    () => countByCategory(tasks, null, settings.categories),
    [tasks, settings.categories],
  );

  const addCategory = useCallback(() => {
    const name = draft.trim();
    if (!name) return;
    if (settings.categories.some((c) => c.name === name)) {
      toast.show(`分类「${name}」已存在`, null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    dispatch({ type: 'CATEGORY_ADD', id: `c_${Date.now().toString(36)}`, name });
    setDraft('');
  }, [dispatch, draft, settings.categories, toast]);

  const commitRename = useCallback(
    (id: string, currentName: string, raw: string, input: HTMLInputElement) => {
      const name = raw.trim();
      if (!name || name === currentName) {
        input.value = currentName;
        return;
      }
      if (settings.categories.some((c) => c.id !== id && c.name === name)) {
        input.value = currentName;
        toast.show(`分类「${name}」已存在`, null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      dispatch({ type: 'CATEGORY_RENAME', id, name });
      toast.show(`已重命名为「${name}」，相关任务已同步`, null, TOAST_TIMEOUT.info);
    },
    [dispatch, settings.categories, toast],
  );

  const removeCategory = useCallback(
    (id: string, name: string) => {
      if (settings.categories.length <= 1) {
        toast.show('至少保留一个分类', null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      dispatch({ type: 'CATEGORY_REMOVE', id });
      toast.show(
        `已删除分类「${name}」，其任务归入「${FALLBACK_CATEGORY_NAME}」`,
        null,
        TOAST_TIMEOUT.info,
      );
    },
    [dispatch, settings.categories.length, toast],
  );

  return (
    <div className="border-b border-line py-4">
      <div className="text-body font-semibold">分类</div>
      <div className="mt-1 text-label text-ink-2">
        重命名会级联更新相关任务；删除后其任务归入「{FALLBACK_CATEGORY_NAME}」
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {settings.categories.map((category, index) => (
          <li
            key={`${category.id}:${category.name}`}
            data-cat-id={category.id}
            className="flex items-center gap-2"
          >
            <input
              defaultValue={category.name}
              aria-label={`分类 ${category.name} 名称`}
              maxLength={12}
              onBlur={(event) =>
                commitRename(category.id, category.name, event.target.value, event.target)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename(
                    category.id,
                    category.name,
                    event.currentTarget.value,
                    event.currentTarget,
                  );
                  event.currentTarget.blur();
                }
              }}
              className="h-11 min-w-0 flex-1 field px-3 text-body text-ink"
 />
 <span className="tnum w-14 shrink-0 text-right text-label text-ink-2">
              {counts[index]?.count ?? 0} 项
            </span>
            <button
              type="button"
              onClick={() => removeCategory(category.id, category.name)}
              aria-label={`删除分类 ${category.name}`}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-danger/10 hover:text-danger"
            >
              <Icon name="trash" size={15} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <input
          data-testid="cat-add-input"
          value={draft}
          maxLength={12}
          placeholder="新增分类名"
          aria-label="新增分类名"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addCategory();
            }
          }}
          className="h-11 min-w-0 flex-1 field px-3 text-body text-ink"
 />
 <button type="button" onClick={addCategory} className="btn btn-outlined shrink-0">
          添加分类
        </button>
      </div>
    </div>
  );
}
