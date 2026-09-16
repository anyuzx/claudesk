from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from claudesk.core.config import clear_vault_location_cache


@contextmanager
def patched_data_dir(path: str | Path) -> Iterator[None]:
    with patch.dict(os.environ, {"CLAUDESK_DATA_DIR": str(path)}, clear=False):
        clear_vault_location_cache()
        try:
            yield
        finally:
            clear_vault_location_cache()
