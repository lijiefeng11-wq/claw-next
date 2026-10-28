"""Windows DPAPI sealing for persisted model API keys (stdlib ``ctypes`` only).

Ciphertext is bound to the current Windows user through ``CryptProtectData``
with ``CRYPTPROTECT_UI_FORBIDDEN``; machine scope is never requested and no
home-made cryptography is used.  Persisted tokens are opaque strings of the
form ``dpapi:v1:<base64>``.  Empty keys are never passed here.

On any non-Windows platform the functions fail closed with
``secret_storage_unavailable``.  Callers must not fall back to plaintext;
the legacy environment-key path is separate and unaffected.
"""
import base64
import ctypes
import sys

PREFIX = "dpapi:v1:"
CRYPTPROTECT_UI_FORBIDDEN = 0x1
# Extra application binding; DPAPI also binds the blob to the current user.
_ENTROPY = b"claw-next/model-api-key/v1"
MAX_PLAINTEXT = 4096
MAX_CIPHERTEXT = 3 * MAX_PLAINTEXT + 1024
MAX_TOKEN = 16384
_WINDOWS = sys.platform == "win32"


class SecretError(Exception):
    """A safe, code-only failure; messages never contain secret material."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def available():
    return _WINDOWS


if _WINDOWS:
    import ctypes.wintypes as _wintypes

    class _DataBlob(ctypes.Structure):
        _fields_ = [("cbData", _wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    _BINDINGS = None

    def _bindings():
        """Bind crypt32/kernel32 once, with explicit signatures."""
        global _BINDINGS
        if _BINDINGS is not None:
            return _BINDINGS
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        blob = ctypes.POINTER(_DataBlob)
        crypt32.CryptProtectData.argtypes = [
            blob, _wintypes.LPCWSTR, blob, ctypes.c_void_p, ctypes.c_void_p,
            _wintypes.DWORD, blob]
        crypt32.CryptProtectData.restype = _wintypes.BOOL
        crypt32.CryptUnprotectData.argtypes = [
            blob, ctypes.POINTER(_wintypes.LPWSTR), blob, ctypes.c_void_p,
            ctypes.c_void_p, _wintypes.DWORD, blob]
        crypt32.CryptUnprotectData.restype = _wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        _BINDINGS = crypt32, kernel32
        return _BINDINGS

    def _blob(data):
        buffer = ctypes.create_string_buffer(data, len(data))
        return buffer, _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))

    def _free(kernel32, blob):
        if blob.pbData:
            kernel32.LocalFree(ctypes.cast(blob.pbData, ctypes.c_void_p))
            blob.pbData = None
            blob.cbData = 0


def encrypt(plaintext):
    """Seal a non-empty key for the current user; returns an opaque token."""
    if not isinstance(plaintext, str) or not plaintext:
        raise SecretError("secret_encrypt_failed")
    try:
        data = plaintext.encode("utf-8")
    except UnicodeEncodeError:
        raise SecretError("secret_encrypt_failed") from None
    if len(data) > MAX_PLAINTEXT:
        raise SecretError("secret_encrypt_failed")
    if not _WINDOWS:
        raise SecretError("secret_storage_unavailable")
    crypt32, kernel32 = _bindings()
    plain_buffer, plain_blob = _blob(data)
    entropy_buffer, entropy_blob = _blob(_ENTROPY)
    sealed = _DataBlob()
    try:
        ok = crypt32.CryptProtectData(
            ctypes.byref(plain_blob), None, ctypes.byref(entropy_blob),
            None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(sealed))
        if not ok or not sealed.pbData:
            raise SecretError("secret_encrypt_failed")
        blob = ctypes.string_at(sealed.pbData, sealed.cbData)
    finally:
        _free(kernel32, sealed)
        del plain_buffer, entropy_buffer
    return PREFIX + base64.b64encode(blob).decode("ascii")


def decrypt(token):
    """Open a token sealed for this user; native rejection fails closed."""
    if not _WINDOWS:
        raise SecretError("secret_storage_unavailable")
    if not isinstance(token, str) or not token.startswith(PREFIX) or len(token) > MAX_TOKEN:
        raise SecretError("secret_decrypt_failed")
    try:
        sealed = base64.b64decode(token[len(PREFIX):], validate=True)
    except ValueError:
        raise SecretError("secret_decrypt_failed") from None
    if not sealed or len(sealed) > MAX_CIPHERTEXT:
        raise SecretError("secret_decrypt_failed")
    crypt32, kernel32 = _bindings()
    sealed_buffer, sealed_blob = _blob(sealed)
    entropy_buffer, entropy_blob = _blob(_ENTROPY)
    plain = _DataBlob()
    description = _wintypes.LPWSTR()
    try:
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(sealed_blob), ctypes.byref(description),
            ctypes.byref(entropy_blob), None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(plain))
        if not ok or not plain.pbData:
            raise SecretError("secret_decrypt_failed")
        data = ctypes.string_at(plain.pbData, plain.cbData)
    finally:
        _free(kernel32, plain)
        if description:
            kernel32.LocalFree(ctypes.cast(description, ctypes.c_void_p))
        del sealed_buffer, entropy_buffer
    if not 0 < len(data) <= MAX_PLAINTEXT:
        raise SecretError("secret_decrypt_failed")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise SecretError("secret_decrypt_failed") from None
