from __future__ import annotations

import re
from urllib.parse import unquote, urlparse


class InvalidDoiError(ValueError):
    """Raised when user-provided DOI text cannot be normalized."""


_DOI_PATTERN = re.compile(r"^10\.\d{4,9}/[^\s]+$", re.IGNORECASE)


def normalize_doi(value: object) -> str:
    """Normalize DOI input accepted by the manual paper ingestion flow."""
    doi = _strip_doi_wrappers(str(value or "").strip())
    doi = unquote(doi).strip().lower()
    if not doi:
        raise InvalidDoiError("DOI is required.")
    if not _DOI_PATTERN.match(doi):
        raise InvalidDoiError("Invalid DOI.")
    return doi


def doi_identity_key(value: object) -> str | None:
    """Return a normalized DOI key, or None when the value is not a DOI."""
    try:
        return normalize_doi(value)
    except InvalidDoiError:
        return None


def _strip_doi_wrappers(value: str) -> str:
    if not value:
        return ""

    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"} and parsed.netloc.lower() in {"doi.org", "dx.doi.org"}:
        return parsed.path.lstrip("/")

    if re.match(r"^doi\s*:", value, flags=re.IGNORECASE):
        return re.sub(r"^doi\s*:", "", value, count=1, flags=re.IGNORECASE).strip()

    return value
