import { afterEach, describe, expect, it } from 'vitest';
import { CLOUD_ORIGIN, isCloudRuntimeAvailable, publicConfig } from '../cloud';
import {
  SESSION_EXPIRED_MESSAGE,
  UNSUPPORTED_RUNTIME_MESSAGE,
  syncErrorMessage,
} from '../cloudSync';

/** Set a synthetic page location for runtime-gate tests. */
function setLocation(origin: string | null, search = ''): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (origin === null) delete g.location;
  else g.location = { origin, search };
}

afterEach(() => setLocation(null));

describe('isCloudRuntimeAvailable', () => {
  it('allows the configured service origin', () => {
    expect(isCloudRuntimeAvailable(publicConfig.endpoint)).toBe(true);
    expect(isCloudRuntimeAvailable(CLOUD_ORIGIN)).toBe(true);
  });

  it('rejects unmatched local client origins', () => {
    expect(isCloudRuntimeAvailable('http://127.0.0.1:4173')).toBe(false);
    expect(isCloudRuntimeAvailable('https://localhost')).toBe(false);
    expect(isCloudRuntimeAvailable('capacitor://localhost')).toBe(false);
  });

  it('rejects a missing or opaque origin', () => {
    expect(isCloudRuntimeAvailable('null')).toBe(false);
    expect(isCloudRuntimeAvailable(null)).toBe(false);
    expect(isCloudRuntimeAvailable()).toBe(false);
  });

  it('requires an explicit ?cloud=1 on an unmatched origin', () => {
    const origin = 'https://client.example.test';
    expect(isCloudRuntimeAvailable(origin, '?cloud=1')).toBe(true);
    expect(isCloudRuntimeAvailable(origin, '')).toBe(false);
    expect(isCloudRuntimeAvailable(origin, '?cloud=0')).toBe(false);
  });
});

describe('cloud error mapping', () => {
  it('maps invalid_client to the unsupported-runtime message', () => {
    const message = syncErrorMessage({
      code: 'invalid_client',
      message: 'the client credential is invalid or revoked',
      status: null,
    });
    expect(message).toBe(UNSUPPORTED_RUNTIME_MESSAGE);
    expect(message).not.toMatch(/invalid|credential|revoked/i);
  });

  it('recognizes an error code included in the message', () => {
    const message = syncErrorMessage({
      code: null,
      message: 'invalid_client: the client credential is invalid or revoked',
      status: null,
    });
    expect(message).toBe(UNSUPPORTED_RUNTIME_MESSAGE);
  });

  it('maps 401 on an unsupported origin to an environment message', () => {
    setLocation('https://client.example.test');
    expect(syncErrorMessage({ code: null, message: 'unauthorized', status: 401 })).toBe(
      UNSUPPORTED_RUNTIME_MESSAGE,
    );
    setLocation(null);
    expect(syncErrorMessage({ code: null, message: 'unauthorized', status: 401 })).toBe(
      UNSUPPORTED_RUNTIME_MESSAGE,
    );
  });

  it('maps 401 on the configured origin to an expired session', () => {
    setLocation(CLOUD_ORIGIN);
    const message = syncErrorMessage({ code: null, message: 'JWT expired', status: 401 });
    expect(message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(message).not.toBe(UNSUPPORTED_RUNTIME_MESSAGE);
  });

  it('maps database permission and other errors to user-facing messages', () => {
    expect(syncErrorMessage({ code: '42501', message: 'row-level security', status: null })).toBe(
      '无权操作此数据',
    );
    expect(syncErrorMessage({ code: 'PGRST301', message: 'connection error', status: null })).toBe(
      '同步失败，数据仍在本机',
    );
  });
});