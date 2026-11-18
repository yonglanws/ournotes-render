// Cached reader and binary helpers for the prebuilt BanG Dream! Our Notes cloud semantic catalog
// (`host/story/cloud-catalog.json`). Used by site-story pooling and on-demand cloud materialization.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLOUD_CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cloud-catalog.json");

let cachedCatalog = null;

export const loadCloudCatalog = () => {
  if (cachedCatalog) return cachedCatalog;
  if (!fs.existsSync(CLOUD_CATALOG_PATH)) {
    cachedCatalog = {
      format: "",
      characters: {},
      characterBands: {},
      costumeLabels: {},
      models: { tw: [], jp: [] },
      stages: [],
      music: [],
      sounds: [],
      donors: {},
      stageMap: new Map(),
      musicMap: new Map(),
      soundMap: new Map(),
      modelMap: new Map(),
    };
    return cachedCatalog;
  }
  const doc = JSON.parse(fs.readFileSync(CLOUD_CATALOG_PATH, "utf8"));
  const stageMap = new Map((doc.stages || []).map((s) => [s.id, s]));
  const musicMap = new Map((doc.music || []).map((m) => [m.cue, m]));
  const soundMap = new Map((doc.sounds || []).map((s) => [s.cue, s]));
  // Index models preferring TW manifest when an ID exists in both TW and JP.
  const modelMap = new Map();
  for (const m of doc.models?.jp || []) modelMap.set(m.id, m);
  for (const m of doc.models?.tw || []) modelMap.set(m.id, m);
  cachedCatalog = { ...doc, stageMap, musicMap, soundMap, modelMap };
  return cachedCatalog;
};

// Extracts exact pixel dimensions from RIFF WEBP headers (VP8X, VP8L, or lossy VP8).
export const webpDimensions = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return { width: 2048, height: 1119 };
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return { width: 2048, height: 1119 };
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buf.length >= 30) {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return { width: 2048, height: 1119 };
};

// Synthesizes a valid AdvStage prefab matching ournotes-player-site's GLTex & AdvStageData contract
// when an unused cloud stage `.webp` has no donor story manifest.
export const synthesizeStagePrefab = (stageId, width, height, textureRel) => {
  const w = Math.max(1, Number(width) || 2048);
  const h = Math.max(1, Number(height) || 1119);
  const ppu = h / 26.5;
  const halfW = w / (2 * ppu);
  const halfH = 13.25;
  const lightPath = `${stageId}/Lights/Group0/DirectionalLight`;
  return {
    key: `Adv/Stage/${stageId}/${stageId}`,
    nodes: [
      {
        path: stageId,
        name: stageId,
        active: true,
        layer: 11,
        tag: 0,
        localPosition: { x: 0, y: 0, z: 0 },
        localRotation: { x: 0, y: 0, z: 0, w: 1 },
        localScale: { x: 1, y: 1, z: 1 },
        components: [
          {
            type: "MonoBehaviour",
            class: "AdvStage",
            m_Enabled: 1,
            m_Name: "",
            _backgroundSprite: {
              sprite: stageId,
              texture: {
                texture: textureRel,
                name: stageId,
                width: w,
                height: h,
                format: 50,
                mipCount: 1,
                colorSpace: 1,
                settings: { m_FilterMode: 1, m_Aniso: 1, m_MipBias: 0, m_WrapU: 1, m_WrapV: 1, m_WrapW: 1 },
              },
              rect: { x: 0, y: 0, width: w, height: h },
              pivot: { x: 0.5, y: 0.5 },
              border: { x: 0, y: 0, z: 0, w: 0 },
              pixelsToUnits: ppu,
              offset: { x: 0, y: 0 },
              textureRect: { x: 0, y: 0, width: w, height: h },
              textureRectOffset: { x: 0, y: 0 },
              settingsRaw: 64,
              uvTransform: { x: ppu, y: w / 2, z: ppu, w: h / 2 },
              vertices: [[-halfW, halfH, 0], [halfW, -halfH, 0], [halfW, halfH, 0], [-halfW, -halfH, 0]],
              uv: [[0, 1], [1, 0], [1, 1], [0, 0]],
              indices: [3, 0, 1, 2, 1, 0],
            },
            _backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
            _characterFieldScale: 4,
            _backgroundFieldScale: 1,
            _characterFieldPosition: { x: 0, y: -0.45, z: 5.5 },
            _backgroundFieldPosition: { x: 0, y: 0, z: 16 },
            _shadowTexture: null,
            _shadowTextureUv: { x: 1, y: 1, z: 0, w: 0 },
            _shadowTextureIntensity: 0.3,
            _shadowTextureAmplitude: { x: 0.002, y: 0.002 },
            _shadowTextureFrequency: 0.5,
            _fov: 39.6,
            _initialCameraPosition: { x: 0, y: 0, z: 0 },
            _initialCameraRotation: { x: 0, y: 0, z: 0 },
            _usingFocusDataSettingsKey: "Settings-Default",
            _focusPointsCollection: { _entries: [] },
            _lightGroupCollection: {
              _groups: [{ _lights: [{ component: "MonoBehaviour", gameObject: lightPath, class: "AdvLight" }] }],
            },
            _particleEffectGroupCollection: { _groups: [] },
            _allVolumeProfileCollection: { _profiles: [] },
          },
        ],
      },
      {
        path: `${stageId}/Lights`,
        name: "Lights",
        active: true,
        layer: 11,
        tag: 0,
        localPosition: { x: 0, y: 0, z: 0 },
        localRotation: { x: 0, y: 0, z: 0, w: 1 },
        localScale: { x: 1, y: 1, z: 1 },
        components: [],
      },
      {
        path: `${stageId}/Lights/Group0`,
        name: "Group0",
        active: true,
        layer: 11,
        tag: 0,
        localPosition: { x: 0, y: 0, z: 0 },
        localRotation: { x: 0, y: 0, z: 0, w: 1 },
        localScale: { x: 1, y: 1, z: 1 },
        components: [],
      },
      {
        path: lightPath,
        name: "DirectionalLight",
        active: true,
        layer: 11,
        tag: 0,
        localPosition: { x: 0, y: 0, z: 0 },
        localRotation: { x: 0, y: 0, z: 0, w: 1 },
        localScale: { x: 1, y: 1, z: 1 },
        components: [
          { type: "Light", m_Enabled: 1, m_Type: 1, m_Color: { r: 1, g: 1, b: 1, a: 1 }, m_Intensity: 0.9 },
          { type: "MonoBehaviour", class: "UniversalAdditionalLightData", m_Enabled: 1, m_Name: "" },
          { type: "MonoBehaviour", class: "AdvLight", m_Enabled: 1, m_Name: "" },
        ],
      },
    ],
  };
};

// Reads MP4 `mdhd`/`mvhd` boxes to estimate exact sampleRate & samples for direct .m4a cues.
export const probeM4aCue = (buf, cue, isBgm = false) => {
  let sampleRate = 48000;
  let samples = isBgm ? 48000 * 60 : 48000 * 2;
  if (Buffer.isBuffer(buf)) {
    const walk = (start, end) => {
      let off = start;
      while (off + 8 <= end) {
        let size = buf.readUInt32BE(off);
        const type = buf.toString("ascii", off + 4, off + 8);
        let hdr = 8;
        if (size === 1 && off + 16 <= end) {
          size = Number(buf.readBigUInt64BE(off + 8));
          hdr = 16;
        } else if (size === 0) {
          size = end - off;
        }
        if (size < hdr || off + size > end) break;
        if (type === "moov" || type === "trak" || type === "mdia") {
          walk(off + hdr, off + size);
        } else if (type === "mdhd" && off + hdr + 24 <= off + size) {
          const ver = buf[off + hdr];
          const ts = ver === 1 ? buf.readUInt32BE(off + hdr + 20) : buf.readUInt32BE(off + hdr + 12);
          const dur = ver === 1
            ? Number(buf.readBigUInt64BE(off + hdr + 24))
            : buf.readUInt32BE(off + hdr + 16);
          if (ts > 0 && dur > 0) {
            sampleRate = ts;
            samples = dur;
          }
        }
        off += size;
      }
    };
    walk(0, buf.length);
  }
  return {
    file: `${cue}.m4a`,
    sampleRate,
    samples,
    channels: 2,
    categories: [isBgm ? "Bgm" : "Se"],
  };
};
