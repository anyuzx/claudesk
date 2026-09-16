from __future__ import annotations

import json
import os
import re
import sys
import hashlib
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator

# Project root is three levels up from this file:
# claudesk/core/config.py -> claudesk/core/ -> claudesk/ -> project root
# Assumes editable install (pip install -e .), which is the only supported mode.
_PROJECT_ROOT = Path(__file__).parent.parent.parent


def _load_source_category_options() -> dict[str, list[dict[str, str]]]:
    resource = resources.files(__package__).joinpath("source_category_options.json")
    with resource.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise RuntimeError("source_category_options.json must contain an object")
    return data


_SOURCE_CATEGORY_OPTIONS = _load_source_category_options()
ARXIV_CATEGORY_OPTIONS = _SOURCE_CATEGORY_OPTIONS["arxiv"]
BIORXIV_CATEGORY_OPTIONS = _SOURCE_CATEGORY_OPTIONS["biorxiv"]


def project_root() -> Path:
    """Return the editable-install project root."""
    root = _PROJECT_ROOT.resolve()
    if not (root / "pyproject.toml").exists():
        raise RuntimeError(f"Cannot resolve claudesk project root from editable install: {root}")
    return root


class VaultConfigError(RuntimeError):
    """Raised when the machine-local Claudesk vault pointer is invalid."""


@dataclass(frozen=True)
class VaultLocation:
    path: Path
    source: Literal["env", "local_config", "default"]
    local_config_path: Path


def local_config_path() -> Path:
    """Return the unsynced machine-local Claudesk config path."""
    if override := os.environ.get("CLAUDESK_LOCAL_CONFIG"):
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claudesk" / "local.yaml"
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / "Claudesk" / "local.yaml"
    base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "claudesk" / "local.yaml"


def _read_local_vault_path(path: Path) -> Optional[Path]:
    if not path.exists():
        return None
    try:
        with open(path) as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        raise VaultConfigError(f"Invalid Claudesk local config at {path}: {exc}") from exc
    except OSError as exc:
        raise VaultConfigError(f"Cannot read Claudesk local config at {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise VaultConfigError(f"Invalid Claudesk local config at {path}: expected a YAML mapping with vault_path.")
    raw_path = data.get("vault_path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise VaultConfigError(f"Invalid Claudesk local config at {path}: vault_path must be a non-empty absolute path.")
    vault_path = Path(raw_path.strip()).expanduser()
    if not vault_path.is_absolute():
        raise VaultConfigError(f"Invalid Claudesk local config at {path}: vault_path must be absolute.")
    return vault_path.resolve()


def local_vault_path() -> Optional[Path]:
    """Return the saved machine-local vault pointer, if one exists."""
    return _read_local_vault_path(local_config_path())


@lru_cache(maxsize=1)
def vault_location() -> VaultLocation:
    """Return the effective Claudesk vault path and where it came from."""
    config_file = local_config_path()
    if env_path := os.environ.get("CLAUDESK_DATA_DIR"):
        return VaultLocation(Path(env_path).expanduser().resolve(), "env", config_file)
    local_path = _read_local_vault_path(config_file)
    if local_path is not None:
        return VaultLocation(local_path, "local_config", config_file)
    return VaultLocation((project_root() / "data").resolve(), "default", config_file)


def clear_vault_location_cache() -> None:
    """Clear the process-local effective vault cache."""
    vault_location.cache_clear()


def _write_yaml_atomically(path: Path, data: dict) -> None:
    """Publish complete YAML, preserving the prior file on pre-replace failures."""
    content = yaml.safe_dump(data, sort_keys=False, allow_unicode=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def set_local_vault_path(path: str | Path, *, clear_cache: bool = True) -> Path:
    """Persist the machine-local vault pointer and create the target directory."""
    vault_path = Path(path).expanduser().resolve()
    vault_path.mkdir(parents=True, exist_ok=True)
    config_file = local_config_path()
    _write_yaml_atomically(config_file, {"vault_path": str(vault_path)})
    if clear_cache:
        clear_vault_location_cache()
    return vault_path


class Profile(BaseModel):
    name: str = Field(
        default="Researcher",
        json_schema_extra={"label": "Name", "group": "profile", "widget": "str", "restart": False, "order": 1},
    )
    field: list[str] = Field(
        default_factory=lambda: ["Biophysics"],
        json_schema_extra={
            "label": "Research fields",
            "group": "profile",
            "widget": "tags",
            "restart": False,
            "order": 2,
            "help": "Fields or subfields used to describe your research context.",
        },
    )
    description: str = Field(
        default="",
        json_schema_extra={
            "label": "Description",
            "group": "profile",
            "widget": "text",
            "restart": False,
            "order": 3,
            "help": "Research context the assistant can use when answering.",
        },
    )

    @field_validator("field", mode="before")
    @classmethod
    def _normalize_field(cls, value: object) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            raw_values: list[object] = [value]
        elif isinstance(value, list):
            raw_values = value
        else:
            raise ValueError("Research fields must be a string or list of strings.")

        fields: list[str] = []
        seen: set[str] = set()
        for raw in raw_values:
            if not isinstance(raw, str):
                raise ValueError("Research field entries must be strings.")
            field = raw.strip()
            if not field or field in seen:
                continue
            fields.append(field)
            seen.add(field)
        return fields

    def field_text(self) -> str:
        if not self.field:
            return "research"
        if len(self.field) == 1:
            return self.field[0]
        if len(self.field) == 2:
            return f"{self.field[0]} and {self.field[1]}"
        return f"{', '.join(self.field[:-1])}, and {self.field[-1]}"

    def context_text(self) -> str:
        text = self.field_text()
        description = self.description.strip()
        return f"{text}: {description}" if description else text


class Keywords(BaseModel):
    include: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Include keywords",
            "group": "keywords",
            "widget": "tags",
            "restart": False,
            "order": 2,
            "help": "Require at least one term. Leave empty to avoid include filtering.",
        },
    )
    exclude: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Exclude keywords",
            "group": "keywords",
            "widget": "tags",
            "restart": False,
            "order": 3,
        },
    )


class SeedPaper(BaseModel):
    id: str
    source: str = "doi"
    note: str = ""


class ArxivSourceConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        json_schema_extra={"label": "Use arXiv", "group": "sources", "widget": "bool", "restart": False, "order": 1},
    )
    categories: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "arXiv categories",
            "group": "sources",
            "widget": "tags",
            "restart": False,
            "order": 2,
            "options": ARXIV_CATEGORY_OPTIONS,
            "help": "Choose arXiv category IDs. Custom values are allowed for newer or renamed categories.",
        },
    )


class BiorxivSourceConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        json_schema_extra={"label": "Use bioRxiv", "group": "sources", "widget": "bool", "restart": False, "order": 3},
    )
    categories: list[str] = Field(
        default_factory=lambda: ["Biophysics"],
        json_schema_extra={
            "label": "bioRxiv categories",
            "group": "sources",
            "widget": "tags",
            "restart": False,
            "order": 4,
            "options": BIORXIV_CATEGORY_OPTIONS,
            "help": "Choose bioRxiv subject areas. Leave empty to fetch all categories.",
        },
    )
    provider: Literal["api", "crossref"] = Field(
        default="api",
        json_schema_extra={
            "label": "bioRxiv primary provider",
            "group": "sources",
            "widget": "select",
            "restart": False,
            "order": 5,
            "options": [
                {"value": "api", "label": "bioRxiv API"},
                {"value": "crossref", "label": "Crossref"},
            ],
            "help": "Provider to try first when fetching bioRxiv metadata.",
        },
    )
    fallback_provider: Literal["api", "crossref", "none"] = Field(
        default="crossref",
        json_schema_extra={
            "label": "bioRxiv backup provider",
            "group": "sources",
            "widget": "select",
            "restart": False,
            "order": 6,
            "options": [
                {"value": "api", "label": "bioRxiv API"},
                {"value": "crossref", "label": "Crossref"},
                {"value": "none", "label": "None"},
            ],
            "help": "Provider to try if the primary source fails.",
        },
    )


class PubmedSourceConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        json_schema_extra={"label": "Use PubMed", "group": "sources", "widget": "bool", "restart": False, "order": 7},
    )
    api_key: Optional[str] = Field(
        default=None,
        json_schema_extra={"excluded": True},
    )
    query_mode: Literal["auto", "builder", "raw"] = Field(
        default="auto",
        json_schema_extra={
            "label": "PubMed search strategy",
            "group": "sources",
            "widget": "select",
            "restart": False,
            "order": 8,
            "options": [
                {"value": "auto", "label": "Auto from Topics & filters"},
                {"value": "builder", "label": "Custom PubMed builder"},
                {"value": "raw", "label": "Advanced raw PubMed query"},
            ],
            "help": "Choose how Claudesk builds the PubMed search before local ranking.",
        },
    )
    concepts: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "PubMed concepts",
            "group": "sources",
            "widget": "tags",
            "restart": False,
            "order": 9,
            "help": "Literal PubMed concepts used only by the custom builder strategy.",
        },
    )
    concept_scope: Literal["title_abstract", "mesh", "title_abstract_or_mesh"] = Field(
        default="title_abstract_or_mesh",
        json_schema_extra={
            "label": "PubMed concept scope",
            "group": "sources",
            "widget": "select",
            "restart": False,
            "order": 10,
            "options": [
                {"value": "title_abstract", "label": "Title / abstract"},
                {"value": "mesh", "label": "MeSH topics"},
                {"value": "title_abstract_or_mesh", "label": "Title / abstract + MeSH"},
            ],
            "help": "Field scope for custom PubMed concept and exclusion chips.",
        },
    )
    exclude_terms: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "PubMed exclusions",
            "group": "sources",
            "widget": "tags",
            "restart": False,
            "order": 11,
            "help": "Literal PubMed terms to exclude in custom builder mode.",
        },
    )
    search_terms: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Raw PubMed search terms",
            "group": "sources",
            "widget": "tags",
            "restart": False,
            "order": 12,
            "help": "Advanced PubMed syntax. Raw terms are parenthesized and joined with OR.",
        },
    )

    @model_validator(mode="before")
    @classmethod
    def _legacy_search_terms_default_to_raw(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        if "query_mode" not in value and "search_terms" in value:
            return {**value, "query_mode": "raw"}
        return value

    @field_validator("search_terms", "concepts", "exclude_terms", mode="before")
    @classmethod
    def _normalize_chip_list(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("PubMed chip fields must be lists of strings.")

        chips: list[str] = []
        seen: set[str] = set()
        for raw in value:
            if not isinstance(raw, str):
                raise ValueError("PubMed chip entries must be strings.")
            chip = raw.strip()
            key = chip.casefold()
            if not chip or key in seen:
                continue
            chips.append(chip)
            seen.add(key)
        return chips


class OpenalexSourceConfig(BaseModel):
    enabled: bool = Field(
        default=False,
        json_schema_extra={
            "label": "Use OpenAlex",
            "group": "sources",
            "widget": "bool",
            "restart": False,
            "order": 20,
            "help": "Requires OPENALEX_API_KEY env var.",
        },
    )
    api_key: Optional[str] = Field(
        default=None,
        json_schema_extra={"excluded": True},
    )


class SourcesConfig(BaseModel):
    arxiv: ArxivSourceConfig = Field(default_factory=ArxivSourceConfig)
    biorxiv: BiorxivSourceConfig = Field(default_factory=BiorxivSourceConfig)
    pubmed: PubmedSourceConfig = Field(default_factory=PubmedSourceConfig)
    openalex: OpenalexSourceConfig = Field(default_factory=OpenalexSourceConfig)


class DigestConfig(BaseModel):
    days_back: int = Field(
        default=3,
        json_schema_extra={"label": "Lookback window", "group": "digest", "widget": "int", "restart": False, "order": 1, "min": 1},
    )
    max_per_source: int = Field(
        default=200,
        json_schema_extra={"label": "Source fetch limit", "group": "digest", "widget": "int", "restart": False, "order": 2, "min": 1},
    )
    top_n: int = Field(
        default=10,
        json_schema_extra={"label": "Digest size", "group": "digest", "widget": "int", "restart": False, "order": 3, "min": 1},
    )


class ObsidianConfig(BaseModel):
    enabled: bool = Field(
        default=False,
        json_schema_extra={"label": "Export digests", "group": "obsidian", "widget": "bool", "restart": False, "order": 1},
    )
    vault_path: Optional[str] = Field(
        default=None,
        json_schema_extra={
            "label": "Obsidian vault",
            "group": "obsidian",
            "widget": "path",
            "restart": False,
            "order": 2,
            "help": "Absolute path. CLAUDESK_OBSIDIAN_VAULT env var overrides this.",
        },
    )
    folder: str = Field(
        default="Research/Digest",
        json_schema_extra={"label": "Digest folder", "group": "obsidian", "widget": "str", "restart": False, "order": 3},
    )


DEFAULT_SCORING_SYSTEM_PROMPT = """You are a strict evaluator. Your task is not to be creative.

Evaluate the relevance of the candidate item to the user's stated interest.

Use only the provided information. Do not infer missing details.

Rubric:

topic_match:
0 = unrelated
1 = broadly adjacent
2 = directly related
3 = central match

method_match:
0 = unrelated methods
1 = weak methodological overlap
2 = clear methodological overlap
3 = same or highly similar methods

usefulness:
0 = not useful
1 = possibly useful
2 = likely useful
3 = must-read or high-priority

novelty:
0 = already obvious/common
1 = modest novelty
2 = substantial novelty
3 = highly novel or field-shaping

confidence:
0 = cannot judge
1 = low confidence
2 = moderate confidence
3 = high confidence"""


class LlmConfig(BaseModel):
    provider: str = Field(
        default="openai",
        json_schema_extra={
            "label": "Scoring provider",
            "group": "llm",
            "widget": "select",
            "restart": False,
            "order": 1,
            "options": [
                {"value": "openai", "label": "OpenAI"},
            ],
        },
    )
    model: str = Field(
        default="gpt-4o-mini",
        json_schema_extra={"label": "Scoring model", "group": "llm", "widget": "str", "restart": False, "order": 2},
    )
    api_key: Optional[str] = Field(
        default=None,
        json_schema_extra={"excluded": True},
    )
    score_shortlist_n: int = Field(
        default=30,
        json_schema_extra={
            "label": "Papers to rescore",
            "group": "llm",
            "widget": "int",
            "restart": False,
            "order": 3,
            "min": 1,
            "help": "How many top-ranked papers receive rubric scoring per digest run.",
        },
    )
    scoring_system_prompt: str = Field(
        default=DEFAULT_SCORING_SYSTEM_PROMPT,
        json_schema_extra={
            "label": "Scoring rubric prompt",
            "group": "llm",
            "widget": "text",
            "restart": False,
            "order": 4,
            "help": "Rubric used for shortlisted papers. Claudesk adds required JSON output instructions.",
        },
    )


class ChatToolsConfig(BaseModel):
    search_web: bool = Field(
        default=True,
        json_schema_extra={"label": "Web search", "group": "chat", "widget": "bool", "restart": False, "order": 10},
    )
    fetch_url: bool = Field(
        default=True,
        json_schema_extra={"label": "Read web pages", "group": "chat", "widget": "bool", "restart": False, "order": 11},
    )
    fetch_paper_full_text: bool = Field(
        default=True,
        json_schema_extra={"label": "Fetch paper full text", "group": "chat", "widget": "bool", "restart": False, "order": 12},
    )
    paper_pdf: bool = Field(
        default=True,
        json_schema_extra={
            "label": "Local PDF tools",
            "group": "chat",
            "widget": "bool",
            "restart": False,
            "order": 13,
            "help": "Let the assistant list, parse, search, and inspect uploaded paper PDFs.",
        },
    )
    task_write: bool = Field(
        default=True,
        json_schema_extra={"label": "Task write tools", "group": "chat", "widget": "bool", "restart": False, "order": 14},
    )
    project_write: bool = Field(
        default=True,
        json_schema_extra={"label": "Project write tools", "group": "chat", "widget": "bool", "restart": False, "order": 15},
    )
    log_write: bool = Field(
        default=True,
        json_schema_extra={"label": "Log write tools", "group": "chat", "widget": "bool", "restart": False, "order": 16},
    )
    note_write: bool = Field(
        default=True,
        json_schema_extra={"label": "Note write tools", "group": "chat", "widget": "bool", "restart": False, "order": 17},
    )
    paper_collection_write: bool = Field(
        default=True,
        json_schema_extra={"label": "Paper collection tools", "group": "chat", "widget": "bool", "restart": False, "order": 18},
    )
    paper_ingest: bool = Field(
        default=True,
        json_schema_extra={"label": "Paper ingest tools", "group": "chat", "widget": "bool", "restart": False, "order": 19},
    )
    paper_asset_write: bool = Field(
        default=True,
        json_schema_extra={"label": "Paper asset write tools", "group": "chat", "widget": "bool", "restart": False, "order": 20},
    )


class ChatSkillsConfig(BaseModel):
    enabled: bool = Field(
        default=False,
        json_schema_extra={
            "label": "External skills",
            "group": "chat",
            "widget": "bool",
            "restart": False,
            "order": 18,
            "help": "Allow explicit $SkillName mentions during Codex turns.",
        },
    )
    roots: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Skill folders",
            "group": "chat",
            "widget": "tags",
            "restart": False,
            "order": 19,
            "help": "Absolute folders containing skill directories. Each skill directory must contain SKILL.md.",
        },
    )


ChatBackend = Literal["openai_api", "gemini_api", "anthropic_api", "codex_cli"]

CHAT_RUNTIME_CATALOG = {
    "openai_api": {
        "label": "OpenAI API",
        "models": [],
        "defaults": {
            "backend": "openai_api", "model": "gpt-4o-mini", "temperature": 0.7,
            "reasoning_effort": None, "reasoning_summary": None, "service_tier": None,
        },
    },
    "gemini_api": {
        "label": "Gemini API",
        "models": [{"value": name, "label": name} for name in ("gemini-2.5-flash", "gemini-2.5-pro")],
        "defaults": {"backend": "gemini_api", "model": "gemini-2.5-flash", "temperature": 0.7},
    },
    "anthropic_api": {
        "label": "Claude API",
        "models": [{"value": "claude-sonnet-4-5", "label": "claude-sonnet-4-5"}],
        "defaults": {"backend": "anthropic_api", "model": "claude-sonnet-4-5", "temperature": 0.7},
    },
    "codex_cli": {
        "label": "Codex",
        "models": [],
        "defaults": {
            "backend": "codex_cli", "model": "gpt-5.5", "reasoning_effort": "medium",
            "reasoning_summary": None, "service_tier": None,
        },
    },
}


def openai_chat_model_capabilities(model_id: str) -> dict | None:
    """Offline request compatibility, separate from account model discovery.

    The Models API supplies identifiers, not endpoint/parameter capabilities.
    Unknown conversational models remain visible but cannot be newly selected.
    Verified model effort ranges: https://developers.openai.com/api/docs/models
    Summary auto chooses a supported format without assuming concise/detailed:
    https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries
    """
    name = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model_id)
    if any(part in name for part in (
        "audio", "realtime", "transcribe", "tts", "image", "search", "deep-research",
        "embedding", "moderation", "computer-use",
    )) or not name.startswith(("gpt-", "chatgpt-", "o1", "o3", "o4", "ft:")):
        return None
    capabilities = {
        "supported": True, "temperature": False, "reasoning_efforts": [],
        "default_reasoning_effort": None, "reasoning_summaries": [],
        "input_modalities": ["text", "image"],
    }
    if name == "gpt-6-astra":
        capabilities.update(reasoning_efforts=["low", "medium", "high", "xhigh", "max"], default_reasoning_effort="medium")
    elif name in {"gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}:
        capabilities.update(reasoning_efforts=["none", "low", "medium", "high", "xhigh", "max"], default_reasoning_effort="medium")
    elif name in {"gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"}:
        capabilities.update(
            reasoning_efforts=["none", "low", "medium", "high", "xhigh"],
            default_reasoning_effort="medium" if name == "gpt-5.5" else "none",
        )
    elif name == "gpt-5.1":
        capabilities.update(reasoning_efforts=["none", "low", "medium", "high"], default_reasoning_effort="none")
    elif name in {"gpt-5", "gpt-5-mini", "gpt-5-nano"}:
        capabilities.update(reasoning_efforts=["minimal", "low", "medium", "high"], default_reasoning_effort="medium")
    elif re.fullmatch(r"gpt-(?:4o|4\.1)(?:-mini|-nano)?", name):
        capabilities["temperature"] = True
    elif name in {"o3", "o3-mini", "o4-mini"}:
        capabilities.update(reasoning_efforts=["low", "medium", "high"], default_reasoning_effort="medium")
        if name == "o3-mini":
            capabilities["input_modalities"] = ["text"]
    else:
        capabilities.update(supported=False, input_modalities=[])
    if capabilities["reasoning_efforts"]:
        capabilities["reasoning_summaries"] = ["auto", "none"]
    return capabilities


class ChatRuntimeSettings(BaseModel):
    """Validated, materialized options owned by one chat session."""

    model_config = ConfigDict(extra="forbid")

    backend: ChatBackend = Field(
        default="openai_api",
        json_schema_extra={
            "label": "Default backend", "group": "chat", "widget": "select", "restart": False, "order": 1,
            "options": [{"value": key, "label": entry["label"]} for key, entry in CHAT_RUNTIME_CATALOG.items()],
            "help": "Runtime defaults are copied into new chats. Existing chats keep their own settings.",
        },
    )
    model: str = Field(
        default="", strict=True,
        json_schema_extra={
            "label": "Model", "group": "chat", "widget": "select", "restart": False, "order": 2,
            "help": "Choose an available model. Applies to new chats only.",
        },
    )
    reasoning_effort: Optional[str] = Field(
        default=None, strict=True, min_length=1, max_length=32, pattern=r"^[a-z][a-z0-9_-]*$",
        json_schema_extra={
            "label": "Reasoning effort", "group": "chat", "widget": "select", "restart": False, "order": 4,
            "options": [{"value": v, "label": v.title()} for v in ("low", "medium", "high", "xhigh")],
        },
    )
    reasoning_summary: Optional[Literal["auto", "concise", "detailed", "none"]] = Field(
        default=None,
        json_schema_extra={
            "label": "Reasoning summary", "group": "chat", "widget": "select", "restart": False, "order": 5,
            "options": [{"value": "", "label": "Provider default"}] + [
                {"value": v, "label": v.title()} for v in ("auto", "concise", "detailed", "none")
            ],
        },
    )
    service_tier: Optional[str] = Field(
        default=None, strict=True,
        json_schema_extra={
            "label": "Service tier", "group": "chat", "widget": "str", "restart": False, "order": 6,
            "help": "Optional service tier for new OpenAI or Codex chats.",
        },
    )
    temperature: Optional[float] = Field(
        default=None, strict=True, ge=0, le=2, allow_inf_nan=False,
        json_schema_extra={
            "label": "Temperature", "group": "chat", "widget": "float", "restart": False, "order": 7,
            "min": 0, "max": 2,
        },
    )

    @field_validator("model", "service_tier")
    @classmethod
    def strip_runtime_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def materialize_runtime(self):
        defaults = dict(CHAT_RUNTIME_CATALOG[self.backend]["defaults"])
        if self.backend == "openai_api":
            capabilities = openai_chat_model_capabilities(self.model or defaults["model"])
            if capabilities and not capabilities["temperature"]:
                defaults["temperature"] = None
        for name in ChatRuntimeSettings.model_fields:
            value = getattr(self, name)
            if name not in defaults:
                if name in self.model_fields_set:
                    raise ValueError(f"{name} is not supported by {self.backend}.")
            elif (value is None and name not in self.model_fields_set) or (name == "model" and not value):
                setattr(self, name, defaults[name])
        if self.service_tier == "":
            self.service_tier = None
        if self.backend == "openai_api" and self.reasoning_effort is not None:
            capabilities = openai_chat_model_capabilities(self.model)
            if not capabilities or self.reasoning_effort not in capabilities["reasoning_efforts"]:
                raise ValueError(f"reasoning_effort is not supported by {self.model}.")
        if self.backend == "openai_api" and self.reasoning_summary not in (None, "none"):
            capabilities = openai_chat_model_capabilities(self.model)
            if not capabilities or self.reasoning_summary not in capabilities["reasoning_summaries"]:
                raise ValueError(f"reasoning_summary is not supported by {self.model}.")
        return self

    @model_serializer(mode="wrap")
    def serialize_runtime(self, handler):
        data = handler(self)
        supported = CHAT_RUNTIME_CATALOG[self.backend]["defaults"]
        for name in ChatRuntimeSettings.model_fields:
            if name not in supported:
                data.pop(name, None)
        return data


def chat_runtime_catalog() -> dict:
    """Expose the same backend fields/defaults to chat controls and Settings."""
    catalog = {}
    for backend, entry in CHAT_RUNTIME_CATALOG.items():
        fields = []
        for name in entry["defaults"]:
            if name == "backend":
                continue
            field = {"key": name, **ChatRuntimeSettings.model_fields[name].json_schema_extra}
            if name == "model":
                field["options"] = entry["models"]
            fields.append(field)
        fields.sort(key=lambda field: field["order"])
        catalog[backend] = {**entry, "fields": fields}
    return catalog


def chat_model_choice(
    backend: str,
    model_id: str,
    *,
    label: str | None = None,
    reasoning_efforts: list[str] | None = None,
    default_reasoning_effort: str | None = None,
    input_modalities: list[str] | None = None,
    is_default: bool = False,
) -> dict | None:
    """Build the picker controls and runtime defaults used by both clients."""
    defaults = {**CHAT_RUNTIME_CATALOG[backend]["defaults"], "model": model_id}
    supported = True
    applicable = set(defaults) - {"backend"}
    if backend == "openai_api":
        capabilities = openai_chat_model_capabilities(model_id)
        if capabilities is None:
            return None
        supported = capabilities["supported"]
        reasoning_efforts = capabilities["reasoning_efforts"]
        default_reasoning_effort = capabilities["default_reasoning_effort"]
        input_modalities = capabilities["input_modalities"]
        defaults["reasoning_effort"] = default_reasoning_effort
        if not capabilities["temperature"]:
            defaults["temperature"] = None
            applicable.discard("temperature")
        if not reasoning_efforts:
            applicable.difference_update({"reasoning_effort", "reasoning_summary"})
    elif backend == "codex_cli":
        reasoning_efforts = reasoning_efforts or []
        defaults["reasoning_effort"] = (
            default_reasoning_effort if default_reasoning_effort in reasoning_efforts
            else next(iter(reasoning_efforts), None)
        )
        if not reasoning_efforts:
            applicable.difference_update({"reasoning_effort", "reasoning_summary"})
    unavailable_reason = None if supported else "Model compatibility has not been verified for Claudesk chat."
    if supported and input_modalities is not None and "image" not in input_modalities:
        supported = False
        unavailable_reason = "This model does not support image attachments used by Claudesk chat."
    fields = []
    for key in defaults:
        if key not in applicable:
            continue
        field = {"key": key, **ChatRuntimeSettings.model_fields[key].json_schema_extra}
        if key == "reasoning_effort":
            field["options"] = [{"value": value, "label": value.title()} for value in reasoning_efforts or []]
        elif key == "reasoning_summary" and backend == "openai_api":
            field["options"] = [{"value": "", "label": "Provider default"}] + [
                {"value": value, "label": value.title()} for value in capabilities["reasoning_summaries"]
            ]
        fields.append(field)
    fields.sort(key=lambda field: field["order"])
    return {
        "id": model_id, "label": label or model_id, "selectable": supported,
        "unavailable_reason": unavailable_reason,
        "input_modalities": input_modalities if input_modalities is not None else ["text", "image"],
        "is_default": is_default, "defaults": defaults, "fields": fields,
    }


class ChatConfig(ChatRuntimeSettings):
    def runtime_settings(self) -> ChatRuntimeSettings:
        return ChatRuntimeSettings.model_validate({
            name: value for name, value in self.model_dump().items()
            if name in ChatRuntimeSettings.model_fields
        })

    system_prompt_addendum: str = Field(
        default="",
        json_schema_extra={
            "label": "Assistant instructions",
            "group": "chat",
            "widget": "text",
            "restart": False,
            "order": 8,
            "help": "Extra instructions appended to the assistant prompt.",
        },
    )
    codex_native_shell_tools: bool = Field(
        default=False,
        json_schema_extra={
            "label": "Codex native shell/file tools",
            "group": "chat",
            "widget": "bool",
            "restart": False,
            "order": 9,
            "help": (
                "Only affects Codex research chat. When off, Codex native shell/file writes, "
                "including apply_patch, run in a read-only sandbox. When enabled, native tools "
                "remain inside Claudesk's scoped sandbox with writable access limited to the Codex "
                "chat workspace. Network stays disabled unless Codex native internet access is also "
                "enabled. Claudesk MCP tools remain available either way."
            ),
        },
    )
    codex_native_web_search: bool = Field(
        default=False,
        json_schema_extra={
            "label": "Codex native web search",
            "group": "chat",
            "widget": "bool",
            "restart": False,
            "order": 10,
            "help": (
                "Only affects Codex research chat. Enables Codex's provider-native web_search "
                "tool. Separate from Claudesk's Web search MCP tool."
            ),
        },
    )
    codex_native_image_view: bool = Field(
        default=False,
        json_schema_extra={
            "label": "Codex native image view",
            "group": "chat",
            "widget": "bool",
            "restart": False,
            "order": 11,
            "help": (
                "Only affects Codex research chat. Enables Codex's native image viewing tool. "
                "Separate from Claudesk PDF/page-image MCP tools."
            ),
        },
    )
    codex_native_network_access: bool = Field(
        default=False,
        json_schema_extra={
            "label": "Codex native internet access",
            "group": "chat",
            "widget": "bool",
            "restart": False,
            "order": 12,
            "help": (
                "Only affects Codex research chat when native shell/file tools are enabled. "
                "Allows Codex native shell commands to use the network inside the scoped sandbox. "
                "Ignored while native shell/file tools are off."
            ),
        },
    )
    tools: ChatToolsConfig = Field(default_factory=ChatToolsConfig)
    skills: ChatSkillsConfig = Field(default_factory=ChatSkillsConfig)


class PaperAssetsConfig(BaseModel):
    pdf_parser: str = Field(
        default="pymupdf",
        json_schema_extra={
            "label": "PDF text parser",
            "group": "paper_assets",
            "widget": "select",
            "restart": False,
            "order": 2,
            "options": [
                {"value": "pymupdf", "label": "PyMuPDF"},
                {"value": "pymupdf4llm", "label": "PyMuPDF4LLM"},
                {"value": "docling", "label": "Docling"},
                {"value": "mineru", "label": "MinerU"},
            ],
            "help": "Parser used for PDF text extraction. PyMuPDF is built in; other parsers require local installs.",
        },
    )


class UiConfig(BaseModel):
    theme_mode: Literal["light", "dark", "system"] = Field(
        default="light",
        json_schema_extra={
            "label": "Theme mode",
            "group": "ui",
            "widget": "select",
            "restart": False,
            "order": 1,
            "options": [
                {"value": "light", "label": "Light"},
                {"value": "dark", "label": "Dark"},
                {"value": "system", "label": "System"},
            ],
            "help": "App color mode. System follows the local OS appearance setting.",
        },
    )


class Config(BaseModel):
    profile: Profile = Field(default_factory=Profile)
    topics: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Topics",
            "group": "keywords",
            "widget": "tags",
            "restart": False,
            "order": 1,
            "help": "Research themes used for similarity ranking.",
        },
    )
    keywords: Keywords = Field(default_factory=Keywords)
    tracked_authors: list[str] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Tracked authors",
            "group": "keywords",
            "widget": "tags",
            "restart": False,
            "order": 4,
            "help": "Papers from these authors stay eligible even when keyword filters would hide them.",
        },
    )
    seed_papers: list[SeedPaper] = Field(
        default_factory=list,
        json_schema_extra={
            "label": "Seed papers",
            "group": "keywords",
            "widget": "json",
            "restart": False,
            "order": 5,
            "help": "Stored in config for future ranking support. Current ranking ignores this list.",
        },
    )
    sources: SourcesConfig = Field(default_factory=SourcesConfig)
    digest: DigestConfig = Field(default_factory=DigestConfig)
    obsidian: ObsidianConfig = Field(default_factory=ObsidianConfig)
    llm: LlmConfig = Field(default_factory=LlmConfig)
    chat: ChatConfig = Field(default_factory=ChatConfig)
    paper_assets: PaperAssetsConfig = Field(default_factory=PaperAssetsConfig)
    ui: UiConfig = Field(default_factory=UiConfig)


def data_dir() -> Path:
    """Return the Claudesk vault directory, creating it if it doesn't exist."""
    d = vault_location().path
    d.mkdir(parents=True, exist_ok=True)
    return d


def paper_assets_root(cfg: Optional[Config] = None, *, create: bool = True) -> Path:
    """Return the managed durable asset root, creating it by default."""
    _ = cfg
    base = data_dir() if create else vault_location().path
    root = (base / "assets").resolve()
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def retrieval_index_root(*, create: bool = True) -> Path:
    """Return the local rebuildable retrieval index root outside the synced vault."""
    vault_path = vault_location().path.resolve()
    digest = hashlib.sha256(str(vault_path).encode("utf-8")).hexdigest()[:16]
    root = (local_config_path().parent / "retrieval-index" / digest).resolve()
    try:
        root.relative_to(vault_path)
    except ValueError:
        pass
    else:
        raise VaultConfigError(f"Retrieval index path must not live under the synced vault: {root}")
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def config_path(path: Optional[str] = None) -> Path:
    """Return the interests.yaml path."""
    return Path(path) if path else data_dir() / "interests.yaml"


def _load_raw_config(path: Optional[str] = None) -> dict:
    resolved = config_path(path)
    if not resolved.exists():
        return {}
    with open(resolved) as f:
        return yaml.safe_load(f) or {}


def _apply_environment_overrides(cfg: Config) -> Config:
    # CLAUDESK_OBSIDIAN_VAULT env var overrides the config file value.
    # Useful on the MacBook where the vault path differs from Linux.
    if vault := os.environ.get("CLAUDESK_OBSIDIAN_VAULT"):
        cfg.obsidian.vault_path = vault
        cfg.obsidian.enabled = True

    if api_key := os.environ.get("OPENAI_API_KEY"):
        cfg.llm.api_key = api_key

    if openalex_api_key := os.environ.get("OPENALEX_API_KEY"):
        cfg.sources.openalex.api_key = openalex_api_key

    return cfg


def _load_config_model(path: Optional[str] = None, *, apply_env: bool) -> Config:
    raw = _load_raw_config(path)
    cfg = Config() if not raw else Config.model_validate(raw)
    return _apply_environment_overrides(cfg) if apply_env else cfg


def load_config_file(path: Optional[str] = None) -> Config:
    """Load interests.yaml from disk without env overrides or cache effects."""
    return _load_config_model(path, apply_env=False)


def _config_to_file_data(cfg: Config) -> dict:
    data = cfg.model_dump(mode="python")
    llm = data.get("llm")
    if isinstance(llm, dict):
        llm.pop("api_key", None)
    sources = data.get("sources")
    if isinstance(sources, dict):
        openalex = sources.get("openalex")
        if isinstance(openalex, dict):
            openalex.pop("api_key", None)
        pubmed = sources.get("pubmed")
        if isinstance(pubmed, dict):
            pubmed.pop("api_key", None)
    return data


def save_config_file(cfg: Config, path: Optional[str] = None) -> Path:
    """Write interests.yaml without clearing the cached runtime config."""
    resolved = config_path(path)
    _write_yaml_atomically(resolved, _config_to_file_data(cfg))
    return resolved


@lru_cache(maxsize=1)
def load_config(path: Optional[str] = None) -> Config:
    """Load interests.yaml into the cached runtime config."""
    return _load_config_model(path, apply_env=True)
