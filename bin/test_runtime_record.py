import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class RuntimeRecordTests(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location('record', ROOT / 'bin/build-runtime-record.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_defaults_and_computer_overrides_keep_resource_and_display_policy(self):
        module = self.load()
        config = module.settings(ROOT / 'fleet-runtime', 'build-fractal-2', 'pyrycode/pyrycode-desktop')
        self.assertEqual(config['env']['PW_WORKERS'], '2')
        self.assertEqual(config['env']['PYRY_E2E_DISPLAY'], 'private')
        self.assertEqual(config['projectHeavyLimits']['pyrycode/pyrycode-mobile'], 1)
        self.assertEqual(config['codeBuildingAgents'], 1)
        self.assertEqual(module.settings(ROOT / 'fleet-runtime', 'macbook', 'pyrycode/pyrycode-desktop')['unattendedPolicy'], 'native-only')

    def test_provenance_hashes_change_with_exact_inventory(self):
        module = self.load()
        first = module.record('image one', 'tools one', 'gates one', 'a' * 40, 'b' * 40)
        changed = module.record('image one', 'tools two', 'gates one', 'a' * 40, 'b' * 40)
        self.assertNotEqual(first['tools'], changed['tools'])
        self.assertEqual(len(first['image']), 64)
        with self.assertRaises(ValueError):
            module.record('latest', 'tools', 'gates', 'unknown', 'b' * 40)

    def test_unknown_computer_refuses_instead_of_losing_its_override(self):
        module = self.load()
        with self.assertRaises(ValueError):
            module.settings(ROOT / 'fleet-runtime', 'unknown', 'pyrycode/pyrycode-desktop')
