import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest


class ConsumerBridgeTests(unittest.TestCase):
    def test_bridge_uses_its_own_pinned_dispatcher_and_preserves_actual_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'dispatcher/scripts').mkdir(parents=True)
            bridge = root / 'bin/check-test-selection'
            shutil.copy(Path(__file__).with_name('check-test-selection'), bridge)
            marker = root / 'observed.json'
            policy = root / 'dispatcher/scripts/test-selection.py'
            policy.write_text("import json\nfrom pathlib import Path\ndef check(root,kind,args,env):\n    Path(" + repr(str(marker)) + ").write_text(json.dumps([str(root),kind,args,env]))\n    raise ValueError('frozen builder rejected full suite')\n")
            check = runpy.run_path(str(bridge))['check_selection']
            with self.assertRaisesRegex(SystemExit, 'frozen builder rejected'):
                check(root, 'go', ['test', './...'], {'CLAUDE_CODE_ENTRYPOINT': 'verifier'})
            self.assertEqual(json.loads(marker.read_text()), [str(root), 'go', ['test', './...'], {'CLAUDE_CODE_ENTRYPOINT': 'verifier'}])


if __name__ == '__main__':
    unittest.main()
