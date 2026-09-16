"""Schema-driven settings registry.

Walks the Pydantic ``Config`` tree in ``claudesk.core.config`` to produce a
flat ``{schema, values, groups}`` payload the Settings pane can render
generically. Powers ``GET /api/settings`` and ``PATCH /api/settings``.

Every field surfaced here carries ``json_schema_extra`` metadata defined in
``claudesk/core/config.py``: ``label``, ``group``, ``widget``, ``restart``,
``order``, plus optional ``help`` / ``min`` / ``max`` / ``options``. Fields marked
``excluded=True`` (api keys) are not surfaced.
"""
from __future__ import annotations

import inspect
import threading
from typing import Any, Iterator, get_origin

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from claudesk.core.config import (
    CHAT_RUNTIME_CATALOG,
    ChatRuntimeSettings,
    Config,
    chat_runtime_catalog,
    load_config,
    load_config_file,
    save_config_file,
)


GROUPS_ORDER: list[dict[str, str]] = [
    {"id": "profile", "label": "Profile"},
    {"id": "keywords", "label": "Topics & keywords"},
    {"id": "sources", "label": "Sources"},
    {"id": "digest", "label": "Digest"},
    {"id": "llm", "label": "LLM"},
    {"id": "chat", "label": "Chat agent"},
    {"id": "paper_assets", "label": "Paper assets"},
    {"id": "ui", "label": "Appearance"},
    {"id": "obsidian", "label": "Obsidian"},
]

_PATCH_LOCK = threading.Lock()


def _is_pydantic_model(annotation: Any) -> bool:
    if get_origin(annotation) is not None:
        return False
    return inspect.isclass(annotation) and issubclass(annotation, BaseModel)


def _field_meta(field: FieldInfo) -> dict[str, Any]:
    extra = field.json_schema_extra
    if extra is None or callable(extra):
        return {}
    return dict(extra)


def _walk_fields(model_cls: type[BaseModel], prefix: str = "") -> Iterator[tuple[str, FieldInfo]]:
    for name, field in model_cls.model_fields.items():
        full_key = f"{prefix}.{name}" if prefix else name
        if _is_pydantic_model(field.annotation):
            yield from _walk_fields(field.annotation, full_key)
        else:
            yield full_key, field


def _get_value_at(data: dict, dotted_key: str) -> Any:
    parts = dotted_key.split(".")
    current: Any = data
    for part in parts:
        current = current[part]
    return current


def _set_value_at(data: dict, dotted_key: str, value: Any) -> None:
    parts = dotted_key.split(".")
    current: Any = data
    for part in parts[:-1]:
        current = current[part]
    current[parts[-1]] = value


def _registry_index() -> tuple[set[str], set[str]]:
    """Return (writable_keys, restart_no_keys) computed from Config metadata."""
    writable: set[str] = set()
    restart_no: set[str] = set()
    for key, field in _walk_fields(Config):
        meta = _field_meta(field)
        if meta.get("excluded"):
            continue
        writable.add(key)
        if not meta.get("restart", True):
            restart_no.add(key)
    return writable, restart_no


def build_settings_payload() -> dict[str, Any]:
    """Build ``{schema, values, groups}`` from the on-disk config.

    Uses ``load_config_file`` (no env overrides) so secret env values never
    leak into the payload.
    """
    cfg = load_config_file()
    data = cfg.model_dump(mode="python")
    runtime_catalog = chat_runtime_catalog()
    runtime_fields = {field["key"]: field for field in runtime_catalog[cfg.chat.backend]["fields"]}
    schema_items: list[dict[str, Any]] = []
    values: dict[str, Any] = {}
    for key, field in _walk_fields(Config):
        meta = _field_meta(field)
        if meta.get("excluded"):
            continue
        runtime_key = key.removeprefix("chat.") if key.startswith("chat.") else None
        if runtime_key in ChatRuntimeSettings.model_fields and runtime_key != "backend":
            if runtime_key not in runtime_fields:
                continue
            meta = runtime_fields[runtime_key]
        item: dict[str, Any] = {
            "key": key,
            "label": meta.get("label", key),
            "group": meta.get("group", "other"),
            "widget": meta.get("widget", "str"),
            "restart": bool(meta.get("restart", True)),
            "order": int(meta.get("order", 0)),
        }
        for opt in ("help", "min", "max", "options"):
            if opt in meta:
                item[opt] = meta[opt]
        schema_items.append(item)
        values[key] = _get_value_at(data, key)
    schema_items.sort(key=lambda i: (i["group"], i["order"], i["key"]))
    return {
        "schema": schema_items,
        "values": values,
        "groups": GROUPS_ORDER,
        "chat_runtime_catalog": runtime_catalog,
    }


def _build_patched_config(patches: list[dict[str, Any]]) -> tuple[Config, set[str], set[str]]:
    """Return a validated patched config plus patched/restart-live keys."""
    writable_keys, restart_no_keys = _registry_index()
    cfg = load_config_file()
    data = cfg.model_dump(mode="python")
    backend = next((patch.get("value") for patch in reversed(patches) if patch.get("key") == "chat.backend"), cfg.chat.backend)
    if isinstance(backend, str) and backend != cfg.chat.backend and backend in CHAT_RUNTIME_CATALOG:
        data["chat"] = {key: value for key, value in data["chat"].items() if key not in ChatRuntimeSettings.model_fields}
        data["chat"].update(CHAT_RUNTIME_CATALOG[backend]["defaults"])
    patched_keys: set[str] = set()
    for patch in patches:
        key = patch.get("key")
        if not isinstance(key, str) or key not in writable_keys:
            raise ValueError(f"Unknown or excluded settings key: {key!r}")
        value = patch.get("value")
        if key == "chat.reasoning_summary" and value == "":
            value = None
        _set_value_at(data, key, value)
        patched_keys.add(key)
    return Config.model_validate(data), patched_keys, restart_no_keys


def build_config_preview(patches: list[dict[str, Any]]) -> Config:
    """Return a validated Config with patches applied, without persisting it."""
    new_cfg, _patched_keys, _restart_no_keys = _build_patched_config(patches)
    return new_cfg


def apply_patches(patches: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate, apply, persist a list of dotted-key patches.

    Each patch is ``{"key": "<dotted.path>", "value": <any>}``. Unknown or
    ``excluded=True`` keys are rejected with ``ValueError``. The merged
    dict is round-tripped through ``Config.model_validate`` for type
    enforcement (raises ``pydantic.ValidationError`` on bad input).

    On success: writes through ``save_config_file`` and clears the
    ``load_config`` lru_cache iff any patched key has ``restart=False``,
    so the running server picks up the change without a restart.
    """
    with _PATCH_LOCK:
        new_cfg, patched_keys, restart_no_keys = _build_patched_config(patches)
        save_config_file(new_cfg)
        if patched_keys & restart_no_keys:
            load_config.cache_clear()
        return build_settings_payload()
