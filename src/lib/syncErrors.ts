import { isCloudRuntimeAvailable } from './cloud';

/* ============================================================================
   云同步的错误归一
   ----------------------------------------------------------------------------
   为什么单独一个文件：错误文案是**用户唯一看得到的同步反馈**，
   而它的分支条件（SQLSTATE 42501、OAuth2 invalid_client、HTTP 401、409、
   `23505` 文本）全是字符串常量 —— 改错一个字母不会报错，只会让用户看到
   "同步失败，数据仍在本机"这句什么都没说的大白话，然后以为数据要没了。

   单独成文之后，这张对照表可以独立被测，也不用为了改一句文案去翻 1000 行的
   网络编排代码。所有取值口径都在这里，cloudSync 只负责"调哪个"。
   ========================================================================= */

export interface SyncErrorInfo {
  /** 上游原始错误码（PostgREST 的 `42501`、OAuth2 的 `invalid_client` 等），无则 null */
  code: string | null;
  /** 面向用户的可读信息 */
  message: string;
  /** HTTP 状态码；网络层失败或未知时为 null */
  status?: number | null;
}

/** RLS 拒绝读写时 PostgREST 返回的 SQLSTATE */
const PERMISSION_DENIED_CODE = '42501';
/** PostgREST 唯一冲突：两台设备并发首次同步都执行 insert，撞 owner_id 唯一索引 */
const UNIQUE_VIOLATION_CODE = '23505';
/** Origin 不在应用白名单里（桌面端 exe / 安卓 APK）时云端返回的 OAuth2 错误码 */
const INVALID_CLIENT_CODE = 'invalid_client';
/** 非发布域名下拿不到有效凭据的 HTTP 状态码；也用于判断「会话确实不能再用了」 */
export const UNAUTHORIZED_STATUS = 401;

/** 环境不支持云同步时的统一口径（不把英文原文抛给用户） */
export const UNSUPPORTED_RUNTIME_MESSAGE = '当前环境不支持云同步（请使用网页版登录）';
/** 登录态失效（token 过期 / 会话被销毁）时的口径 */
export const SESSION_EXPIRED_MESSAGE = '登录状态已失效，请重新登录';

export function toSyncError(
  error: { message?: string; code?: string; status?: number } | null | undefined,
): SyncErrorInfo {
  const raw = typeof error?.message === 'string' ? error.message.trim() : '';
  const code = typeof error?.code === 'string' && error.code ? error.code : null;
  const status = typeof error?.status === 'number' ? error.status : null;
  return { code, message: raw || '同步失败，数据仍在本机', status };
}

/** 唯一冲突（23505 / HTTP 409 / duplicate key）：并发首次同步时另一台设备抢先建了行 */
export function isUniqueViolation(error: SyncErrorInfo | null | undefined): boolean {
  if (!error) return false;
  if (error.code === UNIQUE_VIOLATION_CODE) return true;
  if (error.status === 409) return true;
  return error.message.includes(UNIQUE_VIOLATION_CODE) || /duplicate key/i.test(error.message);
}

/** RLS 静默拦截（PostgREST 不报错、只返空数组）时的统一口径 */
export function permissionDeniedError(): SyncErrorInfo {
  return { code: PERMISSION_DENIED_CODE, message: '无权操作此数据', status: null };
}

/** 把错误翻成一句给用户看的话；权限类、环境类、会话类各开口径，其余落到「不影响本机」 */
export function syncErrorMessage(error: SyncErrorInfo): string {
  if (error.code === PERMISSION_DENIED_CODE) return '无权操作此数据';
  // invalid_client 只可能是"来源不在应用白名单"，与环境强绑定，不问出处
  if (error.code === INVALID_CLIENT_CODE) return UNSUPPORTED_RUNTIME_MESSAGE;
  // 有的路径只把 invalid_client 放进 message，不落在 code 上
  if (error.message.toLowerCase().includes(INVALID_CLIENT_CODE)) return UNSUPPORTED_RUNTIME_MESSAGE;
  if (error.status === UNAUTHORIZED_STATUS) {
    // 401 有两种成因，不能一律说成"环境不支持"：
    // 非发布域名（桌面端 exe / 安卓 APK）→ 云端不认这个来源；
    // 已发布网页版上 → 登录态失效（token 过期），用户就在网页版上，说"请用网页版"会让人一头雾水。
    return isCloudRuntimeAvailable() ? SESSION_EXPIRED_MESSAGE : UNSUPPORTED_RUNTIME_MESSAGE;
  }
  return '同步失败，数据仍在本机';
}
