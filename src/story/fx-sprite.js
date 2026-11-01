import { F } from "../engine/core.js";
import { mat4 } from "../engine/math.js";

// The SpriteRenderer of an effect prefab, for the story Effect feature. It is the chart player's renderer with the
// same Unity behaviour: mesh in the renderer's local space (units), vertex colour = m_Color, material = m_Materials[0]
// with the sprite's texture as _MainTex, sliced / tiled 9-slice geometry, flips, sorting order.
export class FxEffectsError extends Error {}

// UnityEngine.SpriteRenderer of the effect prefabs: mesh in the renderer's local space (units), vertex colour =
// m_Color, material = m_Materials[0] with the sprite's texture as _MainTex. A program with the per-draw sprite
// constants (URP 2D Sprite-Unlit-Default: unity_SpriteColor, unity_SpriteProps) takes the colour and the flip there,
// over white vertices at their unflipped positions.
//   drawMode 0 (Simple): the sprite's own mesh (its render mesh vertices / uv / indices, units relative to the pivot).
//   drawMode 1 (Sliced): a 9-slice of m_Size: outer rectangle (-pivot * size .. (1 - pivot) * size), borders
//   (m_Sprite.border px / pixelsToUnits: x left, y bottom, z right, w top); UVs of the sprite rect in its texture.
//   drawMode 2 (Tiled) is not used by any effect prefab and raises.
// ENGINE: SpriteRenderer mesh generation is native; the documented behaviour below is implemented.
// Pivot kept at the same normalized point of m_Size; borders shrink proportionally when they do not fit (left + right >
// width); the UVs of a sliced sprite are taken from the sprite rect (every effect sprite is unpacked, settingsRaw bit 0
// = 0, so the rect is the texture region).
// ENGINE: vertex colour is Color32 (Unity's sprite vertex format), round(clamp01(c) * 255), as for particles.
// Colour space Gamma (player.colorSpace), so no linear conversion.
// ENGINE: flipX / flipY negate the local x / y of the vertices (the shader culls nothing: Cull Off).
// ENGINE: a program with the per-draw sprite constants gets white, unflipped vertices; colour and flip come per draw.
export class FxSpriteRenderer {
  // comp: the SpriteRenderer's fields; its sprite and material through `materials` (FxMaterials)
  constructor(comp, transform, { materials = null, name = "" } = {}) {
    const sp = materials ? materials.sprite(comp.m_Sprite) : comp.m_Sprite && { ...comp.m_Sprite, name: comp.m_Sprite.sprite };
    if (!sp) throw new FxEffectsError(`${name}: SpriteRenderer without sprite`);
    if (comp.m_DrawMode !== 0 && comp.m_DrawMode !== 1)
      throw new FxEffectsError(`${name}: SpriteRenderer drawMode ${comp.m_DrawMode} not implemented`);
    if (comp.m_MaskInteraction) throw new FxEffectsError(`${name}: SpriteRenderer mask interaction ${comp.m_MaskInteraction}`);
    if (!comp.m_Materials || comp.m_Materials.length !== 1 || !comp.m_Materials[0])
      throw new FxEffectsError(`${name}: SpriteRenderer needs exactly one material`);
    this.name = name;
    this.transform = transform;
    this.enabled = !!comp.m_Enabled;
    this.drawMode = comp.m_DrawMode;
    this.sprite = {
      name: sp.name, texture: sp.texture, rect: { ...sp.rect }, border: { ...sp.border }, pivot: { ...sp.pivot },
      ppu: F(sp.pixelsToUnits), vertices: sp.vertices, uv: sp.uv, indices: sp.indices, packed: (sp.settingsRaw & 1) === 1,
    };
    if (this.drawMode === 1 && this.sprite.packed) throw new FxEffectsError(`${name}: sliced packed sprite not implemented`);
    this.color = [F(comp.m_Color.r), F(comp.m_Color.g), F(comp.m_Color.b), F(comp.m_Color.a)];
    this.size = { x: F(comp.m_Size.x), y: F(comp.m_Size.y) };
    this.flipX = !!comp.m_FlipX;
    this.flipY = !!comp.m_FlipY;
    this.sortingLayer = comp.m_SortingLayer | 0;
    this.sortingOrder = comp.m_SortingOrder | 0;
    this.materialRecord = comp.m_Materials[0];
    this.materials = materials;
    this.material = materials ? materials.get(this.materialRecord) : null;
    this.texture = null;                      // GL texture of the sprite (_MainTex), set by load()
    this._texPromise = null;
    this._geo = null;                         // cached local geometry (positions + uvs), rebuilt on size change
    if (materials && materials.gl) this.load().catch((err) => console.error(`FxSpriteRenderer ${name}: ${err.message}`));
  }

  // sprite texture through the materials' texture cache (GL only)
  load() {
    if (!this.materials || !this.materials.gl) return Promise.resolve();
    if (!this._texPromise) this._texPromise = Promise.resolve(this.materials.texture(this.sprite.texture)).then((t) => { this.texture = t; });
    return this._texPromise;
  }

  // Animator bindings of class SpriteRenderer: m_Color.r|g|b|a, m_Size.x|y
  accessor(attr) {
    const color = attr.match(/^m_Color\.([rgba])$/);
    if (color) {
      const i = "rgba".indexOf(color[1]);
      return { get: () => this.color[i], set: (v) => { this.color[i] = F(v); } };
    }
    const size = attr.match(/^m_Size\.([xy])$/);
    if (!size) return null;
    const c = size[1];
    return { get: () => this.size[c], set: (v) => { v = F(v); if (this.size[c] !== v) { this.size[c] = v; this._geo = null; } } };
  }

  setSizeX(v) { v = F(v); if (this.size.x !== v) { this.size.x = v; this._geo = null; } }

  // local geometry: {pos: [[x, y, 0]], uv: [[u, v]], idx: [...]} (no colour)
  geometry() {
    if (this._geo) return this._geo;
    const s = this.sprite;
    let g;
    if (this.drawMode === 0) {
      g = { pos: s.vertices.map((v) => [F(v[0]), F(v[1]), F(v[2] || 0)]), uv: s.uv.map((u) => [F(u[0]), F(u[1])]), idx: s.indices.slice() };
    } else {
      const W = this.size.x, H = this.size.y, ppu = s.ppu;
      const tw = s.texture.width, th = s.texture.height;
      let L = F(s.border.x / ppu), R = F(s.border.z / ppu), B = F(s.border.y / ppu), T = F(s.border.w / ppu);
      if (L + R > W && L + R > 0) { const k = W / (L + R); L = F(L * k); R = F(R * k); }       // border shrink
      if (B + T > H && B + T > 0) { const k = H / (B + T); B = F(B * k); T = F(T * k); }
      const x0 = F(-s.pivot.x * W), x3 = F(x0 + W), y0 = F(-s.pivot.y * H), y3 = F(y0 + H);
      const xs = [x0, F(x0 + L), F(x3 - R), x3], ys = [y0, F(y0 + B), F(y3 - T), y3];
      const r = s.rect;
      const us = [r.x, r.x + s.border.x, r.x + r.width - s.border.z, r.x + r.width].map((p) => F(p / tw));
      const vs = [r.y, r.y + s.border.y, r.y + r.height - s.border.w, r.y + r.height].map((p) => F(p / th));
      const pos = [], uv = [], idx = [];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        if (!(xs[i + 1] > xs[i]) || !(ys[j + 1] > ys[j])) continue;       // empty cell (zero border / zero size)
        const b = pos.length;
        for (const [a, c] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) { pos.push([xs[a], ys[c], 0]); uv.push([us[a], vs[c]]); }
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
      g = { pos, uv, idx };
    }
    if (this.flipX || this.flipY) g.pos = g.pos.map(([x, y, z]) => [this.flipX ? -x : x, this.flipY ? -y : y, z]);
    this._geo = g;
    return g;
  }

  // vertex buffer for FxMaterial.draw: POSITION float3, COLOR float4 (Color32 values), TEXCOORD0 float2. color /
  // flip false: white vertices / the positions without the renderer's flip (the program applies them per draw).
  mesh({ color = true, flip = true } = {}) {
    const g = this.geometry(), n = g.pos.length, stride = 9, verts = new Float32Array(n * stride);
    const c32 = (x) => Math.round(Math.min(Math.max(x, 0), 1) * 255) / 255;
    const col = color ? this.color.map(c32) : [1, 1, 1, 1];
    const fx = !flip && this.flipX ? -1 : 1, fy = !flip && this.flipY ? -1 : 1;     // geometry() holds the flip
    for (let k = 0; k < n; k++) {
      const o = k * stride;
      verts[o] = fx * g.pos[k][0]; verts[o + 1] = fy * g.pos[k][1]; verts[o + 2] = g.pos[k][2];
      verts[o + 3] = col[0]; verts[o + 4] = col[1]; verts[o + 5] = col[2]; verts[o + 6] = col[3];
      verts[o + 7] = g.uv[k][0]; verts[o + 8] = g.uv[k][1];
    }
    return { verts, stride, attribs: { in_POSITION0: [3, 0], in_COLOR0: [4, 3], in_TEXCOORD0: [2, 7] },
             idx: n > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx) };
  }

  // world-space AABB centre of the mesh (sorting distance)
  worldCenter(M = this.transform.localToWorld()) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of this.geometry().pos) {
      const w = mat4.transformPoint(M, { x: p[0], y: p[1], z: p[2] });
      const a = [w.x, w.y, w.z];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k]); hi[k] = Math.max(hi[k], a[k]); }
    }
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  }

  // Submission item for renderer.submit or null. camPos: [x, y, z] of the camera (Euclidean distance to the bounds centre,
  // as the particle items compute it) or null.
  drawItem(camPos = null) {
    if (!this.enabled || !this.geometry().idx.length) return null;
    const M = this.transform.localToWorld();
    const c = this.worldCenter(M);
    const distance = camPos ? Math.hypot(c[0] - camPos[0], c[1] - camPos[1], c[2] - camPos[2]) : 0;
    const queue = this.material ? this.material.queue
      : (this.materialRecord.renderQueue >= 0 ? this.materialRecord.renderQueue : null);
    return { sortingLayer: this.sortingLayer, sortingOrder: this.sortingOrder, queue, distance, name: this.name, sprite: this,
             draw: (ctx) => this.draw(ctx, M) };
  }

  // Unity binds the sprite texture as _MainTex through a MaterialPropertyBlock (the material's _MainTex_ST stays).
  // The colour and the flip go where the material's program reads them (header).
  draw(ctx, M = this.transform.localToWorld()) {
    if (!this.material) return;
    if (!this.texture) {
      if (!this._warned) { this._warned = true; console.warn(`FxSpriteRenderer ${this.name}: sprite texture not loaded`); }
      return;
    }
    const t = this.texture, prog = this.material.ready ? this.material.program : null;
    const color = !!prog && prog.reads("unity_SpriteColor"), flip = !!prog && prog.reads("unity_SpriteProps");
    const sheet = { _MainTex: t, _MainTex_TexelSize: [1 / t.width, 1 / t.height, t.width, t.height] };
    if (color) sheet.unity_SpriteColor = this.color.slice();
    if (flip) sheet.unity_SpriteProps = [this.flipX ? -1 : 1, this.flipY ? -1 : 1, 0, 0];
    this.material.draw(ctx, this.mesh({ color: !color, flip: !flip }), M, sheet);
  }
}
