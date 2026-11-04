r"""Gemini 生图适配层（HTTP 服务，供机器人调用）。
接口：
  GET  /health        → 探活（含 cookie 状态、最近一次出图结果）
  POST /paint         {"prompt": "...", "ref": "可选参考图"} → {"ok":, "path":, "durationSec":}

## cookie 生命周期（这是本文件最核心的部分）

`gemini_webapi` 每次调用前会 POST 到 Google 的 ROTATE_COOKIES 端点刷新
`__Secure-1PSIDTS`。**刷新后旧值立刻失效**，新值只存在于：
  1. 内存里的 client
  2. 缓存文件 `<GEMINI_COOKIE_PATH>/.cached_cookies_<PSID>.json`

实测踩过的坑（2026-10-30）：
  - 缓存默认写 `%TEMP%\gemini_webapi`，被清理/重启就丢
    → 之前"用了一小时突然 1016"就是这个原因
  - 缓存丢了之后，硬编码的旧 PSIDTS 已经在服务端作废，再也连不上

所以本服务做三件事：
  1. 缓存目录固定到项目内 `data/gemini-cookies`（不进 TEMP）
  2. 每次成功出图后，把**当前内存里的最新 cookie 回写** `gemini-cookies.json`
  3. 启动时优先用缓存里的 cookie，而不是文件里可能过期的

## 其他设计

- 客户端常驻（首次 init 3~5 秒，之后复用；必须同一个 event loop）
- 必须走代理（实测直连 HTTP 000）
- 出图前自动补作画前缀（短提示词会被 Gemini 当对话）
"""

import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

BASE = Path(__file__).parent.parent
COOKIE_FILE = BASE / 'scripts' / 'gemini-cookies.json'
OUTPUT_DIR = Path(r'E:\PRO\etc\daliy\gemini-out')
CACHE_DIR = BASE / 'data' / 'gemini-cookies'

# 必须在 import gemini_webapi 之前设好（库在模块级读取）
os.environ['GEMINI_COOKIE_PATH'] = str(CACHE_DIR)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

PROXY = os.environ.get('GEMINI_PROXY', 'socks5h://127.0.0.1:10808')

app = Flask(__name__, static_folder=None)

_client = None
_init_error = ''
_last_ok = 0.0
_last_error = ''
_gen_count = 0
_account_status = -1

# 持久事件循环。
#
# 不能用 asyncio.run()：它每次创建新 loop 并关闭，而 GeminiClient 的
# 连接池绑定在首次 loop 上，第二次会报
#   "Task ... got Future attached to a different loop"
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)


def run_async(coro):
    return _loop.run_until_complete(coro)


# ---------- cookie 读写 ----------

def _cache_file(psid: str) -> Path:
    return CACHE_DIR / f'.cached_cookies_{psid}.json'


def load_from_cache(psid: str) -> str:
    """从缓存文件读最新的 PSIDTS（比 json 文件里的新）。"""
    p = _cache_file(psid)
    if not p.exists():
        return ''
    try:
        items = json.loads(p.read_text(encoding='utf-8'))
        for it in items:
            if it.get('name') == '__Secure-1PSIDTS':
                return str(it.get('value') or '')
    except Exception:  # noqa: BLE001
        pass
    return ''


def load_cookie() -> tuple[str, str]:
    """读 PSID + 最新的 PSIDTS。

    优先级：环境变量 > 缓存文件 > gemini-cookies.json
    （缓存文件里的更新，因为是轮换后的值）
    """
    psid = os.environ.get('GEMINI_PSID', '').strip()
    psidts = os.environ.get('GEMINI_PSIDTS', '').strip()

    if not psid and COOKIE_FILE.exists():
        try:
            j = json.loads(COOKIE_FILE.read_text(encoding='utf-8'))
            psid = (j.get('__Secure-1PSID') or '').strip()
            if not psidts:
                psidts = (j.get('__Secure-1PSIDTS') or '').strip()
        except Exception as e:  # noqa: BLE001
            print(f'[Gemini] 读 cookie 文件失败: {e}', flush=True)

    # 缓存里的更新，优先用
    if psid:
        cached = load_from_cache(psid)
        if cached and cached != psidts:
            print('[Gemini] 使用缓存里轮换后的 PSIDTS', flush=True)
            psidts = cached

    return psid, psidts


def persist_cookie(psid: str, psidts: str) -> None:
    """把最新的 cookie 回写到 gemini-cookies.json。

    为什么必须做：PSIDTS 每次调用都会轮换，旧值立刻失效。
    如果只留在内存和 %TEMP% 缓存里，进程一重启就彻底失联。
    """
    if not psid or not psidts:
        return
    try:
        data = {}
        if COOKIE_FILE.exists():
            try:
                data = json.loads(COOKIE_FILE.read_text(encoding='utf-8'))
            except Exception:  # noqa: BLE001
                data = {}
        if data.get('__Secure-1PSIDTS') == psidts:
            return  # 没变化，不写
        data['__Secure-1PSID'] = psid
        data['__Secure-1PSIDTS'] = psidts
        COOKIE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        print('[Gemini] 已回写轮换后的 PSIDTS', flush=True)
    except Exception as e:  # noqa: BLE001
        print(f'[Gemini] 回写 cookie 失败: {e}', flush=True)


async def get_client():
    """懒加载 + 复用客户端。"""
    global _client, _init_error, _account_status

    if _client is not None:
        return _client

    psid, psidts = load_cookie()
    if not psid:
        _init_error = '没有 cookie（scripts/gemini-cookies.json 或 GEMINI_PSID）'
        return None

    try:
        from gemini_webapi import GeminiClient

        client = GeminiClient(psid, psidts or None, proxy=PROXY)
        await client.init(timeout=60, auto_close=False, auto_refresh=True)
        _client = client
        _account_status = int(client.account_status)
        _init_error = ''
        print(f'[Gemini] 客户端初始化成功，status={_account_status}', flush=True)

        # 立刻把 init 过程中可能轮换的 cookie 保存下来
        try:
            jar = client.cookies
            cur_ts = ''
            for c in jar.jar if hasattr(jar, 'jar') else []:
                if c.name == '__Secure-1PSIDTS':
                    cur_ts = c.value
                    break
            if cur_ts:
                persist_cookie(psid, cur_ts)
        except Exception:  # noqa: BLE001
            pass

        return _client
    except Exception as e:  # noqa: BLE001
        _init_error = f'{type(e).__name__}: {e}'
        print(f'[Gemini] 初始化失败: {_init_error}', flush=True)
        return None


# ---------- 路由 ----------

@app.get('/health')
def health():
    psid, _ = load_cookie()

    # ok = "服务本身可用"（有 cookie + 客户端能建起来）
    # 刻意**不把 accountStatus 算进 ok**：
    #   cookie 过期（1016）时重启服务也没用，只会让 watchdog 空转。
    #   真实状态单独用 accountOk 暴露，让面板/人工能看到。
    service_ok = bool(psid) and _account_status in (1000, -1)

    return jsonify({
        'ok': service_ok,
        'backend': 'gemini',
        'hasCookie': bool(psid),
        'clientReady': _client is not None,
        'accountStatus': _account_status,
        'accountOk': _account_status == 1000,
        'needNewCookie': _account_status == 1016,
        'lastError': _init_error or _last_error,
        'proxy': PROXY,
        'cacheDir': str(CACHE_DIR),
        'lastOkAgo': round(time.time() - _last_ok, 1) if _last_ok else None,
        'generated': _gen_count,
    })


@app.post('/paint')
def paint():
    global _last_ok, _last_error, _gen_count, _account_status

    data = request.get_json(silent=True) or {}
    prompt = (data.get('prompt') or '').strip()
    ref = (data.get('ref') or '').strip()

    if not prompt:
        return jsonify({'ok': False, 'message': 'prompt 为空'}), 400
    if len(prompt) > 2000:
        prompt = prompt[:2000]

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    started = time.time()

    try:
        result = run_async(_do_paint(prompt, ref))
    except Exception as e:  # noqa: BLE001
        _last_error = f'{type(e).__name__}: {e}'
        print(f'[Gemini] 出图异常: {_last_error}', flush=True)
        # 连接状态可能坏了，重建
        _client = None
        return jsonify({'ok': False, 'message': _last_error[:300]}), 500

    if not result:
        return jsonify({
            'ok': False,
            'message': _last_error or '没有返回图片（可能只回了文字）',
            'accountStatus': _account_status,
        }), 500

    _last_ok = time.time()
    _last_error = ''
    _gen_count += 1
    path, text = result
    return jsonify({
        'ok': True,
        'path': str(path).replace('\\', '/'),
        'durationSec': round(time.time() - started, 2),
        'text': (text or '')[:200],
        'backend': 'gemini',
    })


async def _do_paint(prompt: str, ref: str):
    """真正出图。返回 (文件路径, 文本回复) 或 None。"""
    global _last_error, _account_status

    client = await get_client()
    if client is None:
        _last_error = _init_error
        return None

    # 必须让 Gemini 明确"这是作画请求"。
    # 实测：直接发「第2只猫」会被当成对话，回"我们之前聊到的第2只猫…"。
    guarded = prompt
    if not any(k in prompt for k in ('画', '绘制', '生成图', '生成一张', 'draw', 'paint', 'image of')):
        guarded = f'请画一张图：{prompt}'
    guarded += '\n（请直接生成图片，不要用文字描述。）'

    kwargs = {}
    if ref:
        ref_path = Path(ref)
        if ref_path.exists():
            kwargs['files'] = [str(ref_path)]

    resp = await client.generate_content(guarded, **kwargs)

    # 每次调用后都检查状态 + 回写 cookie（轮换就发生在这之后）
    try:
        _account_status = int(client.account_status)
        psid, _ = load_cookie()
        for c in getattr(client.cookies, 'jar', []):
            if c.name == '__Secure-1PSIDTS':
                persist_cookie(psid, c.value)
                break
    except Exception:  # noqa: BLE001
        pass

    if not resp.images:
        _last_error = f'无图片（status={_account_status}）：{(resp.text or "")[:100]}'
        print(f'[Gemini] {_last_error}', flush=True)
        return None

    img = resp.images[0]
    name = f'gemini-{uuid.uuid4().hex[:12]}.jpg'

    # 注意：gemini 返回实际是 JPEG（FFD8FF），扩展名必须用 .jpg，
    # 否则下游按 png 解析会失败。
    saved = await img.save(path=str(OUTPUT_DIR), filename=name, verbose=False)
    out = Path(saved) if saved else OUTPUT_DIR / name

    if not out.exists():
        for p in OUTPUT_DIR.glob(f'{Path(name).stem}*'):
            out = p
            break

    if out.exists():
        print(
            f'[Gemini] "{prompt[:30]}" -> {out.name}  '
            f'{round(out.stat().st_size / 1024)} KB',
            flush=True,
        )
        return out, resp.text

    _last_error = '图片保存失败'
    return None


if __name__ == '__main__':
    port = int(os.environ.get('GEMINI_PORT', '5052'))
    psid, psidts = load_cookie()
    print(f'[Gemini] 启动 http://127.0.0.1:{port}', flush=True)
    print(f'[Gemini] cookie: {"有" if psid else "无"}（长度 {len(psid)}）', flush=True)
    print(f'[Gemini] PSIDTS: {"有" if psidts else "无"}（长度 {len(psidts)}）', flush=True)
    print(f'[Gemini] 代理: {PROXY}', flush=True)
    print(f'[Gemini] 输出: {OUTPUT_DIR}', flush=True)
    print(f'[Gemini] cookie 缓存: {CACHE_DIR}', flush=True)
    app.run(host='127.0.0.1', port=port, threaded=False)
