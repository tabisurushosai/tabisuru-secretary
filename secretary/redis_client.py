"""Upstash Redis REST API client (no extra deps).

GitHub Actions cron と Cursor BGA から使う。Mac 秘書側は bash の curl で同じ API を叩く。
"""

import json
import os
from typing import Any, Optional

import requests

_TIMEOUT = 10


def _url() -> str:
    u = os.environ.get("UPSTASH_REDIS_REST_URL") or os.environ.get("KV_REST_API_URL")
    if not u:
        raise RuntimeError("UPSTASH_REDIS_REST_URL not set")
    return u.rstrip("/")


def _token() -> str:
    t = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or os.environ.get(
        "KV_REST_API_TOKEN"
    )
    if not t:
        raise RuntimeError("UPSTASH_REDIS_REST_TOKEN not set")
    return t


def _headers() -> dict:
    return {"Authorization": f"Bearer {_token()}"}


def _exec(command: list[Any]) -> Any:
    """Execute a single Redis command via Upstash REST."""
    resp = requests.post(
        _url(),
        headers=_headers(),
        json=command,
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"Upstash error: {data['error']}")
    return data.get("result")


# Convenience wrappers
def get_json(key: str) -> Optional[Any]:
    v = _exec(["GET", key])
    if v is None:
        return None
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (json.JSONDecodeError, ValueError):
            return v
    return v


def set_json(key: str, value: Any, ex_seconds: Optional[int] = None) -> None:
    payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    cmd: list[Any] = ["SET", key, payload]
    if ex_seconds:
        cmd += ["EX", ex_seconds]
    _exec(cmd)


def lpush_json(key: str, value: Any) -> None:
    payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    _exec(["LPUSH", key, payload])


def ltrim(key: str, start: int, stop: int) -> None:
    _exec(["LTRIM", key, start, stop])


def lrange_json(key: str, start: int, stop: int) -> list[Any]:
    raw = _exec(["LRANGE", key, start, stop]) or []
    out: list[Any] = []
    for item in raw:
        if isinstance(item, str):
            try:
                out.append(json.loads(item))
            except (json.JSONDecodeError, ValueError):
                out.append(item)
        else:
            out.append(item)
    return out


def incr(key: str) -> int:
    return int(_exec(["INCR", key]))


# Key namespace (lib/redis.ts と合わせる)
class K:
    @staticmethod
    def heartbeat(who: str) -> str:
        return f"hb:{who}"

    mac_state = "state:mac"

    @staticmethod
    def project_status(p: str) -> str:
        return f"project:{p}:status"

    release_queue = "queue:release"
    alerts = "alerts"
    commands = "commands:pending"
    commands_done = "commands:done"

    @staticmethod
    def counter(name: str) -> str:
        return f"counter:{name}"
