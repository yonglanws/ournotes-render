# TTS 配置与试音

宿主自己调用 GPT-SoVITS 的 `api_v2` 接口（`POST /tts`），**不再读取 AstrBot 或其它机器人的配置文件**。音色、参考
音频、GPT/SoVITS 权重和情绪参考全部写在本项目的配置里，可以单独备份、审查和迁移。

如果你原来用 AstrBot 的 GPT-SoVITS 插件，只需要把 `persona_storage` / `emotion_storage` 里的数据抄进
`voices.yaml` 一次（字段对应见文末），之后 AstrBot 怎么改都不影响本项目。

## 1. 先准备 GPT-SoVITS

- GPT-SoVITS 已启动，`api_v2` 地址类似 `http://127.0.0.1:9880` 或 `http://192.168.1.10:9880`。
- 每个角色至少有一段干净人声参考（5~15 秒），以及这段音频**逐字一致**的文本。
- 参考音频和权重路径是 **GPT-SoVITS 服务端看到的路径**。本机路径只在服务也跑在本机时才对得上。
- 需要切换 GPT/SoVITS 权重时，服务端一次只加载一组权重；宿主检测到 `gptWeightsPath`/`sovitsWeightsPath` 后会把
  并发自动降为 1。**要么每个音色都配权重，要么都不配**：没有配权重的音色会沿用服务端当前加载的权重；混配时
  `npm run check` 会警告。

## 2. 最小配置

`config.yaml`：

```yaml
security:
  allowPrivateServiceEndpoints: true   # 本地/内网 GPT-SoVITS 需要；公网服务可设 false

tts:
  enabled: true
  baseUrl: http://127.0.0.1:9880
  textLang: ja                         # 这个音色模型说的语言；auto = 跟剧本语言
  promptLang: ja                       # 参考音频的语言
  defaultVoice:
    refAudioPath: /srv/gpt-sovits/refs/default.wav
    promptText: 参考音频里说的话
  voices: []
```

只有 `defaultVoice` 时所有角色共用一个声音。要给角色分配音色，加 `voices` 或 `voicesFile`。

## 3. 角色音色

角色少时直接写在 `config.yaml`：

```yaml
tts:
  voices:
    - name: 高松灯
      aliases: [灯, 高松燈, tomori]
      refAudioPath: /srv/gpt-sovits/refs/tomori.wav
      promptText: そよちゃんだけじゃなくて、みんなとも共感できるところがあるんじゃないかって
      promptLang: ja
```

角色多时单独放 `voices.yaml`（推荐，`config.example.yaml` 里已有注释）：

```yaml
# voices.yaml
defaultVoice:
  refAudioPath: /srv/gpt-sovits/refs/default.wav
  promptText: 参考音频里说的话

voices:
  - name: 高松灯
    aliases: [灯, 高松燈, tomori]
    refAudioPath: /srv/gpt-sovits/refs/tomori.wav
    promptText: そよちゃんだけじゃなくて、みんなとも共感できるところがあるんじゃないかって
    promptLang: ja
    gptWeightsPath: /srv/gpt-sovits/models/tomori/tomori.ckpt
    sovitsWeightsPath: /srv/gpt-sovits/models/tomori/tomori.pth
    emotions:
      - label: 开心喜悦
        refAudioPath: /srv/gpt-sovits/refs/tomori-happy.wav
        promptText: うれしい！ありがとう！
        promptLang: ja
```

```yaml
# config.yaml
tts:
  voicesFile: "voices.yaml"
```

`tts.voices` 与 `voicesFile` 同时存在时，同名条目按字段覆盖：`speedFactor`、`refAudioPath` 等写到哪个字段就覆盖哪个
字段，`aliases` 合并；`emotions` 只有内联条目写了才替换。这样可以在 `config.yaml` 里临时改一个角色的语速，而不用
动 50 个角色的主表。

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 角色名；匹配时忽略空格、大小写和常见简繁/日文异体字 |
| `aliases` | 否 | 模型名、角色卡日文名、罗马音等；会与 `story.personaDirs` 里同名角色卡的别名合并 |
| `refAudioPath` | 否* | 参考音频路径；没有时回落到 `defaultVoice.refAudioPath` |
| `promptText` | 建议 | 参考音频逐字文本；写错会明显影响音色 |
| `promptLang` | 否 | 参考音频语言，默认 `tts.promptLang` |
| `gptWeightsPath` | 否 | GPT 权重；与 SoVITS 权重一起切换 |
| `sovitsWeightsPath` | 否 | SoVITS 权重 |
| `speedFactor` | 否 | 语速，0.5~2 |
| `temperature` / `topK` / `topP` | 否 | 采样参数 |
| `repetitionPenalty` | 否 | 重复惩罚，0.5~2 |
| `fragmentInterval` | 否 | 分段间隔秒数，0~2 |
| `emotions` | 否 | 每句情绪参考，见下 |

\* 没有 `refAudioPath` 且没有 `defaultVoice` 时，这个角色的台词会静音；启动日志、`npm run check` 和 API 结果都会
明确列出这些角色。

### 匹配顺序

1. 精确匹配 `name` / `aliases`（忽略空格、大小写、简繁/日文异体字）。
2. 包含匹配：`灯` 能匹配 `高松灯`，`そよ` 能匹配 `長崎そよ`。
3. 都没有时使用 `defaultVoice`，并在 API 结果的 `tts.fallbackSpeakers` 中列出。

角色卡的别名会自动补进音色：`story.personaDirs` 里的 `高松燈`、`燈`、`tomori` 能让模型名 `高松燈` 找到
`voices.yaml` 里的 `高松灯`。如果一个角色卡同时被主音色和变体音色（例如 `白祥`）匹配，只有名字与角色卡同名的
那个音色会接收别名，避免精确名字被别的音色抢走。

## 4. 情绪

打开 `tts.emotion.enabled` 后，LLM 会先给每句台词选一个标签：

- 角色 `emotions` 里有这个标签且有 `refAudioPath` → 用情绪参考音频（音色和语气都变）。
- 只有全局 `tts.emotion.presets` → 用 `speedFactor` / `temperature` 做语气差异，参考音频不变。
- 标签不在任何列表里 → 回到普通音色。

```yaml
tts:
  emotion:
    enabled: true
    labels: [日常平静, 开心喜悦, 低落悲伤]
    presets:
      - { label: 日常平静, speedFactor: 1.0, temperature: 1.0 }
      - { label: 开心喜悦, speedFactor: 1.03, temperature: 1.05 }
      - { label: 低落悲伤, speedFactor: 0.93, temperature: 0.9 }
```

情绪标注失败不会中断任务，只会回落到普通音色。

## 5. 语言与翻译

- `tts.textLang: auto`（默认）按剧本语言合成。
- `tts.textLang: ja` 且剧本是中文时，宿主先用 LLM 批量翻译成日文再合成；`llm.translateForTts: false` 可关闭。
- `textLang` 必须和**音色模型实际说的语言**一致。中文剧本配日文音色时通常设 `ja`，不要设 `auto`。

## 6. 检查与试音

```sh
npm run check                         # 配置、站点、ffmpeg、Chrome、音色数量、缺失参考
npm run tts:check                     # 列出音色表
npm run tts:check -- --voice 高松灯    # 只看一个角色
npm run tts:check -- --synthesize     # 每个音色合成一句，写到 output/tts-check/*.wav
npm run tts:check -- --synthesize --voice 高松灯 --emotion 开心喜悦
npm run tts:check -- --synthesize --voice 高松灯 --text "ありがとう！"
```

试音会显示时长；打开 `output/tts-check/` 里的 WAV 就能听。失败会打印 GPT-SoVITS 的 HTTP 状态和响应片段。

生成故事时，API 结果和 `.story.json` 会带 TTS 报告：

```json
{
  "tts": {
    "enabled": true, "lines": 24, "voiced": 24,
    "voices": { "高松灯": 18, "长崎素世": 6 },
    "fallbackLines": 0, "silentLines": 0, "failedLines": 0,
    "fallbackSpeakers": [], "silentSpeakers": [], "failedSpeakers": []
  }
}
```

- `silentLines > 0`：有角色没有参考音频；看 `silentSpeakers`。
- `fallbackLines > 0`：有角色没有匹配到命名音色，用了默认音色；看 `fallbackSpeakers`。
- `failedLines > 0`：GPT-SoVITS 请求失败且重试耗尽；看 `failedSpeakers` 和日志。

## 7. 缓存

合成结果按“文本 + 音色 + 参数 + 语言”缓存在 `paths.cache/tts/`。改参考音频、权重、语速或文本都会生成新缓存；
想强制重来直接删 `cache/tts/`。

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `TTS connection failed` | `tts.baseUrl` 不对，或 GPT-SoVITS 没启动；先 `curl <baseUrl>/` |
| `no reference audio for …` | 该角色没有 `refAudioPath`，也没有 `defaultVoice`；运行 `npm run tts:check` 看缺谁 |
| `TTS HTTP 400` 且提到参考音频 | 服务端找不到 `refAudioPath`；这是服务端路径，不是本机路径 |
| 全部台词静音 | `tts.enabled` 是否为 true、`voicesFile` 是否存在、`tts.baseUrl` 是否可达 |
| 所有角色同一个声音 | 角色名/别名没匹配上，落到了 `defaultVoice`；看 `tts.fallbackSpeakers` |
| 中文台词念得很怪 | `tts.textLang` 应与音色语言一致（如 `ja`），并确认 `translateForTts` 生效 |
| 某个角色换了音色 | 检查 `voices.yaml` 里是否有同名或别名冲突；`npm run check` 会报共享别名 |
| 切换权重后很慢 | 配了 `gptWeightsPath`/`sovitsWeightsPath` 时会串行；不配权重可并发 |

## 9. 从 AstrBot 迁移

运行时不再读 AstrBot 文件；一次性把字段抄成自己的格式：

| AstrBot 字段 | 本项目字段 |
| --- | --- |
| `persona_storage[].persona_id` | `voices[].name` |
| `persona_storage[].ref_audio_path` | `voices[].refAudioPath` |
| `persona_storage[].prompt_text` | `voices[].promptText` |
| `persona_storage[].prompt_lang` | `voices[].promptLang` |
| `persona_storage[].gpt_path` | `voices[].gptWeightsPath` |
| `persona_storage[].sovits_path` | `voices[].sovitsWeightsPath` |
| `persona_storage[].speed_factor` | `voices[].speedFactor` |
| `persona_storage[].fragment_interval` | `voices[].fragmentInterval` |
| `emotion_storage[]`（按 `persona_id` + `emotion`） | `voices[].emotions[]` 的 `label` / `refAudioPath` / `promptText` / `promptLang` |
| `default_params.ref_audio_path` / `prompt_text` | `defaultVoice.refAudioPath` / `promptText` |

AstrBot 的 `client.base_url` 不迁移：本项目用 `tts.baseUrl`，并受 `security.allowPrivateServiceEndpoints` 控制。
