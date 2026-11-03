"""Analyze every server-held unique QA in bounded batches, then rank source-backed drafts."""
from . import chatrules, modelconfig
from .engine import ProviderFailure

BACKUP_NOTE = "主模型未完成的批次已尝试已配置的备用模型；请核对预览。"
VARIANT_NOTE = "同一主题存在不同回答，已保留全部来源；当前回复仅为草稿，请核对条件和事实。"
NOTES_LIMIT = "警告较多，仅保留前面的核对提示；请同时核对全部来源问答。"


def merge_notes(previous, incoming):
    notes = list(dict.fromkeys(previous + incoming))
    return notes if len(notes) <= 20 else notes[:19] + [NOTES_LIMIT]


def batches(pairs):
    result, batch, chars = [], [], 0
    # Frequency first is deterministic; no item is sampled out or truncated.
    for pair in sorted(pairs, key=lambda p: (-p["count"], int(p["id"][1:]))):
        size = len(pair["question"]) + len(pair["answer"])
        if batch and (len(batch) >= chatrules.MAX_PAIRS or chars + size > chatrules.MAX_PAIRS_CHARS):
            result.append(batch)
            batch, chars = [], 0
        batch.append(pair)
        chars += size
    if batch:
        result.append(batch)
    return result


def analyze(pairs, existing_rules, config, progress=None, cancelled=None):
    plan = batches(pairs)
    if not plan:
        raise ValueError("invalid_pairs")
    sources = {p["id"]: set(p["conversations"]) for p in pairs}
    topics, warnings, failed, processed, used_backup, last_error = {}, [], 0, 0, False, None

    def stop():
        if cancelled and cancelled():
            raise chatrules.ImportCancelled()

    def report(number):
        stop()
        if progress:
            progress({"phase": "analyzing", "processed_pairs": processed, "total_pairs": len(pairs),
                      "processed_batches": number, "total_batches": len(plan), "failed_batches": failed})

    report(0)
    for number, batch in enumerate(plan, 1):
        clean = [{k: p[k] for k in ("id", "question", "answer", "conversation")} for p in batch]
        result = None
        for slot in ("primary", "backup"):
            if slot == "backup" and not modelconfig.slot_configured(config.get("backup") or {}):
                break
            stop()  # Also before a fallback: revocation never starts another call.
            try:
                result = chatrules.generate(clean, existing_rules, config, slot=slot,
                                            conversations={p["id"]: sources[p["id"]] for p in batch})
                used_backup |= slot == "backup"
                break  # Valid empty/partially filtered output is a valid result.
            except ProviderFailure as exc:
                last_error = exc
        stop()
        processed += len(batch)
        if result is None:
            failed += 1
        else:
            warnings = merge_notes(warnings, result["warnings"])
            for candidate in result["candidates"]:
                key = candidate["contains"].strip().casefold()
                source_ids = set(candidate["evidence_ids"])
                source_count = len(set().union(*(sources[i] for i in source_ids)))
                if key not in topics:
                    topics[key] = {**candidate, "evidence_ids": source_ids,
                                   "conflicts": set(candidate["conflicts"]), "warnings": list(candidate["warnings"]),
                                   "best_count": source_count}
                    continue
                topic = topics[key]
                if topic["reply"] != candidate["reply"] and VARIANT_NOTE not in topic["warnings"]:
                    topic["warnings"].append(VARIANT_NOTE)
                if source_count > topic["best_count"]:
                    topic.update(reply=candidate["reply"], description=candidate["description"], best_count=source_count)
                topic["evidence_ids"].update(source_ids)
                topic["conflicts"].update(candidate["conflicts"])
                topic["warnings"] = merge_notes(topic["warnings"], candidate["warnings"])
        report(number)
    if failed == len(plan):
        raise last_error or ProviderFailure("unavailable")
    result = []
    for topic in topics.values():
        topic["count"] = len(set().union(*(sources[i] for i in topic["evidence_ids"])))
        topic["evidence_ids"] = sorted(topic["evidence_ids"], key=lambda value: int(value[1:]))
        topic["conflicts"] = sorted(topic["conflicts"])
        topic.pop("best_count")
        if topic["count"] >= 2:
            result.append(topic)
    if failed:
        warnings.insert(0, "有 " + str(failed) + "/" + str(len(plan)) + " 批未完成分析；以下仅为已完成批次的部分结果，不能视为全文件的完整高频排名。")
    if used_backup:
        warnings.append(BACKUP_NOTE)
    warnings.append("已按原文件中不同来源会话数排序，最多展示 30 个问题。模型归类仍可能遗漏或错分，请核对来源和业务事实。")
    return {"candidates": sorted(result, key=lambda value: -value["count"])[:30], "warnings": warnings}
