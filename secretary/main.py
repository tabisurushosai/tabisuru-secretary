"""Secretary main loop (GitHub Actions cron, every 10 min).

役割:
1. Mac 秘書ハートビート確認 → 3分以上沈黙していればアラート
2. Upstash の MacState を読む
3. 各プロジェクトの release_stage を見て、release_ready → 自動 CWS submit
4. 異常 → Gmail 通知 + alerts に追記
5. 社長承認は不要 (BGA 設計確定 2026-05-19)
"""

import os
import sys
import time
import uuid
from typing import Any

from gmail_notify import send as gmail_send
from redis_client import K, get_json, lpush_json, ltrim, set_json
from chrome_publish import submit as cws_submit, get_status as cws_status

NOW_MS = lambda: int(time.time() * 1000)

# Chrome Web Store の item_id マッピング (Mac 側 ~/.config/tabisuru/chrome_item_ids.txt と同期)
# GitHub Actions secret に CWS_ITEM_IDS_JSON として配置: {"parent-news":"xxx", "toikake":"yyy", ...}
def load_item_ids() -> dict[str, str]:
    raw = os.environ.get("CWS_ITEM_IDS_JSON", "{}")
    import json

    try:
        return json.loads(raw)
    except Exception:
        return {}


def push_alert(severity: str, topic: str, message: str) -> None:
    alert = {
        "id": str(uuid.uuid4()),
        "ts": NOW_MS(),
        "severity": severity,
        "topic": topic,
        "message": message,
    }
    lpush_json(K.alerts, alert)
    ltrim(K.alerts, 0, 199)


def check_mac_heartbeat() -> None:
    hb = get_json(K.heartbeat("mac_secretary"))
    if hb is None:
        push_alert("warn", "mac_heartbeat", "Mac 秘書ハートビート未受信")
        return
    try:
        ts_ms = int(hb)
    except (TypeError, ValueError):
        push_alert("warn", "mac_heartbeat", f"不正なハートビート値: {hb}")
        return

    age_sec = (NOW_MS() - ts_ms) / 1000
    if age_sec > 600:  # 10分以上沈黙
        push_alert(
            "critical",
            "mac_dead",
            f"Mac 秘書 {int(age_sec/60)} 分沈黙",
        )
        gmail_send(
            "[Tabisuru Secretary] Mac 秘書が沈黙",
            f"Mac 秘書のハートビートが {int(age_sec/60)} 分前から途絶えています。\n\n"
            "ダッシュボード: https://tabisuru-secretary.vercel.app/\n"
            "再起動: 旅する書斎.app → 1) 再起動",
        )


def auto_submit_ready_projects() -> int:
    """release_ready の項目を自動申請 (社長承認不要)。"""
    mac = get_json(K.mac_state)
    if not isinstance(mac, dict):
        return 0

    item_ids = load_item_ids()
    submitted = 0
    for p in mac.get("projects", []):
        if not isinstance(p, dict):
            continue
        if p.get("release_stage") != "release_ready":
            continue
        if not p.get("release_ready"):
            continue
        project = p.get("project")
        if not project:
            continue

        # Mac 側でしか upload できないものは Mac に upload を依頼する命令を投入
        # CWS 拡張のみ submit が API でできる (ただし upload は Mac 側のスクリプトに任せる)
        if project in item_ids:
            # まず Mac に upload を依頼
            cmd = {
                "id": f"cmd_{NOW_MS()}_{uuid.uuid4().hex[:6]}",
                "ts": NOW_MS(),
                "kind": "submit_one",
                "target": project,
                "initiator": "auto",
                "status": "pending",
            }
            lpush_json(K.commands, cmd)
            push_alert(
                "info",
                "auto_submit_enqueued",
                f"{project} を申請キューに投入 (BGA 承認不要設定)",
            )
            submitted += 1

    return submitted


def update_self_heartbeat() -> None:
    set_json(K.heartbeat("github_cron"), NOW_MS(), ex_seconds=1800)


def main() -> int:
    print(f"[secretary] start ts={NOW_MS()}")

    update_self_heartbeat()

    try:
        check_mac_heartbeat()
    except Exception as e:
        push_alert("error", "secretary_self", f"check_mac_heartbeat failed: {e}")

    try:
        n = auto_submit_ready_projects()
        if n:
            print(f"[secretary] enqueued {n} submissions")
    except Exception as e:
        push_alert("error", "secretary_self", f"auto_submit failed: {e}")

    print(f"[secretary] done ts={NOW_MS()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
