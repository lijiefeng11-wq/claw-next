"""Run shared-template management UI with fictional data and network responses."""
import pathlib
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the UI fixture")
class ReplyTemplatesUiTests(unittest.TestCase):
    def test_template_editor_and_stale_responses(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        result = subprocess.run([shutil.which("node"), str(root / "tests/reply_templates_ui.cjs")],
                                cwd=root, capture_output=True, encoding="utf-8", timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
