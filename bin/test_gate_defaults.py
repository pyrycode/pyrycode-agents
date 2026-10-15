"""Protected gate defaults use disposable data and never start a dispatcher."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GateDefaultsTests(unittest.TestCase):
    def load(self, gates=None, formats=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            shutil.copy2(ROOT / 'bin/gate-defaults.mjs', root / 'bin/gate-defaults.mjs')
            shutil.copy2(ROOT / 'gate-tiers.json', root / 'gate-tiers.json')
            env = {'PATH': os.environ['PATH'], 'AGENTS_REPO_PATH': str(root)}
            if gates is not None:
                env['PYRY_VERIFIER_GATES'] = gates
            if formats is not None:
                env['PYRY_VERIFIER_GATE_FORMATS'] = json.dumps(formats)
            done = subprocess.run(['node', '--import', str(root / 'bin/gate-defaults.mjs'), '--input-type=module', '-e',
                                   'console.log(JSON.stringify({gates:process.env.PYRY_VERIFIER_GATES,formats:JSON.parse(process.env.PYRY_VERIFIER_GATE_FORMATS)}))'],
                                  env=env, capture_output=True, text=True, check=True)
            return json.loads(done.stdout)

    def test_compound_check_expands_without_dropping_other_required_gates(self):
        result = self.load('custom-before;make check;custom-after;make build')
        gates = result['gates'].split(';')
        self.assertEqual(gates, ['custom-before', 'make vet', 'go test -race -json ./...', 'make staticcheck',
                                 'make substrate-guard', 'go test -tags e2e -race -count=1 -json ./internal/e2e/...',
                                 'custom-after', 'make build'])
        for command in [gates[2], gates[5]]:
            self.assertEqual(result['formats'][command]['format'], 'go-json')
            self.assertIn('{{TESTS}}', result['formats'][command]['baseline'])

    def test_existing_custom_tiers_and_formats_are_preserved(self):
        result = self.load('custom-gate;make build', {'custom-gate': 'junit-xml'})
        self.assertEqual(result['gates'], 'custom-gate;make build')
        self.assertEqual(result['formats']['custom-gate'], 'junit-xml')

    def test_defaults_keep_guards_and_build_around_every_check_tier(self):
        gates = self.load()['gates'].split(';')
        self.assertTrue(gates[0].endswith('cite-guard'))
        self.assertTrue(gates[1].endswith('docs-guard'))
        self.assertIn('make substrate-guard', gates)
        self.assertEqual(gates[-1], 'make build')
        self.assertNotIn('make check', gates)


if __name__ == '__main__':
    unittest.main()
