import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   设置页「构造载荷」的三个回调，依赖数组必须齐全

   这是项目纪律「新增持久化字段要改四处 + 第五处监听依赖」的同类延伸：
   载荷是手抄的、依赖数组也是手抄的，两份代码天然会走岔。
   审查时实测发现三处漏项（都已修）：

   - `onExport`        漏 `notes`    → 导出的是进页面那一刻的记事快照
   - `onExportMarkdown` 漏 `settings` → 习惯/打卡/作息三章是旧的
                                       （习惯编辑器就嵌在设置页里，刚加完就导出必踩）
   - `onSyncClick`     漏 `notes`    → **丢数据**：导入备份后立刻点同步，
                                       推上去的仍是导入前的 notes，合并结果
                                       再 hydrate 回本机 → 刚导入的记事两头都没了

   这里不做"字符串全等"那种脆断言，而是抽出每个回调**真实的依赖数组**再查成员，
   这样将来调顺序、加别的依赖都不会误报。

   ---- 2026-10-31 重构：三处全部收敛成「依赖整份 state」 ----
   原来三个回调各自手写一份载荷、各自手写一份依赖数组，四份清单（3 份载荷 +
   3 份依赖）互相盯不住，漏项只能靠人工审查发现 —— 上面三条就是这么被翻出来的。
   现在载荷统一由 `buildBackupPayload(state)` / `buildPersistedPayload(state)` 造，
   依赖统一写 `[state, ...]`：**漏字段在结构上不可能发生**，
   这几条测试也从"逐字段点名"退化成"确认口径没被改回去"。
   ========================================================================= */

/**
 * `onExport` / `onExportMarkdown` 跟着「数据备份」整块搬进了
 * `components/settings/DataSection.tsx`；
 * `onSyncClick` 跟着「云同步」整块搬进了 `components/settings/CloudSection.tsx`。
 * 这个文件按"回调在哪个文件"分别扫描 —— 断言内容不变，只是换了张脸。
 */
const SRC = readFileSync(
  new URL('../../components/settings/DataSection.tsx', import.meta.url),
  'utf8',
);
const CLOUD = readFileSync(
  new URL('../../components/settings/CloudSection.tsx', import.meta.url),
  'utf8',
);

/**
 * 取出 `const <name> = useCallback(...)` 末尾的依赖数组原文。
 * 依赖数组的缩进是固定的（`\n  }, [`），比数括号可靠得多。
 */
function depsOf(name: string, src: string = SRC): string[] {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
  const depsStart = src.indexOf('\n  }, [', start);
  expect(depsStart, `${name} 的依赖数组没找到`).toBeGreaterThan(-1);
  const open = depsStart + '\n  }, ['.length;
  const close = src.indexOf(']);', open);
  const raw = src.slice(open, close);
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

/** 回调体（从 `const x = useCallback(` 到依赖数组之前） */
function bodyOf(name: string, src: string = SRC): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  const end = src.indexOf('\n  }, [', start);
  return src.slice(start, end);
}

describe('onExport（导出备份 JSON）：依赖整份 state，不再逐字段罗列', () => {
  const deps = depsOf('onExport');
  const body = bodyOf('onExport');

  /**
   * 从"逐个列六个字段"升级成"依赖整份 state"，与 `onSyncClick` 同一口径。
   *
   * 老写法要求依赖里出现 tasks/settings/diary/tombstones/focusSessions/notes
   * 六个名字 —— 而它已经漏过一次 `notes`：导出的是"进入设置页那一刻"的记事快照，
   * 记事本就在这一页旁边编辑，刚写完再导出，文件里没有那篇。
   * 六项依赖与六字段 payload 是两份代码，必然走岔；现在依赖一个 `state` 覆盖全部。
   */
  it('依赖里有整份 state（而不是逐字段罗列）', () => {
    expect(deps).toContain('state');
  });

  it('载荷来自唯一出口 buildBackupPayload(state)，不手抄对象字面量', () => {
    expect(body).toContain('buildBackupPayload(state)');
    // 手抄载荷的指纹：出现 schemaVersion / savedAt 字面量就说明又抄了一份
    expect(body).not.toContain('schemaVersion:');
    expect(body).not.toContain('savedAt:');
  });
});

describe('onExportMarkdown：同样依赖整份 state（习惯/打卡/作息都从 settings 上取）', () => {
  const deps = depsOf('onExportMarkdown');
  const body = bodyOf('onExportMarkdown');

  it('依赖里有整份 state', () => {
    expect(deps).toContain('state');
  });

  it('回调体确实从 state.settings 上取三项流水', () => {
    expect(body).toContain('habits: state.settings.habits');
    expect(body).toContain('habitChecks: state.settings.habitChecks');
    expect(body).toContain('sleepLog: state.settings.sleepLog');
  });

  it('其余四个集合也从 state 上取（不再裸引用闭包里的同名变量）', () => {
    for (const field of ['tasks', 'diary', 'notes', 'focusSessions']) {
      expect(body).toContain(`${field}: state.${field}`);
    }
  });
});

describe('onSyncClick（立即同步）：漏字段 = 反向清空刚导入的数据', () => {
  const deps = depsOf('onSyncClick', CLOUD);
  const body = bodyOf('onSyncClick', CLOUD);

  /**
   * v0.26 起这条契约从"逐个列字段"升级成"**依赖整份 state**"。
   *
   * 老写法要求把 tasks/settings/diary/tombstones/focusSessions/notes
   * 六个字段逐个写进依赖数组 —— 漏一个不报错、只在特定操作序列下丢数据
   * （漏 notes 就是"导入备份后立刻同步 → 刚导入的记事两头都没了"）。
   * 现在载荷由 `buildPersistedPayload(state)` 造、依赖里只放 `state`，
   * 任何持久化字段变化都会换掉回调引用 —— 漏字段在结构上不可能发生。
   */
  it('依赖里有整份 state（而不是逐字段罗列）', () => {
    expect(deps).toContain('state');
  });

  it('载荷来自唯一出口 buildPersistedPayload，不再手抄对象字面量', () => {
    expect(body).toContain('buildPersistedPayload(state');
    // 手抄载荷的指纹：出现 schemaVersion 字面量就说明又抄了一份
    expect(body).not.toContain('schemaVersion:');
  });

  it('savedAt 用本机真实落盘时间覆盖（新设备不能把空数据推上云端）', () => {
    expect(body).toContain('getLocalSavedAt()');
    expect(body).toContain('savedAt ?? undefined');
  });
});
