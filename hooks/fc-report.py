#!/usr/bin/env python3
"""family-computing の状態 hook。

Claude Code の各セッションが、いまの様子を ~/.family-computing/state/<session_id>.json に書く。
アプリはこれをキャラの吹き出しと「あなたを待ってる子」の欄に使う。
ccn から取れる状態は running / waiting_permission / idle の3つだけなので、足りない分（頼まれたこと、
いまやってること、最後の報告、次の一手、あなた待ちか）をここで補う。

登録するイベントと書く内容:
  UserPromptSubmit  phase=working、asked=頼まれた文の1行目
  PreToolUse        phase=working、doing=道具の種類と対象（例「コマンド: bun test」）
  PostToolUse       phase=working（承認待ちを解く）
  Notification      承認や質問の通知なら phase=needs_you、needs=理由
  Stop              phase=resting か needs_you、said=最後の返事の1行目、next=次の一手
  SessionEnd        状態ファイルを消す

LLM は呼ばない。速さを優先し、どんな失敗でも何も出さずに 0 で終わる（本体の動きを止めない）。
"""
import json
import os
import re
import sys
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("FC_STATE_DIR", Path.home() / ".family-computing" / "state"))
HOUSES = Path(os.environ.get("FC_HOUSES", Path.home() / ".family-computing" / "houses.json"))
REGISTRY = Path(os.environ.get("FC_SPECTER_REGISTRY", Path.home() / ".specter" / "agents.json"))
NAME_CMD = f"python3 {Path(__file__).resolve().parent.parent / 'scripts' / 'hook.py'} name"
KEEP_SEC = 3 * 24 * 3600
MAX = 90

TOOL_VERB = {
    "Bash": "コマンド",
    "Edit": "書く",
    "MultiEdit": "書く",
    "Write": "書く",
    "NotebookEdit": "書く",
    "Read": "読む",
    "Grep": "探す",
    "Glob": "探す",
    "WebSearch": "調べる",
    "WebFetch": "調べる",
    "Agent": "手伝いを呼ぶ",
    "Task": "手伝いを呼ぶ",
    "SendMessage": "話す",
    "AskUserQuestion": "質問",
    "TodoWrite": "予定を書く",
    "Skill": "道具箱",
    "advisor": "相談",
}


def clip(s, n=MAX):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def first_line(s):
    for line in str(s or "").splitlines():
        line = line.strip().lstrip("#>*-•● ").strip()
        if line:
            return line
    return ""


def describe_tool(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    if name.startswith("mcp__specter-agents__spawn_child"):
        return f"子を呼ぶ: {inp.get('title') or inp.get('name') or ''}"
    if name.startswith("mcp__"):
        parts = name.split("__")
        return f"{parts[1] if len(parts) > 1 else 'mcp'}: {parts[-1]}"
    verb = TOOL_VERB.get(name, name)
    target = (
        inp.get("description")
        or inp.get("command")
        or inp.get("file_path")
        or inp.get("pattern")
        or inp.get("query")
        or inp.get("url")
        or inp.get("to")
        or ""
    )
    if isinstance(target, str) and "/" in target and name in ("Edit", "MultiEdit", "Write", "Read", "NotebookEdit"):
        target = "/".join(target.rstrip("/").split("/")[-2:])
    return clip(f"{verb}: {target}" if target else verb, 60)


def last_assistant_text(data):
    t = data.get("last_assistant_message")
    if isinstance(t, str) and t.strip():
        return t
    path = data.get("transcript_path")
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            lines = f.read().decode("utf-8", "ignore").splitlines()
    except Exception:
        return ""
    for line in reversed(lines):
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") != "assistant":
            continue
        content = (o.get("message") or {}).get("content")
        if isinstance(content, list):
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            if any(x.strip() for x in texts):
                return "\n".join(texts)
    return ""


NEXT_RE = re.compile(r"^(?:次(?:の一手)?(?:は)?|Next)\s*[:：は]\s*(.+)$")


def pick_next(text):
    """次の一手: 「次:」「次は」「Next:」で始まる行。無ければ最後の行が問いならそれ。"""
    lines = [l.strip().lstrip("-*•> ").strip() for l in text.splitlines() if l.strip()]
    for l in reversed(lines):
        m = NEXT_RE.match(l)
        if m:
            return clip(m.group(1)), False
    if lines and re.search(r"[?？]\s*$", lines[-1]):
        return clip(lines[-1]), True
    return "", False


def write(sid, patch, data):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    p = STATE_DIR / f"{sid}.json"
    try:
        cur = json.loads(p.read_text())
    except Exception:
        cur = {}
    cur.update(patch)
    cur["session_id"] = sid
    cur["cwd"] = data.get("cwd") or cur.get("cwd")
    cur["updated_at"] = int(time.time() * 1000)
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(cur, ensure_ascii=False))
    os.replace(tmp, p)


def house_nudge(sid):
    """子を持つ根のセッションに家の名前が無ければ、名前を付けるよう1回だけ促す文を返す"""
    try:
        houses = json.loads(HOUSES.read_text())
    except Exception:
        houses = {}
    if (houses.get(sid) or {}).get("name"):
        return None
    try:
        rec = json.loads(REGISTRY.read_text())["agents"].get(sid) or {}
    except Exception:
        return None
    if rec.get("parent") or not rec.get("children"):
        return None
    p = STATE_DIR / f"{sid}.json"
    try:
        if json.loads(p.read_text()).get("house_nudged"):
            return None
    except Exception:
        pass
    write(sid, {"house_nudged": True}, {})
    return (
        "family-computing: あなたは子を持つ親なので、家族の家の名前を付けてください。"
        "いまの依頼の中身から、短い名前（12字以内。例「TANGLE の掘り出し」「ccn の引っ越し」）を決めて、"
        f"Bash で `{NAME_CMD} \"<家の名前>\"` を1回実行します。仕事の中身が大きく変わったら付け直してかまいません。"
        "本人が付けた名前があるときは変わりません。"
    )


def emit_context(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}, ensure_ascii=False))


def sweep():
    now = time.time()
    for p in STATE_DIR.glob("*.json"):
        try:
            if now - p.stat().st_mtime > KEEP_SEC:
                p.unlink()
        except Exception:
            pass


def main():
    # close-check などの裏方の claude -p は数えない
    if os.environ.get("CLOSE_CHECK_CHILD") or os.environ.get("FC_REPORT_OFF"):
        return
    data = json.loads(sys.stdin.read() or "{}")
    sid = data.get("session_id")
    if not sid or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", sid):
        return
    ev = data.get("hook_event_name") or (sys.argv[1] if len(sys.argv) > 1 else "")

    if ev == "UserPromptSubmit":
        prompt = data.get("prompt") or ""
        # 別セッションからの文は1行目が from 行なので、本文の1行目を取る
        body = re.sub(r"^from \S+ via \S+\s*\n", "", prompt)
        write(sid, {"phase": "working", "asked": clip(first_line(body)), "doing": "考え中", "needs": None, "tools": 0,
                    "turn_started_at": int(time.time() * 1000)}, data)
        nudge = house_nudge(sid)
        if nudge:
            emit_context("UserPromptSubmit", nudge)
    elif ev == "PreToolUse":
        p = STATE_DIR / f"{sid}.json"
        try:
            n = json.loads(p.read_text()).get("tools", 0) + 1
        except Exception:
            n = 1
        write(sid, {"phase": "working", "doing": describe_tool(data.get("tool_name", ""), data.get("tool_input")), "needs": None, "tools": n}, data)
    elif ev in ("PostToolUse", "PostToolUseFailure"):
        write(sid, {"phase": "working", "needs": None}, data)
        # 初めて子を作った直後にも促す（その会話の中で名前を付けられるように）
        if ev == "PostToolUse" and "spawn_child" in (data.get("tool_name") or ""):
            nudge = house_nudge(sid)
            if nudge:
                emit_context("PostToolUse", nudge)
    elif ev == "Notification":
        kind = data.get("notification_type") or ""
        msg = data.get("message") or ""
        if kind in ("permission_prompt", "elicitation_dialog") or (not kind and re.search(r"permission|許可", msg, re.I)):
            write(sid, {"phase": "needs_you", "needs": clip(msg or "承認を待っている", 60)}, data)
    elif ev == "Stop":
        text = last_assistant_text(data)
        nxt, asking = pick_next(text)
        write(sid, {
            "phase": "needs_you" if asking else "resting",
            "said": clip(first_line(text)),
            "next": nxt or None,
            "needs": "質問に答えてほしい" if asking else None,
            "doing": None,
        }, data)
    elif ev == "SessionStart":
        sweep()
        write(sid, {"phase": "resting", "doing": None, "needs": None}, data)
    elif ev == "SessionEnd":
        try:
            (STATE_DIR / f"{sid}.json").unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
