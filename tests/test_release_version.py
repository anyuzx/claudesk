from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_SCRIPT = ROOT / "scripts" / "release.py"


def load_release_module():
    spec = importlib.util.spec_from_file_location("claudesk_release", RELEASE_SCRIPT)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


release = load_release_module()


def write_minimal_release_tree(root: Path, *, version: str = "0.1.0", changelog: bool = True) -> None:
    (root / "claudesk").mkdir()
    (root / "frontend").mkdir()
    (root / "pyproject.toml").write_text(
        f'[project]\nname = "claudesk"\nversion = "{version}"\n',
        encoding="utf-8",
    )
    (root / "claudesk" / "__init__.py").write_text(f'__version__ = "{version}"\n', encoding="utf-8")
    (root / "frontend" / "package.json").write_text(
        json.dumps({"name": "claudesk-frontend", "version": version}, indent=2) + "\n",
        encoding="utf-8",
    )
    (root / "frontend" / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "claudesk-frontend",
                "version": version,
                "lockfileVersion": 3,
                "packages": {"": {"name": "claudesk-frontend", "version": version}},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    if changelog:
        (root / "CHANGELOG.md").write_text(f"# Changelog\n\n## [{version}] - 2026-05-24\n", encoding="utf-8")


class ReleaseVersionTests(unittest.TestCase):
    def test_validate_semver_accepts_release_and_prerelease_versions(self) -> None:
        self.assertEqual(release.validate_semver("0.1.0"), "0.1.0")
        self.assertEqual(release.validate_semver("1.2.3-rc.1"), "1.2.3-rc.1")

    def test_validate_semver_rejects_invalid_release_versions(self) -> None:
        for version in ("v0.1.0", "01.2.3", "1.2", "1.2.3-01", "1.2.3+build.1"):
            with self.subTest(version=version):
                with self.assertRaises(release.ReleaseError):
                    release.validate_semver(version)

    def test_bump_release_version_updates_all_version_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_minimal_release_tree(root)

            release.bump_release_version("0.2.0", root=root)

            versions = release._load_versions(root)
            self.assertEqual(versions["pyproject.toml"], "0.2.0")
            self.assertEqual(versions["claudesk/__init__.py"], "0.2.0")
            self.assertEqual(versions["frontend/package.json"], "0.2.0")
            self.assertEqual(versions["frontend/package-lock.json"], "0.2.0")
            self.assertEqual(versions['frontend/package-lock.json packages[""]'], "0.2.0")

    def test_check_release_requires_synced_versions_and_changelog_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_minimal_release_tree(root, version="0.1.0", changelog=False)
            original_git_tag_exists = release._git_tag_exists
            release._git_tag_exists = lambda check_root, version: False
            try:
                with self.assertRaisesRegex(release.ReleaseError, "missing a release entry"):
                    release.check_release("0.1.0", root=root)

                (root / "CHANGELOG.md").write_text("# Changelog\n\n## [0.1.0] - 2026-05-24\n", encoding="utf-8")
                release.check_release("0.1.0", root=root)

                package_json = json.loads((root / "frontend" / "package.json").read_text(encoding="utf-8"))
                package_json["version"] = "0.2.0"
                (root / "frontend" / "package.json").write_text(json.dumps(package_json), encoding="utf-8")
                with self.assertRaisesRegex(release.ReleaseError, "not synced"):
                    release.check_release("0.1.0", root=root)
            finally:
                release._git_tag_exists = original_git_tag_exists

    def test_check_release_rejects_existing_tag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_minimal_release_tree(root)
            original_git_tag_exists = release._git_tag_exists
            release._git_tag_exists = lambda check_root, version: True
            try:
                with self.assertRaisesRegex(release.ReleaseError, "already exists"):
                    release.check_release("0.1.0", root=root)
            finally:
                release._git_tag_exists = original_git_tag_exists


if __name__ == "__main__":
    unittest.main()
