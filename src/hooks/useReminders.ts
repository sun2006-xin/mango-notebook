import { useEffect, useRef } from 'react';
import { tasksDueForReminder } from '../lib/task';
import type { DateKey, Task } from '../types';

/* ============================================================================
   到期提醒（系统通知）

   设计取舍：
   - 用浏览器/Electron 通用的 Notification API，不引 Capacitor 本地通知插件 ——
     少一个原生依赖，桌面端和网页版都能用；Android WebView 不支持时静默降级
     （开关照旧在，只是不弹），不会因此报错。
   - 只提醒"今天已到点且未完成"的任务；**同一条任务每次运行只提醒一次**
     （进程内 Set 记账），否则 30 秒轮询会一直弹。
   - 关掉开关 / 权限被收回 → 立即停表，不再发任何通知。
   ========================================================================= */

/** 本地时间 'HH:mm'（24 小时制补零），与 Task.time 同格式可直接比较 */
function currentTimeKey(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function canNotify(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/** 请求通知权限；返回是否可用（用户拒绝或环境不支持都为 false） */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

/**
 * 弹出一条系统通知；复用文件内既有 `canNotify()` 守卫。
 * 环境不支持 / 权限未授予 → 静默跳过；构造异常 try/catch 吞掉，绝不冒泡。
 */
export function showNotification(title: string, body: string): void {
  if (!canNotify()) return;
  try {
    new Notification(title, { body });
  } catch {
    /* 个别环境构造 Notification 会抛：静默跳过 */
  }
}

export function useReminders(today: DateKey, tasks: Task[], enabled: boolean): void {
  // 已提醒过的任务 id：进程内记账即可，重启后重复提醒一次是可接受的代价
  const notified = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !canNotify()) return;

    const tick = () => {
      for (const task of tasksDueForReminder(tasks, today, currentTimeKey())) {
        if (notified.current.has(task.id)) continue;
        notified.current.add(task.id);
        try {
          new Notification('待办提醒', { body: task.title, tag: task.id });
        } catch {
          /* 个别环境构造 Notification 会抛：静默跳过，不影响其它提醒 */
        }
      }
    };

    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [today, tasks, enabled]);
}
