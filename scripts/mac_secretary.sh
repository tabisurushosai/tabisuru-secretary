#!/bin/bash
# Mac 秘書 (LaunchAgent 5min)
# 役割: Mac 状態を Upstash に push。完成 ZIP / butler push / Chrome 拡張 upload の物理アクション。
# 設計: 1回実行で完結。LaunchAgent が StartInterval=300 で呼ぶ。

set -u
# set -e は使わない (一部失敗しても push は続ける)

# --- 環境変数読み込み ---
UPSTASH_ENV="${HOME}/.config/tabisuru/upstash.env"
if [[ ! -f "$UPSTASH_ENV" ]]; then
  echo "[mac_secretary] missing $UPSTASH_ENV" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$UPSTASH_ENV"

if [[ -z "${UPSTASH_REDIS_REST_URL:-}" || -z "${UPSTASH_REDIS_REST_TOKEN:-}" ]]; then
  echo "[mac_secretary] UPSTASH_REDIS_REST_URL / TOKEN not set" >&2
  exit 1
fi

# --- 共通関数 ---
NOW_MS() { python3 -c 'import time; print(int(time.time()*1000))'; }

redis_post() {
  # $@ = Redis command tokens
  local json
  json=$(python3 -c '
import json, sys
print(json.dumps(sys.argv[1:]))
' "$@")
  curl -s -X POST "${UPSTASH_REDIS_REST_URL}" \
    -H "Authorization: Bearer ${UPSTASH_REDIS_REST_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 8 \
    -d "$json" \
    >/dev/null || echo "[mac_secretary] redis_post failed: $*" >&2
}

# --- プロセス確認 ---
collect_state() {
  python3 - <<'PYEOF'
import json, os, subprocess, time, shlex, socket

def pscount(pattern):
    try:
        out = subprocess.check_output(
            ["pgrep", "-fl", pattern],
            stderr=subprocess.DEVNULL,
            timeout=3,
        ).decode()
        return [ln for ln in out.strip().splitlines() if ln]
    except Exception:
        return []

def first_pid(lines):
    if not lines:
        return None
    try:
        return int(lines[0].split()[0])
    except Exception:
        return None

# Process kinds
patterns = {
    "claude_code_loop": "run_claude.sh",
    "gemini_cli": "gemini",
    "codex_cli": "codex",
    "cursor_bga": "cursor.*background",
    "mac_secretary": "mac_secretary",
}
procs = []
for kind, pat in patterns.items():
    lines = pscount(pat)
    procs.append({
        "kind": kind,
        "status": "running" if lines else "idle",
        "pid": first_pid(lines),
        "last_heartbeat": int(time.time() * 1000),
    })

# Projects (TODO カウント)
projects_root = os.path.expanduser("~/Documents")
project_names = [
    "rogue-night", "emoji-soko", "parent-news", "toikake",
    "youtube-safe", "kosodate-bot", "focus-timer",
    "clipnest", "markwell",
]
projects = []
for p in project_names:
    path = os.path.join(projects_root, p)
    if not os.path.isdir(path):
        continue
    # 残TODO = grep -RE 'TODO|FIXME' (簡易)
    todos = 0
    try:
        out = subprocess.check_output(
            ["grep", "-rcE", "TODO|FIXME", "--include=*.ts", "--include=*.tsx",
             "--include=*.js", "--include=*.py", "--include=*.md", path],
            stderr=subprocess.DEVNULL,
            timeout=8,
        ).decode()
        todos = sum(int(ln.split(":")[-1]) for ln in out.splitlines() if ln.split(":")[-1].isdigit())
    except Exception:
        pass

    last_commit_at = 0
    last_commit_msg = ""
    git_dir = os.path.join(path, ".git")
    if os.path.isdir(git_dir):
        try:
            ts = subprocess.check_output(
                ["git", "-C", path, "log", "-1", "--format=%ct"],
                stderr=subprocess.DEVNULL, timeout=3,
            ).decode().strip()
            last_commit_at = int(ts) * 1000
            last_commit_msg = subprocess.check_output(
                ["git", "-C", path, "log", "-1", "--format=%s"],
                stderr=subprocess.DEVNULL, timeout=3,
            ).decode().strip()
        except Exception:
            pass

    projects.append({
        "project": p,
        "remaining_todos": todos,
        "last_commit_at": last_commit_at,
        "last_commit_msg": last_commit_msg[:200],
        "release_ready": todos == 0 and last_commit_at > 0,
        "release_stage": "release_ready" if (todos == 0 and last_commit_at > 0) else "developing",
    })

# Load avg, disk
load = list(os.getloadavg())
try:
    df_out = subprocess.check_output(["df", "-g", "/"], timeout=3).decode().splitlines()
    free_gb = int(df_out[1].split()[3])
except Exception:
    free_gb = -1

state = {
    "ts": int(time.time() * 1000),
    "hostname": socket.gethostname(),
    "uptime_sec": int(time.monotonic()),
    "load_avg": load,
    "disk_free_gb": free_gb,
    "processes": procs,
    "projects": projects,
}
print(json.dumps(state, ensure_ascii=False))
PYEOF
}

# --- 命令 (commands:pending) をポップ実行 ---
process_commands() {
  python3 - <<'PYEOF'
import json, os, subprocess, sys, time, urllib.request

url = os.environ["UPSTASH_REDIS_REST_URL"].rstrip("/")
tok = os.environ["UPSTASH_REDIS_REST_TOKEN"]

def call(cmd):
    req = urllib.request.Request(
        url,
        data=json.dumps(cmd).encode(),
        headers={
            "Authorization": f"Bearer {tok}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"[redis] {e}", file=sys.stderr)
        return {"error": str(e)}

# RPOP from commands:pending one at a time (max 5 per cron tick)
HOME = os.path.expanduser("~")
processed = 0
for _ in range(5):
    res = call(["RPOP", "commands:pending"])
    item = res.get("result")
    if not item:
        break
    try:
        cmd = json.loads(item) if isinstance(item, str) else item
    except Exception:
        cmd = {"raw": item}

    kind = cmd.get("kind") if isinstance(cmd, dict) else None
    target = cmd.get("target") if isinstance(cmd, dict) else None
    print(f"[mac_secretary] processing cmd: {kind} target={target}")

    result_text = "skipped"
    try:
        if kind == "restart_loop":
            subprocess.run(
                ["bash", "-lc", "pkill -f run_claude.sh || true; sleep 1; bash ~/Documents/mass_start_v1_0.sh || true"],
                timeout=60,
                check=False,
            )
            result_text = "restart issued"
        elif kind == "rebuild_zip":
            subprocess.run(
                ["bash", "-lc", "bash ~/Documents/build_all_zips.sh || true"],
                timeout=180,
                check=False,
            )
            result_text = "rebuild issued"
        elif kind == "rerun_butler":
            subprocess.run(
                ["bash", "-lc",
                 "cd ~/Documents/rogue-night && butler push . tabisurushosai/tabisurushosai-emoji-roguelike-night:html"],
                timeout=180,
                check=False,
            )
            result_text = "butler push issued"
        elif kind == "submit_one":
            if target:
                subprocess.run(
                    ["bash", "-lc", f"bash ~/Documents/chrome_publish.sh {target} upload"],
                    timeout=300,
                    check=False,
                )
                result_text = f"submit_one {target} issued"
        elif kind == "submit_all":
            subprocess.run(
                ["bash", "-lc", "bash ~/Documents/chrome_publish_all.sh || true"],
                timeout=600,
                check=False,
            )
            result_text = "submit_all issued"
        elif kind == "pause_secretary":
            with open(os.path.expanduser("~/.config/tabisuru/secretary.paused"), "w") as f:
                f.write(str(int(time.time())))
            result_text = "paused"
        elif kind == "resume_secretary":
            try:
                os.remove(os.path.expanduser("~/.config/tabisuru/secretary.paused"))
            except FileNotFoundError:
                pass
            result_text = "resumed"
        else:
            result_text = f"unknown kind: {kind}"
    except Exception as e:
        result_text = f"error: {e}"

    if isinstance(cmd, dict):
        cmd["status"] = "done"
        cmd["result"] = result_text
        call(["LPUSH", "commands:done", json.dumps(cmd, ensure_ascii=False)])
        call(["LTRIM", "commands:done", 0, 199])

    processed += 1

print(f"[mac_secretary] processed {processed} commands")
PYEOF
}

# --- 一時停止チェック ---
if [[ -f "$HOME/.config/tabisuru/secretary.paused" ]]; then
  echo "[mac_secretary] paused, skipping main loop"
  # ハートビートだけは打つ
  redis_post "SET" "hb:mac_secretary" "$(NOW_MS)" "EX" "600"
  exit 0
fi

# --- 状態を取得して push ---
STATE_JSON=$(collect_state)
if [[ -n "$STATE_JSON" ]]; then
  redis_post "SET" "state:mac" "$STATE_JSON"
fi

# --- ハートビート ---
redis_post "SET" "hb:mac_secretary" "$(NOW_MS)" "EX" "600"

# --- 命令処理 ---
process_commands

echo "[mac_secretary] done $(date -u +%FT%TZ)"
