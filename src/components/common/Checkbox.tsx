import { Icon } from './Icon';

export interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  /** 无障碍标签，例如「完成 数学真题」 */
  label: string;
  /** 'compact' 用于周视图列内（26 热区 + 15 圆环） */
  density?: 'default' | 'compact';
  className?: string;
}

/**
 * 勾选框：原生 `input[type=checkbox]`（`sr-only`）保证 Space / 读屏可用，
 * 视觉层是 44×44 热区 + 20 直径圆环（compact 为 26 + 15，配方在 index.css 的 .cb-*）。
 */
export function Checkbox({
  checked,
  onChange,
  label,
  density = 'default',
  className,
}: CheckboxProps) {
  const compact = density === 'compact';

  return (
    <label
      className={`group relative grid shrink-0 cursor-pointer place-items-center ${
        compact ? 'cb-sm' : 'h-11 w-11'
      } ${className ?? ''}`}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={onChange}
        aria-label={label}
      />
      <span
        aria-hidden="true"
        className={`cb-ring ${compact ? 'cb-ring--sm' : ''} ${
          checked ? 'cb-ring--on' : ''
        } group-hover:border-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus`}
      >
        <Icon name="check" size={compact ? 9 : 11} className={checked ? 'opacity-100' : 'opacity-0'} />
      </span>
    </label>
  );
}
