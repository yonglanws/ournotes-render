# ournotes-render

**无头、纯 API 的 Our Notes 风格 Live2D 剧情视频渲染框架。**

输入一句场景描述或一份 `ournotes.story-script/1` 导演脚本，后端完成 **AI 选角 → 台词 → 分镜 → TTS 配音 →
剧情编译 → 无头 Chrome 逐帧渲染 → 混音 → MP4**，通过 HTTP 返回视频。画面使用本仓库的剧情引擎
（游戏自己的 13:6 对话框、Live2D 着色器、舞台与相机），不是另画一套 UI。

本仓库只保留视频渲染框架：谱面播放、UI 预览与浏览器播放器等无关功能已移除。机器人或任何客户端
只需调用 HTTP API；仓库内的 `astrbot_plugin_ournotes_script/` 是官方对接插件。

## 特性

- **官方 ADV 风格演出**：`scene` / `positions` / `say` / `narrate` / `camera` / `fade` / `pause` / `action`。
  AI 会写镜头焦点（角色/站位/构图点 1~9）、远近、`track` 横移、视线、Live2D 动作与表情、台词前的听者反应
  （`actions` 的 `at: 0`）、黑场与留白。提示词按官方剧情实测：双人戏 36~44 句、每 3~4 句切一次镜头、约 1.1 个
  动作/句、表情挂在动作上、双人戏常用 `lookAt`，并按 30 部官方剧情的镜头分布安排近景与群像。
  格式与规则见[导演脚本](docs/story-director.md)。
- **后端一体化**：队列、AI 选角/台词/分镜、TTS、校验/修复、渲染、混音、编码全部在 `host/`；客户端只提交和取结果。
  默认 `staged` 管线把完整角色提示词只放进台词轮，台词定稿后分镜只能引用 `line` id，改不动台词。
- **AstrBot 插件**：`astrbot_plugin_ournotes_script/` 提供 `/视频对话` 与 `/剧本生成`（别名 `/写剧本`、`/storygen`），
  调用后端的剧本与渲染接口、汇报阶段进度，完成后把 MP4 发回聊天；另带统计与 `/ournotesadmin` 运维指令。
- **确定性渲染**：固定 1/30 秒虚拟时钟步进，音频由页面上报的事件在虚拟时间轴重建，渲染速度不影响成片节奏。
- **两种数据源**：nnnotes 产品站点（`nnnotes.product/1`）用于 AI 队列 + TTS；bdon.moe 公开站点
  （`ournotes.story-manifest/2`）可下载后直接渲染，或用 `ai-site-story` 让 AI 写脚本、合成 TTS 并编译回站点。
- **安全默认值**：密钥只从环境变量读取；下载/请求 URL 只允许 http/https，拒绝 localhost、环回、私有与保留地址；
  API 可选 Bearer 鉴权，CORS 默认关闭。

## 快速开始

需要 Node.js 22+、Chrome/Chromium/Edge、ffmpeg（根目录 `npm install` 的 `ffmpeg-static` 自带；下载失败时把
`video.ffmpegPath` 指向系统 ffmpeg）。

```sh
npm install                    # 根目录一次安装；host 是 npm workspace
cp config.example.yaml config.yaml
# 编辑 config.yaml 中标了 ← 的 paths.site / llm / tts
npm run check                  # 配置、ffmpeg、Chrome、站点、音色一次检查
npm start                      # API: http://127.0.0.1:9881

curl -sS http://127.0.0.1:9881/api/v1/health
```

TTS 支持 GPT-SoVITS（`api_v2`）与 Irodori-TTS（OpenAI 兼容 `/v1/audio/speech`），用 `tts.provider` 切换；字段与
MSST 的 `tts` 节一致。音色表是本项目自己的格式：角色少时写在 `tts.voices`，角色多时用
`tts.voicesFile: voices.yaml`（模板见 `voices.example.yaml`）。不再读取 AstrBot 等外部机器人的配置；配置与试音
步骤见 [TTS 配置与试音](docs/tts.md)。

没有 nnnotes 产品站点时，可把 `paths.siteFormat` 指向 `resources/site`：`/api/v1/generate` 会从 bdon 站点生成
剧本、配音、编译剧情并渲染 MP4。`/api/v1/script/generate` 仍然只返回剧本 JSON。

```sh
npm run tts:check                          # 列出音色表
npm run tts:check -- --synthesize          # 每个音色合成一句到 output/tts-check/
```

生成视频：

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"放学后的教室里，灯和爽世聊起下次 Live","timeout":1800000}'
```

异步调用（推荐给机器人）：请求加 `"wait": false`，轮询 `GET /api/v1/tasks/:id`，
完成后从 `GET /api/v1/download/<file>` 取 MP4。完整端点、字段与配置见[渲染宿主](docs/host.md)。

## 下载公开资源并渲染

不需要 AI/TTS，也不需要自己构建站点：

```sh
# 下载 bdon.moe 的一集剧情、UI/字体、BGM/SE/语音和 Live2D 模型
node host/tools/fetch-story.mjs --adv 10610 --lang ja --out resources/site

# 直接渲染这一集
node host/tools/render-story.mjs --site resources/site --story stories/10610.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job bdon-10610
```

渲染一份带镜头焦点、`track` 横移、站位换组、动作和听者反应的导演脚本：

```sh
node host/tools/site-story.mjs --site resources/site --base stories/10610.json \
  --script host/fixtures/director-demo.json --adv 90001 --lang ja --title "ライブのあとで"
node host/tools/render-story.mjs --site resources/site --story stories/90001.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job director-demo
```

资源只落在 `resources/`（已忽略），仓库不重新分发游戏数据或 Live2D 运行时。

## 文档

| 主题 | 文档 |
| --- | --- |
| 无头 API、队列、AI、TTS、部署、安全 | [渲染宿主](docs/host.md) |
| TTS 音色表、GPT-SoVITS/Irodori、参考音频、权重/LoRA、情绪、试音 | [TTS 配置与试音](docs/tts.md) |
| AstrBot 插件：`/视频对话`、`/剧本生成` 与 `/ournotesadmin` | [插件 README](astrbot_plugin_ournotes_script/README.md) |
| 导演脚本、镜头/动作/听者反应、AI 分镜规则 | [导演脚本](docs/story-director.md) |
| 命令行编写、校验、构建、分镜图 | [剧情编写工具](docs/story-author.md) |
| 剧情数据结构、字体、音频、模型 | [剧情数据格式](docs/story-data-format.md) |
| 剧情引擎支持范围 | [剧情功能](docs/story-features.md) |
| CRI Lips 口型 | [CRI Lips](docs/crilips.md) |

## 开发

```sh
npm test                  # 引擎/剧情/Live2D/导演脚本
npm run test:host         # 队列/AI/TTS/混音/API/浏览器
npm run lint
```

真实剧情/导演脚本的端到端测试需要下载站点并设置 `OURNOTES_E2E_SITE`、`OURNOTES_E2E_CORE`，见
[渲染宿主](docs/host.md#测试)。

## 许可

本项目基于 [empty-sekai/ournotes-player](https://github.com/empty-sekai/ournotes-player)（AGPL-3.0-only）。
游戏资源、商标、Live2D Cubism Core、LLM 与 TTS 服务分别受各自许可约束；本仓库不附带这些资源。
