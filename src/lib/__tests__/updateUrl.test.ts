import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARE_CODE, appendParam, checkForUpdate, withShareCode } from '../update';

/* URL helpers must preserve existing query parameters and encode added values. */

const MANIFEST = {
  version: '0.29.4',
  buildId: 'abc123',
  android: { url: 'daily-todo.apk', size: 1024, versionCode: 2904 },
};

let requested: string[] = [];

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appendParam', () => {
  it('adds a query parameter when none exists', () => {
    expect(appendParam('https://updates.example.test/version.json', 't', '1')).toBe(
      'https://updates.example.test/version.json?t=1',
    );
  });

  it('preserves existing query parameters', () => {
    expect(
      appendParam('https://updates.example.test/version.json?sharecode=YOUR_SHARE_CODE', 't', '1'),
    ).toBe('https://updates.example.test/version.json?sharecode=YOUR_SHARE_CODE&t=1');
  });

  it('encodes parameter values', () => {
    const parsed = new URL(appendParam('https://updates.example.test/version.json', 'q', 'a b&c'));
    expect(parsed.searchParams.get('q')).toBe('a b&c');
  });
});

describe('checkForUpdate', () => {
  it('sends the configured share code as its own parameter', async () => {
    await checkForUpdate('web');
    expect(requested).toHaveLength(1);
    const url = new URL(requested[0]);
    expect(url.searchParams.get('sharecode')).toBe(SHARE_CODE);
    expect(url.searchParams.get('sharecode')).not.toContain('?');
  });

  it('adds one cache-busting timestamp parameter', async () => {
    await checkForUpdate('web');
    const raw = requested[0];
    expect(raw.split('?')).toHaveLength(2);
    expect(new URL(raw).searchParams.get('t')).toMatch(/^\d+$/);
  });

  it('compares Android releases by versionCode（码更大才算有新版本）', async () => {
    const info = await checkForUpdate('android');
    /**
     * 不写死 false：本机的 versionCode 来自构建产物 `build-info.json`，
     * 而它**不入库**（开源副本第一次跑测试时根本没有这个文件 → 本机算 0）。
     * 写死 false 会让"克隆下来先跑测试"直接红，而代码其实是对的。
     * 这里按契约判：远端的码比自己大 = 有新版本。
     */
    expect(info.available).toBe(MANIFEST.android.versionCode > __ANDROID_VERSION_CODE__);
  });

  it('compares Web releases by buildId', async () => {
    const info = await checkForUpdate('web');
    expect(info.available).toBe(true);
  });

  it('adds the share code to the APK download URL', async () => {
    const info = await checkForUpdate('android');
    expect(info.apkUrl).not.toBeNull();
    expect(new URL(info.apkUrl as string).searchParams.get('sharecode')).toBe(SHARE_CODE);
  });
});

describe('withShareCode', () => {
  it('preserves existing query parameters', () => {
    const url = new URL(withShareCode('https://updates.example.test/version.json?channel=stable'));
    expect(url.searchParams.get('channel')).toBe('stable');
    expect(url.searchParams.get('sharecode')).toBe(SHARE_CODE);
  });
});