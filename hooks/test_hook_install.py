"""scripts/hook.py が settings.json に書く登録の試験（#171）。

標準ライブラリだけで動く。実行: python3 -m unittest discover -s hooks -v
FC_SETTINGS、CT_STABLE_HOME、FC_STATE_DIR、FC_LETTERS、FC_PERM_DIR を一時の場所に向けるので、
本物の ~/.claude/settings.json と ~/.family-computing/ には書かない。
hook.py と fc-report.py は一時の場所に写してから動かす（--worktree は hook.py の隣の hooks/ を登録するため）。
登録したコマンドは、Claude Code と同じくシェル（/bin/sh -c）で実行する。
"""
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HOOK_PY = REPO / "scripts" / "hook.py"
REPORT = REPO / "hooks" / "fc-report.py"
MARK = "# family-computing"
SID = "0123abcd-0000-0000-0000-0000000001a1"
EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"]
# 2026-11-23 時点で本人の ~/.claude/settings.json に入っている形（#171 より前の hook.py が書いた形）
OLD_FORM = "/usr/bin/python3 {} # family-computing"
# Claude Code が hook をどのシェルで呼ぶかはここでは決めず、両方で確かめる
SHELLS = [s for s in ("/bin/sh", "/bin/zsh") if os.path.exists(s)]
OTHER = {"type": "command", "command": "echo other-hook", "timeout": 5}


class HookInstall(unittest.TestCase):
    # 空白、引用符、$ を含む置き場で試す（登録するパスの引用を確かめるため）。ふつうの置き場は下の HookInstallPlain で試す
    SUB = "with space it's $HOME `x`"
    REPO_NAME = "copy of repo"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name) / self.SUB
        self.repo = self.dir / self.REPO_NAME
        (self.repo / "scripts").mkdir(parents=True)
        (self.repo / "hooks").mkdir()
        shutil.copy2(HOOK_PY, self.repo / "scripts" / "hook.py")
        shutil.copy2(REPORT, self.repo / "hooks" / "fc-report.py")
        self.stable = self.dir / ("stable home" if " " in self.SUB else "stable")
        self.guard = '[ -f "$f" ] || exit 0'
        (self.stable / "hooks").mkdir(parents=True)
        shutil.copy2(REPORT, self.stable / "hooks" / "fc-report.py")
        self.settings = self.dir / "settings.json"
        self.write_settings({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [dict(OTHER)]}]}, "model": "x"})
        self.state = self.dir / "state"

    def env(self):
        env = {k: v for k, v in os.environ.items() if k not in ("CLOSE_CHECK_CHILD", "FC_REPORT_OFF")}
        env.update(FC_SETTINGS=str(self.settings), CT_STABLE_HOME=str(self.stable),
                   FC_STATE_DIR=str(self.state), FC_LETTERS=str(self.dir / "letters.jsonl"),
                   FC_PERM_DIR=str(self.dir / "perm"))
        return env

    def write_settings(self, data):
        self.settings.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

    def settings_data(self):
        return json.loads(self.settings.read_text())

    def hook_py(self, *args):
        r = subprocess.run([sys.executable, str(self.repo / "scripts" / "hook.py"), *args], env=self.env(),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout

    def ours(self):
        return [(ev, h["command"]) for ev, gs in self.settings_data().get("hooks", {}).items()
                for g in gs for h in g.get("hooks", []) if MARK in h.get("command", "")]

    def run_registered(self, cmd, event="UserPromptSubmit", shell="/bin/sh"):
        payload = {"session_id": SID, "hook_event_name": event, "prompt": "試し", "cwd": "/tmp/x"}
        return subprocess.run([shell, "-c", cmd], input=json.dumps(payload), env=self.env(),
                              capture_output=True, text=True, timeout=30)

    def test_worktree_install_then_script_removed_exits_0(self):
        self.hook_py("install", "--worktree")
        ours = self.ours()
        self.assertEqual(sorted(ev for ev, _ in ours), sorted(EVENTS))
        cmds = {c for _, c in ours}
        self.assertEqual(len(cmds), 1)
        cmd = cmds.pop()
        (self.repo / "hooks" / "fc-report.py").unlink()
        for shell in SHELLS:
            for ev in EVENTS:
                r = self.run_registered(cmd, ev, shell)
                self.assertEqual(r.returncode, 0, f"{shell} {ev}: {cmd!r} -> {r.returncode} {r.stderr}")
        self.assertFalse(self.state.exists())

    def test_stable_dir_removed_exits_0(self):
        self.hook_py("install")
        cmd = self.ours()[0][1]
        self.assertIn(shlex.quote(str(self.stable / "hooks" / "fc-report.py")), cmd)
        shutil.rmtree(self.stable)
        for shell in SHELLS:
            r = self.run_registered(cmd, "PreToolUse", shell)
            self.assertEqual(r.returncode, 0, f"{shell}: {r.stderr}")

    def test_registered_command_runs_report(self):
        self.hook_py("install")
        cmd = self.ours()[0][1]
        for shell in SHELLS:
            shutil.rmtree(self.state, ignore_errors=True)
            r = self.run_registered(cmd, shell=shell)
            self.assertEqual(r.returncode, 0, f"{shell}: {r.stderr}")
            st = json.loads((self.state / f"{SID}.json").read_text())
            self.assertEqual(st["asked"], "試し")
            self.assertEqual(st["phase"], "working")

    def test_install_is_idempotent_and_keeps_other_hooks(self):
        self.hook_py("install")
        self.hook_py("install")
        self.assertEqual(len(self.ours()), len(EVENTS))
        pre = self.settings_data()["hooks"]["PreToolUse"]
        self.assertIn({"matcher": "Bash", "hooks": [OTHER]}, pre)
        self.assertEqual(self.settings_data()["model"], "x")

    def old_form_settings(self):
        old = OLD_FORM.format(self.stable / "hooks" / "fc-report.py")
        data = self.settings_data()
        for ev in EVENTS:
            data["hooks"].setdefault(ev, []).append({"hooks": [{"type": "command", "command": old, "timeout": 5}]})
        self.write_settings(data)
        return old

    def test_status_finds_old_form(self):
        old = self.old_form_settings()
        out = self.hook_py("status")
        self.assertIn("登録済み: ", out)
        self.assertIn(old, out)
        for ev in EVENTS:
            self.assertIn(ev, out)
        self.assertIn("古い形の登録がある", out)

    def test_install_replaces_old_form(self):
        old = self.old_form_settings()
        self.hook_py("install")
        ours = self.ours()
        self.assertEqual(len(ours), len(EVENTS))
        self.assertNotIn(old, {c for _, c in ours})
        for _, c in ours:
            self.assertIn(self.guard, c)
        self.assertNotIn("古い形", self.hook_py("status"))
        self.assertIn({"matcher": "Bash", "hooks": [OTHER]}, self.settings_data()["hooks"]["PreToolUse"])

    def test_uninstall_removes_old_and_new_form(self):
        self.hook_py("install")
        old = OLD_FORM.format(self.stable / "hooks" / "fc-report.py")
        data = self.settings_data()
        data["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": old, "timeout": 5}]})
        self.write_settings(data)
        self.assertIn(f"外した: {len(EVENTS) + 1}件", self.hook_py("uninstall"))
        self.assertEqual(self.ours(), [])
        self.assertEqual(self.settings_data()["hooks"], {"PreToolUse": [{"matcher": "Bash", "hooks": [OTHER]}]})


class HookInstallPlain(HookInstall):
    SUB = "plain"
    REPO_NAME = "repo"


if __name__ == "__main__":
    unittest.main()
