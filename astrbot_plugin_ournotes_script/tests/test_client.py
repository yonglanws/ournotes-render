from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.client import HostError, build_payload, normalize_base


class ClientTests(unittest.TestCase):
    def test_normalize_base(self) -> None:
        self.assertEqual(
            normalize_base("http://127.0.0.1:9881/"), "http://127.0.0.1:9881"
        )
        self.assertEqual(
            normalize_base("http://127.0.0.1:9881/api/v1/"), "http://127.0.0.1:9881"
        )
        self.assertEqual(
            normalize_base("https://example.com/ournotes"),
            "https://example.com/ournotes",
        )

    def test_rejects_bad_bases(self) -> None:
        for value in [
            "",
            "ftp://example.com",
            "http://user:pass@example.com",
            "http://example.com/?a=1",
        ]:
            with self.subTest(value=value), self.assertRaises(HostError):
                normalize_base(value)

    def test_payload_only_includes_set_fields(self) -> None:
        self.assertEqual(build_payload("场景"), {"prompt": "场景"})
        self.assertEqual(
            build_payload(
                "场景",
                language="ja",
                base="stories/1.json",
                target_minutes=2.5,
                max_lines=24,
            ),
            {
                "prompt": "场景",
                "language": "ja",
                "base": "stories/1.json",
                "targetMinutes": 2.5,
                "maxLines": 24,
            },
        )

    def test_error_messages_are_actionable(self) -> None:
        # _describe_error is intentionally static and does not need a network.
        from core.client import OurnotesClient

        self.assertIn("鉴权", OurnotesClient._describe_error(401, '{"message":"no"}'))
        self.assertIn(
            "paths.site",
            OurnotesClient._describe_error(503, '{"message":"site missing"}'),
        )
        self.assertIn("HTTP 500", OurnotesClient._describe_error(500, "boom"))


if __name__ == "__main__":
    unittest.main()
