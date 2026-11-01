// The page-side fixture UI and renderer patches for the e2e story render. It builds the real StoryUI from the synthetic
// UI document of the repo's UI tests, with a tiny textured UI shader, and replaces the scene renderer with a clear +
// UI draw so no game scene/post shaders are needed. Everything else (the story interpreter, Talk timing, audio events,
// letterbox and frame stepping) is the real StorySession.
import { AssetStore } from "/src/data/assets.js";
import { ShaderLib } from "/src/engine/glsl.js";
import { ObjectResources } from "/src/engine/objects.js";
import { StoryRenderer } from "/src/story/renderer.js";
import { StoryUI } from "/src/story/ui.js";
import { GLTex } from "/src/engine/texture.js";
import { uiResources } from "/tests/unit/story-ui-resources.mjs";
import { fontsDoc, uiDoc } from "./fixture-ui-data.js";

const UI_SHADER = `#ifdef VERTEX
#version 300 es
layout(location = 0) in vec3 in_POSITION0;
layout(location = 1) in vec4 in_COLOR0;
layout(location = 2) in vec4 in_TEXCOORD0;
layout(std140) uniform UnityPerDraw {
  vec4 hlslcc_mtx4x4unity_MatrixVP[4];
};
out vec4 vColor;
out vec2 vUV;
void main() {
  vColor = in_COLOR0;
  vUV = in_TEXCOORD0.xy;
  vec4 p = vec4(in_POSITION0, 1.0);
  gl_Position = hlslcc_mtx4x4unity_MatrixVP[0] * p.x + hlslcc_mtx4x4unity_MatrixVP[1] * p.y
              + hlslcc_mtx4x4unity_MatrixVP[2] * p.z + hlslcc_mtx4x4unity_MatrixVP[3];
}
#endif
#ifdef FRAGMENT
#version 300 es
precision mediump float;
uniform sampler2D _MainTex;
in vec4 vColor;
in vec2 vUV;
out vec4 fragColor;
void main() {
  vec4 t = texture(_MainTex, vUV);
  fragColor = vec4(vColor.rgb, vColor.a * t.a);
}
#endif`;

const value = (v) => ({ val: v });
const UI_STATE = {
  rtBlend0: { srcBlend: value(1), destBlend: value(10), srcBlendAlpha: value(1), destBlendAlpha: value(10),
              blendOp: value(0), blendOpAlpha: value(0), colMask: value(15) },
  zTest: value(8), zWrite: value(0), culling: value(0), offsetFactor: value(0), offsetUnits: value(0),
  stencilRef: value(0), stencilReadMask: value(255), stencilWriteMask: value(255), alphaToMask: value(0),
  stencilOp: { comp: value(8), pass: value(0), fail: value(0), zFail: value(0) },
  stencilOpFront: { comp: value(8), pass: value(0), fail: value(0), zFail: value(0) },
  stencilOpBack: { comp: value(8), pass: value(0), fail: value(0), zFail: value(0) },
};

const makeLib = (gl) => {
  const parsed = { properties: [], subShaders: [{ passes: [{ state: UI_STATE }] }] };
  const index = { name: "UI/Default", variants: [{ file: "x/gles3/s0p0_vertex_0.glsl", platform: "gles3", subShader: 0,
    pass: 0, stage: "vertex", type: "GLES3", keywords: [], role: "program:gles3/s0p0_vertex_0" }] };
  const store = new AssetStore({ objects: { "fixture:shader": { class: "Shader", name: "UI/Default", files: {
    json: JSON.stringify({ name: "UI/Default", ...parsed }),
    index: JSON.stringify(index),
    "program:gles3/s0p0_vertex_0": UI_SHADER,
  } } } });
  return ShaderLib.fromObjects(gl, { "UI/Default": "fixture:shader" }, store);
};

export const makeFixtureUI = (gl, loop) => {
  const doc = uiDoc();
  const fonts = fontsDoc();
  const resources = uiResources(doc, fonts, { code: "ja", mode: 0, lineSpacing: 5 });
  const base = resources.objects;
  const objects = {
    ...base,
    lib: makeLib(gl),
    // the synthetic sprites have no image data: a white texture is enough for the layout, tinted by vertex colours
    texture: async (id) => GLTex.solid(gl, [255, 255, 255, 255], `fixture-${id}`),
    material: (id) => ({ material: id || "Default UI Material", shader: { shader: "UI/Default" }, keywords: [],
                         floats: {}, colors: {}, textures: {} }),
  };
  const data = { ...resources.data, parts: { assets: {} } };
  return new StoryUI(gl, loop, resources.doc, { ...resources, data, objects });
};

// --- the minimal scene -----------------------------------------------------------------------------------------------
const fakeTransform = (name, parent = null) => ({
  name, parent, children: [],
  localPosition: { x: 0, y: 0, z: 0 }, localEuler: { x: 0, y: 0, z: 0 }, localScale: { x: 1, y: 1, z: 1 },
  setParent(p) { this.parent = p; if (p && !p.children.includes(this)) p.children.push(this); return this; },
  setLocalEuler(x, y, z) { this.localEuler = { x, y, z }; },
  worldPosition() { return { x: 0, y: 0, z: 0 }; },
  localToWorld() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
});

const fakePrefab = (id) => {
  const root = fakeTransform(String(id).split(":").pop() || "Root");
  const transforms = new Map([[root.name, root]]);
  const pathOf = (ref) => (typeof ref === "string" ? ref : (ref && (ref.gameObject || ref.path)) || root.name);
  const transform = (path) => {
    if (!transforms.has(path)) transforms.set(path, fakeTransform(String(path).split("/").pop(), root));
    return transforms.get(path);
  };
  const fields = (path, cls) => {
    if (cls === "CameraManager") return { _mainCamera: `${path}/MainCamera` };
    if (cls === "Camera") return { "near clip plane": 0.3, "far clip plane": 1000,
      m_BackGroundColor: { r: 0.06, g: 0.05, b: 0.10, a: 1 }, "field of view": 30, orthographic: false,
      "orthographic size": 5 };
    if (cls === "UniversalAdditionalCameraData") return { m_RendererIndex: -1 };
    if (cls === "AdvCharacterField") return { _field: `${path}/Field`,
      _characterStages: [0, 1, 2, 3, 4].map((i) => `${path}/Stage${i}`),
      _focusAnchors: [0, 1, 2, 3, 4].map((i) => `${path}/Anchor${i}`) };
    if (cls === "AdvBackgroundField") return { _field: `${path}/Field`, _renderer: `${path}/Sprite` };
    if (cls === "AdvGlobalVolume") return { _allVolume: `${path}/AllVolume`, _warmupObjects: `${path}/Warmup` };
    if (cls === "Volume") return { sharedProfile: null, weight: 1 };
    if (cls === "SpriteRenderer") return { m_Sprite: null };
    if (cls === "MeshRenderer") return {};
    if (cls === "MeshFilter") return { m_Mesh: "fixture-plane" };
    return {};
  };
  return { root, fields, pathOf, transform, transformOf: (ref) => transform(pathOf(ref)), find: (name) => transform(name),
           nodes: new Map() };
};

export const patchFixtureRendering = () => {
  ObjectResources.prototype.prefab = function (id) { return fakePrefab(id); };
  ObjectResources.prototype.grainTextures = () => [];
  StoryRenderer.prototype.load = async function () {
    this.tex = {}; this.sprites = new Map(); this.plane = null; this.grain = [];
  };
  StoryRenderer.prototype.render = function (vp, ui) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0.06, 0.05, 0.10, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    ui.render({ gl, width: vp.w, height: vp.h });
  };
  // the fixture page draws the 13:6 viewport only; the letterbox bands of the synthetic canvas would cover the
  // bottom of the talk window at a 16:9 output
  StoryUI.prototype.renderLetterBox = function () {};
};
