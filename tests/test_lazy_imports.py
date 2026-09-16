from __future__ import annotations

import subprocess
import sys
import unittest


class LazyImportTests(unittest.TestCase):
    def test_importing_api_and_job_modules_does_not_import_embedding_stack(self) -> None:
        script = """
import sys
import claudesk.api.main  # noqa: F401
import claudesk.jobs.run_digest  # noqa: F401
import claudesk.jobs.run_rubric_scoring  # noqa: F401
forbidden = ("sentence_transformers", "torch", "triton")
present = [name for name in forbidden if name in sys.modules]
if present:
    raise SystemExit("eager imports: " + ", ".join(present))
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
