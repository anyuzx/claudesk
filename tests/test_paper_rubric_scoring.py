from __future__ import annotations

import unittest

from claudesk.core.llm import (
    _normalised_rubric_score,
    _parse_rubric_ratings,
)


class PaperRubricScoringTests(unittest.TestCase):
    def test_parse_rubric_ratings_and_normalise_score(self) -> None:
        ratings = _parse_rubric_ratings({
            "papers": [
                {
                    "index": 1,
                    "topic_match": 3,
                    "method_match": 2,
                    "usefulness": 3,
                    "novelty": 1,
                    "confidence": 2,
                    "evidence": ["Direct topic match", "Clear method overlap"],
                    "reason": "Likely useful but not highly novel.",
                }
            ]
        })

        self.assertIn(1, ratings)
        rubric = ratings[1]
        self.assertAlmostEqual(_normalised_rubric_score(rubric), 11 / 15)
        self.assertEqual(rubric.topic_match, 3)
        self.assertEqual(rubric.evidence, ["Direct topic match", "Clear method overlap"])

    def test_parse_rubric_ratings_skips_malformed_items(self) -> None:
        ratings = _parse_rubric_ratings({
            "papers": [
                {"index": 1, "topic_match": 3},
                {
                    "index": 2,
                    "topic_match": 3,
                    "method_match": 3,
                    "usefulness": 3,
                    "novelty": 3,
                    "confidence": 3,
                },
            ]
        })

        self.assertNotIn(1, ratings)
        self.assertIn(2, ratings)

    def test_parse_rubric_ratings_rejects_out_of_range_scores(self) -> None:
        ratings = _parse_rubric_ratings({
            "papers": [
                {
                    "index": 1,
                    "topic_match": 5,
                    "method_match": 2,
                    "usefulness": 3,
                    "novelty": 0,
                    "confidence": 2,
                },
                {
                    "index": 2,
                    "topic_match": 3,
                    "method_match": -1,
                    "usefulness": 3,
                    "novelty": 0,
                    "confidence": 2,
                },
                {
                    "index": 3,
                    "topic_match": "4",
                    "method_match": 2,
                    "usefulness": 3,
                    "novelty": 0,
                    "confidence": 2,
                },
                {
                    "index": 4,
                    "topic_match": "3",
                    "method_match": 2,
                    "usefulness": 3,
                    "novelty": 0,
                    "confidence": 2,
                },
            ]
        })

        self.assertNotIn(1, ratings)
        self.assertNotIn(2, ratings)
        self.assertNotIn(3, ratings)
        self.assertIn(4, ratings)
        self.assertEqual(ratings[4].topic_match, 3)


if __name__ == "__main__":
    unittest.main()
