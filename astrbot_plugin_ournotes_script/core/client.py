"""ournotes-render 宿主 HTTP 客户端。

插件是纯对接端：提示词、选角、剧本校验、TTS 与渲染都在宿主完成。
这里只负责把宿主的 HTTP 契约映射成调用与异常，不包含任何生成逻辑。
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

DEFAULT_BASE_URL = "http://127.0.0.1:9881"


class HostError(Exception):
    """宿主返回失败，或请求根本没到达宿主。"""

    def __init__(self, message: str, *, status: int | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.message = str(message or "未知错误")
        self.status = status
        self.details = details

    @property
    def retryable(self) -> bool:
        """瞬时故障：宿主忙、网关错误、超时、连接失败。"""
        return self.status is None or self.status in {429, 502, 503, 504}


def normalize_base_url(value: Any, default: str = DEFAULT_BASE_URL) -> str:
    """接受 ``[http(s)://]host[:port][/prefix]``，去掉末尾的 ``/api/v1``。"""
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        raw = default
    if not re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.IGNORECASE):
        raw = "http://" + raw
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HostError(f"api_base 必须是 http/https 地址：{raw}")
    if parsed.username or parsed.password:
        raise HostError("api_base 不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise HostError("api_base 不能包含查询参数或片段")
    if raw.endswith("/api/v1"):
        raw = raw[: -len("/api/v1")].rstrip("/")
    return raw


def build_script_payload(
    prompt: str,
    *,
    mode: str = "story",
    language: str = "",
    base: str = "",
    target_minutes: float | None = None,
    max_lines: int | None = None,
    history: list[dict[str, str]] | None = None,
    pipeline: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "prompt": prompt,
        "mode": "chat" if mode == "chat" else "story",
    }
    if history:
        # 宿主自己也会截取最近 12 条，这里先去掉更早的，别把整份历史发过去
        payload["history"] = history[-6:]
    if language:
        payload["language"] = language
    if base:
        payload["base"] = base
    if target_minutes is not None and float(target_minutes) > 0:
        payload["targetMinutes"] = float(target_minutes)
    if max_lines is not None and int(max_lines) >= 2:
        payload["maxLines"] = int(max_lines)
    if pipeline in {"single", "staged"}:
        payload["pipeline"] = pipeline
    return payload


def build_render_payload(
    script: dict[str, Any],
    *,
    tts: bool = True,
    wait: bool = False,
    timeout_seconds: float = 1800.0,
) -> dict[str, Any]:
    return {
        "script": script,
        "wait": bool(wait),
        "tts": bool(tts),
        "timeout": int(max(1.0, float(timeout_seconds)) * 1000),
    }


class OurnotesClient:
    """宿主 API 的最小封装。"""

    def __init__(
        self,
        base_url: Any,
        api_key: str = "",
        *,
        connect_timeout: float = 15.0,
    ) -> None:
        self.base_url = normalize_base_url(base_url)
        self.api_key = str(api_key or "").strip()
        self._connect_timeout = connect_timeout
        self._client = self._make_client()

    def _make_client(self) -> httpx.AsyncClient:
        headers = {"accept": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=httpx.Timeout(self._connect_timeout, connect=self._connect_timeout),
            follow_redirects=True,
        )

    async def set_base_url(self, base_url: Any) -> None:
        await self.close()
        self.base_url = normalize_base_url(base_url)
        self._client = self._make_client()

    async def close(self) -> None:
        if not self._client.is_closed:
            await self._client.aclose()

    def absolute_url(self, url: str) -> str:
        text = str(url or "").strip()
        if not text:
            return ""
        if re.match(r"^https?://", text, re.IGNORECASE):
            return text
        return f"{self.base_url}/{text.lstrip('/')}"

    async def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        read_timeout = max(1.0, float(timeout))
        try:
            response = await self._client.request(
                method,
                path,
                json=payload,
                timeout=httpx.Timeout(
                    read_timeout, connect=min(self._connect_timeout, read_timeout)
                ),
            )
        except httpx.TimeoutException as exc:
            raise HostError(
                f"宿主请求超时（{read_timeout:.0f} 秒）", status=504
            ) from exc
        except httpx.HTTPError as exc:
            raise HostError(f"无法连接 ournotes-render：{exc}", status=None) from exc

        try:
            data = response.json()
        except ValueError:
            data = None

        if response.status_code >= 400:
            message = ""
            details = None
            if isinstance(data, dict):
                message = str(data.get("message") or data.get("error") or "")
                details = data.get("details")
            raise HostError(
                self._describe_error(response.status_code, message),
                status=response.status_code,
                details=details,
            )

        if not isinstance(data, dict):
            raise HostError("宿主返回了非 JSON 响应", status=502)
        if data.get("success") is False or data.get("ok") is False:
            raise HostError(
                str(data.get("message") or data.get("error") or "宿主返回失败"),
                status=502,
                details=data.get("details"),
            )
        return data

    @staticmethod
    def _describe_error(status: int, message: str = "") -> str:
        detail = message or "没有错误详情"
        if status in {401, 403}:
            return f"宿主鉴权失败（HTTP {status}），请检查插件配置中的 api_key：{detail}"
        if status == 429:
            return f"宿主的生成队列已满（HTTP 429），稍后再试：{detail}"
        if status == 422:
            return f"剧本校验失败（HTTP 422）：{detail}"
        if status == 503:
            return (
                "宿主还不能生成视频（HTTP 503），请检查 paths.site / "
                f"paths.siteFormat / llm 配置：{detail}"
            )
        if status == 504:
            return f"宿主处理超时（HTTP 504）：{detail}"
        return f"宿主返回 HTTP {status}：{detail}"

    # -- 查询 -----------------------------------------------------------------------------------------------
    async def health(self, timeout: float = 10.0) -> dict[str, Any]:
        return await self._request("GET", "/api/v1/health", timeout=timeout)

    async def status(self, timeout: float = 15.0) -> dict[str, Any]:
        return await self._request("GET", "/api/v1/status", timeout=timeout)

    async def resources(self, timeout: float = 30.0) -> dict[str, Any]:
        return await self._request("GET", "/api/v1/resources", timeout=timeout)

    async def cleanup(self, timeout: float = 60.0) -> dict[str, Any]:
        return await self._request("POST", "/api/v1/cleanup", timeout=timeout)

    # -- 生成 -----------------------------------------------------------------------------------------------
    async def generate_script(
        self,
        prompt: str,
        *,
        mode: str = "story",
        history: list[dict[str, str]] | None = None,
        language: str = "",
        base: str = "",
        target_minutes: float | None = None,
        max_lines: int | None = None,
        pipeline: str = "",
        timeout_seconds: float = 1200.0,
    ) -> dict[str, Any]:
        """调用宿主内置 AI harness，返回 script + warnings + stages。"""
        data = await self._request(
            "POST",
            "/api/v1/script/generate",
            payload=build_script_payload(
                prompt,
                mode=mode,
                language=language,
                base=base,
                target_minutes=target_minutes,
                max_lines=max_lines,
                history=history,
                pipeline=pipeline,
            ),
            timeout=max(30.0, float(timeout_seconds)),
        )
        script = data.get("script")
        if not isinstance(script, dict):
            raise HostError("宿主没有返回剧本（script 缺失）", status=502)
        return data

    async def render(
        self,
        script: dict[str, Any],
        *,
        tts: bool = True,
        wait: bool = False,
        timeout_seconds: float = 1800.0,
    ) -> dict[str, Any]:
        """把剧本交给宿主的渲染队列；wait=False 时返回 taskId。"""
        data = await self._request(
            "POST",
            "/api/v1/render",
            payload=build_render_payload(
                script, tts=tts, wait=wait, timeout_seconds=timeout_seconds
            ),
            timeout=max(30.0, float(timeout_seconds) + 60.0)
            if wait
            else 60.0,
        )
        if not wait:
            if not data.get("taskId"):
                raise HostError("宿主没有返回渲染任务 id（taskId）", status=502)
        elif not data.get("downloadUrl") and not data.get("videoPath"):
            raise HostError("宿主导出完成但没有返回视频地址", status=502)
        return data

    async def task(self, task_id: str, timeout: float = 30.0) -> dict[str, Any]:
        return await self._request(
            "GET", f"/api/v1/tasks/{_task_path(task_id)}", timeout=timeout
        )

    async def cancel(self, task_id: str, timeout: float = 30.0) -> dict[str, Any]:
        return await self._request(
            "POST", f"/api/v1/tasks/{_task_path(task_id)}/cancel", payload={}, timeout=timeout
        )

    # -- 下载 -----------------------------------------------------------------------------------------------
    async def download(
        self,
        url: str,
        dest: Path,
        *,
        timeout: float = 1800.0,
        attempts: int = 3,
    ) -> Path:
        """流式下载到本地，先写 .part，校验完整后再改名为目标文件。"""
        full_url = self.absolute_url(url)
        if not full_url:
            raise HostError("下载地址为空", status=502)
        dest.parent.mkdir(parents=True, exist_ok=True)
        last_error: HostError | None = None

        for attempt in range(max(1, attempts)):
            part = dest.with_name(f"{dest.name}.{attempt}.part")
            try:
                async with self._client.stream(
                    "GET",
                    full_url,
                    timeout=httpx.Timeout(
                        max(30.0, timeout), connect=self._connect_timeout
                    ),
                ) as response:
                    if response.status_code >= 400:
                        raise HostError(
                            f"下载视频失败：HTTP {response.status_code}", status=502
                        )
                    total = int(response.headers.get("content-length") or 0)
                    written = 0
                    with open(part, "wb") as handle:
                        async for chunk in response.aiter_bytes(1 << 20):
                            handle.write(chunk)
                            written += len(chunk)
                if total and written < total:
                    raise HostError(f"下载不完整（{written}/{total} 字节）", status=502)
                if written == 0:
                    raise HostError("下载到的视频为空", status=502)
                os.replace(part, dest)
                return dest
            except HostError as exc:
                last_error = exc
            except (httpx.HTTPError, OSError) as exc:
                last_error = HostError(f"下载视频失败：{exc}", status=None)
            finally:
                try:
                    part.unlink(missing_ok=True)
                except OSError:
                    pass
            if attempt + 1 < max(1, attempts):
                await asyncio.sleep(2 * (attempt + 1))

        raise last_error or HostError("下载视频失败", status=None)


def _task_path(task_id: Any) -> str:
    """任务 id 只允许宿主生成的字符集，避免把用户输入拼进路径。"""
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(task_id or "")).strip("-")
    if not value:
        raise HostError("任务 id 为空")
    return value[:120]
