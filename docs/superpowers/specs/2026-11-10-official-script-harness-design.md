# 2026-11-10 官方剧本驱动的 harness 与生成效果优化设计

## 1. 目标与验收口径

本设计针对 `ournotes-player` 的 `host/ai` 生成 harness、`ournotes.story-script/1` 编译链路和官方 ADV 命令保真。用户已确认范围为「统计 + 编译 + 抽帧实测」，验收必须同时具备以下证据：

1. **可复现官方统计**：用固定的 30 部官方样本重新计算台词、动作、镜头、声音和时间分布；报告中必须区分 1300 条 `Talk` 行、1158 条有文本 `Talk` 行、142 条空白 `Talk` 行。统计代码、阈值、测试和文档入库；原始语料、LLM 评估报告、导出的视频与抽帧放到仓库外或现有忽略目录。
2. **生成分布改善**：用固定提示词集、固定模型和温度生成逐场脚本；统一 staged/single 的长度、动作、镜头和文本分布预算；聚合报告给出生成前后与官方基线的可比数值。
3. **命令保真**：生成的 story-script 能编译出官方常见且播放器已注册的 `Pedestal`、`PanV2`、`DoF`、`Look`、`Se` 行，并支持官方实测的 `Zoom`/`Focus`/`Track` 取值与时长。所有新增字段经过 parser、checker、compiler、episode schema、站点清单和播放端检查。
4. **成片实测**：使用真实浏览器与 ffmpeg 导出至少一段包含新增镜头命令和 SE 的样片；在命令时间点抽帧，留画面变化证据和机器可读报告。
5. **提交约束**：现有 23 个未提交文件保持原状；本轮只提交自己的改动到 main，不 push。设计批准前不写实现代码。

不把「测试通过」「报告存在」单独当作完成；必须逐项核对报告覆盖上述指标、命令和帧证据。

## 2. 官方基线（本轮共同数据源）

本轮以仓库已有的 8 部本地官方章节（`10438, 10450, 10459, 10462, 10466, 10468, 10610, 10946`）与 22 部下载双人友情戏（含 `10460...10598` 的固定 ID 列表）为固定语料。语料路径由 `OURNOTES_OFFICIAL_CORPUS` 或等价配置给出；默认可用现有 `resources/site/stories` 与 `output/_official-sample`，不复制或提交语料。

已复核的关键分布，作为生成目标而非硬性逐条照搬：

| 维度 | 官方 30 部实测 |
|---|---|
| 规模 | 30 部、5623 条命令、1300 条 `Talk`、1158 条有文本行、142 条空白行 |
| 简体中文整条台词 | 均值 15.541 字，中位 14，p90 30，最大 60；7~17 字仅占 37.13% |
| 显式换行片段 | 1619 段，均值 11.116 字，7~17 字占 63.13%；一条 Talk 两行占 38.26%，三行及以上 0.78% |
| 短反应与标点 | 2~6 字占 21.68% 有文本行；省略号 46.37%，问号 25.82%，叹号 21.42% |
| 话轮 | 832 个连续说话人段，均值 1.392 句，72.84% 为单句段；双人章切换率约 70.72% |
| 表演 | 1502 条归属有文本 Talk 的 Motion，1.297/行；69 行无 Motion（5.96%）；Motion 中 1497 条携带 `ExpressionName`；独立 `Expression` 全语料仅 2 条 |
| 视线 | `Look` 217 + `LookTarget` 145 = 362，0.313/有文本行；31.26% 的有文本行带视线 |
| 镜头 | 516 Focus = 0.397/Talk 行；Talk 行继承距离 2/3/4 分别 38.92%/36.08%/20.38%；近景连续 1~2 句占 77.85% |
| 运动镜头 | Zoom 152、Pedestal 122、Track 95、DoF 24、PanV2 167；Zoom 最常见值 1.2（52 次），`1.5` 是最常见非零相机移动时长 |
| 声音与节奏 | Se 147、Bgm 71、Stage 57；双人剧 Bgm 中位 2 条/部、Se 中位 5 条/部；8 部带完整语音的样本共 318 cues，均值 3.394s |
| 站位 | 双人同框占 76.2%；站位槽以 3/7 为主，单人开场 19/30，双人开场 10/30 |
| 官方时间常量 | `_waitTalkTextUnitTime=0.04`、`_waitAfterVoiceTime=0.6`、`_minTalkDisplayTime=1.6`；`In/Out` 最常见 0.2s |

这些数字修正现有文档中的三类混淆：「7~17 字」是换行片段的常见长度而非整条 Talk 约束；1300 包含空白 Talk；`0.40 Focus/句` 的分母是全部 Talk 行，按有文本行是约 0.446。所有提示词、门限和测试从同一份机器可读常量派生，禁止再在 `prompt.js`、`staged.js`、`storyWriter.js` 中各自硬编码互相冲突的数字。

产品上有意不照搬的项目必须写进规格和报告：不生成空白 Talk 行；不复制官方的角色/素材 ID；不启用 0.1.8 引擎未原生支持的 `HostActions`；不追求 SE 的官方具体素材，只使用本地站点已有 cue。

## 3. 架构与数据流

新增 `scripts/stories/` 作为唯一测量与评估入口，结构如下：

- `official-corpus.mjs`：读取本地 gz/br 或 JSON episode，校验 `episode.commands/text/sounds/cuesheets`，产出每部 ID、行数、sha256、失败列表和命令状态继承后的规范 `line` 记录。
- `story-metrics.mjs`：官方 episode 与生成 story-script/编译 episode 共用的指标适配器，统一输出文本、话轮、动作、视线、镜头、声音、时间指标；提供 `summarize`、`aggregate`、`windowsOf`。
- `official-baseline.mjs` / `official-baseline.test.mjs`：从语料重算基线并断言样本规模、解析零失败及核心分布区间；语料缺失时以 `skip` 明确标注，不假通过。
- `ai-eval.mjs`：固定场景集、固定生成参数，直接调用 `StoryWriter` 而不占渲染端口；每场保存 story、warnings、latency/usage、summary，另存 `report.json` 聚合。
- `ai-quality.test.mjs`：经 `OURNOTES_EVAL_REPORT` 读取一次命名 run，断言逐场硬性下限和聚合分布；报告缺失时 skip。
- `compiled-command-audit.mjs`：把生成脚本编译为 episode，统计命令类型/参数/duration、资源闭合、required commands，并与官方分布做区间比较。
- `frame-audit.mjs`：读取导出视频、时间线和抽帧清单，用 ffmpeg 在 Focus/Zoom/Pedestal/PanV2/DoF/Se/动作时间点前后抽帧，产出机器可读帧变化报告和 PNG 证据目录。

`host/ai/` 引入一个纯数据模块 `official-targets.js`：由上述基线导出 JSON 或由测试锁定的常量文件提供所有预算；`prompt.js`、`staged.js`、`storyWriter.js` 只消费该模块。现有 `translateForTts`、`judgeEmotions` 留在 TTS 侧，`condenseDialogue`/`softenPunctuation` 不移植；这是上一轮有意保留的项目边界。

`scripts/lib/story-author/script.js` 仍是 story-script 的 parser/checker/compiler 单一事实来源。`schema/episode.schema.json` 显式补齐顶层 `MotionFadeIn`、`MotionWait`、`CanvasLayers`、`TargetTextColors` 的声明。`host/ai/storyWriter.js` 的白名单、`host/ai/staged.js` 的 storyboard 字段表和 `host/ai/prompt.js` 的 few-shot 同步扩展。

站点资源层只做最小闭合：`musicChoices` 旁新增 `soundChoices`，从 base episode 的 `sound_se*` cue sheet 选择可用 `SeID`；`Site.compose`、`host/tools/site-story.mjs` 和 `host/story/catalog.js` 把生成的 SE cue 与 `story.parts.sounds` 一并复制。禁止凭空编造官方 SE ID。

数据流：

```text
官方 episode ──> official-corpus ──> official-baseline.json / targets
                                      │
固定提示词 ──> StoryWriter ──> story-script ──> parse/check/compile ──> episode + story
      │                  │                         │                    │
      └─ ai-eval report ─┴─ story-metrics ─────────┴─ command audit ───┴─ render/ffmpeg ──> frame report
```

`host/pipeline.js` 对生成结果保留 `stages`、`plan`、`dialogue`、`usage` 和 warnings 到 job result / `.story.json`，用于 run 间诊断；不改变现有 API 响应兼容字段。站点与产品两条渲染路径仍分别使用 0.1.8 site engine 与本地 `src/story`，不替换播放器版本。

## 4. 命令模型

所有新增字段只出现在 story-script beat 顶层，编译为独立、按顺序编号的官方命令；不通过 `Talk.HostActions` 定时触发，避免 0.1.8 的 timed `LookTarget` 兼容问题。`actions[].at` 仍保留给手写脚本，AI 默认只输出 `at: 0`。

| 字段 | 可用 beat | 编译命令 | 范围/默认 | 说明 |
|---|---|---|---|---|
| `cameraDuration` | camera | `Focus` / `Track` / `Pedestal` / `PanV2` / `DoF` | `0..20`，省略表示沿用各字段默认 | camera beat 的统一时长覆盖；各字段自己的 duration 优先，最后才是该值 |
| `zoom` / `zoomDuration` | say, narrate, camera | `Zoom` | zoom `0.7..2.5`，duration `0.2..20`，默认 1.5 | 覆盖官方 1.2/1.1/0.9/1.5 等常见值；保持 `IsNoWait:1` |
| `focusDuration` | say, narrate, camera, scene, positions | `Focus` | `0..20`，0/缺省表示硬切 | 显式覆盖自动 closer cut / wider 1.2 / lateral 0.5；1.5 可作为官方常见过渡值 |
| `trackDuration` | say, narrate, camera, scene, positions | `Track` | `0..20`，默认跟随所在 beat 的 Focus duration，没有 Focus 时用 `cameraDuration` | 官方 Track 的 1/2/5/10/20 秒均允许 |
| `pedestal` / `pedestalDuration` | say, narrate, camera | `Pedestal` | 值 `-4..5`，duration `0..20`，默认 1.5 | 对应官方 `-0.2/-0.3/0` 等 Y 偏移 |
| `pan` / `panDuration` / `panFocusSlide` | say, narrate, camera | `PanV2` | 角度 `-30..30`，duration `0..20`，focus slide `0..1` | 只在明确换组/横移时使用；默认不生成 |
| `dof` / `dofDuration` / `dofLayers` | say, narrate, camera | `DoF` | intensity `0..1`，duration `0.5..10`，layers 为 `0`/`2`/省略 | 省略 layers 时作用于角色；不得默认叠加到每句 |
| `look` / `lookY` / `lookDuration` | say, action | `Look` | x/y `-1..1`，duration `0.2..10`，默认 0.5 | 与 `lookAt`（`LookTarget`）并存；同一 beat 只允许一种视线通道，避免重复 |
| `se` / `seDuration` / `seDelay` / `seStop` | scene, say, camera, action | `Se` | 已知 cue 名；duration `0.5..10`、delay `0..10`；`seStop` 为布尔值 | 只在 base story 声音清单闭合后生成；`seStop:true` 发 `Parameter1:"Stop"`，与 `se` 互斥 |
| `motionFadeIn` / `motionWait` | say, action, positions | `Motion` | fade `-1..2`，wait boolean | 默认仍是官方最常见的 `-1`；仅用于有明确节奏需求的 beat |

`seStop` 与 `se` 互斥；`seDuration`/`seDelay` 依附于 `se`。`focusDuration`、`trackDuration` 和 `cameraDuration` 对 `Focus`/`Track` 的优先级是字段自身 duration > `cameraDuration` > compiler 自动 duration；Pedestal/PanV2/DoF/Zoom 的优先级是字段自身 duration > `cameraDuration` > 表中默认值。Camera beats 的 `duration` 保留为旧字段别名，等价于 `cameraDuration`；二者同时出现时取 `cameraDuration` 并报冲突警告，避免破坏旧脚本。`compileScript` 用 `ADV_COMMAND.indexOf` 生成 `raw`，保持 `i === rows.length` 与 `commandCount === rows.length`。

现有 `docs/story-director.md:414` 的「不暴露任意 ADV 命令」限制改为「只暴露经命令审计与抽帧验证的白名单」。`MoveToDirection`、`Angle/Tilt`、`Brightness/PostEffect`、Shake 等不在本轮白名单。

## 5. 提示词与生成预算

统一后的 staged 三段保持 cast / dialogue / storyboard 架构，但所有数值来自官方目标：

- 台词目标按「有文本行」计数：一场 32~47 行、均值约 38.6 行；整条简体中文均值约 15.5 字、p90 约 30 字，换行片段均值约 11.1 字；两行占约 38%，三行不超过 1%；2~6 字短反应约 22%，省略号约 46%，问号约 26%，叹号约 21%。
- 话轮以单句切换为主：约 73% 的连续说话人段长度为 1，均值约 1.4；删除「1~6 句/turn 且至少 2 个 6 句以上 turn」这种与官方和自相矛盾的约束。
- 长度闸与 prompt lineBudget 使用同一个 `targetMinutes -> lines/chars` 函数，不再同时存在 16 行/分、10 行/分、110 字/分三套阈值；基于官方 8 部语音样本，行数约 `15~18 × minutes`，字符约 `240 × minutes`，并允许按语料窗口的 p10/p90 调整。
- 镜头目标：Focus 约 0.40/Talk 行；距离 2/3/4 约 39%/36%/20%；dist≥4 的连续段 1~2 句约 78%；close 数量按行数比例计算而不再硬上限 5；Zoom 允许 0.7~2.5 与 0.2~20s，但 AI 默认每场 2~5 次并优先 1.1/1.2/0.9/1.5/1.5s。
- 表演目标：Motion 约 1.30/有文本行，约 6% 无 Motion，表情优先挂在 Motion 的 `ExpressionName`，独立 Expression 默认 0；视线（`Look`+`LookTarget`）约 0.31/行；说话者与听者的动作合计按官方双通道统计，不再把仅有 listener reaction 的行误判为 static。
- Stage/Bgm/Se 目标：通常 1 个场景，Bgm 约 2 条/部，Se 约 5 条/部；AI 只在情绪/环境转折处选择站点可用 SE，不能给每句配音效。
- 入场与站位：双人同框为主，单人开场约 63%；「另一人 2~4 句后入场」作为倾向而非硬规则；`maxOnStage` 仍默认 3。
- `staticLineBudget`、`closeUps`、`motionBudget`、`focusChanges`、`lookAtBudget` 由统一函数按实际台词条数计算，staged merge 与 single prompt 共用；现有 `ceil(0.9*N)` 的 directed cap 改为检查总表演动作均值与 no-action 带。

提示词头部更正语料来源：8 部本地章节 + 22 部双人友情戏 = 30 部；把「每句 7~17 字」改为「换行片段常见 7~17 字、整条常见 1~30 字」；删除把 10610 的 10 Focus/5 Track/20 Motion 当成普遍模板的暗示。`docs/story-director.md` 同步更正 7~17 字、1300 句、独立 Expression、相机时长和 Zoom 范围。

## 6. 错误处理

- 语料缺失、某个 episode 解压或 schema 失败：记录到 `failures` 并以非零退出码结束基线脚本；测试在无语料环境按明确原因 skip，不把 skip 计入通过。
- LLM 单场超时、JSON 解析失败或生成脚本校验失败：记录 `error`、原始响应截断、warnings 和耗时，继续其余场景；聚合只统计成功场景，并断言成功场数。
- 缺失 `OURNOTES_EVAL_REPORT`、Chrome/Edge、ffmpeg、`OURNOTES_E2E_SITE` 或 base story：相应质量/渲染/抽帧门 skip 并输出所需环境变量；不得用合成帧代替真实导出。
- 新增数值字段越界、缺依赖、互斥或 SE 不存在：parser/checker 报带 JSON pointer 的确定性错误；修复器只允许改已知映射，不能静默丢弃整条命令。
- 编译后若 `requires.commands` 与 episode 命令不一致、声音 cue 未闭合、命令未注册、`i/raw/commandCount` 不一致，命令审计失败并指出具体行。
- 抽帧时间点落在视频末尾或 ffmpeg 失败：报告标为 `frameFailure`；一帧未抽到不算抽帧实测通过。
- `HostActions` 的 0.1.8 timed `LookTarget` 已知缺陷不在本轮扩大使用；新增视线全部编译为独立 `Look`/`LookTarget` 行。
- 现有 23 个未提交文件不得被 `git add -A`、格式化或重写；提交前逐文件核对 `git diff --cached --name-only` 与密钥/绝对路径扫描。

## 7. 测试与交付证据

必须保留以下真实命令输出或报告：

1. `npm test`：story-author parser/checker/compiler、episode schema、命令注册、SE cue 闭合、新字段范围与互斥、布局修复。
2. `npm run test:host`：staged/single prompt、官方目标常量、长度闸、merge、pipeline、站点 SE 清单、命令审计、编译闭环。
3. `npm run lint`。
4. `npm run test:stories`（新增）：语料存在时重算 30 部基线，断言零解析失败及核心分布；读取一次 LLM `report.json` 断言固定场景数、逐场硬性下限、聚合区间和命令数；语料或报告缺失时逐项 skip。
5. `npm run eval:stories -- --run <name>`：使用本机 `config.yaml` 的 LLM 地址/模型，固定温度、pipeline、repairRounds、jsonMode、maxTokens；输出逐场脚本、usage/latency/warnings、`report.json` 和 `all-stories.json`。
6. `npm run audit:frames -- --video <mp4> --episode <episode.json> --out <dir>`：ffmpeg 抽帧并生成 `frame-report.json`；人工核对报告中的前后帧变化、时间点和画面 PNG。
7. 至少一次真实 e2e 导出（`OURNOTES_E2E_CORE`、`OURNOTES_E2E_SITE`、可用 Chrome/ffmpeg 均设置）及其抽帧报告；若环境不可用，明确列为未完成证据而不是用单元测试替代。
8. `git status --short`、`git diff --cached --stat` 和本次提交 hash；确认 23 个原有修改仍为未暂存且内容未被本轮覆盖。

测试断言必须覆盖具体命令字段，例如 `Zoom.Parameter1:"1.2" / Duration:1.5`、`Pedestal.Parameter1:"-0.2"`、`PanV2.Parameter1:"-5"`、`DoF.Parameter1:"0.5"`、`Look.Parameter1/2`、`Se.SeID` 与 episode `sounds/cuesheets/story.parts.sounds` 闭合。抽帧报告必须能追溯到编译 episode 的 `i` 与 timeline 秒数。

## 8. 范围外

不重写播放器；不更新 `ournotes-player-site` 0.1.8 依赖；不改动 TTS 的情绪/翻译职责；不导入 MSST 的 PJSK 台词长度、舞台上下场或 BGM 假设；不生成官方素材 ID、角色名或语音；不一次性开放全部 46 种 ADV 命令；不处理现有 23 个未提交文件；不 push。

## 9. 实施顺序

1. 写 `official-corpus`/`story-metrics`/`official-baseline` 与报告格式，锁定 30 部语料数字。
2. 抽出 `official-targets` 常量，修正 staged/single 提示词、长度闸、merge 预算和相关测试/文档。
3. 扩展 story-script 字段、parser/checker/compiler、schema、SE catalog 与资源闭合，补命令编译断言。
4. 增加固定场景 AI 评估与质量门；跑一轮 LLM，按报告微调预算但不放宽验收区间。
5. 做真实 e2e 导出与 ffmpeg 抽帧；修复抽帧发现的视觉/时序问题。
6. 运行完整测试与 lint，核对工作树，只提交本轮文件到 main，报告提交 hash、测试输出、报告路径和未完成的外部环境项。
