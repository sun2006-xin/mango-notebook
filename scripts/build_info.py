# -*- coding: utf-8 -*-
"""
生成构建标识 `build-info.json`（被 vite.config.ts 读取并注入前端）。

为什么用**源码内容哈希**而不是时间戳：
时间戳的问题很具体 —— 同一份代码重新打一次包，buildId 就变了，
于是所有客户端都会收到一次"有新版本"的提示，点进去装完发现什么都没变。
内容哈希则满足「同代码 ⇒ 同 ID」，只有真的改了东西才会提醒升级。

哈希范围刻意排除 node_modules / dist* / release / android，
只覆盖真正会改变运行结果的文件（源码、静态资源、构建配置）。

用法：python scripts/build_info.py
"""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'build-info.json'

# 参与哈希的入口（目录会递归，文件则单算）
SOURCES = [
    'src',
    'public',
    # 桌面端主进程也进哈希。
    # 为什么必须：以前只哈希前端，于是改了 electron/main.cjs / updater.cjs
    # 之后 buildId 不变 → 桌面端永远显示"已是最新"，而热更新本来就只换前端
    # 那 9 个文件 —— 主进程的改动永远到不了用户机器，还没人知道。
    'electron',
    'index.html',
    'package.json',
    'vite.config.ts',
    'tailwind.config.ts',
    'postcss.config.js',
    'tsconfig.json',
]
# 明确排除：产物目录、依赖、以及本文件自己（否则会自我循环）
IGNORE_PARTS = {'node_modules', 'dist', 'dist-single', 'dist-publish', '.git', '__tests__'}


def collect() -> list[Path]:
    files: list[Path] = []
    for entry in SOURCES:
        target = ROOT / entry
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            for path in target.rglob('*'):
                if path.is_file() and not (IGNORE_PARTS & set(path.parts)):
                    files.append(path)
    return sorted(files, key=lambda p: p.as_posix())


def read_android_version_code() -> int:
    """
    读安卓的 versionCode 一起写进构建标识。

    为什么需要它：安卓端判断"要不要更新"必须用 versionCode，不能用网页的 buildId。
    否则只发网页版（没重打 APK）时，线上的 buildId 变了、而 APK 里的还是旧的，
    于是手机会永远提示"有新版本"、点进去下载的却还是同一个包 —— 死循环。
    安卓只有 versionCode 能表达"这个安装包比我新"。
    """
    try:
        for line in (ROOT / 'android' / 'app' / 'build.gradle').read_text(encoding='utf-8').splitlines():
            s = line.strip()
            if s.startswith('versionCode'):
                return int(s.split()[-1])
    except (OSError, ValueError):
        pass
    return 0


def main() -> None:
    digest = hashlib.sha256()
    count = 0
    for path in collect():
        rel = path.relative_to(ROOT).as_posix()
        digest.update(rel.encode('utf-8'))
        digest.update(b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
        count += 1

    build_id = digest.hexdigest()[:12]
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']

    info = {
        'version': version,
        'buildId': build_id,
        'builtAt': datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'sourceFiles': count,
        'androidVersionCode': read_android_version_code(),
    }
    OUT.write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('build-info: v' + str(version) + ' build ' + build_id
          + ' / android versionCode ' + str(info['androidVersionCode'])
          + '（' + str(count) + ' 个源文件）')


if __name__ == '__main__':
    main()
