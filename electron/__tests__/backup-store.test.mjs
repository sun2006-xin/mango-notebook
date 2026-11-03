import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const backupStore = require('../backup-store.cjs');

/* ============================================================================
   桌面端自动备份的纯逻辑（F4）

   两件事必须钉死，出错的后果都是"用户数据没了"：
   ① 文件名白名单 —— 渲染进程传来的 name 完全不可信。`../evil.json` 一旦被放行，
      读写的就不只是备份目录，而是磁盘上任意位置。
   ② 只留 14 份 —— 但没有清理逻辑时备份目录会无限膨胀；清理写错方向
      （删新的留旧的）等于把最近的救命稻草扔掉。
   ========================================================================= */

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-backup-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('文件名白名单', () => {
  it('只认 YYYY-MM-DD.json 与 pre-restore.json', () => {
    expect(backupStore.isSafeBackupName('2026-10-24.json')).toBe(true);
    expect(backupStore.isSafeBackupName('pre-restore.json')).toBe(true);
  });

  it('路径穿越 / 绝对路径 / 时间戳型文件名一律拒绝', () => {
    for (const bad of [
      '../evil.json',
      '..\\evil.json',
      'sub/2026-10-24.json',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '2026-10-24.json.tmp',
      '2026-10-24.JSON',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(backupStore.isSafeBackupName(bad)).toBe(false);
    }
  });

  it('resolveBackupPath 对非法名返回 null，合法名落在目录内', () => {
    expect(backupStore.resolveBackupPath(dir, '../evil.json')).toBeNull();
    expect(backupStore.resolveBackupPath(dir, '2026-10-24.json')).toBe(
      path.join(path.resolve(dir), '2026-10-24.json'),
    );
  });

  it('readBackup 传穿越名返回 bad-name（不会读到目录外的文件）', () => {
    const outside = path.join(dir, '..', 'evil.json');
    fs.writeFileSync(outside, '{"tasks":[]}');
    const result = backupStore.readBackup(path.join(dir, 'backups'), '../evil.json');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad-name');
    fs.unlinkSync(outside);
  });
});

describe('写入与读取', () => {
  it('write → read 往返（内容一致）', () => {
    const json = JSON.stringify({ schemaVersion: 5, tasks: [{ id: 'a', title: '数学' }] });
    const written = backupStore.writeBackup(dir, '2026-10-24.json', json);
    expect(written.ok).toBe(true);
    expect(backupStore.readBackup(dir, '2026-10-24.json')).toEqual({
      ok: true,
      name: '2026-10-24.json',
      json,
    });
  });

  it('写入走 tmp → rename，目录里不留 .tmp', () => {
    backupStore.writeBackup(dir, '2026-10-24.json', '{"a":1}');
    expect(fs.readdirSync(dir)).toEqual(['2026-10-24.json']);
  });

  it('非法名 / 空内容不写', () => {
    expect(backupStore.writeBackup(dir, '../evil.json', '{}').ok).toBe(false);
    expect(backupStore.writeBackup(dir, '2026-10-24.json', '').ok).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('读不存在的文件返回 missing（不抛）', () => {
    expect(backupStore.readBackup(dir, '2026-10-24.json')).toEqual({
      ok: false,
      error: 'missing',
    });
  });
});

describe('保留份数', () => {
  it('写 16 份 → 只剩最新 14 份', () => {
    for (let i = 1; i <= 16; i += 1) {
      const name = `2026-09-${String(i).padStart(2, '0')}.json`;
      backupStore.writeBackup(dir, name, `{"n":${i}}`);
    }
    expect(backupStore.listBackups(dir)).toHaveLength(16);

    const removed = backupStore.pruneBackups(dir, backupStore.KEEP_BACKUPS);
    expect(removed).toHaveLength(2);
    const left = backupStore.listBackups(dir).map((entry) => entry.name);
    expect(left).toHaveLength(14);
    // 删的是最旧的两份（09-01 / 09-02），最新的必须留着
    expect(left).not.toContain('2026-09-01.json');
    expect(left).not.toContain('2026-09-02.json');
    expect(left).toContain('2026-09-16.json');
  });

  it('pre-restore.json 不占配额，也不会被清理', () => {
    backupStore.writeBackup(dir, 'pre-restore.json', '{"restore":true}');
    for (let i = 1; i <= 15; i += 1) {
      backupStore.writeBackup(dir, `2026-09-${String(i).padStart(2, '0')}.json`, `{"n":${i}}`);
    }
    backupStore.pruneBackups(dir, 14);
    const left = backupStore.listBackups(dir).map((entry) => entry.name);
    expect(left).toContain('pre-restore.json');
    expect(left.filter((name) => name !== 'pre-restore.json')).toHaveLength(14);
  });

  it('目录不存在时列表为空、prune 不抛', () => {
    const ghost = path.join(dir, 'nope');
    expect(backupStore.listBackups(ghost)).toEqual([]);
    expect(() => backupStore.pruneBackups(ghost, 14)).not.toThrow();
  });
});
