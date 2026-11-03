/* ============================================================================
   存储后端（"字节放在哪里"）
   ----------------------------------------------------------------------------
   从 `lib/storage.ts`（777 行）整块切出来：这一层只回答一个问题 ——
   **数据最终写进哪个 KeyValue 后端**。

     网页 / 桌面  localStorage（同步 API 包一层 Promise）
     原生(APK)   Capacitor Preferences（SharedPreferences，不受 WebView origin 影响）

   切它的理由不是行数，而是**换端只改这一个文件**：
   以后要接 IndexedDB / OPFS / 桌面文件系统，改动只落在 resolveBackend；
   而"什么时候写、写什么、写失败了怎么办"完全不在这里。

   ⚠️ 这里**不静态 import @capacitor/core**：三端各省 12–15 KB (min.gz)，
      且本项目单文件交付；原生桥由 Capacitor 在页面脚本前注入 globalThis.Capacitor。
   ========================================================================= */


/* ============================================================================
   平台探测：鸭子类型读 globalThis.Capacitor，零新增运行时依赖
   —— 不静态 import @capacitor/core：三端各省约 12–15 KB (min.gz)，
      且本项目是单文件交付的轻应用。Capacitor 原生桥在页面脚本加载前
      注入 window.Capacitor（公开契约），其上带 isNativePlatform() /
      isPluginAvailable(name)。探测失败绝不是错误：回落 localStorage 即可。
   ========================================================================= */

/** 是否处于 Capacitor 原生运行时（APK）。任何异常一律 false（绝不抛） */
export function isNativeStorage(): boolean {
  try {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform() === true;
  } catch {
    return false;
  }
}

/** 插件守卫：忘了 `npx cap sync` 时桥上没注册插件，isPluginAvailable 为 false */
function isPluginAvailable(name: string): boolean {
  try {
    const cap = (globalThis as { Capacitor?: { isPluginAvailable?: (n: string) => boolean } }).Capacitor;
    return typeof cap?.isPluginAvailable === 'function' && cap.isPluginAvailable(name) === true;
  } catch {
    return false;
  }
}

/* ============================================================================
   双后端抽象：localStorage 与 Preferences 都实现 KeyValueBackend
   ========================================================================= */

/** 跨平台 KV 后端接口（三个方法都返回 Promise，永不因"平台差异"抛不同形状） */
export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** localStorage 后端：同步 API 包一层 Promise（网页 / 桌面 / 回落路径） */
class LocalStorageBackend implements KeyValueBackend {
  constructor(private readonly ls: Storage) {}

  async get(key: string): Promise<string | null> {
    // 不内部兜底：读取异常上抛，由调用方映射成 'unavailable'（与旧版一致）
    return this.ls.getItem(key);
  }

  async set(key: string, value: string): Promise<void> {
    // 不内部兜底：配额 / 安全异常上抛，由 savePersisted 映射判别联合
    this.ls.setItem(key, value);
  }

  async remove(key: string): Promise<void> {
    this.ls.removeItem(key);
  }
}

/** @capacitor/preferences 的最小结构类型（只依赖用到的三个方法） */
interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/** Preferences 后端：原生 SharedPreferences，仅 APK 路径触达 */
class PreferencesBackend implements KeyValueBackend {
  constructor(private readonly prefs: PreferencesLike) {}

  async get(key: string): Promise<string | null> {
    const result = await this.prefs.get({ key });
    return typeof result?.value === 'string' ? result.value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.prefs.set({ key, value });
  }

  async remove(key: string): Promise<void> {
    await this.prefs.remove({ key });
  }
}

/**
 * 过渡双写后端（§1.5.3）：**主端 Preferences（原生）优先**，镜像端 localStorage 兜底；
 * 写两份都落，镜像失败不影响主路径。
 *
 * ⚠️ 主从方向不能反（曾经就是反的，注释还写着"权威存储仍是 localStorage"）：
 * localStorage 是按 **WebView origin** 隔离的，APK 的 hostname 一旦从 localhost
 * 切到发布域名，那一份旧数据就**再也读不到**（跨 origin 无 API 可读）。
 * 所以权威必须是 Preferences（SharedPreferences，原生层，跟 origin 无关），
 * localStorage 只作同 origin 下的一条退路。
 *
 * `get` 里带**一次性迁移**：主端读不到、镜像端有值 → 把镜像值回写主端再返回。
 * 这样"老版本只写过 localStorage"的用户，升级后第一次装载就自动把数据搬进
 * 原生层；此后即使 origin 再变也读得到。
 */
class DualWriteBackend implements KeyValueBackend {
  constructor(
    private readonly primary: KeyValueBackend,
    private readonly mirror: KeyValueBackend,
  ) {}

  async get(key: string): Promise<string | null> {
    const value = await this.primary.get(key);
    if (value !== null) return value;
    const legacy = await this.mirror.get(key);
    if (legacy === null) return null;
    // 迁移：把镜像里的旧数据搬进主端（失败也不影响本次返回）
    try {
      await this.primary.set(key, legacy);
    } catch {
      /* 迁移失败：这次照样让用户看到数据，下次装载再试 */
    }
    return legacy;
  }

  async set(key: string, value: string): Promise<void> {
    await this.primary.set(key, value);
    try {
      await this.mirror.set(key, value);
    } catch {
      /* 镜像写失败不影响主路径 */
    }
  }

  async remove(key: string): Promise<void> {
    await this.primary.remove(key);
    try {
      await this.mirror.remove(key);
    } catch {
      /* 镜像删失败不影响主路径 */
    }
  }
}

/**
 * 过渡双写开关（§1.5.3）：**v0.12 起开启**。
 *
 * 开着的收益（这是"手机升级不丢数据"的落地点）：
 * ① 权威数据在 Preferences（原生层，不受 WebView origin 影响）—— 以后
 *    `capacitor.config.ts` 的 hostname 再怎么改，业务数据都读得到；
 * ② localStorage 仍是镜像：同 origin 下留一条可读退路，万一插件被禁用
 *    （忘 `cap sync`）还有得救；
 * ③ `DualWriteBackend.get` 带一次性迁移：老版本只写过 localStorage 的用户，
 *    升级后第一次装载就把数据搬进原生层。
 *
 * 代价：每次保存写两份（写放大 ~2×，两份都只存一份 6 集合载荷，可接受）。
 */
export const NATIVE_DUAL_WRITE_PHASE = true;

/**
 * 全工程**唯一**的 localStorage 访问入口（try/catch 包住隐私模式下的抛错）。
 *
 * 对外导出是因为 `lib/cloudSync` / `lib/update` / `lib/outbox` 各自需要读写
 * 一两个小键（暂停标记、更新跳过记录、待上传队列），而它们以前各自抄了一份
 * 同名函数 —— 同一件事三份实现，改一处忘两处。
 */
export function getLocalStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/** localStorage 可用时返回后端，否则 null（调用方映射 'unavailable'） */
function createLocalBackend(): KeyValueBackend | null {
  const ls = getLocalStorage();
  return ls ? new LocalStorageBackend(ls) : null;
}

/**
 * 动态 import @capacitor/preferences 并装配后端。
 *
 * ⚠️ 绝不静态 import：Preferences 的 Web 实现底层就是 localStorage，
 * 静态引入会在 web 端执行，直接破坏「storage.ts 唯一入口」纪律。
 * 仅原生路径会走到这里；插件未注册（忘 cap sync）返回 null，
 * 调用方回落 localStorage 路径（与旧版 APK 同行为，不崩不错）。
 */
async function getNativeBackend(): Promise<KeyValueBackend | null> {
  if (!isPluginAvailable('Preferences')) return null;
  try {
    const mod = (await import('@capacitor/preferences')) as unknown as {
      Preferences?: PreferencesLike;
    };
    const prefs = mod.Preferences;
    if (!prefs || typeof prefs.get !== 'function') return null;
    return new PreferencesBackend(prefs);
  } catch {
    return null;
  }
}

/**
 * 平台分发：
 * - 非原生 → localStorage（不可用时返回 null）；
 * - 原生 + 插件可用 → Preferences（或双写后端）；
 * - 原生 + 插件不可用 → 回落 localStorage（插件守卫，R3）。
 */
export async function resolveBackend(): Promise<KeyValueBackend | null> {
  if (!isNativeStorage()) return createLocalBackend();

  const prefs = await getNativeBackend();
  if (!prefs) return createLocalBackend();
  if (NATIVE_DUAL_WRITE_PHASE) {
    const ls = createLocalBackend();
    // 主端 = prefs（原生、与 origin 无关），镜像端 = localStorage（同 origin 的退路）
    return ls ? new DualWriteBackend(prefs, ls) : prefs;
  }
  return prefs;
}
