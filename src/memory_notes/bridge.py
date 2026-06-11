from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TEL_SUFFIX = " (Telos)"
OWNER_SUFFIX = " (owner)"

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def respond_ok(result: Any) -> None:
    sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


def respond_error(message: str, code: str = "bridge_error", details: Any | None = None) -> None:
    sys.stdout.write(
        json.dumps(
            {
                "ok": False,
                "error": {
                    "code": code,
                    "message": message,
                    "details": details,
                },
            },
            ensure_ascii=False,
        )
    )


def require_module() -> tuple[Any, Any]:
    try:
        import gkeepapi  # type: ignore
        from gkeepapi import exception as gkeep_exception  # type: ignore

        return gkeepapi, gkeep_exception
    except Exception as error:  # pragma: no cover
        raise RuntimeError(
            "Python dependency setup is incomplete. Expected gkeepapi to be installed in the tool runtime."
        ) from error


def require_gpsoauth() -> Any:
    try:
        import gpsoauth  # type: ignore

        return gpsoauth
    except Exception as error:  # pragma: no cover
        raise RuntimeError(
            "Python dependency setup is incomplete. Expected gpsoauth to be installed in the tool runtime."
        ) from error


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def strip_suffix(title: str) -> str:
    normalized = clean_text(title)
    for suffix in (TEL_SUFFIX, OWNER_SUFFIX):
        if normalized.lower().endswith(suffix.lower()):
            return normalized[: -len(suffix)].rstrip()
    return normalized


def classify_owner(title: str) -> str:
    normalized = clean_text(title)
    if normalized.lower().endswith(TEL_SUFFIX.lower()):
        return "system"
    if normalized.lower().endswith(OWNER_SUFFIX.lower()):
        return "owner"
    return "user"


def ensure_owner_title(title: str, owner: str | None) -> str:
    normalized = clean_text(title)
    if not normalized:
        raise ValueError("Note title must be a non-empty string.")

    if owner == "system":
        if normalized.lower().endswith(TEL_SUFFIX.lower()):
            return normalized
        return f"{strip_suffix(normalized)}{TEL_SUFFIX}"
    return normalized


def is_list(node: Any) -> bool:
    return hasattr(node, "items") and hasattr(node, "add")


def note_title(node: Any) -> str:
    title = clean_text(getattr(node, "title", ""))
    if title:
        return title

    if is_list(node):
        items = [clean_text(getattr(item, "text", "")) for item in getattr(node, "items", [])]
        items = [item for item in items if item]
        source = " ".join(items[:3])
    else:
        source = clean_text(getattr(node, "text", ""))

    if not source:
        return "Untitled"

    words = source.split()
    derived = " ".join(words[:8])
    if len(words) > 8:
        derived += "..."
    return derived


def preview_text(node: Any) -> str:
    if is_list(node):
        items = []
        for item in getattr(node, "items", []):
            text = clean_text(getattr(item, "text", ""))
            if not text:
                continue
            prefix = "[x]" if bool(getattr(item, "checked", False)) else "[ ]"
            items.append(f"{prefix} {text}")
        return "\n".join(items[:4])

    text = str(getattr(node, "text", "") or "").strip()
    return text[:240]


def to_iso(value: Any) -> str | None:
    if value is None:
        return None

    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    if hasattr(value, "isoformat"):
        try:
            text = value.isoformat()
            if isinstance(text, str):
                return text.replace("+00:00", "Z")
        except Exception:
            pass

    if isinstance(value, (int, float)):
        if value > 1_000_000_000_000:
            value = value / 1000
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    text = str(value).strip()
    return text or None


def timestamp_fields(node: Any) -> tuple[str | None, str | None]:
    timestamps = getattr(node, "timestamps", None)
    if timestamps is None:
        return None, None

    created = None
    updated = None
    for name in ("created", "created_at"):
        created = to_iso(getattr(timestamps, name, None))
        if created:
            break
    for name in ("updated", "edited", "updated_at", "user_edited"):
        updated = to_iso(getattr(timestamps, name, None))
        if updated:
            break
    return created, updated


def serialize_item(item: Any) -> dict[str, Any]:
    return {
        "id": getattr(item, "id", None),
        "text": getattr(item, "text", "") or "",
        "checked": bool(getattr(item, "checked", False)),
        "sort": getattr(item, "sort", None),
    }


def serialize_note(node: Any, *, full: bool = False) -> dict[str, Any]:
    created_at, updated_at = timestamp_fields(node)
    actual_title = clean_text(getattr(node, "title", ""))
    title = note_title(node)
    kind = "list" if is_list(node) else "note"

    result: dict[str, Any] = {
        "id": getattr(node, "id", None),
        "serverId": getattr(node, "server_id", None),
        "title": title,
        "logicalTitle": strip_suffix(title),
        "rawTitle": actual_title,
        "kind": kind,
        "owner": classify_owner(actual_title),
        "archived": bool(getattr(node, "archived", False)),
        "trashed": bool(getattr(node, "trashed", False)),
        "pinned": bool(getattr(node, "pinned", False)),
        "createdAt": created_at,
        "updatedAt": updated_at,
        "preview": preview_text(node),
    }

    if full:
        result["text"] = getattr(node, "text", "") or ""
        if kind == "list":
            result["items"] = [serialize_item(item) for item in getattr(node, "items", [])]

    return result


def save_state(keep: Any, state_path: str | None) -> None:
    if not state_path:
        return
    target = Path(state_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(keep.dump()), encoding="utf-8")


def load_keep(profile: dict[str, Any]) -> Any:
    gkeepapi, _ = require_module()
    keep = gkeepapi.Keep()
    state_path = profile.get("statePath")
    state = None
    if state_path and Path(state_path).exists():
        try:
            state = json.loads(Path(state_path).read_text(encoding="utf-8"))
        except Exception:
            state = None

    keep.authenticate(
        profile["email"],
        profile["masterToken"],
        state=state,
        sync=True,
        device_id=profile.get("deviceId"),
    )
    save_state(keep, state_path)
    return keep


def resolve_note(keep: Any, note_ref: str, *, allow_trashed: bool = True) -> Any:
    normalized_ref = clean_text(note_ref)
    if not normalized_ref:
        raise ValueError("Note reference is required.")

    direct = keep.get(normalized_ref)
    if direct is not None:
        if not allow_trashed and bool(getattr(direct, "trashed", False)):
            raise ValueError(f'Note "{note_ref}" is in trash.')
        return direct

    lowered = normalized_ref.lower()
    matches = []
    for node in keep.all():
        if not allow_trashed and bool(getattr(node, "trashed", False)):
            continue

        candidates = {
            str(getattr(node, "id", "")).lower(),
            str(getattr(node, "server_id", "")).lower(),
            clean_text(getattr(node, "title", "")).lower(),
            strip_suffix(getattr(node, "title", "")).lower(),
            note_title(node).lower(),
            strip_suffix(note_title(node)).lower(),
        }
        if lowered in candidates:
            matches.append(node)

    if not matches:
        raise ValueError(f'Note "{note_ref}" was not found.')
    if len(matches) > 1:
        titles = ", ".join(note_title(node) for node in matches[:4])
        raise ValueError(f'Note "{note_ref}" is ambiguous. Matches: {titles}')
    return matches[0]


def resolve_list_item(note: Any, item_ref: str) -> Any:
    normalized_ref = clean_text(item_ref)
    if not normalized_ref:
        raise ValueError("List item reference is required.")

    lowered = normalized_ref.lower()
    matches = []
    for item in getattr(note, "items", []):
        item_text = clean_text(getattr(item, "text", ""))
        if lowered in {str(getattr(item, "id", "")).lower(), item_text.lower()}:
            matches.append(item)

    if not matches:
        raise ValueError(f'List item "{item_ref}" was not found.')
    if len(matches) > 1:
        raise ValueError(f'List item "{item_ref}" is ambiguous. Use the item id instead.')
    return matches[0]


def sort_notes(notes: list[Any]) -> list[Any]:
    def sort_key(node: Any) -> tuple[Any, ...]:
        _, updated = timestamp_fields(node)
        return (updated or "", note_title(node).lower())

    return sorted(notes, key=sort_key, reverse=True)


def action_probe(profile: dict[str, Any], _input: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    notes = list(keep.all())
    save_state(keep, profile.get("statePath"))
    return {
        "email": profile["email"],
        "deviceId": profile.get("deviceId"),
        "notes": len(notes),
        "lists": sum(1 for node in notes if is_list(node)),
        "updatedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def action_password_login(_profile: dict[str, Any] | None, input_data: dict[str, Any]) -> dict[str, Any]:
    gpsoauth = require_gpsoauth()
    email = clean_text(input_data.get("email"))
    password = str(input_data.get("password") or "")
    device_id = clean_text(input_data.get("deviceId"))
    if not email or not password or not device_id:
        raise ValueError("email, password, and deviceId are required.")

    response = gpsoauth.perform_master_login(email, password, device_id)
    token = clean_text(response.get("Token"))
    if not token:
        error_code = clean_text(response.get("Error")) or "AuthenticationFailed"
        details = clean_text(response.get("ErrorDetail")) or clean_text(response.get("Message"))
        extra = f" ({details})" if details else ""
        raise ValueError(
            f"gpsoauth master login failed: {error_code}{extra}. "
            "If this is a normal Google password, try an App Password or use the EmbeddedSetup oauth_token flow."
        )

    probe = action_exchange_token(None, {
        "email": email,
        "masterToken": token,
        "deviceId": device_id,
    })
    return {
        "email": email,
        "deviceId": device_id,
        "masterToken": token,
        "notes": probe.get("notes", 0),
    }


def action_exchange_token(_profile: dict[str, Any] | None, input_data: dict[str, Any]) -> dict[str, Any]:
    gpsoauth = require_gpsoauth()
    email = clean_text(input_data.get("email"))
    device_id = clean_text(input_data.get("deviceId"))
    master_token = clean_text(input_data.get("masterToken"))
    oauth_token = clean_text(input_data.get("oauthToken"))
    if not email or not device_id:
        raise ValueError("email and deviceId are required.")

    token = master_token
    if not token:
        if not oauth_token:
            raise ValueError("oauthToken is required when masterToken is not provided.")
        response = gpsoauth.exchange_token(email, oauth_token, android_id=device_id)
        token = clean_text(response.get("Token"))
        if not token:
          error_code = clean_text(response.get("Error")) or "AuthenticationFailed"
          details = clean_text(response.get("ErrorDetail")) or clean_text(response.get("Message"))
          extra = f" ({details})" if details else ""
          raise ValueError(f"gpsoauth token exchange failed: {error_code}{extra}.")

    keep = load_keep({
        "email": email,
        "masterToken": token,
        "deviceId": device_id,
        "statePath": input_data.get("statePath"),
    })
    notes = list(keep.all())
    save_state(keep, input_data.get("statePath"))
    return {
        "email": email,
        "deviceId": device_id,
        "masterToken": token,
        "notes": len(notes),
        "lists": sum(1 for node in notes if is_list(node)),
        "updatedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def action_list_notes(profile: dict[str, Any], input_data: dict[str, Any]) -> list[dict[str, Any]]:
    keep = load_keep(profile)
    query = clean_text(input_data.get("query") or input_data.get("q"))
    kind = clean_text(input_data.get("kind"))
    archived = input_data.get("archived")
    trashed = input_data.get("trashed")
    limit = input_data.get("limit")

    filtered = []
    for node in keep.all():
        if kind == "list" and not is_list(node):
            continue
        if kind == "note" and is_list(node):
            continue
        if archived is not None and bool(getattr(node, "archived", False)) != bool(archived):
            continue
        if trashed is not None and bool(getattr(node, "trashed", False)) != bool(trashed):
            continue
        if query:
            haystack = "\n".join(
                [
                    clean_text(getattr(node, "title", "")),
                    strip_suffix(getattr(node, "title", "")),
                    note_title(node),
                    str(getattr(node, "text", "") or ""),
                ]
            ).lower()
            if query.lower() not in haystack:
                continue
        filtered.append(node)

    sorted_notes = sort_notes(filtered)
    if isinstance(limit, int) and limit > 0:
        sorted_notes = sorted_notes[:limit]

    save_state(keep, profile.get("statePath"))
    return [serialize_note(node, full=False) for node in sorted_notes]


def action_get_note(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or input_data.get("id") or input_data.get("title") or ""))
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_put_note(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    title = clean_text(input_data.get("title"))
    note_ref = clean_text(input_data.get("note") or input_data.get("id"))
    owner = clean_text(input_data.get("owner")) or "system"
    create_only = bool(input_data.get("createOnly"))
    text = str(input_data.get("text") or "")
    kind = clean_text(input_data.get("kind")) or "note"
    items = input_data.get("items")

    note = None
    if note_ref:
        try:
            note = resolve_note(keep, note_ref)
        except Exception:
            note = None
    elif title:
        try:
            note = resolve_note(keep, title)
        except Exception:
            note = None

    if note is not None and create_only:
        raise ValueError(f'Note "{title or note_ref}" already exists.')

    if note is None:
        if kind == "list":
            normalized_items = []
            for item in items or []:
                if isinstance(item, dict):
                    normalized_items.append((str(item.get("text") or ""), bool(item.get("checked", False))))
                else:
                    normalized_items.append((str(item), False))
            note = keep.createList(ensure_owner_title(title, owner), normalized_items)
        else:
            note = keep.createNote(ensure_owner_title(title, owner), text)
    else:
        if title:
            note.title = ensure_owner_title(title, owner)
        if is_list(note):
            if kind == "note":
                raise ValueError("This note is a checklist. Use createList/item methods for checklist content.")
            if items is not None:
                for item in list(getattr(note, "items", [])):
                    item.delete()
                keep.sync()
                for item in items:
                    if isinstance(item, dict):
                        note.add(str(item.get("text") or ""), bool(item.get("checked", False)))
                    else:
                        note.add(str(item), False)
        else:
            note.text = text

    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_append_note(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    if is_list(note):
        raise ValueError("append() only works on text notes. Use itemAdd() for checklists.")

    note.text = f"{note.text or ''}{str(input_data.get('text') or '')}"
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_patch_note(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    if is_list(note):
        raise ValueError("patch() only works on text notes. Use item methods for checklists.")

    search = str(input_data.get("search") or "")
    replace = str(input_data.get("replace") or "")
    if not search:
        raise ValueError("Search text must not be empty.")

    occurrences = note.text.count(search)
    if occurrences == 0:
        raise ValueError(f'Search text was not found in note "{note_title(note)}".')
    if occurrences > 1:
        raise ValueError(
            f'Search text matched {occurrences} times in note "{note_title(note)}". Make the search text more specific.'
        )

    note.text = note.text.replace(search, replace)
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_remove_note(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    note.trash()
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_set_flags(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    if "archived" in input_data:
        note.archived = bool(input_data.get("archived"))
    if "pinned" in input_data:
        note.pinned = bool(input_data.get("pinned"))
    if bool(input_data.get("restore")):
        note.untrash()
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_add_item(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    if not is_list(note):
        raise ValueError("This note is not a checklist.")

    note.add(str(input_data.get("text") or ""), bool(input_data.get("checked", False)))
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_check_item(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    if not is_list(note):
        raise ValueError("This note is not a checklist.")

    item = resolve_list_item(note, str(input_data.get("item") or ""))
    item.checked = bool(input_data.get("checked", True))
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_remove_item(profile: dict[str, Any], input_data: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    note = resolve_note(keep, str(input_data.get("note") or ""))
    if not is_list(note):
        raise ValueError("This note is not a checklist.")

    item = resolve_list_item(note, str(input_data.get("item") or ""))
    item.delete()
    keep.sync()
    save_state(keep, profile.get("statePath"))
    return serialize_note(note, full=True)


def action_sync(profile: dict[str, Any], _input: dict[str, Any]) -> dict[str, Any]:
    keep = load_keep(profile)
    notes = [node for node in keep.all()]
    save_state(keep, profile.get("statePath"))
    return {
        "notes": len(notes),
        "lists": sum(1 for node in notes if is_list(node)),
        "updatedAt": datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z"),
    }


ACTIONS = {
    "probe": action_probe,
    "password_login": action_password_login,
    "exchange_token": action_exchange_token,
    "list_notes": action_list_notes,
    "get_note": action_get_note,
    "put_note": action_put_note,
    "append_note": action_append_note,
    "patch_note": action_patch_note,
    "remove_note": action_remove_note,
    "set_flags": action_set_flags,
    "add_item": action_add_item,
    "check_item": action_check_item,
    "remove_item": action_remove_item,
    "sync": action_sync,
}


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        respond_error("Bridge request payload is empty.")
        return 1

    try:
        payload = json.loads(raw)
        action = payload.get("action")
        if action not in ACTIONS:
            raise ValueError(f'Unsupported bridge action "{action}".')

        result = ACTIONS[action](payload.get("profile"), payload.get("input") or {})
        respond_ok(result)
        return 0
    except Exception as error:  # pragma: no cover
        respond_error(str(error), details={"traceback": traceback.format_exc()})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
