"""RustとTypeScriptの試験が読む見本 src/report-cases.json を、fc-report.py の実出力と突き合わせる試験（#115 手順4）。

見本は events（hook に渡す入力の並び）と state（その後の状態ファイル）の組。
Python はここで events を fc-report.py に流して、出た state が見本と一致することを検べる。
Rust（src-tauri/src/lib.rs の report_cases）と TypeScript（src/model.test.ts）は同じ見本を読み、Report の形で解釈できることを検べる。
時刻の2キー（updated_at、turn_started_at）は実行のたびに変わるので、見本では 0 にそろえる。
見本を作り直すとき: FC_WRITE_FIXTURE=1 python3 -I -m unittest discover -s hooks
FC_STATE_DIR と FC_LETTERS は一時の場所に向くので、本物の ~/.family-computing には書かない。
"""
import json
import os
import unittest
from pathlib import Path

from test_fc_report import HookCase

FIXTURE = Path(__file__).resolve().parent.parent / "src" / "report-cases.json"
CLOCK_KEYS = ("updated_at", "turn_started_at")


def prompt(text):
    return {"hook_event_name": "UserPromptSubmit", "prompt": text, "cwd": "/tmp/x"}


TOOL = {"tool_name": "Bash", "tool_input": {"command": "rm x"}}
WRITE = {"tool_name": "Write", "tool_input": {"file_path": "/a/b.txt"}}
ASK = {"hook_event_name": "PermissionRequest"}
STOP = {"hook_event_name": "Stop", "last_assistant_message": "beta を呼んだ"}
MATE_TOOL = {"agent_id": "abeta-584d11236f35ece0", "agent_type": "beta", "tool_name": "Bash", "tool_input": {"command": "touch beta.txt"}}

SCENARIOS = [
    ("依頼を受けて考え中", [prompt("試し\n2行目")]),
    ("道具を使っている", [prompt("a"), {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "/a/b/c.ts"}}]),
    ("承認待ちが1件（pending に中身が入る）", [prompt("a"), {**ASK, **TOOL}]),
    ("承認待ちが2件（pending は null、件数は2）", [prompt("a"), {**ASK, **TOOL}, {**ASK, **WRITE}]),
    ("承認が済んで作業に戻る", [prompt("a"), {**ASK, **TOOL}, {"hook_event_name": "PostToolUse", **TOOL}]),
    ("終わって休む（次の一手つき）", [prompt("a"), {"hook_event_name": "Stop", "last_assistant_message": "# 終わった\n詳細\n次: PRを出す"}]),
    ("問いかけで止まる", [prompt("a"), {"hook_event_name": "Stop", "last_assistant_message": "どうする？"}]),
    ("セッションが始まったところ", [{"hook_event_name": "SessionStart", "cwd": "/tmp/y"}]),
    # in-process のチームメイトの入力は session_id がリードと同じで、agent_id が付く（2026-11-21 の実機の形）
    ("休んだリードは、チームメイトが道具を使っても休んだまま", [prompt("a"), STOP, {"hook_event_name": "PreToolUse", **MATE_TOOL}, {"hook_event_name": "PostToolUse", **MATE_TOOL}]),
    ("チームメイトの承認待ちはリードの承認待ちになる（画面はリードの端末に出る）", [prompt("a"), STOP, {**ASK, **MATE_TOOL}]),
    ("チームメイトの承認が済むと、休んだリードは休みに戻る", [prompt("a"), STOP, {**ASK, **MATE_TOOL}, {"hook_event_name": "PostToolUse", **MATE_TOOL}]),
    # 承認の画面で理由なしの No か Esc を押したときに届いた並び（#180、2026-11-23 に Claude Code 2.1.330 で実測）。
    # この後は PostToolUse も PostToolUseFailure も Stop も来ず、phase は needs_you のまま残る。画面側（src/model.ts の moodOf）が見分ける
    ("承認の画面を No か Esc で閉じた（この後に hook は来ない）", [
        prompt("a"), {"hook_event_name": "PreToolUse", **WRITE}, {**ASK, **WRITE},
        {"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission"},
    ]),
]


class ReportFixture(HookCase):
    def replay(self, events):
        for ev in events:
            fields = dict(ev)
            self.run_hook(fields.pop("hook_event_name"), **fields)
        st = self.read()
        for k in CLOCK_KEYS:
            if k in st:
                self.assertIsInstance(st[k], int)
                st[k] = 0
        return st

    def fresh(self):
        """ケースごとに状態の置き場を空にする"""
        self.setUp()

    def test_fixture_matches_real_output(self):
        if os.environ.get("FC_WRITE_FIXTURE") == "1":
            out = []
            for name, events in SCENARIOS:
                self.fresh()
                out.append({"name": name, "events": events, "state": self.replay(events)})
            FIXTURE.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
        cases = json.loads(FIXTURE.read_text())
        self.assertEqual([c["name"] for c in cases], [n for n, _ in SCENARIOS], "見本と SCENARIOS がずれている")
        for c in cases:
            with self.subTest(c["name"]):
                self.fresh()
                st = self.replay(c["events"])
                self.check_report(st)
                self.assertEqual(st, c["state"])


if __name__ == "__main__":
    unittest.main()
