# Data format

The renderer ships no game data. A product site (made by
[nnnotes](https://github.com/MetaSekaiLab/nnnotes) from files the user supplies) contains immutable products; a
published story site contains the story manifests and files described in
[story data](story-data-format.md). This page describes the product layout and the model product that the renderer
reads. It is a subset of the former player documentation: chart, live and UI-pack data are no longer part of this
repository.

## Products

A product is a manifest named `nnnotes.product/1`:

```json
{
  "schema": "nnnotes.product/1",
  "product": "story",
  "subject": "10002",
  "root": "../",
  "files": { "story.json": { "asset": "assets/<sha256>.json", "size": 1234 } },
  "objects": {}
}
```

| Field | Meaning |
| --- | --- |
| `schema` | Always `nnnotes.product/1`. |
| `product` | The product kind: `story`, `story.scene`, `story.ui`, `story.fonts`, `story.asset`, `story.sound`, `story.video`, `story.host`, `live2d.model`, … |
| `subject` | The identity the consumer expects: a story id, `default`, a language, `10002/ja`, or a model key. |
| `root` | Optional. The directory asset paths are relative to (default: the manifest's directory). |
| `files` | Logical file name → file entry. |
| `objects` | Object id → `{class, name, files}` for Unity object tables. |

A story product's `files` names `story.json` and `episode.json`. The story index
([story data](story-data-format.md)) names the other products by their manifest paths.

### File entries

A file entry stores a file by content:

```json
{ "asset": "assets/<sha256>.<ext>", "size": 1234 }
```

- `asset` is relative to the manifest's `root` (or its directory).
- `size` is the decoded length in bytes.
- `stored` is present when the asset is compressed on disk (`.gz` or `.br`) and is the stored length.
- A split JSON file may instead be `{ "parts": [["key", "assets/<sha>.json", size, stored], …], "size": … }`; the parts
  are merged into one object by key (a Live2D prefab is split this way).

Consumers verify the SHA-256 in the name, the decoded size and, when present, the stored size. Encoded assets are
served with `Content-Encoding: gzip` or `br`.

### Objects

`objects` maps an object id to its serialized Unity object:

```json
"objects": {
  "<object id>": {
    "class": "GameObject",
    "name": "adv_live2d_...",
    "files": { "json": { "asset": "assets/<sha>.json", "size": 123 } }
  }
}
```

Roles are `json`, `index`, `arrays`, `image`, `blob:_bytes`, and program files such as `program:vertex`. A product's
document (for example `model.json`) names these ids; the asset store resolves an id to its file.

## Live2D models

A story product's `parts.models` maps a model id to a model product manifest. `models.json` lists the site's models:

```json
{
  "format": 3,
  "models": [
    { "id": "adv_live2d_tomori_001_live_01", "key": "Character/Live2D/001_adv/adv_live2d_tomori_001_live_01/model/adv_live2d_tomori_001_live_01",
      "group": "001_adv", "manifest": "models/adv_live2d_tomori_001_live_01.json" }
  ]
}
```

### Model manifest

A model manifest is a `nnnotes.product/1` product of `live2d.model`. Its `subject` is the model key
(`Character/Live2D/<group>/<id>/model/<id>`), and its `files` contains `model.json`. The model's prefab, moc, shaders,
materials, textures, clips, fade motions and expressions are objects in the same manifest.

### model.json

`model.json` (format 3) names the object ids the runtime reads:

| Field | Meaning |
| --- | --- |
| `prefab` | The model's root GameObject (its `prefab.json`, with the `Live2DCharacter` component). |
| `moc` | The CubismMoc MonoBehaviour; its `blob:_bytes` file is the `.moc3`. |
| `shaders` | Unity shader name → Shader object. |
| `resources` | `cubismMask` / `cubismMaskCulling` Material objects. |
| `bindings` | AnimationClip object → `[{path, attribute}]` for each clip binding. |
| `motionSync` | Whether the root has a MotionSync controller with a CRI audio input. |
| `name`, `key`, `canvas`, `textures` | Model facts. |

The prefab's `Live2DCharacter` component holds `_motionList` (clips, each with a `clip` name), `_expressionList`,
`DefaultMotionName` and `DefaultExpressionName`. Those are the names a director script may use.

### Model shaders

A model's materials name Shader objects. A shader object's `json` holds its parsed form and variant index; each
program file has a top-level `#ifdef VERTEX` / `#ifdef FRAGMENT` block starting with `#version 300 es`. The story
renderer may add the `_ADDITIONAL_LIGHTS_VERTEX` keyword when the story scene uses its lighting quality.

## Story products

A story product is a `nnnotes.product/1` product of `story`:

- `files`: `story.json` and `episode.json`.
- `subject`: the story's `advId` as a string.
- The story's `parts` name the scene, UI, fonts, assets, models, sounds, videos and host products.

The story data page describes the documents and their cross-references:
[Story data format](story-data-format.md).

## Site entry products

A story listing (`stories.json`, format `ournotes.stories/1`) maps a story entry to its manifest path, language list and
title. An entry may be a `nnnotes.product/1` story manifest (the AI queue's input) or an
`ournotes.story-manifest/2` episode (the site-format path rendered by `host/tools/render-story.mjs`).

## Validation

The renderer validates what it loads: product manifests and their file entries, model manifests and `model.json`,
story parts and their languages. The authoring tools add the script-level checks:

```sh
node scripts/story-author.mjs check story.json --site path/to/site
node host/tools/site-story.mjs --site path/to/site --base stories/10610.json --script story.json --adv 90001
```

`docs/story-director.md` describes the director fields these checks cover.
