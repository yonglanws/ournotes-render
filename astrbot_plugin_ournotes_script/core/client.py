"""Small async client for the ournotes-render host API used by the script command."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlparse

import aiohttp


class HostError(RuntimeError):
    """The host is unreachable, rejected the request, or returned an unusable answer."""


def normalize_base(value: Any) -> str:
    """Validate ``[http(s)://]host[:port][/prefix]`` and remove a trailing ``/api/v1``."""
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        raise HostError(
            "api_base 未配置；请填写 ournotes-render 的地址，例如 http://127.0.0.1:9881"
        )
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


def build_payload(
    prompt: str,
    *,
    language: str = "",
    base: str = "",
    target_minutes: float | None = None,
    max_lines: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"prompt": prompt}
    if language:
        payload["language"] = language
    if base:
        payload["base"] = base
    if target_minutes is not None:
        payload["targetMinutes"] = target_minutes
    if max_lines is not None:
        payload["maxLines"] = max_lines
    return payload


class OurnotesClient:
    def __init__(self, base_url: Any, *, api_key: str = "", timeout: int = 300) -> None:
        self.base_url = normalize_base(base_url)
        self.api_key = str(api_key or "").strip()
        self.timeout = max(10, int(timeout))
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                headers={"accept": "application/json"},
            )
        return self._session

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = self.base_url + path
        try:
            session = await self._get_session()
            async with session.post(
                url, json=payload, headers=self._headers()
            ) as response:
                body = await response.text()
                if response.status != 200:
                    raise HostError(self._describe_error(response.status, body))
                try:
                    data = json.loads(body)
                except json.JSONDecodeError as exc:
                    raise HostError(
                        f"宿主返回的不是 JSON（HTTP {response.status}）：{body[:200]}"
                    ) from exc
                if not isinstance(data, dict):
                    raise HostError("宿主返回的 JSON 不是对象")
                if data.get("ok") is False or data.get("success") is False:
                    message = data.get("message") or data.get("error") or "生成失败"
                    raise HostError(str(message))
                return data
        except asyncio.TimeoutError as exc:
            raise HostError(f"生成超时：宿主在 {self.timeout} 秒内没有返回") from exc
        except aiohttp.ClientConnectorError as exc:
            raise HostError(
                f"无法连接 ournotes-render：{self.base_url}（{exc}）"
            ) from exc
        except aiohttp.ClientError as exc:
            raise HostError(f"请求 ournotes-render 失败：{exc}") from exc

    @staticmethod
    def _describe_error(status: int, body: str) -> str:
        message = body.strip()
        try:
            data = json.loads(body)
            if isinstance(data, dict):
                message = str(data.get("message") or data.get("error") or message)
                details = data.get("details")
                if details:
                    message += f"（{json.dumps(details, ensure_ascii=False)[:300]}）"
        except json.JSONDecodeError:
            message = message[:300]
        if status in {401, 403}:
            return (
                f"宿主鉴权失败（HTTP {status}），请检查插件配置中的 api_key：{message}"
            )
        if status == 503:
            return f"宿主还不能生成剧本（HTTP 503），请检查 paths.site / llm 配置：{message}"
        return f"宿主返回 HTTP {status}：{message or '没有错误详情'}"

    async def generate_script(
        self,
        prompt: str,
        *,
        language: str = "",
        base: str = "",
        target_minutes: float | None = None,
        max_lines: int | None = None,
    ) -> dict[str, Any]:
        data = await self._post(
            "/api/v1/script/generate",
            build_payload(
                prompt,
                language=language,
                base=base,
                target_minutes=target_minutes,
                max_lines=max_lines,
            ),
        )
        script = data.get("script")
        if not isinstance(script, dict):
            raise HostError("宿主没有返回剧本对象（script）")
        return data
