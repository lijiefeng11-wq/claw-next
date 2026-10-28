"""In-memory secret-store fixture. Default tests never touch OS credentials."""
import uuid
from unittest.mock import patch

from backend import modelsecrets


def install_secret_fixture(case):
    values = {}

    def create(value):
        reference = "keychain:v1:" + uuid.uuid4().hex
        values[reference] = value
        return reference

    def read(reference):
        if reference not in values:
            raise modelsecrets.SecretError("secret_decrypt_failed")
        return values[reference]

    for name, implementation in (("create", create), ("read", read),
                                  ("delete", lambda reference: values.pop(reference, None))):
        patcher = patch.object(modelsecrets, name, side_effect=implementation)
        patcher.start()
        case.addCleanup(patcher.stop)
    return values
