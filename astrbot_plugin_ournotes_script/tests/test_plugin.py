from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer

PLUGIN_DIR = Path(__file__).resolve().parents[1]
_DATA_DIR = Path.home() / ".cache" / "ournotes-plugin-test"


def _install_astrbot_stubs() -> None:
    astrbot = types.ModuleType("astrbot")
    astrbot.__path__ = []  # type: ignore[attr-defined]
    api = types.ModuleType("astrbot.api")
    api.__path__ = []  # type: ignore[attr-defined]
    api.logger = __import__("logging").getLogger("ournotes-test")
    api.AstrBotConfig = dict
    api.message_components = types.ModuleType("astrbot.api.message_components")

    class Plain:
        def __init__(self, text: str) -> None:
            self.text = text

    class File:
        def __init__(self, name: str, file: str = "", url: str = "") -> None:
            self.name = name
            self.file = file
            self.url = url

    api.message_components.Plain = Plain  # type: ignore[attr-defined]
    api.message_components.File = File  # type: ignore[attr-defined]

    event = types.ModuleType("astrbot.api.event")

    class AstrMessageEvent:
        pass

    class _Filter:
        def command(self, name: str, alias: list[str] | None = None, **_: Any):
            def decorator(fn):
                fn.command_name = name
                fn.command_alias = alias or []
                return fn

            return decorator

    event.AstrMessageEvent = AstrMessageEvent
    event.filter = _Filter()

    star = types.ModuleType("astrbot.api.star")

    class Context:
        pass

    class Star:
        def __init__(self, context: Context) -> None:
            self.context = context

    class StarTools:
        @staticmethod
        def get_data_dir(plugin_name: str = "") -> Path:
            return _DATA_DIR / plugin_name

    star.Context = Context
    star.Star = Star
    star.StarTools = StarTools

    core = types.ModuleType("astrbot.core")
    core.__path__ = []  # type: ignore[attr-defined]
    star_pkg = types.ModuleType("astrbot.core.star")
    star_pkg.__path__ = []  # type: ignore[attr-defined]
    filter_pkg = types.ModuleType("astrbot.core.star.filter")
    filter_pkg.__path__ = []  # type: ignore[attr-defined]
    command = types.ModuleType("astrbot.core.star.filter.command")

    class GreedyStr(str):
        pass

    command.GreedyStr = GreedyStr

    sys.modules.update(
        {
            "astrbot": astrbot,
            "astrbot.api": api,
            "astrbot.api.event": event,
            "astrbot.api.message_components": api.message_components,
            "astrbot.api.star": star,
            "astrbot.core": core,
            "astrbot.core.star": star_pkg,
            "astrbot.core.star.filter": filter_pkg,
            "astrbot.core.star.filter.command": command,
        }
    )


_install_astrbot_stubs()

_PACKAGE = "ournotes_plugin_under_test"
_package = types.ModuleType(_PACKAGE)
_package.__path__ = [str(PLUGIN_DIR)]  # type: ignore[attr-defined]
sys.modules[_PACKAGE] = _package
main = importlib.import_module(f"{_PACKAGE}.main")

DOC = {
    "format": "ournotes.story-script/1",
    "title": "测试场景",
    "cast": {"a": {"model": "m", "name": "高松灯"}},
    "beats": [
        {"scene": "stage", "location": "教室"},
        {"say": "a", "text": "你好", "motion": "mtn_nod01"},
    ],
}


class FakeEvent:
    def __init__(self, text: str = "") -> None:
        self.text = text
        self.sent: list[Any] = []
        self.stopped = False

    def stop_event(self) -> None:
        self.stopped = True

    def plain_result(self, text: str) -> tuple[str, str]:
        return ("plain", text)

    def chain_result(self, chain: list[Any]) -> tuple[str, list[Any]]:
        return ("chain", chain)

    async def send(self, result: Any) -> None:
        self.sent.append(result)

    def get_sender_name(self) -> str:
        return "tester"


class PluginTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        async def handler(request: web.Request) -> web.Response:
            payload = await request.json()
            if payload.get("prompt") == "失败":
                return web.json_response(
                    {"success": False, "message": "site missing"}, status=503
                )
            return web.json_response(
                {"ok": True, "script": DOC, "warnings": [{"message": "测试警告"}]}
            )

        app = web.Application()
        app.router.add_post("/api/v1/script/generate", handler)
        self.server = TestServer(app)
        await self.server.start_server()
        self.base = str(self.server.make_url("")).rstrip("/")
        self.config = {
            "api_base": self.base,
            "language": "zh-Hans",
            "target_minutes": 2,
            "max_lines": 20,
            "timeout_seconds": 30,
            "preview_lines": 5,
        }
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.plugin = main.OurnotesScriptPlugin(
            context=types.SimpleNamespace(), config=self.config
        )
        await self.plugin.initialize()

    async def asyncTearDown(self) -> None:
        await self.plugin.terminate()
        await self.server.close()

    async def test_command_sends_preview_and_json_file(self) -> None:
        event = FakeEvent()
        results = [
            result async for result in self.plugin.generate_story(event, "放学后的教室")
        ]
        self.assertTrue(event.stopped)
        self.assertEqual(
            results, [], "the long path sends through event.send instead of yielding"
        )
        self.assertEqual(len(event.sent), 2)
        self.assertEqual(event.sent[0][0], "plain")
        self.assertIn("正在生成剧本", event.sent[0][1])

    async def test_send_path_uses_a_file(self) -> None:
        event = FakeEvent()
        async for _ in self.plugin.generate_story(event, "放学后的教室"):
            pass
        self.assertEqual(len(event.sent), 2)
        kind, chain = event.sent[1]
        self.assertEqual(kind, "chain")
        self.assertIsInstance(
            chain[0], sys.modules["astrbot.api.message_components"].Plain
        )
        file_component = chain[1]
        self.assertIsInstance(
            file_component, sys.modules["astrbot.api.message_components"].File
        )
        self.assertTrue(Path(file_component.file).is_file())
        self.assertIn("《测试场景》", chain[0].text)
        self.assertIn("测试警告", chain[0].text)

    async def test_host_error_is_reported(self) -> None:
        event = FakeEvent()
        results = [result async for result in self.plugin.generate_story(event, "失败")]
        self.assertEqual(results, [])
        self.assertEqual(len(event.sent), 2)
        self.assertEqual(event.sent[1][0], "plain")
        self.assertIn("剧本生成失败", event.sent[1][1])
        self.assertIn("paths.site", event.sent[1][1])

    async def test_empty_prompt_returns_usage(self) -> None:
        event = FakeEvent()
        results = [result async for result in self.plugin.generate_story(event, "  ")]
        self.assertEqual(len(results), 1)
        self.assertIn("用法", results[0][1])
        self.assertFalse(event.sent)

    async def test_text_only_mode(self) -> None:
        self.plugin.send_json_file = False
        event = FakeEvent()
        results = [
            result async for result in self.plugin.generate_story(event, "放学后的教室")
        ]
        self.assertEqual(results, [])
        self.assertEqual(len(event.sent), 2)
        self.assertEqual(event.sent[1][0], "plain")
        self.assertIn("《测试场景》", event.sent[1][1])


if __name__ == "__main__":
    unittest.main()
