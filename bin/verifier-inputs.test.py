import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class VerifierInputsTests(unittest.TestCase):
    def test_external_toolchain_and_config_change_snapshot_and_unknown_inputs_disable_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "dispatcher").mkdir()
            shutil.copy2(Path(__file__).with_name("verifier-inputs"), root / "bin/verifier-inputs")
            fake = root / "fake"
            fake.mkdir()
            (fake / "git").write_text("#!/usr/bin/env python3\nimport os,sys\nfrom pathlib import Path\nargs=sys.argv[1:]\nif '--show-toplevel' in args: print(Path(args[1]).resolve())\nelif 'status' in args: print(os.environ.get('TEST_DIRTY',''))\nelif 'ls-files' in args: print(os.environ.get('TEST_UNTRACKED',''),end='')\nelse: print('a'*40)\n")
            (fake / "go").write_text("#!/usr/bin/env python3\nimport os,json,sys\nif sys.argv[1]=='env': print(json.dumps({'GOVERSION':os.environ.get('TEST_GO','go1.26'),'GOWORK':os.environ.get('TEST_WORK','off'),'GOENV':os.environ['TEST_CONFIG']}))\nelse: print(json.dumps({'Replace':{'Path':'../local'}} if os.environ.get('TEST_REPLACE') else {'Path':'main'}))\n")
            for executable in fake.iterdir():
                executable.chmod(0o755)
            config = root / "goenv"
            config.write_text("first")
            env = dict(os.environ, PATH=str(fake) + os.pathsep + os.environ["PATH"], TEST_CONFIG=str(config))

            def run(**changes):
                return subprocess.run([str(root / "bin/verifier-inputs")], env=dict(env, **changes), capture_output=True, text=True, timeout=10)

            first = run()
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(first.stdout, run().stdout)
            self.assertNotEqual(first.stdout, run(TEST_GO="go1.27").stdout)
            config.write_text("second")
            self.assertNotEqual(first.stdout, run().stdout)
            external = root / "extra.go"
            external.write_text("first source")
            (root / "dispatcher/extra.go").write_text("dispatcher source")
            untracked = run(TEST_UNTRACKED="extra.go")
            self.assertEqual(untracked.returncode, 0, untracked.stderr)
            external.write_text("changed source")
            self.assertNotEqual(untracked.stdout, run(TEST_UNTRACKED="extra.go").stdout)
            for changes in [dict(TEST_DIRTY=" M helper.py"), dict(TEST_REPLACE="yes"), dict(TEST_WORK="/external/workspace")]:
                self.assertNotEqual(run(**changes).returncode, 0)


if __name__ == "__main__":
    unittest.main()
