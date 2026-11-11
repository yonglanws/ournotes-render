from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.client import (  # noqa: E402
    HostError,
    OurnotesClient,
    build_render_payload,
    build_script_payload,
    normalize_base_url,
)


class ClientTests(unittest.TestCase):
    def test_normalize_base_url(self) -> None:
        self.assertEqual(
            normalize_base_url("http://127.0.0.1:9881/"), "http://127.0.0.1:9881"
        )
        self.assertEqual(
            normalize_base_url("http://127.0.0.1:9881/api/v1/"), "http://127.0.0.1:9881"
        )
        self.assertEqual(
            normalize_base_url("https://example.com/ournotes"),
            "https://example.com/ournotes",
        )
        self.assertEqual(
            normalize_base_url("127.0.0.1:9881"), "http://127.0.0.1:9881"
        )

    def test_rejects_bad_bases(self) -> None:
        for value in [
            "ftp://example.com",
            "http://user:pass@example.com",
            "http://example.com/?a=1",
        ]:
            with self.subTest(value=value), self.assertRaises(HostError):
                normalize_base_url(value)

    def test_script_payload_only_includes_set_fields(self) -> None:
        self.assertEqual(
            build_script_payload("场景"), {"prompt": "场景", "mode": "story"}
        )
        self.assertEqual(
            build_script_payload(
                "场景",
                mode="chat",
                language="ja",
                base="stories/1.json",
                target_minutes=2.5,
                max_lines=24,
                history=[{"role": "user", "content": "上次聊到练习"}],
                pipeline="single",
            ),
            {
                "prompt": "场景",
                "mode": "chat",
                "history": [{"role": "user", "content": "上次聊到练习"}],
                "language": "ja",
                "base": "stories/1.json",
                "targetMinutes": 2.5,
                "maxLines": 24,
                "pipeline": "single",
            },
        )

    def test_render_payload_requests_the_async_queue(self) -> None:
        payload = build_render_payload({"format": "ournotes.story-script/1"}, tts=False)
        self.assertEqual(payload["wait"], False)
        self.assertEqual(payload["tts"], False)
        self.assertEqual(payload["timeout"], 1_800_000)
        self.assertEqual(payload["script"]["format"], "ournotes.story-script/1")

    def test_error_messages_are_actionable(self) -> None:
        self.assertIn("鉴权", OurnotesClient._describe_error(401, "no"))
        self.assertIn("paths.site", OurnotesClient._describe_error(503, "site missing"))
        self.assertIn("队列已满", OurnotesClient._describe_error(429, "busy"))
        self.assertIn("HTTP 500", OurnotesClient._describe_error(500, "boom"))


if __name__ == "__main__":
    unittest.main()
