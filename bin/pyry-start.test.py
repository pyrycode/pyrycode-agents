"""Launcher contract tests. No real dispatcher, package install or secrets are used."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

class RunnerOptionTests(unittest.TestCase):
    def launch(self, args, saved="claude", entry="pyry-start", auth_fails=False, missing_helper=False, stale_lock=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "dispatcher").mkdir()
            (root / "target").mkdir()
            fake = root / "fake"
            fake.mkdir()
            shutil.copy2(Path(__file__).with_name("pyry-start"), root / "bin/pyry-start")
            shutil.copy2(Path(__file__).with_name("pyry-restart"), root / "bin/pyry-restart")
            if stale_lock:
                (root / "target/.dispatcher.lock").write_text("PID=99999999\n")
            (root / ".env").write_text("PYRY_AGENT_RUNNER=" + saved + "\n")
            scripts = {
                "pnpm": '#!/bin/sh\nprintf install > "$TEST_ROOT/install"\n',
                "automation-access": '''#!/usr/bin/env python3
import os, sys
assert sys.argv[1]=='op'
os.environ['TEST_HELPER_USED']='yes'
os.environ['OP_SERVICE_ACCOUNT_TOKEN']='test-service-token'
os.execvp('op', ['op', *sys.argv[2:]])
''',
                "op": '''#!/usr/bin/env python3
import os, sys
assert os.environ.get('TEST_HELPER_USED')=='yes', 'service-account helper bypassed'
if os.environ.get('TEST_AUTH_FAILS')=='yes':
    print('test: service-account authentication failed', file=sys.stderr)
    sys.exit(19)
args=sys.argv[1:]
command=args[args.index('--')+1:]
# Simulate op run: saved .env values replace the parent environment.
os.environ['PYRY_AGENT_RUNNER']=os.environ['TEST_SAVED_RUNNER']
os.execv(command[0],command)
''',
                "node": '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
Path(os.environ['TEST_ROOT'],'result').write_text(json.dumps({'runner':os.environ.get('PYRY_AGENT_RUNNER'),'args':sys.argv[1:],'service_token_present':'OP_SERVICE_ACCOUNT_TOKEN' in os.environ}))
''',
                "pgrep": "#!/bin/sh\nexit 1\n",
                "sleep": "#!/bin/sh\nexit 0\n",
            }
            for name, content in scripts.items():
                p = fake / name
                p.write_text(content)
                p.chmod(0o755)
            env = dict(os.environ, PATH=str(fake) + os.pathsep + os.environ["PATH"],
                       TEST_ROOT=str(root), TEST_SAVED_RUNNER=saved,
                       TARGET_REPO_PATH=str(root / "target"), PYRY_AGENT_RUNNER="parent-value",
                       PYRY_AUTOMATION_ACCESS=str(fake / ("missing" if missing_helper else "automation-access")),
                       TEST_AUTH_FAILS="yes" if auth_fails else "no")
            run = subprocess.run(["sh", str(root / "bin" / entry), *args], env=env,
                                 capture_output=True, text=True, timeout=10)
            result = json.loads((root / "result").read_text()) if (root / "result").exists() else None
            return run, result, (root / "install").exists()

    def test_codex_overrides_saved_claude(self):
        run, result, _ = self.launch(["--runner", "codex"])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["runner"], "codex")
        self.assertFalse(result["service_token_present"])
        self.assertEqual(result["args"], ["--import", "tsx", "src/dispatch-bin.ts"])

    def test_claude_overrides_saved_codex(self):
        run, result, _ = self.launch(["--runner=claude"], saved="codex")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["runner"], "claude")

    def test_omitted_option_keeps_saved_setting(self):
        run, result, _ = self.launch([], saved="codex")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["runner"], "codex")

    def test_remaining_arguments_remain_literal(self):
        prompt = 'Use "quotes" and $(literal)'
        run, result, _ = self.launch(["--runner", "codex", "inbox", prompt])
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(result["args"][-2:], ["inbox", prompt])

    def test_bad_or_missing_runner_fails_before_install(self):
        for args in [["--runner"], ["--runner", "typo"], ["--runner="]]:
            with self.subTest(args=args):
                run, result, installed = self.launch(args)
                self.assertEqual(run.returncode, 2)
                self.assertIsNone(result)
                self.assertFalse(installed)

    def test_restart_preserves_runner_and_literal_arguments(self):
        for stale in [False, True]:
            with self.subTest(stale_lock=stale):
                run, result, _ = self.launch(["--runner", "codex", "inbox", "literal $value"],
                                             entry="pyry-restart", stale_lock=stale)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(result["runner"], "codex")
                self.assertEqual(result["args"][-2:], ["inbox", "literal $value"])

    def test_auth_failure_preserves_error_without_misleading_pid_warning(self):
        run, result, _ = self.launch([], auth_fails=True)
        self.assertEqual(run.returncode, 19, run.stderr)
        self.assertIsNone(result)
        self.assertNotIn("could not find the dispatcher's own PID", run.stderr)

    def test_missing_helper_fails_before_install(self):
        run, result, installed = self.launch([], missing_helper=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("service-account helper", run.stderr)
        self.assertIsNone(result)
        self.assertFalse(installed)

    def test_help_does_not_launch(self):
        run, result, installed = self.launch(["--help"])
        self.assertEqual(run.returncode, 0)
        self.assertIn("--runner", run.stdout)
        self.assertIsNone(result)
        self.assertFalse(installed)

if __name__ == "__main__":
    unittest.main()
