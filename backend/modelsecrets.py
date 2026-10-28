"""Platform storage for model keys; no plaintext fallback on any platform."""
import sys

from . import dpapi, keychain


class SecretError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def create(value):
    try:
        if sys.platform == "darwin":
            return keychain.create(value)
        if sys.platform == "win32":
            return dpapi.encrypt(value)
        raise SecretError("secret_storage_unavailable")
    except (keychain.SecretError, dpapi.SecretError) as exc:
        raise SecretError(exc.code) from None


def read(reference):
    if not isinstance(reference, str):
        raise SecretError("secret_decrypt_failed")
    try:
        if reference.startswith("keychain:v1:"):
            if sys.platform != "darwin":
                raise SecretError("secret_storage_unavailable")
            return keychain.read(reference)
        if reference.startswith("dpapi:v1:"):
            if sys.platform != "win32":
                raise SecretError("secret_storage_unavailable")
            return dpapi.decrypt(reference)
        raise SecretError("secret_decrypt_failed")
    except (keychain.SecretError, dpapi.SecretError) as exc:
        raise SecretError(exc.code) from None


def delete(reference):
    # DPAPI is self-contained ciphertext; foreign Keychain items are not local.
    if isinstance(reference, str) and reference.startswith("keychain:v1:") and sys.platform == "darwin":
        try:
            keychain.delete(reference)
        except keychain.SecretError as exc:
            raise SecretError(exc.code) from None
