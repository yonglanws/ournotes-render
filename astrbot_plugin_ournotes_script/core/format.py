"""Turn an ``ournotes.story-script/1`` document into a readable chat preview.

This module has no AstrBot imports so it can be unit-tested on its own. The preview is intentionally compact: the
complete, machine-readable script travels as a JSON attachment.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _number(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:g}"
    return _text(value)


def cast_map(cast: Any) -> dict[str, str]:
    """Return ``{cast id: display name}`` for both the object and list forms."""
    out: dict[str, str] = {}
    if isinstance(cast, Mapping):
        for key, value in cast.items():
            cast_id = _text(key)
            if not cast_id:
                continue
            if isinstance(value, Mapping):
                out[cast_id] = _text(value.get("name")) or cast_id
            else:
                out[cast_id] = _text(value) or cast_id
    elif isinstance(cast, Sequence) and not isinstance(cast, (str, bytes)):
        for item in cast:
            if not isinstance(item, Mapping):
                continue
            cast_id = _text(item.get("id")) or _text(item.get("name"))
            if cast_id:
                out[cast_id] = _text(item.get("name")) or cast_id
    return out


def speaker_name(cast: Mapping[str, str], cast_id: Any) -> str:
    key = _text(cast_id)
    return cast.get(key, key)


def _camera_text(value: Any) -> str:
    if isinstance(value, Mapping):
        return _text(value.get("distance")) or _text(value.get("camera")) or "camera"
    return _number(value)


def direction_parts(beat: Mapping[str, Any], *, include_directions: bool) -> list[str]:
    if not include_directions:
        return []
    parts: list[str] = []
    if beat.get("motion"):
        parts.append(f"动作 {_text(beat['motion'])}")
    if beat.get("expression"):
        parts.append(f"表情 {_text(beat['expression'])}")
    if beat.get("lookAt"):
        parts.append(f"视线 {_text(beat['lookAt'])}")
    if beat.get("camera") is not None:
        parts.append(f"镜头 {_camera_text(beat['camera'])}")
    if beat.get("focus") is not None:
        parts.append(f"焦点 {_number(beat['focus'])}")
    if beat.get("track") is not None:
        parts.append(f"横移 {_number(beat['track'])}")
    if beat.get("zoom") is not None:
        parts.append(f"缩放 {_number(beat['zoom'])}")
    return parts


def _cast_list(names: Sequence[str]) -> str:
    return "、".join(name for name in names if name)


def _beat_lines(
    beat: Mapping[str, Any],
    cast: Mapping[str, str],
    *,
    include_directions: bool,
) -> list[str]:
    lines: list[str] = []
    dialogue = "say" in beat or "narrate" in beat

    if "scene" in beat:
        scene = _text(beat.get("scene"))
        location = _text(beat.get("location"))
        line = f"【场景】{location or scene or '（未命名）'}"
        extras: list[str] = []
        if location and scene:
            extras.append(f"背景 {scene}")
        if beat.get("music"):
            extras.append(f"BGM {_text(beat['music'])}")
        if extras:
            line += " · " + " · ".join(extras)
        lines.append(line)
    elif "positions" in beat and isinstance(beat.get("positions"), Mapping):
        positions = [
            f"{speaker_name(cast, cast_id)} {_text(position)}"
            for cast_id, position in beat["positions"].items()
            if _text(position)
        ]
        if positions:
            lines.append("【站位】" + "，".join(positions))

    if "say" in beat:
        line = f"{speaker_name(cast, beat['say'])}：{_text(beat.get('text'))}"
        directions = direction_parts(beat, include_directions=include_directions)
        if directions:
            line += "（" + " · ".join(directions) + "）"
        lines.append(line)
    elif "narrate" in beat:
        text = _text(beat.get("narrate")) or _text(beat.get("text"))
        line = f"【旁白】{text}"
        directions = direction_parts(beat, include_directions=include_directions)
        if directions:
            line += "（" + " · ".join(directions) + "）"
        lines.append(line)
    elif "action" in beat:
        if include_directions:
            actor = speaker_name(cast, beat.get("cast")) if beat.get("cast") else ""
            label = _text(beat.get("action"))
            parts = direction_parts(beat, include_directions=include_directions)
            line = "【反应】" + " ".join(part for part in (actor, label) if part)
            if parts:
                line += "（" + " · ".join(parts) + "）"
            lines.append(line.strip())
    elif "fade" in beat:
        line = f"【黑场】{_text(beat['fade'])}"
        if beat.get("duration") is not None:
            line += f" {_number(beat['duration'])}s"
        lines.append(line)
    elif "pause" in beat:
        lines.append(f"【停顿】{_number(beat['pause'])}s")
    elif not dialogue and (
        "camera" in beat or "focus" in beat or "track" in beat or "zoom" in beat
    ):
        if include_directions:
            parts: list[str] = []
            if beat.get("camera") is not None:
                parts.append(_camera_text(beat["camera"]))
            if beat.get("focus") is not None:
                parts.append(f"焦点 {_number(beat['focus'])}")
            if beat.get("track") is not None:
                parts.append(f"横移 {_number(beat['track'])}")
            if beat.get("zoom") is not None:
                parts.append(f"缩放 {_number(beat['zoom'])}")
            if parts:
                lines.append("【镜头】" + " · ".join(parts))
    return lines


def count_dialogue(beats: Sequence[Any]) -> int:
    return sum(
        1
        for beat in beats
        if isinstance(beat, Mapping) and ("say" in beat or "narrate" in beat)
    )


def format_warnings(warnings: Any, *, limit: int = 5) -> str:
    if not isinstance(warnings, Sequence) or isinstance(warnings, (str, bytes)):
        return ""
    messages: list[str] = []
    for warning in warnings:
        if isinstance(warning, Mapping):
            message = _text(warning.get("message")) or _text(warning.get("code"))
        else:
            message = _text(warning)
        if message:
            messages.append(message)
    if not messages:
        return ""
    shown = messages[:limit]
    suffix = f" 等 {len(messages)} 条" if len(messages) > limit else ""
    return "⚠️ 生成警告：" + "；".join(shown) + suffix


def format_script(
    document: Any,
    *,
    include_directions: bool = True,
    preview_lines: int = 20,
    max_chars: int = 1800,
) -> str:
    """Format a director script for a chat message.

    ``preview_lines`` limits the number of spoken/narrated lines (0 means all); ``max_chars`` then caps the whole
    message. The complete document should be sent separately as JSON.
    """
    if not isinstance(document, Mapping):
        return "（宿主返回的剧本不是对象）"
    beats = document.get("beats")
    if not isinstance(beats, Sequence) or isinstance(beats, (str, bytes)):
        beats = []
    beats = [beat for beat in beats if isinstance(beat, Mapping)]

    title = _text(document.get("title")) or "未命名剧本"
    cast = cast_map(document.get("cast"))
    total_dialogue = count_dialogue(beats)
    scene_count = sum(1 for beat in beats if "scene" in beat)

    header = [f"《{title}》"]
    if cast:
        header.append("角色：" + _cast_list(list(cast.values())))
    header.append(f"共 {total_dialogue} 句 · {scene_count} 个场景")
    header.append("")

    lines: list[str] = []
    shown_dialogue = 0
    truncated = False
    for beat in beats:
        dialogue = "say" in beat or "narrate" in beat
        if dialogue and preview_lines > 0 and shown_dialogue >= preview_lines:
            truncated = True
            break
        lines.extend(_beat_lines(beat, cast, include_directions=include_directions))
        if dialogue:
            shown_dialogue += 1

    text = "\n".join(header + lines).rstrip()
    if truncated:
        rest = max(0, total_dialogue - shown_dialogue)
        text += f"\n\n……（还有 {rest} 句，完整剧本见附件）"
    if max_chars > 0 and len(text) > max_chars:
        cut = text[:max_chars].rsplit("\n", 1)[0].rstrip()
        text = cut + "\n……（内容过长，完整剧本见附件）"
    return text
