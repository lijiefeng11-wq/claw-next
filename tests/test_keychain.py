"""Tests for the Keychain adapter.

The default suite runs entirely against an in-memory fake of the native
Security/CoreFoundation layer: no Keychain item is created, read or deleted.
The optional native round trip only runs on darwin when
CLAW_NEXT_TEST_KEYCHAIN=1, uses one throwaway fictional item, and cleans up in
``finally``. It never prints the secret.
"""
import ctypes
import os
import sys
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import keychain  # noqa: E402

ACCOUNT_END = len("keychain:v1:")
BASE = 0x10000  # address of the first fake handle


class FakeNative:
    """In-memory stand-in for the SecItem* calls and their CF objects.

    Handles are genuine ``ctypes.c_void_p`` values so the module's own pointer
    marshalling is exercised; payloads live in ``self.objects``.
    """

    def __init__(self):
        self.items = {}
        self.forced = {}
        self.calls = []
        self.objects = {}
        self.created = 0
        self.released = 0
        self.last_data = b""
        self.constants = {}

    def payload(self, handle):
        return self.objects[handle.value if isinstance(handle, ctypes.c_void_p) else handle]

    def _new(self, kind, payload):
        self.created += 1
        handle = BASE + self.created * 16
        self.objects[handle] = (kind, payload)
        return handle

    def constant(self, name):
        if name not in self.constants:
            handle = BASE + 0x100000 + len(self.constants) * 16
            self.constants[name] = handle
            self.objects[handle] = ("str", name.encode())
        return self.constants[name]

    # CF constructors.
    def cf_string(self, _allocator, buffer, length, _encoding, _external):
        return self._new("str", bytes(buffer.raw[:length]))

    def cf_data(self, _allocator, buffer, length):
        return self._new("data", bytes(buffer.raw[:length]) if length else b"")

    def cf_dictionary(self, _allocator, keys, values, count, _kcb, _vcb):
        pairs = [(ctypes.cast(keys[index], ctypes.c_void_p).value,
                  ctypes.cast(values[index], ctypes.c_void_p).value)
                 for index in range(count)]
        return self._new("dict", pairs)

    def cf_release(self, _ref):
        self.released += 1

    def cf_get_type_id(self, _ref):
        return 7

    def cf_data_type_id(self):
        return 7

    def cf_data_length(self, _data):
        return len(self.last_data)

    def cf_data_ptr(self, _data):
        return self.last_data

    def _account(self, handle):
        entries = self.payload(handle)[1]
        for key, value in entries:
            if self.payload(ctypes.c_void_p(key))[1] == b"kSecAttrAccount":
                return self.payload(ctypes.c_void_p(value))[1].decode("utf-8")
        raise AssertionError("no account in query")

    def _value(self, handle, wanted):
        for key, value in self.payload(handle)[1]:
            if self.payload(ctypes.c_void_p(key))[1] == wanted.encode():
                return value
        raise AssertionError("missing attribute")

    # Native API.
    def sec_item_add(self, attributes, _result):
        self.calls.append(("add", attributes))
        status = self.forced.get("add", 0)
        if status:
            return status
        account = self._account(attributes)
        self.items[account] = self.payload(
            ctypes.c_void_p(self._value(attributes, "kSecValueData")))[1]
        return 0

    def sec_item_copy_matching(self, query, result):
        self.calls.append(("copy", query))
        status = self.forced.get("copy", 0)
        if status:
            return status
        account = self._account(query)
        if account not in self.items:
            return keychain._ERR_SEC_ITEM_NOT_FOUND
        self.last_data = self.items[account]
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0] = self._new("data", self.last_data)
        return 0

    def sec_item_delete(self, query):
        self.calls.append(("delete", query))
        status = self.forced.get("delete", 0)
        if status:
            return status
        account = self._account(query)
        if account not in self.items:
            return keychain._ERR_SEC_ITEM_NOT_FOUND
        del self.items[account]
        return 0


def install_fake(fake):
    """Point keychain module globals at ``fake``; return a restore callable."""
    names = ("_CF", "_SEC", "_k", "_kcf", "_CFRelease", "_CFGetTypeID", "_CFDataGetTypeID",
             "_SecItemAdd", "_SecItemCopyMatching", "_SecItemDelete",
             "_CFStringCreateWithBytes", "_CFDataCreate", "_CFDictionaryCreate",
             "_CFDataGetLength", "_CFDataGetBytePtr")
    replacements = {"_CF": fake, "_SEC": fake, "_k": fake.constant, "_kcf": fake.constant,
                    "_CFRelease": fake.cf_release, "_CFGetTypeID": fake.cf_get_type_id,
                    "_CFDataGetTypeID": fake.cf_data_type_id,
                    "_CFStringCreateWithBytes": fake.cf_string, "_CFDataCreate": fake.cf_data,
                    "_CFDictionaryCreate": fake.cf_dictionary,
                    "_CFDataGetLength": fake.cf_data_length, "_CFDataGetBytePtr": fake.cf_data_ptr,
                    "_SecItemAdd": fake.sec_item_add, "_SecItemCopyMatching": fake.sec_item_copy_matching,
                    "_SecItemDelete": fake.sec_item_delete}
    patchers = [patch.object(keychain, name, replacements[name], create=True) for name in names]
    for patcher in patchers:
        patcher.start()

    def restore():
        for patcher in reversed(patchers):
            patcher.stop()

    return restore


class FakeBackendTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeNative()
        self.addCleanup(install_fake(self.fake))

    def test_create_returns_typed_unique_reference(self):
        first = keychain.create("sk-fictional-0001")
        second = keychain.create("sk-fictional-0001")
        self.assertRegex(first, r"\Akeychain:v1:[0-9a-f]{32}\Z")
        self.assertNotEqual(first, second)
        self.assertEqual(sorted(self.fake.items.values()), [b"sk-fictional-0001"] * 2)
        self.assertIn(first[ACCOUNT_END:], self.fake.items)

    def test_create_scopes_item_without_prompt(self):
        keychain.create("v")
        attributes = self.fake.calls[0][1]
        self.assertEqual(self.fake.payload(ctypes.c_void_p(
            self.fake._value(attributes, "kSecAttrService"))), ("str", keychain.SERVICE.encode()))
        self.assertEqual(self.fake.payload(ctypes.c_void_p(
            self.fake._value(attributes, "kSecUseAuthenticationUI"))),
            ("str", b"kSecUseAuthenticationUIFail"))
        self.assertEqual(self.fake.created, self.fake.released)

    def test_read_returns_stored_value(self):
        reference = keychain.create("sk-fictional-Ω")
        self.assertEqual(keychain.read(reference), "sk-fictional-Ω")
        self.assertEqual(self.fake.created, self.fake.released)

    def test_read_uses_no_prompt_query(self):
        reference = keychain.create("v")
        keychain.read(reference)
        query = self.fake.calls[-1][1]
        self.assertEqual(self.fake.payload(self.fake._value(query, "kSecUseAuthenticationUI")),
                         ("str", b"kSecUseAuthenticationUIFail"))
        names = [self.fake.payload(ctypes.c_void_p(key))[1]
                 for key, _ in self.fake.payload(query)[1]]
        self.assertIn(b"kSecUseAuthenticationUI", names)
        self.assertIn(b"kSecMatchLimit", names)
        self.assertIn(b"kSecReturnData", names)

    def test_delete_is_idempotent(self):
        reference = keychain.create("v")
        self.assertIsNone(keychain.delete(reference))
        self.assertIsNone(keychain.delete(reference))
        self.assertEqual(self.fake.items, {})
        self.assertEqual(self.fake.created, self.fake.released)

    def test_invalid_reference_rejected_before_native_access(self):
        for bad in ("", "keychain:v1:", "keychain:v1:XYZ", "keychain:v2:" + "a" * 32,
                    "keychain:v1:" + "A" * 32, "keychain:v1:" + "a" * 31,
                    "keychain:v1:" + "a" * 33, "keychain:v1:" + "a" * 32 + "\n",
                    "keychain:v1:" + "a" * 30 + "-f", None, 7, b"keychain:v1:" + b"a" * 32):
            with self.subTest(reference=repr(bad)):
                for operation in (keychain.read, keychain.delete):
                    with self.assertRaises(keychain.SecretError) as caught:
                        operation(bad)
                    self.assertEqual(caught.exception.code, keychain.CODE_DECRYPT_FAILED)
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.fake.created, 0)

    def test_create_rejects_empty_non_utf8_and_oversized(self):
        for bad in ("", "x" * (keychain.MAX_SECRET_BYTES + 1), "\ud800", 123):
            with self.subTest(value=type(bad).__name__):
                with self.assertRaises(keychain.SecretError) as caught:
                    keychain.create(bad)
                self.assertEqual(caught.exception.code, keychain.CODE_ENCRYPT_FAILED)
        self.assertEqual(self.fake.calls, [])
        keychain.create("y" * keychain.MAX_SECRET_BYTES)
        self.assertEqual(len(self.fake.items), 1)

    def test_native_failures_map_to_generic_codes(self):
        reference = keychain.create("v")
        self.fake.forced["add"] = -50  # unexpected native parameter failure
        with self.assertRaises(keychain.SecretError) as caught:
            keychain.create("sk-fictional-0002")
        self.assertEqual(caught.exception.code, keychain.CODE_ENCRYPT_FAILED)
        self.fake.forced["copy"] = -50
        with self.assertRaises(keychain.SecretError) as caught:
            keychain.read(reference)
        self.assertEqual(caught.exception.code, keychain.CODE_DECRYPT_FAILED)
        self.fake.forced["delete"] = -50
        with self.assertRaises(keychain.SecretError) as caught:
            keychain.delete(reference)
        self.assertEqual(caught.exception.code, keychain.CODE_DELETE_FAILED)

    def test_native_call_exception_fails_closed(self):
        def explode(*_args):
            raise RuntimeError("native text sk-fictional-not-a-code")

        keychain._SecItemAdd = explode
        with self.assertRaises(keychain.SecretError) as caught:
            keychain.create("v")
        self.assertEqual(str(caught.exception), keychain.CODE_ENCRYPT_FAILED)
        self.assertEqual(self.fake.created, self.fake.released)

    def test_missing_item_read_fails_closed(self):
        with self.assertRaises(keychain.SecretError) as caught:
            keychain.read("keychain:v1:" + uuid.uuid4().hex)
        self.assertEqual(caught.exception.code, keychain.CODE_DECRYPT_FAILED)

    def test_undecodable_payload_fails_closed(self):
        reference = keychain.create("v")
        self.fake.items[reference[ACCOUNT_END:]] = b"\xff\xfe"
        with self.assertRaises(keychain.SecretError) as caught:
            keychain.read(reference)
        self.assertEqual(caught.exception.code, keychain.CODE_DECRYPT_FAILED)
        self.assertEqual(self.fake.created, self.fake.released)

    def test_unavailable_backend_fails_closed(self):
        keychain._CF = None
        for operation, args in (
                (keychain.create, ("v",)),
                (keychain.read, ("keychain:v1:" + "a" * 32,)),
                (keychain.delete, ("keychain:v1:" + "a" * 32,))):
            with self.assertRaises(keychain.SecretError) as caught:
                operation(*args)
            self.assertEqual(caught.exception.code, keychain.CODE_UNAVAILABLE)
        self.assertEqual(self.fake.calls, [])

    def test_non_darwin_platform_fails_closed(self):
        saved = keychain.sys.platform
        try:
            keychain.sys.platform = "linux"
            self.assertEqual(keychain._load_frameworks(), (None, None))
        finally:
            keychain.sys.platform = saved
        self.assertIs(keychain.is_available(), True)  # fake still installed

    def test_secret_error_exposes_only_safe_codes(self):
        for code in keychain.SecretError.SAFE_CODES:
            self.assertEqual(str(keychain.SecretError(code)), code)
            self.assertEqual(keychain.SecretError(code).args, (code,))
        self.assertEqual(str(keychain.SecretError("sk-fictional-leak")),
                         keychain.CODE_UNAVAILABLE)

    def test_locked_keychain_and_allocation_failures_are_safe(self):
        reference = keychain.create("v")
        for operation, args, native in ((keychain.create, ("fictional",), "add"),
                                        (keychain.read, (reference,), "copy"),
                                        (keychain.delete, (reference,), "delete")):
            self.fake.forced[native] = -25308
            with self.assertRaises(keychain.SecretError) as caught:
                operation(*args)
            self.assertEqual(caught.exception.code, keychain.CODE_UNAVAILABLE)
        with patch.object(keychain, "_CFStringCreateWithBytes", side_effect=RuntimeError("private text")):
            for operation, args in ((keychain.create, ("fictional",)), (keychain.delete, (reference,))):
                with self.assertRaises(keychain.SecretError) as caught:
                    operation(*args)
                self.assertNotIn("private text", str(caught.exception))


@unittest.skipUnless(sys.platform == "darwin" and os.environ.get("CLAW_NEXT_TEST_KEYCHAIN") == "1",
                     "native Keychain test disabled (set CLAW_NEXT_TEST_KEYCHAIN=1 on darwin)")
class NativeKeychainTest(unittest.TestCase):
    """Opt-in only; not executed by the default unit test run."""

    def test_native_round_trip_fictional_key(self):
        if not keychain.is_available():
            self.skipTest("native bindings unavailable")
        secret = "fictional-" + uuid.uuid4().hex
        reference = keychain.create(secret)
        try:
            self.assertEqual(keychain.read(reference), secret)
            self.assertNotIn(secret, reference)
        finally:
            keychain.delete(reference)


if __name__ == "__main__":
    unittest.main()
