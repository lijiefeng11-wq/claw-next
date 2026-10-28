"""Validated image bytes and card data, never remote fetches or executable actions."""
import base64
import binascii
import json
import re

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGES = 3
MAX_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024
MAX_EVENT_BYTES = 8 * 1024 * 1024


def validate_content(messages, require):
    count = total = 0
    for message in messages:
        attachments = message.get("attachments", [])
        require(isinstance(attachments, list), "invalid_attachments")
        require(len(attachments) <= MAX_IMAGES, "images_too_large", 413)
        require("attachments" not in message or message is messages[-1] and message["role"] == "buyer", "historical_image_data")
        for attachment in attachments:
            require(isinstance(attachment, dict) and set(attachment) == {"type", "mime", "data_url"}
                    and attachment.get("type") == "image", "invalid_attachment")
            url = attachment.get("data_url")
            require(isinstance(url, str) and len(url) <= 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 64, "image_too_large", 413)
            require(attachment.get("mime") in ("image/png", "image/jpeg", "image/webp"), "invalid_image_type")
            prefix, separator, encoded = url.partition(",")
            require(prefix == "data:" + attachment["mime"] + ";base64", "invalid_image_type")
            require(separator and prefix in ("data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"), "invalid_image_type")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                require(False, "invalid_image_data")
            require(0 < len(raw) <= MAX_IMAGE_BYTES, "image_too_large", 413)
            valid = (prefix == "data:image/png;base64" and raw.startswith(b"\x89PNG\r\n\x1a\n")) or (
                prefix == "data:image/jpeg;base64" and raw.startswith(b"\xff\xd8\xff")) or (
                prefix == "data:image/webp;base64" and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP")
            require(valid, "invalid_image_data")
            count += 1
            total += len(raw)
            require(count <= MAX_IMAGES and total <= MAX_TOTAL_IMAGE_BYTES, "images_too_large", 413)
        if "card" in message:
            card = message["card"]
            require(message["kind"] == "card" and isinstance(card, dict)
                    and set(card) <= {"type", "title", "description", "fields"}, "invalid_card")
            require(card.get("type") in ("goods", "order", "source", "system"), "invalid_card_type")
            for key, maximum in (("type", 64), ("title", 500), ("description", 4000)):
                require(key not in card or isinstance(card[key], str) and len(card[key]) <= maximum, "invalid_card")
            fields = card.get("fields", [])
            require(isinstance(fields, list) and len(fields) <= 10, "invalid_card_fields")
            require(all(isinstance(field, dict) and set(field) == {"label", "value"}
                        and isinstance(field["label"], str) and 0 < len(field["label"]) <= 20
                        and isinstance(field["value"], str) and len(field["value"]) <= 200
                        for field in fields), "invalid_card_fields")
            texts = [card.get("title", ""), card.get("description", "")]
            texts.extend(value for field in fields for value in field.values())
            require(not any(re.search(r"https?://|www\.", value, re.IGNORECASE) for value in texts), "card_url_forbidden")


def model_content(context):
    """Keep roles/order/metadata; pair image parts with their original message IDs.

    Frontend send candidates are never forwarded verbatim: the engine may add
    sanitized public candidates for this event only.
    """
    messages = []
    images = []
    for message in context.get("messages", []):
        clean = {k: v for k, v in message.items() if k != "attachments"}
        attachments = message.get("attachments", [])
        if message["kind"] == "image" and not attachments:
            clean["image_available"] = False
        if attachments:
            clean["image_count"] = len(attachments)
        messages.append(clean)
        for attachment in attachments:
            images.extend([{"type": "text", "text": "Image for message " + message["id"] + " (" + message["role"] + ")"},
                           {"type": "image_url", "image_url": {"url": attachment["data_url"]}}])
    view = {k: v for k, v in context.items() if k != "send_options"}
    text = json.dumps({**view, "messages": messages}, ensure_ascii=False)
    return [{"type": "text", "text": text}, *images] if images else text
