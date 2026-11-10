# 导演脚本：让 AI 写出接近官方 ADV 的演出

`ournotes.story-script/1` 是本项目的演出脚本格式。它不只是“谁说了什么”：每个 beat 都能指定舞台、站位、镜头焦点、镜头远近、横向平移、Live2D 动作、表情、视线、听者反应、黑场和留白。AI 剧本编写器（`host/ai/`）和命令行编写工具（`scripts/story-author.mjs`）使用同一套格式与校验器，因此 AI 生成的脚本可以：

- 用站点里真实存在的舞台、BGM、模型、动作和表情；
- 在台词开始前给听者安排反应（`actions` 的 `at: 0`），也可以在台词中段定时演出；
- 让镜头看向某个角色、站位或 1~9 的构图点，并切换 `near` / `middle` / `far` / `close` / `very-close`；
- 用 `track` 横向平移镜头、`zoom` 缓慢推近/拉远，做出官方那种两人构图、群像横移和情绪推镜；
- 用 `positions` 换组：一组人退场、另一组进场，镜头跟着新组走；
- 用 `fade` 做真正的时间/地点跳转，用 `pause` 留白；
- 在没有台词的瞬间用 `action` beat 演一个反应镜头。

这套格式来自对官方 ADV 命令的归纳：`Stage`、`Character`、`In` / `Out`、`Motion`、`Expression`、`Talk`、`Focus`、`Track`、`LookTarget`、`FadeOut` / `FadeIn`、`Delay`。它不试图暴露全部命令，而是把官方演出中最常用的部分做成可校验、可让 AI 稳定生成的子集。

台词内 `actions` 的时间比例、说话者/听者双通道和“一句一个主动作”的预算，参考了
[MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) 的 story format；本项目把它们编译成
Our Notes 自己的 `Talk` 行 + `HostActions` 扩展，并在官方 ADV 的虚拟时钟上执行。

## 官方一集的节奏（30 部官方样本：8 部本地章节 + 22 部双人友情戏）

样本是 8 部 MyGO/群像章节（10438、10450、10459、10462、10466、10468、10610、10946）加 22 部不同乐队的双人
友情戏（10460--10598），共 1300 条 `Talk` 行（1158 条有文本、142 条空白）、516 次 `Focus`。10610 有 13 句、
36.8 秒语音、90 条命令：**10 次 `Focus`、5 次 `Track`、20 次 `Motion`、0 次 `Fade`**，但它是 5 人教学场，
镜头比日常戏碎。整体规律是：

1. 有文本台词每集 32~47 条（均值约 38.6）、约 1~2.5 分钟。整条台词均值 15.5 字、中位 14、p90 30；
   显式换行片段均值 11.1 字。约 38.3% 的台词分两行，三行及以上 0.78%；2~6 字短反应占 21.7%。
2. 平均 **0.40 次 `Focus`/`Talk` 行**（按有文本行约 0.45）。`CameraDistance` 在 `Talk` 行上的占比：
   2（1.4×）38.9%、3（1.8×）36.1%、4（2.8×）20.4%；1（1.2×）和 5（4×）是少数。按有文本行算，
   **约 20% 的台词在 4（近景）**、39% 在 2、36% 在 3：近景不是稀有镜头，群像/双人仍以 2/3 为主。
   近景段长 0~2 句（空镜按 1 段；末尾空白 Talk 会缩短段长）约占 **77.9%**（116/149，
   `closeRunOneOrTwoShare`），3 句及以上约 22%。生成脚本没有空白 `Talk` 行，所以预算按 **0.446
   `Focus`/有文本行** 和 **22.88% 近景/有文本行**（265/1158）换算；上面的 0.397 和 20.38% 是官方全量
   `Talk` 行口径。
3. `Motion` 约 1.30 个/有文本行；5.96% 的句子没有 `Motion`；约 **44.7%** 的有文本行有 2 个以上表演动作
   (Motion + Expression + Look + LookTarget) = 518/1158（`twoMotionShare`）；有动作的行中为 518/1094 = 47.3%，
   恰好 2 个 `Motion` 的行是 276/1158 = 23.8%。归属有文本 Talk 的 1502 条 `Motion` 中 1497 条携带
   `ExpressionName`；全语料 1508 条中 1503 条携带。
4. 独立 `Expression` 全语料只有 2 条（约 0.067 条/集）：表情基本都挂在 `Motion` 上；默认 `idle`，不是每句都笑。
5. `Look` 217 + `LookTarget` 145 = 362，约 0.313 次/有文本行；31.26% 的句子带视线。双人戏开场常先 1 人，
   2~4 句后另一人 `In`。
6. 群像章节（约 60 句）镜头切得更碎，角色分批进出；不要把它当成日常双人戏模板。
7. 这 30 集里 `Zoom` 152 次（约 5.1 次/集）、`Pedestal` 122 次（4.1 次/集）、`PanV2` 167 次（5.6 次/集）、
   `Track` 95 次（3.2 次/集）、`DoF` 24 次（0.8 次/集）、`Se` 147 次（4.9 次/集）、`Bgm` 71 次（2.4 次/集）；
   缓慢的 ±10% 推拉很常见，所以脚本格式提供可选的 `zoom`/`zoomDuration`。

所以提示词要求：**二人同框（`middle`）↔ 说话者近景（`close`）交替，每 3~4 句一组；`near` 全场最多 1 次，
`close` 约占 22.9% 的有文本行（30 句约 7 次），近景停 1~2 句后回到二人/群像；`Focus` 约 0.45/有文本行（官方 Talk 行 0.397）；`track` 只在
换组/群像横移时用（约 0~2 次）；`zoom` 每场约 2~5 次。** `fade` 只留给真正的时间/地点跳跃，连续对话里不用。
10610 的 `10 Focus / 5 Track / 20 Motion` 不要当成日常戏模板。所有预算由 `host/ai/official-targets.js` 的
`dialogueBudgetFor` / `directionBudgetFor` 从同一组 checked 常量计算，提示词、长度闸和 staged merge 不再各写一套。

## 一个完整的导演脚本

下面这份脚本只用来演示字段和写法，分镜密度比官方日常戏高；站位也为了演示三人换组，严格按上一节的
“两人 `far-left`/`far-right`、三人 `far-left`/`center`/`far-right`”执行时以 `story.maxOnStage` 为准，不要照抄
示例里的相邻站位。

```json
{
  "format": "ournotes.story-script/1",
  "base": "stories/10610.json",
  "language": "ja",
  "title": "ライブのあとで",
  "font": "sans",
  "cast": {
    "tomori": {
      "model": "adv_live2d_tomori_001_live_01",
      "name": "燈"
    },
    "anon": {
      "model": "adv_live2d_anon_002_live_01",
      "name": "愛音"
    },
    "soyo": {
      "model": "adv_live2d_soyo_004_live_01",
      "name": "爽世"
    }
  },
  "beats": [
    {
      "scene": "adv_bkg_stage_000189",
      "location": "ライブのあと",
      "music": "sound_bgm_adv_nows_the_time",
      "camera": {
        "distance": "middle",
        "focus": 3,
        "track": 0.2
      },
      "positions": {
        "anon": "far-left",
        "tomori": "center"
      }
    },
    {
      "say": "anon",
      "text": "やり切ったね。\n今日のライブ、最高だった！",
      "motion": "mtn_smile01",
      "expression": "exp_smile02",
      "actions": [
        {
          "at": 0,
          "cast": "tomori",
          "expression": "exp_smile01"
        }
      ]
    },
    {
      "say": "tomori",
      "text": "うん……\nまた、みんなで演奏したい。",
      "motion": "mtn_nod01",
      "expression": "exp_shy01",
      "focus": "tomori",
      "camera": "close",
      "track": 0.3,
      "actions": [
        {
          "at": 0,
          "cast": "anon",
          "expression": "exp_smile02"
        }
      ]
    },
    {
      "positions": {
        "anon": "far-left",
        "tomori": "center",
        "soyo": "far-right"
      },
      "camera": "far",
      "focus": 5,
      "track": 0
    },
    {
      "say": "soyo",
      "text": "ふふ、よかったね。\n次はもっと上手くやろう。",
      "motion": "mtn_smile01",
      "expression": "exp_smile02",
      "actions": [
        {
          "at": 0,
          "cast": "tomori",
          "expression": "exp_smile03"
        }
      ]
    },
    {
      "say": "tomori",
      "text": "次は……\nもっと、ちゃんと。",
      "motion": "mtn_nod02",
      "expression": "exp_serious01",
      "focus": "tomori",
      "camera": "close",
      "actions": [
        {
          "at": 0,
          "cast": "soyo",
          "expression": "exp_idle01"
        }
      ]
    },
    {
      "say": "anon",
      "text": "ちゃんとって？\n燈らしいけど。",
      "motion": "mtn_question01",
      "expression": "exp_smile01"
    },
    {
      "action": "soyo",
      "motion": "mtn_wink01",
      "expression": "exp_smile02",
      "lookAt": "anon",
      "duration": 0.4
    },
    {
      "say": "soyo",
      "text": "燈は燈のままでいいよ。\nね？",
      "motion": "mtn_smile02",
      "expression": "exp_smile02",
      "actions": [
        {
          "at": 0.5,
          "cast": "anon",
          "expression": "exp_smile02"
        }
      ]
    },
    {
      "positions": {
        "tomori": "center",
        "soyo": "far-right"
      },
      "camera": "middle",
      "focus": 7,
      "track": 0.2
    },
    {
      "say": "tomori",
      "text": "……うん。\nありがとう。",
      "motion": "mtn_nod01",
      "expression": "exp_smile01",
      "lookAt": "soyo",
      "focus": "tomori",
      "camera": "close",
      "actions": [
        {
          "at": 0,
          "cast": "soyo",
          "expression": "exp_smile01"
        }
      ]
    },
    {
      "pause": 0.3
    },
    {
      "say": "soyo",
      "text": "そろそろ帰ろっか。\n明日も練習だし。",
      "motion": "mtn_bye01",
      "expression": "exp_smile01"
    },
    {
      "positions": {
        "anon": "far-left",
        "tomori": "center",
        "soyo": "far-right"
      },
      "camera": "far",
      "focus": 5,
      "track": 0
    },
    {
      "say": "anon",
      "text": "明日も！\nじゃあ、またね！",
      "motion": "mtn_bye01",
      "expression": "exp_smile02",
      "actions": [
        {
          "at": 0,
          "cast": "tomori",
          "expression": "exp_smile02"
        },
        {
          "at": 0,
          "cast": "soyo",
          "expression": "exp_smile02"
        }
      ]
    },
    {
      "action": "tomori",
      "expression": "exp_smile02",
      "lookAt": "anon",
      "duration": 0.3
    }
  ]
}
```

这份脚本就是 `host/fixtures/director-demo.json`，可渲染成本地 `output/director-demo.mp4`（命令见下文）。它只用一个
stage：先两人对话，`positions` 引入第三人，再让一人退场、最后重新进场，镜头始终跟着当前组。

## beat 一览

| beat | 字段 | 说明 |
| --- | --- | --- |
| `scene` | `scene`、`music`、`location`、`camera`、`focus`、`track`、`positions` | 换舞台。第二个 scene 起会先 `FadeOut`，清空舞台，再 `FadeIn`。连续对话不要反复用。 |
| `positions` | `positions`、`camera`、`focus`、`track` | 改变站位；未列出的角色退场，新位置的角色淡入。用来换组。 |
| `say` | `say`、`text`、`motion`、`expression`、`lookAt`、`focus`、`camera`、`track`、`zoom`、`zoomDuration`、`actions` | 一句台词。动作/表情在台词开始前执行；`lookAt` 让说话者看向目标；`actions` 在台词前或台词中执行。 |
| `narrate` | `narrate`、`focus`、`camera`、`track`、`zoom`、`zoomDuration`、`actions` | 无说话者的台词；`actions` 必须写 `cast`。 |
| `camera` | `camera`、`focus`、`track`、`zoom`、`zoomDuration`、`duration` | 只移动镜头，不改变站位。 |
| `fade` | `fade`（`out`/`in`）、`duration` | 黑场转场，只用于时间/地点跳跃。 |
| `pause` | `pause`（秒） | 无台词留白，编译成 `Delay`；建议 0.1~0.5 秒。 |
| `action` | `action`、`motion`、`expression`、`lookAt`、`duration` | 没有台词的反应镜头；`duration` 会追加一个 `Delay`。 |

`camera` 可以写 `near` / `middle` / `far` / `close` / `very-close`，也可以写
`{ "distance": "close", "focus": 2, "track": 0.4 }`。它们对应官方的 `CameraDistance` 和 focus data 的变焦：

| 名字 | CameraDistance | 视场 | 用法 |
|---|---:|---:|---|
| `near` | 1 | 1.2× | 最广的全景；开场/收尾，全场 0~1 次 |
| `middle` | 2 | 1.4× | 双人中景，默认 |
| `far` | 3 | 1.8× | 三人群像 / 紧中景 |
| `close` | 4 | 2.8× | 情绪近景；约占 22.9% 的有文本行，1~2 句后回到 `middle` |
| `very-close` | 5 | 4× | 大特写，最多 1 次 |

`focus` 是站在台上的 cast id、位置名（`far-left` / `left` / `center` / `right` / `far-right`），或 1~9 的构图点：
1/3/5/7/9 是站位，2/4/6/8 是两人中间的构图点。目标是角色时编译成该角色站位的 `PositionType`，和官方单人近景
一致；官方少数同时写 `PositionType` + `TargetName` 的行是“两人构图、头部跟某一角色”的特殊取景，本格式不暴露
这个组合。`track` 编译成官方 `Track` 行，表示镜头相对焦点的横向偏移（-4~4，0 为正对焦点）。

镜头切换的时长按官方样本自动决定：**推近是硬切（无 `Duration`）**，**拉回中景/群像缓推 1.2 秒**，同距离横移
0.5 秒（近景之间横移仍硬切）。`camera` beat 写了 `duration` 时以它为准。

`zoom` 是一个可选的慢推/慢拉，编译成官方 `Zoom` 行：`zoom: 1.03~1.10` 推近、`0.92~0.98` 拉远，
`zoomDuration` 3~5 秒（省略时 4 秒；camera beat 用它的 `duration`）。一个机位只写一次，一场约 2~5 次；不写就
保持静止。`zoom` 在 `Focus` 之后执行，所以要先写 `focus`/`camera` 再写 `zoom`。

动作和表情行编译时带 `MotionFadeIn: -1`：播放器使用动作自带的淡入（MyGO 动作数据里是 1 秒），换动作时从当前
姿势交叉淡入，不会突然跳到新动作第一帧。缺少这个字段时游戏按 0 秒处理，这正是自行拼 `Motion` 行时动作看起来
“跳一下”的原因。台词中的 `actions` 仍用 0.15 秒的快速淡入。

## `actions`：台词前 / 台词中的定时演出

```json
"actions": [
  { "at": 0, "cast": "soyo", "expression": "exp_smile02" },
  { "at": 0, "cast": "tomori", "motion": "mtn_nod01" },
  { "at": 0.5, "cast": "anon", "lookAt": "tomori" }
]
```

- `at` 是 0..1，表示台词正文的百分比；省略为 0。
- **`at: 0` 的动作在台词开始前执行**，编译成独立的 `Motion` / `Expression` / `LookTarget` 行。官方大多数听者反应都是这样发生的。
- `at > 0` 的动作由 `Talk` 的 `HostActions` 扩展在虚拟时钟上调度；正文长度取“语音时长，或按字数估算的显示时长”，至少 `_minTalkDisplayTime`。只用于确实需要压住长句后半段的反应。30 部官方样本都没有 `at > 0` 的句中动作，所以 AI 提示词要求听者反应一律写 `at: 0`；`HostActions` 仍保留给手工脚本。
- `cast` 省略时默认说话者；`narrate` 必须写。
- 每条至少写 `motion`、`expression`、`lookAt` 之一；格式允许最多 12 条，但提示词建议最多 1 条听者反应（加上 `say.motion` 共 2 个动作）。
- 目标必须在台上，动作/表情必须是该模型真实存在的名称。

## 官方风格的演出规则

1. **一场戏一个 stage**：先建立空间，之后用 `positions` 换组，不要为每次换人新开 scene。只有真正换时间/地点才 `fade`。开场先放 1 人（最多 2 人），2~4 句后让下一人进场；一场最多 2 次 `positions` 变化。换组时让已有人物保持原位，只让角色退场/进场；把同一角色从 `left` 改到 `center` 会编译成 `Out` + `In`，画面会闪一下。
2. **镜头按组**：双人戏用“二人同框（`middle`，`focus: 5`）↔ 说话者近景（`close`，`focus` 该角色）”交替，每个机位保持 3~4 句；三人用 `far` + `focus: 5` 群像，偶尔用两人构图。`Focus` 约 0.45/有文本行（官方 Talk 行 0.397）：一场 30 句约 13 次 `Focus` 变化，不要只写 4 个就停。`near` 全场最多 1 次，`close` 约占 22.9% 的有文本行（30 句约 7 次），近景停 1~2 句后回到 `middle` + `focus: 5`；不要连续两句 `close`，也不要停在同一个 `close` 上直到结尾。推近时保持同一侧 `focus`，只改 `camera.distance`，不要换焦点；情绪镜头可以加一次 `zoom` 慢推。
3. **两人分站两侧**：两人同台用 `far-left` / `far-right`，`focus: 5` 框住两人；不要用 `center+right`、`center+left` 或
   `left+right`，两个角色会叠在一起。三人群像用 `far-left` / `center` / `far-right`，`camera: far`、`focus: 5`、`track: 0`
   （AI 默认 `story.maxOnStage: 3`；要严格两人可设 2，第三人换组进出）。`focus` 优先写位置；角色 `focus` 只给
   情绪最重的 1~2 句。
4. **听者先反应**：听者的表情/动作写 `actions` 的 `at: 0`；说话者的主动作写 `say.motion`。一句最多一个说话者动作、一个听者反应。官方样本没有句中动作，`at` 一律写 0。
5. **表情跟动作**：表情和 `motion` 写在同一条 `say` 上；默认 `idle`，不要每句都笑。官方独立 `Expression` 约 0.07 条/集（默认 0），确有必要一场最多 1 次。
6. **动作预算**：`Motion` 约 1.30/句；约 6% 的句子没有 Motion；约 44.7% 的有文本行有 2 个以上表演动作 (Motion + Expression + Look + LookTarget)（518/1158；有动作的行中 47.3%；恰好 2 个 Motion 23.8%）。不要给同一角色同一句叠 2 个动作，也不要每句都动；staged merge 的 `maxStatic`（约 12%）只是参考上限，修剪仍以达到 `motionMax` 为准。
7. **台词长短**：约 38% 的台词分两行，三行及以上不足 1%；约 22% 是 2~6 字的短反应；不同角色要有不同的句长和语气。
8. **留白克制**：`pause` 只用于 0.1~0.5 秒的呼吸；`fade` 只用于真正的时间/地点跳跃。

这些规则同时写进了 AI 的提示词。`staged` 管线里，台词轮负责句长、语气和短反应，分镜轮负责镜头、动作预算和
`lookAt`；`single` 管线则把两部分合在一份提示词里（`host/ai/prompt.js`）。两种管线都会给出每个动作 stem 的语义
说明（例如 `mtn_nod01` = 点头、`mtn_question01` = 歪头疑问），让模型按台词选动作，而不是猜名字。`single` 下开启
`llm.directorPlan` 时，AI 会先写一份分镜计划，再写完整脚本；该步骤默认关闭，因为规则已经写进主提示词，两次生成
反而容易让第二遍偏离计划。

## 校验与自动修复

`checkScript` / `parseScript` 检查：

- 舞台、BGM、模型、动作、表情是否在站点里；
- `focus` / `lookAt` 是否是台上的角色、合法位置或 1~9 的构图点；
- `actions` 的 `at` 范围、目标是否在台上、动作/表情是否存在；
- `track` 是否在 -4~4；
- 站位冲突、重复 id、台词宽度等。

可自动修复的问题（近似名称、重复 id、冲突站位、超宽文本）会带 JSON Patch；`host/ai/storyWriter.js` 会先套用修复，再让 LLM 做最多 `llm.repairRounds` 轮定向修正。

错误码新增：`unknownFocus`、`unknownLookAt`、`offStageAction`、`emptyAction`、`tooManyActions`、`range`、`unknownFade`。

## 多轮生成：选角 → 台词 → 分镜

角色提示词很长时，把“选角色 + 写台词 + 写分镜”塞进一个提示词会让模型同时背三套规则，角色的语气容易被分镜
清单冲淡，长人格还会挤占上下文。角色卡放在 `story.personaDirs` 指向的目录里（每个 `*.md` 一位角色），
`llm.pipeline` 默认是 `staged`，把生成拆成三次独立调用：

1. **选角**（`buildCastMessages`）：只给模型清单、舞台清单和用户要求，输出标题、开头一句话、一个小事件、
   2~3 名角色及各自在本场的作用、4~6 条大纲。这一轮只看到角色的名字、所属组和一句身份摘要，不读完整角色卡。
   结果里没有已知模型时，回退到站点角色顺序（`story.cast` 优先）。
2. **写台词**（`buildDialogueMessages`）：只带**选中角色**的完整角色卡（`personaDirs`，或同名的 `story.personas`
   覆盖）、每人的官方句式参考和大纲，输出 `{ "lines": [{ "id": "l1", "say": "anon", "text": "…" }] }`。
   这一轮看不到动作、表情、镜头、BGM 清单，模型只需要把“话”写对；台词总长、两行比例、短反应频率都在这里控制。
3. **写分镜**（`buildStoryboardMessages`）：输入已经定稿的台词稿、选中角色的动作/表情清单（带语义说明）、
   舞台和 BGM，输出只引用 `line` id 的演出 beat：`scene`、`positions`、`camera`、`focus`、`track`、`motion`、
   `expression`、`lookAt`、`actions`、`pause`、`fade`。提示词里不再出现长角色人格，只有“这一句该怎么演”；
   镜头/视线/动作预算按台词条数经 `directionBudgetFor` 从官方率换算（`Focus` 约 0.40/`Talk` 行、`lookAt` 约 0.31/有文本行、`Motion` 约 1.30/行、`close` 约 20%），避免每句都切镜头。

合并由 `mergeStagedScript` 完成，不是让模型再输出一遍完整剧本：

- 台词逐字来自第二轮；第三轮即使写了 `say`/`text` 也只取演出字段，改不动台词。
- 每个 `line` id 必须出现且只出现一次；缺的分镜按“无动作”补上，重复的保留第一次，未知 id 丢弃并记 warning。
- 每句只保留 1 个听者反应；独立 `Expression` 最多保留 1 条（官方约 0.07 条/集，默认 0），多出来的在合并时裁掉并记 warning。
- 站位在合并后统一归一化：两人改成 `far-left`/`far-right`；三人改成 `far-left`/`center`/`far-right`，并改成
  `camera: far`、`focus: 5`、`track: 0`。模型写了 `center+right` 这种会叠人的站位也会被纠正。
- 第一条不是 `scene` 时补一个默认 `scene`：1 人站 `center`，2 人站 `far-left`/`far-right`，3 人站
  `far-left`/`center`/`far-right`。

校验失败时，修复轮只重发**分镜**提示词（台词稿固定在上下文里），所以修几轮都不会把台词改坏。台词稿本身
没有可用 lines 时，只重试台词轮一次，角色和分镜不会被牵连。
`llm.directorPlan` 只对 `pipeline: single` 有意义；`staged` 已经天然分轮，不需要额外的计划轮。

```yaml
llm:
  pipeline: staged   # staged（默认，三轮）| single（一次写完整剧本）
```

角色提示词很短、或想省调用次数时设 `pipeline: single`，行为与之前完全一致：一次输出完整的
`ournotes.story-script/1`，可选的 `llm.directorPlan` 仍可先写一份分镜计划。

## 站点格式与 AI 管线

两条路径使用同一个脚本格式：

- **产品站点**（`nnnotes.product/1`）：`/api/v1/generate` 的 AI 队列、TTS、`scripts/story-author.mjs` 使用的路径。TTS 会为每句生成语音，注入 `VoiceIDs`，并用 `airlipsync_voice` 驱动口型。
- **站点格式**（`ournotes.story-manifest/2`，bdon.moe 剧情播放器）：`host/tools/site-story.mjs` 把同一份脚本编译成新的剧情清单和 `episode.json`，写回站点目录，再由 `host/tools/render-story.mjs` 用 0.1.8 站点引擎渲染。它会把字体产品切换成 browser-font 模式，因此脚本里的新台词不会缺字。
  `host/tools/ai-site-story.mjs` 进一步把站点目录交给 AI 写作器：它生成同一份导演脚本，用内置 TTS 逐句合成（支持情绪参考音频），把 WAV、cue sheet、`VoiceIDs`/`voiceCues` 写回站点，再编译。适合只有 bdon 下载资源、没有 nnnotes 产品站点的场景。

```sh
# 列出站点可用的舞台、BGM、模型、动作、表情
node host/tools/site-story.mjs --site resources/site --base stories/10610.json --list --lang ja

# 把导演脚本编译成站点里的新剧情（adv 90001）
node host/tools/site-story.mjs --site resources/site --base stories/10610.json \
  --script host/fixtures/director-demo.json --adv 90001 --lang ja --title "ライブのあとで"

# 或者让 AI 从一句话写一份，并用内置 TTS 合成（需要 config.yaml 的 LLM 与 TTS）
node host/tools/ai-site-story.mjs --site resources/site --base stories/10610.json --lang ja \
  --prompt "ライブのあと、燈と愛音と爽世が次の演奏について話す" --adv 90002 --minutes 2

# 已经有脚本时只做 TTS + 编译
node host/tools/ai-site-story.mjs --site resources/site --base stories/10610.json \
  --script output/90002.script.json --lang ja --adv 90002 --title "ライブのあとで"

# 渲染
node host/tools/render-story.mjs --site resources/site --story stories/90001.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job director-demo
```

## 能力边界

- 不暴露任意 ADV 命令（例如 `PanV2`、`Pedestal`、`Tilt`、`Role`、`MoveToDirection`、`DoParam`）。分镜用 `Focus` + 远近 + `Track` + 站位 + 黑场完成。
- 不支持逐参数面部曲线；表情必须使用模型自带的 expression。
- 站点格式路径的 TTS 会写成站点内的真实 WAV cue；情绪支持依赖 `tts.emotion` 与角色情绪参考音频。没有情绪参考音频时，只能用语速/温度做有限的语气差异。
- AI 负责“写”，不保证文学质量；格式、名称、站位和镜头目标由校验器兜底。
