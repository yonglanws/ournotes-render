"""AstrBot plugin: generate an Our Notes director script from a scene description.

The plugin is a thin client for the ournotes-render host's ``POST /api/v1/script/generate`` endpoint. It sends a
readable preview and the complete ``ournotes.story-script/1`` JSON as a file, so the script can be fed back to
``POST /api/v1/render`` or written to a site with ``host/tools/site-story.mjs``.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

try:
    from astrbot.api.star import StarTools
except ImportError:  # very old AstrBot releases
    StarTools = None  # type: ignore[assignment]

try:
    from astrbot.api import AstrBotConfig
except ImportError:  # older AstrBot releases type the config as a plain mapping
    try:
        from astrbot.core import AstrBotConfig  # type: ignore[attr-defined]
    except ImportError:
        AstrBotConfig = dict  # type: ignore[misc,assignment]

from astrbot.core.star.filter.command import GreedyStr

from .core.client import HostError, OurnotesClient
from .core.format import format_script, format_warnings
from .core.storage import prune_scripts, write_script_file

PLUGIN_NAME = "astrbot_plugin_ournotes_script"
DEFAULT_API_BASE = "http://127.0.0.1:9881"


def _data_dir() -> Path:
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path

        return Path(get_astrbot_data_path()) / "plugin_data" / PLUGIN_NAME
    except Exception:  # noqa: BLE001 - older AstrBot layouts
        if StarTools is not None:
            try:
                return Path(StarTools.get_data_dir(PLUGIN_NAME))
            except Exception:  # noqa: BLE001, S110 - direct invocation outside AstrBot
                pass
        return Path(__file__).resolve().parent / "data"


class OurnotesScriptPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None) -> None:
        super().__init__(context)
        self.config = config or {}
        self.api_base = self._str("api_base", DEFAULT_API_BASE)
        self.api_key = self._str("api_key", "")
        self.language = self._language()
        self.base_story = self._str("base_story", "")
        self.target_minutes = self._float("target_minutes", 2.0, 0.5, 10.0)
        self.max_lines = self._int("max_lines", 40, 6, 200)
        self.timeout_seconds = self._int("timeout_seconds", 300, 30, 900)
        self.max_prompt_chars = self._int("max_prompt_chars", 500, 20, 2000)
        self.preview_lines = self._int("preview_lines", 20, 0, 100)
        self.max_text_chars = self._int("max_text_chars", 1800, 200, 6000)
        self.send_json_file = self._bool("send_json_file", True)
        self.include_directions = self._bool("include_directions", True)
        self.max_files = self._int("max_files", 50, 1, 500)
        self.scripts_dir = _data_dir() / "scripts"

        self.config_error = ""
        self.client: OurnotesClient | None
        try:
            self.client = OurnotesClient(
                self.api_base,
                api_key=self.api_key,
                timeout=self.timeout_seconds,
            )
        except HostError as exc:
            self.client = None
            self.config_error = str(exc)

    # -- configuration helpers -------------------------------------------------------------------------------------
    def _get(self, key: str, default: Any) -> Any:
        try:
            value = self.config.get(key, default)  # type: ignore[union-attr]
        except AttributeError:
            value = getattr(self.config, key, default)
        return default if value is None else value

    def _str(self, key: str, default: str) -> str:
        return str(self._get(key, default) or "").strip()

    def _bool(self, key: str, default: bool) -> bool:
        value = self._get(key, default)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _int(self, key: str, default: int, low: int, high: int) -> int:
        try:
            value = int(self._get(key, default))
        except (TypeError, ValueError):
            value = default
        return max(low, min(high, value))

    def _float(self, key: str, default: float, low: float, high: float) -> float:
        try:
            value = float(self._get(key, default))
        except (TypeError, ValueError):
            value = default
        return max(low, min(high, value))

    def _language(self) -> str:
        value = self._str("language", "zh-Hans")
        return "" if value.lower() in {"", "auto", "自动"} else value

    # -- lifecycle -------------------------------------------------------------------------------------------------
    async def initialize(self) -> None:
        self.scripts_dir.mkdir(parents=True, exist_ok=True)
        prune_scripts(self.scripts_dir, self.max_files)
        if self.client is None:
            logger.warning("[ournotes] %s", self.config_error)
        else:
            logger.info("[ournotes] script plugin ready: %s", self.api_base)

    async def terminate(self) -> None:
        if self.client is not None:
            await self.client.close()

    # -- command ---------------------------------------------------------------------------------------------------
    def _usage(self) -> str:
        return (
            "用法：/剧本生成 <场景描述>\n"
            "例：/剧本生成 放学后的教室里，灯和爽世聊起下次 Live\n\n"
            f"当前：语言 {self.language or '跟随站点'} · 目标 {self.target_minutes:g} 分钟 · "
            f"最多 {self.max_lines} 句"
        )

    @filter.command("剧本生成", alias=["写剧本", "storygen"])
    async def generate_story(self, event: AstrMessageEvent, prompt: GreedyStr):
        """根据场景描述生成 Our Notes 导演剧本，发送可读预览和 JSON 附件。"""
        event.stop_event()
        text = str(prompt).strip()
        if not text:
            yield event.plain_result(self._usage())
            return
        if len(text) > self.max_prompt_chars:
            yield event.plain_result(
                f"场景描述太长（{len(text)} 字），请控制在 {self.max_prompt_chars} 字以内。"
            )
            return
        if self.client is None:
            yield event.plain_result(f"插件配置有误：{self.config_error}")
            return

        logger.info(
            "[ournotes] script request from %s (%s chars)",
            event.get_sender_name(),
            len(text),
        )
        try:
            await event.send(
                event.plain_result(
                    f"正在生成剧本（目标 {self.target_minutes:g} 分钟 / 最多 {self.max_lines} 句），"
                    "通常需要 1~3 分钟…"
                )
            )
        except Exception:  # noqa: BLE001 - a status message must not abort the generation
            logger.exception("[ournotes] failed to send the status message")

        try:
            data = await self.client.generate_script(
                text,
                language=self.language,
                base=self.base_story,
                target_minutes=self.target_minutes,
                max_lines=self.max_lines,
            )
        except asyncio.CancelledError:
            raise
        except HostError as exc:
            logger.warning("[ournotes] script generation failed: %s", exc)
            await self._send_text(event, f"剧本生成失败：{exc}")
            return
        except Exception as exc:  # noqa: BLE001 - a command must answer with its error
            logger.exception("[ournotes] unexpected script generation failure")
            await self._send_text(event, f"剧本生成失败：{exc}")
            return

        document = data["script"]
        preview = format_script(
            document,
            include_directions=self.include_directions,
            preview_lines=self.preview_lines,
            max_chars=self.max_text_chars,
        )
        warning_text = format_warnings(data.get("warnings"))
        if warning_text:
            preview += "\n\n" + warning_text

        title = str(document.get("title") or "未命名剧本")
        logger.info("[ournotes] script ready: %s", title)
        if not self.send_json_file:
            await self._send_text(event, preview)
            return

        path: Path | None = None
        try:
            path = write_script_file(self.scripts_dir, document, title=title)
            prune_scripts(self.scripts_dir, self.max_files)
            chain = [Comp.Plain(preview), Comp.File(name=path.name, file=str(path))]
            await event.send(event.chain_result(chain))
            return
        except Exception:  # noqa: BLE001 - attachments are optional on some platforms
            logger.exception("[ournotes] failed to send the script attachment")
            suffix = f"\n\n（附件发送失败；JSON 已保存在 {path}）" if path else ""
            await self._send_text(event, preview + suffix)

    @staticmethod
    async def _send_text(event: AstrMessageEvent, text: str) -> None:
        try:
            await event.send(event.plain_result(text))
        except Exception:  # noqa: BLE001 - never raise from the final reply path
            logger.exception("[ournotes] failed to send a text reply")
