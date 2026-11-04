import sys
import unittest

sys.path.insert(0, "backend")

import productknowledge as pk  # noqa: E402

K1 = "a" * 64
K2 = "b" * 64
K3 = "c" * 64


def prod(key=K1, title="蓝牙耳机", facts=None, complete=True):
    return {
        "product_key": key,
        "title": title,
        "facts": facts if facts is not None else ["原装正品", "不支持无线充电"],
        "details_complete": complete,
    }


def goods(*keys):
    return [{"product_key": k, "title": "t"} for k in keys]


class ValidateProductsTest(unittest.TestCase):
    def test_valid_returns_copy(self):
        raw = [prod()]
        out = pk.validate_products(raw)
        self.assertEqual(out, raw)
        self.assertIsNot(out, raw)
        self.assertIsNot(out[0]["facts"], raw[0]["facts"])

    def test_rejects_duplicates_extra_keys_and_type_tricks(self):
        bad = [
            [prod(), prod()],
            [{**prod(), "extra": 1}],
            [prod(key="A" * 64)],
            [{**prod(), "details_complete": "true"}],
            [{**prod(), "details_complete": 1}],
            [{**prod(), "facts": [""]}],
            [{**prod(), "facts": ["x" * 1001]}],
            [{**prod(), "title": "  "}],
            [{**prod(), "title": "x" * 201}],
            [{**prod(), "facts": ["bad\x00text"]}],
            [prod() for _ in range(31)],
            "not-a-list",
        ]
        for raw in bad:
            with self.assertRaises(ValueError) as ctx:
                pk.validate_products(raw)
            self.assertEqual(str(ctx.exception), "invalid_products")

    def test_rejects_too_many_facts_without_truncating(self):
        with self.assertRaises(ValueError):
            pk.validate_products([prod(facts=["f"] * 81)])


class ChooseKnowledgeTest(unittest.TestCase):
    def test_exact_key_match_and_negation_kept(self):
        recs = [prod(facts=["不支持无线充电"])]
        out = pk.choose_knowledge(goods(K1), recs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["goods_ref"], K1)
        self.assertEqual(out[0]["facts"], ["不支持无线充电"])
        self.assertTrue(out[0]["details_complete"])
        for field in ("goods_ref", "title", "category", "facts", "details_complete"):
            self.assertIn(field, out[0])

    def test_equal_titles_unequal_keys_do_not_match(self):
        recs = [prod(key=K2, title="蓝牙耳机")]
        self.assertEqual(pk.choose_knowledge(goods(K1), recs), [])

    def test_missing_keys_ambiguous_and_catalog_prefilter(self):
        self.assertEqual(pk.choose_knowledge(goods(K3), [prod(key=K1)]), [])
        self.assertEqual(
            pk.choose_knowledge(goods(K1), [prod(key=K1), prod(key=K1)]), []
        )
        # Unmatched catalog entries never leak; unmatched shop docs ignored.
        out = pk.choose_knowledge(goods(K1), [prod(key=K1), prod(key=K2)])
        self.assertEqual([r["goods_ref"] for r in out], [K1])

    def test_selected_indices_and_max_ten(self):
        doc = {**prod(), "category": "数码电器", "selected_indices": [1]}
        out = pk.choose_knowledge(goods(K1), [doc])
        self.assertEqual(out[0]["facts"], ["不支持无线充电", "原装正品"])
        self.assertEqual(out[0]["category"], "数码电器")
        keys = ["%064x" % i for i in range(15)]
        recs = [prod(key=k) for k in keys]
        self.assertEqual(len(pk.choose_knowledge(goods(*keys), recs)), 10)


class CategorizeOutputTest(unittest.TestCase):
    def products(self):
        return pk.validate_products(
            [prod(key=K1, facts=["不支持无线充电", "续航8小时"]), prod(key=K2)]
        )

    def test_valid_output_keeps_original_facts(self):
        raw = [
            {"product_key": K1, "category": "数码电器", "indices": [0]},
            {"product_key": K2, "category": "其他", "indices": []},
        ]
        out = pk.categorize_output(raw, self.products())
        by_key = {r["product_key"]: r for r in out}
        self.assertEqual(by_key[K1]["selected_indices"], [0])
        self.assertEqual(by_key[K1]["facts"], ["不支持无线充电", "续航8小时"])
        self.assertEqual(by_key[K2]["selected_indices"], [])

    def test_malformed_output_rejected(self):
        prods = self.products()
        bad = [
            [{"product_key": K1, "category": "数码电器", "indices": [0]}],
            [
                {"product_key": K1, "category": "数码电器", "indices": [0]},
                {"product_key": K3, "category": "其他", "indices": []},
            ],
            [
                {"product_key": K1, "category": "数码电器", "indices": [0]},
                {"product_key": K1, "category": "其他", "indices": []},
            ],
            [
                {"product_key": K1, "category": "未知类", "indices": [0]},
                {"product_key": K2, "category": "其他", "indices": []},
            ],
            [
                {"product_key": K1, "category": "数码电器", "indices": [2]},
                {"product_key": K2, "category": "其他", "indices": []},
            ],
            [
                {"product_key": K1, "category": "数码电器", "indices": [True]},
                {"product_key": K2, "category": "其他", "indices": []},
            ],
            [
                {"product_key": K1, "category": "数码电器", "indices": [0, 0]},
                {"product_key": K2, "category": "其他", "indices": []},
            ],
            [
                {"product_key": K1, "category": "数码电器", "indices": [0], "x": 1},
                {"product_key": K2, "category": "其他", "indices": []},
            ],
            "not-a-list",
        ]
        for raw in bad:
            with self.assertRaises(ValueError):
                pk.categorize_output(raw, prods)

    def test_out_of_order_keys_accepted_all_once(self):
        raw = [
            {"product_key": K2, "category": "其他", "indices": [1]},
            {"product_key": K1, "category": "数码电器", "indices": [1]},
        ]
        out = pk.categorize_output(raw, self.products())
        self.assertEqual(sorted(r["product_key"] for r in out), [K1, K2])


if __name__ == "__main__":
    unittest.main()
