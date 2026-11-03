#!/usr/bin/env python3
"""开源前自检：仓库里（以及 git 历史里）有没有不该出现的东西。

用法：
    python scripts/scan_secrets.py              # 扫工作区（默认）
    python scripts/scan_secrets.py --zip ../x.zip   # 扫交接压缩包
    python scripts/scan_secrets.py --history    # 扫 git 历史（关键！）

为什么需要它：
    代码里把凭据挪进 `.env.local` 只解决了"**当前**源码"。
    **历史提交里的旧 blob 仍然带着凭据** —— 只要 push 带历史，
    别人 `git log -p` 就能捞出来。这个脚本把"看得见"和"看不见"的两层一起查。

    ⚠️ 2026-11-04 补强：旧版按"文本后缀"过滤，`.properties` 不在列表里，
       于是 `android/keystore.properties`（含真实 storePassword / keyPassword）
       被整个跳过，交接包报了"干净，可以开源"。现在按**文件名**兜底：
       本机私有文件允许留在工作区，但出现在任何压缩包里一律报红。

退出码：0 = 干净；1 = 发现问题。
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 构建产物与依赖不算（它们本来就含运行时数据）
SKIP_DIRS = {
    'node_modules', '.git', 'dist', 'dist-single', 'dist-web', 'dist-publish',
    'release', 'build', '.gradle', '.vite', 'coverage', '.tmp', 'private-backups',
    # `npx cap sync` 生成的部署配置（已在 .gitignore 里），每次都从 capacitor.config.ts 重算
    'assets',
}
SKIP_SUFFIX = {'.log', '.jks', '.keystore', '.apk', '.zip', '.png', '.jpg', '.ico', '.woff2'}

# 本机私有文件：源仓库里允许存在（.gitignore 已忽略），但**绝不能进任何交接/开源压缩包**。
# 这是文件名级风险，内容正则兜不住：文件可以叫别的名字、值也可以不是 wbpk_ 开头。
PRIVATE_FILENAMES = {
    'keystore.properties',   # Android 签名库口令 / 密钥口令
    'signing.properties',
    '.env.local',
}

# 构建机生成配置：由 capacitor.config.ts 在**那台机器上**重算，内容是那台机器的 origin
# （本机就是项目方部署域名）。它常被放在被 SKIP_DIRS 跳过的 assets/ 里，
# 所以必须在目录过滤之前按文件名拦一次。
GENERATED_IN_ZIP_BAN = {'capacitor.config.json'}

# 工作区里允许存在（本机私有 / 安全假值）
ALLOWED_FILES = {'.env.local', '.env.test'}
# 压缩包里只允许安全假值；其余本机私有文件一律报红
ALLOWED_IN_ZIP = {'.env.test'}

PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ('云端 publishableKey', re.compile(r'wbpk_[A-Za-z0-9_]{20,}'), '凭据：任何构建都能拿它连你的云'),
    ('云端 resourceId', re.compile(r'wbcs_[A-Za-z0-9]{12,}'), '部署标识：暴露你的云资源'),
    ('部署域名', re.compile(r'[a-z0-9-]+\.app\.workbuddy\.host'), '部署标识：指向你的实例'),
    ('分享码', re.compile(r'(?i)sharecode=(?!YOUR)[A-Z0-9]{8,}'), '访问门禁：公开后会被爬'),
    ('疑似私钥', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'), '绝对不能出现'),
]

# `.properties` 里的非空口令赋值（占位值不算）。只报行号，不打印值。
SECRET_ASSIGNMENT = re.compile(
    r'(?i)^\s*(?:store|key|keystore|signing)?password\s*=\s*'
    r'(?!\s*$)(?!YOUR|your|xxx|example|placeholder|changeme|<)\S{4,}'
)

TEXT_SUFFIX = {
    '.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '.md', '.py', '.html', '.css',
    '.gradle', '.xml', '.yml', '.yaml', '.txt', '.example', '.test', '.local',
    '.properties', '',
}


def iter_files(base: Path):
    for p in base.rglob('*'):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(base).parts):
            continue
        if p.suffix.lower() in SKIP_SUFFIX:
            continue
        if p.suffix.lower() not in TEXT_SUFFIX:
            continue
        yield p


def scan_text(name: str, text: str) -> list[str]:
    hits: list[str] = []
    is_properties = name.lower().endswith('.properties')
    for line_no, line in enumerate(text.splitlines(), 1):
        for label, pattern, why in PATTERNS:
            if pattern.search(line):
                hits.append(f'  {name}:{line_no}  [{label}] {why}')
        # 即使文件名检查被绕过（例如改叫 android-signing.conf），
        # 只要还是 .properties 且写了非空口令，就再报一次
        if is_properties and SECRET_ASSIGNMENT.search(line):
            hits.append(f'  {name}:{line_no}  [签名/密钥口令] 压缩包里出现非空口令赋值')
    return hits


def scan_workspace() -> tuple[int, list[str]]:
    hits: list[str] = []
    scanned = 0
    for path in iter_files(ROOT):
        rel = path.relative_to(ROOT).as_posix()
        # 本机私有的文件允许存在，不报（它们本来就在 .gitignore 里）
        if path.name in ALLOWED_FILES or path.name in PRIVATE_FILENAMES:
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        scanned += 1
        hits.extend(scan_text(rel, text))
    return scanned, hits


def scan_zip(zip_path: Path) -> tuple[int, list[str]]:
    hits: list[str] = []
    scanned = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            parts = info.filename.split('/')
            filename = parts[-1]
            # ⚠️ 文件名检查必须放在**目录过滤之前**：私有/生成文件常常正好落在
            #    assets/、dist/ 这些被跳过的目录里，放后面等于没查。
            if filename in ALLOWED_IN_ZIP:
                continue
            if filename in ALLOWED_FILES or filename in PRIVATE_FILENAMES:
                hits.append(f'  {info.filename}  [本机私有文件] 不该出现在压缩包里')
                continue
            if filename in GENERATED_IN_ZIP_BAN:
                hits.append(f'  {info.filename}  [构建机生成配置] 含本机 origin，不该出现在压缩包里')
                continue
            if any(part in SKIP_DIRS for part in parts):
                continue
            if Path(info.filename).suffix.lower() not in TEXT_SUFFIX:
                continue
            try:
                text = z.read(info).decode('utf-8')
            except (UnicodeDecodeError, KeyError):
                continue
            scanned += 1
            hits.extend(scan_text(info.filename, text))
    return scanned, hits


def scan_history() -> list[str]:
    """git 历史里出现过的凭据（只报"有没有"，不打印具体值）。"""
    problems: list[str] = []
    try:
        for label, pattern, _ in PATTERNS[:2]:  # 只查最要命的两个：key 与 resourceId
            token = 'wbpk_' if label.endswith('publishableKey') else 'wbcs_'
            out = subprocess.run(
                ['git', 'log', '--all', '--oneline', '-S', token],
                cwd=ROOTS(), capture_output=True, text=True, timeout=120,
            )
            if out.returncode != 0:
                problems.append(f'  !! 无法读取 git 历史（{out.stderr.strip()[:80]}）')
                continue
            lines = [ln for ln in out.stdout.splitlines() if ln.strip()]
            if lines:
                problems.append(f'  !! 历史里有 {len(lines)} 个提交含 `{token}`，例如：{lines[0][:60]}')
    except FileNotFoundError:
        problems.append('  !! 找不到 git 命令（跳过历史检查）')
    return problems


def ROOTS() -> Path:  # noqa: N802 - 小写函数名与 git 风格保持一致即可
    return ROOT


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', type=Path, help='扫一个交接压缩包')
    ap.add_argument('--history', action='store_true', help='额外检查 git 历史')
    args = ap.parse_args()

    if args.zip:
        scanned, hits = scan_zip(args.zip)
        print(f'扫描压缩包 {args.zip.name}：{scanned} 个文本文件')
    else:
        scanned, hits = scan_workspace()
        print(f'扫描工作区：{scanned} 个文本文件（已跳过依赖/产物/本机私有文件）')

    hist = scan_history() if args.history else []

    if hits:
        print(f'\n发现 {len(hits)} 处不该出现的内容：')
        for line in hits[:40]:
            print(line)
        if len(hits) > 40:
            print(f'  …… 另有 {len(hits) - 40} 处')
    else:
        print('  ✓ 未发现凭据 / 部署标识 / 私有文件')

    if hist:
        print('\ngit 历史检查：')
        for line in hist:
            print(line)
        print('  → 处理办法：删掉 .git 重新 init（推荐），或用 git filter-repo 重写历史')

    ok = not hits and not hist
    print('\n结论：' + ('干净，可以开源' if ok else '先把上面这些处理掉再开源'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
