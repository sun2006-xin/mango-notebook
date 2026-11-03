# -*- coding: utf-8 -*-
"""
生成在线更新清单 → `dist-publish/update/`。

产出结构：
    update/version.json        清单（版本、构建 ID、逐文件 sha256）
    update/app/...             桌面端要热替换的那套前端文件
    update/daily-todo.apk      安卓安装包（存在才打包）

为什么**逐文件列哈希**而不是丢一个 zip：
1. 客户端可以只下载变化的那几个文件 —— 支付宝离线包的「增量差分」就是这个思路，
   我们这里用文件级差分已经足够（整个前端才 11 个文件）；
2. 省掉在主进程里实现 zip 解压（Node 没有内置 zip，引第三方库不值当）；
3. 每个文件单独校验，坏一个重下一个，不会"整包重来"。

用法：python scripts/make_update.py
"""
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist-single'
PUBLISH = ROOT / 'dist-publish'
OUT = PUBLISH / 'update'
# app 已改名为「芒果本本」，APK 归档名同步；旧名 每日待办-Android版.apk 已废弃
APK = ROOT / 'release' / '芒果本本-Android版.apk'
GRADLE = ROOT / 'android' / 'app' / 'build.gradle'


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def read_version_code() -> int:
    """从 build.gradle 里读 versionCode —— 它是安卓判定「谁更新」的唯一依据。"""
    try:
        for line in GRADLE.read_text(encoding='utf-8').splitlines():
            s = line.strip()
            if s.startswith('versionCode'):
                return int(s.split()[-1])
    except (OSError, ValueError):
        pass
    return 0


def collect_files() -> list[dict]:
    """dist-single 下要下发的文件（相对路径 + 哈希 + 大小）。"""
    files = []
    for path in sorted(DIST.rglob('*'), key=lambda p: p.relative_to(DIST).as_posix()):
        if not path.is_file():
            continue
        rel = path.relative_to(DIST).as_posix()
        files.append({'path': rel, 'sha256': sha256_of(path), 'size': path.stat().st_size})
    return files


def main() -> None:
    if not (DIST / 'index.html').exists():
        raise SystemExit('找不到 dist-single/index.html，先跑 npm run desktop:build')

    info = json.loads((ROOT / 'build-info.json').read_text(encoding='utf-8'))
    files = collect_files()

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / 'app').mkdir(parents=True)

    for item in files:
        src = DIST / item['path']
        dst = OUT / 'app' / item['path']
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    manifest = {
        'version': info['version'],
        'buildId': info['buildId'],
        'builtAt': info['builtAt'],
        'publishedAt': datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        # 桌面端：按文件清单热替换 resources/web（或 userData/web）
        'desktop': {'base': 'app/', 'files': files},
        # 网页端：同样比对 buildId，只是它自己会刷新
        'web': {'buildId': info['buildId']},
    }

    if APK.exists():
        shutil.copy2(APK, OUT / 'daily-todo.apk')
        manifest['android'] = {
            'version': info['version'],
            'versionCode': read_version_code(),
            'url': 'daily-todo.apk',
            'sha256': sha256_of(APK),
            'size': APK.stat().st_size,
        }
        print('已打包 APK：' + str(round(APK.stat().st_size / 1048576, 2)) + ' MB')
    else:
        print('提示：没有找到 APK，本次清单不含安卓条目')

    (OUT / 'version.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print('更新清单已生成：' + str(OUT / 'version.json'))
    print('  版本 ' + info['version'] + ' / build ' + info['buildId'] + ' / ' + str(len(files)) + ' 个文件')


if __name__ == '__main__':
    main()
