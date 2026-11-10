// The fixed, versioned evaluation scenes. The evaluator and the quality gate
// import this one list so a report cannot silently evaluate a different prompt
// set. Labels are the distinct base scene ids; --runs suffixes are only report
// file names.
export const EVAL_SCENES = Object.freeze([
  { label: "rain-stop", logline: "雨后便利店的屋檐下，两名乐队成员等雨停；一人想立刻走，一人想再多待一会儿。",
    title: "雨停之前" },
  { label: "lost-ticket", logline: "车站检票口，一人发现车票不见了；另一人嘴上说不管，还是蹲下来一起找。",
    title: "找不到的票" },
  { label: "last-rehearsal", logline: "练习室熄灯前，两人为一句和声反复磨合；一人先失去耐心，另一人坚持再来一次。",
    title: "最后一遍" },
  { label: "shared-snack", logline: "深夜厨房只剩最后一份点心，两人推来推去，谁也不肯先吃。",
    title: "最后一份" },
  { label: "one-umbrella", logline: "放学时突然下起大雨，只有一把伞；两人挤在伞下，谁都没提要走快一点。",
    title: "一把伞" },
  { label: "before-stage", logline: "演出开始前十分钟，一人在后台紧张得说不出话；另一人用很笨的方式让她开口。",
    title: "上场之前" },
  { label: "missing-earring", logline: "更衣室里，一人发现耳环少了一只；另一人一边安慰一边翻遍每个角落。",
    title: "少了一只" },
  { label: "last-train", logline: "末班车进站前，两人在站台聊起明天；广播响了，谁也没有先动。",
    title: "末班车" },
]);

export const EVAL_SCENE_LABELS = Object.freeze(EVAL_SCENES.map((scene) => scene.label));

export const sceneList = () => EVAL_SCENES.map((scene, index) => ({ ...scene, index: index + 1 }));
