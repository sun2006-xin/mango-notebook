import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHARE_CODE, withShareCode } from '../update';

/* Share-code configuration must come from build settings or package metadata,
   not from hardcoded application values. */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

describe('share-code configuration', () => {
  it('renderer reads shareCode from injected build settings', () => {
    const src = stripComments(readFileSync(new URL('../update.ts', import.meta.url), 'utf8'));
    expect(src).toContain('__CLOUD_ENV__.shareCode');
    expect(src).not.toContain("from '../../package.json'");
  });

  it('test configuration supplies a non-empty placeholder', () => {
    expect(SHARE_CODE.length).toBeGreaterThan(0);
  });

  it('Electron updater reads an optional share code from package metadata', () => {
    const updater = stripComments(
      readFileSync(new URL('../../../electron/updater.cjs', import.meta.url), 'utf8'),
    );
    expect(updater).not.toContain(`'${SHARE_CODE}'`);
    expect(updater).not.toContain(`"${SHARE_CODE}"`);
    expect(updater).toContain("require('../package.json')");

    const release = readFileSync(
      new URL('../../../scripts/release_desktop.py', import.meta.url),
      'utf8',
    );
    expect(release).toContain('VITE_SHARE_CODE');
  });

  it('source package metadata has no deployment share code by default', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(pkg.shareCode).toBeUndefined();
  });

  it('withShareCode adds the parameter with and without an existing query', () => {
    const noQuery = new URL(withShareCode('https://updates.example.test/version.json'));
    expect(noQuery.searchParams.get('sharecode')).toBe(SHARE_CODE);

    const existingQuery = new URL(
      withShareCode('https://updates.example.test/version.json?channel=stable'),
    );
    expect(existingQuery.searchParams.get('channel')).toBe('stable');
    expect(existingQuery.searchParams.get('sharecode')).toBe(SHARE_CODE);
  });
});