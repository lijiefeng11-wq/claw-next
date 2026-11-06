"""Only fictional car rows and visible buyer messages; no real catalog or chats."""
import unittest
from unittest.mock import patch
from backend import vehicle_knowledge as vk


def record(name, model, family="虚构牌"):
    return {"record_id": name, "family": family, "model": model, "variant": "虚构版型",
            "specifications": {k: "" for k in vk.COLUMNS[3:]}}


def buyer(text):
    return {"role": "buyer", "kind": "text", "content": text}


class VehicleContextTests(unittest.TestCase):
    def setUp(self):
        self.catalog = vk.VehicleCatalog([record("a", "示例甲车 20-24款"), record("b", "示例乙车 21-25款"),
            record("vv", "VV7", "WEY"), record("9", "示例雅阁九代 14-16款"), record("a6", "A6"),
            record("gl8", "GL8ES / 艾维亚")])

    def test_visible_model_survives_greeting_year_and_window_fragments(self):
        for text in ("您好", "你好，在吗", "2018款", "我的是2018年款", "7座的", "前窗的呢", "后窗", "前挡风尺寸", "后挡", "可以吗"):
            with self.subTest(text=text):
                result = self.catalog.lookup_context([buyer("示例甲车"), buyer(text)])
                self.assertEqual(result["status"], "matched")
                self.assertEqual(result["candidates"][0]["record_id"], "a")

    def test_latest_explicit_model_and_unknown_new_model_do_not_use_old_car(self):
        result = self.catalog.lookup_context([buyer("示例甲车"), buyer("换成示例乙车"), buyer("您好")])
        self.assertEqual(result["candidates"][0]["record_id"], "b")
        for text in ("我的车换成未知丙车了", "另一辆还不知道车型", "X99能用吗", "不是这个车型"):
            with self.subTest(text=text):
                self.assertEqual(self.catalog.lookup_context([buyer("示例甲车"), buyer(text)])["status"], "not_found")

    def test_multiple_models_remain_candidates_and_never_get_auto_selected(self):
        result = self.catalog.lookup_context([buyer("示例甲车和示例乙车都能用吗"), buyer("2018款")])
        self.assertEqual((result["status"], result["total_matches"]), ("ambiguous", 2))
        self.assertEqual(self.catalog.lookup_context([buyer("不是示例甲车")])["status"], "ambiguous")

    def test_buyer_only_current_context_and_six_message_bound(self):
        agent = {"role": "agent", "kind": "text", "content": "示例乙车"}
        self.assertEqual(self.catalog.lookup_context([agent, buyer("您好")])["status"], "not_found")
        result = self.catalog.lookup_context([buyer("示例甲车"), agent, buyer("您好")])
        self.assertEqual(result["candidates"][0]["record_id"], "a")
        self.assertEqual(self.catalog.lookup_context([buyer("示例甲车")] + [buyer("您好")] * 6)["status"], "not_found")

    def test_latest_readable_card_takes_precedence_and_unknown_card_stops_old_car(self):
        card = {"role": "buyer", "kind": "card", "content": "商品卡片：示例乙车专用遮阳帘"}
        for messages in ([card], [buyer("示例甲车"), card], [buyer("示例甲车"), card, buyer("您好")]):
            self.assertEqual(self.catalog.lookup_context(messages)["candidates"][0]["record_id"], "b")
        for title in ("未知丙车专用遮阳帘", "通用商品卡片", ""):
            self.assertEqual(self.catalog.lookup_context([buyer("示例甲车"), {**card, "content": title}])["status"], "not_found")

    def test_invalid_and_long_latest_input_does_not_resurrect_previous_model(self):
        for value in (None, {}, "wrong", [None], [{"role":"buyer", "kind":"text"}]):
            self.assertEqual(self.catalog.lookup_context(value)["status"], "not_found")
        self.assertEqual(self.catalog.lookup_context([buyer("示例甲车"), buyer("未知车" * 3000)])["status"], "not_found")

    def test_known_glued_brand_does_not_relax_model_boundaries(self):
        for text in ("WEYVV7", "wey vv7", "魏派VV7"):
            self.assertEqual(self.catalog.lookup(text)["candidates"][0]["record_id"], "vv")
        for text in ("XXXVV7", "WEYVV70", "WEYVV7ES", "XA6", "A60", "A6L", "GL8胖头鱼", "GL8"):
            self.assertEqual(self.catalog.lookup(text)["status"], "not_found", text)

    def test_explicit_generation_spelling_equivalence_keeps_original_row(self):
        for text in ("示例雅阁九代", "示例雅阁9代", "2014款9代示例雅阁"):
            result = self.catalog.lookup(text)
            self.assertEqual(result["candidates"][0]["record_id"], "9", text)
            self.assertEqual(result["candidates"][0]["model"], "示例雅阁九代 14-16款")
        self.assertEqual(self.catalog.lookup("8代示例雅阁")["status"], "not_found")

    def test_context_lookup_retains_budget_exhaustion(self):
        with patch("backend.vehicle_knowledge.time.monotonic", side_effect=[0, 0, 1]):
            self.assertEqual(self.catalog.lookup_context([buyer("示例甲车")])["status"], "unavailable")
