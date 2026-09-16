#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
Check = tuple[str, list[str]]


DEFAULT_CHECKS: tuple[Check, ...] = (
    (
        "Python syntax",
        [sys.executable, "-m", "compileall", "-q", "claudesk", "tests", "scripts"],
    ),
    (
        "Backend architecture and lazy imports",
        [
            sys.executable,
            "-m",
            "unittest",
            "-q",
            "tests.test_backend_architecture",
            "tests.test_lazy_imports",
        ],
    ),
    ("Diff whitespace", ["git", "diff", "--check"]),
)


def run_checks(checks: Sequence[Check]) -> int:
    for label, command in checks:
        print(f"\n== {label} ==")
        print(shlex.join(command))
        result = subprocess.run(command, cwd=REPO_ROOT, check=False)
        if result.returncode != 0:
            return result.returncode
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the dependency-free backend quality gate.",
    )
    parser.add_argument(
        "--skip-diff-check",
        action="store_true",
        help="Skip git diff --check when running outside a git worktree diff context.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    checks = tuple(check for check in DEFAULT_CHECKS if not args.skip_diff_check or check[0] != "Diff whitespace")
    return run_checks(checks)


if __name__ == "__main__":
    raise SystemExit(main())
