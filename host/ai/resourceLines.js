// One-line prompt entries for the resource lists. A site-format story only carries opaque asset ids, so the semantic
// fields come from the resource guide (host/story/site-resources.yaml and built-in official FX metadata); a site
// without a guide falls back to clean labels so unknown ids never show empty bullets.
import { applyFrameGuide, applyPostEffectGuide, applySoundGuide, applyTransitionGuide } from "../story/resourceGuide.js";

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
  const item = typeof sound === "string" ? applySoundGuide(sound) : sound;
  const name = item.name || item.label || "";
  return `- ${item.cue}${name ? ` — ${name}` : ""}${item.use ? `：${item.use}` : ""}`;
};

export const frameLine = (frame) => {
  const item = typeof frame === "string" || !frame?.name ? applyFrameGuide(frame) : frame;
  const tags = facets(item.tags);
  const actions = Array.isArray(item.actions) && item.actions.length ? ` [frameAction: ${item.actions.join("/")}]` : "";
  const head = `- ${item.id}${item.name ? ` — ${item.name}` : ""}${tags ? `（${tags}）` : ""}`;
  return `${head}${item.use ? `：${item.use}` : ""}${actions}`;
};

export const postEffectLine = (postEffect) => {
  const item = typeof postEffect === "string" || !postEffect?.name ? applyPostEffectGuide(postEffect) : postEffect;
  const mood = item.mood ? `（${item.mood}）` : "";
  return `- ${item.id}${item.name ? ` — ${item.name}` : ""}${mood}${item.use ? `：${item.use}` : ""}`;
};

export const transitionLine = (transition) => {
  const item = typeof transition === "string" || !transition?.name ? applyTransitionGuide(transition) : transition;
  return `- ${item.id}${item.name ? ` — ${item.name}` : ""}${item.use ? `：${item.use}` : ""}`;
};
