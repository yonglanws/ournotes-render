# Changelog

## v0.3.0

- 插件改为与 MySekaiStoryteller 插件一致的纯对接端：`/api/v1/script/generate` 出剧本，再用
  `/api/v1/render`（`wait: false`）排队渲染并轮询阶段进度；渲染完成才下载和投递视频。
- 新增 `/视频对话`：带会话级历史调用宿主的 chat 模式，宿主按最近对话重新选角；历史按聊天上下文隔离并定期清理。
- 新增 `/统计` 与 `/ournotesadmin` 管理组：状态、队列、取消、资源、清理、切换宿主地址。
- 新增宿主健康检查、本地并发闸与排队上限、消息去重、429 排队重试、任务取消时同步取消宿主渲染任务。
- 视频投递改为多级降级：本地文件 → URL 变体 → 文件服务 → 手动文件 token → 路径提示。
- 依赖从 `aiohttp` 换成 `httpx`；配置项拆分为 `script_timeout` / `export_timeout`，新增 `tts`、`pipeline`、
  排队与进度相关选项。

## v0.2.0

- `/剧本生成` now returns a finished MP4 instead of a script preview: it submits the host's video task, polls progress,
  downloads the video and sends it.
- Send progress messages on phase changes and at a configurable interval.
- Configurable overall timeout, polling interval, video size warning and retained video count.
- Cancel the host task when the command times out or the plugin unloads.

## v0.1.0

- Add the `/剧本生成` command (aliases `/写剧本`, `/storygen`).
- Call `POST /api/v1/script/generate` on an ournotes-render host and send a readable preview plus the complete
  `ournotes.story-script/1` JSON as a file.
- Configurable language, target duration, line limit, base story, timeout, preview length and attachment mode.
- Retain the latest generated scripts in the plugin data directory and prune older ones.
