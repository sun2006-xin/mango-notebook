import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const backupStore = require('../backup-store.cjs');

/* ============================================================================
   QA 独立验证（v0.8 · F4）：桌面端文件备份的边界补充

   补的是工程师 11 条用例没覆盖的角：
   - 入参是 null / 数字（渲染进程的 payload 也可能是脏的）；
   - 同一天写两次（每天一份 → 覆盖，不能变成两份）；
   - 目录里混进非白名单文件 / 同名目录（既不能被删，也不能被列出来当真备份）；
   - size 报的是 UTF-8 字节（中文备份文件大小要能对上磁盘）；
   - keep=0 时 pre-restore 仍然不许被删。
   ========================================================================= */

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-backup-qa-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

describe('脏入参：一律拒绝且不抛', () => {
  it('readBackup / writeBackup 收到 null、数字、空串都返回 bad-name', () => {
    for (const bad of [null, undefined, 42, '', '   ']) {
      expect(() => backupStore.readBackup(dir, bad)).not.toThrow();
      expect(backupStore.readBackup(dir, bad)).toEqual({ ok: false, error: 'bad-name' });
      expect(() => backupStore.writeBackup(dir, bad, '{}')).not.toThrow();
      expect(backupStore.writeBackup(dir, bad, '{}')).toEqual({ ok: false, error: 'bad-name' });
    }
  });

  it('json 不是字符串 / 空串 → 不写盘', () => {
    expect(backupStore.writeBackup(dir, '2026-10-24.json', null).ok).toBe(false);
    expect(backupStore.writeBackup(dir, '2026-10-24.json', 42).ok).toBe(false);
    expect(backupStore.writeBackup(dir, '2026-10-24.json', '').ok).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('目录不存在时 writeBackup 会自己建目录（不能因为目录没建就丢备份）', () => {
    const nested = path.join(dir, 'a', 'b', 'backups');
    const result = backupStore.writeBackup(nested, '2026-10-24.json', '{"ok":true}');
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(nested, '2026-10-24.json'))).toBe(true);
  });
});

describe('每天一份：同名覆盖 + 不留临时文件', () => {
  it('同一天写两次 → 目录里仍只有 1 个文件，内容是最后一次', () => {
    backupStore.writeBackup(dir, '2026-10-24.json', '{"v":1}');
    backupStore.writeBackup(dir, '2026-10-24.json', '{"v":2}');
    expect(fs.readdirSync(dir)).toEqual(['2026-10-24.json']);
    expect(backupStore.readBackup(dir, '2026-10-24.json').json).toBe('{"v":2}');
  });

  it('size 报的是 UTF-8 字节（中文 3 字节/字，与磁盘大小一致）', () => {
    const json = JSON.stringify({ title: '复习单调栈' });
    const result = backupStore.writeBackup(dir, '2026-10-24.json', json);
    expect(result.ok).toBe(true);
    const onDisk = fs.statSync(path.join(dir, '2026-10-24.json')).size;
    expect(result.size).toBe(onDisk);
    expect(result.size).toBe(Buffer.byteLength(json, 'utf8'));
    expect(result.size).toBeGreaterThan(json.length); // 有中文 → 一定大于字符数
  });
});

describe('剪枝只动白名单内的日期文件', () => {
  it('混入 notes.txt / 残留 .tmp / 同名目录 → 既不列出来也不被删', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    // 断电 / 被强杀可能留下的半截文件：既不能当成备份，也不能被剪枝误删
    fs.writeFileSync(path.join(dir, '2026-09-30.json.tmp'), '{"partial":');
    fs.mkdirSync(path.join(dir, '2026-10-25.json')); // 同名目录（isFile 为假）
    backupStore.writeBackup(dir, '2026-10-24.json', '{"n":1}');

    const listed = backupStore.listBackups(dir).map((entry) => entry.name);
    expect(listed).toEqual(['2026-10-24.json']); // 目录 / 非白名单文件都不算备份

    backupStore.pruneBackups(dir, 0);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '2026-09-30.json.tmp'))).toBe(true);
    expect(fs.statSync(path.join(dir, '2026-10-25.json')).isDirectory()).toBe(true);
    // 唯一的日期备份被删掉了（keep=0）
    expect(fs.existsSync(path.join(dir, '2026-10-24.json'))).toBe(false);
  });

  it('16 份日期备份 + pre-restore → 剪完剩 14 份日期备份，pre-restore 永远保留', () => {
    backupStore.writeBackup(dir, 'pre-restore.json', '{"restore":true}');
    for (let i = 1; i <= 16; i += 1) {
      backupStore.writeBackup(dir, `2026-09-${String(i).padStart(2, '0')}.json`, `{"n":${i}}`);
    }
    const removed = backupStore.pruneBackups(dir, 14);
    expect(removed).toHaveLength(2);

    const left = backupStore.listBackups(dir).map((entry) => entry.name);
    expect(left.filter((name) => name === 'pre-restore.json')).toHaveLength(1);
    expect(left.filter((name) => name !== 'pre-restore.json')).toHaveLength(14);
    // 留下的是**最新**的 14 份
    expect(left).toContain('2026-09-16.json');
    expect(left).not.toContain('2026-09-01.json');
    expect(left).not.toContain('2026-09-02.json');
  });

  it('重复剪枝是幂等的（第二次不删任何东西）', () => {
    for (let i = 1; i <= 15; i += 1) {
      backupStore.writeBackup(dir, `2026-09-${String(i).padStart(2, '0')}.json`, `{"n":${i}}`);
    }
    expect(backupStore.pruneBackups(dir, 14)).toHaveLength(1);
    expect(backupStore.pruneBackups(dir, 14)).toHaveLength(0);
    expect(backupStore.listBackups(dir)).toHaveLength(14);
  });
});
