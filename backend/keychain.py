"""macOS Keychain secret storage via Security.framework / CoreFoundation.

Only the generic-password item APIs (``SecItemAdd``/``SecItemCopyMatching``/
``SecItemDelete``) are used, against the current user's default file keychain.
Query authentication UI is disabled per query, so a locked or denied keychain
fails closed instead of prompting. The keychain is never locked or unlocked.

Every call fails closed (``SecretError``) on a non-darwin host, a locked or
denied keychain, an unexpected native status, or malformed data. Errors carry
only a generic safe code; secret values and native statuses never appear.
"""
import ctypes
import ctypes.util
import re
import sys
import uuid

SERVICE = "claw-next.backend.model-key.v1"
REFERENCE_PREFIX = "keychain:v1:"
MAX_SECRET_BYTES = 4096

CODE_UNAVAILABLE = "secret_storage_unavailable"
CODE_ENCRYPT_FAILED = "secret_encrypt_failed"
CODE_DECRYPT_FAILED = "secret_decrypt_failed"
CODE_DELETE_FAILED = "secret_delete_failed"

_OSSTATUS = ctypes.c_int32
_CF_UTF8 = 0x08000100
_CFIndex = ctypes.c_long
_CFTypeRef = ctypes.c_void_p
_CFStringRef = ctypes.c_void_p
_CFAllocatorRef = ctypes.c_void_p
_CFDictionaryRef = ctypes.c_void_p

_ERR_SEC_SUCCESS = 0
_ERR_SEC_ITEM_NOT_FOUND = -25300
_UNAVAILABLE_STATUSES = {-25291, -25293, -25308, -25315, -128}

_REFERENCE_RE = re.compile(r"\A" + re.escape(REFERENCE_PREFIX) + r"([0-9a-f]{32})\Z")


def _load_frameworks():
    if sys.platform != "darwin":
        return None, None
    try:
        cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation")
                         or "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        sec = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        return cf, sec
    except OSError:
        return None, None


_CF, _SEC = _load_frameworks()


def _declare(lib, name, result, *arguments):
    function = getattr(lib, name)
    function.restype = result
    function.argtypes = list(arguments)
    return function


if _CF is not None and _SEC is not None:
    _CFStringCreateWithBytes = _declare(_CF, "CFStringCreateWithBytes", _CFStringRef,
                                        _CFAllocatorRef, ctypes.c_void_p, _CFIndex,
                                        ctypes.c_uint32, ctypes.c_ubyte)
    _CFDataCreate = _declare(_CF, "CFDataCreate", _CFTypeRef, _CFAllocatorRef,
                             ctypes.c_void_p, _CFIndex)
    _CFDataGetLength = _declare(_CF, "CFDataGetLength", _CFIndex, _CFTypeRef)
    _CFDataGetBytePtr = _declare(_CF, "CFDataGetBytePtr", ctypes.POINTER(ctypes.c_ubyte),
                                 _CFTypeRef)
    _CFDictionaryCreate = _declare(_CF, "CFDictionaryCreate", _CFDictionaryRef,
                                   _CFAllocatorRef, ctypes.POINTER(_CFTypeRef),
                                   ctypes.POINTER(_CFTypeRef), _CFIndex,
                                   ctypes.c_void_p, ctypes.c_void_p)
    _CFGetTypeID = _declare(_CF, "CFGetTypeID", ctypes.c_ulong, _CFTypeRef)
    _CFDataGetTypeID = _declare(_CF, "CFDataGetTypeID", ctypes.c_ulong)
    _CFRelease = _declare(_CF, "CFRelease", None, _CFTypeRef)

    _SecItemAdd = _declare(_SEC, "SecItemAdd", _OSSTATUS, _CFDictionaryRef, ctypes.c_void_p)
    _SecItemCopyMatching = _declare(_SEC, "SecItemCopyMatching", _OSSTATUS, _CFDictionaryRef,
                                    ctypes.POINTER(_CFTypeRef))
    _SecItemDelete = _declare(_SEC, "SecItemDelete", _OSSTATUS, _CFDictionaryRef)


def is_available():
    """True when the native Security and CoreFoundation bindings are loaded."""
    return _CF is not None and _SEC is not None


def _k(name):
    """Address of a Security constant such as ``kSecClass``."""
    return ctypes.c_void_p.in_dll(_SEC, name).value


def _kcf(name):
    """Address of a CoreFoundation constant such as ``kCFBooleanFalse``."""
    return ctypes.c_void_p.in_dll(_CF, name).value


class _CFLifetime:
    """Collects CF objects created for one call; releases them in reverse order."""

    def __init__(self):
        self._owned = []

    def own(self, ref):
        if not ref:
            raise MemoryError("CF allocation failure")
        self._owned.append(ref)
        return ref

    def string(self, text):
        data = text.encode("utf-8")
        buffer = ctypes.create_string_buffer(data, len(data))
        return self.own(_CFStringCreateWithBytes(None, buffer, len(data), _CF_UTF8, 0))

    def data(self, payload):
        buffer = ctypes.create_string_buffer(payload, len(payload))
        return self.own(_CFDataCreate(None, buffer, len(payload)))

    def dictionary(self, pairs):
        size = len(pairs)
        keys = (_CFTypeRef * size)(*[key for key, _ in pairs])
        values = (_CFTypeRef * size)(*[value for _, value in pairs])
        return self.own(_CFDictionaryCreate(None, keys, values, size, None, None))

    def close(self):
        while self._owned:
            _CFRelease(self._owned.pop())


class SecretError(Exception):
    """Safe secret failure; ``code`` is one of the generic public codes."""

    SAFE_CODES = (CODE_UNAVAILABLE, CODE_ENCRYPT_FAILED, CODE_DECRYPT_FAILED,
                  CODE_DELETE_FAILED)

    def __init__(self, code):
        if code not in self.SAFE_CODES:
            code = CODE_UNAVAILABLE
        super().__init__(code)
        self.code = code

    def __str__(self):
        return self.code


def _native_call(function, *arguments):
    """Run a native call; return ``(status, failed)`` without leaking text."""
    try:
        return int(function(*arguments)), False
    except Exception:
        return -1, True


def _validate_reference(reference):
    """Structural check, run before any native access."""
    if not isinstance(reference, str):
        raise SecretError(CODE_DECRYPT_FAILED)
    match = _REFERENCE_RE.fullmatch(reference)
    if match is None:
        raise SecretError(CODE_DECRYPT_FAILED)
    return match.group(1)


def _match_pairs(cf, account):
    """Class, service, account and non-synchronizable criteria."""
    return [
        (_k("kSecClass"), _k("kSecClassGenericPassword")),
        (_k("kSecAttrService"), cf.string(SERVICE)),
        (_k("kSecAttrAccount"), cf.string(account)),
        (_k("kSecAttrSynchronizable"), _kcf("kCFBooleanFalse")),
    ]


def create(secret):
    """Store ``secret`` as a new unique item; return ``keychain:v1:<uuid hex>``."""
    if not is_available():
        raise SecretError(CODE_UNAVAILABLE)
    if not isinstance(secret, str):
        raise SecretError(CODE_ENCRYPT_FAILED)
    try:
        payload = secret.encode("utf-8", "strict")
    except UnicodeEncodeError:
        raise SecretError(CODE_ENCRYPT_FAILED) from None
    if not 0 < len(payload) <= MAX_SECRET_BYTES:
        raise SecretError(CODE_ENCRYPT_FAILED)

    account = uuid.uuid4().hex
    cf = _CFLifetime()
    try:
        attributes = cf.dictionary(_match_pairs(cf, account) + [
            (_k("kSecValueData"), cf.data(payload)),
            (_k("kSecAttrAccessible"), _k("kSecAttrAccessibleWhenUnlockedThisDeviceOnly")),
            # Never prompt: a locked or denied keychain fails the add instead.
            (_k("kSecUseAuthenticationUI"), _k("kSecUseAuthenticationUIFail")),
        ])
        status, failed = _native_call(_SecItemAdd, attributes, None)
    except Exception:
        raise SecretError(CODE_ENCRYPT_FAILED) from None
    finally:
        cf.close()
    if status in _UNAVAILABLE_STATUSES:
        raise SecretError(CODE_UNAVAILABLE)
    if failed or status != _ERR_SEC_SUCCESS:
        raise SecretError(CODE_ENCRYPT_FAILED)
    return REFERENCE_PREFIX + account


def read(reference):
    """Return the secret stored under ``reference``; fail closed if absent."""
    account = _validate_reference(reference)
    if not is_available():
        raise SecretError(CODE_UNAVAILABLE)
    cf = _CFLifetime()
    result = _CFTypeRef()
    payload = None
    try:
        query = cf.dictionary(_match_pairs(cf, account) + [
            (_k("kSecReturnData"), _kcf("kCFBooleanTrue")),
            (_k("kSecMatchLimit"), _k("kSecMatchLimitOne")),
            (_k("kSecUseAuthenticationUI"), _k("kSecUseAuthenticationUIFail")),
        ])
        status, failed = _native_call(_SecItemCopyMatching, query, ctypes.byref(result))
        if status in _UNAVAILABLE_STATUSES:
            raise SecretError(CODE_UNAVAILABLE)
        if failed or status != _ERR_SEC_SUCCESS or not result.value:
            raise SecretError(CODE_DECRYPT_FAILED)
        data = result.value
        if _CFGetTypeID(data) != _CFDataGetTypeID():
            raise SecretError(CODE_DECRYPT_FAILED)
        length = int(_CFDataGetLength(data))
        if not 0 < length <= MAX_SECRET_BYTES:
            raise SecretError(CODE_DECRYPT_FAILED)
        pointer = _CFDataGetBytePtr(data)
        if not pointer:
            raise SecretError(CODE_DECRYPT_FAILED)
        payload = bytes(pointer[:length])
    except SecretError:
        raise
    except Exception:
        raise SecretError(CODE_DECRYPT_FAILED) from None
    finally:
        if result.value:
            _CFRelease(result.value)
        cf.close()
    try:
        return payload.decode("utf-8", "strict")
    except UnicodeDecodeError:
        raise SecretError(CODE_DECRYPT_FAILED) from None


def delete(reference):
    """Delete the item for ``reference``; a missing item counts as deleted."""
    account = _validate_reference(reference)
    if not is_available():
        raise SecretError(CODE_UNAVAILABLE)
    cf = _CFLifetime()
    try:
        query = cf.dictionary(_match_pairs(cf, account) + [
            (_k("kSecUseAuthenticationUI"), _k("kSecUseAuthenticationUIFail")),
        ])
        status, failed = _native_call(_SecItemDelete, query)
    except Exception:
        raise SecretError(CODE_DELETE_FAILED) from None
    finally:
        cf.close()
    if status in _UNAVAILABLE_STATUSES:
        raise SecretError(CODE_UNAVAILABLE)
    if failed:
        raise SecretError(CODE_DELETE_FAILED)
    if status not in (_ERR_SEC_SUCCESS, _ERR_SEC_ITEM_NOT_FOUND):
        raise SecretError(CODE_DELETE_FAILED)
    return None
