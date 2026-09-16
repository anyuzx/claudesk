from __future__ import annotations

import os
import sqlite3
import tempfile
import textwrap
import unittest
from datetime import date

from claudesk.core.db import (
    SCHEMA_VERSION,
    init_db,
)
from claudesk.core.db.papers import (
    get_paper,
    upsert_paper,
)
from claudesk.core.models import Paper
from claudesk.sources import pubmed


def make_conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class PaperJournalMetadataTests(unittest.TestCase):
    def test_init_db_adds_journal_abbrev_column_on_existing_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "legacy.db")
            conn = make_conn(db_path)
            conn.executescript(
                """
                CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
                INSERT INTO schema_version (version) VALUES (6);
                CREATE TABLE papers (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    source          TEXT NOT NULL,
                    external_id     TEXT NOT NULL,
                    title           TEXT NOT NULL,
                    abstract        TEXT NOT NULL,
                    authors         TEXT NOT NULL DEFAULT '[]',
                    published_date  TEXT NOT NULL,
                    url             TEXT NOT NULL,
                    embedding       BLOB,
                    relevance_score REAL,
                    justification   TEXT,
                    note            TEXT,
                    status          TEXT NOT NULL DEFAULT 'new',
                    is_saved        INTEGER NOT NULL DEFAULT 0,
                    is_read         INTEGER NOT NULL DEFAULT 0,
                    is_to_read      INTEGER NOT NULL DEFAULT 0,
                    fetched_at      TEXT NOT NULL,
                    UNIQUE(source, external_id)
                );
                """
            )
            conn.commit()

            init_db(conn)

            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(papers)").fetchall()
            }
            version = conn.execute(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
            ).fetchone()[0]

            self.assertIn("journal_abbrev", columns)
            self.assertIn("score_rubric", columns)
            self.assertNotIn("justification", columns)
            self.assertEqual(version, SCHEMA_VERSION)
            conn.close()

    def test_upsert_paper_backfills_journal_abbrev_for_existing_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            conn = make_conn(os.path.join(tmpdir, "claudesk.db"))
            init_db(conn)

            paper = Paper(
                source="pubmed",
                external_id="pmid:123",
                title="PubMed paper",
                abstract="Abstract",
                authors=["Alice Example"],
                published_date=date(2026, 4, 24),
                url="https://pubmed.ncbi.nlm.nih.gov/123/",
            )
            paper_id = upsert_paper(conn, paper)
            conn.commit()

            updated_paper = paper.model_copy(update={"journal_abbrev": "Proc Natl Acad Sci U S A"})
            same_id = upsert_paper(conn, updated_paper)
            conn.commit()

            stored = get_paper(conn, paper_id)
            self.assertEqual(same_id, paper_id)
            self.assertIsNotNone(stored)
            self.assertEqual(stored.journal_abbrev, "Proc Natl Acad Sci U S A")
            conn.close()

    def test_pubmed_parser_extracts_journal_abbreviation(self) -> None:
        xml_text = textwrap.dedent(
            """
            <PubmedArticleSet>
              <PubmedArticle>
                <MedlineCitation>
                  <PMID>12345</PMID>
                  <Article>
                    <Journal>
                      <ISSN>0027-8424</ISSN>
                      <JournalIssue>
                        <PubDate>
                          <Year>2026</Year>
                          <Month>Apr</Month>
                          <Day>24</Day>
                        </PubDate>
                      </JournalIssue>
                      <Title>Proceedings of the National Academy of Sciences of the United States of America</Title>
                      <ISOAbbreviation>Proc Natl Acad Sci U S A</ISOAbbreviation>
                    </Journal>
                    <ArticleTitle>Example article title</ArticleTitle>
                    <Abstract>
                      <AbstractText>Example abstract text.</AbstractText>
                    </Abstract>
                    <AuthorList>
                      <Author>
                        <ForeName>Alice</ForeName>
                        <LastName>Example</LastName>
                      </Author>
                    </AuthorList>
                  </Article>
                </MedlineCitation>
                <PubmedData>
                  <ArticleIdList>
                    <ArticleId IdType="doi">10.1000/example</ArticleId>
                  </ArticleIdList>
                </PubmedData>
              </PubmedArticle>
            </PubmedArticleSet>
            """
        ).strip()

        papers = pubmed._parse_pubmed_xml(xml_text)

        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0].journal_abbrev, "Proc Natl Acad Sci U S A")
        self.assertEqual(papers[0].external_id, "10.1000/example")


if __name__ == "__main__":
    unittest.main()
