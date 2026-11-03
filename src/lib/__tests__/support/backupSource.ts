import type { BackupSource } from '../../storage';

/**
 * 测试用：造一份「备份来源」，只写你关心的那几个集合，其余补空数组。
 *
 * 为什么需要：`buildBackupPayload` 现在收一个对象（`BackupSource`）而不是六个
 * 位置参数 —— 位置参数靠顺序，`notes` 与 `focusSessions` 类型都是数组，
 * 写反了照样编译通过，导出文件里两样东西互换。改成按名字取之后，
 * 每个测试都得凑齐六个字段，太吵；这里给个默认值，语义保持"没写的=空"。
 *
 * ⚠️ 这里的空数组清单**故意不写成可选的**：`BackupSource` 将来加第 7 个集合时，
 * 这个对象字面量会缺字段 → 编译报错 → 强制有人来处理，
 * 而不是悄悄给个默认值让测试一路绿到底。
 */
export function backupSource(
  parts: Partial<BackupSource> & { settings: BackupSource['settings'] },
): BackupSource {
  return {
    tasks: [],
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
    ...parts,
  };
}
