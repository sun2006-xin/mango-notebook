# -*- coding: utf-8 -*-
"""
桌面端一键更新：构建 → 内联图标 → 铺到两个交付目录 → 重打 app.asar → 打绿色版 zip。

覆盖两处（都必须更新，否则新旧代码混跑）：
- `../daily-todo-desktop/resources/`  ← 用户日常双击的那个绿色版
- `release/win-unpacked/resources/`   ← Windows 绿色版 zip 的源目录

只动 `web/` 与 `app.asar`，**不碰 exe**。

⚠️ 还会同步 `%APPDATA%\\daily-todo\\web`（热更新换入的那套）——**必须同步**：
主进程加载前端时优先用这个目录，出厂包只是最后的安全垫。
只更出厂包的话，桌面端跑的还是旧的热更新包，于是每次启动都发现
"线上比我新" → 反复提示更新（v0.22 踩过，用户以为是更新坏了）。
同步范围严格限定在 `web/` 子目录 + 三个标记文件，**不碰 Local Storage 等用户数据**。

用法：python scripts/release_desktop.py [--skip-build]
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist-single'
DESKTOP = ROOT.parent / 'daily-todo-desktop' / 'resources'
WIN = ROOT / 'release' / 'win-unpacked' / 'resources'

# 交付的 exe 文件名（跟 electron-builder 的 productName 走）
EXE_NAME = Path('芒果本本.exe')

ASAR_PKG = {
    'name': 'daily-todo',
    'version': '0.1.0',
    'main': 'electron/main.cjs',
    'private': True,
}


def emit(*args) -> None:
    """
    打印，但**绝不让管道问题打断发布**。

    踩过的坑：`python scripts/release_desktop.py | head -3` 里的 head 读够 3 行就关管道，
    Python 下一次 print 抛 BrokenPipeError，进程在半途被杀 —— 结果 app.asar 和出厂
    `web/` 都没铺完，而终端看起来"跑完了"。发布脚本不该因为你看日志的方式而半途而废。
    """
    try:
        print(*args)
    except (BrokenPipeError, OSError):
        try:
            sys.stdout = open(os.devnull, 'w', encoding='utf-8')
        except OSError:
            pass


def read_env_value(key: str) -> str:
    """从 .env.local 读一个值（没有就回落到环境变量）。

    为什么不用 python-dotenv：这是发布脚本，多一个依赖只为读一个键不值当；
    格式也只有 `KEY=VALUE` 一种（见 .env.example）。
    """
    path = ROOT / '.env.local'
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            if k.strip() == key:
                return v.strip()
    except OSError:
        pass
    return os.environ.get(key, '')


def asar_package_json() -> dict:
    """
    asar 里的 package.json。

    `buildId` 是关键：主进程用它判断"我这个已安装的版本是哪一版"，
    再和服务器上的 version.json 比对决定要不要下载更新。
    没写进去的话主进程只能拿到 'unknown'，每次启动都会重复下载同一个包。
    """
    info = {}
    try:
        info = json.loads((ROOT / 'build-info.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        emit('!! 读不到 build-info.json，asar 将不带 buildId（更新检查会失效）')

    pkg = dict(ASAR_PKG)
    if info.get('version'):
        pkg['version'] = info['version']
    pkg['buildId'] = info.get('buildId', 'unknown')
    # 分享码：**单一真相是 .env.local**（与渲染层同源，见 src/lib/update.ts）。
    # 主进程读不到 import.meta.env，所以在这里把它烘进 asar 内的 package.json。
    # 仓库的 package.json 已经不存这个字段了 —— 它是部署信息，不该进开源仓库。
    # 更新源域名同样来自 .env.local：客户端产物里不再出现发布域名
    deploy_origin = read_env_value('VITE_CLOUD_ENDPOINT').rstrip('/')
    if deploy_origin:
        pkg['deployOrigin'] = deploy_origin
    share_code = read_env_value('VITE_SHARE_CODE')
    if share_code:
        pkg['shareCode'] = share_code
    else:
        emit('!! .env.local 里没有 VITE_SHARE_CODE：桌面端自动更新会失效（其余功能不受影响）')
    return pkg


def run(cmd, cwd=ROOT):
    emit('$ ' + ' '.join(cmd))
    result = subprocess.run(cmd, cwd=str(cwd), shell=(sys.platform == 'win32'))
    if result.returncode != 0:
        raise SystemExit('命令失败: ' + ' '.join(cmd))


def main():
    skip_build = '--skip-build' in sys.argv

    if not skip_build:
        run(['npm', 'run', 'desktop:build'])
    run([sys.executable, 'scripts/inline_icons.py'])

    for target in (DESKTOP, WIN):
        web = target / 'web'
        web.mkdir(parents=True, exist_ok=True)
        for name in ('index.html', 'manifest.webmanifest', 'sw.js'):
            shutil.copy2(DIST / name, web / name)
        # 就地覆盖，不 rmtree —— 沙箱的删除回收站对个别目录会 flaky
        # （genie-trash 报 "Some operations were aborted"），而且图标集是稳定的，
        # 覆盖写完全够用，删了反而引入一个不必要的失败点
        icons = web / 'icons'
        icons.mkdir(parents=True, exist_ok=True)
        for src_file in sorted((DIST / 'icons').iterdir()):
            shutil.copy2(src_file, icons / src_file.name)
        emit('已同步 web -> ' + str(web))

    # app.asar 内容：整个 electron/（主进程与它 require 的模块）+ dist-single + package.json
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / 'src'
        # ⚠️ 必须整目录拷，不能只拷 main.cjs。
        # 曾经这里写死 `copy2(main.cjs)`，后来 main.cjs 新增了
        # `require('./serve-guard.cjs')`，而 serve-guard.cjs 没进包 ——
        # 结果应用启动即 "Cannot find module"，窗口永远不出现，
        # 又因为 uncaughtException 兜底只记日志不退出，进程一直赖在后台占着 exe。
        # 整目录拷贝之后，electron/ 里再加文件不需要改这个脚本。
        shutil.copytree(
            ROOT / 'electron',
            src / 'electron',
            ignore=shutil.ignore_patterns('__tests__'),
        )
        shutil.copytree(DIST, src / 'dist-single')
        (src / 'package.json').write_text(
            json.dumps(asar_package_json(), indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

        out = Path(tmp) / 'app.asar'
        run(['npx', 'asar', 'pack', str(src), str(out)])
        for target in (DESKTOP, WIN):
            shutil.copy2(out, target / 'app.asar')
            emit('已覆盖 app.asar -> ' + str(target / 'app.asar'))

    info = build_info()
    sync_hot_update_dir(str(info.get('version', '')), str(info.get('buildId', '')))

    patch_exe_icon()
    run([sys.executable, 'scripts/package_win_zip.py'])

    consistent = verify()
    emit('桌面端交付更新完成（exe 与用户数据均未改动）')
    if not consistent:
        emit('')
        emit('!! 上面有不一致的产物：桌面端可能仍在跑旧版，并会在每次启动时提示更新。')
        sys.exit(1)


# ---------------------------------------------------------------------------
# 热更新目录（%APPDATA%\daily-todo\web）
# ---------------------------------------------------------------------------


def build_info() -> dict:
    try:
        return json.loads((ROOT / 'build-info.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def hot_web_dirs() -> list[Path]:
    """
    已经存在、并且真的在被使用的"热更新生效目录"。

    Electron 的 userData 在 Windows 上是 `%APPDATA%/<asar-package-name>`，
    这里的 name 固定是 `daily-todo`（见 asar_package_json）。
    目录不存在就返回空 —— 说明这台机器从没走过在线热更新，没什么要同步的。
    """
    appdata = os.environ.get('APPDATA')
    if not appdata:
        return []
    web = Path(appdata) / 'daily-todo' / 'web'
    return [web] if (web / 'index.html').is_file() else []


def sync_hot_update_dir(version: str, build_id: str) -> None:
    """
    把新版写进热更新目录（如果它存在）。

    ⚠️ 这一步**不能省**。`electron/main.cjs` 的加载优先级是：

        userData/web （热更新换入的）  >  resources/web （出厂包，最后的安全垫）

    所以只要这台机器曾经自动更新过一次，出厂包就**再也不会被读到** ——
    我在 `resources/web` 里铺的新版等于白铺，桌面端跑的还是那份旧包，
    于是每次启动都发现"线上比我新"，反复提示更新。
    （v0.22 就是这样被用户发现的："你不是直接更新桌面端吗，怎么每次还要更新"。）

    同步范围严格限定：`web/` 子目录 + 两个标记文件。
    **不碰** `Local Storage` / `Session Storage` —— 那些才是用户数据。
    """
    for web in hot_web_dirs():
        for name in ('index.html', 'manifest.webmanifest', 'sw.js'):
            shutil.copy2(DIST / name, web / name)
        icons = web / 'icons'
        icons.mkdir(parents=True, exist_ok=True)
        for src_file in sorted((DIST / 'icons').iterdir()):
            shutil.copy2(src_file, icons / src_file.name)

        base = web.parent
        # 身份证：`updater.localBuildId()` 读的就是它。不改的话它会一直报旧 buildId
        (base / 'web.active.json').write_text(
            json.dumps(
                {'version': version, 'buildId': build_id, 'at': int(time.time() * 1000)},
                ensure_ascii=False,
            ),
            encoding='utf-8',
        )
        # 通行证：缺了会被 settleAtBoot 判成"换入后没渲染成功" → 回滚 + 拉黑整个构建。
        # 我们写进去的就是刚发布、已验证的那份产物，所以直接发证。
        (base / 'web.ok').write_text(str(int(time.time() * 1000)), encoding='utf-8')
        # 旧的"待换入 / 可回滚"包清掉：内容已是新版，回滚到它们只会退回更旧的版本
        for stale in ('web.prev', 'web.staging'):
            target = base / stale
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
        staging_mark = base / 'web.staging.json'
        if staging_mark.exists():
            staging_mark.unlink(missing_ok=True)
        emit('已同步热更新目录 -> ' + str(web))


def verify() -> bool:
    """
    三处产物的 `index.html` 必须**字节一致**。

    不一致就是"下次启动又被提示更新"或"跑的其实是旧版"的伏笔，
    而这两种症状在终端里完全看不出来 —— 所以打三个哈希，让它们自己说话。
    """
    reference = (DIST / 'index.html').read_bytes()
    digest = hashlib.sha256(reference).hexdigest()[:12]
    emit('')
    emit('校验 index.html（应为同一个哈希 ' + digest + '）:')
    all_ok = True
    targets = [('dist-single', DIST)] + [
        ('绿色版', DESKTOP / 'web'),
        ('win-unpacked', WIN / 'web'),
    ] + [('热更新目录', d) for d in hot_web_dirs()]
    for label, directory in targets:
        target = directory / 'index.html'
        if not target.is_file():
            emit('  [缺失] ' + label + ' -> ' + str(target))
            all_ok = False
            continue
        data = target.read_bytes()
        same = data == reference
        all_ok = all_ok and same
        emit(
            '  [' + ('OK  ' if same else '不一致') + '] '
            + label + '  ' + str(len(data)) + ' bytes  '
            + hashlib.sha256(data).hexdigest()[:12]
        )
    return all_ok


# ---------------------------------------------------------------------------
# exe 文件图标
# ---------------------------------------------------------------------------
# 为什么需要这一步：exe **文件**图标是打包时烘进 PE 资源段的，
# 换 `resources/web` 或 `app.asar` 都不会动它 —— 那正是"网页和窗口图标都换了、
# 资源管理器里还是旧图标"的原因。
#
# 正常做法是 electron-builder 重打一次，但它要从网上下载 electron / winCodeSign，
# 网络一抖就是 502。所以这里改用 electron-winstaller 自带的 rcedit 直接改资源段：
# 不重打包、不联网、不动其它任何东西。
#
# 两个坑：
# ① rcedit 读不了中文文件名（Fatal error: Unable to load file）→ 用 ASCII 名中转；
# ② 应用正在运行时 exe 被锁（Unable to commit changes）→ 先改名再放新文件
#    （Windows 允许重命名运行中的 exe，不允许覆盖写）。
def patch_exe_icon():
    rcedit = ROOT / 'node_modules' / 'electron-winstaller' / 'vendor' / 'rcedit.exe'
    ico = ROOT / 'public' / 'icons' / 'app.ico'
    if not rcedit.exists() or not ico.exists():
        emit('跳过 exe 图标（缺 rcedit 或 app.ico）')
        return

    # DESKTOP / WIN 指向的是 **resources** 目录，exe 在它的父目录
    for target in (DESKTOP.parent, WIN.parent):
        exe = target / EXE_NAME
        if not exe.exists():
            emit('跳过 exe 图标（找不到 ' + str(exe) + '）')
            continue

        tmp = target / '_icon_patch.exe'
        shutil.copy2(exe, tmp)
        result = subprocess.run([str(rcedit), str(tmp), '--set-icon', str(ico)])
        if result.returncode != 0:
            tmp.unlink(missing_ok=True)
            emit('!! exe 图标替换失败：' + str(exe))
            continue

        # 换回中文名。原文件若被运行中的进程锁住：改名放走它，再放入新文件。
        try:
            shutil.move(str(tmp), str(exe))
        except PermissionError:
            stale = target / (EXE_NAME.stem + '.old.exe')
            stale.unlink(missing_ok=True)
            exe.rename(stale)
            shutil.move(str(tmp), str(exe))
            emit('（应用正在运行，旧 exe 已改名为 ' + stale.name + '，关闭后可删）')
        emit('已更新 exe 图标 -> ' + str(exe))


if __name__ == '__main__':
    main()
