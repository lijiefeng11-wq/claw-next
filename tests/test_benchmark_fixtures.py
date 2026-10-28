"""Portable, offline checks for the fully synthetic benchmark corpus."""
import base64
import copy
import json
import re
import struct
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from backend.content import model_content, validate_content
from backend.engine import model_decide
from backend.store import require


FIXTURES = Path(__file__).parent / "fixtures" / "model_benchmark"


def read_json(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class BenchmarkFixtureTests(unittest.TestCase):
    def test_chat_corpus_contains_only_synthetic_phrases_and_fake_metadata(self):
        contexts = read_json("chats.json")
        listed_phrases = read_json("phrases.json")
        phrases = set(listed_phrases)
        self.assertEqual(len(listed_phrases), len(phrases))
        used_phrases = set()
        self.assertEqual(len(contexts), 24)
        self.assertEqual(sum(len(c["messages"]) for c in contexts), 209)
        for phrase in phrases:
            self.assertRegex(phrase, r"^[\u4e00-\u9fff]+$")
        for context in contexts:
            self.assertEqual(set(context), {"history_complete", "benchmark_partial_history", "messages"})
            self.assertIs(context["history_complete"], False)
            self.assertIs(context["benchmark_partial_history"], True)
            self.assertEqual(context["messages"][-1]["role"], "buyer")
            for index, message in enumerate(context["messages"], 1):
                self.assertEqual(set(message), {"id", "role", "kind", "content", "created_at"})
                self.assertEqual(message["id"], f"fixture-message-{index}")
                self.assertEqual(message["created_at"], 0)
                self.assertIn(message["role"], ("buyer", "assistant"))
                self.assertEqual(message["kind"], "text")
                for phrase in message["content"].split("，"):
                    self.assertIn(phrase, phrases)
                    used_phrases.add(phrase)
        self.assertEqual(used_phrases, phrases)
        text = json.dumps(contexts, ensure_ascii=False)
        self.assertIsNone(re.search(r"https?://|www\.|@|[0-9]{8,}", text))

    def test_generated_png_has_valid_chunks_and_no_metadata(self):
        data = (FIXTURES / "synthetic.png").read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        offset, kinds, compressed = 8, [], b""
        while offset < len(data):
            size = struct.unpack("!I", data[offset:offset + 4])[0]
            kind = data[offset + 4:offset + 8]
            payload = data[offset + 8:offset + 8 + size]
            crc = struct.unpack("!I", data[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(zlib.crc32(kind + payload) & 0xffffffff, crc)
            kinds.append(kind)
            if kind == b"IHDR":
                self.assertEqual(struct.unpack("!2I5B", payload), (512, 512, 8, 2, 0, 0, 0))
            if kind == b"IDAT":
                compressed += payload
            offset += size + 12
        self.assertEqual(kinds, [b"IHDR", b"IDAT", b"IEND"])
        self.assertEqual(offset, len(data))
        self.assertEqual(len(zlib.decompress(compressed)), 512 * (512 * 3 + 1))

    def test_card_and_image_fixtures_reach_model_content(self):
        context = copy.deepcopy(read_json("chats.json")[0])
        image_url = "data:image/png;base64," + base64.b64encode(
            (FIXTURES / "synthetic.png").read_bytes()).decode()
        context["messages"][-1].update(kind="image", attachments=[
            {"type": "image", "mime": "image/png", "data_url": image_url}])
        validate_content(context["messages"], require)
        parts = model_content(context)
        self.assertEqual(parts[-1], {"type": "image_url", "image_url": {"url": image_url}})
        self.assertNotIn("base64", parts[0]["text"])
        context["messages"][-1].pop("attachments")
        card = read_json("goods_card.json")
        context["messages"][-1].update(kind="card", card=card)
        validate_content(context["messages"], require)
        self.assertEqual(json.loads(model_content(context))["messages"][-1]["card"], card)

    def test_corpus_can_exercise_model_adapter_without_network_or_platform(self):
        response = {"choices": [{"message": {"content": json.dumps(
            {"action": "reply", "text": "虚构测试回复", "reason": "fixture"})}}]}
        config = {"primary": {"base_url": "http://127.0.0.1:1/v1", "model": "fixture",
                              "api_key": "", "timeout_seconds": 1}, "backup": {}}
        with patch("backend.engine._post", return_value=response) as post:
            for context in read_json("chats.json"):
                original = copy.deepcopy(context)
                result = model_decide(context, {"system_prompt": "仅测试，不发送"}, config)
                self.assertEqual(result["action"], "reply")
                self.assertTrue(result["reason"].startswith("model:primary:"))
                self.assertEqual(context, original)
            self.assertEqual(post.call_count, 24)


if __name__ == "__main__":
    unittest.main()
