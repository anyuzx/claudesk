from __future__ import annotations


class DomainError(Exception):
    """Base class for expected core/domain errors."""


class NotFoundError(DomainError):
    """Raised when a requested domain object does not exist."""


class ValidationError(DomainError):
    """Raised when domain input fails validation."""
