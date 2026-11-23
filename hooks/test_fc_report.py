"""fc-report.py が書く状態ファイルとお手紙の形を固定する試験（#115）。

標準ライブラリだけで動く。実行: python3 -m unittest discover -s hooks -v
FC_STATE_DIR と FC_LETTERS を一時の場所に向けるので、本物の ~/.family-computing/ には書かない。
形は src/model.ts の Report と合わせている。Report が変わったら、ここの REPORT_TYPES も直す。
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name("fc-report.py")
SID = "0123abcd-0000-0000-0000-000000000001"
SID2 = "0123abcd-0000-0000-0000-000000000002"
CHILD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
# in-process のチームメイトの印（2026-11-21 の実機の形。session_id はリードのもの）
MATE = {"agent_id": "abeta-584d11236f35ece0", "agent_type": "beta"}

# src/model.ts の Report。null を許すキーは NoneType も入れる。
NONE = type(None)
REPORT_TYPES = {
    "phase": (str,),
    "asked": (str,),
    "doing": (str, NONE),
    "said": (str,),
    "next": (str, NONE),
    "needs": (str, NONE),
    "tools": (int,),
    "turn_started_at": (int,),
    "updated_at": (int,),
    "pending": (dict, NONE),
    "pending_count": (int,),
    "perm_queue": (list,),
}
PHASES = {"working", "needs_you", "resting"}
PERM_KEYS = {"tool": str, "summary": str, "detail": str, "id": str}


class HookCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.state = self.dir / "state"
        self.letters = self.dir / "letters.jsonl"

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if k not in ("CLOSE_CHECK_CHILD", "FC_REPORT_OFF")}
        env.update(FC_STATE_DIR=str(self.state), FC_LETTERS=str(self.letters), FC_PERM_DIR=str(self.dir / "perm"), **extra)
        return env

    def run_hook(self, event, sid=SID, env=None, **fields):
        payload = {"session_id": sid, "hook_event_name": event, **fields}
        r = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), env=env or self.env(),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def read(self, sid=SID):
        return json.loads((self.state / f"{sid}.json").read_text())

    def check_report(self, st):
        self.assertIsInstance(st["session_id"], str)
        self.assertIn(st["phase"], PHASES)
        for key, types in REPORT_TYPES.items():
            if key in st:
                self.assertIsInstance(st[key], types, f"{key}={st[key]!r}")
        for item in st.get("perm_queue", []):
            self.assertEqual(set(item), set(PERM_KEYS))
            for k, t in PERM_KEYS.items():
                self.assertIsInstance(item[k], t)
        if st.get("pending"):
            self.assertEqual(set(st["pending"]), set(PERM_KEYS))
        if "perm_queue" in st:
            self.assertEqual(st["pending_count"], len(st["perm_queue"]))


class StateShape(HookCase):
    def test_user_prompt_submit(self):
        self.run_hook("UserPromptSubmit", prompt="試し\n2行目", cwd="/tmp/x")
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "working")
        self.assertEqual(st["asked"], "試し")
        self.assertEqual(st["asked_by"], "human")
        self.assertEqual(st["doing"], "考え中")
        self.assertEqual(st["tools"], 0)
        self.assertEqual(st["perm_queue"], [])
        self.assertIsNone(st["pending"])
        self.assertEqual(st["cwd"], "/tmp/x")
        self.assertEqual(st["session_id"], SID)

    def test_pre_tool_use_counts_tools(self):
        self.run_hook("UserPromptSubmit", prompt="a")
        self.run_hook("PreToolUse", tool_name="Bash", tool_input={"command": "bun test"})
        self.assertEqual(self.read()["doing"], "コマンド: bun test")
        self.run_hook("PreToolUse", tool_name="Read", tool_input={"file_path": "/a/b/c.ts"})
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["tools"], 2)
        self.assertEqual(st["doing"], "読む: b/c.ts")

    def test_permission_request_and_post_tool_use(self):
        self.run_hook("UserPromptSubmit", prompt="a")
        tool = dict(tool_name="Bash", tool_input={"command": "rm x"})
        self.run_hook("PermissionRequest", **tool)
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "needs_you")
        self.assertEqual(st["pending_count"], 1)
        self.assertEqual(st["pending"], st["perm_queue"][0])
        self.assertEqual(st["pending"]["tool"], "Bash")
        self.assertEqual(st["pending"]["detail"], "rm x")
        self.assertTrue(st["pending"]["id"].startswith("h:"))
        self.assertEqual(st["needs"], "承認待ち: コマンド: rm x")
        # 同じ道具の2回目は並びに足さない
        self.run_hook("PermissionRequest", **tool)
        self.assertEqual(self.read()["pending_count"], 1)
        # 別の道具が足されると pending は None になり、件数は2
        self.run_hook("PermissionRequest", tool_name="Write", tool_input={"file_path": "/a/b.txt"})
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["pending_count"], 2)
        self.assertIsNone(st["pending"])
        # 終わった道具だけが外れる
        self.run_hook("PostToolUse", **tool)
        st = self.read()
        self.check_report(st)
        self.assertEqual([x["tool"] for x in st["perm_queue"]], ["Write"])
        self.assertEqual(st["phase"], "working")  # 並びが残っていても PostToolUse は working に戻す（現状の挙動）
        self.run_hook("PostToolUse", tool_name="Write", tool_input={"file_path": "/a/b.txt"})
        st = self.read()
        self.assertEqual(st["phase"], "working")
        self.assertIsNone(st["needs"])
        self.assertEqual(st["pending_count"], 0)

    def test_notification(self):
        self.run_hook("UserPromptSubmit", prompt="a")
        self.run_hook("Notification", notification_type="idle_prompt", message="待ってる")
        self.assertEqual(self.read()["phase"], "working")
        self.run_hook("Notification", notification_type="permission_prompt", message="Bash を許可しますか")
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "needs_you")
        self.assertEqual(st["needs"], "Bash を許可しますか")

    def test_denied_permission_leaves_marks_for_the_screen(self):
        """承認の画面を理由なしの No か Esc で閉じたときに届いた並び（#180、2026-11-23 に Claude Code 2.1.330 で実測。
        No と Esc で同じだった）。この後は PostToolUse も PostToolUseFailure も Stop も来ないので、hook では needs_you を解けない。
        画面（src/model.ts の moodOf）は、承認が元の needs_you（pending_count が1以上）と、その後に sessions の status が
        idle に変わったことで見分ける。ここでは、画面が頼る印が残ることを固定する"""
        write = dict(tool_name="Write", tool_input={"file_path": "/tmp/x/out.txt", "content": "hello"})
        self.run_hook("UserPromptSubmit", prompt="Write で /tmp/x/out.txt を作って")
        self.run_hook("PreToolUse", **write)
        self.run_hook("PermissionRequest", **write)
        self.run_hook("Notification", notification_type="permission_prompt", message="Claude needs your permission")
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "needs_you")
        self.assertEqual(st["pending_count"], 1)
        self.assertEqual(st["perm_queue"][0]["tool"], "Write")
        self.assertIsInstance(st["updated_at"], int)

    def test_stop_resting_with_next(self):
        self.run_hook("UserPromptSubmit", prompt="a")
        self.run_hook("PreToolUse", tool_name="Bash", tool_input={"command": "ls"})
        self.run_hook("Stop", last_assistant_message="# 終わった\n詳細\n次: PRを出す")
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "resting")
        self.assertEqual(st["said"], "終わった")
        self.assertEqual(st["next"], "PRを出す")
        self.assertIsNone(st["doing"])
        self.assertIsNone(st["needs"])
        self.assertEqual(st["perm_queue"], [])
        self.assertEqual(st["asked"], "a")

    def test_stop_asking(self):
        self.run_hook("UserPromptSubmit", prompt="a")
        self.run_hook("Stop", last_assistant_message="どうする？")
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "needs_you")
        self.assertEqual(st["needs"], "質問に答えてほしい")
        self.assertEqual(st["next"], "どうする？")

    def test_session_start_and_end(self):
        self.run_hook("SessionStart", cwd="/tmp/y")
        st = self.read()
        self.check_report(st)
        self.assertEqual(st["phase"], "resting")
        self.assertIsNone(st["doing"])
        self.run_hook("SessionEnd")
        self.assertFalse((self.state / f"{SID}.json").exists())

    def test_session_start_sweeps_old_files(self):
        self.state.mkdir()
        old = self.state / f"{SID2}.json"
        old.write_text("{}")
        t = old.stat().st_mtime - 4 * 24 * 3600
        os.utime(old, (t, t))
        self.run_hook("SessionStart")
        self.assertFalse(old.exists())

    def test_no_made_child_flag(self):
        # made_child は名付けの促しに使っていた。#93 で促しを消し、アプリにも安定版にも読み手が無いので書かない（#186）
        self.run_hook("SessionStart")
        self.run_hook("PostToolUse", tool_name="mcp__ccn__create_session",
                      tool_input={"prompt": "x"}, tool_response=json.dumps({"id": CHILD_ID}))
        self.assertNotIn("made_child", self.read())

    def test_session_message_does_not_override_human_asked(self):
        self.run_hook("UserPromptSubmit", prompt="人の依頼")
        self.run_hook("UserPromptSubmit", prompt="from agent:n/12345678/child via n\n子の報告")
        st = self.read()
        self.assertEqual(st["asked"], "人の依頼")
        self.assertEqual(st["asked_by"], "human")

    def test_not_human_prompt_is_not_asked(self):
        self.run_hook("UserPromptSubmit", prompt="<system-reminder>x</system-reminder>")
        self.assertNotIn("asked", self.read())

    def test_off_switches_and_bad_session_id_write_nothing(self):
        for key in ("FC_REPORT_OFF", "CLOSE_CHECK_CHILD"):
            env = dict(os.environ, FC_STATE_DIR=str(self.state), FC_LETTERS=str(self.letters), **{key: "1"})
            self.run_hook("SessionStart", env=env)
        self.run_hook("SessionStart", sid="../evil")
        self.assertFalse(self.state.exists())


class TeammateInputs(HookCase):
    """agent_id の付いた入力（in-process のチームメイトと sub-agent）は、リードの様子に混ぜない"""

    def rested(self):
        self.run_hook("UserPromptSubmit", prompt="依頼")
        self.run_hook("PreToolUse", tool_name="Agent", tool_input={"description": "beta を呼ぶ", "name": "beta"})
        self.run_hook("Stop", last_assistant_message="beta を呼んだ")
        return self.read()

    def test_tool_use_does_not_touch_lead(self):
        before = self.rested()
        tool = dict(tool_name="Bash", tool_input={"command": "touch beta.txt"}, **MATE)
        self.run_hook("PreToolUse", **tool)
        self.run_hook("PostToolUse", **tool)
        self.run_hook("PostToolUseFailure", **tool)
        self.run_hook("SubagentStop", last_assistant_message="終わった", **MATE)
        self.run_hook("Stop", last_assistant_message="チームメイトの返事？", **MATE)
        self.run_hook("UserPromptSubmit", prompt="チームメイトへの文", **MATE)
        self.run_hook("Notification", notification_type="permission_prompt", message="x", **MATE)
        st = self.read()
        self.assertEqual(st, before)
        self.assertEqual((st["phase"], st["doing"], st["tools"], st["said"]), ("resting", None, 1, "beta を呼んだ"))

    def test_session_end_with_agent_id_keeps_lead_file(self):
        self.rested()
        self.run_hook("SessionEnd", **MATE)
        self.assertTrue((self.state / f"{SID}.json").exists())

    def test_permission_goes_to_lead_queue_and_back_to_resting(self):
        self.rested()
        tool = dict(tool_name="Bash", tool_input={"command": "touch beta.txt"})
        self.run_hook("PreToolUse", **tool, **MATE)
        self.run_hook("PermissionRequest", **tool, **MATE)
        st = self.read()
        self.check_report(st)
        self.assertEqual((st["phase"], st["needs"], st["pending_count"]), ("needs_you", "承認待ち: コマンド: touch beta.txt", 1))
        self.assertEqual(st["pending"]["tool"], "Bash")
        self.assertIsNone(st["doing"])
        self.assertEqual(st["tools"], 1)
        # 承認の通知には agent_id が付かない（実機の形）
        self.run_hook("Notification", notification_type="permission_prompt", message="Claude needs your permission")
        self.run_hook("PostToolUse", **tool, **MATE)
        st = self.read()
        self.check_report(st)
        self.assertEqual((st["phase"], st["needs"], st["pending_count"], st["pending"]), ("resting", None, 0, None))

    def test_permission_during_lead_turn_returns_to_working(self):
        self.run_hook("UserPromptSubmit", prompt="依頼")
        self.run_hook("PreToolUse", tool_name="Read", tool_input={"file_path": "/a/b/c.ts"})
        tool = dict(tool_name="Bash", tool_input={"command": "touch beta.txt"}, **MATE)
        self.run_hook("PermissionRequest", **tool)
        self.assertEqual(self.read()["phase"], "needs_you")
        self.run_hook("PostToolUse", **tool)
        st = self.read()
        self.assertEqual((st["phase"], st["doing"], st["pending_count"]), ("working", "読む: b/c.ts", 0))

    def test_other_items_stay_queued(self):
        self.rested()
        mine = dict(tool_name="Write", tool_input={"file_path": "/a/b.txt"})
        mate = dict(tool_name="Bash", tool_input={"command": "touch beta.txt"}, **MATE)
        self.run_hook("PermissionRequest", **mine)
        self.run_hook("PermissionRequest", **mate)
        self.assertEqual(self.read()["pending_count"], 2)
        self.run_hook("PostToolUse", **mate)
        st = self.read()
        self.check_report(st)
        self.assertEqual([x["tool"] for x in st["perm_queue"]], ["Write"])
        self.assertEqual((st["phase"], st["needs"]), ("needs_you", "承認待ち: 書く: a/b.txt"))

    def test_mate_writes_no_letters(self):
        self.run_hook("SessionStart")
        self.run_hook("PostToolUse", tool_name="SendMessage", tool_input={"to": "team-lead", "summary": "報告", "message": "x"},
                      tool_response={"success": True}, **MATE)
        self.run_hook("PostToolUse", tool_name="mcp__ccn__create_session", tool_input={"prompt": "x"},
                      tool_response=json.dumps({"id": CHILD_ID}), **MATE)
        self.run_hook("UserPromptSubmit", prompt='<cross-session-message from="abc">x</cross-session-message>', **MATE)
        self.assertFalse(self.letters.exists())

    def test_empty_agent_id_is_lead(self):
        self.run_hook("UserPromptSubmit", prompt="a", agent_id="")
        self.run_hook("PreToolUse", tool_name="Bash", tool_input={"command": "ls"}, agent_id=None, agent_type="general-purpose")
        st = self.read()
        self.assertEqual((st["doing"], st["tools"]), ("コマンド: ls", 1))


class LettersShape(HookCase):
    def lines(self):
        return [json.loads(l) for l in self.letters.read_text().splitlines()]

    def test_sent_send_message(self):
        self.run_hook("PostToolUse", tool_name="SendMessage",
                      tool_input={"to": "worker", "summary": "依頼", "message": "本文"}, tool_response={"success": True})
        (rec,) = self.lines()
        self.assertEqual(rec["ev"], "sent")
        self.assertEqual(rec["kind"], "send")
        self.assertEqual(rec["from"], SID)
        self.assertEqual(rec["to"], "worker")
        self.assertEqual(rec["summary"], "依頼")
        self.assertIsInstance(rec["at"], int)
        self.assertEqual(len(rec["id"]), 12)
        for k in ("to_id", "peer"):
            self.assertIn(k, rec)

    def test_failed_send_message_is_not_recorded(self):
        self.run_hook("PostToolUse", tool_name="SendMessage",
                      tool_input={"to": "worker", "message": "x"}, tool_response={"success": False})
        self.assertFalse(self.letters.exists())

    def test_sent_ccn_create_session_has_to_id(self):
        self.run_hook("PostToolUse", tool_name="mcp__ccn__create_session",
                      tool_input={"prompt": "調べて"}, tool_response=json.dumps({"id": CHILD_ID}))
        (rec,) = self.lines()
        self.assertEqual((rec["kind"], rec["to_id"], rec["summary"]), ("ccn_create", CHILD_ID, "調べて"))

    def test_received_cross_session_message(self):
        self.run_hook("UserPromptSubmit",
                      prompt='<cross-session-message from="abc" from-name="親">依頼です\n詳細</cross-session-message>')
        (rec,) = self.lines()
        self.assertEqual(rec["ev"], "received")
        self.assertEqual(rec["to"], SID)
        self.assertEqual(rec["from_raw"], "abc")
        self.assertEqual(rec["from_name"], "親")
        self.assertEqual(rec["summary"], "依頼です")

    def test_received_from_agent_line(self):
        self.run_hook("UserPromptSubmit", prompt="from agent:node1/ABCDEF12/worker via node1\n報告です")
        (rec,) = self.lines()
        self.assertEqual(rec["ev"], "received")
        self.assertEqual((rec["from_node"], rec["from_sid8"], rec["summary"]), ("node1", "abcdef12", "報告です"))

    def test_rotates_over_1mb(self):
        self.letters.write_bytes(b"x" * (1024 * 1024 + 1))
        self.run_hook("PostToolUse", tool_name="SendMessage",
                      tool_input={"to": "w", "summary": "s"}, tool_response={})
        self.assertTrue(self.letters.with_suffix(".1.jsonl").exists())
        self.assertEqual(len(self.lines()), 1)


if __name__ == "__main__":
    unittest.main()


class PermInputTest(HookCase):
    """承認の画面に出る道具の input 全体を perm/<session_id>.json に残す（Claude Town の承認の欄、#83）。
    transcript には、承認の画面が出ている間に道具の行がまだ書かれていないことがあった（2026-11-22、v2.1.330）"""

    def perm(self, sid=SID):
        return json.loads((self.dir / "perm" / f"{sid}.json").read_text())

    def test_keeps_the_full_input_and_prints_nothing(self):
        qs = {"questions": [{"question": "色は？", "header": "色", "options": [{"label": "赤"}, {"label": "青"}], "multiSelect": False}]}
        r = self.run_hook("PermissionRequest", tool_name="AskUserQuestion", tool_input=qs)
        # PermissionRequest の hook の標準出力は、許可か拒否の答えとして読まれる。何も出さない
        self.assertEqual(r.stdout, "")
        items = self.perm()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["tool_name"], "AskUserQuestion")
        self.assertEqual(items[0]["tool_input"], qs)
        self.assertIsNone(items[0]["agent_id"])
        self.assertIsInstance(items[0]["at"], int)

    def test_teammate_requests_are_marked(self):
        self.run_hook("PermissionRequest", tool_name="Bash", tool_input={"command": "ls"}, **MATE)
        self.assertEqual(self.perm()["items"][0]["agent_id"], MATE["agent_id"])

    def test_keeps_only_the_last_eight(self):
        for i in range(10):
            self.run_hook("PermissionRequest", tool_name="Bash", tool_input={"command": f"echo {i}"})
        items = self.perm()["items"]
        self.assertEqual([x["tool_input"]["command"] for x in items], [f"echo {i}" for i in range(2, 10)])

    def test_state_dir_is_not_used_for_it(self):
        # 安定版も読む state/ には新しいファイルを置かない（state/*.json は古い版も読む）
        self.run_hook("PermissionRequest", tool_name="Bash", tool_input={"command": "ls"})
        self.assertEqual(sorted(p.name for p in self.state.glob("*.json")), [f"{SID}.json"])

    def test_session_end_removes_it(self):
        self.run_hook("PermissionRequest", tool_name="Bash", tool_input={"command": "ls"})
        self.run_hook("SessionEnd")
        self.assertFalse((self.dir / "perm" / f"{SID}.json").exists())
