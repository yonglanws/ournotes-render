# 无头渲染宿主（Our Notes 风格 Live2D 视频 API）

本仓库只保留**视频渲染框架**：无头、纯 API 的 Our Notes 风格剧情视频渲染器。它接收一句场景描述或一份
`ournotes.story-script/1` 导演脚本，在后端完成 **AI 分镜与剧本 → TTS 配音 → 编译 Our Notes 剧情 → 无头浏览器
逐帧渲染 → 音频混合 → MP4**，通过 HTTP 返回视频。浏览器播放器、谱面播放、UI 预览、AstrBot 插件等无关功能已移除；
任何机器人或客户端只需要调用 HTTP API。

与 [MySekaiStoryteller-API](https://github.com/yuntian/MySekaiStoryteller-API) 的对应关系：

- **画风与引擎是 Our Notes**：直接运行本仓库的 `StorySession`（游戏自己的 13:6 对话 UI、Live2D 着色器、舞台、
  相机与字体），不是 Project SEKAI 的 PixiJS 渲染器。
- **队列、AI 写作、TTS 全部在后端**：客户端不配置 LLM/TTS，也不维护队列。TTS 音色表是本项目自己的格式
  （`tts.defaultVoice` + `tts.voices` / `voices.yaml`），不读取 AstrBot 等外部机器人的配置；见 [TTS 配置与试音](tts.md)。
- **确定性渲染**：无头页面以固定 1/30 秒步进推进剧情，只在虚拟时间轴上取帧；音频由页面上报的播放事件在
  后端重建，不依赖实时录音速度。
- **导演脚本**：AI 不只写台词，还写镜头焦点、远近、横向平移、Live2D 动作/表情、听者反应、黑场和留白。提示词
  按官方剧情的实测节奏（双人戏 36~44 句、每 3~4 句切一次、约 1.1 个动作/句、表情挂在动作上、双人戏常用
  `lookAt`）和 30 部官方剧情的镜头分布编写。格式与规则见 [导演脚本](story-director.md)。

## 目录

- `host/`：宿主源码（纯 ESM，Node 22+）
- `host/ai/`：提示词、AI 剧本编写、可选分镜计划、校验与自动修复
- `host/tools/fetch-story.mjs`：下载一集公开剧情站点（剧情、UI/字体、音频、Live2D 模型），或按角色补齐模型
- `host/tools/render-story.mjs`：不经过 AI/TTS，直接把一集现有剧情渲染成 MP4
- `host/tools/site-story.mjs`：把导演脚本编译到站点格式的剧情站点（`ournotes.story-manifest/2`）
- `host/tools/ai-site-story.mjs`：让 AI 直接为站点格式写导演脚本、合成 TTS 并编译
- `host/tools/check.mjs`：`npm run check`，检查配置、站点、ffmpeg、Chrome、音色
- `host/tools/tts-check.mjs`：`npm run tts:check`，列出音色并逐角色试音
- `astrbot_plugin_ournotes_script/`：AstrBot 插件，`/剧本生成` 调用宿主的剧本接口并返回预览 + JSON
- `src/story/`、`src/live2d/`、`src/engine/`：剧情引擎、Live2D 运行时与渲染内核
- `scripts/story-author.mjs`：命令行编写/校验/构建/预览分镜图
- `config.example.yaml`：配置示例（标了必须修改的几处）
- `voices.example.yaml`：角色音色表模板
- [TTS 配置与试音](tts.md)：音色、权重、情绪、翻译、试音与常见问题
- `host/tests/`：队列、AI、TTS、混音、API、无头浏览器与真实站点测试

## 前置条件

| 需要 | 用途 | 说明 |
| --- | --- | --- |
| Node.js 22+ | 宿主 | 与引擎一致 |
| Chrome / Chromium / Edge | 无头渲染 | 宿主自动查找；`render.chrome` 可指定 |
| ffmpeg | 编码/解码 | 根目录 `npm install` 安装 `ffmpeg-static` 即自带；也可 `video.ffmpegPath` 指定 |
| 剧情站点 | 游戏资源 | `paths.site` 指向 nnnotes 的 `nnnotes.product/1` 站点（完整渲染）；只有 bdon 站点时用 `paths.siteFormat` 提供剧本生成 |
| Live2D Cubism Core | Live2D | `render.core` 指向本地 `live2dcubismcore.min.js` 或 URL |
| OpenAI 兼容 LLM | AI 剧本 | `llm.baseUrl` / `llm.model`，密钥只从环境变量读取 |
| GPT-SoVITS 兼容 TTS | 配音 | `tts.baseUrl`；没有 TTS 也能渲染无声/仅有 BGM 的视频 |

**仓库不附带游戏资源。** 站点有两种格式，用途不同：

- **AI 队列/剧本生成的站点**：用你自己的游戏文件通过 [nnnotes](https://github.com/MetaSekaiLab/nnnotes) 构建，
  产物格式 `nnnotes.product/1`，由本仓库 0.2 引擎读取；`paths.site` 指向它，`/api/v1/generate` 才能工作。
- **没有产品站点时仍可生成剧本**：把 `paths.siteFormat` 指向 `fetch-story` 下载的 bdon 站点（如
  `resources/site`），`/api/v1/script/generate` 会从该站点的舞台、BGM、模型和角色卡生成导演脚本；完整渲染仍走
  `render-story` / `site-story`，或另外配置 `paths.site`。
- **现成剧情/站点格式的站点**：[bdon.moe 剧情播放器](https://bdon.moe/tools/story-player)发布的公开站点
  （`ournotes.story-manifest/2`）。`fetch-story` 下载一集剧情、UI/字体/音频与 Live2D 模型；
  `render-story` 用 `ournotes-player@0.1.8`（bdon.moe 播放器使用的同一引擎）直接渲染；
  `site-story` 可以把同一份导演脚本编译成这个站点格式的新剧情。

下载内容写入 `resources/`，已被 `.gitignore` 排除，不会提交到仓库。没有站点时 `/api/v1/health` 仍可用，但
`/api/v1/generate` 会返回 503。

## 下载资源并渲染示例

最省事的“下载资源并渲染”路径不需要自己构建站点，也不需要 AI/TTS：

```sh
npm install     # 根目录一次安装（host 是 workspace）

# 1. 下载一集剧情（默认从 https://storage.bdon.moe/moenotes 读取）。--adv 是剧情编号，
#    可在 https://bdon.moe/tools/story-player 的剧情列表里找到；这里用 10610「ライブ後」。
node host/tools/fetch-story.mjs --adv 10610 --lang ja --out resources/site

# 2. 直接渲染这集剧情（13:6、30fps、带原版 BGM/SE/语音）
node host/tools/render-story.mjs --site resources/site --story stories/10610.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job bdon-10610
```

完整索引在 `https://storage.bdon.moe/moenotes/stories.json`（约 975 部，含标题、章节、命令数与语言），
用 `--adv <id>` 下载对应集；`--lang` 选择 UI/字体语言，剧情文本行通常自带五种语言。

`fetch-story` 会：
- 校验站点 URL（仅 http/https，拒绝 localhost/环回/私有/保留地址，并校验 DNS 与每次重定向）；
- 下载 `stories/<advId>.json`、公共文件、所选语言组（UI、字体、字体图集、文本）以及所有 Live2D 模型清单及其文件；
- 保持资源的内容寻址布局（`assets/<sha256>.<ext>[.gz]`），重复运行只补齐缺失文件；
- 把这一集合并进 `stories.json` / `models.json`，保留已经下载的其他集与模型，并更新 `site.json`；
- 把 Live2D Cubism Core 与 MotionSync Core 存到 `<site>/vendor/`，两者都不进 Git。

### 补齐其他角色的模型

`--adv` 只下载那一集剧情实际用到的模型。bdon 的全局模型索引（`<base>/models.json`）有 194 个条目，覆盖每套服装；
用 `--characters` 按角色 key 补一套首选服装（校园冬季 → 虚拟 → 便服 → Live 的顺序自动挑，跳过
still/mask/hat/child），下载模型清单和内容寻址资源，并合并进本地的 `models.json` / `site.json`：

```sh
node host/tools/fetch-story.mjs --out resources/site \
  --characters chieri,hotaru,houka,mahoro,miku,shizuku,yomogi,raika,uika,umiri,nyamu,sub_viola,sub_kanata,sub_mortis
```

角色 key 取自模型 id（`adv_live2d_<key>_<number>_...`，副角色是 `sub_<key>`）；也可以直接传完整模型 id
指定某一套服装。重复运行会跳过已存在的资源。

`render-story` 不经过队列、LLM 或 TTS：它把站点清单交给页面，页面加载站点格式引擎，跑完整的
`StorySession`（场景、Live2D、UI、音频事件），宿主再混音并编码 MP4。输出在 `output/<job>.mp4`。
加 `--max-duration 20` 可以只渲染前 20 秒做快速检查。

### 渲染一份导演脚本（镜头 + 动作 + 听者反应）

`host/fixtures/director-demo.json` 是一份 9 句台词的连续场景导演脚本，包含：

- 三个角色、一个舞台、BGM；用 `positions` 换组，不反复 fade；
- `focus` 的构图点 2/5/6 + `camera: near/middle/far/close` + `track` 横移 + 一次 `zoom` 慢推；
- 台词开始前的听者反应（`actions` 的 `at: 0`），以及一次台词中段反应；
- `lookAt` 视线、`pause` 呼吸、无台词反应镜头（`action`）。

把它编译到下载好的站点并渲染：

```sh
node host/tools/site-story.mjs --site resources/site --base stories/10610.json \
  --script host/fixtures/director-demo.json --adv 90001 --lang ja --title "ライブのあとで"

node host/tools/render-story.mjs --site resources/site --story stories/90001.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job director-demo
```

`site-story` 会：

- 从底本读取舞台、BGM、模型、动作、表情，校验脚本；
- 编译成新的 `episode.json`（包含 `Focus`、`Track`、`Motion`、`Expression`、`LookTarget`、`Talk` +
  `HostActions`、`Delay`、`FadeOut/FadeIn` 等官方命令）；
- 把字体产品切换为 browser-font 模式，让脚本里的新台词不会因字体图集缺字而变成方块；
- 写 `stories/<adv>.json`、内容寻址的 episode 资源，并更新 `stories.json`。

示例输出约 35.1 秒、1054 帧、1300×600、30fps、带 BGM。`--list` 可列出站点可用的舞台、BGM、模型、动作和表情：

```sh
node host/tools/site-story.mjs --site resources/site --base stories/10610.json --list --lang ja
```

### 让 AI 直接写站点格式的剧情

如果只有下载好的 bdon 站点、没有 nnnotes 产品站点，可以用 `ai-site-story`：它把站点的舞台、BGM、模型、动作、
表情（带语义说明）做成 AI 目录，让模型直接写导演脚本，然后用内置 TTS 逐句合成，把 WAV、cue sheet 和
`VoiceIDs`/`voiceCues` 写回站点，最后用 `site-story` 编译。`llm.pipeline` 默认 `staged`：先选角，再只带选中角色的
完整人格写台词，最后单独写分镜/动作/BGM；台词逐字保留，修复轮只重写分镜。`llm.directorPlan` 只对
`pipeline: single` 有效。`tts.emotion` 打开时，LLM 会先给每句选情绪标签，再按角色的 `emotions` 参考音频或全局
`speedFactor`/`temperature` 预设合成。

站点格式的 AI 目录按 `story.personaDirs` 的角色卡列出全部可用模型（每个角色一套服装，底本用过的优先），所以
可以写跨乐队剧情；`story.cast` 仍可限定只从某个乐队选。跨乐队角色如果没有在 `tts.voices`/`voicesFile` 里配参考
音频/权重，会落回 `tts.defaultVoice`，听起来会是同一个默认音色；API 结果的 `tts.fallbackSpeakers` 会列出这些角色。

```sh
node host/tools/ai-site-story.mjs --site resources/site --base stories/10610.json --lang ja \
  --prompt "ライブのあと、灯と愛音と爽世が次の演奏について話す" --adv 90002 --minutes 2
```

输出会打印新剧情 manifest、生成的脚本 JSON 路径和行数；之后用 `render-story` 渲染。它能写的演出与 HTTP 队列
相同：`focus`（角色/站位/构图点 1~9）、`camera`、`track`、`lookAt`、`motion`/`expression`、台词前/中的
`actions`、`fade`/`pause`/`action`。

> 资源版权归 Bushiroad / Craft Egg / Ishimori 所有；下载脚本只用于本地、非商业的渲染测试。Live2D Cubism Core
> 与 MotionSync Core 受 Live2D 自己的许可约束；仓库不重新分发它们。

## 安装与启动

```sh
git clone https://github.com/empty-sekai/ournotes-player.git
cd ournotes-player
npm install                       # 根目录一次安装；host 是 npm workspace
cp config.example.yaml config.yaml
# 编辑 config.yaml 中标了 ← 的 paths.site / paths.siteFormat / llm / tts
npm run check                     # 配置、ffmpeg、Chrome、站点、音色
npm start                         # API: http://127.0.0.1:9881
```

`npm run check` 会一次列出所有配置问题和修复方向（包括拼错的配置项、缺失的站点/音色/密钥、不可用的
ffmpeg/Chrome）。TTS 音色很多时，把 `tts.voicesFile` 指向 `voices.yaml`（模板见 `voices.example.yaml`），
再用 `npm run tts:check` 试音；完整说明见 [TTS 配置与试音](tts.md)。

启动后：

```sh
curl http://127.0.0.1:9881/api/v1/health
```

`health` 会报告站点、ffmpeg、浏览器、LLM、TTS（音色数量/默认音色）和队列状态。`ffmpeg-static` 首次安装会下载
对应平台的二进制；如果安装脚本被 npm 策略或网络拦截，可执行 `npm install --ignore-scripts` 后把
`video.ffmpegPath` 指向系统 ffmpeg，或设置 `OURNOTES_FFMPEG`。

## 快速调用

### 一句话生成视频（同步）

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"放学后的教室里，灯和爽世聊起下次 Live","timeout":1800000}'
```

成功返回：

```json
{
  "success": true,
  "message": "Video exported successfully",
  "videoPath": "D:\\...\\output\\task-...mp4",
  "storyPath": "D:\\...\\output\\task-...story.json",
  "fileSize": 5242880,
  "duration": 41.2,
  "frameCount": 1236,
  "downloadUrl": "/api/v1/download/task-...mp4",
  "storyDownloadUrl": "/api/v1/download/task-...story.json",
  "tts": { "enabled": true, "lines": 24, "voiced": 24, "voices": { "高松灯": 18, "长崎素世": 6 },
           "fallbackLines": 0, "silentLines": 0, "failedLines": 0 },
  "warnings": [],
  "timings": { "totalMs": 95000, "renderMs": 41000 },
  "story": { "title": "…", "language": "zh-Hans", "lines": 24, "cast": [] }
}
```

### 异步任务（推荐给机器人）

```sh
# 提交
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"…","wait":false,"timeout":1800000}'
# -> {"success":true,"taskId":"task-…","status":"queued",...}

# 轮询
curl -sS http://127.0.0.1:9881/api/v1/tasks/task-…
# status: queued | running | completed | failed | cancelled
# phase: casting | dialogue | storyboard | writing | synthesizing | compiling | rendering | mixing | encoding | done
#        （staged 管线用 casting/dialogue/storyboard；single 管线用 writing/planning）
# progress: 0..1
```

`completed` 时 `result` 与同步响应相同。`POST /api/v1/tasks/<id>/cancel` 取消排队或运行中的任务。

### 渲染现成剧本

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/render \
  -H 'Content-Type: application/json' \
  --data-binary @request.json
# request.json: {"script": { "format": "ournotes.story-script/1", ... }, "tts": true}
```

`script` 的完整字段见[导演脚本](story-director.md)和[剧情编写工具](story-author.md)。宿主会先校验并自动修复
已知问题（近似名称、重复 id、冲突站位），无法修复时返回 400 和 JSON Pointer 错误列表。

### 只校验剧本

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/script/check \
  -H 'Content-Type: application/json' \
  -d '{"script": { ... }}'
```

返回 `{ok, errors, warnings, script}`；`script` 是套用自动修复后的文档。

## API 一览

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/health` | 服务、站点、ffmpeg、浏览器、LLM/TTS、队列；不需要鉴权 |
| GET | `/api/v1/status` | 队列摘要 + 最近 50 个任务 + 产物数量 |
| POST | `/api/v1/generate` | 一句话/剧本生成视频；`wait:false` 返回 202 |
| POST | `/api/v1/render` | 与 generate 相同（语义上用于现成剧本） |
| POST | `/api/v1/script/generate` | 只用 AI 写剧本并返回 JSON（不配音、不渲染） |
| POST | `/api/v1/script/check` | 校验/修复 `ournotes.story-script/1` |
| GET | `/api/v1/tasks` | 最近任务列表 |
| GET | `/api/v1/tasks/:id` | 任务状态、阶段、进度、排队位置、结果 |
| GET | `/api/v1/tasks/:id/status` | 同上（别名） |
| POST | `/api/v1/tasks/:id/cancel` | 取消任务 |
| GET | `/api/v1/resources` | 站点目录：底本、舞台、音乐、音效、模型、动作、表情、音色名、人格名 |
| GET | `/api/v1/files?page=&limit=&sort=` | 分页列出 `paths.output` 中的 `.mp4` / `.json` |
| GET | `/api/v1/download/:filename` | 下载产物 |
| POST | `/api/v1/cleanup` | 立即清理超过 `queue.outputMaxAgeHours` 的产物 |
| GET | `/api/v1/cleanup/stats` | 清理策略与累计统计 |

### 请求字段（generate / render）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string | 场景/剧情要求；与 `script` 二选一 |
| `script` | object | 完整的 `ournotes.story-script/1`；优先于 `prompt` |
| `base` | string | 底本 manifest，如 `stories/10002.json`；默认 `story.base` 或站点第一篇 Normal |
| `language` | string | `ja` / `en` / `zh-Hant` / `zh-Hans` / `ko` |
| `title` | string | 标题；留空由 AI 取 |
| `targetMinutes` | number | 目标时长，默认 `story.targetMinutes` |
| `maxLines` | number | 台词条数上限，默认 `story.maxLines` |
| `tts` | boolean | 本条任务是否配音，默认 `true` |
| `wait` | boolean | 默认 `true` 同步等待；`false` 立即返回 202 |
| `timeout` | number | 同步等待上限（毫秒），含排队；到点取消任务 |
| `priority` | number | 队列优先级，越大越先执行 |
| `userId` | string | 仅用于日志/公平性观测 |

## 配置

完整注释见 [config.example.yaml](../config.example.yaml)。要点：

| 配置 | 说明 |
| --- | --- |
| `paths.site` | nnnotes 产品站点目录（`/api/v1/generate` 完整渲染必需） |
| `paths.siteFormat` | bdon 站点格式目录；没有产品站点时让 `/api/v1/script/generate` 仍可生成剧本 |
| `paths.output` / `paths.cache` | 成片、故事 JSON、TTS 缓存 |
| `story.base` / `story.language` | 默认底本与语言；留空自动选择 |
| `story.cast` | 提供给 AI 的角色白名单（模型 id 或 character） |
| `story.maxOnStage` | 同台人数上限：3（默认，官方群像 `far-left/center/far-right` + `camera: far`）或 2（严格两人，第三人换组进出） |
| `story.personaDirs` | 角色卡目录：每个 `*.md` 一位角色，按文件名/标题/日文名/罗马音匹配模型；staged 只把入选角色的完整角色卡放进台词轮 |
| `story.personas` | 单条人格覆盖；与目录里的角色卡同名时覆盖它 |
| `llm.pipeline` | `staged`（默认：选角 → 台词 → 分镜三轮，完整角色提示词只进台词轮）或 `single`（一次写完整剧本） |
| `llm.directorPlan` | 仅 `single`：先让 AI 写分镜计划再写完整剧本（默认关） |
| `llm.*` | OpenAI 兼容端点、模型、温度、重试；`apiKeyEnv` 只给环境变量名 |
| `tts.defaultVoice` | 没有单独音色的角色使用的参考音频：`refAudioPath` / `promptText` / `promptLang` |
| `tts.voicesFile` | 角色音色表文件（本项目自己的格式，模板见 `voices.example.yaml`）；路径相对仓库根目录 |
| `tts.voices` | 内联音色条目；与 `voicesFile` 同名时按字段覆盖、`aliases` 合并 |
| `tts.*` | GPT-SoVITS 端点、语言、语速/采样参数、`fragmentInterval`、并发、重试、失败策略 |
| `tts.required` | `true` = 任一句合成失败就让任务失败；`false`（默认）= 该句静音并写入 warnings |
| `tts.emotion` | 情绪的标签、全局语速/温度预设；角色的情绪参考音频写在 `voices[].emotions` |
| `video.*` | 分辨率、30fps、JPEG 中间质量、CRF、编码器、音频码率、最大时长 |
| `render.*` | Chrome 路径、GPU/软件渲染、Cubism Core、超时 |
| `queue.*` | 并发、队列容量、任务超时、产物保留 |
| `security.apiKeyEnv` | 非空时 API 需要 `Authorization: Bearer <env 值>` |
| `server.cors` / `server.corsOrigins` | 打开 CORS 并给出精确来源白名单；不使用 `*` |

### 密钥

**配置文件里没有可用的密钥字段。** 宿主只读取 `*Env` 指向的环境变量：

- `OURNOTES_LLM_API_KEY`：LLM 密钥
- `OURNOTES_API_KEY`：API 访问令牌（可选）
- `OURNOTES_TTS_API_KEY`：TTS 服务密钥（可选，取决于你的 GPT-SoVITS 部署）

这些值不会出现在 `/health`、日志或剧本 JSON 中。

## 渲染管线

1. **AI 剧本**（`llm.pipeline: staged`，默认）：三次调用。① 选角：只给角色/舞台清单和用户要求，输出标题、小事件、
   2~3 名角色及各自在本场的作用、4~6 条大纲；结果不可用时回退到站点角色顺序。② 台词：只带选中角色的完整
   `story.personas`、句式参考和大纲，输出 `{ lines: [{ id, say, text }] }`，这一轮看不到动作/镜头/BGM 清单。
   ③ 分镜：输入定稿台词、选中角色的动作/表情、舞台和 BGM，输出只引用 `line` id 的演出 beat。合并时台词逐字取
   第二轮，第三轮即使写了 `say`/`text` 也只取演出字段。`pipeline: single` 退回一次整本生成；此时
   `llm.directorPlan` 可先写一份短计划（默认关）。
2. **校验与修复**：两条管线都经过 JSON 提取 → 结构校验 → 已知问题自动修复 → 最多 `llm.repairRounds` 轮定向修复。
   staged 的修复轮只重发分镜提示词，台词稿固定在上下文里，所以修几轮都不会把台词改坏。校验器与
   [剧情编写工具](story-author.md)共用同一套规则。站点格式的 AI 目录列出所有“有角色卡或已知名字”的模型，每个角色只取
   一套服装（底本用过的优先），因此可以写跨乐队剧情；用 `story.cast` 可以限定只从某个乐队选。staged 合并按本场
   官方预算修剪过量的 focus/视线剪辑点，并把换行比例调整到官方约 38% 两行（只在现有标点后移动换行，不改字词）；
   分镜修复后仍不可用时会退回「默认走位 + 无动作演出」。
3. **TTS**：按台词逐句调用 GPT-SoVITS（可并发、磁盘缓存、可重试、失败降级；切换角色权重时串行）。角色音色来自
   `tts.defaultVoice` / `tts.voices` / `voicesFile`，不再读取 AstrBot 或其它外部配置；完整字段、匹配规则和试音步骤
   见 [TTS 配置与试音](tts.md)。`tts.textLang` 默认 `auto`（跟随剧本语言）；设为具体语言（如 `ja`）且与剧本语言不同
   时，先用 LLM 批量翻译。`tts.emotion.enabled` 打开时，一次 LLM 调用给每句选情绪标签，角色的 `emotions` 参考音频
   会覆盖 `refAudioPath`；没有情绪参考时，全局 `presets` 用 `speedFactor`/`temperature` 做语气差异。每句 WAV 被编译
   成一个 `story.sound` 产物，Talk 行写入 `VoiceIDs`；产品站点路径还写入 `Parameter1: "airlipsync_voice"`（宿主扩展）：
   既播放该句 TTS 语音，又按游戏自带的 timed pseudo lip sync 让嘴型在打字/整句期间运动；语音结束时嘴闭合。站点格式
   路径写入 `VoiceIDs`/`voiceCues`，由页面解码波形给 MotionSync。API 结果的 `tts` 会报告实际使用的音色、回落到默认
   音色的句子、静音句子和失败句子对应的角色。
4. **编译**：`Site.compose` 把剧本编译成底本的 `episode.json`/`story.json`，只替换故事、字体与 TTS 音轨；
   舞台、UI、着色器、BGM 仍来自底本站点。`focus` 编译成 `Focus`（角色/站位/构图点），`track` 编译成 `Track`；
   `at: 0` 的 `actions` 编译成 Talk 前的 `Motion`/`Expression`/`LookTarget`，台词中的 `actions` 编译成 Talk 行的
   `HostActions`；`fade`/`pause` 编译成 `FadeOut`/`FadeIn`/`Delay`。
5. **逐帧渲染**：无头 Chrome 通过 CDP 打开页面，`StorySession` 以固定 1/30 秒步进，`auto: true` 自动推进；
   每帧 `render()` 后把 canvas 编码成 JPEG POST 给宿主。**不按墙钟播放音频**，因此渲染速度不影响成片时间轴。
   `Talk` 在虚拟时钟上按正文比例调度 `HostActions`，动作/表情不会因为渲染快慢而漂移。
6. **音频重建**：页面用自定义 `SilentAudio` 记录每次 `play/stop` 的游戏时间、cue、循环点、淡入淡出；
   宿主用 ffmpeg 把 cue 解码成 PCM，在 48 kHz 立体声时间轴上混合 BGM/SE/配音，写入 WAV。
7. **编码**：ffmpeg 以 `fps` 读取 JPEG 序列，加 AAC 音轨，按 `encoder` 尝试 NVENC / AMF / QSV，失败回退
   `libx264`，输出 `+faststart` 的 MP4。

### 为什么是 30 fps

`StorySession` 的固定步长是 `STORY_FRAME_RATE = 30`（`src/story/interfaces.js`）。输出 30 fps 时一帧对应一步，
时间轴最准确；其他帧率按整数步抽取或重复，默认不建议修改。

### Our Notes 风格从哪里来

画面完全由 `src/story/` 的 ADV 播放器产生：13:6 视口、游戏自己的对话框/立绘定位/相机/背景着色器/Live2D 材质。
宿主只负责驱动、取帧、配音与封装，不重画 UI。

## 部署与安全

- API 默认只监听 `127.0.0.1:9881`，且**默认没有鉴权**。需要对外提供服务时，设置 `security.apiKeyEnv` 指向一个
  令牌环境变量，或只让反向代理访问；`npm run check` 会在监听非回环地址且没有令牌时给出警告。
- 渲染页面服务器只绑定 `127.0.0.1`，随机端口，任务 id 随机；页面只能读取 `/src`、`/host/render`、UI 测试模块、
  `/site-engine/`（按 Node 解析到的 `ournotes-player-site` 包）与当前站点，路径经过规范化，拒绝 `..`。
- CORS 默认关闭；需要浏览器直连时设 `server.cors: true`，并在 `server.corsOrigins` 写精确来源，不支持通配符。
- 宿主对**调用方提供的 URL**执行严格 SSRF 校验（仅 http/https、拒绝 localhost/环回/私有/保留地址，并校验 DNS
  解析结果）。LLM/TTS 属于运维配置，默认也拒绝私有地址；本地/内网 GPT-SoVITS 需要在
  `security.allowPrivateServiceEndpoints: true` 显式打开。
- 产物按 `queue.outputMaxAgeHours` 清理；下载文件名只允许单段安全字符，目录查询基于目录列表而非拼接路径。
- 游戏资源、Live2D Cubism Core、LLM 与 TTS 服务的使用分别受各自许可约束；本宿主不附带这些资源。

## 测试

```sh
npm test                     # 引擎/剧情/Live2D/导演脚本单元测试
npm run test:host            # 队列/AI/TTS/混音/API/浏览器冒烟
OURNOTES_SKIP_BROWSER=1 npm run test:host   # 没有 Chrome 的机器
```

浏览器冒烟测试会启动一次真实的 headless Chrome，画 10 帧并编码 MP4，不需要游戏站点。
真实剧情渲染需要一个配置好的站点，可参考 `host/tests/e2e-render.test.mjs`：

```sh
OURNOTES_E2E_SITE=/path/to/site \
OURNOTES_E2E_CORE=/path/to/live2dcubismcore.min.js \
node --test host/tests/e2e-render.test.mjs
```

没有站点时，可以先用公开站点做一次真实的端到端渲染：

```sh
node host/tools/fetch-story.mjs --adv 10610 --lang ja --out resources/site
node host/tools/render-story.mjs --site resources/site --story stories/10610.json \
  --max-duration 10 --out output --job check-site
```

`--max-duration` 只截取前若干秒，适合确认浏览器、Live2D、UI、字体和音频都正常。
下载好站点后，也可以跑站点格式的端到端测试（渲染 8 秒并解码 MP4）：

```sh
OURNOTES_E2E_SITE=resources/site \
OURNOTES_E2E_CORE=resources/site/vendor/live2dcubismcore.min.js \
OURNOTES_E2E_STORY=stories/10610.json OURNOTES_E2E_LANG=ja \
node --test host/tests/e2e-site.test.mjs
```

导演脚本的端到端测试会把 `host/fixtures/director-demo.json` 编译到站点，渲染 12 秒并检查 `Focus` / `Track` /
`LookTarget` / `HostActions`：

```sh
OURNOTES_E2E_SITE=resources/site \
OURNOTES_E2E_CORE=resources/site/vendor/live2dcubismcore.min.js \
node --test host/tests/e2e-director.test.mjs
```

### 固定场景 AI 评估与命令审计

`scripts/stories/ai-eval.mjs` 用固定的 8 个双人场景离线调用 `StoryWriter`，逐场编译、做命令审计并计算与官方语料
相同的指标。场景和中文 logline 直接写在源码里（改动 logline 等于换评估基线）：

| # | label | 场景 |
|---|---|---|
| 1 | `rain-stop` | 雨后便利店屋檐下等雨停，一人想走，一人想再待一会儿 |
| 2 | `lost-ticket` | 检票口找不到车票，另一人嘴上不管却蹲下一起找 |
| 3 | `last-rehearsal` | 熄灯前为一句和声反复磨合，一人失去耐心，一人坚持再来 |
| 4 | `shared-snack` | 深夜厨房最后一份点心推来推去，谁也不肯先吃 |
| 5 | `one-umbrella` | 放学突然下雨只有一把伞，两人挤在伞下谁都不走快 |
| 6 | `before-stage` | 演出前十分钟一人在后台紧张失语，另一人笨拙地让她开口 |
| 7 | `missing-earring` | 更衣室少了一只耳环，一人安慰，一人翻遍每个角落 |
| 8 | `last-train` | 末班车进站前聊起明天，广播响了谁都没有先动 |

```sh
# 必需：站点格式的底本目录；报告写到仓库外（默认 <workspace>/../ournotes-ai-lab）
OURNOTES_CONFIG=/path/to/ournotes-player/config.yaml \
OURNOTES_SITE_FORMAT=/path/to/ournotes-player/resources/site \
OURNOTES_AI_LAB=/path/to/ournotes-ai-lab \
npm run eval:stories -- --run phase1 --pipeline staged --temperature 0.8
```

- `--run <name>`：报告目录名，必填，只允许字母、数字、`.`、`_`、`-`。
- `--prompts all|1,2,...`：选择固定场景（1 起始）；`--runs N` 将每个选中场景重复 N 次，标签追加 `-runN`。
- `--pipeline staged|single`、`--temperature`、`--target`：覆盖本次运行。`targetMinutes` 默认 2 分钟、`--target` 可改；
  `maxLines` 取操作者配置并最多 36 行（2 分钟基线）。固定的还有 `repairRounds: 2`、`translateForTts: false`、
  `jsonMode: "auto"`、`maxTokens: 16384`、`timeoutMs: 180000`、`maxOnStage: 2`。
  `llm.model`、`llm.baseUrl` 和 `llm.apiKeyEnv` 仍来自操作者配置；密钥只从环境变量读取，不写入报告。
- `OURNOTES_SITE_FORMAT` 可以是绝对路径，因此可以在 worktree 里读取主仓库的 `resources/site`，但评估不会写入站点。
- 单场超时、JSON 失败、编译失败或命令审计失败只记录该场，继续其余场景；回答被 `finish_reason=length` 截断时
  由 `StoryWriter` 内部对同一请求重试一次，评估器每场只调用一次 `StoryWriter`。分镜经修复仍不可用、退回
  「默认走位 + 无动作演出」时按失败场记录（该场没有可验收的演出）。成功场数与失败列表分开写入。

报告目录：

```text
runs/<run>/<label>.story.json     该场最终脚本（ournotes.story-script/1）
runs/<run>/<label>.report.json    该场 latency/usage/warnings/summary/compiled counts；失败场记录 error
runs/<run>/<label>.raw.txt        最后一次模型回复（分镜修复或降级时用于诊断，不含提示词和密钥）
runs/<run>/all-stories.json       label -> 脚本
runs/<run>/report.json            generatedAt、脱敏配置、逐场结果、仅成功场的 aggregate、failures
```

质量门读取一次命名 run 的报告；报告未设置或不存在时按明确原因 skip，不当作通过：

```sh
OURNOTES_EVAL_REPORT=/path/to/ournotes-ai-lab/runs/phase1/report.json npm run test:stories
```

门禁检查每场 `summary.count >= 28`、`charsTotal >= 400`、`warnings` 与 `compiled.commands` 存在；聚合区间为
`charsMean 12..19`、`twoLineShare 0.25..0.50`、`shortShare 0.12..0.30`、`soloRunShare 0.58..0.82`、
`focusPerLine 0.30..0.50`、`motionsPerLine 1.0..1.5`、`lookAnyPerLine 0.20..0.42`、`zoomPerLine 0.03..0.16`、
`pedestalPerLine 0.04..0.15`、`panV2PerLine 0.05..0.18`、`sePerLine 0.04..0.16`，并要求 `Zoom` / `Pedestal` /
`PanV2` / `DoF` / `Look` / `Se` 至少各编译出一条。聚合只统计成功场；不要为了通过而放宽区间。

已编译 episode 的命令审计可以单独运行（检查 `i`/`raw`/`commandCount`、注册命令、参数区间、SE 资源闭合、
`HostActions` 里的 `LookTargetPosition` 和 required-command 清单，失败时退出码为 1）：

```sh
npm run audit:stories -- --episode output/phase1/episode.json \
  --site resources/site --base stories/10438.json --manifest output/phase1/stories/99001.json
```

必须提供 `--manifest`（含 `requires.commands`）或含 `commands` 的 `--story`；缺少 required-command 清单时
审计直接报错退出，不会在未检查命令清单的情况下打印 `ok: true`。

## 已知限制

- **HTTP AI 队列需要产品站点**（`nnnotes.product/1`）。站点格式（`ournotes.story-manifest/2`）可以用
  `host/tools/ai-site-story.mjs` 让 AI 写导演脚本、合成 TTS 并编译，或用 `site-story` 编译手写脚本，再用
  `render-story` 直接渲染。站点格式的 TTS 会写成真实 WAV cue，渲染时由页面解码给 MotionSync；不再静音。
- 导演脚本只覆盖 `scene` / `positions` / `say` / `narrate` / `camera` / `fade` / `pause` / `action`。底本
  finalize 行里的淡出等仍会执行，但作者不能逐条写任意 ADV 命令；只暴露经命令审计与抽帧验证的白名单
  （`Focus` / `Track` / `Zoom` / `Pedestal` / `PanV2` / `DoF` / `Look` / `LookTarget` / `Se` 等），
  `Track` 只作为 `camera`/`track` 字段暴露，不支持任意参数。
- `actions` 只支持动作、表情和 `lookAt`，不支持逐参数面部曲线。
- 产品站点的 AI 剧本 TTS 嘴型使用游戏的 air lip sync（按句时长），不是 MotionSync 音频分析。站点格式的
  AI/TTS 剧情和现成剧情（`render-story`）则把语音波形解码成 PCM，按虚拟时钟喂给 MotionSync Core，口型跟随真实
  语音；这条路径的音频仍由宿主按事件重建，不依赖实时播放。
- BGM/SE 来自底本故事的 cue sheet；TTS 只生成 Voice 轨。音频混合按页面上报的事件重建，线性淡入淡出，
  不逐采样复刻 WebAudio 的调度。
- 输出帧率固定以 30 为基准，其他帧率是整数抽帧。
- AI 生成质量取决于配置的 LLM；宿主只保证格式、名称、站位、镜头目标和动作合法，不保证剧情文学质量。

## 故障排除

| 现象 | 检查 |
| --- | --- |
| `/generate` 返回 503 `site_missing` | `paths.site` 是否指向含 `stories.json`/`models.json` 的产品站点；只想生成剧本时用 `paths.siteFormat` 和 `/script/generate` |
| 页面报 `Live2D Cubism MotionSync Core is not loaded` | 本管线用 `airlipsync_voice`，不需要 MotionSync；若底本模型强制要求，配置 `render.motionsync` |
| 页面报 WebGL2 不可用 | Chrome 是否支持 SwiftShader；尝试 `render.gpu: true` 或更新浏览器 |
| 渲染很慢 | 软件渲染正常；可降低 `video.width/height`、提高 `render.gpu`，或增加 `queue.concurrency` 但注意内存 |
| 视频没有声音 | `tts.enabled`、`tts.voices`/`tts.defaultVoice` 是否配置、GPT-SoVITS 是否可达；`npm run tts:check -- --synthesize`；BGM 需要底本有 `sound_bgm*` cue |
| 部分台词静音 | API 结果的 `tts.silentSpeakers` / `tts.failedSpeakers`；角色缺参考音频或服务端失败 |
| 所有角色同一个声音 | `tts.fallbackSpeakers` 列出的角色没有匹配到命名音色，落到了 `defaultVoice`；补 `aliases` |
| 配置改了没生效 | `npm run check` 会报告未知配置项（含拼写建议）和旧字段迁移提示 |
| 编码失败 | `health.ffmpeg`；`video.encoder` 先设 `libx264` 排查硬件编码器 |
| LLM 401/403 | 环境变量是否设置；`llm.baseUrl` 是否指向 OpenAI 兼容端点 |
| 队列一直等待 | `GET /api/v1/status` 看 `running/waiting`；`queue.concurrency` |
| 站点脚本新台词显示方块 | 用 `site-story` 编译（会切换 browser-font）；不要直接手改底本 episode |
| 动作/表情不生效 | 名称必须是该模型真实存在的 `mtn_*` / `exp_*`；目标必须在台上 |
