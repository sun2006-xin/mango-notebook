import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type ConfirmVariant = 'danger' | 'outline' | 'primary';

export interface ConfirmButtonProps {
  /** 静息态文案（用户看到的第一句话） */
  children: ReactNode;
  /** 已武装（armed）时的文案，默认在静息文案前加「确认」 */
  confirmLabel?: ReactNode;
  /** 用户**第二次**点击时才执行 */
  onConfirm: () => void;
  /**
   * 武装状态的自动收回时间（毫秒）。
   * 默认 3000 —— 与项目里原本各处手写的值一致：短到不会误触，
   * 长到来得及反应。
   */
  timeoutMs?: number;
  variant?: ConfirmVariant;
  testId?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

const VARIANT_CLASS: Record<ConfirmVariant, string> = {
  danger: 'btn btn-danger',
  outline: 'btn btn-outlined',
  primary: 'btn btn-primary',
};

/**
 * 二次确认按钮：**点一下武装，再点一下执行，3 秒后自动收回**。
 *
 * 为什么抽出来：这个项目里"不可逆操作"的确认原本有四种写法在混用 ——
 * 按钮文案变「确认…再点一次」（各自手写 state + 定时器）、3 秒自动收回、
 * 只弹一个 Toast、以及独立确认面板。四种写法的差别不只是外观：
 * **有的会自动收回、有的不会**。不会收回的那种最坑 —— 用户半分钟前点了一下
 * 想看看反应，回来随手再点一下，东西就没了。
 *
 * 统一的语义：
 * - 第一次点击：**只武装**，不执行任何动作（也不关弹层、不改数据）；
 * - 第二次点击：执行 `onConfirm`；
 * - 3 秒内没有第二次点击：自动退回静息态；
 * - 卸载 / 变为 disabled：定时器立刻清掉（否则组件没了还去 setState）。
 *
 * 刻意**不**支持"确认后保持武装"——执行完就该回到起点，让状态只有一个方向。
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  timeoutMs = 3000,
  variant = 'danger',
  testId,
  disabled = false,
  className = '',
  ariaLabel,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setArmed(false);
  }, []);

  // 卸载与 disabled 都要收掉定时器：组件已经不存在了还去 setState 是无谓的
  useEffect(() => {
    if (disabled) disarm();
  }, [disabled, disarm]);

  useEffect(() => disarm, [disarm]);

  const onClick = useCallback(() => {
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setArmed(false);
      }, timeoutMs);
      return;
    }
    // 第二次点击：先收状态再执行，避免 onConfirm 抛错时按钮卡在"确认中"
    disarm();
    onConfirm();
  }, [armed, disabled, disarm, onConfirm, timeoutMs]);

  return (
    <button
      type="button"
      data-testid={testId}
      data-armed={armed ? 'true' : undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`${armed ? 'btn btn-primary' : VARIANT_CLASS[variant]} shrink-0 disabled:opacity-40 ${className}`}
    >
      {armed ? (confirmLabel ?? `确认${typeof children === 'string' ? children : ''}？`) : children}
    </button>
  );
}
