#!/usr/bin/env python3
"""Claude Town（リポジトリは family-computing）の状態 hook。

Claude Code の各セッションが、いまの様子を ~/.family-computing/state/<session_id>.json に書く。
アプリはこれをキャラの吹き出しと「あなたを待ってる子」の欄に使う。
ccn から取れる状態は running / waiting_permission / idle の3つだけなので、足りない分（頼まれたこと、
いまやってること、最後の報告、次の一手、あなた待ちか）をここで補う。

登録するイベントと書く内容:
  UserPromptSubmit  phase=working、asked=頼まれた文の1行目
  PreToolUse        phase=working、doing=道具の種類と対象（例「コマンド: bun test」）
  PostToolUse       phase=working（承認待ちを解く）
  PermissionRequest 承認の画面が出る道具を perm_queue に足す（画面の「許可する」は1件のときだけ使える）。
                    道具の input 全体は perm/<session_id>.json に、新しい順の8件まで残す（承認の欄が読む）
  Notification      承認や質問の通知なら phase=needs_you、needs=理由
  Stop              phase=resting か needs_you、said=最後の返事の1行目、next=次の一手
  SessionEnd        状態ファイルと perm/<session_id>.json を消す

in-process のチームメイトと sub-agent の入力は、session_id がリードのもので、agent_id が付いて届く。
これはリードの様子ではないので、リードの状態ファイルにもお手紙にも書かない。例外は承認だけにする。
チームメイトの承認の画面はリードの端末に出て、人はそこで答えるので、並び（perm_queue）には足して外す。
tmux のチームメイトは自分の session_id で届き、agent_id は付かないので、ふつうのセッションと同じに書く。

LLM は呼ばない。速さを優先し、どんな失敗でも何も出さずに 0 で終わる（本体の動きを止めない）。
"""
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("FC_STATE_DIR", Path.home() / ".family-computing" / "state"))
LETTERS = Path(os.environ.get("FC_LETTERS", Path.home() / ".family-computing" / "letters.jsonl"))
# 承認の画面に出る道具の input 全体（Claude Town の承認の欄が読む、#83）。安定版も読む state/ とは別の置き場にする
PERM_DIR = Path(os.environ.get("FC_PERM_DIR", Path.home() / ".family-computing" / "perm"))
PERM_KEEP = 8
LETTERS_MAX = 1024 * 1024
# 子を作る道具。ccn の MCP の create_session（親は from 行で ccn に残る）と、Specter の spawn_child（ccn には親が残らない）
MAKE_CHILD = ("mcp__ccn__create_session", "mcp__specter-agents__spawn_child")
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
    if name in MAKE_CHILD:
        return clip(f"子を呼ぶ: {inp.get('name') or first_line(inp.get('prompt') or inp.get('task')) or ''}", 60)
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


def perm_item(name, inp):
    """承認の中身。id は道具の名前と引数から作る（PermissionRequest には tool_use_id が無いため）"""
    inp = inp if isinstance(inp, dict) else {}
    detail = inp.get("command") or inp.get("file_path") or inp.get("url") or inp.get("pattern") or inp.get("query") or ""
    if not detail and inp:
        detail = json.dumps(inp, ensure_ascii=False)
    key = json.dumps({"t": name, "i": inp}, ensure_ascii=False, sort_keys=True)
    return {"tool": name, "summary": describe_tool(name, inp), "detail": str(detail)[:400], "id": "h:" + hashlib.sha1(key.encode()).hexdigest()[:16]}


def keep_input(sid, data):
    """承認の画面に出る道具の名前と input 全体を残す。transcript には、承認の画面が出ている間に道具の行が
    まだ書かれていないことがあった（2026-11-22、Claude Code 2.1.330）。PermissionRequest は画面が出る前に必ず届く。
    agent_id はチームメイトと sub-agent の印で、Claude Town はその承認には答えない"""
    PERM_DIR.mkdir(parents=True, exist_ok=True)
    p = PERM_DIR / f"{sid}.json"
    try:
        items = json.loads(p.read_text()).get("items") or []
    except Exception:
        items = []
    agent = data.get("agent_id")
    items.append({"tool_name": data.get("tool_name", ""), "tool_input": data.get("tool_input"),
                  "agent_id": agent if isinstance(agent, str) and agent else None, "at": int(time.time() * 1000)})
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"items": items[-PERM_KEEP:]}, ensure_ascii=False))
    os.replace(tmp, p)


def read_queue(sid):
    try:
        return json.loads((STATE_DIR / f"{sid}.json").read_text()).get("perm_queue") or []
    except Exception:
        return []


def write_queue(sid, q, data, phase, needs):
    # pending は並びがちょうど1件のときの中身。2件以上なら None にして、画面からの許可を止める
    write(sid, {"perm_queue": q, "pending_count": len(q), "pending": q[0] if len(q) == 1 else None,
                "phase": phase if q or phase != "needs_you" else "working", "needs": needs if q else None}, data)


# 人が打った文ではない包み（裏の仕事の通知、システムの差し込み、ローカルコマンドの出力）。これで始まる入力は頼まれたことにしない
NOT_HUMAN = re.compile(r"^\s*<(task-notification|system-reminder|local-command-[a-z-]+|bash-[a-z-]+)\b")


PRELUDE = re.compile(r"^\s*Another Claude session sent a message:\s*\n")


def unwrap(prompt):
    """ターミナルに届いたお手紙の前置きの1行を外し、<cross-session-message> があれば包みの内側だけを返す"""
    p = PRELUDE.sub("", prompt)
    m = re.search(r"<cross-session-message[^>]*>(.*?)(</cross-session-message>|$)", p, re.S)
    return m.group(1).strip() if m else p.strip()


def asked_of(prompt):
    """UserPromptSubmit の文から（頼まれたことの1行目, 出どころ）を返す。出どころは human か session。頼まれたことにしない文は ("", None)"""
    if NOT_HUMAN.match(prompt):
        return "", None
    # 別セッションからの文は <cross-session-message ...> で包まれていたり、1行目が from 行だったりするので、本文の1行目を取る
    unwrapped = PRELUDE.sub("", prompt).strip()
    by = "session" if re.search(r"<cross-session-message[^>]*>|^from agent:\S+ via \S+", unwrapped) else "human"
    body = unwrap(prompt)
    body = re.sub(r"^from \S+ via \S+\s*\n", "", body)
    if NOT_HUMAN.match(body):
        return "", None
    return clip(first_line(body)), by


def cur_field(sid, key):
    try:
        return json.loads((STATE_DIR / f"{sid}.json").read_text()).get(key)
    except Exception:
        return None


# お手紙（セッションどうしのやり取り）。送った道具の名前 → 記録の種類
LETTER_TOOLS = {"SendMessage": "send", "mcp__ccn__send_message": "ccn_send", "mcp__ccn__create_session": "ccn_create"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def append_letter(rec):
    """letters.jsonl に1行足す。1行は1回の write で書く。1MB を超えたら .1 に移して新しく始める"""
    rec["at"] = int(time.time() * 1000)
    rec["id"] = hashlib.sha1(json.dumps(rec, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
    LETTERS.parent.mkdir(parents=True, exist_ok=True)
    try:
        if LETTERS.stat().st_size > LETTERS_MAX:
            os.replace(LETTERS, LETTERS.with_suffix(".1.jsonl"))
    except FileNotFoundError:
        pass
    line = (json.dumps(rec, ensure_ascii=False) + "\n").encode()
    fd = os.open(LETTERS, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)


def letter_sent(sid, name, inp, resp):
    """送った記録。宛先は生のまま残し、セッション ID への結び付けはアプリがする"""
    kind = LETTER_TOOLS[name]
    inp = inp if isinstance(inp, dict) else {}
    text = json.dumps(resp, ensure_ascii=False) if not isinstance(resp, str) else resp
    if kind == "send":
        if isinstance(resp, dict) and resp.get("success") is False:
            return
        to, body = str(inp.get("to") or ""), inp.get("summary") or first_line(inp.get("message") if isinstance(inp.get("message"), str) else "")
        to_id = None
    elif kind == "ccn_send":
        to, body = str(inp.get("session") or ""), first_line(inp.get("text"))
        m = UUID.search(text)
        to_id = m.group(0) if m else None
    else:
        # create_session の返り値の id が、新しい子のセッション ID
        m = UUID.search(text)
        to, body, to_id = "", first_line(inp.get("prompt")) or "（最初の文なし）", (m.group(0) if m else None)
    if not to and not to_id:
        return
    append_letter({"ev": "sent", "kind": kind, "from": sid, "to": to, "to_id": to_id, "peer": inp.get("peer") or None, "summary": clip(body, 60)})


def letter_received(sid, prompt):
    """受けた記録。<cross-session-message from=... from-name=...> か、1行目が from agent:<ノード>/<sid8>/<役割> via <ノード> の文"""
    m = re.search(r"<cross-session-message\s+([^>]*)>", prompt)
    if m:
        attrs = dict(re.findall(r'([a-z-]+)="([^"]*)"', m.group(1)))
        body = unwrap(prompt)
        append_letter({"ev": "received", "to": sid, "from_raw": attrs.get("from"), "from_name": attrs.get("from-name"), "summary": clip(first_line(body), 60)})
        return
    m = re.match(r"\s*from agent:([^/\s]+)/([0-9a-fA-F]{8})[^\s]* via (\S+)\s*\n?(.*)", PRELUDE.sub("", prompt), re.S)
    if m:
        append_letter({"ev": "received", "to": sid, "from_node": m.group(1), "from_sid8": m.group(2).lower(), "summary": clip(first_line(m.group(4)), 60)})


def emit_context(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}, ensure_ascii=False))


def sweep():
    now = time.time()
    for p in [*STATE_DIR.glob("*.json"), *PERM_DIR.glob("*.json")]:
        try:
            if now - p.stat().st_mtime > KEEP_SEC:
                p.unlink()
        except Exception:
            pass


def from_agent(sid, ev, data):
    """チームメイトか sub-agent の入力。承認の並びだけを触り、doing、tools、said、asked、お手紙には書かない。
    2026-11-21 の実機（Claude Code 2.1.330、in-process）では、チームメイトの PermissionRequest と承認後の PostToolUse に
    agent_id が付き、承認の Notification には付かなかった。承認の画面はリードの端末に出た"""
    if ev == "PermissionRequest":
        keep_input(sid, data)
        q = read_queue(sid)
        item = perm_item(data.get("tool_name", ""), data.get("tool_input"))
        if not any(x["id"] == item["id"] for x in q):
            q.append(item)
        write_queue(sid, q, data, phase="needs_you", needs=f"承認待ち: {item['summary']}")
    elif ev in ("PostToolUse", "PostToolUseFailure"):
        # 並びに無い道具（承認の要らなかった道具）では何も書かない
        done_id = perm_item(data.get("tool_name", ""), data.get("tool_input"))["id"]
        q = read_queue(sid)
        rest = [x for x in q if x["id"] != done_id]
        if len(rest) == len(q):
            return
        if rest:
            write_queue(sid, rest, data, phase="needs_you", needs=f"承認待ち: {rest[0]['summary']}")
        else:
            # 並びが空になったら、リードの番の途中（doing がある）なら working、番の外なら resting に戻す。
            # リードは自分の番の間は doing を必ず持ち、Stop と SessionStart で None にする
            write_queue(sid, rest, data, phase="working" if cur_field(sid, "doing") else "resting", needs=None)


def main():
    # close-check などの裏方の claude -p は数えない
    if os.environ.get("CLOSE_CHECK_CHILD") or os.environ.get("FC_REPORT_OFF"):
        return
    data = json.loads(sys.stdin.read() or "{}")
    sid = data.get("session_id")
    if not sid or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", sid):
        return
    ev = data.get("hook_event_name") or (sys.argv[1] if len(sys.argv) > 1 else "")
    agent = data.get("agent_id")
    if isinstance(agent, str) and agent:
        from_agent(sid, ev, data)
        return

    if ev == "UserPromptSubmit":
        prompt = data.get("prompt") or ""
        patch = {"phase": "working", "doing": "考え中", "needs": None, "tools": 0,
                 "turn_started_at": int(time.time() * 1000), "perm_queue": [], "pending": None, "pending_count": 0}
        try:
            letter_received(sid, prompt)
        except Exception:
            pass
        asked, by = asked_of(prompt)
        # 頼まれたことを上書きするのは、人が打った文か、まだ人の依頼が入っていないときの別セッションからの文だけ。
        # 親に届く子の報告で、人の依頼が消えないようにする
        if asked and (by == "human" or cur_field(sid, "asked_by") != "human"):
            patch.update({"asked": asked, "asked_by": by})
        write(sid, patch, data)
    elif ev == "PreToolUse":
        p = STATE_DIR / f"{sid}.json"
        try:
            n = json.loads(p.read_text()).get("tools", 0) + 1
        except Exception:
            n = 1
        name = data.get("tool_name", "")
        inp = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
        write(sid, {"phase": "working", "doing": describe_tool(name, inp), "needs": None, "tools": n}, data)
    elif ev == "PermissionRequest":
        # 承認の画面が出る道具を、並びの末尾に足す。画面からの許可は、並びがちょうど1件のときだけにする
        keep_input(sid, data)
        q = read_queue(sid)
        item = perm_item(data.get("tool_name", ""), data.get("tool_input"))
        if not any(x["id"] == item["id"] for x in q):
            q.append(item)
        write_queue(sid, q, data, phase="needs_you", needs=f"承認待ち: {item['summary']}")
    elif ev in ("PostToolUse", "PostToolUseFailure"):
        # 終わった道具を承認の並びから外す
        done_id = perm_item(data.get("tool_name", ""), data.get("tool_input"))["id"]
        q = [x for x in read_queue(sid) if x["id"] != done_id]
        write_queue(sid, q, data, phase="working", needs=None)
        if ev == "PostToolUse" and data.get("tool_name") in LETTER_TOOLS:
            try:
                letter_sent(sid, data.get("tool_name"), data.get("tool_input"), data.get("tool_response"))
            except Exception:
                pass
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
            "pending": None,
            "perm_queue": [],
            "pending_count": 0,
        }, data)
    elif ev == "SessionStart":
        sweep()
        write(sid, {"phase": "resting", "doing": None, "needs": None}, data)
    elif ev == "SessionEnd":
        for p in (STATE_DIR / f"{sid}.json", PERM_DIR / f"{sid}.json"):
            try:
                p.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
