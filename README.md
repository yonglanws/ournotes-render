# ournotes-render

**无头、纯 API 的 Our Notes 风格 Live2D 剧情视频渲染框架。**

输入一句场景描述或一份 `ournotes.story-script/1` 导演脚本，后端完成 **AI 选角 → 台词 → 分镜 → TTS 配音 → 按需拉取云端资源 → 剧情编译 → 无头 Chrome 逐帧渲染 → 混音 → MP4**，通过 HTTP 返回视频。画面使用本仓库的剧情引擎（游戏自己的 13:6 对话框、Live2D 着色器、舞台与相机），不是另画一套 UI。

本仓库只保留视频渲染框架：谱面播放、UI 预览与浏览器播放器等无关功能已移除。机器人或任何客户端只需调用 HTTP API；配套的独立 AstrBot 插件位于 [astrbot_plugin_ournotes_script](https://github.com/yonglanws/astrbot_plugin_ournotes_script)。

## 特性

- **零本地站点云端优先运行时（Cloud-First）**：`paths.site` 与 `paths.siteFormat` 默认均可留空（`""`）。不预先下载 `resources/site` 也能直接启动 `npm start`：宿主会自动从 `https://storage.bdon.moe/moenotes` 初始化轻量云端底座到 `paths.cache/cloud-site`（跳过语音与全量归档），并在编译时按剧本需求从 `storage.bdon.moe/moenotes` 与 `assets.bdon.moe` 自动拉取所需的 Live2D 模型、舞台、BGM、SE、画面遮罩、后期滤镜、粒子特效、CG 与规则转场。`fetch-story` 现为可选的离线预下载工具。
- **全量云端中文语义目录与智能筛选**：内置由 `host/tools/build-cloud-catalog.mjs` 离线构建的简体中文语义索引（`host/story/cloud-catalog.json` + `host/story/site-resources.yaml`），覆盖 **343** 张舞台（含室内/室外、时段标签与标题黑屏过滤）、**91** 首 BGM、**345** 条 SE、**267** 套 Live2D 模型（**209 TW + 58 JP**，按角色/乐队/服装分组），以及 **53** 个画面遮罩、**14** 个后期滤镜、**10** 个粒子特效、**349** 张 CG 与 **6** 个转场规则的 donor 索引。AI 提示词通过 CJK 二字切片与语义/情绪/乐队打分进行分类精选，同时编译层支持全部云端合法资源 ID。
- **官方 ADV 风格演出**：支持 `scene` / `positions` / `say` / `narrate` / `camera` / `fade` / `pause` / `action` 与走位/镜头/特效/声音 beat。AI 会写镜头焦点（角色/站位/构图点 1~9）、远近、横向平移、视线、Live2D 动作（左侧站位自动用 `_L` 朝右、右侧站位自动用 `_R` 朝左）与表情、台词前听者反应（`actions` `at: 0`）、转场与留白；两人同台用 `left`/`right` + `middle`（1.4×），三人同台用 `far-left`/`center`/`far-right` + `near`（1.2×）群像与单人 `close` 特写。规则基于 30 部官方剧情实测，详情见[导演脚本](docs/story-director.md)。
- **后端一体化**：队列、AI 选角/台词/分镜、校验/修复、TTS、云端资源物化、渲染、混音与编码全部在 `host/`；默认 `staged` 管线把完整角色卡只放进台词轮，台词定稿后分镜只能引用 `line` id，改不动台词。
- **独立 AstrBot 插件**：[astrbot_plugin_ournotes_script](https://github.com/yonglanws/astrbot_plugin_ournotes_script) 提供 `/视频对话` 与 `/剧本生成`（别名 `/写剧本`、`/storygen`），调用后端剧本与渲染接口并把 MP4 发回聊天。
- **确定性渲染**：固定 1/30 秒虚拟时钟步进，音频由页面上报的事件在虚拟时间轴重建，渲染速度不影响成片节奏。
- **三种站点模式**：零配置云端运行时（`cloud-site`，默认）、本地 bdon 公开站点（`paths.siteFormat` / `ournotes.story-manifest/2`），以及 nnnotes 产品站点（`paths.site` / `nnnotes.product/1`）。
- **安全默认值**：密钥只从环境变量读取；远程 URL 只允许 http/https，拒绝 localhost、环回、私有与保留地址；API 可选 Bearer 鉴权，CORS 默认关闭。

## 快速开始

需要 Node.js 22+、Chrome/Chromium/Edge、ffmpeg（根目录 `npm install` 的 `ffmpeg-static` 自带；下载失败时把 `video.ffmpegPath` 指向系统 ffmpeg）。

```sh
npm install                    # 根目录一次安装；host 是 npm workspace
cp config.example.yaml config.yaml
# 按需编辑 config.yaml 中的 llm 与 tts（paths.site / paths.siteFormat 留空即启用云端运行时）
npm run check                  # 检查配置、ffmpeg、Chrome、站点模式、音色
npm start                      # API: http://127.0.0.1:9881

curl -sS http://127.0.0.1:9881/api/v1/health
```

TTS 支持 GPT-SoVITS（`api_v2`）与 Irodori-TTS（OpenAI 兼容 `/v1/audio/speech`），用 `tts.provider` 切换；字段与 [MySekaiStoryteller-API](https://github.com/yonglanws/MySekaiStoryteller-API) 的 `tts` 节一致。音色表写在 `tts.voices` 或 `tts.voicesFile: voices.yaml`（模板见 `voices.example.yaml`），配置与试音步骤见 [TTS 配置与试音](docs/tts.md)。

```sh
npm run tts:check                          # 列出音色表
npm run tts:check -- --synthesize          # 每个音色合成一句到 output/tts-check/
```

生成视频（首次启动无本地站点时会自动初始化 `cache/cloud-site` 并按需拉取所用资产）：

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"放学后的教室里，灯和爽世聊起下次 Live","timeout":1800000}'
```

异步调用（推荐给机器人）：请求加 `"wait": false`，轮询 `GET /api/v1/tasks/:id`，完成后从 `GET /api/v1/download/<file>` 取 MP4。完整端点、字段与配置见[渲染宿主](docs/host.md)。

## 可选离线工具（本地站点下载与直接渲染）

如果希望离线预下载或直接渲染官方公开剧情，可使用 `host/tools/` 下的可选 CLI（也可通过 `npm run host:*` 调用）：

```sh
# 可选：离线下载 bdon.moe 的一集剧情、UI/字体、音频与 Live2D 模型到 resources/site
npm run host:fetch-story -- --adv 10610 --lang ja --out resources/site

# 直接渲染这一集（不经过 AI/TTS）
npm run host:render-story -- --site resources/site --story stories/10610.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job bdon-10610
```

编译并渲染一份本地导演脚本：

```sh
npm run host:site-story -- --site resources/site --base stories/10610.json \
  --script host/fixtures/director-demo.json --adv 90001 --lang ja --title "ライブのあとで"
npm run host:render-story -- --site resources/site --story stories/90001.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job director-demo
```

本地资源只落在 `resources/` 与 `cache/`（已忽略），仓库不重新分发游戏数据或 Live2D 运行时。

## 文档

| 主题 | 文档 |
| --- | --- |
| 无头 API、云端运行时、队列、AI、TTS、部署、安全 | [渲染宿主](docs/host.md) |
| 服务器调优与长片稳定性记录 | [宿主调优记录](docs/host-tuning.md) |
| TTS 音色表、GPT-SoVITS/Irodori、参考音频、权重/LoRA、情绪、试音 | [TTS 配置与试音](docs/tts.md) |
| 独立 AstrBot 插件：`/视频对话`、`/剧本生成` | [astrbot_plugin_ournotes_script](https://github.com/yonglanws/astrbot_plugin_ournotes_script) |
| 导演脚本、镜头/动作/听者反应、AI 分镜规则 | [导演脚本](docs/story-director.md) |
| 命令行编写、校验、构建、分镜图（实验性） | [剧情编写工具](docs/story-author.md) |
| 剧情数据结构、字体、音频、模型 | [剧情数据格式](docs/story-data-format.md) |
| 通用产品与模型格式 | [数据格式](docs/data-format.md) |
| 剧情引擎支持范围 | [剧情功能](docs/story-features.md) |
| CRI Lips 口型 | [CRI Lips](docs/crilips.md) |

## 开发与测试

```sh
npm test                  # 引擎/剧情/Live2D/导演脚本单元测试
npm run test:host         # 队列/AI/TTS/云端物化/混音/API/浏览器冒烟测试
npm run test:stories      # 官方基线/质量门/命令审计测试（缺语料或报告时按项 skip）
npm run lint              # ESLint 检查
```

更多脚本（`baseline:stories`、`eval:stories`、`audit:stories`、`audit:frames`）与端到端环境变量设置见[渲染宿主](docs/host.md#测试)。

## 许可

本项目基于 [empty-sekai/ournotes-player](https://github.com/empty-sekai/ournotes-player)（AGPL-3.0-only）。游戏资源、商标、Live2D Cubism Core、LLM 与 TTS 服务分别受各自许可约束；本仓库不附带这些资源。
