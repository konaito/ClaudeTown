#!/usr/bin/env python3
"""Claude Town（リポジトリは family-computing）の状態 hook（hooks/fc-report.py）を ~/.claude/settings.json に登録する、または外す。

  python3 scripts/hook.py install     # 安定版の写し（$CT_STABLE_HOME/hooks/fc-report.py）を登録する（何度呼んでも1つだけ）
  python3 scripts/hook.py install --worktree   # この hook.py の隣の hooks/fc-report.py を登録する（作業ツリーの hook を試すとき。済んだら install で戻す）
  python3 scripts/hook.py uninstall   # 外す
  python3 scripts/hook.py status      # 登録されているかを見る

安定版の写しは scripts/release-stable.sh か scripts/install-stable-hooks.sh が、安定版のタグから作る。
作業ツリーの hook を登録したままにすると、子が hook を書き換えたとたんに安定版に出る内容も変わる（#24）。

cam の各プロファイルの settings.json は ~/.claude/settings.json へのリンクなので、ここだけ書けば全部に効く。
書く前に settings.json.bak-fc-<時刻> を残す。読み出しが空や壊れていたら何も書かずに止まる。

登録するコマンドは、登録先のファイルが無ければ何もせず 0 で終わる（#171）。
python3 は開けないファイルを渡されると 2 で終わり、Claude Code は PreToolUse と UserPromptSubmit の 2 を「止める」として扱う。
登録したまま worktree や安定版の写しを消すと、この機械の全セッションの道具と入力が止まっていた。
#171 より前の形（/usr/bin/python3 <path> # family-computing）は status、install、uninstall が MARK で見つけて扱う。
install し直すと新しい形に替わる。
"""
import json
import os
import shlex
import shutil
import sys
import time
from pathlib import Path

SETTINGS = Path(os.environ.get("FC_SETTINGS", Path.home() / ".claude" / "settings.json"))
MARK = "# family-computing"
STABLE_HOME = Path(os.environ.get("CT_STABLE_HOME", Path.home() / ".family-computing" / "stable"))
SCRIPT = STABLE_HOME / "hooks" / "fc-report.py"
WORKTREE_SCRIPT = Path(__file__).resolve().parent.parent / "hooks" / "fc-report.py"
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"]


def command(script):
    # MARK は末尾のシェルのコメントとして残す。古い hook.py（安定版に写した分を含む）も MARK で新しい形を見つけて外せる
    f = shlex.quote(str(script))
    return f'f={f}; [ -f "$f" ] || exit 0; /usr/bin/python3 "$f" {MARK}'


def guarded(cmd):
    return '[ -f "$f" ] || exit 0' in cmd


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
        cmds = sorted({h["command"] for gs in data.get("hooks", {}).values() for g in gs for h in g.get("hooks", []) if MARK in h.get("command", "")})
        print("登録済み: " + ", ".join(evs) if evs else "未登録")
        for c in cmds:
            print("  " + c)
        if any(not guarded(c) for c in cmds):
            print("古い形の登録がある。登録先のファイルが無いと全セッションの道具が止まるので、install し直す（#171）")
    elif cmd == "install":
        script = WORKTREE_SCRIPT if "--worktree" in sys.argv[2:] else SCRIPT
        # 登録するコマンドはファイルが無くても 0 で終わるが、無いファイルを登録しても状態は出ないので止める
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
