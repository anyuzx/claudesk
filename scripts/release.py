#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?$"
)


class ReleaseError(RuntimeError):
    pass


def validate_semver(version: str) -> str:
    if version.startswith("v"):
        raise ReleaseError("Pass the version without the leading 'v'.")
    if not SEMVER_RE.fullmatch(version):
        raise ReleaseError(f"Invalid SemVer release version: {version}")
    return version


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def _replace_once(text: str, pattern: str, replacement: str, *, path: Path) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ReleaseError(f"Could not update expected version field in {path}")
    return updated


def _load_pyproject_version(root: Path) -> str:
    pyproject = root / "pyproject.toml"
    data = tomllib.loads(_read_text(pyproject))
    try:
        version = data["project"]["version"]
    except KeyError as exc:
        raise ReleaseError("pyproject.toml is missing [project].version") from exc
    if not isinstance(version, str):
        raise ReleaseError("pyproject.toml [project].version must be a string")
    return version


def _load_init_version(root: Path) -> str:
    path = root / "claudesk" / "__init__.py"
    match = re.search(r'^__version__\s*=\s*"([^"]+)"\s*$', _read_text(path), re.MULTILINE)
    if not match:
        raise ReleaseError("claudesk/__init__.py is missing __version__")
    return match.group(1)


def _load_frontend_versions(root: Path) -> dict[str, str]:
    package_json = json.loads(_read_text(root / "frontend" / "package.json"))
    package_lock = json.loads(_read_text(root / "frontend" / "package-lock.json"))
    versions: dict[str, str] = {
        "frontend/package.json": package_json.get("version"),
        "frontend/package-lock.json": package_lock.get("version"),
    }
    try:
        versions['frontend/package-lock.json packages[""]'] = package_lock["packages"][""]["version"]
    except KeyError as exc:
        raise ReleaseError('frontend/package-lock.json is missing packages[""].version') from exc
    return versions


def _load_versions(root: Path) -> dict[str, str]:
    return {
        "pyproject.toml": _load_pyproject_version(root),
        "claudesk/__init__.py": _load_init_version(root),
        **_load_frontend_versions(root),
    }


def _write_json(path: Path, payload: object) -> None:
    _write_text(path, json.dumps(payload, indent=2) + "\n")


def bump_release_version(version: str, *, root: Path = REPO_ROOT) -> None:
    version = validate_semver(version)

    pyproject = root / "pyproject.toml"
    _write_text(
        pyproject,
        _replace_once(
            _read_text(pyproject),
            r'^version\s*=\s*"[^"]+"',
            f'version = "{version}"',
            path=pyproject,
        ),
    )

    init_py = root / "claudesk" / "__init__.py"
    _write_text(
        init_py,
        _replace_once(
            _read_text(init_py),
            r'^__version__\s*=\s*"[^"]+"',
            f'__version__ = "{version}"',
            path=init_py,
        ),
    )

    package_path = root / "frontend" / "package.json"
    package_json = json.loads(_read_text(package_path))
    package_json["version"] = version
    _write_json(package_path, package_json)

    package_lock_path = root / "frontend" / "package-lock.json"
    package_lock = json.loads(_read_text(package_lock_path))
    package_lock["version"] = version
    package_lock.setdefault("packages", {}).setdefault("", {})["version"] = version
    _write_json(package_lock_path, package_lock)


def _changelog_has_entry(root: Path, version: str) -> bool:
    changelog = root / "CHANGELOG.md"
    if not changelog.exists():
        return False
    heading = re.compile(rf"^## \[?{re.escape(version)}\]?(?:\s|-|$)", re.MULTILINE)
    return bool(heading.search(_read_text(changelog)))


def _git_tag_exists(root: Path, version: str) -> bool:
    result = subprocess.run(
        ["git", "tag", "--list", f"v{version}"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ReleaseError(result.stderr.strip() or "Could not inspect git tags")
    return bool(result.stdout.strip())


def check_release(version: str, *, root: Path = REPO_ROOT) -> None:
    version = validate_semver(version)
    versions = _load_versions(root)
    mismatches = {
        name: found
        for name, found in versions.items()
        if found != version
    }
    if mismatches:
        details = ", ".join(f"{name}={found!r}" for name, found in sorted(mismatches.items()))
        raise ReleaseError(f"Version files are not synced to {version}: {details}")
    if not _changelog_has_entry(root, version):
        raise ReleaseError(f"CHANGELOG.md is missing a release entry for {version}")
    if _git_tag_exists(root, version):
        raise ReleaseError(f"Tag v{version} already exists")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare and validate Claudesk releases.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    bump = subparsers.add_parser("bump", help="Update version-bearing files.")
    bump.add_argument("version", help="SemVer version without the leading v, e.g. 0.2.0")

    check = subparsers.add_parser("check", help="Validate release readiness for a version.")
    check.add_argument("version", help="SemVer version without the leading v, e.g. 0.2.0")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "bump":
            bump_release_version(args.version)
            print(f"Updated release version to {args.version}")
            return 0
        if args.command == "check":
            check_release(args.version)
            print(f"Release {args.version} is ready to tag")
            return 0
    except ReleaseError as exc:
        print(f"release.py: {exc}", file=sys.stderr)
        return 1
    raise AssertionError(f"Unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
