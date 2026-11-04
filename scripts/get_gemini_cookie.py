#!/usr/bin/env python
"""获取 Gemini 网页版 cookie（比桌面客户端导出的持久）。

为什么需要这个：
  从 Gemini **桌面客户端**导出的 cookie 寿命很短——实测生成 10 张图后
  就变成 1016 UNAUTHENTICATED。而**网页版**（gemini.google.com）的
  __Secure-1PSID 有效期约 400 天。

用法：
    # 方式 1：交互式打开浏览器登录（推荐）
    python get_gemini_cookie.py

    # 方式 2：从已登录的 Chrome 读（需要关掉 Chrome）
    python get_gemini_cookie.py --from-chrome

    # 方式 3：手工粘贴（最快）
    python get_gemini_cookie.py --manual
"""

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = Path(__file__).parent.parent
OUT = BASE / 'scripts' / 'gemini-cookies.json'
PROXY = 'socks5h://127.0.0.1:10808'


def save(psid: str, psidts: str) -> None:
    data = {}
    if OUT.exists():
        try:
            data = json.loads(OUT.read_text(encoding='utf-8'))
        except Exception:  # noqa: BLE001
            data = {}
    data['__Secure-1PSID'] = psid
    if psidts:
        data['__Secure-1PSIDTS'] = psidts
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n✅ 已写入 {OUT}')


def verify(psid: str, psidts: str) -> bool:
    """立刻验证 cookie 能不能出图。"""
    import asyncio

    async def run() -> bool:
        from gemini_webapi import GeminiClient

        client = GeminiClient(psid, psidts or None, proxy=PROXY)
        await client.init(timeout=60, auto_close=False, auto_refresh=True)
        print(f'  account_status: {client.account_status}')

        if int(client.account_status) != 1000:
            print('  ❌ 状态不是 AVAILABLE(1000)')
            await client.close()
            return False

        print('  状态正常，试生成一张图 ...')
        resp = await client.generate_content('画一只猫')
        ok = len(resp.images) > 0
        print(f'  图片数: {len(resp.images)}')
        if not ok:
            print(f'  文本回复: {(resp.text or "")[:120]}')
        await client.close()
        return ok

    try:
        return asyncio.run(run())
    except Exception as e:  # noqa: BLE001
        print(f'  ❌ 验证失败: {type(e).__name__}: {e}')
        return False


def from_manual() -> int:
    print('请从浏览器复制两个 cookie 值：')
    print('  https://gemini.google.com → F12 → Application → Cookies')
    print()
    psid = input('__Secure-1PSID: ').strip()
    if not psid:
        print('❌ PSID 为空')
        return 1
    psidts = input('__Secure-1PSIDTS（可选，直接回车跳过）: ').strip()

    print('\n验证中 ...')
    if verify(psid, psidts):
        save(psid, psidts)
        print('✅ 验证通过')
        return 0

    print('\n⚠️ 验证失败，但仍然保存（可能是临时问题）')
    save(psid, psidts)
    return 1


def from_chrome() -> int:
    """从 Chrome 的 Cookies 库读（需要先关掉 Chrome）。"""
    try:
        import browser_cookie3  # type: ignore
    except ImportError:
        print('❌ 需要先安装: pip install browser-cookie3')
        return 1

    print('从 Chrome 读 cookie（如果 Chrome 在运行请先关闭）...')
    try:
        jar = browser_cookie3.chrome(domain_name='google.com')
    except Exception as e:  # noqa: BLE001
        print(f'❌ 读取失败: {e}')
        print('   提示：完全退出 Chrome 后重试')
        return 1

    psid = psidts = ''
    for c in jar:
        if c.name == '__Secure-1PSID':
            psid = c.value
        elif c.name == '__Secure-1PSIDTS':
            psidts = c.value

    if not psid:
        print('❌ 没找到 __Secure-1PSID，可能 Chrome 里没登录 Gemini')
        return 1

    print(f'找到 PSID（长度 {len(psid)}）')
    print('\n验证中 ...')
    if verify(psid, psidts):
        save(psid, psidts)
        print('✅ 验证通过')
        return 0

    print('\n⚠️ 验证失败')
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--manual', action='store_true', help='手工粘贴 cookie')
    ap.add_argument('--from-chrome', action='store_true', help='从 Chrome 读取')
    ap.add_argument('--no-verify', action='store_true', help='跳过验证')
    args = ap.parse_args()

    if args.manual:
        return from_manual()
    if args.from_chrome:
        return from_chrome()

    # 默认也走手工（最可靠）
    print('=== Gemini cookie 获取 ===')
    print()
    print('两种方式：')
    print('  1. --manual       手工从浏览器复制（最快，推荐）')
    print('  2. --from-chrome  自动从 Chrome 读（需要关 Chrome）')
    print()
    print('重要：请从**浏览器网页版** gemini.google.com 复制，')
    print('      不要用桌面客户端的（客户端 cookie 寿命很短）')
    print()
    return from_manual()


if __name__ == '__main__':
    sys.exit(main())
