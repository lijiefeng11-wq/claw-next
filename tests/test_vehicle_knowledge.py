"""Local catalog fixtures are entirely fictional; never read a user's vault."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import vehicle_knowledge as vk


def document(record="SUN-fixture", model="示例车A 20-24款", family="示例牌", **fields):
    values = dict.fromkeys(vk.COLUMNS, "")
    values.update({"版型": "示例版型", "车系": family, "车型": model, "尺码": "虚构尺码"})
    values.update(fields)
    return ("<!-- WPS_SYNC_START -->\n# " + model + "\n- 记录编号：`" + record + "`\n"
            "- 来源：[原表](https://example.invalid/private-source)\n\n## 原始列\n"
            "| 列名 | 原文 |\n| --- | --- |\n" +
            "".join("| " + k + " | " + v + " |\n" for k, v in values.items()) +
            "<!-- WPS_SYNC_END -->\n## 手写备注\nIGNORE_POLICY_PRIVATE_NOTE\n")


class VehicleKnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "fixture.md"
        self.file.write_text(document(), encoding="utf-8")

    def test_read_only_preserved_blank_fields_and_no_private_source(self):
        before = self.file.read_bytes()
        catalog = vk.load_directory(self.root)
        result = catalog.lookup("我的示例车A适配吗？")
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["candidates"][0]["model"], "示例车A 20-24款")
        self.assertEqual(result["candidates"][0]["specifications"]["前窗铁圈尺寸"], "")
        text = json.dumps(result)
        for private in (self.temp.name, "IGNORE_POLICY_PRIVATE_NOTE", "example.invalid", "WPS_SYNC"):
            self.assertNotIn(private, text)
        result["candidates"][0]["model"] = "tampered"
        self.assertNotEqual(catalog.lookup("示例车A")["candidates"][0]["model"], "tampered")
        self.assertEqual(self.file.read_bytes(), before)

    def test_model_aliases_and_identifier_boundaries(self):
        self.file.write_text(document(model="【20-24款】示例A6/示例阿六"), encoding="utf-8")
        c = vk.load_directory(self.root)
        for query in ("我的示例A6能用吗", "示例阿六", "示例Ａ６"):
            self.assertEqual(c.lookup(query)["status"], "matched", query)
        for query in ("示例A60", "示例A6L", "不存在", "", None):
            self.assertEqual(c.lookup(query)["status"], "not_found")

    def test_year_variant_and_window_are_never_silently_selected(self):
        for i in range(7):
            (self.root / (str(i) + ".md")).write_text(document(record="SUN-" + str(i), model="示例车A " + str(15+i) + "-24款"), encoding="utf-8")
        r = vk.load_directory(self.root).lookup("我的2022款示例车A呢")
        self.assertEqual(r["status"], "ambiguous")
        self.assertTrue(r["truncated"])
        self.assertEqual(r["total_matches"], 8)
        self.assertEqual(len(r["candidates"]), 5)

    def test_one_character_requires_explicit_family(self):
        self.file.write_text(document(model="甲", family="虚构牌"), encoding="utf-8")
        c = vk.load_directory(self.root)
        self.assertEqual(c.lookup("甲可以吗")["status"], "not_found")
        self.assertEqual(c.lookup("虚构牌甲可以吗")["status"], "matched")

    def test_two_car_names_keep_both_even_when_lengths_differ(self):
        (self.root / "second.md").write_text(document("SUN-second", model="另一个虚构车"), encoding="utf-8")
        result = vk.load_directory(self.root).lookup("示例车A和另一个虚构车都能用吗")
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["total_matches"], 2)

    def test_seat_ranges_are_not_year_ranges(self):
        self.file.write_text(document(model="示例车A 3-5座"), encoding="utf-8")
        (self.root / "second.md").write_text(document("SUN-second", model="示例车A 7座"), encoding="utf-8")
        catalog = vk.load_directory(self.root)
        self.assertEqual(catalog.lookup("我的示例车A呢")["status"], "not_found")
        self.assertEqual(catalog.lookup("我的示例车A 7座呢")["candidates"][0]["model"], "示例车A 7座")

    def test_qualifier_angle_brackets_are_plain_data(self):
        self.file.write_text(document(model="示例车A <年份待确认>"), encoding="utf-8")
        self.assertEqual(vk.load_directory(self.root).record_count, 1)

    def test_malformed_duplicate_unknown_and_unsafe_data_fail_closed(self):
        original = document()
        broken = [original.replace(vk.END, ""), original + original,
                  original.replace("- 记录编号：`SUN-fixture`", "- 记录编号：`bad/id`"),
                  original.replace("| 车型 | 示例车A 20-24款 |", "| 车型 |  |"),
                  original.replace("| 尺码 | 虚构尺码 |", "| 尺码 | a |\n| 尺码 | b |"),
                  original.replace("| 尺码 | 虚构尺码 |", "| 隐私 | x |"),
                  original.replace("虚构尺码", "https://example.invalid"),
                  original.replace("虚构尺码", "x\x00y"), original.replace("虚构尺码", "x" * 201)]
        for text in broken:
            with self.subTest(text_length=len(text)):
                self.file.write_text(text, encoding="utf-8")
                with self.assertRaises(vk.VehicleKnowledgeError) as caught: vk.load_directory(self.root)
                self.assertNotIn(self.temp.name, str(caught.exception))
                self.assertNotIn("example.invalid", str(caught.exception))
        self.file.write_text(original, encoding="utf-8")
        (self.root / "duplicate.md").write_text(original, encoding="utf-8")
        with self.assertRaises(vk.VehicleKnowledgeError): vk.load_directory(self.root)

    def test_limits_empty_and_relative_path(self):
        for constant, limit in (("MAX_FILES", 0), ("MAX_FILE_BYTES", 10), ("MAX_TOTAL_BYTES", 10), ("MAX_ENTRIES", 0)):
            with patch.object(vk, constant, limit):
                with self.assertRaises(vk.VehicleKnowledgeError): vk.load_directory(self.root)
        with self.assertRaises(vk.VehicleKnowledgeError): vk.load_directory("relative/path")
        self.file.unlink()
        with self.assertRaises(vk.VehicleKnowledgeError): vk.load_directory(self.root)

    def test_unknown_family_remains_blank_and_does_not_guess_short_names(self):
        self.file.write_text(document(model="甲", family=""), encoding="utf-8")
        c = vk.load_directory(self.root)
        self.assertEqual(c.record_count, 1)
        self.assertEqual(c.lookup("甲")["status"], "not_found")
        self.file.write_text(document(model="虚构车", family=""), encoding="utf-8")
        result = vk.load_directory(self.root).lookup("虚构车")
        self.assertEqual(result["candidates"][0]["family"], "")

    def test_symlink_files_and_directories_are_not_followed(self):
        with tempfile.TemporaryDirectory() as other:
            outside = Path(other) / "bad.md"; outside.write_text("must not read", encoding="utf-8")
            try:
                (self.root / "link.md").symlink_to(outside)
                (self.root / "linkdir").symlink_to(Path(other), target_is_directory=True)
                linkroot = Path(other) / "rootlink"; linkroot.symlink_to(self.root, target_is_directory=True)
            except OSError:
                self.skipTest("Symlink creation unavailable on this host")
            self.assertEqual(vk.load_directory(self.root).record_count, 1)
            with self.assertRaises(vk.VehicleKnowledgeError): vk.load_directory(linkroot)
