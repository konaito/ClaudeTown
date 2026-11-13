#!/usr/bin/env python3
"""Claude Town（リポジトリは family-computing）の状態 hook（hooks/fc-report.py）を ~/.claude/settings.json に登録する、または外す。

  python3 scripts/hook.py install     # 安定版の写し（$CT_STABLE_HOME/hooks/fc-report.py）を登録する（何度呼んでも1つだけ）
  python3 scripts/hook.py install --worktree   # この hook.py の隣の hooks/fc-report.py を登録する（作業ツリーの hook を試すとき。済んだら install で戻す）
  python3 scripts/hook.py uninstall   # 外す
  python3 scripts/hook.py status      # 登録されているかを見る
  python3 scripts/hook.py name <プロジェクトの名前>   # このセッション（親）の世帯の名前を付ける。引数なしなら今の名前を出す

世帯の名前は、作業しているプロジェクトのディレクトリの名前（例 family-computing）にする。依頼の文の要約は付けない。
アプリがこの名前を使うのは、セッションが振り分けの場所（~/Documents/meta、ccn の受け口など）で動いていて、
子孫の作業場所からプロジェクトが分からないときだけ（src-tauri/src/naming.rs）。

安定版の写しは scripts/release-stable.sh か scripts/install-stable-hooks.sh が、安定版のタグから作る。
作業ツリーの hook を登録したままにすると、子が hook を書き換えたとたんに安定版に出る内容も変わる（#24）。

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
STABLE_HOME = Path(os.environ.get("CT_STABLE_HOME", Path.home() / ".family-computing" / "stable"))
SCRIPT = STABLE_HOME / "hooks" / "fc-report.py"
WORKTREE_SCRIPT = Path(__file__).resolve().parent.parent / "hooks" / "fc-report.py"
HOUSES = Path(os.environ.get("FC_HOUSES", Path.home() / ".family-computing" / "houses.json"))
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"]


def command(script):
    return f"/usr/bin/python3 {script} {MARK}"


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


def name_house(args):
    """世帯の名前（作業しているプロジェクトのディレクトリの名前）を付ける。
    本人がアプリで付けた名前（by=human）があれば、エージェントからは上書きしない"""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("FC_SESSION_ID")
    if not sid:
        sys.exit("セッション ID が分からない。Claude Code の中（Bash）で実行する")
    try:
        houses = json.loads(HOUSES.read_text())
    except FileNotFoundError:
        houses = {}
    cur = houses.get(sid) or {}
    if not args:
        print(f"今の世帯の名前: {cur.get('name') or '（まだ無い）'}" + ("（本人が付けた）" if cur.get("by") == "human" else ""))
        return
    name = " ".join(args).strip()[:24]
    if not name:
        sys.exit("名前が空")
    if cur.get("by") == "human":
        print(f"本人が付けた名前「{cur.get('name')}」があるので変えなかった")
        return
    houses[sid] = {"name": name, "by": "agent", "at": int(time.time() * 1000)}
    HOUSES.parent.mkdir(parents=True, exist_ok=True)
    tmp = HOUSES.with_suffix(".tmp")
    tmp.write_text(json.dumps(houses, ensure_ascii=False, indent=2))
    os.replace(tmp, HOUSES)
    print(f"世帯の名前を「{name}」にした")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "name":
        name_house(sys.argv[2:])
        return
    data = load()
    if cmd == "status":
        evs = [ev for ev, gs in data.get("hooks", {}).items() for g in gs for h in g.get("hooks", []) if MARK in h.get("command", "")]
        cmds = sorted({h["command"] for gs in data.get("hooks", {}).values() for g in gs for h in g.get("hooks", []) if MARK in h.get("command", "")})
        print("登録済み: " + ", ".join(evs) if evs else "未登録")
        for c in cmds:
            print("  " + c)
    elif cmd == "install":
        script = WORKTREE_SCRIPT if "--worktree" in sys.argv[2:] else SCRIPT
        # 無いファイルを登録すると python3 が 2 で終わり、PreToolUse では全セッションの道具が止まる
        if not script.exists():
            sys.exit(f"{script} が無い（安定版の写しは scripts/install-stable-hooks.sh で作る）")
        strip(data)
        hooks = data.setdefault("hooks", {})
        for ev in EVENTS:
            hooks.setdefault(ev, []).append({"hooks": [{"type": "command", "command": command(script), "timeout": 5}]})
        save(data)
        print(f"登録した（{script}）: " + ", ".join(EVENTS))
    elif cmd == "uninstall":
        n = strip(data)
        if n:
            save(data)
        print(f"外した: {n}件")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
