import { useEffect, useRef, useState } from 'react';
import { cloud } from '../../lib/cloud';
import { Icon } from '../common/Icon';

/* ============================================================================
   登录面板：只做手机号 + 验证码登录
   —— 没有密码、没有邮箱、没有微信、没有匿名登录。
   纪律：手机号原样传给 SDK（SDK 自己归一化区号），不自己拼 `+86`；
        日志里不出现完整手机号 / 验证码。
   ========================================================================= */

const PHONE_PATTERN = /^1\d{10}$/;
const RESEND_SECONDS = 60;

export interface LoginPanelProps {
  open: boolean;
  onClose: () => void;
  /** 登录成功后回调（父级负责刷新登录态与展示提示） */
  onSignedIn: () => void;
}

/**
 * 两步式验证码登录。
 *
 * - 手机号不合法：**不发请求**，只在输入框下方显示提示；重新输入即清除。
 * - 「获取验证码」→ `sendOtp`，把 `verificationId` / `isExistingUser` 留在 state 里；
 *   60 秒倒计时只锁发送按钮，不影响「登录」。
 * - 「登录」→ `verifyOtp`，这一步不再发码。
 */
export function LoginPanel({ open, onClose, onSignedIn }: LoginPanelProps) {
  const [phone, setPhone] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [isExistingUser, setIsExistingUser] = useState(false);

  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const phoneRef = useRef<HTMLInputElement>(null);

  // 倒计时：只影响「获取验证码」按钮
  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // 打开后聚焦手机号；Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => phoneRef.current?.focus(), 40);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  // 关闭时把表单收干净，下次打开是全新一轮
  useEffect(() => {
    if (open) return;
    setPhone('');
    setToken('');
    setError(null);
    setHint(null);
    setVerificationId(null);
    setIsExistingUser(false);
    setCountdown(0);
  }, [open]);

  /** 手机号一改，上一轮的验证码就作废，错误提示也一起清掉 */
  const onPhoneChange = (value: string): void => {
    setPhone(value);
    setError(null);
    setVerificationId(null);
    setIsExistingUser(false);
  };

  const onSendCode = async (): Promise<void> => {
    if (sending || countdown > 0) return;
    if (!PHONE_PATTERN.test(phone)) {
      setError('请输入正确的 11 位手机号');
      return;
    }
    setSending(true);
    setError(null);
    setHint(null);
    try {
      const { data, error: otpError } = await cloud.auth.sendOtp({ phone });
      if (otpError || !data) {
        setError(otpError?.message || '验证码发送失败，请稍后重试');
        return;
      }
      setVerificationId(data.verificationId);
      setIsExistingUser(data.isExistingUser);
      setCountdown(RESEND_SECONDS);
      setHint('验证码已发送，请查收短信');
    } catch {
      setError('网络异常，验证码发送失败');
    } finally {
      setSending(false);
    }
  };

  const onVerify = async (): Promise<void> => {
    if (verifying) return;
    if (!PHONE_PATTERN.test(phone)) {
      setError('请输入正确的 11 位手机号');
      return;
    }
    if (!verificationId) {
      setError('请先获取验证码');
      return;
    }
    if (!token.trim()) {
      setError('请输入收到的验证码');
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const { data, error: verifyError } = await cloud.auth.verifyOtp({
        phone,
        verificationId,
        isExistingUser,
        token: token.trim(),
      });
      if (verifyError || !data) {
        setError(verifyError?.message || '验证码不正确或已失效');
        return;
      }
      setHint(null);
      onSignedIn();
      onClose();
    } catch {
      setError('网络异常，登录失败');
    } finally {
      setVerifying(false);
    }
  };

  const sendLabel = countdown > 0 ? `${countdown} 秒后重发` : sending ? '发送中…' : '获取验证码';

  return (
    <>
      <div
        className={`scrim fixed inset-0 z-40 transition-opacity duration-base ease-standard ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="登录以开启云同步"
        aria-hidden={!open}
        className={`fixed left-1/2 top-1/2 z-50 w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2
          rounded-xl border border-line bg-surface p-5 shadow-2 transition-opacity duration-base ease-standard ${
            open ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-h2 font-bold tracking-[-0.01em]">登录开启云同步</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭登录面板"
            className="grid h-11 w-11 place-items-center rounded-md text-ink-2 hover:bg-surface-sunk hover:text-ink"
          >
            <Icon name="close" />
          </button>
        </div>

        <p className="mt-1 text-label leading-relaxed text-ink-2">
          用手机号验证码登录，换手机也能接着用这份待办。不登录也能照常使用。
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="login-phone">
            手机号
          </label>
          <input
            ref={phoneRef}
            id="login-phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={phone}
            maxLength={11}
            placeholder="11 位手机号"
            aria-invalid={error !== null}
            aria-describedby={error ? 'login-phone-error' : undefined}
            onChange={(event) => onPhoneChange(event.target.value.replace(/\D/g, ''))}
            className="h-11 field bg-surface-sunk px-3 text-body text-ink"
 />
 {error ? (
 <p id="login-phone-error" role="alert" className="text-label text-danger">
              {error}
            </p>
          ) : null}
          {!error && hint ? <p className="text-label text-ink-2">{hint}</p> : null}
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="login-code">
            验证码
          </label>
          <div className="flex items-center gap-2">
            <input
              id="login-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={token}
              maxLength={8}
              placeholder="短信中的验证码"
              onChange={(event) => {
                setToken(event.target.value.replace(/\D/g, ''));
                setError(null);
              }}
              className="h-11 min-w-0 flex-1 field bg-surface-sunk px-3 text-body text-ink"
 />
 <button
 type="button"
 onClick={() => void onSendCode()}
 disabled={sending || countdown > 0}
 className="btn btn-outlined h-11 shrink-0 disabled:opacity-50"
            >
              {sendLabel}
            </button>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn btn-outlined">
            取消
          </button>
          <button
            type="button"
            onClick={() => void onVerify()}
            disabled={verifying}
            className="btn btn-primary disabled:opacity-50"
          >
            {verifying ? '登录中…' : '登录'}
          </button>
        </div>
      </div>
    </>
  );
}
