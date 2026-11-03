import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadAndInstallApk, isInAppApkInstallAvailable } from '../apkUpdate';

/* ============================================================================
   应用内安装 APK（安卓）的 JS 侧

   这里测的是**鸭子类型探测**和**四种结局的映射** —— 原生那半部分（下载 + 调起
   安装器）只能真机验证，但"什么时候该走应用内、什么时候该回落到浏览器"
   完全由这里决定。判错了的后果很具体：老版本 APK / 网页端点了更新毫无反应。
   ========================================================================= */

interface FakePlugin {
  download: (options: { url: string }) => Promise<unknown>;
  addListener: (
    event: string,
    cb: (payload: { done: number; total: number }) => void,
  ) => Promise<{ remove: () => Promise<void> } | void>;
}

/** 装一个假的 Capacitor 全局 */
function installCapacitor(options: {
  native: boolean;
  plugin?: Partial<FakePlugin>;
}): { removed: number } {
  const counter = { removed: 0 };
  const plugin: FakePlugin = {
    download: async () => ({ ok: true }),
    addListener: async () => ({
      remove: async () => {
        counter.removed += 1;
      },
    }),
    ...options.plugin,
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => options.native,
    Plugins: { ApkInstaller: plugin },
  };
  return counter;
}

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('探测', () => {
  it('没有 Capacitor 全局（网页 / 桌面）→ 不可用', () => {
    expect(isInAppApkInstallAvailable()).toBe(false);
  });

  it('isNativePlatform() 返回 false → 不可用', () => {
    installCapacitor({ native: false });
    expect(isInAppApkInstallAvailable()).toBe(false);
  });

  it('isNativePlatform() 抛异常 → 当作不可用，不崩', () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => {
        throw new Error('boom');
      },
      Plugins: {},
    };
    expect(isInAppApkInstallAvailable()).toBe(false);
  });

  it('原生 + 插件存在 → 可用', () => {
    installCapacitor({ native: true });
    expect(isInAppApkInstallAvailable()).toBe(true);
  });

  it('原生但插件没注册（老版本壳）→ 不可用', () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {},
    };
    expect(isInAppApkInstallAvailable()).toBe(false);
  });
});

describe('四种结局的映射（调用方据此决定要不要回落浏览器）', () => {
  it('非原生 → unsupported', async () => {
    await expect(downloadAndInstallApk('https://downloads.example.test/update.apk')).resolves.toBe('unsupported');
  });

  it('插件返回 ok → opened-installer', async () => {
    installCapacitor({ native: true });
    await expect(downloadAndInstallApk('https://downloads.example.test/update.apk')).resolves.toBe('opened-installer');
  });

  it('缺「安装未知应用」权限 → needs-permission（不是失败）', async () => {
    installCapacitor({
      native: true,
      plugin: { download: async () => ({ ok: false, needsPermission: true }) },
    });
    await expect(downloadAndInstallApk('https://downloads.example.test/update.apk')).resolves.toBe('needs-permission');
  });

  it('ok:false 但没说缺权限 → failed', async () => {
    installCapacitor({ native: true, plugin: { download: async () => ({ ok: false }) } });
    await expect(downloadAndInstallApk('https://downloads.example.test/update.apk')).resolves.toBe('failed');
  });

  it('插件抛异常（比如原生没实现）→ failed，不把异常抛给 UI', async () => {
    installCapacitor({
      native: true,
      plugin: {
        download: async () => {
          throw new Error('not implemented');
        },
      },
    });
    await expect(downloadAndInstallApk('https://downloads.example.test/update.apk')).resolves.toBe('failed');
  });

  it('空地址 → failed（不发请求）', async () => {
    installCapacitor({ native: true });
    await expect(downloadAndInstallApk('')).resolves.toBe('failed');
  });
});

describe('进度与清理', () => {
  it('进度回调被原样转发给调用方', async () => {
    let emit: ((p: { done: number; total: number }) => void) | null = null;
    installCapacitor({
      native: true,
      plugin: {
        addListener: async (_event, cb) => {
          emit = cb;
          return { remove: async () => {} };
        },
        download: async () => {
          emit?.({ done: 512, total: 2048 });
          return { ok: true };
        },
      },
    });
    const seen: number[] = [];
    await downloadAndInstallApk('https://downloads.example.test/update.apk', (done) => seen.push(done));
    expect(seen).toEqual([512]);
  });

  it('结束后一定移除监听（否则每次点更新都多挂一个）', async () => {
    const counter = installCapacitor({ native: true });
    await downloadAndInstallApk('https://downloads.example.test/update.apk', () => {});
    expect(counter.removed).toBe(1);
  });

  it('下载失败也要移除监听', async () => {
    const counter = installCapacitor({
      native: true,
      plugin: {
        download: async () => {
          throw new Error('network');
        },
      },
    });
    await downloadAndInstallApk('https://downloads.example.test/update.apk', () => {});
    expect(counter.removed).toBe(1);
  });

  it('监听注册失败不影响下载本身（只是没有进度条）', async () => {
    installCapacitor({
      native: true,
      plugin: {
        addListener: async () => {
          throw new Error('no listeners');
        },
      },
    });
    await expect(downloadAndInstallApk('https://downloads.example.test/update.apk', () => {})).resolves.toBe(
      'opened-installer',
    );
  });

  it('不传 onProgress 时不注册监听', async () => {
    const addListener = vi.fn(async () => ({ remove: async () => {} }));
    installCapacitor({ native: true, plugin: { addListener } });
    await downloadAndInstallApk('https://downloads.example.test/update.apk');
    expect(addListener).not.toHaveBeenCalled();
  });
});
