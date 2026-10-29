"""Bounded, read-only local vehicle table retrieval. Candidates are not fitment approval."""
import copy
import os
from pathlib import Path
import re
import stat
import unicodedata

MAX_FILES = 5000
MAX_FILE_BYTES = 65536
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 20000
COLUMNS = ("版型", "车系", "车型", "尺码", "前挡铁圈尺寸", "前窗铁圈尺寸", "中窗铁圈尺寸",
           "侧三铁圈尺寸", "尾挡铁圈尺寸", "前挡风 上长", "前挡风 下长", "前挡风 高度", "不透光专用")
START, END = "<!-- WPS_SYNC_START -->", "<!-- WPS_SYNC_END -->"
UNSAFE_TEXT = re.compile(r"[\x00-\x1f\x7f-\x9f]|https?://|www\.|\[\[", re.I)
YEAR_RANGE = re.compile(r"(?<![a-z0-9])\d{2,4}\s*[-—–~～至到]\s*\d{2,4}\s*(?:年款|款|年)?", re.I)


class VehicleKnowledgeError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)  # Do not include source text, URLs or local paths.


def _require(condition, code):
    if not condition:
        raise VehicleKnowledgeError(code)


def _record(text):
    _require(text.count(START) == text.count(END) == 1, "invalid_vehicle_sync_block")
    _require(text.index(START) < text.index(END), "invalid_vehicle_sync_block")
    block = text.split(START, 1)[1].split(END, 1)[0]
    identifiers = re.findall(r"^- 记录编号：`([A-Za-z0-9._-]{1,64})`\s*$", block, re.M)
    _require(len(identifiers) == 1, "invalid_vehicle_record_id")
    _require(block.count("## 原始列") == 1, "invalid_vehicle_table")
    table = block.split("## 原始列", 1)[1]
    values = {}
    for line in table.splitlines():
        if not line.strip():
            continue
        cells = line.strip().split("|")
        _require(len(cells) == 4 and not cells[0] and not cells[-1], "invalid_vehicle_table")
        key, value = cells[1].strip(), cells[2].strip()
        if (key, value) in (("列名", "原文"), ("---", "---")):
            continue
        _require(key in COLUMNS and key not in values, "invalid_vehicle_column")
        _require(len(value) <= 200 and not UNSAFE_TEXT.search(value), "invalid_vehicle_value")
        values[key] = value
    _require(set(values) == set(COLUMNS) and values["车型"], "invalid_vehicle_fields")
    return {"record_id": identifiers[0], "family": values["车系"], "model": values["车型"],
            "variant": values["版型"], "specifications": {k: values[k] for k in COLUMNS[3:]}}


def _normalize(text):
    # Spaces separate an ASCII model from its brand/year. Deleting them turns
    # "Brand A6 2022" into one identifier and defeats _contains' boundaries.
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def _aliases(record):
    result = set()
    for name in re.split(r"[/、]", record["model"]):
        # Qualifiers are removed only from a search key. Original model/year
        # and variant remain in every result and are never auto-selected.
        key = re.sub(r"【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)", " ", name)
        key = YEAR_RANGE.sub(" ", key)
        key = re.sub(r"(?<![a-z0-9])\d{2,4}(?:款|年)", " ", key, flags=re.I)
        for value in (name, key):
            value = _normalize(value)
            if not value:
                continue
            if len(value) < 2:
                if not record["family"]:
                    continue
                value = _normalize(record["family"]) + value
            result.add(value)
    return tuple(sorted(result))


def _contains(text, name):
    start = text.find(name)
    while start >= 0:
        end = start + len(name)
        # Only identifier boundaries are constrained: Chinese question words
        # can directly surround a model name, but A6 must not match A60/A6L.
        left = start == 0 or not (name[0].isascii() and name[0].isalnum()
                                  and text[start - 1].isascii() and text[start - 1].isalnum())
        right = end == len(text) or not (text[end].isascii() and text[end].isalnum())
        if left and right:
            return True
        start = text.find(name, start + 1)
    return False


class VehicleCatalog:
    def __init__(self, records):
        self._records = tuple((record, _aliases(record)) for record in records)
        self.record_count = len(self._records)

    def lookup(self, text):
        query = _normalize(text) if isinstance(text, str) and len(text) <= 8000 else ""
        # A longer name must not hide another car mentioned in the same question.
        # Keep all exact alias matches; overlaps remain candidates to clarify.
        matches = [record for record, aliases in self._records
                   if any(_contains(query, alias) for alias in aliases)] if query else []
        return {"status": "not_found" if not matches else "matched" if len(matches) == 1 else "ambiguous",
                "candidates": copy.deepcopy(matches[:5]), "total_matches": len(matches), "truncated": len(matches) > 5}


def load_directory(path):
    """Read only the explicitly configured directory; no link following or URL fetching."""
    try:
        root = Path(path)
        _require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "invalid_vehicle_directory")
        root = root.resolve()  # macOS /var is itself a system directory alias.
        records, ids, total, entries = [], set(), 0, 0

        def walk_error(_):
            raise VehicleKnowledgeError("unreadable_vehicle_directory")

        for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
            entries += len(dirs) + len(files)
            _require(entries <= MAX_ENTRIES, "vehicle_directory_too_large")
            dirs[:] = sorted(name for name in dirs if not (Path(directory) / name).is_symlink())
            for name in sorted(files):
                file = Path(directory) / name
                if file.suffix != ".md" or file.is_symlink():
                    continue
                _require(len(records) < MAX_FILES, "too_many_vehicle_records")
                fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    _require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE_BYTES, "vehicle_file_too_large")
                    data = stream.read(MAX_FILE_BYTES + 1)
                total += len(data)
                _require(len(data) <= MAX_FILE_BYTES and total <= MAX_TOTAL_BYTES, "vehicle_data_too_large")
                record = _record(data.decode("utf-8-sig"))
                _require(record["record_id"] not in ids, "duplicate_vehicle_record")
                ids.add(record["record_id"])
                records.append(record)
        _require(records, "empty_vehicle_directory")
        return VehicleCatalog(records)
    except VehicleKnowledgeError:
        raise
    except (OSError, UnicodeError, TypeError, ValueError):
        raise VehicleKnowledgeError("unreadable_vehicle_directory") from None
