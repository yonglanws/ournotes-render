# Changelog

All notable changes to this package. Versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0](https://github.com/empty-sekai/ournotes-player/compare/v0.2.0...v0.4.0) - 2026-11-01

### Configuration and TTS

- Add `astrbot_plugin_ournotes_script`: the `/剧本生成` AstrBot command (aliases `/写剧本`, `/storygen`) calls
  `POST /api/v1/script/generate`, sends a readable scene/dialogue/camera preview and attaches the complete
  `ournotes.story-script/1` JSON. Configuration covers the host URL, API key, language, base story, duration, line
  limit, timeout, preview length and attachment mode; the plugin keeps the latest scripts in its data directory.
- TTS is now configured in the host's own format: `tts.defaultVoice` (fallback reference) plus `tts.voices` inline or
  `tts.voicesFile: voices.yaml` for a large cast. `tts.astrbotConfig` was removed, `tts.characters` was renamed to
  `tts.voices`, and the flat `defaultRefAudioPath`/`defaultPromptText` fields are grouped under `tts.defaultVoice`.
  The loader reports every old field with a migration hint instead of silently ignoring it.
- Voice entries support aliases, GPT/SoVITS weights, per-emotion references and per-voice synthesis parameters. Names
  fold common simplified/traditional/Japanese variants, and aliases from `story.personaDirs` sheets are merged into the
  matching voice, so a site model name `高松燈` finds the voice `高松灯`; a name that belongs to another voice is never
  stolen by alias enrichment.
- `npm run check` (`host/tools/check.mjs`) validates the whole setup in one pass: unknown settings with spelling
  suggestions, wrong types, old TTS fields, service URLs, the story site, ffmpeg, Chrome, the site-format engine,
  Cubism Core, character sheets, LLM and TTS voices, writable output directories, and a non-loopback server without an
  API key. `node host/main.js --check` prints the same report as JSON.
- `npm run tts:check` (`host/tools/tts-check.mjs`) lists the voice table and, with `--synthesize`, writes one short
  WAV per voice to `output/tts-check/` so each reference can be listened to before generating an episode. `--voice`,
  `--emotion` and `--text` narrow the test.
- TTS synthesis retries transient failures (`tts.retries`) and reports `tts.voices`, `tts.fallbackLines`,
  `tts.silentLines`, `tts.failedLines` and the affected speakers in the API result and `.story.json`, so a missing
  reference or an unmatched character is visible instead of a silently quiet video.
- Add [docs/tts.md](docs/tts.md) and `voices.example.yaml`; `config.example.yaml` is a shorter quick-start with the
  fields that must change marked.
- The default server bind is now `127.0.0.1` instead of `0.0.0.0`, and operator service endpoints (LLM/TTS) reject
  private addresses unless `security.allowPrivateServiceEndpoints` is explicitly true.
- `host` is an npm workspace: one `npm install` at the repository root installs js-yaml, ffmpeg-static and the
  site-format engine; `npm run host:install` is gone. The render page resolves `ournotes-player-site` through Node and
  serves it at a stable `/site-engine/` route, so hoisted, pnpm and global installs work. The API version comes from the
  root package.
- CI and release workflows match the application again: both run the unit and host suites plus lint on a clean
  workspace install; the release job no longer tries to `npm publish` a private application or use the removed
  `typecheck`/`build.mjs`/`contract:check` scripts.

### Headless render host only

- The repository is now a video rendering framework only: the chart player, UI preview, browser player, npm browser
  bundles and the AstrBot plugin are removed. Any client uses the HTTP API.
- Add a director script extension: `camera` / `fade` / `pause` / `action` beats, `focus` (a cast id, a position, or a
  focus point 1--9), `track` pans, `lookAt`, and `actions` before or inside a line for speaker or listener motions,
  expressions and gaze.
- `actions` at `0` compile to pre-line `Motion`/`Expression`/`LookTarget` rows (the game's usual listener reaction);
  later actions run as `HostActions` on the line's virtual clock, so they cannot drift with render speed.
- Compiled `Motion`/`Expression` rows now carry `MotionFadeIn: -1`: the player uses each clip's own 1 s fade-in, so a
  new motion cross-fades from the pose on screen instead of snapping to its first frame (the cause of the jerky AI
  script motion switches).
- Add a staged AI pipeline (`llm.pipeline: staged`, now the default) for long character prompts: pass 1 casts 2--3
  models and designs one micro-event, pass 2 writes only the dialogue with the full `story.personas` of the selected
  cast, pass 3 directs that finished dialogue (stage, blocking, camera, motion, expression, gaze, listener reactions,
  BGM). The merge restores the dialogue verbatim and keys direction by `line` id, so the storyboard cannot rewrite a
  line; a repair round re-asks only for the storyboard. The storyboard prompt carries explicit focus/camera/lookAt and
  action budgets derived from the line count, and the merge trims extra listener reactions and standalone expressions.
  `llm.pipeline: single` keeps the one-call writer and its optional `llm.directorPlan`.
- Rewrite the AI prompt around the measured staging of eight official episodes (four two-person friendship stories,
  three chapters and 10610): 20--40 lines for a 2--3 minute scene, a cut every 3--4 lines with two-shot / speaker-side
  alternation, about 1.1 motions per line with some lines unacted, expressions attached to motions, `lookAt` every
  2--3 lines in two-person scenes, one character opening alone and the next entering after a few lines, and line-length
  variation with 20--35% two-row lines. The few-shot example was rewritten to show that pacing; the old 10--18 line /
  cut-every-line guidance is gone. Per-character line styles for the MyGO cast are measured from the same episodes.
- Camera work now follows 30 measured official episodes (1300 lines: 2 = 153 Focus rows, 3 = 176, 4 = 141, 1 = 21,
  5 = 16; 20% of lines sit at the 2.8x close-up): `close` (4) and `very-close` (5) join `near` / `middle` / `far`; a
  cast `focus` compiles to its slot as `PositionType` (the official solo close-up shape) instead of an off-centre
  `TargetName`; camera timing cuts in (no `Duration`), eases back out over 1.2 s and pans 0.5 s laterally; and the
  optional `zoom` / `zoomDuration` compile to the game's slow `Zoom` row (0--2 per scene). The AI prompt uses `close`
  about once per 8 lines, reserves `near` (1.2x) for the one wide shot, and adds the slow zoom on emotional shots; the
  normalizer turns a `near` line focused on one character into `close` and aims a group close-up at its speaker.
  `docs/story-director.md` has the measured table and shot grammar.
- A cast label copied from the persona list with its group suffix (`高松灯（鸡狗）`) is stripped to the display name
  before it reaches the talk window; the group still drives casting and voice matching.
- Motions still carry short semantic notes (`mtn_nod01` = nod, ...); the optional director-plan pre-pass stays off by
  default (`llm.directorPlan: false`) because the main prompt already carries the shot rules.
- Stage positions are normalized so characters do not stack: two people are moved to `far-left` / `far-right`; three
  to `far-left` / `center` / `far-right` with `camera: far`, `focus: 5` and `track: 0`. `story.maxOnStage` defaults to
  3 (the official group shot); set it to 2 to keep only the far pair and have the third wait outside. The AI cast pass
  chooses at most `maxOnStage` people, and a too-large stage is a storyboard repair problem.
- Add `fetch-story --characters`: read the published site's global `models.json` (194 entries), pick one preferred
  costume per character key, download its manifest and content-addressed files, and merge `models.json` / `site.json`.
  A site built from one episode now covers all 28 modeled characters of MyGO/Ave Mujica, millsage, 梦限大 and
  一家Dumb Rock!; the name map also knows `uika`, `umiri`, `nyamu`, `sub_mortis`, `sub_viola` and `sub_kanata`.
- The site-format AI catalog lists every model whose character has a sheet (`story.personaDirs`) or a known name, one
  costume per character and base-story outfits first, so a story can cast another band; `story.cast` still restricts
  the list. `buildSiteStory` merges the new cast into `story.json.models` and `manifest.models`, which is what lets
  those cross-band episodes render at all.
- Voice data can be copied once from AstrBot's `persona_storage`/`emotion_storage` (reference audio, GPT/SoVITS
  weights, per-emotion references, per-character `fragment_interval`) into `tts.voices` / `voices.yaml`; the runtime
  reads only the host's own table. The field mapping is in [docs/tts.md](docs/tts.md).
- Add `story.personaDirs`: every `*.md` in the configured directories is one character sheet. The cast pass sees only
  the name, group and one-line role; the dialogue pass gets the full sheet of the selected cast only. The sheet name,
  file stem, Japanese name and romanized name become aliases, so `adv_live2d_nagi_018_...` finds 琴平凪.
- The first live generation with the new prompt (36 lines, 3 cast, 0 warnings) exposed two staging gaps: the near shot
  was held to the end, and a three-person group used `left/center/far-right` and overlapped. The prompt now requires a
  return to the two-shot/group 1--2 lines after a close-up, 7--10 `Focus` changes in a 30-line scene, and
  `far-left/center/far-right` whenever three are on stage.
- Add `host/tools/site-story.mjs`: compile the same director script onto an `ournotes.story-manifest/2` site, with
  browser-font conversion, new episode assets and a `stories.json` entry.
- `fetch-story` merges `stories.json` / `models.json` instead of replacing them, so downloading several episodes for
  comparison keeps the earlier ones in the site index.
- `ai-site-story.mjs` now synthesizes TTS for the site-format path: 18+ WAV cues, a `ournotes_tts` cue sheet,
  `VoiceIDs`/`voiceCues` on Talk rows, and a `story.json` audio entry, so `render-story` plays real voices.
- Add per-line emotion judgement and per-character emotion reference/pacing overrides (`tts.emotion`,
  `voices[].emotions`); GPT/SoVITS weight pairs are switched through the server before a character's first line.
- The LLM JSON extractor unwraps double-encoded JSON strings returned by some gateways.
- Add a director demo (`host/fixtures/director-demo.json`) and an opt-in end-to-end test that compiles and renders it.
- Add `docs/story-director.md` and merge the useful staging rules from MySekaiStoryteller's story format.

### Headless render host

- Add `host/`: a pure-API ournotes-style video renderer that drives `StorySession` in headless Chrome, captures fixed-step frames, rebuilds the BGM/TTS audio timeline and encodes MP4 with ffmpeg.
- Move the queue, AI story writer and GPT-SoVITS TTS into the backend.
- Add `config.example.yaml`, `docs/host.md` and host tests (queue, prompt/validation, TTS cue injection, audio mixing, API, browser smoke).
- Add `host/tools/fetch-story.mjs`: download one episode of a published story site (manifest, common/language files, Live2D models, optional Cubism runtimes) with SSRF checks and content-addressed resume.
- Add `host/tools/render-story.mjs` and a site-format engine path: render an existing `ournotes.story-manifest/2` episode with the same `ournotes-player@0.1.8` engine bdon.moe's player uses, including deterministic voice PCM for MotionSync lip sync.

## [0.2.0](https://github.com/empty-sekai/ournotes-player/compare/v0.1.8...v0.2.0) - 2026-10-19

### Product loading and compatibility

- Read shared object resources from `nnnotes.product/1` manifests through typed texture, material, mesh, prefab, animation and shader accessors.
- Play Live2D model format 3, live products and UI packs through the shared object layer.
- Read format 2 chart and Live2D model sites through the same rendering interfaces.
- Story and UI inputs use the product formats generated by nnnotes 0.3.x.
- Route story cue volumes by CRI category names while retaining sound-row stop and crossfade behavior.

### Data validation

- Check product chart listings against manifest metadata and the complete unique asset closure.
- Validate chat status text values in story UI documents.
- Validate prefab hierarchy documents against their published transform and component schema.
- Describe room, spot, sound, video and CRI Lips documents, and accept null localization on native text records.

### Site products

- Select regional model aliases by region and localize standalone chart band names.
- Expose chart metadata for standalone live products and site aliases.
- Load live variants from entry manifests and accept variant paths in read-set requests.
- Validate product chart aliases, language-indexed UI references and offered variants.
- Honor audio-disabled story products and select an available playback language from story listings.

### Story products

- Story loading, playback and authoring use `nnnotes.product/1` manifests with shared object resources and language-specific UI and fonts.
- Home and live-result stories resolve their host prefabs, room geometry, Spine materials and animation bindings by object identity.
- Data validation checks the story product graph, font bindings, shader variants, audio files and model dependencies. `--lang` selects an explicit language scope.
- Node story loading accepts a manifest or a product layout containing exactly one story.

### Bug fixes

- Keep Spine index uploads from changing another renderer's vertex array.
- Keep model and shared-object validation caches independent.
- Clear loading text after language changes and display configured audio volumes in the controls.

## [0.1.8](https://github.com/empty-sekai/ournotes-player/compare/v0.1.7..v0.1.8) — 2026-10-16

### Features
- report fixes for script problems, and pace each line _(story-author)_


### Bug Fixes
- cull per-object lights against the layer of each draw _(story)_
- refuse nested DOTween Sequences _(story)_
- play a cue missing from its sheet as silence _(story)_


### Documentation
- list every export of the story and UI entry points


## [0.1.7](https://github.com/empty-sekai/ournotes-player/compare/v0.1.6..v0.1.7) — 2026-10-14

### Features
- support nominal chart expectations _(songs)_
- let a pack name a browser font family for its text _(ui)_
- export the replay input presets as ournotes-player/replay/preset _(replay)_
- draw font glyphs in the browser with TextMeshPro layout _(story)_
- add an experimental command-line story author _(story)_


### Bug Fixes
- cancel failed and aborted loads _(assets)_
- release MotionSync native resources _(live2d)_
- give uGUI draws the constants a 2D Shader Graph sprite material reads _(story)_
- preserve Sprite geometry and native formation perspective _(ui)_
- sample atlas Sprites from integer local crops _(ui)_
- draw nothing for the zero glyph of a browser font _(story)_


### Documentation
- add a changelog generated by git-cliff


## [0.1.6](https://github.com/empty-sekai/ournotes-player/compare/v0.1.5..v0.1.6) — 2026-09-30

### Features
- chart data page over nnnotes songs and chart-stats _(examples)_
- the chart data page reads nnnotes music-data _(examples)_
- the chart data page names the deck model commit _(examples)_
- play scenarios and accuracy sliders on the chart data page _(examples)_
- the chart detail shows the rank measure of every Gekisou range _(examples)_
- add single-skill aptitude functions and master factor conversion _(examples)_
- show Gekisou skill aptitude and chart factors in details _(examples)_
- label chart data and Gekisou aptitude as Beta _(examples)_
- refine chart data and add optional replay controls _(songs)_
- add experimental serialized prefab preview _(ui)_


### Bug Fixes
- the chart data page guide renders its definition lists; hedged wording _(examples)_
- keep mobile tables complete and contain replay controls _(songs)_
- keep engine notes consistent across line endings _(ui)_
- keep unsupported motion timing finite _(ui)_
- preserve notes and keep manual runs unpublished _(release)_


### Documentation
- the chart data page guide gives the rank 1 to rank 5 ratio _(examples)_
- chart data guide: figures come from a rewrite checked against the game's code _(examples)_
- chart data guide: how Gekisou skills work _(examples)_
- correct the Just-count support interaction claim _(examples)_
- record the scoped native whole-live verification _(examples)_


## [0.1.5](https://github.com/empty-sekai/ournotes-player/compare/v0.1.4..v0.1.5) — 2026-09-28

### Bug Fixes
- let a page's video keep its own clock, as CRI Mana does _(story)_
- catch up a late frame's game time up to Time.maximumDeltaTime _(story)_


### Performance
- drain the phases of a step in user-blocking tasks _(engine)_
- upload only the uniforms and blocks that changed; switch only changed vertex arrays _(engine)_
- draw a model from shared buffers; leave out the state a run of draws already set _(live2d)_


## [0.1.4](https://github.com/empty-sekai/ournotes-player/compare/v0.1.3..v0.1.4) — 2026-09-28

### Bug Fixes
- lay dialog texts and font fallbacks out with the game's line metrics _(story)_


## [0.1.3](https://github.com/empty-sekai/ournotes-player/compare/v0.1.2..v0.1.3) — 2026-09-28

### Bug Fixes
- lay open fonts out with the game's line metrics _(story)_


## [0.1.2](https://github.com/empty-sekai/ournotes-player/compare/v0.1.1..v0.1.2) — 2026-09-28

### Bug Fixes
- relay the log event and ignore taps while a session is replaced _(story)_


### Performance
- cache shader variants and pass states per material _(engine)_
- draw at the game's screen resolution, lighter frames on phones _(story)_


## [0.1.1](https://github.com/empty-sekai/ournotes-player/compare/v0.1.0..v0.1.1) — 2026-09-27

### Features
- read compressed assets and stories that reference their models


### Documentation
- describe the live, story and Live2D players in the README


## [0.1.0](https://github.com/empty-sekai/ournotes-player/releases/tag/v0.1.0) — 2026-09-27

### Features
- add the chart player, its API and the <ournotes-player> element
- add a Live2D model viewer
- support chart sites of several regions and languages
- describe regions, languages and model names in the manifests
- add read-set --plan: a chart's read set without stepping it
- add read-set --serve: many charts in one process
- add the game's Live settings and a note speed control
- add the Live2D story runtime, motion events and the URP post stack
- add bar lines and the flick arrows of note designs 2 and 3
- add the story player _(story)_
- chat phone, centered talk window, frame particles, URP-lit rooms, CRI Lips lip sync and emoji sprites _(story)_
- text underlines, named colours, missing glyphs, frame texts and video seek re-speed _(story)_
- frame canvas texts laid out and drawn through the story UI _(story)_
- text layout and drawing through TMP font fallback chains _(story)_
- particle effects draw from their own random stream _(story)_
- line and video bars in the control bar, seeking to a line or within a movie _(story)_
- a film-grain option, off by default; the grain tiles at the game's render size _(story)_
- seek within a clip; the control labels follow the story's language _(story)_
- the home spot's post-processing volume _(story)_


### Bug Fixes
- element state in ready, property setters, single play event
- model opacity curves and expression ids the model lacks _(live2d)_
- follow the host's visibility; check the Cubism Core before loading
- sort the ENGINE: notes list the same way on every platform
- accept any AudioContext sample rate and suspend it at the chart end
- simple talk window draws and checks text from fallback fonts _(story)_
- rebind every model's views after the Cubism Core heap grows _(live2d)_
- hide the backlog and choices at start, show letterbox bands in time, drop the menu _(story)_
- apply the UI stencil state, so the video curtain and masked UI draw _(engine)_
- drop the story page's line caption, which repeated the talk window with its tags _(examples)_
- a voice's PCM source made before the voice starts no longer drops the voice _(audio)_
- the story pages keep the core and motionsync query entries in their links _(examples)_
- a story motion that has ended holds its last pose instead of replaying _(live2d)_
- story videos play their sound and pause with the player _(story)_
- the story pages load a Spine runtime from ?spine= for home talks _(examples)_
- supply the sprite, camera and object built-ins that particle effects read _(story)_
- a float4 value on a float, float2 or float3 uniform uploads its leading components _(engine)_


### Performance
- build the per-draw uniform sheet on demand
- a forward clip seek plays on from the current session; cheaper undrawn steps _(story)_


### Documentation
- describe the chart data format, with JSON schemas and a validator
- write the readme, fidelity notes and contributing guide
- link nnnotes at its home, MetaSekaiLab/nnnotes
- install from GitHub until the package is on npm
- add performance.md: the CPU cost of a frame
- a file holds each controller and clip once; the validator checks every reference _(story)_
