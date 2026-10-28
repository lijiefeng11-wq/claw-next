import io
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import launchd

REPO = Path(__file__).resolve().parent.parent
SECRET = "sk-test-SECRET-token-value-DO-NOT-PRINT-1234567890"


class LaunchdTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="launchd test 空 格 ")
        self.root = Path(self.tmp.name)
        self.data = self.root / "data dir"
        self.data.mkdir()
        self.config = self.root / "con fig.json"
        self.config.write_text(json.dumps({
            "shops": [], "clients": [],
            "model": {"api_key_env": "CLAW_NEXT_MODEL_API_KEY"},
            "launchd": {"environment_names": ["CLAW_NEXT_MODEL_API_KEY"], "secret": SECRET},
        }), encoding="utf-8")
        self.python = Path(sys.executable)
        self.output = self.root / "out dir" / "com.claw-next.backend.plist"

    def tearDown(self):
        self.tmp.cleanup()

    def generate(self, **overrides):
        args = dict(config=self.config, data_dir=self.data, python=self.python, output=self.output)
        args.update(overrides)
        return launchd.generate(**args)

    def test_plist_is_xml_and_parses_with_expected_keys(self):
        plist = self.generate()
        parsed = plistlib.loads(self.output.read_bytes())
        self.assertEqual(parsed, plist)
        self.assertEqual(parsed["Label"], "com.claw-next.backend")
        self.assertEqual(parsed["ProgramArguments"], [
            str(self.python), "-m", "backend.service", "--config", str(self.config),
            "--data-dir", str(self.data), "--host", "127.0.0.1", "--port", "18881"])
        self.assertEqual(parsed["WorkingDirectory"], str(REPO))
        self.assertIs(parsed["RunAtLoad"], True)
        self.assertEqual(parsed["KeepAlive"], {"SuccessfulExit": False})
        self.assertEqual(parsed["ThrottleInterval"], 30)
        self.assertEqual(parsed["Umask"], 0o077)
        self.assertEqual(Path(parsed["StandardOutPath"]).parent, self.data / "logs")
        self.assertEqual(Path(parsed["StandardErrorPath"]).parent, self.data / "logs")
        if os.name != "nt":
            self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.data / "logs").is_dir())

    def test_spaces_and_unicode_paths_round_trip(self):
        self.generate()
        parsed = plistlib.loads(self.output.read_bytes())
        self.assertIn("空 格", parsed["StandardOutPath"])
        self.assertIn("data dir", parsed["ProgramArguments"][6])
        self.assertIn("con fig.json", parsed["ProgramArguments"][4])

    def test_no_secret_values_or_environment_values_in_plist(self):
        with mock.patch.dict(os.environ, {"CLAW_NEXT_MODEL_API_KEY": SECRET}, clear=False):
            self.generate()
        text = self.output.read_text(encoding="utf-8")
        self.assertNotIn(SECRET, text)
        self.assertNotIn("SECRET", text)
        parsed = plistlib.loads(text.encode())
        self.assertNotIn("EnvironmentVariables", parsed)
        self.assertNotIn("EnvironmentVariableNames", parsed)

    def test_custom_port_and_label(self):
        plist = self.generate(port=19500, label="com.example.backend-test")
        self.assertIn("19500", plist["ProgramArguments"])
        self.assertEqual(plist["Label"], "com.example.backend-test")

    def test_rejects_non_absolute_paths(self):
        for field in ("config", "data_dir", "python", "output"):
            with self.subTest(field=field):
                with self.assertRaises(launchd.LaunchdError) as ctx:
                    self.generate(**{field: "relative/path"})
                self.assertEqual(str(ctx.exception), f"{field}_must_be_absolute")
        self.assertFalse(self.output.exists())

    def test_rejects_missing_files(self):
        with self.assertRaises(launchd.LaunchdError) as ctx:
            self.generate(config=self.root / "missing.json")
        self.assertEqual(str(ctx.exception), "config_not_found")
        with self.assertRaises(launchd.LaunchdError) as ctx:
            self.generate(python=self.root / "missing python")
        self.assertEqual(str(ctx.exception), "python_not_executable")

    def test_rejects_invalid_labels_and_ports(self):
        for label in ("", "bad label", "a/b", "../x", ".", "com..x", "x" * 300):
            with self.subTest(label=label):
                with self.assertRaises(launchd.LaunchdError) as ctx:
                    self.generate(label=label)
                self.assertEqual(str(ctx.exception), "invalid_label")
        for port in (0, -1, 65536, "abc", None, True, 1.5):
            with self.subTest(port=port):
                with self.assertRaises(launchd.LaunchdError) as ctx:
                    self.generate(port=port)
                self.assertEqual(str(ctx.exception), "invalid_port")
        self.assertFalse(self.output.exists())

    def test_never_overwrites_existing_output(self):
        self.output.parent.mkdir(parents=True)
        self.output.write_text("keep me", encoding="utf-8")
        with self.assertRaises(launchd.LaunchdError) as ctx:
            self.generate()
        self.assertEqual(str(ctx.exception), "output_exists")
        self.assertEqual(self.output.read_text(encoding="utf-8"), "keep me")
        self.assertEqual(sorted(p.name for p in self.output.parent.iterdir()), [self.output.name])

    def test_output_cannot_be_config_data_dir_or_interpreter(self):
        for output in (self.config, self.data, self.python):
            with self.subTest(output=output):
                with self.assertRaises(launchd.LaunchdError) as ctx:
                    self.generate(output=output)
                self.assertEqual(str(ctx.exception), "invalid_output")

    def test_cli_success_and_safe_error(self):
        command = [sys.executable, "-m", "backend.launchd", "--config", str(self.config),
                   "--data-dir", str(self.data), "--python", str(self.python), "--output", str(self.output)]
        result = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertTrue(self.output.is_file())
        again = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=60)
        self.assertEqual(again.returncode, 2)
        self.assertIn("output_exists", again.stderr)
        self.assertNotIn("Traceback", again.stderr)
        bad = subprocess.run(command[:-2] + ["--port", "70000", "--output", str(self.root / "other.plist")],
                             cwd=REPO, capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 2)
        self.assertIn("invalid_port", bad.stderr)
        self.assertNotIn("Traceback", bad.stderr)
        self.assertFalse((self.root / "other.plist").exists())

    def test_cli_handles_unicode_paths_with_legacy_console_encoding(self):
        stream = io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict")
        with mock.patch("sys.stdout", stream):
            self.assertEqual(launchd.main(["--config", str(self.config), "--data-dir", str(self.data),
                                          "--python", str(self.python), "--output", str(self.output)]), 0)
        self.assertTrue(self.output.exists())
        stream.close()

    def test_generator_never_touches_launchd_or_spawns_service(self):
        with mock.patch("subprocess.Popen", side_effect=AssertionError("spawn")), \
             mock.patch("subprocess.run", side_effect=AssertionError("spawn")), \
             mock.patch("os.system", side_effect=AssertionError("spawn")), \
             mock.patch("os.execv", side_effect=AssertionError("spawn")), \
             mock.patch("os.fork", side_effect=AssertionError("spawn"), create=True):
            self.generate()
            self.assertEqual(launchd.main(["--config", str(self.config), "--data-dir", str(self.data),
                                           "--python", str(self.python), "--output", str(self.root / "b.plist")]), 0)


if __name__ == "__main__":
    unittest.main()
