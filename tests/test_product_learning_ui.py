"""Actual product-learning UI with fictional responses, including late responses."""
import pathlib
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which('node'), 'Node.js is required for the UI fixture')
class ProductLearningUiTests(unittest.TestCase):
    def test_shop_switch_logout_and_uncertain_requests(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        result = subprocess.run([shutil.which('node'), str(root / 'tests/product_learning_ui.cjs')],
                                cwd=root, capture_output=True, encoding='utf-8', timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
