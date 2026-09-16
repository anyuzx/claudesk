from __future__ import annotations

import unittest

from claudesk.core.doi import InvalidDoiError, doi_identity_key, normalize_doi


class DoiNormalizationTests(unittest.TestCase):
    def test_normalizes_supported_doi_forms(self) -> None:
        cases = {
            "10.1234/ABC.Def": "10.1234/abc.def",
            " doi:10.1234/ABC.Def ": "10.1234/abc.def",
            "DOI: 10.1234/ABC.Def": "10.1234/abc.def",
            "https://doi.org/10.1234/ABC.Def": "10.1234/abc.def",
            "http://dx.doi.org/10.1234/ABC.Def": "10.1234/abc.def",
            "https://doi.org/10.1234%2FABC.Def": "10.1234/abc.def",
        }

        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(normalize_doi(raw), expected)

    def test_rejects_invalid_doi_forms(self) -> None:
        invalid_values = [
            "",
            "doi:",
            "not a doi",
            "10.1234",
            "10.1234/has whitespace",
            "https://example.org/10.1234/example",
            "https://doi.org/not-a-doi",
        ]

        for raw in invalid_values:
            with self.subTest(raw=raw):
                with self.assertRaises(InvalidDoiError):
                    normalize_doi(raw)

    def test_identity_key_returns_none_for_non_doi_values(self) -> None:
        self.assertIsNone(doi_identity_key("pmid:12345"))
        self.assertIsNone(doi_identity_key("2401.12345"))
        self.assertEqual(doi_identity_key(" DOI:10.1234/ABC "), "10.1234/abc")


if __name__ == "__main__":
    unittest.main()
