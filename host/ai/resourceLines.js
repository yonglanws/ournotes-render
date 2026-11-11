// One-line prompt entries for the resource lists. A site-format story only carries opaque asset ids, so the semantic
// fields come from the resource guide (host/story/site-resources.yaml); a site without a guide still gets the caption
// or label the story carried, so the format degrades to the previous behaviour instead of showing empty bullets.

const facets = (value) => (Array.isArray(value) ? value.filter(Boolean).join("，") : "");

export const stageLine = (stage) => {
  const name = stage.name || stage.caption || "";
  const tags = facets(stage.tags);
  const head = `- ${stage.id}${name ? ` — ${name}` : ""}${tags ? `（${tags}）` : ""}`;
  return `${head}${stage.description ? `：${stage.description}` : ""}`;
};

export const musicLine = (music) => {
  const name = music.name || music.label || "";
  const mood = music.mood ? `（${music.mood}）` : "";
  return `- ${music.cue}${name ? ` — ${name}` : ""}${mood}${music.use ? `：${music.use}` : ""}`;
};

export const soundLine = (sound) => {
  const name = sound.name || sound.label || "";
  return `- ${sound.cue}${name ? ` — ${name}` : ""}${sound.use ? `：${sound.use}` : ""}`;
};
