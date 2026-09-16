from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Callable

from claudesk.core.models import Paper

SourceProgressCallback = Callable[[dict[str, object]], None]
FetchFn = Callable[..., list[Paper]]


@dataclass(frozen=True)
class Source:
    name: str
    fetch: FetchFn
