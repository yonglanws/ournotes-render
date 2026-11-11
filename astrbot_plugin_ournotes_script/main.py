"""AstrBot 插件：把聊天指令对接到 ournotes-render 宿主。

插件是纯对接端：它不生成提示词、不调 LLM、不校验剧本、不做 TTS。
所有生成能力都在宿主内置 AI harness 中，插件只负责：

1. 接收 ``/剧本生成`` / ``/视频对话``；
2. 调宿主 ``POST /api/v1/script/generate`` 拿剧本；
3. 调宿主 ``POST /api/v1/render``（``wait: false``）排队渲染并轮询进度；
4. 下载并按多种策略回传到会话；
5. 保存会话级聊天历史、统计与产物清理。
"""

from __future__ import annotations

import asyncio
import socket
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlparse, urlunparse

import astrbot.api.message_components as Comp
from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star

try:
    from astrbot.api import AstrBotConfig
except ImportError:  # older AstrBot releases type the config as a plain mapping
    try:
        from astrbot.core import AstrBotConfig  # type: ignore[attr-defined]
    except ImportError:
        AstrBotConfig = dict  # type: ignore[misc,assignment]

try:
    from astrbot.core.star.filter.command import GreedyStr
except ImportError:  # 旧版 AstrBot 没有 GreedyStr，退回普通字符串参数

    class GreedyStr(str):  # type: ignore[no-redef]
        """兼容占位：旧版 AstrBot 会把整段消息作为字符串传入。"""

from .core.client import HostError, OurnotesClient, normalize_base_url
from .core.format import count_dialogue, format_warnings
from .core.storage import (
    JsonState,
    prune_files,
    prune_old_files,
    safe_stem,
    write_json_file,
)

PLUGIN_NAME = "astrbot_plugin_ournotes_script"
DEFAULT_API_BASE = "http://127.0.0.1:9881"
DEFAULT_TARGET_MINUTES = 0.0

CLEANUP_INTERVAL_SECONDS = 1800
FILE_RETENTION_SECONDS = 2 * 60 * 60

PHASES = {
    "queued": "排队",
    "starting": "启动",
    "casting": "选角",
    "dialogue": "写台词",
    "storyboard": "写分镜",
    "writing": "写剧本",
    "planning": "分镜计划",
    "validating": "校验剧本",
    "synthesizing": "配音",
    "compiling": "编译剧情",
    "rendering": "渲染画面",
    "mixing": "混合音频",
    "encoding": "编码视频",
    "writing_output": "写入结果",
    "completed": "完成",
    "failed": "失败",
    "cancelled": "已取消",
}


def _cfg(config: Any, key: str, default: Any) -> Any:
    try:
        value = config.get(key, default)
    except AttributeError:
        value = getattr(config, key, default)
    return default if value is None else value


def _cfg_str(config: Any, key: str, default: str = "") -> str:
    return str(_cfg(config, key, default) or "").strip()


def _cfg_int(config: Any, key: str, default: int, low: int, high: int) -> int:
    try:
        value = int(_cfg(config, key, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def _cfg_float(config: Any, key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(_cfg(config, key, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def _cfg_bool(config: Any, key: str, default: bool) -> bool:
    value = _cfg(config, key, default)
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(value)


def _data_dir(context: Context) -> Path:
    """优先使用 AstrBot 的持久化数据目录，插件更新不会清掉历史与统计。"""
    try:
        if hasattr(context, "get_data_dir"):
            return Path(context.get_data_dir()) / PLUGIN_NAME
        if hasattr(context, "data_dir"):
            return Path(context.data_dir) / PLUGIN_NAME
    except Exception:  # noqa: BLE001 - 不同 AstrBot 版本目录接口不一致
        pass
    try:
        from astrbot.api.star import StarTools

        return Path(StarTools.get_data_dir(PLUGIN_NAME))
    except Exception:  # noqa: BLE001 - 直接运行插件时没有 AstrBot 环境
        return Path(__file__).resolve().parent / "data"


def _phase_label(phase: Any) -> str:
    value = str(phase or "").strip()
    return PHASES.get(value, value or "生成中")


def _safe_task_id(task_id: Any) -> str:
    value = "".join(
        char if char.isalnum() or char in "._-" else "-" for char in str(task_id or "")
    ).strip("-")
    return value[:80] or "task"


class OurnotesVideoPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

        # ---- 宿主连接 -------------------------------------------------------------------------------
        self.config_error = ""
        try:
            self.api_base = normalize_base_url(_cfg_str(config, "api_base", DEFAULT_API_BASE))
        except HostError as exc:
            self.api_base = DEFAULT_API_BASE
            self.config_error = exc.message
        self.api_key = _cfg_str(config, "api_key", "")

        # ---- 生成参数：全部原样传给宿主，插件不做任何提示词处理 -------------------------------------
        self.language = self._language()
        self.base_story = _cfg_str(config, "base_story", "")
        self.target_minutes = _cfg_float(
            config, "target_minutes", DEFAULT_TARGET_MINUTES, 0.0, 10.0
        )
        self.max_lines = _cfg_int(config, "max_lines", 0, 0, 300)
        self.tts = _cfg_bool(config, "tts", True)
        self.script_timeout = _cfg_int(config, "script_timeout", 1200, 60, 3600)
        self.export_timeout = _cfg_int(config, "export_timeout", 1800, 60, 86_400)
        self.busy_retry_seconds = _cfg_float(config, "busy_retry_seconds", 15.0, 1.0, 120.0)
        pipeline = _cfg_str(config, "pipeline", "auto").lower()
        self.pipeline = pipeline if pipeline in {"single", "staged"} else ""
        self.max_prompt_chars = _cfg_int(config, "max_prompt_chars", 500, 20, 4000)

        # ---- 本地并发闸：宿主自己也会限流，这里只避免一台机器人瞬间打满请求 -------------------------
        self.max_concurrent_requests = _cfg_int(config, "max_concurrent_requests", 2, 1, 16)
        self.max_pending = _cfg_int(config, "max_pending", 20, 1, 200)
        self._slots = asyncio.Semaphore(self.max_concurrent_requests)
        self._waiting = 0
        self._inflight: dict[str, dict[str, Any]] = {}

        # ---- 轮询与进度 -----------------------------------------------------------------------------
        self.poll_interval = _cfg_float(config, "poll_interval_seconds", 3.0, 0.5, 30.0)
        self.progress_interval = _cfg_int(config, "progress_interval_seconds", 60, 0, 300)

        # ---- 会话历史与统计 -------------------------------------------------------------------------
        self.history_rounds = _cfg_int(config, "history_rounds", 3, 1, 20)
        self.session_timeout_minutes = _cfg_int(
            config, "session_timeout_minutes", 60, 5, 24 * 60
        )

        # ---- 产物目录 -------------------------------------------------------------------------------
        data_root = _data_dir(context)
        self.temp_dir = _cfg_str(config, "temp_dir", "")
        self.work_dir = (
            Path(self.temp_dir).expanduser().resolve() if self.temp_dir else data_root
        )
        self.video_dir = self.work_dir / "videos"
        self.story_dir = self.work_dir / "stories"
        self.chat_history_file = data_root / "chat_history.json"
        self.stats_file = data_root / "export_stats.json"

        self._history_state = JsonState(self.chat_history_file)
        self._stats_state = JsonState(self.stats_file)
        raw_history = self._history_state.load({})
        self.chat_history: dict[str, list[dict[str, Any]]] = (
            raw_history if isinstance(raw_history, dict) else {}
        )
        self.stats = self._load_stats()

        self.callback_api_base = _cfg_str(config, "callback_api_base", "").rstrip("/")
        self.max_video_mb = _cfg_int(config, "max_video_mb", 50, 1, 500)
        self.max_video_files = _cfg_int(config, "max_video_files", 20, 1, 200)

        # ---- 运行状态 -------------------------------------------------------------------------------
        self._seen_messages: dict[str, float] = {}
        self._message_dedup_ttl = 600
        self._cleanup_task: asyncio.Task | None = None
        self._closing = False

        self.client: OurnotesClient | None
        if self.config_error:
            self.client = None
        else:
            try:
                self.client = OurnotesClient(self.api_base, self.api_key)
            except HostError as exc:
                self.client = None
                self.config_error = exc.message

        logger.info(f"ournotes 对接端初始化：宿主 {self.api_base}")

    def _language(self) -> str:
        value = _cfg_str(self.config, "language", "zh-Hans")
        return "" if value.lower() in {"", "auto", "跟随站点"} else value

    # ------------------------------------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------------------------------------
    async def initialize(self) -> None:
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.story_dir.mkdir(parents=True, exist_ok=True)
        prune_files(self.video_dir, self.max_video_files, "*.mp4")
        prune_old_files(self.story_dir, FILE_RETENTION_SECONDS, "*.json")
        self._prune_sessions()
        self._cleanup_task = asyncio.create_task(
            self._cleanup_loop(), name="ournotes-cleanup"
        )
        if self.client is None:
            logger.warning(f"ournotes 配置有误：{self.config_error}")
        else:
            logger.info(f"ournotes 插件就绪：{self.api_base}")

    async def terminate(self) -> None:
        self._closing = True
        tasks = [
            entry["task"]
            for entry in self._inflight.values()
            if isinstance(entry.get("task"), asyncio.Task) and not entry["task"].done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.info(f"已取消 {len(tasks)} 条在途生成任务")
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
        self._save_history()
        self._stats_state.save(self.stats)
        if self.client is not None:
            await self.client.close()
        logger.info("ournotes 插件已关闭")

    async def _cleanup_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
                prune_old_files(self.video_dir, FILE_RETENTION_SECONDS, "*.mp4")
                prune_old_files(self.story_dir, FILE_RETENTION_SECONDS, "*.json")
                self._prune_sessions()
            except asyncio.CancelledError:
                break
            except Exception:  # noqa: BLE001 - 清理失败不能拖垮插件
                logger.exception("ournotes 清理任务异常")

    # ------------------------------------------------------------------------------------------------
    # 指令
    # ------------------------------------------------------------------------------------------------
    @filter.command(
        "视频对话",
        alias={"视频生成", "视频聊天", "测试视频对话", "测试视频生成", "测试视频聊天"},
    )
    async def chat_cmd(self, event: AstrMessageEvent, message: GreedyStr) -> AsyncIterator[Any]:
        """根据消息生成一段角色短视频回复。"""
        async for result in self._submit(event, str(message), "chat"):
            yield result

    @filter.command(
        "剧本生成",
        alias={
            "剧本对话",
            "故事生成",
            "story",
            "生成剧本",
            "生成故事",
            "写剧本",
            "storygen",
            "测试剧本生成",
            "测试故事生成",
            "测试story",
            "测试生成剧本",
        },
    )
    async def story_cmd(self, event: AstrMessageEvent, scene: GreedyStr) -> AsyncIterator[Any]:
        """根据场景生成完整剧本视频。"""
        async for result in self._submit(event, str(scene), "story"):
            yield result

    @filter.command("统计", alias={"stats", "统计信息", "导出统计"})
    async def stats_cmd(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        yield event.plain_result(self._stats_report())

    def _usage(self, mode: str) -> str:
        scope = (
            f"语言 {self.language or '跟随站点'} · 目标 {self.target_minutes:g} 分钟"
            if self.target_minutes
            else f"语言 {self.language or '跟随站点'} · 目标跟随宿主"
        )
        if mode == "chat":
            return (
                "用法：/视频对话 <消息>\n"
                "例：/视频对话 今天好累啊\n\n"
                f"当前：{scope} · 保留 {self.history_rounds} 轮历史"
            )
        lines = f"最多 {self.max_lines} 句" if self.max_lines else "句数跟随宿主"
        return (
            "用法：/剧本生成 <场景>\n"
            "例：/剧本生成 放学后的教室里，灯和爽世聊起下次 Live\n\n"
            f"当前：{scope} · {lines}"
        )

    async def _submit(
        self, event: AstrMessageEvent, text: str, mode: str
    ) -> AsyncIterator[Any]:
        prompt = (text or "").strip()
        if not prompt:
            yield event.plain_result(self._usage(mode))
            return
        if len(prompt) > self.max_prompt_chars:
            yield event.plain_result(
                f"描述太长（{len(prompt)} 字），请控制在 {self.max_prompt_chars} 字以内。"
            )
            return
        if self.client is None:
            yield event.plain_result(f"插件配置有误：{self.config_error}")
            return
        if not self._claim_message(event):
            return

        _health, problem = await self._preflight()
        if problem:
            yield event.plain_result(f"渲染宿主不可用：{problem}\n{self.api_base}")
            return
        if len(self._inflight) >= self.max_pending:
            yield event.plain_result(f"排队已满（{len(self._inflight)}），请稍后再试。")
            return

        request_id = uuid.uuid4().hex[:8]
        context = self._event_context(event)
        task = asyncio.create_task(
            self._run(request_id, context, prompt, mode), name=f"ournotes-{request_id}"
        )
        self._inflight[request_id] = {
            "task": task,
            "mode": mode,
            "prompt": prompt[:40],
            "started": time.time(),
            "render_task_id": "",
        }
        task.add_done_callback(lambda _task, rid=request_id: self._inflight.pop(rid, None))
        yield event.plain_result(
            f"视频生成中，生成时间较久，请耐心等待....\n任务 #{request_id}"
        )

    # ------------------------------------------------------------------------------------------------
    # 生成流水线：剧本（宿主）→ 渲染（宿主）→ 下载 → 投递
    # ------------------------------------------------------------------------------------------------
    async def _run(
        self, request_id: str, context: dict[str, str], prompt: str, mode: str
    ) -> None:
        started = time.time()
        acquired = False
        try:
            if self._slots.locked():
                self._waiting += 1
                try:
                    ahead = max(0, self._waiting - 1)
                    queue_note = f"前方 {ahead} 个任务" if ahead else "等待空位"
                    await self._send_safe(
                        context, f"已排队（{queue_note}），任务 #{request_id}"
                    )
                    await self._slots.acquire()
                finally:
                    self._waiting = max(0, self._waiting - 1)
            else:
                await self._slots.acquire()
            acquired = True

            history = self._history_for(context.get("session_key", "")) if mode == "chat" else None
            generated = await self._generate_with_busy_retry(
                request_id, context, prompt, mode, history
            )
            story = generated.get("script") or {}
            if not isinstance(story, dict) or not story:
                raise HostError("宿主没有返回可用剧本", status=502)
            self._save_story(request_id, story)
            if mode == "chat":
                self._record_chat(context.get("session_key", ""), prompt, story)

            title = str(story.get("title") or "").strip()
            dialogue = count_dialogue(story.get("beats") or [])
            headline = f"《{title}》" if title else "剧本"
            await self._send_safe(
                context,
                f"{headline}剧本已生成（{dialogue} 句），正在渲染视频…\n任务 #{request_id}",
            )

            result = await self._render_and_wait(request_id, context, story)
            download_url = str(result.get("downloadUrl") or "")
            local_path: Path | None = None
            if download_url:
                target = self.video_dir / f"video_{int(time.time())}_{request_id}.mp4"
                try:
                    local_path = await self.client.download(
                        download_url, target, timeout=float(self.export_timeout)
                    )
                except HostError as exc:
                    # 下载失败不致命：还有 URL / 文件服务两级回传
                    logger.warning(f"视频下载失败，改用 URL 投递: {exc.message}")
            else:
                logger.warning("宿主导出没有 downloadUrl，仅能依赖本地文件")

            caption = self._caption(request_id, story, result, local_path)
            full_url = self.client.absolute_url(download_url)
            await self._send_video(context, local_path, full_url, caption)
            self._record_export(True, time.time() - started)
            prune_files(self.video_dir, self.max_video_files, "*.mp4")

        except asyncio.CancelledError:
            await self._cancel_render(request_id)
            if not self._closing:
                self._record_export(False, time.time() - started, "任务已取消")
                await self._send_safe(context, f"任务 #{request_id} 已取消")
            raise
        except HostError as exc:
            logger.warning(f"任务 #{request_id} 失败: {exc.message}")
            self._record_export(False, time.time() - started, exc.message)
            await self._send_safe(context, self._format_host_error(exc, request_id))
        except Exception as exc:  # noqa: BLE001 - 后台任务必须给出可读反馈
            logger.exception(f"任务 #{request_id} 异常")
            self._record_export(False, time.time() - started, str(exc))
            await self._send_safe(context, f"生成失败：{exc}\n任务 #{request_id}")
        finally:
            if acquired:
                self._slots.release()

    async def _generate_with_busy_retry(
        self,
        request_id: str,
        context: dict[str, str],
        prompt: str,
        mode: str,
        history: list[dict[str, str]] | None,
    ) -> dict[str, Any]:
        """宿主或反向代理返回 429 时排队重试；其余错误直接上抛。"""
        assert self.client is not None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.script_timeout
        notified = False
        while True:
            try:
                return await self.client.generate_script(
                    prompt,
                    mode=mode,
                    history=history,
                    language=self.language,
                    base=self.base_story,
                    target_minutes=self.target_minutes or None,
                    max_lines=self.max_lines or None,
                    pipeline=self.pipeline,
                    timeout_seconds=float(self.script_timeout),
                )
            except HostError as exc:
                if exc.status != 429 or loop.time() >= deadline:
                    raise
                if not notified:
                    await self._send_safe(
                        context,
                        f"宿主生成并发已满，已排队等待空位…\n任务 #{request_id}",
                    )
                    notified = True
                wait = min(self.busy_retry_seconds, max(0.5, deadline - loop.time()))
                await asyncio.sleep(wait)

    async def _render_and_wait(
        self, request_id: str, context: dict[str, str], story: dict[str, Any]
    ) -> dict[str, Any]:
        assert self.client is not None
        queued = await self.client.render(
            story, tts=self.tts, wait=False, timeout_seconds=float(self.export_timeout)
        )
        render_task_id = str(queued.get("taskId") or "")
        entry = self._inflight.get(request_id)
        if entry is not None:
            entry["render_task_id"] = render_task_id

        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.export_timeout
        last_phase = ""
        last_update = loop.time()
        while True:
            if loop.time() >= deadline:
                await self._cancel_render(request_id)
                raise HostError(
                    f"渲染超时（{self.export_timeout} 秒），可以降低 max_lines 或调大 export_timeout。",
                    status=504,
                )
            await asyncio.sleep(self.poll_interval)
            try:
                view = await self.client.task(render_task_id)
            except HostError as exc:
                if exc.status is None or exc.status in {502, 503, 504}:
                    logger.warning(f"查询渲染任务失败，继续等待: {exc.message}")
                    continue
                raise

            status = str(view.get("status") or "")
            if status == "completed":
                result = view.get("result")
                if not isinstance(result, dict):
                    raise HostError("渲染任务完成但没有返回结果", status=502)
                return result
            if status in {"failed", "cancelled"}:
                error = view.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else error
                raise HostError(
                    f"渲染{('已取消' if status == 'cancelled' else '失败')}：{message or status}",
                    status=502,
                )
            if status in {"", "unknown"}:
                raise HostError("宿主找不到渲染任务（可能已过期）", status=502)

            phase = str(view.get("phase") or status)
            progress = view.get("progress")
            now = loop.time()
            due = self.progress_interval > 0 and now - last_update >= self.progress_interval
            if phase != last_phase or due:
                percent = (
                    f" {round(float(progress) * 100)}%" if progress is not None else ""
                )
                await self._send_safe(
                    context,
                    f"渲染中：{_phase_label(phase)}{percent}\n任务 #{request_id}",
                )
                last_phase = phase
                last_update = now

    async def _cancel_render(self, request_id: str) -> None:
        entry = self._inflight.get(request_id) or {}
        render_task_id = str(entry.get("render_task_id") or "")
        if not render_task_id or self.client is None:
            return
        try:
            await self.client.cancel(render_task_id)
        except Exception:  # noqa: BLE001 - 取消是尽力而为
            logger.warning(f"取消宿主渲染任务失败: {render_task_id}")

    # ------------------------------------------------------------------------------------------------
    # 宿主健康检查与错误提示
    # ------------------------------------------------------------------------------------------------
    async def _preflight(self) -> tuple[dict[str, Any] | None, str]:
        if self.client is None:
            return None, self.config_error or "插件未配置宿主地址"
        try:
            health = await self.client.health()
        except HostError as exc:
            return None, exc.message
        if health.get("success") is False:
            return health, str(health.get("message") or "健康检查未通过")
        site = health.get("site") or {}
        if isinstance(site, dict) and site.get("configured") is False:
            return health, "宿主未配置站点（paths.site / paths.siteFormat）"
        llm = health.get("llm") or {}
        if isinstance(llm, dict) and llm.get("configured") is False:
            return health, "宿主未配置内置 AI（llm.enabled=false / llm.model 为空）"
        return health, ""

    @staticmethod
    def _format_host_error(exc: HostError, request_id: str) -> str:
        status = exc.status
        if status == 429:
            head = "宿主生成并发已满，请稍后重试。"
        elif status == 422:
            head = f"剧本生成失败：{exc.message}"
            details = exc.details
            if isinstance(details, list) and details:
                shown = []
                for item in details[:3]:
                    if isinstance(item, dict):
                        shown.append(str(item.get("message") or item.get("code") or item))
                    else:
                        shown.append(str(item))
                head += "\n" + "；".join(shown)[:300]
        elif status == 504:
            head = "生成超时，请降低目标时长或调大 script_timeout / export_timeout。"
        elif status in {502, 503}:
            head = f"渲染宿主暂不可用：{exc.message}"
        elif status is None:
            head = f"无法连接渲染宿主：{exc.message}"
        else:
            head = f"生成失败：{exc.message}"
        return f"{head}\n任务 #{request_id}"

    # ------------------------------------------------------------------------------------------------
    # 会话历史
    # ------------------------------------------------------------------------------------------------
    def _history_for(self, session_key: str) -> list[dict[str, str]]:
        if not session_key:
            return []
        self._prune_sessions()
        items = self.chat_history.get(session_key) or []
        messages: list[dict[str, str]] = []
        for item in items[-(self.history_rounds * 2):]:
            if isinstance(item, dict) and str(item.get("content") or "").strip():
                messages.append(
                    {
                        "role": str(item.get("role") or "user"),
                        "content": str(item.get("content")),
                    }
                )
        return messages

    def _record_chat(self, session_key: str, prompt: str, story: dict[str, Any]) -> None:
        if not session_key:
            return
        cast = story.get("cast") or {}
        names = {
            str(key): str((value or {}).get("name") or key)
            if isinstance(value, dict)
            else str(value or key)
            for key, value in cast.items()
        } if isinstance(cast, dict) else {}
        speaker = ""
        lines: list[str] = []
        for beat in story.get("beats") or []:
            if not isinstance(beat, dict):
                continue
            if "say" in beat:
                text = str(beat.get("text") or "").strip()
                if text:
                    lines.append(text)
                if not speaker:
                    speaker = names.get(str(beat.get("say") or ""), "")
            elif "narrate" in beat:
                text = str(beat.get("narrate") or beat.get("text") or "").strip()
                if text:
                    lines.append(text)
        if not lines:
            return
        now = time.time()
        items = self.chat_history.setdefault(session_key, [])
        items.append({"role": "user", "content": prompt, "ts": now})
        items.append({"role": speaker or "角色", "content": "\n".join(lines), "ts": now})
        self.chat_history[session_key] = items[-(self.history_rounds * 4):]
        self._save_history()

    def _save_history(self) -> None:
        self._history_state.save(self.chat_history)

    def _prune_sessions(self) -> None:
        cutoff = time.time() - self.session_timeout_minutes * 60
        expired = [
            key
            for key, items in self.chat_history.items()
            if not isinstance(items, list)
            or not items
            or max(
                (
                    float(item.get("ts") or 0)
                    for item in items
                    if isinstance(item, dict)
                ),
                default=0,
            )
            < cutoff
        ]
        for key in expired:
            self.chat_history.pop(key, None)
        if expired:
            self._save_history()

    # ------------------------------------------------------------------------------------------------
    # 统计
    # ------------------------------------------------------------------------------------------------
    @staticmethod
    def _default_stats() -> dict[str, Any]:
        return {
            "total_exports": 0,
            "total_success": 0,
            "total_failed": 0,
            "total_time_seconds": 0,
            "last_export_time": 0,
            "last_error": "",
        }

    def _load_stats(self) -> dict[str, Any]:
        raw = self._stats_state.load({})
        stats = self._default_stats()
        if isinstance(raw, dict):
            for key, value in stats.items():
                if key in raw and isinstance(raw[key], type(value)):
                    stats[key] = raw[key]
        return stats

    def _record_export(self, success: bool, elapsed: float, error: str = "") -> None:
        stats = self.stats
        stats["total_exports"] = int(stats.get("total_exports", 0)) + 1
        if success:
            stats["total_success"] = int(stats.get("total_success", 0)) + 1
        else:
            stats["total_failed"] = int(stats.get("total_failed", 0)) + 1
            if error:
                stats["last_error"] = str(error)[:200]
        stats["total_time_seconds"] = int(stats.get("total_time_seconds", 0)) + max(
            0, int(elapsed)
        )
        stats["last_export_time"] = int(time.time())
        self._stats_state.save(stats)

    def _stats_report(self) -> str:
        stats = self.stats
        total = int(stats.get("total_exports", 0))
        success = int(stats.get("total_success", 0))
        failed = int(stats.get("total_failed", 0))
        lines = [f"生成统计：成功 {success} / 失败 {failed}（共 {total}）"]
        if total:
            rate = success * 100.0 / total
            minutes = int(stats.get("total_time_seconds", 0)) / 60.0
            lines.append(f"成功率 {rate:.0f}% · 累计耗时 {minutes:.1f} 分钟")
        last = int(stats.get("last_export_time", 0))
        if last:
            lines.append(
                f"最近一次：{time.strftime('%Y-%m-%d %H:%M', time.localtime(last))}"
            )
        last_error = str(stats.get("last_error") or "").strip()
        if last_error:
            lines.append(f"最近错误：{last_error}")
        return "\n".join(lines)

    # ------------------------------------------------------------------------------------------------
    # 消息发送
    # ------------------------------------------------------------------------------------------------
    def _claim_message(self, event: AstrMessageEvent) -> bool:
        message_id = str(getattr(event, "message_id", "") or "")
        if not message_id:
            return True
        now = time.time()
        seen = self._seen_messages
        last = seen.get(message_id)
        if last is not None and now - last < self._message_dedup_ttl:
            logger.warning(f"重复消息事件已忽略: {message_id}")
            return False
        seen[message_id] = now
        if len(seen) > 1024:
            for old in list(seen)[: len(seen) - 1024]:
                seen.pop(old, None)
        return True

    @staticmethod
    def _event_context(event: AstrMessageEvent) -> dict[str, str]:
        try:
            return {
                "origin": str(
                    getattr(event, "unified_msg_origin", "")
                    or event.get_sender_id()
                ),
                "session_key": str(
                    getattr(event, "unified_msg_origin", "")
                    or event.get_sender_id()
                ),
                "user_id": str(event.get_sender_id()),
                "group_id": str(getattr(event, "group_id", "") or ""),
            }
        except Exception:  # noqa: BLE001 - 事件字段在不同适配器上不完全一致
            return {"origin": "", "session_key": "", "user_id": "", "group_id": ""}

    async def _send_safe(self, context: dict[str, str], text: str) -> None:
        origin = context.get("origin") or ""
        if not origin:
            logger.warning(f"缺少会话地址，无法发送消息: {text}")
            return
        user_id = context.get("user_id") or ""
        with_at = bool(context.get("group_id") and user_id)

        async def send(at: bool) -> None:
            chain = []
            if at:
                try:
                    chain.append(Comp.At(qq=int(user_id)))
                except (TypeError, ValueError):
                    chain.append(Comp.At(qq=user_id))
            chain.append(Comp.Plain(text))
            await self.context.send_message(origin, MessageChain(chain=chain))

        try:
            await send(with_at)
        except Exception as exc:  # noqa: BLE001 - At 失败就退回纯文本
            logger.warning(f"发送消息失败，尝试纯文本: {exc}")
            try:
                await send(False)
            except Exception:  # noqa: BLE001 - 回复路径不抛异常
                logger.exception("纯文本消息也发送失败")

    def _caption(
        self,
        request_id: str,
        story: dict[str, Any],
        result: dict[str, Any],
        local_path: Path | None,
    ) -> str:
        title = str(
            story.get("title") or (result.get("story") or {}).get("title") or ""
        ).strip()
        dialogue = count_dialogue(story.get("beats") or [])
        duration = float(result.get("duration") or 0)
        parts: list[str] = [f"《{title}》生成完成" if title else "视频生成完成"]
        details: list[str] = []
        if dialogue:
            details.append(f"{dialogue} 句")
        if duration:
            details.append(f"{duration:.1f} 秒")
        size_mb = 0.0
        if local_path is not None and local_path.exists():
            size_mb = local_path.stat().st_size / 1048576
            details.append(f"{size_mb:.1f} MB")
        if details:
            parts.append(" · ".join(details))
        warning_text = format_warnings(result.get("warnings"))
        if warning_text:
            parts.append(warning_text)
        if size_mb > self.max_video_mb:
            parts.append(
                f"视频 {size_mb:.1f} MB，超过 {self.max_video_mb} MB，平台可能拒收。"
            )
        parts.append(f"任务 #{request_id}")
        return "\n".join(parts)

    async def _send_video(
        self,
        context: dict[str, str],
        local_path: Path | None,
        download_url: str,
        caption: str,
    ) -> None:
        """五重降级投递：本地文件 → URL 变体 → 文件服务 → 手动 token → 路径提示。"""
        origin = context.get("origin") or ""
        if not origin:
            logger.warning("缺少会话地址，无法发送视频")
            return
        user_id = context.get("user_id") or ""

        if context.get("group_id") and user_id:
            try:
                try:
                    at = Comp.At(qq=int(user_id))
                except (TypeError, ValueError):
                    at = Comp.At(qq=user_id)
                await self.context.send_message(origin, MessageChain(chain=[at]))
            except Exception as exc:  # noqa: BLE001 - 通知失败不影响视频
                logger.warning(f"艾特通知发送失败: {exc}")

        if local_path is not None and local_path.exists():
            try:
                local_text = self._clean_path(str(local_path))
                await self.context.send_message(
                    origin,
                    MessageChain(
                        chain=[
                            Comp.Plain(caption),
                            Comp.Video.fromFileSystem(path=local_text),
                        ]
                    ),
                )
                logger.info(f"视频发送成功（本地文件）: {local_text}")
                return
            except Exception as exc:  # noqa: BLE001 - 继续尝试 URL
                logger.warning(f"本地文件发送失败: {exc}")

        for url in self._url_variants(download_url):
            try:
                await self.context.send_message(
                    origin,
                    MessageChain(
                        chain=[Comp.Plain(caption), Comp.Video.fromURL(url=url)]
                    ),
                )
                logger.info(f"视频发送成功（URL）: {url}")
                return
            except Exception as exc:  # noqa: BLE001 - 继续尝试下一个变体
                logger.warning(f"URL 发送失败 {url}: {exc}")

        if local_path is not None and local_path.exists():
            try:
                video = Comp.Video(file=str(local_path))
                file_url = await video.register_to_file_service()
                if self.callback_api_base and file_url:
                    parsed = urlparse(file_url)
                    callback = urlparse(self.callback_api_base)
                    file_url = urlunparse(
                        (
                            callback.scheme,
                            callback.netloc,
                            parsed.path,
                            parsed.params,
                            parsed.query,
                            parsed.fragment,
                        )
                    )
                await self.context.send_message(
                    origin,
                    MessageChain(
                        chain=[Comp.Plain(caption), Comp.Video.fromURL(url=file_url)]
                    ),
                )
                logger.info(f"视频发送成功（文件服务）: {file_url}")
                return
            except Exception as exc:  # noqa: BLE001 - 继续尝试手动注册
                logger.warning(f"文件服务发送失败: {exc}")

        if local_path is not None and local_path.exists():
            try:
                from astrbot.core import astrbot_config, file_token_service

                token = await file_token_service.register_file(str(local_path))
                if self.callback_api_base:
                    file_url = f"{self.callback_api_base}/api/file/{token}"
                else:
                    port = astrbot_config.get("dashboard", {}).get("port", 6185)
                    host_ip = self._detect_host_ip()
                    if not host_ip:
                        raise RuntimeError("无法检测宿主机 IP")
                    file_url = f"http://{host_ip}:{port}/api/file/{token}"
                await self.context.send_message(
                    origin,
                    MessageChain(
                        chain=[Comp.Plain(caption), Comp.Video.fromURL(url=file_url)]
                    ),
                )
                logger.info(f"视频发送成功（手动文件服务）: {file_url}")
                return
            except Exception as exc:  # noqa: BLE001 - 最后只能提示路径
                logger.warning(f"手动文件服务发送失败: {exc}")

        if local_path is not None and local_path.exists():
            await self._send_safe(
                context, f"{caption}\n视频已下载到 {local_path}，当前平台不支持视频消息。"
            )
            return
        await self._send_safe(context, f"{caption}\n但视频文件下载失败，未能发送。")

    @staticmethod
    def _clean_path(path: str) -> str:
        """POSIX 下 Path('//x') 会保留双斜杠，投递前按旧版约定收拢成一个。"""
        while path.startswith("//"):
            path = path[1:]
        return path

    def _url_variants(self, download_url: str) -> list[str]:
        url = (download_url or "").strip()
        if not url:
            return []
        variants = [url]
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        if hostname in {"127.0.0.1", "localhost"}:
            host_ip = self._detect_host_ip()
            for replacement in ("host.docker.internal", host_ip):
                if not replacement:
                    continue
                variant = urlunparse(
                    (
                        parsed.scheme,
                        parsed.netloc.replace(hostname, replacement),
                        parsed.path,
                        parsed.params,
                        parsed.query,
                        parsed.fragment,
                    )
                )
                if variant not in variants:
                    variants.append(variant)
        if self.callback_api_base:
            callback = urlparse(self.callback_api_base)
            if callback.hostname and callback.hostname != hostname:
                variant = urlunparse(
                    (
                        callback.scheme,
                        callback.netloc,
                        parsed.path,
                        parsed.params,
                        parsed.query,
                        parsed.fragment,
                    )
                )
                if variant not in variants:
                    variants.append(variant)
        return variants

    @staticmethod
    def _detect_host_ip() -> str:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                sock.settimeout(1)
                sock.connect(("8.8.8.8", 80))
                return str(sock.getsockname()[0])
            finally:
                sock.close()
        except Exception:  # noqa: BLE001 - 探测失败返回空串
            return ""

    # ------------------------------------------------------------------------------------------------
    # 产物
    # ------------------------------------------------------------------------------------------------
    def _save_story(self, request_id: str, story: dict[str, Any]) -> None:
        title = safe_stem(story.get("title") or "story")
        path = self.story_dir / f"{title}_{int(time.time())}_{request_id}.json"
        if not write_json_file(path, story):
            logger.warning(f"保存剧本失败: {path}")

    # ------------------------------------------------------------------------------------------------
    # 管理指令
    # ------------------------------------------------------------------------------------------------
    @filter.command_group("ournotesadmin")
    def ournotesadmin(self) -> None:
        """ournotes-render 对接管理（子指令仅管理员）"""

    @ournotesadmin.command("status", alias={"状态", "系统状态", "查看状态"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def status_cmd(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        health, problem = await self._preflight()
        lines = [
            "ournotes-render 对接状态",
            f"宿主: {self.client.base_url if self.client else self.api_base}",
            f"连接: {'正常' if not problem else '不可用 - ' + problem}",
        ]
        if health:
            site = health.get("site") or {}
            if isinstance(site, dict):
                kind = {"product": "产品站点", "site-format": "下载站点"}.get(
                    str(site.get("kind") or ""), str(site.get("kind") or "未配置")
                )
                lines.append(f"站点: {kind}" + (f"（{site.get('dir')}）" if site.get("dir") else ""))
            llm = health.get("llm") or {}
            if isinstance(llm, dict):
                lines.append(
                    "AI: "
                    + ("已配置" if llm.get("configured") else "未配置")
                    + f"（{llm.get('model') or '-'}）"
                )
            queue = health.get("queue") or {}
            if isinstance(queue, dict):
                lines.append(
                    f"渲染: 运行 {queue.get('running', 0)} / 等待 {queue.get('waiting', 0)}"
                    f" / 并发 {queue.get('concurrency', '-')}"
                )
            tts = health.get("tts") or {}
            if isinstance(tts, dict):
                lines.append(
                    "TTS: "
                    + ("已启用" if tts.get("enabled") else "未启用")
                    + f"（{tts.get('provider') or '-'} · {tts.get('voices', 0)} 音色）"
                )
            config = health.get("config") or {}
            if isinstance(config, dict) and (config.get("errors") or config.get("warnings")):
                lines.append(
                    f"宿主配置: {config.get('errors', 0)} 错误 / {config.get('warnings', 0)} 警告"
                )
        lines.append(f"本地: 生成中 {len(self._inflight)} / 等待 {self._waiting}")
        lines.append("")
        lines.append(self._stats_report())
        yield event.plain_result("\n".join(lines))

    @ournotesadmin.command("queue", alias={"队列", "排队", "队列状态"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def queue_cmd(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        host_line = "宿主：查询失败"
        if self.client is not None:
            try:
                status = await self.client.status()
                queue = status.get("queue") or {}
                tasks = status.get("tasks") or []
                host_line = (
                    f"宿主：运行 {queue.get('running', 0)} / "
                    f"等待 {queue.get('waiting', 0)} / "
                    f"任务 {len(tasks)}"
                )
            except HostError as exc:
                host_line = f"宿主：查询失败 - {exc.message}"
        lines = [host_line, f"本地：生成中 {len(self._inflight)} / 等待 {self._waiting}"]
        for request_id, entry in list(self._inflight.items())[:10]:
            elapsed = int(time.time() - float(entry.get("started", time.time())))
            lines.append(
                f"  #{request_id} {entry.get('mode', '')} {elapsed} 秒 {entry.get('prompt', '')}"
            )
        yield event.plain_result("\n".join(lines))

    @ournotesadmin.command("cancel", alias={"取消", "终止", "停止"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cancel_cmd(
        self, event: AstrMessageEvent, task_id: str
    ) -> AsyncIterator[Any]:
        key = str(task_id or "").strip().lstrip("#")
        if not key:
            yield event.plain_result("用法：/ournotesadmin cancel <任务ID>（ID 见提交回执）")
            return
        entry = self._inflight.get(key)
        if entry is None:
            matches = [rid for rid in self._inflight if rid.startswith(key)]
            if len(matches) == 1:
                key = matches[0]
                entry = self._inflight[key]
        if entry is None:
            yield event.plain_result(f"未找到任务 {key or '(空)'}")
            return
        entry["task"].cancel()
        yield event.plain_result(f"已请求取消任务 #{key}（宿主渲染任务也会一并取消）")

    @ournotesadmin.command("resources", alias={"资源列表", "模型列表", "资源"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def resources_cmd(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        if self.client is None:
            yield event.plain_result(f"插件配置有误：{self.config_error}")
            return
        try:
            data = await self.client.resources()
        except HostError as exc:
            yield event.plain_result(f"获取资源目录失败：{exc.message}")
            return
        yield event.plain_result(self._format_resources(data))

    @ournotesadmin.command("cleanup", alias={"清理", "清理文件", "删除临时文件"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cleanup_cmd(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        local = prune_old_files(self.video_dir, FILE_RETENTION_SECONDS, "*.mp4")
        local += prune_old_files(self.story_dir, FILE_RETENTION_SECONDS, "*.json")
        parts = [f"本地清理 {local} 个超过 2 小时的文件"]
        if self.client is not None:
            try:
                result = await self.client.cleanup()
                parts.append(
                    f"宿主清理 {result.get('removed', 0)} 个过期导出文件"
                )
            except HostError as exc:
                parts.append(f"宿主清理失败：{exc.message}")
        yield event.plain_result("\n".join(parts))

    @ournotesadmin.command("setapi", alias={"设置api", "设置API", "更新api"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def set_api_cmd(self, event: AstrMessageEvent, url: str) -> AsyncIterator[Any]:
        if self.client is None:
            yield event.plain_result(f"插件配置有误：{self.config_error}")
            return
        try:
            target = normalize_base_url(str(url).strip())
        except HostError as exc:
            yield event.plain_result(exc.message)
            return
        await self.client.set_base_url(target)
        self.api_base = self.client.base_url
        try:
            self.config["api_base"] = self.api_base
            self.config.save_config()
        except Exception as exc:  # noqa: BLE001 - 保存失败不影响本次运行
            logger.warning(f"保存 API 地址失败: {exc}")
        _, problem = await self._preflight()
        if problem:
            yield event.plain_result(f"地址已更新但连接失败：{self.api_base}\n{problem}")
        else:
            yield event.plain_result(f"API 地址已更新：{self.api_base}")

    def _format_resources(self, data: dict[str, Any]) -> str:
        models = data.get("models") or []
        bases = data.get("bases") or []
        stages = data.get("stages") or []
        music = data.get("music") or []
        voices = data.get("voices") or []
        lines = [
            f"角色 {len(models)} · 舞台 {len(stages)} · BGM {len(music)} · "
            f"底本 {len(bases)} · 音色 {len(voices)}"
        ]
        if models:
            names = [
                f"{model.get('name') or model.get('id')}(id={model.get('id')})"
                for model in models[:40]
            ]
            lines.append("角色：" + "、".join(names))
            if len(models) > 40:
                lines.append(f"…另有 {len(models) - 40} 个角色")
        if bases:
            names = [
                str(item.get("title") or item.get("id") or item.get("manifest") or item)
                if isinstance(item, dict)
                else str(item)
                for item in bases[:20]
            ]
            lines.append("底本：" + "、".join(names))
            if len(bases) > 20:
                lines.append(f"…另有 {len(bases) - 20} 个底本")
        if stages:
            names = [
                f"{item.get('caption') or item.get('id')}"
                if isinstance(item, dict)
                else str(item)
                for item in stages[:20]
            ]
            lines.append("舞台：" + "、".join(names))
            if len(stages) > 20:
                lines.append(f"…另有 {len(stages) - 20} 个舞台")
        if music:
            names = [
                f"{item.get('label') or item.get('cue')}"
                if isinstance(item, dict)
                else str(item)
                for item in music[:20]
            ]
            lines.append("BGM：" + "、".join(names))
            if len(music) > 20:
                lines.append(f"…另有 {len(music) - 20} 首 BGM")
        if voices:
            lines.append("音色：" + "、".join(str(item) for item in voices[:30]))
            if len(voices) > 30:
                lines.append(f"…另有 {len(voices) - 30} 个音色")
        return "\n".join(lines)[:1800]
