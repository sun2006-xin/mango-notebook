# -*- coding: utf-8 -*-
"""
变异测试（项目铁律）：
把每处修复改回缺陷态，确认对应的守护用例**确实变红**。
一个从不变红的测试等于没有测试。

运行：python scripts/mutate.py
"""
import re
import signal
import subprocess
import sys
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# 正在被改动的那一处（用于信号兜底还原）。
# 曾经踩过：跑到一半被 Ctrl+C / 超时杀掉，变异留在源码里就退出了 ——
# 下一次跑脚本时锚点"找不到"（其实是被自己改没了），全量还会莫名挂一条。
# 被杀时没有 finally，只能靠信号处理器兜底。
PENDING: list[tuple[Path, str]] = []


def _restore_pending(*_args):
    for path, original in PENDING:
        path.write_text(original, encoding="utf-8")
    if PENDING:
        print("\n!! 被中断，已还原：", ", ".join(str(p) for p, _ in PENDING))
    PENDING.clear()
    sys.exit(130)


def plain(text):
    """vitest 默认带 ANSI 颜色，先把转义序列剥掉再解析"""
    return ANSI.sub("", text or "")

ROOT = Path(__file__).resolve().parent.parent

# (名字, 文件, 原文, 变异后, 目标测试文件, 期望失败数下限)
CASES = [
    (
        "M1 行内渲染不转义（XSS 复现）",
        "src/lib/markdown.ts",
        "  let out = escapeHtml(raw);",
        "  let out = raw;",
        "src/lib/__tests__/markdown.test.ts",
        3,
    ),
    (
        "M2 清空数据时漏掉专注记录",
        "src/store/domains/lifecycle.ts",
        "        focusSessions: [],\n        settings: { ...fresh, theme: state.settings.theme },",
        "        settings: { ...fresh, theme: state.settings.theme },",
        "src/store/__tests__/focusReducer.test.ts",
        1,
    ),
    (
        "M3 去掉子任务向上汇总",
        "src/lib/task.ts",
        "    if (parent && parent.done !== allDone) {",
        "    if (false && parent && parent.done !== allDone) {",
        "src/lib/__tests__/subtask.test.ts",
        2,
    ),
    (
        "M4 子任务也进顶层列表（会重复渲染）",
        "src/lib/task.ts",
        "  const topLevel = dayTasks.filter((t) => !t.parentId);",
        "  const topLevel = dayTasks;",
        "src/lib/__tests__/subtask.test.ts",
        1,
    ),
    (
        "M5 时长改回采信 durationMs",
        "src/lib/focus.ts",
        "  const ms = end - start;",
        "  const ms = Number(session.durationMs);",
        "src/lib/__tests__/focus.test.ts",
        1,
    ),
    (
        "M6 自动保存漏监听 focusSessions",
        "src/hooks/usePersist.ts",
        "state.focusSessions",
        "[]",
        "src/hooks/__tests__/persistDeps.test.ts",
        1,
    ),
    (
        "M7 HYDRATE 忽略传入的墓碑",
        "src/store/domains/lifecycle.ts",
        "        tombstones: action.tombstones ?? state.tombstones,",
        "        tombstones: state.tombstones,",
        "src/store/__tests__/focusReducer.test.ts",
        1,
    ),
    (
        "M8 日界不夹紧范围",
        "src/store/domains/settings.ts",
        "        ? Math.min(DAY_START_MAX, Math.max(0, Math.trunc(action.hour)))",
        "        ? Math.trunc(action.hour)",
        "src/store/__tests__/focusReducer.test.ts",
        1,
    ),
    (
        "M9 自动同步不把云端内容交回本机（同步不管用的原样复现）",
        "src/lib/cloudSync.ts",
        "      mergeHandler?.(outcome.payload);",
        "      void outcome.payload;",
        "src/lib/__tests__/autoSync.test.ts",
        1,
    ),
    (
        "M10 失败提示不节流（老弹没权限的原样复现）",
        "src/lib/cloudSync.ts",
        "  if (!force && now - (lastNotifiedAt.get(message) ?? 0) < ERROR_NOTIFY_COOLDOWN_MS) return;",
        "  if (false && !force) return;",
        "src/lib/__tests__/autoSync.test.ts",
        1,
    ),
    (
        "M11 连续失败不停摆（每次保存都撞墙）",
        "src/lib/cloudSync.ts",
        "        autoSyncPaused = true;",
        "        autoSyncPaused = false;",
        "src/lib/__tests__/autoSync.test.ts",
        2,
    ),
    (
        "M12 后台合并抢走用户正在看的页面（60s 一次被拽走视图）",
        "src/App.tsx",
        "lastView: viewRef.current",
        "lastView: migrated.settings.lastView",
        "src/lib/__tests__/autoSync.test.ts",
        1,
    ),
    (
        "M13 导出把回收站里的记事也带出来",
        "src/lib/exportMarkdown.ts",
        "  return listOf(notes).filter((note) => note && !isNoteDeleted(note));",
        "  return listOf(notes).filter((note) => note);",
        "src/lib/__tests__/exportMarkdown.test.ts",
        1,
    ),
    (
        "M14 导入备份改回 JSON.parse + migrate（选什么都照单全收）",
        # 2026-10-31：整块搬到 components/settings/DataSection.tsx（契约测试同步改了扫描目标）
        "src/components/settings/DataSection.tsx",
        "        const payload = parseBackupJson(text);",
        "        const payload = migrate(JSON.parse(text) as unknown);",
        "src/views/__tests__/importBackup.contract.test.ts",
        1,
    ),
    # ── v0.25 批次：移动端热区 / 渲染稳定性 / 跨标签页计时 ────────────────
    (
        "M15 导航按钮热区缩回 36px（手机上点不中的原样复现）",
        "src/components/layout/Nav.tsx",
        "grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink",
        "grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink",
        "src/components/__tests__/touchTarget.contract.test.ts",
        1,
    ),
    (
        "M16 toggleTask 把 tasks 写回依赖（勾一个框整列表重渲）",
        "src/hooks/useTaskActions.ts",
        "    [dispatch, today, toast],",
        "    [dispatch, today, toast, tasks],",
        "src/hooks/__tests__/renderStability.contract.test.ts",
        1,
    ),
    (
        "M17 WeekView 行上改回内联箭头函数（memo 失效）",
        "src/views/WeekView.tsx",
        "onToggle={rowHandlers.get(task.id)?.toggle ?? NOOP}",
        "onToggle={() => actions.toggleTask(task.id)}",
        "src/hooks/__tests__/renderStability.contract.test.ts",
        2,
    ),
    (
        "M18 日记预览改回渲染期现场求值（每次按键重渲整棵树）",
        "src/views/DiaryView.tsx",
        "dangerouslySetInnerHTML={{ __html: previewHtml }}",
        "dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}",
        "src/hooks/__tests__/renderStability.contract.test.ts",
        1,
    ),
    (
        "M19 别的 key 也当成计时器变动（无事生非地让位）",
        "src/hooks/useTimerOwnership.ts",
        "      if (event.key !== FOCUS_RUNNING_KEY) return;",
        "      void event.key;",
        "src/hooks/__tests__/useTimerOwnership.dom.test.tsx",
        1,
    ),
    (
        "M20 idle 状态也被别的标签页拽着让位",
        "src/hooks/useTimerOwnership.ts",
        "      if (!current.active) return;",
        "      void current.active;",
        "src/hooks/__tests__/useTimerOwnership.dom.test.tsx",
        1,
    ),
    (
        "M21 运行态被清掉误判成「有人接管」（提示语说反）",
        "src/hooks/useTimerOwnership.ts",
        "      if (incomingId === null) {",
        "      if (false) {",
        "src/hooks/__tests__/useTimerOwnership.dom.test.tsx",
        2,
    ),
    # ── v0.26 批次：快捷键 / 回顾趋势 / 载荷唯一出口 ─────────────────────
    (
        "M22 打字时也响应快捷键（在日记里写 n 光标被弹走）",
        "src/hooks/useHotkeys.ts",
        "  if (input.typing) return null;",
        "  if (false && input.typing) return null;",
        "src/hooks/__tests__/useHotkeys.dom.test.tsx",
        2,
    ),
    (
        "M23 抢走 Ctrl/Cmd 组合键（浏览器地盘）",
        "src/hooks/useHotkeys.ts",
        "  if (input.ctrlKey || input.metaKey || input.altKey) return null;",
        "  if (false && (input.ctrlKey || input.metaKey || input.altKey)) return null;",
        "src/hooks/__tests__/useHotkeys.dom.test.tsx",
        3,
    ),
    (
        "M24 同步载荷丢了 savedAt 覆盖（新设备把云端清空）",
        # 2026-10-31：onSyncClick 已搬进 components/settings/CloudSection.tsx
        "src/components/settings/CloudSection.tsx",
        "        : buildPersistedPayload(state, savedAt ?? undefined);",
        "        : buildPersistedPayload(state);",
        "src/views/__tests__/settingsDeps.contract.test.ts",
        1,
    ),
    (
        "M25 一天有任务就画趋势图（空槽图没信息还占地方）",
        "src/lib/recap.ts",
        "  return points.filter((point) => point.total > 0).length >= 2;",
        "  return points.filter((point) => point.total > 0).length >= 1;",
        "src/lib/__tests__/recap.test.ts",
        1,
    ),
    # ── v0.27 批次：云同步字段级 LWW / 离线写入队列 ──────────────────────
    (
        "M26 字段级合并退化成「永远本机赢」（对端的改动全丢）",
        "src/lib/merge.ts",
        "    const useLocal = toMillis(localClock) >= toMillis(remoteClock);",
        "    const useLocal = true;",
        "src/lib/__tests__/mergeFieldLevel.test.ts",
        3,
    ),
    (
        "M27 缺字段时钟时回落 updatedAt（会偷走对端没改过的字段）",
        "src/lib/fieldClock.ts",
        "  return task.createdAt;",
        "  return task.updatedAt;",
        "src/lib/__tests__/mergeFieldLevel.test.ts",
        3,
    ),
    (
        "M28 reducer 收尾不打点（字段级合并退化成整条 LWW）",
        "src/store/reducer.ts",
        "  return next === state ? next : withFieldClocks(state, next);",
        "  return next;",
        "src/store/__tests__/fieldClock.test.ts",
        5,
    ),
    (
        "M29 sanitizeTasks 丢掉字段时钟（逐字段重建的经典漏项）",
        "src/lib/sanitize.ts",
        "      ...(fieldAt ? { fieldAt } : {}),\n",
        "",
        "src/lib/__tests__/mergeFieldLevel.test.ts",
        2,
    ),
    (
        "M30 一侧没有时钟也走字段级（拿不到信息时靠猜，照样丢改动）",
        "src/lib/merge.ts",
        "  if (!local.fieldAt || !remote.fieldAt) {",
        "  if (!local.fieldAt && !remote.fieldAt) {",
        "src/lib/__tests__/mergeFieldLevel.test.ts",
        1,
    ),
    # ── v0.27 批次：离线写入队列 ────────────────────────────────────────────
    (
        "M31 网络恢复不解除停摆（明明连得上却同步不了，⑦ 的原症状）",
        "src/hooks/useAutoSync.ts",
        "    const onOnline = (): void => {\n      resumeAutoSync();\n      tick();\n    };",
        "    const onOnline = (): void => {\n      tick();\n    };",
        "src/hooks/__tests__/useAutoSync.dom.test.tsx",
        1,
    ),
    (
        "M32 离线也去撞墙（地铁里待 3 分钟就把自动同步试到停摆）",
        "src/lib/cloudSync.ts",
        "  if (isBrowserOffline()) return null;\n  const now = Date.now();",
        "  const now = Date.now();",
        "src/lib/__tests__/offlineQueue.runtime.test.ts",
        2,
    ),
    (
        "M33 送达成功也不清队列（设置页永远挂着「N 条待上传」）",
        "src/lib/cloudSync.ts",
        "    // 送达成功 → 待上传队列清空（这是\"确实送到了\"的唯一凭据，别在别处提前清）\n    clearOutbox();\n",
        "",
        "src/lib/__tests__/offlineQueue.runtime.test.ts",
        1,
    ),
    (
        "M34 离线的改动不落盘（刷新之后彻底忘了还没上传）",
        "src/lib/cloudSync.ts",
        "  if (isBrowserOffline()) {\n    markUndelivered(payload, 'offline');",
        "  if (isBrowserOffline()) {\n    void payload;",
        "src/lib/__tests__/offlineQueue.runtime.test.ts",
        1,
    ),
    # ── v0.28 批次：长期迭代（习惯→任务 / 自动周报 / 任务拆解）──────────────
    (
        "M35 习惯派任务不看流水（每天重复派，删掉还长回来）",
        "src/lib/habits.ts",
        "    if (logged.has(habit.id)) continue;",
        "    // mutated",
        "src/lib/__tests__/habits.test.ts",
        1,
    ),
    (
        "M36 习惯派任务不看开关（不请自来地往用户清单里塞任务）",
        "src/lib/habits.ts",
        "    if (habit.autoTask !== true) continue;",
        "    // mutated",
        "src/lib/__tests__/habits.test.ts",
        1,
    ),
    (
        "M37 派了任务却不记流水（下次启动再派一遍，一天两条「背单词」）",
        "src/store/domains/tasks.ts",
        "          habitTaskLog: sanitizeHabitTaskLog(\n            [...state.settings.habitTaskLog, ...fresh],\n            state.settings.habits,\n          ),",
        "          habitTaskLog: state.settings.habitTaskLog,",
        "src/store/__tests__/longTerm.test.ts",
        2,
    ),
    (
        "M38 合并生成流水不排序（每次冷启动都以为数组变了，白写盘 + 白推送）",
        "src/lib/habits.ts",
        "  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));",
        "  // mutated",
        "src/lib/__tests__/habits.test.ts",
        1,
    ),
    (
        "M39 空周只看专注时长（只勾任务没开计时的人被判成空周，周报永远不生成）",
        "src/lib/weekly.ts",
        "  if (stats.focusMs === 0 && stats.doneCount === 0 && stats.reviewedCount === 0) {",
        "  if (stats.focusMs === 0) {",
        "src/lib/__tests__/weeklyAutoReport.test.ts",
        1,
    ),
    (
        "M40 自动周报去结本周（周三就宣布这周的成绩 = 编造）",
        "src/lib/weekly.ts",
        "    weekOffset: -1,",
        "    weekOffset: 0,",
        "src/lib/__tests__/weeklyAutoReport.test.ts",
        2,
    ),
    (
        "M41 不看目标日已有的周报（每开一次应用就重写一遍，用户的修改被抹掉）",
        "src/lib/weekly.ts",
        "  if (typeof target?.content === 'string' && target.content.includes(TEXT.weeklyMarker)) {",
        "  if (false as boolean) {",
        "src/lib/__tests__/weeklyAutoReport.test.ts",
        1,
    ),
    (
        "M42 自动周报覆盖整篇日记（把用户那天写的字吃掉）",
        "src/hooks/useWeeklyAutoReport.ts",
        "      existing?.content ?? '',",
        "      '',",
        "src/hooks/__tests__/longTermAuto.dom.test.tsx",
        1,
    ),
    (
        "M43 already-written 不记流水（每次启动重新检查，删掉后又被写回）",
        "src/hooks/useWeeklyAutoReport.ts",
        "      if (plan.reason === 'already-written') {",
        "      if (false as boolean) {",
        "src/hooks/__tests__/longTermAuto.dom.test.tsx",
        1,
    ),
    (
        "M44 拆出来的步骤漏 parentId（清单里多出几条散任务）",
        "src/hooks/useTaskActions.ts",
        "          dispatch({ type: 'TASK_ADD', task: { ...child, parentId: id } });",
        "          dispatch({ type: 'TASK_ADD', task: child });",
        "src/hooks/__tests__/breakdownTask.dom.test.tsx",
        1,
    ),
    (
        "M45 拆解不去重（连点两次出两份步骤）",
        "src/hooks/useTaskActions.ts",
        "      const steps = plan.steps.filter((step) => !existing.has(step.title));",
        "      const steps = plan.steps;",
        "src/hooks/__tests__/breakdownTask.dom.test.tsx",
        2,
    ),
    (
        "M46 sanitizeSettings 漏了周报流水（老载荷读回来 undefined，hook 里 .includes 当场抛）",
        "src/lib/sanitize.ts",
        "    weeklyReportLog: sanitizeWeeklyReportLog(rec.weeklyReportLog),",
        "    // mutated",
        "src/store/__tests__/longTerm.test.ts",
        1,
    ),
    (
        "M48 习惯开关不参与幂等比较（「每天生成任务」点了完全没反应）",
        "src/store/domains/habits.ts",
        "  return sameRows(a, b);",
        "  const strip = (list) => list.map(({ autoTask, ...rest }) => rest);\n  return sameRows(strip(a), strip(b));",
        "src/store/__tests__/fieldCoverage.contract.test.ts",
        2,
    ),
    (
        "M49 删习惯不清生成流水（孤儿记录跟着云同步来回传，永远删不干净）",
        "src/store/domains/habits.ts",
        "      const habitTaskLog = state.settings.habitTaskLog.filter((entry) => alive.has(entry.habitId));",
        "      const habitTaskLog = state.settings.habitTaskLog;",
        "src/store/__tests__/longTerm.test.ts",
        1,
    ),
    (
        "M47 周报开关写成 === true（所有老用户的自动周报被静默关掉）",
        "src/lib/sanitize.ts",
        "    weeklyAutoReport: rec.weeklyAutoReport !== false,",
        "    weeklyAutoReport: rec.weeklyAutoReport === true,",
        "src/store/__tests__/longTerm.test.ts",
        1,
    ),
    (
        "M50 sameFields 只遍历左侧键（对侧多出来的字段永远发现不了）",
        "src/lib/equal.ts",
        "  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);",
        "  const keys = new Set(Object.keys(left));",
        "src/lib/__tests__/equal.test.ts",
        2,
    ),
    (
        "M51 sameRows 不比长度（列表少一条/多一条判成没变）",
        "src/lib/equal.ts",
        "  if (left.length !== right.length) return false;",
        "  if (left.length !== right.length) return true;",
        "src/lib/__tests__/equal.test.ts",
        1,
    ),
    (
        "M52 集合比较漏掉版本戳（那一组改动永远同步不出去）",
        "src/lib/equal.ts",
        "    if (!left.byKey.has(key) || left.byKey.get(key) !== stamp) return false;",
        "    if (!left.byKey.has(key)) return false;",
        "src/lib/__tests__/equal.test.ts",
        2,
    ),
    (
        "M53 备份载荷漏 notes（导出再导入，记事全部消失）",
        "src/lib/storage.ts",
        "    notes,\n  };\n}",
        "  };\n}",
        "src/lib/__tests__/backup.test.ts",
        2,
    ),
    (
        "M54 snapshotDiffers 漏掉墓碑（删除不同步：一边删了，另一边还在）",
        "src/lib/syncDecision.ts",
        "    !sameSet(IDENTITY_SPECS.tombstones, a.tombstones, b.tombstones) ||",
        "    false ||",
        "src/store/__tests__/fieldCoverage.contract.test.ts",
        1,
    ),
    (
        "M56 分类只剩一个也允许删（任务无处归类，全被塞进「其他」）",
        "src/components/settings/CategoriesEditor.tsx",
        "      if (settings.categories.length <= 1) {",
        "      if (false) {",
        "src/components/settings/__tests__/goalsCategories.dom.test.tsx",
        1,
    ),
    (
        "M57 目标不去重（连点两下造两条一样的，列表里出现重复项）",
        "src/components/settings/GoalsEditor.tsx",
        "    if (settings.goals.some((goal) => goal.name === name && goal.date === draftDate)) {",
        "    if (false) {",
        "src/components/settings/__tests__/goalsCategories.dom.test.tsx",
        1,
    ),
    (
        "M58 设置行漏渲染说明（那一行比邻居矮一截，整列看着没对齐）",
        "src/components/settings/SettingRow.tsx",
        "        {hint ? <div className=\"mt-1 text-label text-ink-2\">{hint}</div> : null}",
        "        {null}",
        "src/components/settings/__tests__/settingRow.dom.test.tsx",
        1,
    ),
    # ── 第三批拆文件（云 / 数据两块）新长出来的两条出口 ──────────────────
    (
        "M59 useHydrateFrom 手抄 HYDRATE（装回状态绕过唯一出口）",
        "src/hooks/useHydrateFrom.ts",
        "    dispatch(hydrateFromPayload(payload, null));",
        "    dispatch({ type: 'HYDRATE', tasks: payload.tasks } as never);",
        "src/views/__tests__/qaV08CrossModule.test.ts",
        1,
    ),
    (
        "M60 本地备份恢复前不写 pre-restore 兜底（点错了再也回不去）",
        "src/components/settings/DataSection.tsx",
        "        await writeDesktopBackup(JSON.stringify(snapshot), 'pre-restore.json');",
        "        await Promise.resolve();",
        "src/components/settings/__tests__/dataSection.contract.test.ts",
        1,
    ),
    # ── v0.29.2 审查修的一批埋藏缺陷 ────────────────────────────────
    (
        "M62 装载超时兜底仍允许写盘（空态把盘上真实数据整包覆盖）",
        "src/store/domains/lifecycle.ts",
        "          persistBlocked: action.persistBlocked === true,",
        "          persistBlocked: false,",
        "src/store/__tests__/storeBootstrap.test.ts",
        1,
    ),
    (
        "M63 自动同步不看「清空过本机」（60 秒后云端数据原样长回来）",
        "src/lib/cloudSync.ts",
        "    if (!manual && clearAutoSyncBlocked) return { status: 'unchanged' };",
        "    if (false) return { status: 'unchanged' };",
        "src/lib/__tests__/cloudSync.runtime.test.ts",
        1,
    ),
    (
        "M64 清空云端后自动同步照常推送（清空白做）",
        "src/lib/cloudSync.ts",
        "    if (!manual && autoPushPaused && (action === 'push-local' || action === 'merge')) {",
        "    if (false) {",
        "src/lib/__tests__/cloudSync.runtime.test.ts",
        1,
    ),
    (
        "M65 复习页数字键不拦默认行为（评一次级顺带把页面切走）",
        "src/views/ReviewView.tsx",
        "        event.preventDefault();\n        if (event.key === '1') rate('again');",
        "        if (event.key === '1') rate('again');",
        "src/views/__tests__/reviewKeys.contract.test.ts",
        1,
    ),
    (
        "M61 恢复先 hydrate 再写快照（存下去的是恢复后的数据，退不回去）",
        "src/components/settings/DataSection.tsx",
        """        const snapshot = buildBackupPayload(state);
        await writeDesktopBackup(JSON.stringify(snapshot), 'pre-restore.json');
        // ⚠️ 唯一装载入口：绝不手抄 HYDRATE（见 store/reducer.ts 的说明）
        hydrateFrom(payload);""",
        """        hydrateFrom(payload);
        const snapshot = buildBackupPayload(state);
        await writeDesktopBackup(JSON.stringify(snapshot), 'pre-restore.json');""",
        "src/components/settings/__tests__/dataSection.contract.test.ts",
        1,
    ),
    # ── v0.29.3 今日页首屏重排 ──────────────────────────────────────
    (
        "M66 概览条默认展开（四块辅助信息把清单顶到第二屏）",
        "src/views/TodayView.tsx",
        "  const [briefOpen, setBriefOpen] = useState(false);",
        "  const [briefOpen, setBriefOpen] = useState(true);",
        "src/views/__tests__/todayFirstScreen.contract.test.ts",
        1,
    ),
    (
        "M67 逾期区不限条数（攒一周欠账就能占掉半屏）",
        "src/components/task/OverdueSection.tsx",
        "  const LIMIT = 3;",
        "  const LIMIT = 999;",
        "src/views/__tests__/todayFirstScreen.contract.test.ts",
        1,
    ),
    # ── v0.29.4 设计系统收敛 ─────────────────────────────────────────
    (
        "M68 确认按钮第一次点击就执行（危险操作没有二次确认）",
        "src/components/common/ConfirmButton.tsx",
        "    if (!armed) {",
        "    if (false) {",
        "src/components/common/__tests__/ConfirmButton.dom.test.tsx",
        1,
    ),
    (
        "M69 确认态永不自动收回（很久以后误点一下就执行）",
        "src/components/common/ConfirmButton.tsx",
        "        setArmed(false);\n      }, timeoutMs);",
        "        void 0;\n      }, timeoutMs);",
        "src/components/common/__tests__/ConfirmButton.dom.test.tsx",
        1,
    ),
    (
        "M70 卡片三件套又抄回组件（改一次圆角要满仓库找）",
        "src/components/task/DailyRecapCard.tsx",
        'className="mb-4 card px-4 py-3"',
        'className="mb-4 rounded-lg border border-line bg-surface px-4 py-3"',
        "src/__tests__/designSystem.contract.test.ts",
        1,
    ),
    # ── v0.29.5 信息层级 / 更新 URL ─────────────────────────────────
    (
        "M71 更新清单 URL 又用 ? 硬拼（sharecode 被污染成 403，报「未联网」）",
        "src/lib/update.ts",
        "fetch(appendParam(MANIFEST_URL, 't', String(Date.now())), {",
        "fetch(`${MANIFEST_URL}?t=${Date.now()}`, {",
        "src/lib/__tests__/updateUrl.test.ts",
        1,
    ),
    (
        "M72 底部栏改回 7 个（每格 55px，字都在挤）",
        "src/components/layout/Nav.tsx",
        "{TAB_VIEWS.map((id) => {",
        "{VIEW_ORDER.map((id) => {",
        "src/views/__tests__/infoArchitecture.contract.test.ts",
        1,
    ),
    (
        "M73 统计卡改回竖排三张（光这三张就占掉半屏）",
        "src/views/SettingsView.tsx",
        'className="mt-4 grid grid-cols-3 gap-2"',
        'className="mt-4 grid grid-cols-1 gap-2"',
        "src/views/__tests__/infoArchitecture.contract.test.ts",
        1,
    ),
    (
        "M74 分组又多默认展开一组（折叠就白做了）",
        "src/views/SettingsView.tsx",
        '          testId="settings-group-habits"',
        '          defaultOpen\n          testId="settings-group-habits"',
        "src/views/__tests__/infoArchitecture.contract.test.ts",
        1,
    ),
    # ── v0.29.6 工程化审查修的隐藏缺陷 ──────────────────────────────
    (
        "M75 原生端同步写又冒充成功（切后台那次编辑只留在镜像，重启即丢）",
        "src/lib/storage.ts",
        "  if (isNativeStorage()) return null;\n  const ls = getLocalStorage();",
        "  if (false) return null;\n  const ls = getLocalStorage();",
        "src/lib/__tests__/storage.native.test.ts",
        1,
    ),
    (
        "M76 TASK_PATCH 不校验日期（清空日期框 → 任务从所有视图消失 + 逾期显示 NaN）",
        "src/store/helpers.ts",
        "  if ('date' in next && !isValidDateKey(String(next.date ?? ''))) delete next.date;",
        "  if (false) delete next.date;",
        "src/store/__tests__/patchSanitize.test.ts",
        1,
    ),
    (
        "M77 周报流水用长度判重（满 60 周后新的一周永远记不进去）",
        "src/store/domains/settings.ts",
        """      if (state.settings.weeklyReportLog.includes(action.startKey)) return state;
      const log = sanitizeWeeklyReportLog([...state.settings.weeklyReportLog, action.startKey]);
      return patchSettings(state, { weeklyReportLog: log });""",
        """      const log = sanitizeWeeklyReportLog([...state.settings.weeklyReportLog, action.startKey]);
      if (log.length === state.settings.weeklyReportLog.length) return state;
      return patchSettings(state, { weeklyReportLog: log });""",
        "src/store/__tests__/longTerm.test.ts",
        1,
    ),
    (
        "M78 墓碑永不清理（回收站承诺 90 天自动清理却只增不减）",
        "src/lib/sanitize.ts",
        "  const kept = [...byId.values()].filter((stone) => toMillis(stone.deletedAt) >= cutoff);",
        "  const kept = [...byId.values()].filter(() => true);",
        "src/lib/__tests__/tombstoneSanitize.test.ts",
        1,
    ),
    # ── v0.29.6 拆 cloudSnapshot（IO 层）后新长出来的出口 ──────────────
    (
        "M79 并发首同不再合并（两台都首同步时，后到的整包盖掉对方）",
        "src/lib/cloudSnapshot.ts",
        "    const toWrite = raced.payload ? mergeSnapshots(payload, raced.payload) : payload;",
        "    const toWrite = payload;",
        "src/lib/__tests__/cloudSync.runtime.test.ts",
        1,
    ),
    (
        "M80 云端条数不再记录（本机为空时会把云端真实数据推成空）",
        "src/lib/cloudSnapshot.ts",
        "  noteRemoteCount(taskCountOf(row.payload));",
        "  void taskCountOf(row.payload);",
        "src/lib/__tests__/cloudSync.runtime.test.ts",
        1,
    ),
    # ── v0.29.7 体验/逻辑优化 ──────────────────────────────────────
    (
        "M81 自动备份失败也占当天名额（磁盘满一次，这天就再没备份）",
        "src/hooks/useAutoBackup.ts",
        "          if (ok) {\n            lastBackupDay = day;",
        "          if (true) {\n            lastBackupDay = day;",
        "src/hooks/__tests__/autoBackupRetry.dom.test.tsx",
        1,
    ),
    (
        "M82 兜底快照写失败仍继续恢复（用户以为有退路，其实没有）",
        "src/components/settings/DataSection.tsx",
        "        if (!snapshotWritten) {",
        "        if (false) {",
        "src/components/settings/__tests__/dataSection.contract.test.ts",
        1,
    ),
    # ── v0.29.8 契约转行为测试（新长出来的纯函数）────────────────────
    (
        "M83 没翻开就允许评级（会把没看过的卡评掉）",
        "src/lib/listSlice.ts",
        "  if (!revealed) return null;",
        "  if (false) return null;",
        "src/lib/__tests__/listSlice.test.ts",
        1,
    ),
    (
        "M84 溢出条数可以是负数（界面会写「还有 -1 条」）",
        "src/lib/listSlice.ts",
        "  const overflow = Math.max(0, items.length - safeLimit);",
        "  const overflow = items.length - safeLimit;",
        "src/lib/__tests__/listSlice.test.ts",
        1,
    ),
    (
        "M85 今日概览条默认展开（四块辅助信息又把清单顶下去）",
        "src/components/today/TodaySummary.tsx",
        "      {expanded ? <div className=\"summary-enter mt-1\">{children}</div> : null}",
        "      {true ? <div className=\"summary-enter mt-1\">{children}</div> : null}",
        "src/components/today/__tests__/TodaySummary.dom.test.tsx",
        1,
    ),
    (
        "M86 秒表不足 1 分钟也记录（几十秒的误触被算成一段专注）",
        "src/hooks/useStopwatch.ts",
        "    if (elapsed >= MIN_RECORD_MS) {",
        "    if (true) {",
        "src/hooks/__tests__/useStopwatch.dom.test.tsx",
        1,
    ),
    (
        "M87 提醒响过之后不清运行态（同一分钟里反复响）",
        "src/hooks/useReminderWatcher.ts",
        "      saveRunningTimer(null);",
        "      void 0;",
        "src/hooks/__tests__/reminderWatcher.dom.test.tsx",
        1,
    ),
    # ── v0.29.9 输入防抖 + 离线体验 ────────────────────────────────
    (
        "M88 防抖卸载时不补交（关抽屉 / 切记事丢掉最后几个字）",
        "src/hooks/useDebouncedCommit.ts",
        "      // 卸载时也要送 —— 切记事、关抽屉都走这条\n      flush();",
        "      // 卸载时不补交",
        "src/hooks/__tests__/useDebouncedCommit.dom.test.tsx",
        1,
    ),
    (
        "M89 flush 后既不清计时器也不清 pending（同一次输入提交两次，第二次把新值盖回去）",
        "src/hooks/useDebouncedCommit.ts",
        "  const flush = useCallback(() => {\n    clearTimer();\n    const item = pending.current;\n    pending.current = null;\n    if (item) commitRef.current(item.value);",
        "  const flush = useCallback(() => {\n    const item = pending.current;\n    if (item) commitRef.current(item.value);",
        "src/hooks/__tests__/useDebouncedCommit.dom.test.tsx",
        1,
    ),
    (
        "M90 关闭抽屉不补交（敲完最后一个字立刻关闭 → 那几个字永久丢失）",
        "src/components/task/TaskDrawer.tsx",
        "                onClick={closeWithFlush}",
        "                onClick={onClose}",
        "src/components/task/__tests__/taskDrawerEdit.dom.test.tsx",
        1,
    ),
    # ── v0.30.0 今日页派生数据（引用稳定 + 单次扫描）────────────────
    (
        "M91 派生数据不做缓存（每次 store 变化都重算，TaskList 的 memo 形同虚设）",
        "src/lib/dayView.ts",
        "  if (cache && sameKey(cache.key, key)) return cache.value;",
        "  if (false) return cache!.value;",
        "src/lib/__tests__/dayView.test.ts",
        1,
    ),
    (
        "M55 sameFields 永远判不同（幂等失效：每次编辑都多写一次盘、多推一次云）",
        "src/lib/equal.ts",
        "    if (!sameValue(left[key], right[key])) return false;\n  }\n  return true;",
        "    if (!sameValue(left[key], right[key])) return false;\n  }\n  return false;",
        "src/lib/__tests__/equal.test.ts",
        3,
    ),
]


# 单条变异的超时（秒）。超过就判定"这条挂死了"，继续下一条。
#
# 为什么需要：Windows 上 `npx vitest run <单文件>` 偶发不退出（同一个文件
# 重跑又好）。没有超时的话，一条卡住就把整轮拖死 —— 这一轮实测被拖了两次，
# 每次十几分钟，还分不清"是脚本坏了还是这条真的卡"。宁可标记 [HANG] 回头单独看，
# 也不要让 74 条里的一条绑架其余 73 条。
CASE_TIMEOUT_S = 150


def run(test_file, timeout=CASE_TIMEOUT_S):
    try:
        proc = subprocess.run(
            ["npx", "vitest", "run", test_file],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        # 挂死：不当作"抓到了"，也不当作"没抓到"，单独标记
        return -1, False, None
    out = plain((proc.stdout or "") + (proc.stderr or ""))
    failed = 0
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("Tests ") and "failed" in s:
            # 形如 "Tests  3 failed | 66 passed (69)"
            head = s[len("Tests "):].split("|")[0].strip()
            try:
                failed = int(head.split()[0])
            except (ValueError, IndexError):
                failed = 0
    passed_all = "Test Files  1 passed" in out or "no tests" in out
    return failed, passed_all, out


def selected_cases():
    """
    支持只跑指定的几条：`python scripts/mutate.py --only M46,M60-M74`

    为什么需要：整套 74 条要跑十几分钟，而 Windows 上偶尔会有一条 vitest
    挂死不退出（这一轮就踩了两次）。没有这个开关的话，只要一条卡住，
    后面的全都白等，还得分不清"是脚本坏了还是这条真的卡"。
    过滤之后可以先定位那一条，再单独重跑。
    """
    args = sys.argv[1:]
    if '--only' not in args:
        return CASES
    spec = args[args.index('--only') + 1]
    picked: list[str] = []
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part[1:]:
            head, tail = part.split('-', 1)
            picked.append((head.strip(), tail.strip()))
        else:
            picked.append((part, part))
    def code_of(name: str) -> str:
        return name.split(' ')[0]

    def split_code(code: str):
        """'M46' → ('M', 46)；解析不出数字就返回 (code, None)"""
        head = code.rstrip('0123456789')
        tail = code[len(head):]
        return head, (int(tail) if tail.isdigit() else None)

    out = []
    for case in CASES:
        code = code_of(case[0])
        c_head, c_num = split_code(code)
        for lo, hi in picked:
            l_head, l_num = split_code(lo)
            h_head, h_num = split_code(hi)
            # 区间：前缀相同且数字落在 [lo, hi]（M46-M74 要能匹配中间那些）
            if l_num is not None and h_num is not None:
                if c_head == l_head == h_head and l_num <= (c_num or -1) <= h_num:
                    out.append(case)
                    break
            # 单词：前缀匹配即可（'M5' 能带上 M50–M59，方便抽查一组）
            elif code.startswith(lo):
                out.append(case)
                break
    return out


def main():
    signal.signal(signal.SIGINT, _restore_pending)
    signal.signal(signal.SIGTERM, _restore_pending)
    ok = True
    cases = selected_cases()
    only_mode = len(cases) != len(CASES)
    if only_mode:
        print(f'（只跑 {len(cases)} 条：' + ', '.join(c[0].split(' ')[0] for c in cases) + '）')
    for name, rel, old, new, test_file, min_fail in cases:
        path = ROOT / rel
        original = path.read_text(encoding="utf-8")
        if old not in original:
            print(f"[SKIP] {name}: 未找到锚点，跳过（源码可能已改动）")
            ok = False
            continue
        try:
            PENDING.append((path, original))
            path.write_text(original.replace(old, new, 1), encoding="utf-8")
            failed, passed_all, _ = run(test_file)
            if failed < 0:
                print(f"[HANG] {name}: 用例进程 {CASE_TIMEOUT_S}s 内没退出（重跑通常就好）")
                ok = False
                continue
            if failed >= min_fail:
                print(f"[OK]   {name}: 如期变红（失败 {failed} >= {min_fail}）")
            elif passed_all:
                print(f"[BAD]  {name}: 改回缺陷后测试仍然全绿 —— 守护用例是假的！")
                ok = False
            else:
                print(f"[BAD]  {name}: 只红了 {failed} 条，期望 >= {min_fail}")
                ok = False
        finally:
            path.write_text(original, encoding="utf-8")
            PENDING.clear()

    if only_mode:
        print('结论：', '全部变异都被抓到' if ok else '存在问题，见上方 [BAD]/[SKIP]')
        return 0 if ok else 1

    # 还原后再跑一次全量，确认源码回到健康状态
    proc = subprocess.run(
        ["npx", "vitest", "run"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
    )
    tail = [line for line in plain(proc.stdout).splitlines() if line.strip().startswith("Tests ")]
    print("还原后全量：" + (tail[-1].strip() if tail else "(未取到)"))
    if proc.returncode != 0:
        print("!! 还原后全量未通过")
        ok = False

    print("结论：", "全部变异都被抓到" if ok else "存在问题，见上方 [BAD]/[SKIP]")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
