# -*- coding: utf-8 -*-
"""
把 dist-single/index.html 里引用的图标内联成 base64 data URI，产出 dist-publish/。

为什么要内联：分享链接环境下，页面只会取回 index.html 这一个文件，
对 icons/*.png 的二次请求会被拦（403），图标全变裂图。内联后零外部请求。

用法：python scripts/inline_icons.py
"""
import base64
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
def _pick_src() -> Path:
    """网页产物优先取 dist-web（带云配置的那份构建）。

    为什么：桌面端与安卓是**纯本地**构建（`--mode local`，不含任何凭据），
    而网页版要保留登录/同步。所以两者必须分成两个目录 ——
    网页发布只能来自 dist-web，绝不能从 dist-single 抄。
    """
    web = ROOT / 'dist-web'
    return web if (web / 'index.html').exists() else ROOT / 'dist-single'


SRC = _pick_src()
DST = ROOT / 'dist-publish'

MIME = {'.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'}


def data_uri(path: Path) -> str:
    suffix = path.suffix.lower()
    mime = MIME.get(suffix, 'application/octet-stream')
    raw = path.read_bytes()
    return 'data:' + mime + ';base64,' + base64.b64encode(raw).decode('ascii')


def main() -> None:
    if not (SRC / 'index.html').exists():
        raise SystemExit('找不到网页产物：先跑 npm run web:build（它输出到 dist-web）')

    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    html = (SRC / 'index.html').read_text(encoding='utf-8')

    # 逐个图标文件替换：目录里有啥就内联啥，不写死文件名，
    # 免得以后加了新尺寸忘了同步这里。
    icons_dir = SRC / 'icons'
    replaced = 0
    for icon in sorted(icons_dir.iterdir()):
        for pattern in ('./icons/' + icon.name, 'icons/' + icon.name):
            if pattern in html:
                html = html.replace(pattern, data_uri(icon))
                replaced += 1

    (DST / 'index.html').write_text(html, encoding='utf-8')

    for name in ('manifest.webmanifest', 'sw.js'):
        src = SRC / name
        if src.exists():
            shutil.copy2(src, DST / name)

    # icons/ 一并留下：桌面端与离线缓存仍按路径取，不影响网页版内联结果
    if icons_dir.exists():
        shutil.copytree(icons_dir, DST / 'icons')

    kb = len(html.encode('utf-8')) / 1024
    print('已内联 ' + str(replaced) + ' 处图标引用 -> dist-publish/index.html (' + format(kb, '.1f') + ' kB)')
    print('外部图标引用剩余: ' + str(html.count('icons/')))

    # 顺手把在线更新清单也生成出来 —— 它属于"让 dist-publish 变成一份完整可发布产物"，
    # 放在这里可以避免"发布了网站但忘了生成清单，客户端永远收不到更新"。
    import subprocess
    import sys
    subprocess.run([sys.executable, str(ROOT / 'scripts' / 'make_update.py')], check=False)


if __name__ == '__main__':
    main()
