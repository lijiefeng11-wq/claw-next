"""DPAPI compatibility checks; no real credentials are used."""
import base64
import sys
import unittest

from backend import dpapi


class DpapiTests(unittest.TestCase):
    def test_invalid_keys_are_rejected_with_safe_codes(self):
        for value in (None, "", "x" * 4097, "\ud800"):
            with self.subTest(type=type(value).__name__), self.assertRaises(dpapi.SecretError):
                dpapi.encrypt(value)

    @unittest.skipIf(sys.platform == "win32", "non-Windows guard")
    def test_foreign_ciphertext_never_attempts_decryption(self):
        for operation, value in ((dpapi.encrypt, "fictional"), (dpapi.decrypt, "dpapi:v1:fictional")):
            with self.assertRaises(dpapi.SecretError) as caught:
                operation(value)
            self.assertEqual(caught.exception.code, "secret_storage_unavailable")

    @unittest.skipUnless(sys.platform == "win32", "requires native Windows DPAPI")
    def test_current_user_round_trip_and_tampering(self):
        secret = "fictional-key-for-native-dpapi-test"
        sealed = dpapi.encrypt(secret)
        self.assertNotIn(secret, sealed)
        self.assertEqual(dpapi.decrypt(sealed), secret)
        # Change the trailing authentication data, not an ignored provider header.
        corrupted = bytearray(base64.b64decode(sealed[len(dpapi.PREFIX):]))
        corrupted[-1] ^= 1
        tampered = dpapi.PREFIX + base64.b64encode(corrupted).decode("ascii")
        with self.assertRaises(dpapi.SecretError):
            dpapi.decrypt(tampered)
