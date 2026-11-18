// Prompt construction for the integrated AI story writer. The model gets the site's real names only, the exact script
// format including the director fields (camera focus, track, timed actions, fades, pauses), and the staging rules
// measured from 30 official episodes (8 local chapters plus 22 duo friendship stories; 1300 Talk rows, 1158 text
// lines); the output is checked and repaired afterwards.
import { motionStems } from "../../scripts/lib/story-author/script.js";
import { frameChoices, postEffectChoices, soundChoices, transitionChoices } from "../story/resourceGuide.js";
import { budgetCount, dialogueBudgetFor, directionBudgetFor, gazeBudgetFor, OFFICIAL_TARGETS } from "./official-targets.js";
import { dialoguePersonaPrompt } from "./personas.js";
import {
  formatCategorizedMusic, formatCategorizedSounds, formatCategorizedStages,
  selectPromptCharacterGroups, selectPromptSounds,
} from "./catalogSelection.js";
import { frameLine, postEffectLine, transitionLine } from "./resourceLines.js";

const pct = (value) => Math.round(value * 100);
const pct1 = (value) => (Math.round(value * 1000) / 10).toFixed(1);
const fixed = (value, digits = 2) => Number(value).toFixed(digits);
// Per-episode counts are the checked per-text-line rate times the checked
// mean episode length; they are formats of OFFICIAL_TARGETS, not new literals.
const perEpisode = (rate) =>
  (rate * OFFICIAL_TARGETS.textLinesPerEpisodeMean).toFixed(1);

export const MAX_PROMPT_MODELS = 24;
const MAX_MOTIONS = 28;
const MAX_EXPRESSIONS = 16;
const MAX_PLAN_CHARS = 5000;

// What a motion stem does, inferred from the game's names. The model cannot watch the clips, so the prompt gives it
// the meaning and the situation each motion fits; unknown names are listed without a note.
const MOTION_NOTES = [
  [/haruhikage/i, "特殊姿势（爽世的「春日影」动作）"],
  [/confrict/i, "抱臂/纠结"],
  [/note/i, "记笔记"],
  [/nervous/i, "紧张"],
  [/join/i, "凑近/加入"],
  [/check02/i, "看手机/确认"],
  [/check01/i, "查看/确认"],
  [/look02/i, "环视/张望"],
  [/look01/i, "转头看"],
  [/bye02/i, "挥手告别（活泼）"],
  [/bye01/i, "挥手告别"],
  [/denial03/i, "强烈否认/摇头"],
  [/denial02/i, "否认/摇头"],
  [/denial01/i, "轻轻否认"],
  [/surprised02/i, "吃惊后仰"],
  [/surprised01/i, "惊讶"],
  [/question/i, "歪头疑问"],
  [/thinking/i, "思考"],
  [/serious/i, "认真/正色"],
  [/kime/i, "得意/摆姿势"],
  [/angry02/i, "明显生气"],
  [/angry01/i, "生气"],
  [/sad01/i, "失落"],
  [/cry01/i, "哭"],
  [/wink01/i, "眨眼"],
  [/nod02/i, "用力点头"],
  [/nod01/i, "点头"],
  [/smile02/i, "明显的笑"],
  [/smile01/i, "微笑"],
  [/idle01/i, "待机"],
];

export const EXPRESSION_NOTES = [
  [/^exp_grinning01$/i, "黑化阴笑（带脸部阴影、遮眼，严禁用于温暖/友好/开心对话）"],
  [/^exp_shadow0[12]$/i, "阴郁/脸部阴影（带遮眼暗影，只用于低落/阴沉/黑化）"],
  [/^exp_sdeprecate01$/i, "自嘲/苦笑（带脸部阴影）"],
  [/^exp_dispair01$/i, "绝望/失神（可带脸部阴影/发青，不用于温暖/开心对话）"],
  [/^exp_hatred01$/i, "怨恨（带遮眼阴影，只用于敌意/黑化）"],
  [/^exp_mad02$/i, "狂乱（带脸部阴影，只用于失控/敌意）"],
  [/^exp_mad01$/i, "狂怒"],
  [/^exp_envy01$/i, "嫉妒/阴沉（可带脸部阴影）"],
  [/^exp_nohighlight01$/i, "失去高光/失神（不用于温暖/开心对话）"],
  [/^exp_bsmile0[1-6]$/i, "坏笑/得意挑衅笑（部分角色带下脸阴影/发青，不用于温柔/真诚/温暖场景）"],
  [/^exp_smirk01$/i, "坏笑/冷笑（不用于温柔/真诚/温暖场景）"],
  [/^exp_sneer01$/i, "嘲笑/冷笑（不用于温暖/友好场景）"],
  [/^exp_dispase0[12]$/i, "焦躁/发青（脸色发青，不用于温暖/开心场景）"],
  [/^exp_smile0[78]$/i, "笑容变体"],
  [/^exp_smile06$/i, "大笑"],
  [/^exp_smile05$/i, "笑容变体"],
  [/^exp_smile04$/i, "苦笑/勉强笑（多带汗滴，部分角色带遮眼，不用于真诚微笑）"],
  [/^exp_smile03$/i, "笑得更开"],
  [/^exp_smile02$/i, "开心"],
  [/^exp_smile01$/i, "微笑"],
  [/^exp_idle0[1-5]$/i, "平静"],
  [/^exp_serious0[1-3]$/i, "认真"],
  [/^exp_angry03$/i, "生气（部分角色带脸部阴影/遮眼）"],
  [/^exp_angry0[1-6]$/i, "生气"],
  [/^exp_sad0[1-7]$/i, "难过"],
  [/^exp_cry0[1-7]$/i, "哭"],
  [/^exp_shy0[1-4]$/i, "害羞"],
  [/^exp_surprised0[1-5]$/i, "惊讶"],
  [/^exp_pale0[1-3]$/i, "脸色发白/发青（惊恐/受打击，exp_pale02 可带遮眼）"],
  [/^exp_upset0[12]$/i, "不悦/烦躁（部分角色带脸部阴影）"],
  [/^exp_thinking0[1-3]$/i, "思考"],
  [/^exp_heart01$/i, "心动"],
  [/^exp_kime0[1-3]$/i, "得意"],
  [/^exp_amazed0[12]$/i, "无语/错愕"],
  [/^exp_salk01$/i, "闹别扭"],
  [/^exp_pain01$/i, "痛苦"],
  [/^exp_spin0[12]$/i, "晕"],
  [/^exp_nervous01$/i, "紧张"],
  [/^exp_absent01$/i, "走神/呆住"],
  [/^exp_anxiety01$/i, "不安/焦虑"],
  [/^exp_cheer01$/i, "打气/欢呼"],
  [/^exp_dislike01$/i, "厌恶/嫌弃"],
  [/^exp_gaze01$/i, "凝视"],
  [/^exp_jitome01$/i, "半月眼/无语盯"],
  [/^exp_kirakira01$/i, "期待/亮眼"],
  [/^exp_kusogaki01$/i, "狡黠坏笑"],
  [/^exp_motivation0[12]$/i, "有干劲"],
  [/^exp_panic02$/i, "慌张（部分角色带鼻影）"],
  [/^exp_panic0[12]$/i, "慌张"],
  [/^exp_puzzled0[12]$/i, "困惑"],
  [/^exp_question0[12]$/i, "疑问"],
  [/^exp_shock01$/i, "震惊"],
  [/^exp_sing01$/i, "唱歌"],
  [/^exp_tired0[12]$/i, "疲惫"],
  [/^exp_trance01$/i, "陶醉/入迷"],
];

const CORE_EXPRESSION_PRIORITY = [
  "exp_idle01", "exp_smile01", "exp_smile02", "exp_smile03",
  "exp_shy01", "exp_serious01", "exp_sad01", "exp_surprised01",
  "exp_angry01", "exp_thinking01", "exp_cry01", "exp_nervous01",
];

// Measured line styles of the MyGO members in the official friendship episodes (Chinese text): characters must not all
// speak in the same 12~15 character sentence. The site's own characters fall back to the generic rules in the prompt.
const VOICE_STYLES = [
  [/高松\s*灯|高松\s*燈|tomori/i, "6~12 字，常带「……」，很少分两行；句子轻、犹豫，常是不完整的短句。"],
  [/千早\s*爱音|千早\s*愛音|anon/i, "16~24 字，约 2/3 分两行；感叹号和问句多，语气跳脱，爱自己接自己的话。"],
  [/长崎\s*素世|長崎\s*素世|soyo/i, "12~18 字，礼貌委婉，少感叹号；常把真心话藏在客套后面，用「呢/吧」收尾。"],
  [/椎名\s*立希|taki/i, "14~18 字，约一半分两行；直接、短促，爱反问或吐槽，少客套。"],
  [/要\s*乐奈|要\s*樂奈|rana/i, "4~8 字，几乎一行；答非所问，少用感叹号，关注眼前的小东西。"],
];

export const voiceStyleFor = (model) => {
  const hay = `${model.name || ""} ${model.character || ""} ${model.id || ""}`;
  for (const [re, text] of VOICE_STYLES) if (re.test(hay)) return text;
  return "";
};

const noted = (name, table) => {
  for (const [re, text] of table) if (re.test(name)) return text;
  return "";
};

const fmtList = (items, limit, notes = null) => {
  const list = [...new Set(items || [])];
  const shown = list.slice(0, limit).map((name) => {
    const note = notes ? noted(name, notes) : "";
    return note ? `${name}（${note}）` : name;
  });
  return shown.join("，") + (list.length > shown.length ? `，…（还有 ${list.length - shown.length} 个）` : "");
};

// The staged pipeline builds its own prompts from the same tables, so the notes a model reads stay identical.
export const motionListFor = (motions) => fmtList(motionStems(motions), MAX_MOTIONS, MOTION_NOTES);
export const expressionListFor = (expressions) => {
  const unique = [...new Set(expressions || [])];
  const prioritized = [
    ...CORE_EXPRESSION_PRIORITY.filter((name) => unique.includes(name)),
    ...unique.filter((name) => !CORE_EXPRESSION_PRIORITY.includes(name)),
  ];
  return fmtList(prioritized, MAX_EXPRESSIONS, EXPRESSION_NOTES);
};

// A sheet matches by name, by a romanized alias, or by the character key inside a site model id
// (`adv_live2d_nagi_018_...` + alias "nagi"). The first match wins, so a directory sheet can be overridden by an
// explicit story.personas entry with the same name.
export const personaEntryFor = (personas, model) => {
  const list = personas || [];
  // an exact display-name match beats a romanized alias: 丰川祥子 is not 白祥 (the CRYCHIC-era sheet also says Sakiko)
  const exact = list.find((p) => p.name && (p.name === model.name || p.name === model.character));
  if (exact) return exact;
  const hay = `${model.id || ""} ${model.name || ""} ${model.character || ""}`.toLowerCase();
  for (const p of list) {
    const name = String(p.name || p.character_name || "").trim();
    if (!name) continue;
    const aliases = [name, ...(Array.isArray(p.aliases) ? p.aliases : [])]
      .map((a) => String(a).trim().toLowerCase()).filter(Boolean);
    if (aliases.some((a) => hay.includes(a))) return p;
  }
  return null;
};

export const personaFor = (personas, model) => String(personaEntryFor(personas, model)?.prompt || "").trim();

const firstOf = (list, preferred) => {
  const names = [...new Set(list || [])];
  for (const p of preferred) if (names.includes(p)) return p;
  return names[0] || "";
};

// A compact director's note from the model: title, logline and the intended shot flow. It is not parsed as a script;
// the script prompt reads it as notes, so a malformed plan only loses the notes.
export const buildPlanMessages = ({ catalog, request, config }) => {
  const language = request.language || catalog.language;
  const minutes = Number(request.targetMinutes ?? config.story.targetMinutes ?? 3);
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  const charGroups = selectPromptCharacterGroups(catalog.models || [], { query: request.prompt || "", maxCap: MAX_PROMPT_MODELS });
  const models = [...charGroups.values()].map((list) => list[0]).filter(Boolean);
  const cast = models.map((m) => `- ${m.name}${m.band ? `（${m.band}）` : m.character && m.character !== m.name ? ` (${m.character})` : ""}`).join("\n");
  const stages = formatCategorizedStages(catalog.stages || [], {
    query: request.prompt || "",
    castBands: models.map((m) => m.band),
    limit: 64,
  });
  return [
    {
      role: "system",
      content: [
        "你是《BanG Dream! Our Notes》的 ADV 分镜导演。",
        "先写一份短小的导演计划，只输出一个 JSON 对象，不要 markdown 或解释。",
        `计划服务于后面要写的 ournotes.story-script/1：一场戏只写一个很小的具体事件，同台最多 ${maxOnStage} 人，`,
        "通常只有一个 stage，靠 positions 换组、focus/track 换镜头，而不是靠 fade 换场。",
        "镜头每 3~4 句换一次：双人戏用二人同框（middle）和说话者近景（close）交替；三人同台默认 near 群像（1.2×），近景只拍单人特写（focus 指向一个人）。不要每 1~2 句切。",
        "镜头档位：full 1.0× / near 1.2× 是宽景与多人全景（三人 1/5/9 或 4~5 人同台默认用 near 1.2×）；middle 1.4× 是双人中景；far 1.8× 是紧中景（只用于单人或 left/right 紧双人，不能拍 1/5/9 三人群像）；close 2.8× 是情绪近景；very-close 4× 是大特写。",
      ].join("\n"),
    },
    {
      role: "user",
      content: `## 场景要求
${request.prompt || "写一段安静的日常对话。"}

时长约 ${minutes} 分钟，语言 ${language}。可用角色：
${cast || "(none)"}

可用场景：
${stages || "(none)"}

## 输出 JSON
{
  "title": "短标题",
  "logline": "一句话概括这一场戏",
  "cast": ["角色显示名"],
  "arc": "情绪/事件如何开始、转折、收束",
  "scenes": [
    {"stage": "舞台 id", "location": "地点字幕", "purpose": "这场戏的作用",
     "shots": [
       {"beat": "这一拍发生什么", "speaker": "谁说话", "camera": "near|middle|far|close",
        "focus": "镜头对着谁/哪个构图点", "track": "镜头横向偏移", "acting": "谁做什么反应"}
     ]}
  ],
  "ending": "最后一句/最后一个画面"
}
要求：一段 60~120 秒的连续戏；先选一个具体的小事件；每 3~4 句换一次构图，二人同框和说话者一侧交替；
不要每拍都换 stage。只输出 JSON。`,
    },
  ];
};

// The staging prose both pipelines share: the single call carries it in its system prompt, the storyboard pass in its
// system prompt too, so a change to the measured rules reaches both. maxOnStage 3 is the official group layout: two
// people stand at left / right, a third at center. maxOnStage 2 keeps only the pair and has the third wait
// outside, for operators who want no adjacent slots at all. `budget` is the actual direction budget for this scene, so
// the shared system rules and the per-scene user block cannot state different counts.
export const stagingRules = (maxOnStage = 3, budget = null) => {
  const limit = Math.max(2, Math.min(3, Math.round(Number(maxOnStage) || 3)));
  const gaze = budget ? gazeBudgetFor(budget) : null;
  const budgetLine = budget
    ? `本场预算：Focus 约 ${budget.focusChanges} 次、close 约 ${budget.closeUps} 次、` +
      `zoom ${budget.zoomMin}~${budget.zoomMax} 次、总视线（lookAt + 独立 look）约 ${gaze.total} 次、` +
      `Se 约 ${budget.se} 条、Track 约 ${budget.track} 次。`
    : "";
  // Extended camera and FX are motivated by dramatic/physical beats rather than forced per-scene floors on static chats.
  const extensionBudget = budget
    ? `扩展运镜（按剧情动机使用，静态双人对话可为 0，不要无故上下左右晃镜头）：` +
      `Pedestal ${budgetCount(0, budget.pedestal)} 次、PanV2 ${budgetCount(0, budget.panV2)} 次、` +
      `DoF ${budgetCount(0, budget.dof)} 次、独立 look 最多 ${gaze.independentMax} 次` +
      `（计入上面的总视线，不额外增加）、Se 约 ${budget.se} 条。`
    : "";
  return [
    `一场戏只写一个很小的具体事件（拍照、找东西、等人、收拾器材、分零食、试新曲……），${limit === 2 ? "2 人一组" : "2~3 人一组"}（需要时让其他成员分批进出，同台最多 ${limit} 人）；不要世界观解说、比赛结果或生离死别。`,
    limit === 2
      ? "同一场最多 2 人同台；开场先 1 人，2~4 句后用 positions 让下一人进场；第 3 人必须等一人退场后再进场；换组时已有人保持原位，只让 1 人进出。"
      : "同一场最多 3 人同台；开场先 1 人，2~4 句后用 positions 让下一人进场；换组时已有人保持原位，只让 1 人进出。",
    limit === 3
      ? "两人同台用 left / right（间隔自然，不要用 far-left / far-right）；三人同台用 far-left / center / far-right（camera near，focus 5，track 0），默认 near 1.2× 群像（可用 positions 的 dz: 0.6~1.5 做景深错位）；近景只允许 close/very-close 的单人特写（focus 指向一个人），不用 far（1.8× 会切掉两侧角色），也不写群像推近。不要用 center+right 或 center+left，两个角色会叠在一起。"
      : "两人同台用 left / right（间隔自然，不要用 far-left / far-right）；不要用 center+right 或 center+left，两个角色会叠在一起。",
    "镜头档位：full 1.0× / near 1.2× 是最广的多人全景（三人 1/5/9 或 4~5 人同台默认用 near 1.2×，双人戏开场/收尾可用 0~1 次，不要把 near 当近景）；middle 1.4× 是双人中景（默认）；far 1.8× 是紧中景（只用于单人中近景或 left/right 紧双人，绝不用于 1/5/9 三人群像）；close 2.8× 是情绪近景；very-close 4× / macro 6× 是大特写（最多 1 次）。",
    "镜头每 3~4 句换一次：双人戏用二人同框（middle，focus 5）和说话者近景（close，focus 该角色）交替；三人同台用 near + focus 5 群像，或单人特写（close，focus 该角色），不用 far 拍三人同框，也不写群像推近。不要每句切，也不要只在一个机位站桩。近景停 1~2 句（偶尔 3 句），随后回到二人/群像；不要连续两句都切 close。",
    budgetLine,
    extensionBudget,
    `慢推镜（可选）：zoom 1.03~1.10 缓慢推近、0.92~0.98 拉远，zoomDuration 3~5 秒、ease "OutSine"；${budget ? `一场 ${budget.zoomMin}~${budget.zoomMax} 次` : "次数按本场预算"}，官方最常见值是 ${OFFICIAL_TARGETS.zoomDefault}，但本脚本默认只写缓慢推拉；只给情绪句、近景或结尾，一个机位最多 1 次。`,
    "有动机的运镜与特效触发（禁止无意义抖动，所有开关型效果必须在场末/切幕前收回）：\n" +
      "- 情绪转折/告白：ease \"OutSine\" + zoom 推近 + 背景虚化（dof 0.4~0.7，dofLayers 0；绝不虚化聚焦说话者，角色 dofLayers 2 必须写 dofTarget 指向非说话者）+ 可选 bgm: \"stop\"（bgmFade 1.5）留白。\n" +
      "- 多句环绕漂移（PanV2）：只在多句连续倾诉、换组或视线转移时写（pan -12~12，panDuration 3~6，ease \"OutSine\" 或 \"Linear\"），自动不阻塞台词（IsNoWait）。\n" +
      "- 沉默反应与心声：无台词停顿用 hideTalk: true 配合 pause（>= 0.6 秒会自动收起对话框）或 action 拍；纯省略号或内心独白写 thought: true / ignoreLipSync: true 防止空张嘴。\n" +
      "- 走位与蹲起：已出场角色换位直接用 positions 或 move（{cast, to/dir/dx/dy/dz, duration}），不要 Out+In 闪人；弯腰/蹲下找东西用 move {dir: \"down\", distance: 0.25} 配合 pedestal -0.25 与 focusTargetHead: true，起身用 dir: \"up\" 恢复。\n" +
      "- 倾斜、冲击与视线：angle {z: -12~12} 做歪头/迟疑；爆发/吐槽用 shake {target: \"ui\", power: 3~5} 震动对话框；低头回避用 look: 0.4, lookY: -0.5~-0.8，抬头用 look: \"stop\"（或 lookAt: \"stop\"）收回。\n" +
      "- 回忆与独白：用 postEffect（如 reminiscence1/2）、frame（如 letterbox_black/fog）、brightness {target: \"bg\", value: 0.5}、fadeColor \"#FFFFFF\" / transition \"dissolve\"，结束时用 postEffectStop: true / frameStop: true / brightness 1 复位。",
    `表演：一句台词最多一个说话者动作，听者反应最多一个；约 ${pct(OFFICIAL_TARGETS.noMotionShare)}% 的台词没有 Motion；表情和动作一起写，默认 idle，不要每句都笑。exp_grinning01、exp_shadow01/02、exp_hatred01、exp_dispair01、exp_mad02、exp_sdeprecate01、exp_nohighlight01 等带脸部阴影/遮眼/失神效果的表情只用于阴沉、黑化、绝望或敌意台词；温暖、开心、鼓励、和解或友好道别（如「明天见」「谢谢」）严禁使用这类阴影表情，也不要用 exp_bsmile*/exp_smirk01 坏笑代替温和微笑（请用 exp_smile01/02/03、exp_shy01 或 exp_idle01）。动作写 stem（如 mtn_smile01），编译器会按左 _L / 中 _C / 右 _R 自动面向对话伙伴；只有刻意转头避开或正对镜头时才写完整 _L/_C/_R 后缀。close/very-close 单人近景自动对齐角色头部高度（TargetName），middle/far 蹲起或身高差时也可显式设 focusTargetHead: true。`,
    limit === 2
      ? `视线：双人戏每 3~4 句写一个 lookAt，不要每 1~2 句都写；角色把视线移开时用独立 look/lookY（最多 ${gaze?.independentMax ?? 2} 次，计入总视线预算），结束后用 look: "stop" 收回。`
      : `视线：双人戏每 3~4 句写一个 lookAt，三人以上只在被点名或明显反应时用；角色把视线移开时用独立 look/lookY（最多 ${gaze?.independentMax ?? 2} 次，计入总视线预算），结束后用 look: "stop" 收回。`,
    "留白只用于 0.1~0.5 秒的呼吸（或 >= 0.6 秒 hideTalk 沉默拍）；fade out/in 只用于真正的时间或地点跳跃。",
  ].filter(Boolean).join("\n");
};

// The one denominator note both prompts print: the official rate is per Talk
// row, while generated scripts have no blank Talk rows and the budget is per
// text-bearing line.
export const officialDenominatorNote = () =>
  `口径：官方 Focus ${fixed(OFFICIAL_TARGETS.focusPerTalkRow, 3)}/Talk 行（含空白 Talk 行）；` +
  `生成脚本没有空白 Talk 行，预算按 ${fixed(OFFICIAL_TARGETS.focusPerTextLine, 3)}/有文本行换算。` +
  `近景 distance 4 的 Talk 行占比 ${pct1(OFFICIAL_TARGETS.distance4Share)}%，` +
  `按有文本行是 ${pct1(OFFICIAL_TARGETS.distance4TextLineShare)}%。`;

// `plan`: the director's plan (object or text), shown to the script writer as notes.
export const buildStoryMessages = ({ catalog, request, config, plan = null }) => {
  const language = request.language || catalog.language;
  const title = request.title || config.story.title || "";
  const minutes = Number(request.targetMinutes ?? config.story.targetMinutes ?? 3);
  const maxLines = Number(request.maxLines ?? config.story.maxLines ?? 120);
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story.maxOnStage ?? 3) || 3)));
  // One shared line/character budget for both pipelines; maxLines stays a configured cap applied after it.
  const budget = dialogueBudgetFor(minutes);
  const lineBudget = Math.min(maxLines, Math.max(1, budget.lines, budget.minLines));
  const maxLineTarget = Math.max(1, Math.min(budget.maxLines, maxLines));
  const minLineTarget = Math.min(budget.minLines, maxLineTarget);
  const lineRange = `${minLineTarget}~${maxLineTarget}`;
  // The single system prompt and user prompt share one scene budget, just like
  // the staged storyboard system/user pair.
  const direction = directionBudgetFor(lineBudget);
  const gaze = gazeBudgetFor(direction);
  const charGroups = selectPromptCharacterGroups(catalog.models || [], { query: request.prompt || "", maxCap: MAX_PROMPT_MODELS });
  const models = charGroups.size <= 6
    ? [...charGroups.values()].flat()
    : [...charGroups.values()].map((list) => list[0]).filter(Boolean);
  const modelLines = models.map((m) => {
    // The single pass writes dialogue too, so a persona is trimmed the same way the staged dialogue pass trims it.
    // The fast cast has usually narrowed the pool to 1~3 models by now, so the full sheet would also fit — the trim
    // keeps the two paths consistent for operators who do configure 20 KB sheets.
    const persona = dialoguePersonaPrompt(personaEntryFor(config.story.personas, m));
    const style = voiceStyleFor(m);
    return [
      `- model: ${m.id}`,
      `  name: ${m.name}${m.character && m.character !== m.name ? ` (character: ${m.character})` : ""}`,
      `  costume: ${m.costumeLabel || m.costume || "默认服装"}`,
      `  motions: ${motionListFor(m.motions) || "(none)"}`,
      `  expressions: ${expressionListFor(m.expressions) || "(none)"}`,
      m.defaultMotion ? `  default motion: ${m.defaultMotion}` : "",
      m.defaultExpression ? `  default expression: ${m.defaultExpression}` : "",
      persona ? `  persona: ${persona}` : "",
      style ? `  line style: ${style}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");

  const resolvedSounds = soundChoices(catalog.soundChoices || catalog.sounds || []);
  const resolvedFrames = frameChoices(catalog.frameChoices || catalog.frames || []);
  const resolvedPostEffects = postEffectChoices(catalog.postEffectChoices || catalog.postEffects || []);
  const resolvedTransitions = transitionChoices(catalog.transitionChoices || catalog.transitions || []);
  const stageLines = formatCategorizedStages(catalog.stages || [], {
    query: request.prompt || "",
    castBands: models.map((m) => m.band),
    limit: 80,
  });
  const musicLines = formatCategorizedMusic(catalog.music || [], { query: request.prompt || "", limit: 91 });
  const pickedSounds = selectPromptSounds(resolvedSounds, { query: request.prompt || "", limit: 72 });
  const soundLines = formatCategorizedSounds(pickedSounds, { query: request.prompt || "", limit: 72 });
  const frameLines = resolvedFrames.slice(0, 24).map(frameLine).join("\n") || "(none)";
  const postEffectLines = resolvedPostEffects.slice(0, 24).map(postEffectLine).join("\n") || "(none)";
  const transitionLines = resolvedTransitions.slice(0, 16).map(transitionLine).join("\n") || "(none)";
  const exampleSe = pickedSounds[0]?.cue || resolvedSounds[0]?.cue || "";
  const history = Array.isArray(request.history) ? request.history.slice(-6) : [];
  const historyBlock = history.length
    ? `\n## 最近对话（只用于保持称呼、关系和语气，不要复述）\n${
      history.map((item) => `${item.role}：${item.content}`).join("\n")}\n`
    : "";
  const chatNote = request.mode === "chat"
    ? "\n这是一次即时对话回复：围绕用户最后这句话写一小段互动，比完整短剧更短、更直接；不要展开完整起承转合。\n"
    : "";

  const system = [
    "你是《BanG Dream! Our Notes》的 ADV 分镜演出家，不是小说作者。",
    "只输出一个合法 JSON 对象，不要 markdown、代码围栏、解释或前后缀。",
    "JSON 必须符合 ournotes.story-script/1 格式；所有模型、舞台、音乐、动作、表情名称必须来自用户给出的清单。",
    "你写的是可以直接播放的连续演出，不是站桩对话：谁站在哪、镜头看谁、什么时候切近景、说话者做什么动作、听者怎么反应。",
    `篇幅：整场 ${lineRange} 条有文本台词（目标约 ${lineBudget} 条；官方 30 部均值约 ${OFFICIAL_TARGETS.textLinesPerEpisodeMean.toFixed(1)} 条）；不要写 10 句就收尾，也不要每句都推进剧情。`,
    stagingRules(maxOnStage, direction),
    config.llm.systemPrompt || "",
  ].filter(Boolean).join("\n");

  // The site lists one model per costume; the example must not cast the same character twice under two outfits.
  const distinct = [];
  for (const m of models) {
    const key = m.character || m.name;
    if (!distinct.some((x) => (x.character || x.name) === key)) distinct.push(m);
  }
  // Prefer the MyGO pair the official friendship episodes use most (Tomori + Anon); other casts keep catalog order.
  const preferred = VOICE_STYLES.map(([re]) => re);
  const ordered = [];
  for (const re of preferred) {
    const m = distinct.find((x) => re.test(`${x.name || ""} ${x.character || ""} ${x.id || ""}`));
    if (m && !ordered.includes(m)) ordered.push(m);
  }
  for (const m of distinct) if (!ordered.includes(m)) ordered.push(m);
  const a = ordered[0] || models[0], b = ordered[1] || models[1] || a;
  const aMotions = motionStems(a.motions), bMotions = motionStems(b.motions);
  const aMotion = firstOf(aMotions, ["mtn_smile02", "mtn_smile01", "mtn_nod01"]);
  const aMotion2 = firstOf(aMotions, ["mtn_nod01", "mtn_smile01", "mtn_serious01"]);
  const bMotion = firstOf(bMotions, ["mtn_nod01", "mtn_smile01", "mtn_serious01"]);
  const bMotion2 = firstOf(bMotions, ["mtn_smile01", "mtn_nod01", "mtn_serious01"]);
  const aExp = firstOf(a.expressions, ["exp_smile01", "exp_idle01"]);
  const bExp = firstOf(b.expressions, ["exp_smile01", "exp_idle01"]);
  const aIdle = firstOf(a.expressions, ["exp_idle01", "exp_idle02", "exp_idle03"]) || aExp;
  const bIdle = firstOf(b.expressions, ["exp_idle01", "exp_idle02", "exp_idle03"]) || bExp;
  const bShy = firstOf(b.expressions, ["exp_shy01", "exp_shy02", "exp_shy03"]) || bExp;
  const stage0 = catalog.stages[0]?.id || "stage_id";

  const cast = { a: { model: a.id, name: a.name }, b: { model: b.id, name: b.name } };
  const beats = [
    // one character opens alone at left; the second enters at right after three lines
    { scene: stage0, location: "地点", focus: "left", camera: "middle", positions: { a: "left" } },
    { say: "a", text: "今天也……顺利练完了呢。",
      ...(aMotion ? { motion: aMotion } : {}), ...(aExp ? { expression: aExp } : {}) },
    { say: "a", text: "……嗯。" },
    { say: "a", text: "下次……再慢一点吧。", ...(aMotion2 ? { motion: aMotion2 } : {}),
      ...(aIdle ? { expression: aIdle } : {}) },
    // the second character enters; the two-shot uses focus 5 and one small track pan
    { positions: { a: "left", b: "right" }, focus: 5, camera: "middle", track: 0.2 },
    { say: "b", text: "嗯。刚开始还担心会来不及。\n不过今天总算跟上了！", ...(bMotion ? { motion: bMotion } : {}),
      ...(bExp ? { expression: bExp } : {}), lookAt: "a" },
    { say: "a", text: "你也会……担心吗？", ...(aMotion2 ? { motion: aMotion2 } : {}),
      ...(aIdle ? { expression: aIdle } : {}), lookAt: "b",
      ...(bMotion2 ? { actions: [{ at: 0, cast: "b", motion: bMotion2 }] } : {}) },
    { say: "b", text: "……会啊。\n毕竟是你的事嘛。", ...(bMotion2 ? { motion: bMotion2 } : {}),
      ...(bShy ? { expression: bShy } : {}) },
    { say: "a", text: "那……下次一起练到最后一班车吧。",
      ...(aMotion ? { motion: aMotion } : {}), ...(aExp ? { expression: aExp } : {}), lookAt: "b" },
    // the one close-up of the scene (2.8x) on the emotional line; a reacts before it, and the next line eases back
    // to the two-shot (middle, focus 5) instead of holding the close-up to the end
    { say: "b", text: "……嗯。那就这么说定了！\n下次可别再一个人闷着练了。", ...(bMotion2 ? { motion: bMotion2 } : {}),
      ...(bExp ? { expression: bExp } : {}), focus: "b", camera: "close", zoom: 1.06, zoomDuration: 4,
      ...(exampleSe ? { se: exampleSe, seDuration: 1.5, seDelay: 0.2 } : {}),
      ...(aMotion2 ? { actions: [{ at: 0, cast: "a", motion: aMotion2 }] } : {}) },
    { say: "b", text: "……回去吧。", ...(bMotion ? { motion: bMotion } : {}),
      ...(bIdle ? { expression: bIdle } : {}), camera: "middle", focus: 5 },
  ];
  const example = {
    format: "ournotes.story-script/1",
    base: catalog.manifest,
    language,
    title: title || "标题",
    font: config.story.font || "sans",
    cast,
    beats,
  };

  const planNotes = plan
    ? `\n## 导演计划（参考，不要照抄字段）\n${(typeof plan === "string" ? plan : JSON.stringify(plan)).slice(0, MAX_PLAN_CHARS)}\n`
    : "";

  const user = `## 任务
${request.mode === "chat"
    ? `写一小段约 ${minutes} 分钟的 Our Notes 对话回复。用户最后说的是：`
    : `写一场约 ${minutes} 分钟的 Our Notes 风格短剧。用户给出的场景/要求是：`}

${request.prompt || "写一段安静的日常对话。"}
${chatNote}${historyBlock}
- 语言：${language}（台词用该语言写；示例台词只是演示节奏）
- 标题：${title || "由你取一个贴合场景的短标题"}
- 台词总量 ${lineRange} 条（目标约 ${lineBudget} 条，按有文本 Talk 行计）；一场戏只推进一个事件或一个情绪转折。
- 可用的底本 base：${catalog.manifest}（必须原样写入脚本的 base 字段）
- 可用语言：${(catalog.languages || [language]).filter(Boolean).join(", ")}
${planNotes}
## 官方节奏（30 部官方样本：8 部本地章节 + 22 部双人友情戏）
- 台词：整条台词常见 1~${OFFICIAL_TARGETS.lineCharsP90} 字（均值 ${fixed(OFFICIAL_TARGETS.lineCharsMean, 1)} 字、中位 ${OFFICIAL_TARGETS.lineCharsMedian}、p90 ${OFFICIAL_TARGETS.lineCharsP90}）；显式换行片段常见 7~17 字、均值 ${fixed(OFFICIAL_TARGETS.segmentCharsMean, 1)} 字；约 ${pct(OFFICIAL_TARGETS.twoLineShare)}% 两行，三行以上不足 1%；2~6 字短反应约 ${pct(OFFICIAL_TARGETS.shortShare)}%；省略号约 ${pct(OFFICIAL_TARGETS.ellipsisShare)}%、问号约 ${pct(OFFICIAL_TARGETS.questionShare)}%、叹号约 ${pct(OFFICIAL_TARGETS.exclaimShare)}%。
- 话轮：约 ${pct(OFFICIAL_TARGETS.soloRunShare)}% 的连续说话人段只有一句，均值约 ${fixed(OFFICIAL_TARGETS.speakerRunMean, 1)} 句；官方单集约 ${OFFICIAL_TARGETS.textLinesPerEpisodeMin}~${OFFICIAL_TARGETS.textLinesPerEpisodeMax} 条有文本台词（均值约 ${fixed(OFFICIAL_TARGETS.textLinesPerEpisodeMean, 1)}，时长约 1~2.5 分钟），本场按 ${OFFICIAL_TARGETS.linesPerMinute} 条/分钟换算成上面的目标范围。先 1 人开场，2~4 句后第二人进场；不要机械一人一句，也不要每次都写长段。
- 镜头：Focus 约 ${fixed(OFFICIAL_TARGETS.focusPerTalkRow, 2)}/句（按 Talk 行计；按有文本行约 ${fixed(OFFICIAL_TARGETS.focusPerTextLine, 2)}）；距离 2/3/4 分别约 ${pct(OFFICIAL_TARGETS.distance2Share)}%/${pct(OFFICIAL_TARGETS.distance3Share)}%/${pct(OFFICIAL_TARGETS.distance4Share)}%；近景段长 0~2 句（空镜按 1 段；末尾空白 Talk 会缩短段长）约占 ${pct1(OFFICIAL_TARGETS.closeRunOneOrTwoShare)}%，每 3~4 句换一次构图。
- ${officialDenominatorNote()}
- 运镜：官方常用 Focus、Track、Zoom、Pedestal、PanV2、DoF；Zoom 每集约 ${perEpisode(OFFICIAL_TARGETS.zoomPerTextLine)} 次、Pedestal 约 ${perEpisode(OFFICIAL_TARGETS.pedestalPerTextLine)} 次、PanV2 约 ${perEpisode(OFFICIAL_TARGETS.panV2PerTextLine)} 次、DoF 约 ${perEpisode(OFFICIAL_TARGETS.dofPerTextLine)} 次；Se 每集约 ${perEpisode(OFFICIAL_TARGETS.sePerTextLine)} 条、Bgm 每集约 ${fixed(OFFICIAL_TARGETS.bgmPerEpisode, 1)} 条。AI 每场默认 ${direction.zoomMin}~${direction.zoomMax} 次 Zoom、0~${direction.track} 次 Track，Pedestal ${budgetCount(0, direction.pedestal)} 次、PanV2 ${budgetCount(0, direction.panV2)} 次（仅在动作蹲起、多句倾诉漂移或换组时触发，静态双人对话可为 0）、DoF ${budgetCount(0, direction.dof)} 次（官方实测频率），Se 约 ${direction.se} 条/场。
- 表演：Motion 约 ${fixed(OFFICIAL_TARGETS.motionsPerTextLine, 2)}/句；约 ${pct(OFFICIAL_TARGETS.noMotionShare)}% 的句子没有 Motion；约 ${pct1(OFFICIAL_TARGETS.twoMotionShare)}% 的有文本行有 2 个以上表演动作 (Motion + Expression + Look + LookTarget)；独立 Expression 每集约 ${fixed(OFFICIAL_TARGETS.standaloneExpressionPerEpisode, 2)} 条（默认 0~1 条/场），表情都挂在 Motion 上。
- 视线：Look + LookTarget 约 ${fixed(OFFICIAL_TARGETS.lookAnyPerTextLine, 2)}/句（${pct(OFFICIAL_TARGETS.lookLineShare)}% 的句子带视线）；总视线（lookAt + 独立 look）约 ${gaze.total} 次/场，其中独立 look 最多 ${gaze.independentMax} 次（计入总视线，不额外增加）；双人戏每 3~4 句一个 lookAt。
- 10610 的 13 句教学场是特例（10 Focus / 5 Track / 20 Motion），镜头更碎；日常戏不要照它的密度写。

## 输出格式（ournotes.story-script/1）
一个 JSON 对象，只能有以下顶层键：format, base, language, title, font, cast, beats。
示例（只参考结构和节奏，名称请换成清单中的真实名称，台词请用 ${language}；不要照抄示例句子）：

${JSON.stringify(example, null, 2)}

## beat 规则
- 第一个 beat 必须是 scene。scene beat：{"scene": 舞台 id, "location": 地点文字, "camera": "full|near|middle|far|close|very-close|macro" 或 {"distance","focus","track"}, "focus": 可选, "track": 可选, "music": 可选, "transition": "fade|dissolve", "transitionDuration": 可选, "fadeRule": "0001..0005", "fadeColor": "#000000|#FFFFFF", "positions": {角色: 位置或 {"at","dx","dy","dz","motion","expression"}}, "id": 可选}。scene 的 positions 只放 1 人，其余角色 2~4 句后再进场。
- positions beat：{"positions": {角色: 位置或 {"at","dx","dy","dz"}}, "camera": 可选, "focus": 可选, "track": 可选, "moveDuration": 可选}。位置只能是 far-left, left, center, right, far-right；两个角色不能占同一位置。省略的角色退场，新角色进场。**两人同台用 left / right**（不要用 far-left / far-right，间隔太开）；${maxOnStage === 3 ? "三人同台用 far-left / center / far-right（camera near，focus 5，track 0），默认 near 群像；近景只拍单人特写（close/very-close，focus 指向一个人），不用 far（1.8× 会切掉两侧角色）或群像推近" : `同台最多 ${maxOnStage} 人，第 3 人必须等一人退场后再进场`}；不要用 center+right 或 center+left（会重叠）。一场最多 2 次 positions 变化；换组时让已有人物保持原位，只让 1 人进出；已出场角色微调位置会由 MoveToDirection 平滑移动（不要靠 Out+In 闪人）。
- say beat：{"say": 角色 cast id, "text": 台词, "thought": 可选布尔, "ignoreLipSync": 可选布尔, "hideTalk": 可选布尔, "motion": 可选说话者动作, "expression": 可选说话者表情, "lookAt": 可选或"stop", "focus": 可选, "camera": 可选, "track": 可选, "zoom": 可选, "zoomDuration": 可选, "focusTargetHead": 可选布尔, "ease": 可选, "actions": 可选, "id": 可选}。说话者必须已经站在舞台上。**不写 focus/camera/track 就保持当前镜头**；同一组连续对话不要每句都写镜头字段。表情尽量和 motion 一起写；没有 motion 就尽量不改表情。
- narrate beat：{"narrate": 旁白文字, "thought": 可选, "ignoreLipSync": 可选, "hideTalk": 可选, "focus": 可选, "camera": 可选, "track": 可选, "zoom": 可选, "zoomDuration": 可选, "actions": 可选}。旁白的 actions 必须写 cast。narrate 全场 0~2 句，放在开场、沉默反应或收尾，用「（……）」这种短句，不要小说式描写。
- camera beat：{"camera": "full|near|middle|far|close|very-close|macro" 或 {"distance","focus","track"}, "focus": 可选, "track": 可选, "zoom": 可选, "zoomDuration": 可选, "cameraDuration": 可选秒, "ease": 可选}。只移动镜头，不改变站位。只改距离时保持同一个 focus；near 是宽景/三人全景（双人戏最多 1 次）；close 近景约占 ${pct1(OFFICIAL_TARGETS.distance4TextLineShare)}% 的有文本行（本场约 ${direction.closeUps} 次），每次 1~2 句（偶尔 3 句）。
- fade / pause / action / move / angle / bgm / frame / postEffect / brightness / shake / cameraShake / flash / talkWindow / hideTalk beat：fade 只用于时间/地点跳跃（可配 fadeRule/fadeColor）；pause 用于 0.1~0.5 秒呼吸或 >= 0.6 秒 hideTalk 沉默拍；action 是无台词反应镜头；bgm: {"bgm": cue 或 "stop", "bgmFade": 秒} 可在场中转折停乐或换曲；其余 FX beat 见下方扩展字段。
- focus：优先写位置名；两人同框用 focus: 5，单人近景用角色 id 或该角色的位置名；角色 focus 只给情绪最重的 1~2 句。不要用 2/4/6/8 去框 left/right 的两个人。close / very-close **必须**给角色 id 或该角色的位置名，不要用 focus 5；单人特写默认对准头部锚点，蹲起或身高差可显式设 focusTargetHead: true。
- 近景节奏：close 只切给情绪最重的 1~2 句；下一句用 middle（双人）/ near（三人）+ focus 5 回到二人/群像，不要连续两句 close，也不要从 close 直接切到另一个 close；三人同台时用 near 群像，近景只给单人特写（close/very-close，focus 该角色），不用 far 拍三人群像（1.8× 会切掉两侧角色），也不写群像推近。推近时保持同一侧 focus，只改 camera distance，不要换焦点。
- track：镜头相对焦点的横向偏移，-4~4（close 时自动限幅 ±0.25，very-close 强制 0）；0 是正对焦点。两人对话用 ±0.2~0.8，群像横移可用 ±1.2~2。一场 0~${direction.track} 次，双人通常 0~1 次；只在换组/群像横移时写，不要每句微调。
- zoom：镜头缓慢推近/拉远，1.03~1.10 推近、0.92~0.98 拉远；zoomDuration 3~5 秒、ease "OutSine"。一场 ${direction.zoomMin}~${direction.zoomMax} 次，只给情绪句、近景或结尾，一个机位最多 1 次；不写就静止。
- actions：一句台词内的听者反应，最多 1 条（加上 say.motion 共 2 个动作）：{"at": 0~1, "cast": 可选（默认说话者）, "motion": 可选, "expression": 可选, "lookAt": 可选或"stop"}。至少写 motion/expression/lookAt 之一；cast 必须在台上。**听者反应一律写 at: 0**；官方样本没有句中动作，不要用 0.3~0.7。
- lookAt：一个站在台上的 cast id、位置名、1~9 的构图点，或 "stop" 收回视线。双人戏每 3~4 句写一个 lookAt；总视线（lookAt + 独立 look）约 ${gaze.total} 次/场，独立 look 最多 ${gaze.independentMax} 次（计入总视线）。
- cast id 是字母开头、只含字母数字下划线的字符串；cast 的 model 必须是下方清单里的 model id，name 是显示名。
- motion 优先写清单中的 stem（如 mtn_smile01），编译器按左侧 _L / 中间 _C / 右侧 _R 自动选择面向伙伴的变体；只有刻意背对/正对时才写完整带后缀名；expression 必须是完整名。动作说明（括号里）是按名称推断的，只用来帮你选，不要写进 JSON。
- 同一时刻最多 3 个角色在台上；用 positions 换组，不要为每次换人新开一个 scene。
- 台词每行不超过 22 个全角字符，单条最多 2 行（用 \\n 换行）；约 ${pct(OFFICIAL_TARGETS.twoLineShare)}% 两行；约 ${pct(OFFICIAL_TARGETS.shortShare)}% 是 2~6 字的短反应；不要空行，不要首尾空白。
- 不要输出清单之外的任何名称；不确定的动作/表情/特效就省略该字段。
- 结尾用一句短话、一个小动作或一句没说完的话收束，不要总结主题，不要写“未完待续”。

## 扩展运镜、演出特效与声音字段（可直接写在对应 beat 顶层）
按剧情动机选用，静坐日常对话不强求填满；所有开启的状态效果（DoF/Role/Tilt/Brightness/Frame/PostEffect/CameraShake/Look）在转折结束或离场前需成对收回。只能使用下方清单里已有的名称，数值不要越界。
- focusDuration / trackDuration / moveDuration / ease / cameraDelay / focusSharp / focusTargetHead：focusDuration/trackDuration 0~20 秒（0=硬切，${fixed(OFFICIAL_TARGETS.focusDurationDefault, 1)} 常见；与同拍 zoom/pan/pedestal 并用时 focusDuration 保持 0，避免同轴 tween 冲突）；ease 可选 OutQuad / OutSine / Linear / OutQuint / InOutSine / InOutQuad（Zoom/PanV2 >= 0.8s 默认 OutSine，>= 4s 默认 Linear）；cameraDelay 0~20s；focusSharp: true 清掉景深；focusTargetHead: true 瞄准单人头部高度。
- pedestal / pedestalDuration：Y 偏移 -4~5，duration 0~20，默认 1.5；本场建议 ${budgetCount(0, direction.pedestal)} 次（如蹲下查找时 "pedestal": -0.25，静坐对话可为 0）。
- pan / panDuration / panFocusSlide：角度 -30~30，duration 0~20，focus slide 0~1；本场建议 ${budgetCount(0, direction.panV2)} 次（如多句倾诉 "pan": -8, "panDuration": 4, "ease": "OutSine"，静坐对话可为 0）。
- dof / dofDuration / dofLayers / dofTarget：强度 0~1，duration 0.5~10，layers 0（背景虚化，默认）/ 2（角色虚化）；本场建议 ${budgetCount(0, direction.dof)} 次（"dof": 0.5, "dofLayers": 0）。**背景虚化用 dofLayers: 0 不需 target；dofLayers: 2 必须写 dofTarget 指向非聚焦角色（绝不虚化聚焦说话者）。**
- role / roleDuration / tilt / tiltDuration：role 荷兰角 -30~30，tilt 俯仰角 -15~15（用于不安/仰望，结束时写 0 复位）。
- move / angle：move {"cast"?, "to"?, "dir"?: "left|right|up|down|forward|back", "distance"?, "dx"?, "dy"?, "dz"?, "duration"?, "wait"?}；angle {"cast"?, "z"?, "x"?, "duration"?, "delay"?, "wait"?}（z/x -45~45，结束归 0）。
- look / lookY / lookDuration：x/y -1~1（或 look: "stop" 收回），duration 0.2~10，默认 0.5；独立 look 最多 ${gaze.independentMax} 句（低头回避可用 "look": 0.4, "lookY": -0.6）；与 lookAt 二选一，同一 beat 不要同时写。
- bgm / bgmFade / bgmVolume / bgmStart：say 或 bgm beat 中可写 "bgm": cue 或 "stop"，"bgmFade": 0.5~10，做情感高潮前停乐或换曲。
- frame / frameAction / frameDuration / frameStop：frame 必须来自下方可用画面遮罩清单（无则省略）；带 Show_anime 的遮幅配 frameAction: "Show_anime"，结束时写 frameStop: true。
- postEffect / postEffectDuration / postEffectStop：postEffect 必须来自下方可用后期滤镜清单（无则省略）；回忆/冲击结束时写 postEffectStop: true。
- brightness / shake / cameraShake / flash / talkWindow / hideTalk / thought / ignoreLipSync：brightness {"target": "bg"|"cast"|castId, "value": 0~1, "duration"?}；shake {"target": "ui"|"stage"|"all"|castId, "power": 0.2~10, "duration"?}（惊呼用 target: "ui"）；cameraShake "start"|"stop"（配 cameraShakeStrength 0.01~20）；flash true；talkWindow "default"|"center"；hideTalk true；thought/ignoreLipSync true。
- se / seDuration / seDelay / seStop：se 必须是站点声音清单里的 cue（清单为 (none) 时不要写 se/seStop）；duration 0.5~10，delay 0~10；seStop 与 se 互斥。
- motionFadeIn / motionWait：fade -1~2，wait 布尔；默认 ${OFFICIAL_TARGETS.motionFadeInDefault}/false，只在明确需要节奏时写。
示例（只演示字段位置，不要照抄数值；同一拍 Focus 与慢推/环绕并用时 focusDuration 为 0）：
{"say": "a", "text": "……嗯。", "focus": 5, "camera": "middle", "track": 0.2, "focusDuration": 0, "trackDuration": 0,
 "pedestal": -0.2, "pedestalDuration": 1.5,
 "pan": 12, "panDuration": 2.5, "panFocusSlide": 0.5, "dof": 0.4, "dofDuration": 1.5, "dofLayers": 2,
 "look": -0.4, "lookY": 0.1, "lookDuration": 0.5, ${exampleSe ? `"se": ${JSON.stringify(exampleSe)}, "seDuration": 2, "seDelay": 0.2, ` : ""}"motionFadeIn": ${OFFICIAL_TARGETS.motionFadeInDefault}, "motionWait": false}

## 台词与角色
- 每个角色要有自己的句长和语气：寡言角色 4~10 字、常带「……」、少分两行；活泼角色 16~24 字、可两行、感叹号多；稳重角色 12~18 字、少感叹号；嘴硬角色 12~18 字、短句反问；随性角色 4~8 字、答非所问。
- 长短句交替：约 ${pct(OFFICIAL_TARGETS.shortShare)}% 是 2~6 字的短反应（「…………」「……嗯。」「真的？」「诶？」）；约 ${pct(OFFICIAL_TARGETS.twoLineShare)}% 两行；不要所有台词都 10~15 字。
- 允许重复对方的话、停顿、欲言又止；不要每句都完整主谓宾。
- 台词是角色当下会说的话，不是旁白或主题总结。

## 按语义选动作
- 常用 nod / smile / check / question / thinking / denial / serious；surprised 一场最多 1~2 次，angry / kime 各最多 1 次；不要连续三句用强烈动作。
- 同一个温和动作可以重复（官方一场会重复 smile / nod / check 5~8 次），不要为了不重复而选怪动作。
- 听者优先用 lookAt 和表情承担反应，不必每句都给动作。
- 表情要与台词一致；默认 idle，不要每句都笑。exp_grinning01 带脸部阴影与遮眼黑化效果，严禁用于温暖、开心、友好对话或道别；exp_shadow* 仅用于低落阴郁，不可用于欢快或温暖收尾。

## 演出质量
- 先选一个具体的小事件，整场围绕它；结构是“小事件开场 → 2~3 句闲聊/跑题 → 一个很小的发现或请求 → 情绪转一次 → 收尾”，不要写成起承转合齐全的短篇小说。
- 镜头：二人同框 ↔ 说话者一侧，3~4 句一组；三人同台用 near 群像或单人特写（close，focus 该角色），不用 far 拍三人同框，也不写群像推近；换组才切。Focus 约 ${fixed(OFFICIAL_TARGETS.focusPerTextLine, 2)}/有文本行（官方 Talk 行口径 ${fixed(OFFICIAL_TARGETS.focusPerTalkRow, 3)}/句）：本场约 ${direction.focusChanges} 次 Focus 变化（含换组、推近、回到群像），不要只写 4 个 Focus 就停。
- 双人戏最多一次 near（全景）；情绪近景用 close，约占 ${pct1(OFFICIAL_TARGETS.distance4TextLineShare)}% 的有文本行（本场约 ${direction.closeUps} 次），每次 1~2 句（偶尔 3 句），随后用 middle（双人）/ near（三人）+ focus 5 回到二人或群像，不要停在同一个 close 上直到结尾。三人同台时 close 只拍单人特写。推近时保持同一侧 focus，只改 camera distance，不要换焦点。
- 动作预算：Motion 约 ${fixed(OFFICIAL_TARGETS.motionsPerTextLine, 2)}/句（本场约 ${direction.motionMin}~${direction.motionMax} 个）；约 ${pct(OFFICIAL_TARGETS.noMotionShare)}% 的句子没有 Motion；约 ${pct1(OFFICIAL_TARGETS.twoMotionShare)}% 的有文本行有 2 个以上表演动作 (Motion + Expression + Look + LookTarget)；不要给同一角色同一句叠 2 个动作。
- 表情跟动作走，默认 idle；不要连续三句笑，也不要给同一角色连续两句相反表情；独立表情默认 0（官方每集约 ${fixed(OFFICIAL_TARGETS.standaloneExpressionPerEpisode, 2)} 条），确有必要最多 1 次（只改表情的静镜头）。
- 情绪只转一次；结尾停在小动作、短句或没说完的话，不要总结主题。
- 与其多切一次镜头，不如让听者的表情和视线承担反应。
- 动作/表情必须服务台词；想不出合适的动作就省略，让镜头和表情承担演出。
- 不要用旁白代替画面；不要写“镜头缓缓推进”这类文字，镜头只能用字段表达。

## 可用舞台（scene 只能从这里选）
先选舞台，再写能在这个舞台里发生的事件；台词里的地点、时间、天气和道具必须和舞台描述一致。清单外的地点不要写；用户指定的地点不在清单里时，选最接近的一张并改写事件。舞台名里带具体学校/店铺（如水濑女子学园、RiNG、千石家）时，只有出场角色属于那里才选；否则选不带专名的通用地点。
${stageLines}

## 可用音乐（music 只能从这里选）
按括号里的情绪和冒号后的用途选；只在场景或情绪转折处换曲，整场最多两次；没有合适的就省略，不要为了有 BGM 而硬选。认真谈心、道歉、安慰、自我怀疑或伤感时，不要选轻巧、调侃、喜剧的曲子；轻松玩笑时也不要选安静、伤感的曲子。
${musicLines}

## 可用音效（se 只能从这里选；列表为 (none) 时不写 se/seStop）
只在台词里真的发生对应动作时使用（敲门、拿起手机、脚步、写字……），不要用 se 代替动作，也不要在同一句叠两个。
${soundLines}

## 可用画面遮罩（frame 只能从这里选；列表为 (none) 时不写 frame）
只在回忆、高潮遮幅、氛围或视觉冲击时按描述选用，用完记得关闭（frameStop: true）。
${frameLines}

## 可用后期滤镜（postEffect 只能从这里选；列表为 (none) 时不写 postEffect）
只在回忆闪回、心理冲击或明显氛围切换时按情绪选用，结束时用 postEffectStop: true 关闭。
${postEffectLines}

## 可用转场规则（scene / fade 的 fadeRule 或 transition）
${transitionLines}

## 可用角色与模型（model 必须从这里选）
每个角色只能选一个模型。同一支乐队同台时尽量统一到同一类服装（队服 / 校服 / 便服 / 虚拟舞台服 / 打工服；校服不同年级算同一类）：先选覆盖人数最多的一类，个别没有该类的角色可以例外，但避免一个人穿队服、另一个人穿初中校服这种强烈冲突。
${modelLines}

## 再次强调
只输出 JSON 对象本身。不要使用 json 代码围栏。不要解释。`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
};

// The single pipeline's pre-pass: narrow a large model pool to the characters this scene needs, so the story prompt
// carries 1~3 compact personas instead of every sheet. The staged pipeline does the same with its cast pass.
export const buildQuickCastMessages = ({ catalog, request, config, history = [] }) => {
  const maxOnStage = Math.max(2, Math.min(3, Math.round(Number(config.story?.maxOnStage ?? 3) || 3)));
  const charGroups = selectPromptCharacterGroups(catalog.models || [], { query: request.prompt || "", maxCap: MAX_PROMPT_MODELS });
  const rosterModels = [...charGroups.values()].map((list) => list[0]).filter(Boolean);
  const roster = rosterModels
    .map((m) => {
      const entry = personaEntryFor(config.story?.personas, m);
      const summary = entry?.summary || "";
      return `- ${m.id} — ${m.name}${m.character && m.character !== m.name ? ` (${m.character})` : ""}${summary ? `：${summary}` : ""}`;
    })
    .join("\n") || "(none)";
  const recent = history.slice(-4).map((h) => `${h.role}: ${h.content}`).join("\n");
  return [
    {
      role: "system",
      content:
        "你是角色选择器。根据用户消息从角色池选出最适合出演这场戏的角色：通常 1~2 个，" +
        `用户明确描述多人互动时最多 ${maxOnStage} 个。只输出 JSON：{"cast":["模型 id",...]}。`,
    },
    {
      role: "user",
      content: `用户说：${request.prompt || "写一段安静的日常对话。"}\n` +
        `${recent ? `最近对话：\n${recent}\n\n` : ""}可选角色：\n${roster}\n\n只输出 JSON。`,
    },
  ];
};
