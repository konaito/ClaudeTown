"""survey.py を合成の ~/.claude に向けて回す試験（#212）。

標準ライブラリだけで動く。実行: python3 -m unittest discover -s scripts/native -v
一時の場所（tempfile.mkdtemp）に置き場所を作り、survey.py の引数に渡すので、本物の ~/.claude は読まない。
生きているセッションの pid には、この試験のプロセスの pid を使う。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SURVEY = Path(__file__).with_name("survey.py")
JA_SID = "0123abcd-0000-0000-0000-00000000000a"
BAD_SID = "0123abcd-0000-0000-0000-00000000000b"


def project_dir_name(cwd):
    # src-tauri/src/native/sessions.rs の project_dir_name と同じ。ASCII の英数字以外を全部 - にする
    return "".join(c if c.isascii() and c.isalnum() else "-" for c in cwd)


def put_session(root, cwd, sid):
    pid = os.getpid()
    (root / "sessions").mkdir(parents=True, exist_ok=True)
    # 同じ pid で2本置くので、ファイル名は sid で分ける（survey.py は名前を見ない）
    (root / "sessions" / f"{sid}.json").write_text(json.dumps({"pid": pid, "cwd": cwd, "sessionId": sid}))
    proj = root / "projects" / project_dir_name(cwd)
    proj.mkdir(parents=True, exist_ok=True)
    (proj / f"{sid}.jsonl").write_text(json.dumps({"type": "user", "sessionId": sid}) + "\n")
    return proj / sid


class SurveyTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="survey-test-"))
        self.addCleanup(shutil.rmtree, self.root)

    def run_survey(self):
        return subprocess.run(
            [sys.executable, "-I", str(SURVEY), str(self.root)],
            capture_output=True, text=True, timeout=60,
        )

    def live_line(self, out):
        lines = [l for l in out.splitlines() if l.startswith("生きているセッション")]
        self.assertEqual(len(lines), 1, out)
        return lines[0]

    def test_japanese_cwd_is_found(self):
        put_session(self.root, "/tmp/日本語の場所", JA_SID)
        r = self.run_survey()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("jsonl が見つからない", r.stdout)
        # jsonl の大きさが1本分出る
        self.assertRegex(self.live_line(r.stdout), r"^生きているセッション 1 jsonl の大きさ\(MB\) \[0\.0\]")

    def test_broken_meta_is_counted_not_crash(self):
        base = put_session(self.root, "/tmp/ascii-place", BAD_SID)
        sub = base / "subagents"
        sub.mkdir(parents=True)
        (sub / "agent-x.meta.json").write_text("{壊れている")
        (sub / "agent-x.jsonl").write_text(json.dumps({"type": "user", "isSidechain": True}) + "\n")
        r = self.run_survey()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("生きているセッション 1", r.stdout)
        self.assertIn("'meta: JSON でない': 1", r.stdout.split("生きているセッション", 1)[1])

    def test_both_together(self):
        put_session(self.root, "/tmp/日本語の場所", JA_SID)
        base = put_session(self.root, "/tmp/ascii-place", BAD_SID)
        sub = base / "subagents"
        sub.mkdir(parents=True)
        (sub / "agent-x.meta.json").write_text("{壊れている")
        r = self.run_survey()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("生きているセッション 2", r.stdout)
        self.assertNotIn("jsonl が見つからない", r.stdout)


if __name__ == "__main__":
    unittest.main()
