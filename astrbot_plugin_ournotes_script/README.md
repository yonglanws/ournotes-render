<div align="center">

# astrbot_plugin_ournotes_script

[ournotes-render](https://github.com/yonglanws/ournotes-render) 的 AstrBot 对接插件——
把聊天指令转成宿主的剧本生成与视频渲染请求，成品 MP4 自动回传到 QQ / Telegram

<a href="#简介">简介</a> ·
<a href="#快速开始">快速开始</a> ·
<a href="#指令">指令</a> ·
<a href="#配置">配置</a> ·
<a href="#工作流程">工作流程</a> ·
<a href="#故障排除">故障排除</a>

</div>

## 简介

插件是纯对接端：**提示词、选角、剧本校验、TTS、渲染全部在宿主完成**。
插件只负责接收指令、调用宿主 HTTP API、显示进度、下载视频并投递到会话，
不在 AstrBot 侧配置 LLM 提供商或角色人格。

- **两种创作模式**：`/视频对话` 生成短视频回复（带会话级历史）；`/剧本生成` 按场景生成完整短剧
- **宿主内置 AI harness**：插件把场景、模式、历史与时长参数交给宿主 `POST /api/v1/script/generate`，
  由宿主完成选角、提示词裁剪、台词修复与日文翻译
- **两段式反馈**：剧本返回后立即提示「正在渲染视频」，渲染队列的阶段与进度持续回传，完成后发送 MP4
- **宿主统一限流**：生成与渲染并发由宿主控制；插件侧另有轻量并发闸与排队上限，宿主队列满（HTTP 429）时自动排队重试
- **健壮回传**：视频流式下载，本地文件直发 → URL 变体 → 文件服务 token 多级降级，兼容 Docker / NAT 网络
- **会话历史**：`/视频对话` 按聊天上下文保存最近几轮，超时自动清理；剧本与统计落盘，重启不丢
- **运维能力**：连接状态、宿主队列、任务取消、资源概览、过期文件清理、API 地址切换（`/ournotesadmin` 仅管理员）

> `/视频对话` 的历史与 chat 模式依赖宿主 `/api/v1/script/generate` 的 `mode` / `history` 字段；
> 旧宿主会忽略这两个字段，仍能生成视频但没有上下文。

## 快速开始

> [!IMPORTANT]
> 需要一台已运行且启用内置 AI 的 [ournotes-render](https://github.com/yonglanws/ournotes-render) 宿主。
> 宿主 `config.yaml` 中需要配置 `llm.enabled: true`、模型通道，以及 `paths.site` 或 `paths.siteFormat`。

- AstrBot 4.10.4+
- Python 3.10+
- 宿主的 HTTP API 从机器人侧可达（同机 `127.0.0.1:9881`，跨机填对方 IP）

```bash
# 在 AstrBot 根目录执行；目录名必须保持 astrbot_plugin_ournotes_script
git clone --depth 1 https://github.com/yonglanws/ournotes-render.git /tmp/ournotes-render
cp -r /tmp/ournotes-render/astrbot_plugin_ournotes_script data/plugins/astrbot_plugin_ournotes_script
pip install -r data/plugins/astrbot_plugin_ournotes_script/requirements.txt
# 在 AstrBot WebUI 的插件管理中点击「重载插件」
```

日志出现 `ournotes 插件就绪` 即加载成功。

## 指令

### 创作指令

| 指令 | 别名 | 说明 | 示例 |
| --- | --- | --- | --- |
| `/视频对话 <消息>` | `/视频生成` `/视频聊天` `/测试视频对话` | 生成一段角色短视频回复 | `/视频对话 今天好累啊` |
| `/剧本生成 <场景>` | `/剧本对话` `/故事生成` `/story` `/写剧本` `/storygen` | 生成完整剧本视频 | `/剧本生成 放学后的教室里，灯和爽世聊起下次 Live` |
| `/统计` | `/stats` `/统计信息` | 查看生成统计 | `/统计` |

### 管理指令（`/ournotesadmin` 组，仅管理员）

| 指令 | 别名 | 说明 |
| --- | --- | --- |
| `/ournotesadmin status` | `/状态` `/系统状态` | 宿主连接、站点、AI、渲染队列、TTS 与本地统计 |
| `/ournotesadmin queue` | `/队列` `/排队` | 宿主队列与本地在途任务 |
| `/ournotesadmin cancel <任务ID>` | `/取消` `/终止` `/停止` | 取消本地任务并请求宿主取消渲染任务 |
| `/ournotesadmin resources` | `/资源列表` `/模型列表` | 查看宿主可用角色 / 舞台 / BGM / 底本 / 音色 |
| `/ournotesadmin cleanup` | `/清理` `/清理文件` | 清理宿主与本地超过 2 小时的产物 |
| `/ournotesadmin setapi <URL>` | - | 切换宿主地址并保存到插件配置 |

## 配置

在 AstrBot WebUI 的插件配置页修改：

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `api_base` | 宿主 API 地址（同机 `127.0.0.1:9881`，跨机填对方 IP） | `http://127.0.0.1:9881` |
| `api_key` | 宿主前置鉴权令牌（可选） | 空 |
| `language` | 剧本语言；`auto` 跟随底本站点 | `zh-Hans` |
| `base_story` | 底本 manifest，如 `stories/10610.json`；留空自动选第一篇 | 空 |
| `target_minutes` | 目标时长（分钟），`0` 跟随宿主配置 | `0` |
| `max_lines` | 最大台词条数，`0` 跟随宿主配置 | `0` |
| `tts` | 启用宿主 TTS 配音 | `true` |
| `script_timeout` | 剧本生成超时（秒），含宿主重试 | `1200` |
| `export_timeout` | 渲染与下载超时（秒） | `1800` |
| `busy_retry_seconds` | 宿主队列满时的重试间隔（秒） | `15` |
| `max_concurrent_requests` | 插件侧同时生成的任务数 | `2` |
| `max_pending` | 在途 + 等待任务上限 | `20` |
| `pipeline` | `auto` 跟随宿主 / `single` 单段 / `staged` 分段 | `auto` |
| `max_prompt_chars` | 场景描述长度上限 | `500` |
| `history_rounds` | `/视频对话` 保留的历史轮数 | `3` |
| `session_timeout_minutes` | 会话历史保留时长 | `60` |
| `poll_interval_seconds` | 渲染进度轮询间隔 | `3` |
| `progress_interval_seconds` | 同一阶段内进度消息间隔；宿主帧进度变化至少每 10 秒转发；`0` = 只发阶段变化 | `20` |
| `temp_dir` | 视频与剧本产物目录，留空用插件数据目录 | 空 |
| `callback_api_base` | AstrBot 文件服务的外部可达地址 | 空 |
| `max_video_mb` | 视频大小提醒阈值 | `50` |
| `max_video_files` | 保留的最近视频数 | `20` |

`api_base` 只接受 `http` / `https`；不接受带用户名密码、查询参数或片段的地址。

### 从 0.2 升级

- 主流程从「提交 `/api/v1/generate` 后整段等待」改为「`/api/v1/script/generate` 出剧本后，再用
  `/api/v1/render` 排队渲染」；剧本会保存到插件数据目录 `stories/`，统计落到 `export_stats.json`。
- 新增 `/视频对话` 与 `/ournotesadmin` 管理组；`timeout_seconds` 拆成 `script_timeout` 与 `export_timeout`。
- 依赖从 `aiohttp` 换成 `httpx`，重载插件前记得重新安装 `requirements.txt`。

## 工作流程

```text
用户发送 /剧本生成 <场景>
    ↓
插件健康检查（宿主 /api/v1/health）→ 立即回复「视频生成中」与任务号
    ↓
POST /api/v1/script/generate（场景 / 模式 / 历史 / 时长 / pipeline）
    宿主：选角 → 台词 → 分镜 → 校验与修复
    ↓
POST /api/v1/render（剧本 JSON，wait: false）
    宿主：队列 → TTS → 剧情编译 → 逐帧渲染 → 混音 → MP4
    ↓
GET /api/v1/tasks/<id> 轮询阶段与进度 → 发送「渲染中：配音 50%」等消息
    ↓
GET /api/v1/download/<文件> 流式下载 → 多级降级发送到群
    ↓
回执标题 / 句数 / 时长 / 大小；统计与剧本落盘；过期产物定期清理
```

## 故障排除

### 提示「宿主未配置内置 AI」

宿主 `config.yaml` 的 `llm.enabled` 为 `false`，或 `llm.model` 为空。在宿主侧配置模型通道并重启宿主，
插件本身不需要也不读取 AstrBot 的对话模型。

### 提示「宿主未配置站点」

宿主 `paths.site` 与 `paths.siteFormat` 都为空。配置一个 nnnotes 产品站点，或把下载好的 bdon 站点指向
`paths.siteFormat`。

### 提示「无法连接渲染宿主」

1. 确认宿主在运行：`curl http://<宿主IP>:9881/api/v1/health`
2. 跨设备时检查防火墙放行 9881 端口、`api_base` 填写正确 IP
3. 修改地址可在插件配置页填写，或用 `/ournotesadmin setapi <URL>` 即时切换

### 剧本生成失败（HTTP 422）

宿主返回的校验错误会原样展示前几条。查看宿主日志定位具体的提示词或模型输出问题；
插件侧没有可调的本地校验逻辑。

### 提示「宿主生成队列已满」

宿主队列已满，插件会自动按 `busy_retry_seconds` 重试直到 `script_timeout`。
若经常出现，可降低 `max_concurrent_requests`，或调大宿主 `queue.concurrency`。

### 视频发送失败

1. Docker 部署 AstrBot 时配置 `callback_api_base` 为外部可达地址
2. 确认 AstrBot 文件服务端口从机器人侧可达
3. 查看插件日志中本地文件、URL、文件服务各级发送尝试记录

## 项目结构

```text
astrbot_plugin_ournotes_script/
├── main.py              # 指令、并发闸、进度、视频投递、会话历史与统计
├── core/
│   ├── client.py        # 宿主 HTTP 契约（health / script / render / task / download）
│   ├── format.py        # 剧本句数统计与警告文本
│   └── storage.py       # JSON 状态持久化、剧本落盘与产物清理
├── metadata.yaml        # 插件元数据
├── _conf_schema.json    # 配置模式定义
└── requirements.txt     # Python 依赖（httpx）
```

## 相关内容

- [ournotes-render](https://github.com/yonglanws/ournotes-render) —— 渲染宿主：无头纯 API 的 Live2D 剧情视频框架
- [宿主配置](https://github.com/yonglanws/ournotes-render/blob/main/docs/host.md) —— 站点、LLM、TTS 与队列
- [导演脚本](https://github.com/yonglanws/ournotes-render/blob/main/docs/story-director.md) —— `ournotes.story-script/1` 格式与演出规则

## 许可

本插件是 ournotes-render 的一部分，遵循 AGPL-3.0-only（见 [LICENSE](LICENSE) 与
[LICENSE-EXCEPTION](LICENSE-EXCEPTION)）。
