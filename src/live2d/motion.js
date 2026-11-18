import { F } from "../engine/core.js";
import { clampF, easeSine, hermite } from "./math.js";

// Mutually-exclusive arm-layer and hand-pose visibility parameters must snap discretely on motion transitions
// instead of cross-fading through 50%/50% semi-transparent double-arm states.
export const DISCRETE_LAYER_PARAM_RE =
  /^(?:paramArm[LR]_layer(?:_?\d+)?|hand_[LR]_?\d+|paramArm[LR]Line|ParamRarmGJ|ParamStallON[LR]|ParamJaket[LR]B\d*)$/i;

export const isDiscreteLayerParam = (id) => DISCRETE_LAYER_PARAM_RE.test(String(id || ""));

export const collectDiscreteLayerParams = (params) => {
  const out = new Set();
  const ids = params?.ids || [];
  for (let i = 0; i < ids.length; i++) {
    if (isDiscreteLayerParam(ids[i])) out.add(i);
  }
  return out;
};

// Shared CubismFadeController.OnLateUpdate (order 100) blend with discrete layer-switch snapping.
export const fadeCharacterMotion = (ch, discreteParams = ch.discreteLayerParams) => {
  const t = ch.loop.time, L = ch.layer.list;
  if (!L.length) return;
  const last = L[L.length - 1];
  const e = (x) => F(F(t - x.fadeInStartTime) * x.speed);
  const el = e(last);
  let fading = false;
  if (L.length > 1) {
    const M = last.motion;
    for (let j = 0; j < M.pfit.length && !fading; j++)
      fading = el <= last.fadeInTime || (M.pfit[j] >= 0 && el <= M.pfit[j]);
  }
  if (!fading) {
    for (let j = L.length - 2; j >= 0; j--) if (L[j].endTime < t) L.splice(j, 1);
    return;
  }
  ch.store.restore();
  const P = ch.params;
  const discrete = discreteParams || collectDiscreteLayerParams(P);
  for (const pm of L) {
    const M = pm.motion;
    const ep = e(pm);
    const fi = pm.fadeInTime > 0 ? easeSine(F(ep / pm.fadeInTime)) : 1;
    const fo = (M.fadeOutTime > 0 && pm.endTime >= 0) ? easeSine(F(F(pm.endTime - t) / M.fadeOutTime)) : 1;
    const w = F(1 * F(fi * fo));
    const endArg = F(pm.endTime - ep);
    for (const [i, c] of M.curveOf) {
      if (discrete.has(i)) {
        if (pm === last) {
          const v = clampF(hermite(c.keys, ep), P.min[i], P.max[i]);
          P.override(i, v, 1);
        } else if (!last.motion.curveOf.has(i)) {
          // A fading-out motion must not leave an extra hand/arm layer active if the incoming motion omits that curve.
          P.override(i, P.def[i], 1);
        }
        continue;
      }
      const v = clampF(hermite(c.keys, ep), P.min[i], P.max[i]);
      const pfit = M.pfit[c.k], pfot = M.pfot[c.k];
      let wp = w;
      if (!(pfit < 0 && pfot < 0)) {
        const wi = pfit >= 0 ? (pfit >= 1.4e-45 ? easeSine(F(ep / pfit)) : 1) : fi;
        const wo = pfot >= 0 ? ((endArg >= 0 && pfot >= 1.4e-45) ? easeSine(F(endArg / pfot)) : 1) : fo;
        wp = F(wi * wo);
      }
      P.override(i, F(F(F(v - P.value[i]) * wp) + P.value[i]), 1);
    }
  }
};

// Motion data of a model: the Mecanim clips of Live2DCharacter._motionList (what the Animator writes) and the
// CubismFadeMotionData of CubismFadeController (what the fade blends with).

// Model curves (the Cubism importer's EyeBlink and LipSync targets) animate fields of the root's controllers.
const FIELDS = { "CubismEyeBlinkController.EyeOpening": "eyeOpening", "CubismMouthController.MouthOpening": "mouthOpening",
                 "CubismRenderController.Opacity": "renderOpacity" };

const sample = (s, t) => {
  let lo = 0, hi = s.t.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s.t[m] <= t) lo = m; else hi = m - 1; }
  const x = F(t - s.t[lo]), k = lo * 4;
  return F(F(F(F(F(F(s.k[k] * x) + s.k[k + 1]) * x) + s.k[k + 2]) * x) + s.k[k + 3]);
};

// The class a clip binding (clip.json) animates: a MonoBehaviour's script class (the last part of `scriptClass`),
// else the class of its type id (null when unknown).
const bindingClass = (b) => (b.typeID === 114 ? (b.scriptClass ? b.scriptClass.slice(b.scriptClass.lastIndexOf("|") + 1) : null)
  : b.class ?? null);

// One AnimationClip as the Animator samples it into raw CubismParameter.Value (no clamp) and the model curves'
// controller fields: the streamed cubic keys and the constant curves of the clip (clip.json). `names`: per binding of
// the clip, the path and the attribute it animates in the model's hierarchy (model.json bindings).
// ENGINE: Mecanim samples streamed clips natively; this is the cubic form of the stored keys, float32 in source order.
export class Live2DClip {
  constructor(clip, names, params) {
    this.name = clip.name;
    this.length = clip.stopTime;
    this.loopTime = clip.loopTime;
    if (clip.dense.curveCount) throw new Error(`${this.name}: dense clip curves not implemented`);
    if (clip.startTime !== 0 || clip.cycleOffset !== 0) throw new Error(`${this.name}: clip start / cycle offset not implemented`);
    const nS = clip.streamed.curveCount;
    // every binding animates one float curve: the streamed ones, then the constant ones
    if (!names || names.length !== clip.bindings.length) throw new Error(`${this.name}: no names for its bindings`);
    if (clip.bindings.length !== nS + clip.constant.length || clip.bindings.some((b) => b.pptr || (b.curves ?? 1) !== 1))
      throw new Error(`${this.name}: bindings other than one float curve each not implemented`);
    const ev = clip.events.filter((e) => e.functionName === "InstanceId");
    this.instanceId = ev.length ? ev[ev.length - 1].intParameter : -1;
    // A binding whose path is not in the model's hierarchy (path null) animates nothing.
    // ENGINE: the Animator leaves a binding without a transform at its path unbound.
    const target = (i) => {
      const { path, attribute } = names[i], cls = bindingClass(clip.bindings[i]);
      if (path === null) return -1;
      if (path === "" && FIELDS[`${cls}.${attribute}`]) return FIELDS[`${cls}.${attribute}`];
      if (cls !== "CubismParameter" || attribute !== "Value" || !path.startsWith("Parameters/"))
        throw new Error(`${this.name}: binding of ${cls} ${JSON.stringify(path)} ${attribute} not implemented`);
      return params.idx(path.slice("Parameters/".length));
    };
    this.streamed = [];
    for (let c = 0; c < nS; c++) this.streamed.push({ param: target(c), t: [], k: [] });
    for (const [time, keys] of clip.streamed.frames)
      for (const [c, c0, c1, c2, c3] of keys) {
        const s = this.streamed[c];
        s.t.push(time); s.k.push(F(c0), F(c1), F(c2), F(c3));
      }
    const constants = clip.constant.map((v, j) => ({ param: target(nS + j), v: F(v) }));
    const field = (c) => typeof c.param === "string";
    this.fieldCurves = this.streamed.filter(field);
    this.fieldConstants = constants.filter(field);
    this.streamed = this.streamed.filter((s) => !field(s) && s.param >= 0);
    this.constants = constants.filter((c) => !field(c) && c.param >= 0);
  }

  // A clip with m_LoopTime set is sampled wrapped around its length, one without it clamped to it. A character's clip
  // playable stops at length - 0.0001 (character.js animatorUpdate), so a motion does not wrap there.
  // ENGINE: Mecanim's sampling of a clip past its length (m_LoopTime) is native; wrapped or clamped here.
  localTime(t) { return (this.loopTime && t > this.length) ? t % this.length : Math.min(t, this.length); }

  // values: the parameter values; fields: the object whose eyeOpening / mouthOpening / renderOpacity the model curves set
  write(clipTime, values, fields = null) {
    const t = F(this.localTime(clipTime));
    for (const s of this.streamed) values[s.param] = sample(s, t);
    for (const c of this.constants) values[c.param] = c.v;
    if (!fields) return;
    for (const s of this.fieldCurves) fields[s.param] = sample(s, t);
    for (const c of this.fieldConstants) fields[c.param] = c.v;
  }
}

// CubismFadeMotionData with its curves resolved to parameter indices (ids the model lacks are skipped, as the
// dictionary lookup of CubismFadeController misses them).
export class Live2DFadeMotion {
  constructor(m, params) {
    this.name = m.MotionName;
    this.objectName = m.m_Name ?? m.name ?? null;          // UnityEngine.Object.name ("<motion>.fade")
    this.fadeInTime = m.FadeInTime; this.fadeOutTime = m.FadeOutTime;
    this.length = m.MotionLength;
    this.parameterIds = m.ParameterIds;
    this.pfit = m.ParameterFadeInTimes; this.pfot = m.ParameterFadeOutTimes;
    this.curveOf = new Map();
    m.ParameterIds.forEach((id, k) => {
      if (!params.index.has(id)) return;
      const keys = m.ParameterCurves[k].m_Curve;
      if (!keys.length) throw new Error(`${this.name}: empty curve ${id}`);
      this.curveOf.set(params.idx(id), { k, keys });
    });
  }
}
