"""Primary/backup model configuration: validation, migration and safe views.

The configuration is stored server-side in the private SQLite database and is
never part of the client protocol.  Secrets are only ever held in this module's
internal representation; every outward view is built by ``public_config`` which
never includes a key or an environment variable name.
"""
import ipaddress
from urllib.parse import urlsplit

from . import modelsecrets

DEFAULT_API_KEY_ENV = "CLAW_NEXT_MODEL_API_KEY"
DEFAULT_TIMEOUT_SECONDS = 20
MAX_TIMEOUT_SECONDS = 60
MAX_BASE_URL = 2048
MAX_MODEL_NAME = 128
MAX_API_KEY = 4096
SLOTS = ("primary", "backup")


class ModelConfigError(Exception):
    """A rejected configuration value; ``code`` is a safe API error code."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def empty_slot():
    return {"base_url": "", "model": "", "timeout_seconds": DEFAULT_TIMEOUT_SECONDS, "api_key": ""}


def is_local_host(host):
    """True for literal loopback/private IPs and ``localhost``."""
    if not isinstance(host, str) or not host:
        return False
    host = host.rstrip(".").lower()
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        address = mapped
    return address.is_loopback or address.is_private or address.is_link_local


def valid_base_url(base):
    """Empty (disabled) or an https URL; plain HTTP only for local hosts."""
    if not isinstance(base, str) or len(base) > MAX_BASE_URL:
        return False
    if not base:
        return True
    if base != base.strip() or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in base):
        return False
    try:
        parsed = urlsplit(base)
        host = parsed.hostname
        if parsed.port == 0:
            return False
    except ValueError:
        return False
    if not host or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    if parsed.scheme == "https":
        return True
    if parsed.scheme == "http":
        return is_local_host(host)
    return False


def _clean_text(value, maximum, code, strip=False):
    if not isinstance(value, str) or len(value) > maximum:
        raise ModelConfigError(code)
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ModelConfigError(code)
    if strip and value != value.strip():
        raise ModelConfigError(code)
    return value


def _clean_key(value):
    if not isinstance(value, str) or len(value) > MAX_API_KEY:
        raise ModelConfigError("invalid_api_key")
    try:
        if len(value.encode("utf-8")) > MAX_API_KEY:
            raise ModelConfigError("invalid_api_key")
    except UnicodeEncodeError:
        raise ModelConfigError("invalid_api_key") from None
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ModelConfigError("invalid_api_key")
    if value != value.strip():
        raise ModelConfigError("invalid_api_key")
    return value


def parse_slot(raw, current):
    """Validate one submitted slot; a blank/absent key preserves the saved one."""
    if not isinstance(raw, dict) or not set(raw) <= {"base_url", "model", "timeout_seconds", "api_key", "clear_key"}:
        raise ModelConfigError("invalid_model_config")
    base = raw.get("base_url", current.get("base_url", ""))
    model = raw.get("model", current.get("model", ""))
    if not valid_base_url(base):
        raise ModelConfigError("invalid_model_url")
    model = _clean_text(model, MAX_MODEL_NAME, "invalid_model_name", strip=True)
    if bool(base) != bool(model):
        raise ModelConfigError("invalid_model_config")
    timeout = raw.get("timeout_seconds", current.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
    if type(timeout) is not int or not 1 <= timeout <= MAX_TIMEOUT_SECONDS:
        raise ModelConfigError("invalid_model_timeout")
    clear = raw.get("clear_key", False)
    if type(clear) is not bool:
        raise ModelConfigError("invalid_model_config")
    supplied = raw.get("api_key", None)
    if supplied is not None:
        supplied = _clean_key(supplied)
    if clear and supplied:
        raise ModelConfigError("invalid_model_config")
    if clear:
        key = ""
    elif supplied:
        key = supplied
    else:
        key = current.get("api_key", "")
    use_env = current.get("use_environment_key", True)
    if clear or supplied or base != current.get("base_url", ""):
        use_env = False
    result = {"base_url": base, "model": model, "timeout_seconds": timeout, "api_key": key,
              "use_environment_key": use_env}
    if not clear and not supplied and "api_key_ref" in current:
        result["api_key_ref"] = current["api_key_ref"]
    return result


def _stored_slot(raw):
    """Defensively normalise a persisted slot; corrupt data is treated as unset."""
    slot = empty_slot()
    if not isinstance(raw, dict):
        return slot
    slot["use_environment_key"] = raw.get("use_environment_key", True) is True
    base, model = raw.get("base_url"), raw.get("model")
    if isinstance(base, str) and isinstance(model, str) and valid_base_url(base) and bool(base) == bool(model):
        if not any(ord(c) < 32 or ord(c) == 127 for c in model) and len(model) <= MAX_MODEL_NAME and model == model.strip():
            slot["base_url"], slot["model"] = base, model
    timeout = raw.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    if type(timeout) is int and 1 <= timeout <= MAX_TIMEOUT_SECONDS:
        slot["timeout_seconds"] = timeout
    key = raw.get("api_key", "")
    if isinstance(key, str) and key and len(key) <= MAX_API_KEY and not any(ord(c) < 32 or ord(c) == 127 for c in key):
        slot["api_key"] = key
    # Legacy Windows DPAPI records are recognized, never decrypted on a Mac.
    if "api_key_ref" in raw or "api_key_dpapi" in raw:
        slot["api_key_ref"] = raw.get("api_key_ref", raw.get("api_key_dpapi"))
        if "api_key_ref" in raw and "api_key_dpapi" in raw:
            slot["api_key_ref"] = "invalid:ambiguous"
        slot["api_key"] = ""
        slot["use_environment_key"] = False
    return slot


def stored_config(payload, fallback):
    """Build the internal configuration from persisted data plus the file config.

    Old flat records (``base_url``/``model``) migrate to the primary slot, and
    the file/environment configuration provides the primary slot and the
    environment key name when nothing has been saved yet.
    """
    fallback = fallback if isinstance(fallback, dict) else {}
    version = 0
    payload = payload if isinstance(payload, dict) else {}
    if type(payload.get("version")) is int and payload["version"] >= 0:
        version = payload["version"]
    if "primary" in payload or "backup" in payload:
        primary, backup = _stored_slot(payload.get("primary")), _stored_slot(payload.get("backup"))
    elif payload:
        # Legacy flat saved record: migrate to the primary slot on read.
        primary, backup = _stored_slot(payload), empty_slot()
    elif "primary" in fallback or "backup" in fallback:
        primary, backup = _stored_slot(fallback.get("primary")), _stored_slot(fallback.get("backup"))
    else:
        primary, backup = _stored_slot(fallback), empty_slot()
    env = fallback.get("api_key_env")
    if not isinstance(env, str) or not env:
        env = DEFAULT_API_KEY_ENV
    return {"version": version, "primary": primary, "backup": backup, "api_key_env": env}


def parse_update(payload, current):
    """Validate a submitted configuration; legacy flat submissions map to primary."""
    if not isinstance(payload, dict):
        raise ModelConfigError("invalid_model_config")
    version = payload.get("version")
    if type(version) is not int or version < 0:
        raise ModelConfigError("invalid_model_config")
    if "primary" in payload or "backup" in payload:
        if not set(payload) <= {"version", "primary", "backup"} or "primary" not in payload or "backup" not in payload:
            raise ModelConfigError("invalid_model_config")
        primary = parse_slot(payload["primary"], current.get("primary") or empty_slot())
        backup = parse_slot(payload["backup"], current.get("backup") or empty_slot())
    else:
        if not set(payload) <= {"version", "base_url", "model"}:
            raise ModelConfigError("invalid_model_config")
        if "base_url" not in payload or "model" not in payload:
            raise ModelConfigError("invalid_model_config")
        legacy = {"base_url": payload["base_url"], "model": payload["model"]}
        primary = parse_slot(legacy, current.get("primary") or empty_slot())
        backup = dict(current.get("backup") or empty_slot())
    return {"primary": primary, "backup": backup}


def slot_configured(slot):
    return bool(isinstance(slot, dict) and slot.get("base_url") and slot.get("model"))


def key_for(config, slot, environment):
    """Saved slot key, or the legacy environment key for the primary slot only."""
    value = config.get(slot) or {}
    if "api_key_ref" in value:
        # Never fall back to an environment key or an unauthenticated request.
        return modelsecrets.read(value["api_key_ref"])
    saved = (config.get(slot) or {}).get("api_key") if isinstance(config, dict) else ""
    if isinstance(saved, str) and saved:
        return saved
    if slot == "primary" and (config.get(slot) or {}).get("use_environment_key", True):
        name = config.get("api_key_env") or DEFAULT_API_KEY_ENV
        if isinstance(name, str):
            value = environment.get(name, "") if hasattr(environment, "get") else ""
            return value if isinstance(value, str) else ""
    return ""


def public_config(config, environment):
    """API view: never includes keys, environment names or other secrets."""

    def view(name):
        slot = config.get(name) or empty_slot()
        return {"base_url": slot.get("base_url", ""), "model": slot.get("model", ""),
                "timeout_seconds": slot.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS),
                "key_configured": "api_key_ref" in slot or bool(key_for(config, name, environment))}

    return {"version": config.get("version", 0), "primary": view("primary"), "backup": view("backup")}
