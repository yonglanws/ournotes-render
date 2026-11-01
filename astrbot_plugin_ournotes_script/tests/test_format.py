from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.format import (
    cast_map,
    count_dialogue,
    format_script,
    format_warnings,
)
from core.storage import (
    prune_scripts,
    safe_stem,
    script_path,
    write_script_file,
)

DOC = {
    "format": "ournotes.story-script/1",
    "title": "测试剧本",
    "cast": {"a": {"model": "m_a", "name": "高松灯"}, "b": "长崎素世"},
    "beats": [
        {"scene": "stage1", "location": "教室", "music": "bgm1"},
        {
            "positions": {"a": "far-left", "b": "far-right"},
            "camera": "middle",
            "focus": 5,
        },
        {
            "say": "a",
            "text": "你好",
            "motion": "mtn_nod01",
            "expression": "exp_idle02",
            "lookAt": "b",
        },
        {"narrate": "放学后的教室很安静。", "camera": "close"},
        {"camera": "far", "focus": "center", "track": 0.5, "zoom": 1.05},
        {"action": "挥手", "cast": "b", "motion": "mtn_wave01", "duration": 1},
        {"fade": "out", "duration": 0.5},
        {"pause": 0.2},
    ],
}


class FormatTests(unittest.TestCase):
    def test_cast_forms(self) -> None:
        self.assertEqual(cast_map(DOC["cast"]), {"a": "高松灯", "b": "长崎素世"})
        self.assertEqual(
            cast_map([{"id": "x", "name": "甲"}, {"name": "乙"}]),
            {"x": "甲", "乙": "乙"},
        )

    def test_full_preview(self) -> None:
        text = format_script(DOC)
        self.assertIn("《测试剧本》", text)
        self.assertIn("角色：高松灯、长崎素世", text)
        self.assertIn("【场景】教室 · 背景 stage1 · BGM bgm1", text)
        self.assertIn("【站位】高松灯 far-left，长崎素世 far-right", text)
        self.assertIn("高松灯：你好（动作 mtn_nod01 · 表情 exp_idle02 · 视线 b）", text)
        self.assertIn("【旁白】放学后的教室很安静。（镜头 close）", text)
        self.assertIn("【镜头】far · 焦点 center · 横移 0.5 · 缩放 1.05", text)
        self.assertIn("【反应】长崎素世 挥手（动作 mtn_wave01）", text)
        self.assertIn("【黑场】out 0.5s", text)
        self.assertIn("【停顿】0.2s", text)
        self.assertEqual(count_dialogue(DOC["beats"]), 2)

    def test_preview_line_limit(self) -> None:
        text = format_script(DOC, preview_lines=1)
        self.assertIn("高松灯：你好", text)
        self.assertNotIn("放学后的教室很安静", text)
        self.assertIn("还有 1 句", text)

    def test_zero_preview_means_all(self) -> None:
        text = format_script(DOC, preview_lines=0)
        self.assertIn("放学后的教室很安静", text)
        self.assertNotIn("还有", text)

    def test_directions_can_be_hidden(self) -> None:
        text = format_script(DOC, include_directions=False)
        self.assertIn("高松灯：你好", text)
        self.assertNotIn("mtn_nod01", text)
        self.assertNotIn("【镜头】", text)
        self.assertNotIn("【反应】", text)
        self.assertIn("【场景】教室", text)

    def test_character_limit(self) -> None:
        text = format_script(DOC, max_chars=80)
        self.assertLessEqual(len(text), 80 + len("\n……（内容过长，完整剧本见附件）"))
        self.assertIn("内容过长", text)

    def test_warnings(self) -> None:
        self.assertEqual(
            format_warnings([{"message": "少了动作"}, "重复站位"]),
            "⚠️ 生成警告：少了动作；重复站位",
        )
        self.assertEqual(format_warnings([]), "")
        self.assertEqual(format_warnings(None), "")

    def test_bad_document(self) -> None:
        self.assertIn("不是对象", format_script([]))


class StorageTests(unittest.TestCase):
    def test_safe_stem(self) -> None:
        self.assertEqual(safe_stem("天台上的告别"), "天台上的告别")
        self.assertNotIn("/", safe_stem("a/b:c?"))
        self.assertTrue(safe_stem("???").startswith("script"))

    def test_write_and_prune(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            first = write_script_file(
                directory, DOC, when=datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
            )
            self.assertTrue(first.is_file())
            self.assertTrue(first.name.startswith("测试剧本-20260101-120000"))
            self.assertEqual(
                json.loads(first.read_text(encoding="utf-8"))["title"], "测试剧本"
            )

            for index, name in enumerate(["old.json", "middle.json", "new.json"]):
                path = directory / name
                path.write_text("{}", encoding="utf-8")
                os.utime(path, (1000 + index, 1000 + index))
            deleted = prune_scripts(directory, keep=2)
            self.assertGreaterEqual(deleted, 1)
            self.assertTrue((directory / "new.json").exists())
            self.assertFalse((directory / "old.json").exists())

    def test_script_path_uses_timestamp(self) -> None:
        path = script_path(
            "x", "标题", when=datetime(2026, 2, 3, 4, 5, 6, 789000, tzinfo=timezone.utc)
        )
        self.assertEqual(path.name, "标题-20260203-040506-789.json")


if __name__ == "__main__":
    unittest.main()
