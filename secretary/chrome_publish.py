"""Chrome Web Store API publisher.

注意:
- Mac の `chrome_publish.sh` は ZIP push を Mac 側で実行する (item_id を引数に取る)
- ここでは `submit` (審査提出のみ) と `status` 確認を Web API 直叩きで行う
- ZIP upload は Mac 側に任せる (Mac 上に最新 ZIP がある & repo は Mac で管理)
- GitHub cron からは「Mac 秘書に upload 命令を投入する」だけにする → commands に積む
"""

import json
import os
from typing import Optional

import requests

_BASE = "https://www.googleapis.com/chromewebstore/v1.1"


def _credentials() -> dict:
    """OAuth クレデンシャルを env から読む。

    ~/.config/chrome-webstore/credentials.json の中身を GitHub Actions secret として
    CWS_CREDENTIALS_JSON に格納する想定。
    """
    raw = os.environ.get("CWS_CREDENTIALS_JSON")
    if not raw:
        raise RuntimeError("CWS_CREDENTIALS_JSON not set")
    return json.loads(raw)


def _access_token() -> str:
    creds = _credentials()
    resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "refresh_token": creds["refresh_token"],
            "grant_type": "refresh_token",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def submit(item_id: str, publish_target: str = "default") -> dict:
    """審査提出 (publish)。upload 済 ZIP がある前提。"""
    tok = _access_token()
    resp = requests.post(
        f"{_BASE}/items/{item_id}/publish?publishTarget={publish_target}",
        headers={
            "Authorization": f"Bearer {tok}",
            "x-goog-api-version": "2",
            "Content-Length": "0",
        },
        timeout=30,
    )
    return {"http": resp.status_code, "body": _safe_json(resp)}


def get_status(item_id: str) -> dict:
    tok = _access_token()
    resp = requests.get(
        f"{_BASE}/items/{item_id}?projection=DRAFT",
        headers={
            "Authorization": f"Bearer {tok}",
            "x-goog-api-version": "2",
        },
        timeout=15,
    )
    return {"http": resp.status_code, "body": _safe_json(resp)}


def _safe_json(resp: requests.Response):
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text[:400]}
