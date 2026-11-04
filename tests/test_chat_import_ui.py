"""Run the real draft UI module with fictional DOM, files and model results."""
import pathlib
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the UI fixture")
class ChatImportUiTests(unittest.TestCase):
    def test_import_and_draft_application_feedback(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        result = subprocess.run([shutil.which("node"), str(root / "tests/chat_import_ui.cjs")],
                                cwd=root, capture_output=True, encoding="utf-8", timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
