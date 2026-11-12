from __future__ import annotations

import importlib
import json
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
    components = types.ModuleType("astrbot.api.message_components")

    class Plain:
        def __init__(self, text: str) -> None:
            self.text = text

    class At:
        def __init__(self, qq: Any = "") -> None:
            self.qq = qq

    class Video:
        def __init__(self, file: str = "") -> None:
            self.file = file
            self.path = ""
            self.url = ""

        @classmethod
        def fromFileSystem(cls, path: str, **_: Any) -> Video:
            video = cls(str(path))
            video.path = str(path)
            return video

        @classmethod
        def fromURL(cls, url: str, **_: Any) -> Video:
            video = cls()
            video.url = str(url)
            return video

        async def register_to_file_service(self) -> str:
            return "http://file-service.local/api/file/token"

    components.Plain = Plain  # type: ignore[attr-defined]
    components.At = At  # type: ignore[attr-defined]
    components.Video = Video  # type: ignore[attr-defined]

    event = types.ModuleType("astrbot.api.event")

    class AstrMessageEvent:
        pass

    class MessageChain:
        def __init__(self, chain: list[Any] | None = None) -> None:
            self.chain = chain or []

    class _CommandGroup:
        def __init__(self, name: str) -> None:
            self.name = name

        def command(self, name: str, alias: set[str] | None = None, **_: Any):
            def decorator(fn):
                fn.command_name = name
                fn.command_alias = alias or set()
                return fn

            return decorator

    class _Filter:
        class PermissionType:
            ADMIN = "admin"

        def command(self, name: str, alias: set[str] | None = None, **_: Any):
            def decorator(fn):
                fn.command_name = name
                fn.command_alias = alias or set()
                return fn

            return decorator

        def command_group(self, name: str, **_: Any):
            def decorator(fn):
                fn.group_name = name
                return _CommandGroup(name)

            return decorator

        def permission_type(self, _kind: Any):
            def decorator(fn):
                return fn

            return decorator

    event.AstrMessageEvent = AstrMessageEvent
    event.MessageChain = MessageChain
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
            "astrbot.api.message_components": components,
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

VIDEO_BYTES = b"fake-mp4-bytes"

SCRIPT = {
    "format": "ournotes.story-script/1",
    "base": "stories/1.json",
    "language": "zh-Hans",
    "title": "测试视频",
    "cast": {
        "a": {"model": "m_a", "name": "灯"},
        "b": {"model": "m_b", "name": "爽世"},
    },
    "beats": [
        {"scene": "stage_a", "location": "教室", "positions": {"a": "left", "b": "right"}},
        {"say": "a", "text": "今天也一起练习吧。"},
        {"say": "b", "text": "嗯。"},
        {"narrate": "窗外的雨声很轻。"},
    ],
}


class FakeContext:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Any]] = []

    async def send_message(self, origin: str, chain: Any) -> None:
        self.sent.append((origin, chain))

    def texts(self) -> list[str]:
        out = []
        for _origin, chain in self.sent:
            for part in getattr(chain, "chain", []):
                if hasattr(part, "text"):
                    out.append(part.text)
        return out


class FakeEvent:
    def __init__(self, text: str = "", message_id: str = "") -> None:
        self.text = text
        self.message_id = message_id
        self.unified_msg_origin = "test:group:100"
        self.group_id = "100"

    def plain_result(self, text: str) -> tuple[str, str]:
        return ("plain", text)

    def get_sender_id(self) -> str:
        return "42"

    def get_sender_name(self) -> str:
        return "tester"


class PluginTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.polls = 0
        self.script_payloads: list[dict[str, Any]] = []
        self.render_payloads: list[dict[str, Any]] = []
        self.fail_render = False
        self.task_views: list[dict[str, Any]] | None = None

        async def health(_: web.Request) -> web.Response:
            return web.json_response(
                {
                    "success": True,
                    "site": {"configured": True, "kind": "site-format", "dir": "/site"},
                    "llm": {"configured": True, "model": "mock"},
                    "queue": {"running": 0, "waiting": 0, "concurrency": 2},
                    "tts": {"enabled": True, "provider": "irodori", "voices": 3},
                    "config": {"errors": 0, "warnings": 0},
                }
            )

        async def generate_script(request: web.Request) -> web.Response:
            payload = await request.json()
            self.script_payloads.append(payload)
            if payload.get("prompt") == "坏剧本":
                return web.json_response(
                    {
                        "success": False,
                        "message": "the script has errors",
                        "details": [{"path": "/beats", "message": "the script has only 1 line"}],
                    },
                    status=422,
                )
            return web.json_response(
                {"ok": True, "script": SCRIPT, "warnings": [], "stages": [], "usage": None}
            )

        async def render(request: web.Request) -> web.Response:
            payload = await request.json()
            self.render_payloads.append(payload)
            return web.json_response(
                {
                    "success": True,
                    "taskId": "task-render-1",
                    "status": "queued",
                    "statusUrl": "/api/v1/tasks/task-render-1",
                },
                status=202,
            )

        async def task(request: web.Request) -> web.Response:
            task_id = request.match_info["task_id"]
            if self.fail_render:
                return web.json_response(
                    {
                        "success": True,
                        "taskId": task_id,
                        "status": "failed",
                        "error": {"code": "job_failed", "message": "渲染失败"},
                    }
                )
            self.polls += 1
            if self.task_views and self.polls <= len(self.task_views):
                return web.json_response(
                    {"success": True, "taskId": task_id, **self.task_views[self.polls - 1]}
                )
            if self.task_views:
                return web.json_response(
                    {
                        "success": True,
                        "taskId": task_id,
                        "status": "completed",
                        "phase": "completed",
                        "progress": 1,
                        "result": {"success": True, "downloadUrl": "/api/v1/download/render.mp4",
                                   "duration": 12.3, "warnings": []},
                    }
                )
            if self.polls == 1:
                return web.json_response(
                    {
                        "success": True,
                        "taskId": task_id,
                        "status": "running",
                        "phase": "synthesizing",
                        "progress": 0.5,
                    }
                )
            return web.json_response(
                {
                    "success": True,
                    "taskId": task_id,
                    "status": "completed",
                    "phase": "completed",
                    "progress": 1,
                    "result": {
                        "success": True,
                        "downloadUrl": "/api/v1/download/render.mp4",
                        "duration": 12.3,
                        "warnings": [{"message": "测试警告"}],
                    },
                }
            )

        async def cancel(request: web.Request) -> web.Response:
            return web.json_response(
                {"taskId": request.match_info["task_id"], "cancelled": True}
            )

        async def download(_: web.Request) -> web.Response:
            return web.Response(body=VIDEO_BYTES, content_type="video/mp4")

        async def status(_: web.Request) -> web.Response:
            return web.json_response(
                {"success": True, "queue": {"running": 0, "waiting": 0}, "tasks": []}
            )

        async def resources(_: web.Request) -> web.Response:
            return web.json_response(
                {
                    "success": True,
                    "models": [{"id": "m_a", "name": "灯"}],
                    "bases": [{"id": "1", "title": "底本一", "manifest": "stories/1.json"}],
                    "stages": [{"id": "stage_a", "caption": "教室"}],
                    "music": [{"cue": "bgm_a", "label": "Quiet"}],
                    "voices": ["灯"],
                }
            )

        async def cleanup(_: web.Request) -> web.Response:
            return web.json_response({"success": True, "removed": 2, "freedBytes": 10})

        app = web.Application()
        app.router.add_get("/api/v1/health", health)
        app.router.add_post("/api/v1/script/generate", generate_script)
        app.router.add_post("/api/v1/render", render)
        app.router.add_get("/api/v1/tasks/{task_id}", task)
        app.router.add_post("/api/v1/tasks/{task_id}/cancel", cancel)
        app.router.add_get("/api/v1/download/render.mp4", download)
        app.router.add_get("/api/v1/status", status)
        app.router.add_get("/api/v1/resources", resources)
        app.router.add_post("/api/v1/cleanup", cleanup)
        self.server = TestServer(app)
        await self.server.start_server()
        self.base = str(self.server.make_url("")).rstrip("/")
        self.context = FakeContext()
        self.config = {
            "api_base": self.base,
            "language": "zh-Hans",
            "target_minutes": 2,
            "max_lines": 20,
            "script_timeout": 60,
            "export_timeout": 60,
            "poll_interval_seconds": 0.5,
            "max_video_files": 5,
        }
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        for name in ("export_stats.json", "chat_history.json"):
            (main._data_dir(self.context) / name).unlink(missing_ok=True)
        self.plugin = main.OurnotesVideoPlugin(context=self.context, config=self.config)
        await self.plugin.initialize()

    async def asyncTearDown(self) -> None:
        await self.plugin.terminate()
        await self.server.close()

    async def test_story_command_generates_and_sends_the_video(self) -> None:
        event = FakeEvent(message_id="msg-1")
        results = [
            result async for result in self.plugin.story_cmd(event, "放学后的教室")
        ]
        self.assertEqual(len(results), 1)
        self.assertIn("视频生成中", results[0][1])
        self.assertEqual(len(self.plugin._inflight), 1)
        task = next(iter(self.plugin._inflight.values()))["task"]
        await task

        self.assertEqual(self.script_payloads[0]["mode"], "story")
        self.assertEqual(self.script_payloads[0]["prompt"], "放学后的教室")
        self.assertEqual(self.script_payloads[0]["targetMinutes"], 2.0)
        self.assertEqual(self.script_payloads[0]["maxLines"], 20)
        self.assertTrue(self.render_payloads[0]["wait"] is False)
        self.assertTrue(self.render_payloads[0]["tts"] is True)
        self.assertEqual(self.render_payloads[0]["script"]["title"], "测试视频")

        texts = self.context.texts()
        self.assertTrue(any("剧本已生成，正在渲染视频…" in text for text in texts))
        self.assertFalse(any("渲染中：" in text for text in texts))
        chain = self.context.sent[-1][1].chain
        self.assertEqual(chain[0].__class__.__name__, "Plain")
        self.assertIn("《测试视频》生成完成", chain[0].text)
        self.assertIn("3 句 · 12.3 秒", chain[0].text)
        self.assertIn("测试警告", chain[0].text)
        video = chain[1]
        self.assertEqual(video.__class__.__name__, "Video")
        self.assertTrue(Path(video.path).is_file())
        self.assertEqual(Path(video.path).read_bytes(), VIDEO_BYTES)

    async def test_render_polls_silently_and_sends_only_two_progress_messages(self) -> None:
        self.task_views = [
            {"status": "running", "phase": "synthesizing", "progress": 0.3,
             "message": "TTS 1/4", "elapsedSeconds": 2},
            {"status": "running", "phase": "rendering", "progress": 0.62,
             "message": "渲染剧情帧 60 帧，2.0 秒剧情", "elapsedSeconds": 10},
            {"status": "running", "phase": "rendering", "progress": 0.62,
             "message": "渲染剧情帧 120 帧，4.0 秒剧情", "elapsedSeconds": 20},
        ]
        await self.plugin._run(
            "req-silent", {"origin": "test:group:100", "session_key": "test:group:100",
                           "user_id": "42", "group_id": "100"},
            "静默轮询", "story",
        )

        texts = self.context.texts()
        self.assertEqual(len([text for text in texts if "剧本已生成，正在渲染视频…" in text]), 1)
        self.assertFalse(any("渲染中：" in text for text in texts), texts)
        self.assertFalse(any("TTS 1/4" in text or "渲染剧情帧 120 帧" in text for text in texts), texts)

    async def test_chat_mode_passes_history_and_records_it(self) -> None:
        context = {"origin": "test:group:100", "session_key": "test:group:100",
                   "user_id": "42", "group_id": "100"}
        await self.plugin._run("req-chat-1", context, "今天好累", "chat")
        self.assertNotIn("history", self.script_payloads[0])
        self.assertEqual(self.script_payloads[0]["mode"], "chat")
        self.assertEqual(len(self.plugin.chat_history["test:group:100"]), 2)
        self.assertEqual(self.plugin.chat_history["test:group:100"][0]["content"], "今天好累")

        self.polls = 0
        await self.plugin._run("req-chat-2", context, "那休息一下吧", "chat")
        history = self.script_payloads[1].get("history") or []
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["content"], "今天好累")
        self.assertIn("今天也一起练习吧", history[1]["content"])

    async def test_a_failed_render_is_reported(self) -> None:
        self.fail_render = True
        context = {"origin": "test:group:100", "session_key": "test", "user_id": "42",
                   "group_id": "100"}
        await self.plugin._run("req-fail", context, "场景", "story")
        texts = self.context.texts()
        self.assertTrue(any("渲染失败" in text for text in texts))
        self.assertEqual(self.plugin.stats["total_failed"], 1)

    async def test_empty_prompt_returns_usage(self) -> None:
        event = FakeEvent()
        results = [result async for result in self.plugin.story_cmd(event, "  ")]
        self.assertEqual(len(results), 1)
        self.assertIn("用法", results[0][1])
        self.assertFalse(self.script_payloads)

    async def test_a_bad_script_is_reported_with_details(self) -> None:
        context = {"origin": "test:group:100", "session_key": "test", "user_id": "42",
                   "group_id": "100"}
        await self.plugin._run("req-bad", context, "坏剧本", "story")
        text = "\n".join(self.context.texts())
        self.assertIn("剧本生成失败", text)
        self.assertIn("the script has only 1 line", text)

    async def test_admin_status_resources_and_cleanup(self) -> None:
        status = [item async for item in self.plugin.status_cmd(FakeEvent())]
        self.assertIn("ournotes-render 对接状态", status[0][1])
        self.assertIn("下载站点", status[0][1])
        resources = [item async for item in self.plugin.resources_cmd(FakeEvent())]
        self.assertIn("角色 1", resources[0][1])
        self.assertIn("底本一", resources[0][1])
        cleaned = [item async for item in self.plugin.cleanup_cmd(FakeEvent())]
        self.assertIn("宿主清理 2 个", cleaned[0][1])


if __name__ == "__main__":
    unittest.main()
