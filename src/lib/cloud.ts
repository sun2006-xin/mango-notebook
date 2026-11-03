import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';
import type { PersistedPayload } from '../types';

/* ============================================================================
   云服务客户端（全工程唯一入口）
   —— 任何其它文件都要从这里 import `cloud`，不要另建客户端、不要手写
      `fetch('/.cloud/**')`、不要引入 `@cloudbase/js-sdk`。
   ========================================================================= */

/**
 * Public cloud settings are injected at build time by Vite. Do not hardcode
 * deployment-specific values in this module. The server must enforce
 * authentication and authorization for cloud data.
 */
/** 构建期注入（见 vite.config.ts / globals.d.ts）。`--mode local` 时整块为空 */
const env = __CLOUD_ENV__;

/**
 * Cloud settings are injected from the build environment; deployment-specific
 * values must not be hardcoded in source. Without a complete configuration,
 * `isCloudConfigured` is false and the app keeps its local features without
 * showing cloud login or sync controls. Public client settings do not replace
 * authentication or authorization enforced by the server.
 */
export const publicConfig = {
  resourceId: env.resourceId,
  endpoint: env.endpoint,
  oauthRelayBaseUrl: env.oauthRelay,
  publishableKey: env.key,
} as const;

/**
 * 这个构建是否配好了云服务。
 *
 * ⚠️ 两个字段缺一不可：SDK 在 **构造时** 就会抛
 * 「endpoint is required」「publishableKey is required」，而且是在模块求值阶段，
 * 一旦为空就是白屏。所以没有配置时**绝不能构造客户端**（见下面的安全桩）。
 */
export const isCloudConfigured = Boolean(
  publicConfig.endpoint && publicConfig.publishableKey,
);

/** 云端整包快照表名（每用户一行） */
export const SYNC_TABLE = 'todo_sync';
/** 历史版本表：todo_sync 被覆盖/删除前由数据库触发器自动存档，客户端只读 */
export const SYNC_HISTORY_TABLE = 'todo_sync_history';

/** `public.todo_sync` 的一行。owner_id 由数据库 DEFAULT auth.uid() 填充，应用不感知。 */
export interface TodoSyncRow {
  id: number;
  payload: PersistedPayload;
  saved_at: string;
  created_at: string;
}

/**
 * `public.todo_sync_history` 的一行 —— 一份**被覆盖前**的旧快照。
 *
 * 由数据库 BEFORE UPDATE/DELETE 触发器写入，客户端**只读**：
 * 表里没有 UPDATE 策略（历史不可篡改），INSERT/DELETE 只留给触发器做保留裁剪。
 */
export interface TodoSyncHistoryRow {
  id: number;
  owner_id: string;
  sync_row_id: number | null;
  payload: PersistedPayload;
  saved_at: string;
  archived_at: string;
  archived_reason: string;
}

/**
 * 给 SDK 的强类型 schema（只声明用到的这一张表）。
 *
 * `Insert` / `Update` 里**故意没有 owner_id** —— 它由数据库默认值填充，
 * 应用代码传它既没必要，也会绕过 RLS 的设计意图。
 */
export interface CloudDatabase {
  public: {
    Tables: {
      todo_sync: {
        Row: TodoSyncRow;
        Insert: {
          id?: number;
          payload: PersistedPayload;
          saved_at?: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          payload?: PersistedPayload;
          saved_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      todo_sync_history: {
        Row: TodoSyncHistoryRow;
        // 只声明 Row：历史由触发器写入，客户端不 INSERT / 不 UPDATE
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

/**
 * 只初始化一次。三个值都传：`oauthRelayBaseUrl` 即使当前只做手机号登录也传，
 * 缺失会让 OAuth 相关入口直接报 `requires oauthRelayBaseUrl`。
 */
function createRealClient() {
  return createWorkBuddyCloud<CloudDatabase>({
    endpoint: publicConfig.endpoint,
    oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
    publishableKey: publicConfig.publishableKey,
  });
}

/**
 * 未配置时的**安全桩**：任何链式调用都返回"未配置"错误，绝不抛、绝不联网。
 *
 * 为什么需要它：`cloud` 是模块级常量，被 cloudSync / cloudSnapshot 直接引用。
 * 如果没有配置又不构造客户端，那些模块的 `cloud.auth.xxx` 会在运行期炸成
 * "Cannot read properties of undefined"。桩让"没配置"这件事在**最深的一层**
 * 也是安全的 —— 上层的 UI 与自动同步本来就已被 `isCloudConfigured` 挡住，
 * 这里只是兜住"万一被调用"。
 */
function createUnconfiguredClient(): ReturnType<typeof createRealClient> {
  const result = {
    data: null,
    error: { code: 'not-configured', message: '本构建未配置云服务', status: null },
  };
  // 每个属性访问都返回"同一个可等待的桩"，于是 .from().select().eq() 这类链式调用不会断
  const stub: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => resolve(result);
        }
        if (prop === 'unsubscribe') return () => undefined;
        return () => stub;
      },
    },
  );
  return stub as ReturnType<typeof createRealClient>;
}

export const cloud = isCloudConfigured ? createRealClient() : createUnconfiguredClient();

/* ============================================================================
   Runtime availability gate
   The default native clients build without cloud settings. Self-hosted builds
   use their own endpoint. This origin check controls UI and OAuth routing; it
   is not a server-side authorization boundary.
   ========================================================================= */

/** 配置服务的 origin（endpoint 不含路径时与页面 origin 一致） */
export const CLOUD_ORIGIN = publicConfig.endpoint.replace(/\/+$/, '');

/** 桌面自建云构建 / 本地联调的显式开关；未配置云时不会启用登录 */
const VERIFY_ONLY_PARAM = 'cloud';

function getPageOrigin(): string | null {
  try {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    return typeof origin === 'string' ? origin : null;
  } catch {
    return null;
  }
}

function getPageSearch(): string {
  try {
    const search = (globalThis as { location?: { search?: string } }).location?.search;
    return typeof search === 'string' ? search : '';
  } catch {
    return '';
  }
}

/**
 * 当前运行环境是否支持云同步。
 *
 * 页面 origin 匹配当前构建配置的服务 origin 时为 true；桌面自建云构建还可
 * 通过 `?cloud=1` 显式启用。没有配置云时始终为 false。
 *
 * 两个入参都带默认值，正常调用就是 `isCloudRuntimeAvailable()`；
 * 显式传参只为单测覆盖各端 origin，生产代码不要传。
 */
export function isCloudRuntimeAvailable(
  origin: string | null = getPageOrigin(),
  search: string = getPageSearch(),
): boolean {
  /**
   * 没有配置 = 这个构建不提供云同步（开源版的默认状态）。
   * 放在最前面：连"origin 是否匹配"都不必再算 —— 配置为空时 CLOUD_ORIGIN 也是空串，
   * 拿空串去比会在某些页面（origin 为空）上误判为真。
   */
  if (!isCloudConfigured) return false;

  if (origin === CLOUD_ORIGIN) return true;
  // 桌面自建云构建 / 本地联调：配置了服务后才允许显式打开登录入口
  try {
    return new URLSearchParams(search).get(VERIFY_ONLY_PARAM) === '1';
  } catch {
    return false;
  }
}
