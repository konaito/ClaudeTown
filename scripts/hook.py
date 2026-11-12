#!/usr/bin/env python3
"""family-computing の状態 hook（hooks/fc-report.py）を ~/.claude/settings.json に登録する、または外す。

  python3 scripts/hook.py install     # 登録する（何度呼んでも1つだけ）
  python3 scripts/hook.py uninstall   # 外す
  python3 scripts/hook.py status      # 登録されているかを見る

cam の各プロファイルの settings.json は ~/.claude/settings.json へのリンクなので、ここだけ書けば全部に効く。
書く前に settings.json.bak-fc-<時刻> を残す。読み出しが空や壊れていたら何も書かずに止まる。
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

SETTINGS = Path(os.environ.get("FC_SETTINGS", Path.home() / ".claude" / "settings.json"))
MARK = "# family-computing"
SCRIPT = Path(__file__).resolve().parent.parent / "hooks" / "fc-report.py"
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"]


def command():
    return f"/usr/bin/python3 {SCRIPT} {MARK}"


def load():
    raw = SETTINGS.read_text()
    if not raw.strip():
        sys.exit(f"{SETTINGS} が空なので止めた")
    data = json.loads(raw)
    if not isinstance(data, dict):
        sys.exit(f"{SETTINGS} の形が想定と違うので止めた")
    return data


def save(data):
    real = SETTINGS.resolve()
    backup = real.with_name(f"{real.name}.bak-fc-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(real, backup)
    tmp = real.with_name(real.name + ".fc-tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, real)
    print(f"書いた: {real}（控え: {backup}）")


def strip(data):
    hooks = data.get("hooks", {})
    removed = 0
    for ev in list(hooks):
        groups = []
        for g in hooks[ev]:
            hs = [h for h in g.get("hooks", []) if MARK not in h.get("command", "")]
            removed += len(g.get("hooks", [])) - len(hs)
            if hs:
                groups.append({**g, "hooks": hs})
        if groups:
            hooks[ev] = groups
        else:
            del hooks[ev]
    return removed


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    data = load()
    if cmd == "status":
        evs = [ev for ev, gs in data.get("hooks", {}).items() for g in gs for h in g.get("hooks", []) if MARK in h.get("command", "")]
        print("登録済み: " + ", ".join(evs) if evs else "未登録")
    elif cmd == "install":
        if not SCRIPT.exists():
            sys.exit(f"{SCRIPT} が無い")
        strip(data)
        hooks = data.setdefault("hooks", {})
        for ev in EVENTS:
            hooks.setdefault(ev, []).append({"hooks": [{"type": "command", "command": command(), "timeout": 5}]})
        save(data)
        print("登録した: " + ", ".join(EVENTS))
    elif cmd == "uninstall":
        n = strip(data)
        if n:
            save(data)
        print(f"外した: {n}件")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
