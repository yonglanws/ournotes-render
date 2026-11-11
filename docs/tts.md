# TTS 配置与试音

宿主支持两个 TTS 后端，**不再读取 AstrBot 或其它机器人的配置文件**：

- `gpt-sovits`（默认）：GPT-SoVITS 的 `api_v2` 接口（`POST /tts`），权重是服务端全局状态。
- `irodori`：Irodori-TTS-Server 的 OpenAI 兼容接口（`POST /v1/audio/speech`），参考音频 / LoRA adapter /
  caption 跟着每个请求走。

音色、参考音频、GPT/SoVITS 权重或 LoRA、情绪参考全部写在本项目的配置里，可以单独备份、审查和迁移。两个后端的
字段名与 MySekaiStoryteller 的 `tts` 节一致，同一份音色表可以在两个后端之间切换。

如果你原来用 AstrBot 的 GPT-SoVITS 插件，只需要把 `persona_storage` / `emotion_storage` 里的数据抄进
`voices.yaml` 一次（字段对应见文末），之后 AstrBot 怎么改都不影响本项目。

## 1. 先准备 TTS 服务

### GPT-SoVITS

- GPT-SoVITS 已启动，`api_v2` 地址类似 `http://127.0.0.1:9880` 或 `http://192.168.1.10:9880`。
- 每个角色至少有一段干净人声参考（5~15 秒），以及这段音频**逐字一致**的文本。
- 参考音频和权重路径是 **GPT-SoVITS 服务端看到的路径**。本机路径只在服务也跑在本机时才对得上。
- 需要切换 GPT/SoVITS 权重时，服务端一次只加载一组权重；宿主检测到 `gptWeightsPath`/`sovitsWeightsPath` 后会把
  并发自动降为 1。**要么每个音色都配权重，要么都不配**：没有配权重的音色会沿用服务端当前加载的权重；混配时
  `npm run check` 会警告。

### Irodori-TTS

Irodori-TTS-Server 提供 OpenAI 兼容的 `POST /v1/audio/speech`。`tts.baseUrl` 填**服务根地址**，不要带 `/v1`：

```yaml
tts:
  provider: irodori
  baseUrl: http://192.168.1.10:8088
  irodori:
    model: irodori-tts
    responseFormat: wav
    numSteps: 40
    cfgScaleText: 3.0
    cfgScaleCaption: 3.0
    cfgScaleSpeaker: 5.0
    durationScale: 1.0
    chunkingEnabled: true
    chunkMinChars: 80
    seed: -1
```

- 每个请求自带 `ref_wav` / `ref_wavs`、`lora_adapter`、`caption`，服务端没有全局权重状态，所以并发不会被降为 1。
- 参考音频、LoRA adapter 目录同样是**服务端路径**，而且必须是 Irodori 服务进程能看到的路径。GPT-SoVITS 和
  Irodori 挂载不同时（例如 GSV 的 `/vol2/...` 不在 Irodori 的容器里），同一份 `refAudioPath` 会报
  `No such file or directory`；这种情况在 `config.yaml` 的 `tts.voices` 里写同名条目、只覆盖 `refAudioPath`
  即可（内联条目按字段覆盖 `voicesFile`）。
- Irodori **只读日文**：中文剧本会先把台词翻成日文（`llm.translateForTts`，默认开）。没有假名的句子不会送去
  合成，而是静音并计入 `tts.nonJapaneseLines`；`tts.required: true` 时这种句子会让任务失败。
- `tts.textLang` 对 Irodori 不生效，目标语言固定为 `ja`。
- 返回非 WAV（`mp3` / `ogg`）时宿主会用 ffmpeg 转成 WAV 再进音轨。

## 2. 最小配置

`config.yaml`：

```yaml
security:
  allowPrivateServiceEndpoints: true   # 本地/内网 GPT-SoVITS 需要；公网服务可设 false

tts:
  enabled: true
  provider: gpt-sovits                 # gpt-sovits | irodori
  baseUrl: http://127.0.0.1:9880       # Irodori 填服务根地址（不要带 /v1）
  textLang: ja                         # 这个音色模型说的语言；auto = 跟剧本语言（Irodori 固定 ja）
  promptLang: ja                       # 参考音频的语言
  defaultVoice:
    refAudioPath: /srv/gpt-sovits/refs/default.wav
    promptText: 参考音频里说的话
  voices: []
```

只有 `defaultVoice` 时所有角色共用一个声音。要给角色分配音色，加 `voices` 或 `voicesFile`。

切到 Irodori 只需要三处：`provider: irodori`、`baseUrl` 换成服务根地址、填上 `tts.irodori`（见上一节）。音色表里
的 `refAudioPath` 可以直接复用；要更像角色再加 `loraAdapter`，要控制语气加 `caption`。

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

Irodori 的角色块（字段与 MSST 一致；`characterName` 是 `name` 的别名，`emotion` 是 `label` 的别名）：

```yaml
# voices.yaml
voices:
  - characterName: 晓山瑞希
    loraAdapter: /srv/Irodori-TTS/models/LoRA/PJSK/晓山瑞希/lora_adapter
    refAudioPath: /srv/Irodori-TTS/models/LoRA/PJSK/晓山瑞希/emotion_refs/main.wav
    caption: 落ち着いた、穏やかな口調で話している。
    numSteps: 32
    emotions:
      - emotion: 开心
        refAudioPath: /srv/Irodori-TTS/models/LoRA/PJSK/晓山瑞希/emotion_refs/happy.wav
        caption: 明るく、優しい口調で話している。
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
| `refAudioPaths` | 否 | Irodori：多条参考音频；非空时发 `ref_wavs`，不再发 `ref_wav` |
| `loraAdapter` | 否 | Irodori：PEFT LoRA adapter 目录（服务端路径） |
| `caption` | 否 | Irodori：表演描述（日语）；不填时依次用 `promptText`、`tts.irodori.defaultCaption` |
| `speed` | 否 | Irodori：角色语速，0.25~4；不填用 `tts.speedFactor` |
| `numSteps` | 否 | Irodori：角色级推理步数；不填用 `tts.irodori.numSteps` |
| `speedFactor` | 否 | GPT-SoVITS 语速，0.5~2 |
| `temperature` / `topK` / `topP` | 否 | GPT-SoVITS 采样参数 |
| `repetitionPenalty` | 否 | GPT-SoVITS 重复惩罚，0.5~2 |
| `fragmentInterval` | 否 | GPT-SoVITS 分段间隔秒数，0~2 |
| `emotions` | 否 | 每句情绪参考，见下；Irodori 情绪条目也接受 `refAudioPaths` / `loraAdapter` / `caption` / `speed` / `numSteps` |

`characterName` 可以代替 `name`，情绪条目的 `emotion` 可以代替 `label`：MSST 的角色块基本可以原样粘贴。两个后端
共用一张表：GPT-SoVITS 忽略 Irodori 字段，Irodori 忽略权重和 `promptText`。

\* 没有参考音频（`refAudioPath` 或 `refAudioPaths`）且没有 `defaultVoice` 时，这个角色的台词会静音；启动日志、
`npm run check` 和 API 结果都会明确列出这些角色。

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

Irodori 下：

- 情绪条目除了 `refAudioPath`，还可以只写 `caption` / `refAudioPaths` / `speed` / `numSteps`；没写的字段沿用角色
  默认值，所以换语气不会丢掉角色的 LoRA。
- `tts.irodori.emotionLabels` 非空时自动打开情绪标注，并把这些标签并入可选列表（MSST 的写法）。
- 全局 presets 的 `speed`（或 `speedFactor`）会映射到 Irodori 的语速；`temperature` 只对 GPT-SoVITS 生效。
- Irodori 下发给情绪判断的标签只保留“这个卡司里真的配有 caption/参考音频”的那些，避免选到全局标签后语气
  毫无变化；如果整个卡司都没有 Irodori 情绪条目，才退回全部标签。

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
- `provider: irodori` 时目标语言固定 `ja`，`textLang` 不参与。翻译失败的句子如果没有假名，会被跳过而不是
  用中文音素硬读；这种句子计入 `tts.nonJapaneseLines`，API 结果里还有 `nonJapaneseSpeakers`。

## 6. 检查与试音

```sh
npm run check                         # 配置、站点、ffmpeg、Chrome、音色数量、缺失参考
npm run tts:check                     # 列出音色表
npm run tts:check -- --voice 高松灯    # 只看一个角色
npm run tts:check -- --synthesize     # 每个音色合成一句，写到 output/tts-check/*.wav
npm run tts:check -- --synthesize --voice 高松灯 --emotion 开心喜悦
npm run tts:check -- --synthesize --voice 高松灯 --text "ありがとう！"
```

试音会显示当前 provider、服务地址和音色表；Irodori 下还会显示 model / steps / seed，并把 `weights` 列换成 `lora`。
失败会打印服务端的 HTTP 状态和响应片段。Irodori 只接受日文，`--text` 请写日文。

生成故事时，API 结果和 `.story.json` 会带 TTS 报告：

```json
{
  "tts": {
    "enabled": true, "lines": 24, "voiced": 24,
    "voices": { "高松灯": 18, "长崎素世": 6 },
    "fallbackLines": 0, "silentLines": 0, "failedLines": 0, "nonJapaneseLines": 0,
    "fallbackSpeakers": [], "silentSpeakers": [], "failedSpeakers": [], "nonJapaneseSpeakers": []
  }
}
```

- `silentLines > 0`：有角色没有参考音频；看 `silentSpeakers`。
- `fallbackLines > 0`：有角色没有匹配到命名音色，用了默认音色；看 `fallbackSpeakers`。
- `failedLines > 0`：请求失败且重试耗尽；看 `failedSpeakers` 和日志。
- `nonJapaneseLines > 0`：Irodori 没有收到日文，这一句被跳过；看 `nonJapaneseSpeakers`，检查 `translateForTts`。

## 7. 缓存

合成结果按“provider + 文本 + 音色 + 参数 + 语言”缓存在 `paths.cache/tts/`。改参考音频、权重/LoRA、caption、
`tts.irodori` 参数、语速或文本都会生成新缓存；想强制重来直接删 `cache/tts/`。两个 provider 的缓存互不覆盖。

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `TTS connection failed` | `tts.baseUrl` 不对，或 TTS 服务没启动；先 `curl <baseUrl>/` |
| `no reference audio for …` | 该角色没有参考音频，也没有 `defaultVoice`；运行 `npm run tts:check` 看缺谁 |
| `TTS HTTP 400` 且提到参考音频 | 服务端找不到参考音频；这是服务端路径，不是本机路径 |
| 全部台词静音 | `tts.enabled` 是否为 true、`voicesFile` 是否存在、`tts.baseUrl` 是否可达 |
| 所有角色同一个声音 | 角色名/别名没匹配上，落到了 `defaultVoice`；看 `tts.fallbackSpeakers` |
| 中文台词念得很怪 | `tts.textLang` 应与音色语言一致（如 `ja`），并确认 `translateForTts` 生效 |
| 某个角色换了音色 | 检查 `voices.yaml` 里是否有同名或别名冲突；`npm run check` 会报共享别名 |
| 切换权重后很慢 | 配了 `gptWeightsPath`/`sovitsWeightsPath` 时会串行；不配权重可并发 |
| `Irodori reads Japanese only` / 大量 `nonJapaneseLines` | 这一句没有日文。确认 `llm.translateForTts` 没有被关掉，或把台词写成日文 |
| Irodori 请求 404 | `tts.baseUrl` 带了 `/v1`，或填成了 GPT-SoVITS 的 9880 端口；Irodori 填服务根地址 |
| Irodori 音色不像角色 | 检查 `loraAdapter` 是否指向服务端存在的目录；`caption` 要用日语描述语气 |
| Irodori 换情绪后音色变了 | 情绪条目里写了 `loraAdapter` 且指向别的 adapter；删掉该字段即可沿用角色默认 |

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
