# ournotes-render

**A headless, pure-API video renderer for Our Notes style Live2D story scenes.**

Give it a scene prompt or an `ournotes.story-script/1` director script; the backend casts the characters, writes the dialogue, directs the shots, synthesizes TTS voices, materializes any needed cloud assets on demand, compiles the episode, renders it frame by frame in headless Chrome with the game's own `StorySession`, rebuilds the audio timeline, and encodes an MP4.

This repository keeps only the video rendering framework (the chart player, UI preview, and standalone browser player have been removed). Bots and external clients only call the HTTP API; the official AstrBot adapter lives in the standalone [astrbot_plugin_ournotes_script](https://github.com/yonglanws/astrbot_plugin_ournotes_script) repository.

## Features

- **Zero-local-site cloud-first runtime**: `paths.site` and `paths.siteFormat` are optional and default to `""`. When both are empty, starting the host automatically bootstraps a lightweight cloud runtime base from `https://storage.bdon.moe/moenotes` into `paths.cache/cloud-site` (skipping voice archives and the 1,021-story archive) and materializes Live2D models, stages, BGM, SE, stills, frames, particle effects, post-effects, and rule transitions on demand from `storage.bdon.moe/moenotes` and `assets.bdon.moe`. `host/tools/fetch-story.mjs` is now optional offline tooling rather than a required setup step.
- **Full Cloud Chinese Semantic Catalog & AI selection**: Bundled offline catalog (`host/story/cloud-catalog.json` + `host/story/site-resources.yaml`, built by `host/tools/build-cloud-catalog.mjs`) covering **343** stages (with indoor/outdoor, time-of-day, band tags, and title-card filtering), **91** BGMs, **345** SEs, **267** Live2D models (**209 TW + 58 JP**, grouped by character, band, and outfit), plus donor indices for **53** frames, **14** post-effects, **10** particle effects, **349** stills, and **6** rule transitions. AI prompts use CJK bigram + semantic/tone/band-ranked categorized selection while compilation accepts every valid cloud asset ID.
- **Official ADV-style direction**: `scene` / `positions` / `say` / `narrate` / `camera` / `fade` / `pause` / `action` plus blocking, camera, FX, and sound beats, with focus points (`1..9`), distance, `track` pans, gaze, Live2D motions (left slots `1,3` use `_L` facing screen-right/inward; right slots `7,9` use `_R` facing screen-left/inward; `center` `5` uses `_C`), expressions, pre-line listener reactions (`actions` `at: 0`), fades, and silent beats. Two-person scenes frame at `left`/`right` + `middle` (1.4×); three-person groups frame at `far-left`/`center`/`far-right` + `near` (1.2×) with `close` reserved for single-speaker close-ups. Rules follow measurements from 30 official episodes; see [Story director](docs/story-director.md).
- **Backend pipeline**: queue, AI casting / dialogue / storyboard, validation and repair, TTS, cloud materialization, rendering, audio mix, and encoding all live in `host/`. The default `staged` pipeline gives full character sheets only to the dialogue pass; the storyboard references `line` IDs and cannot rewrite finalized lines.
- **Standalone AstrBot plugin**: [astrbot_plugin_ournotes_script](https://github.com/yonglanws/astrbot_plugin_ournotes_script) provides `/视频对话` and `/剧本生成` (aliases `/写剧本`, `/storygen`), calling the host's script and render endpoints and sending finished MP4s back to chat.
- **Deterministic frames**: a fixed 1/30 s virtual clock; audio is rebuilt from playback events on the same timeline, so render speed never changes the output timing.
- **Three site modes**: zero-config cloud runtime (`cloud-site`, default), local bdon site (`paths.siteFormat` / `ournotes.story-manifest/2`), or nnnotes product site (`paths.site` / `nnnotes.product/1`).
- **Safe defaults**: secrets come from environment variables only; outbound URLs allow `http`/`https` only with private, loopback, and reserved addresses rejected; optional Bearer auth; CORS off by default.

## Quick start

Requires Node.js 22+, Chrome/Chromium/Edge, and ffmpeg (`npm install` at the repository root installs `ffmpeg-static`; if that download fails, point `video.ffmpegPath` at a system ffmpeg).

```sh
npm install                    # one install; host/ is an npm workspace
cp config.example.yaml config.yaml
# configure llm and tts in config.yaml (leave paths.site & paths.siteFormat empty for cloud-first runtime)
npm run check                  # check config, ffmpeg, Chrome, site mode, and voices
npm start                      # API: http://127.0.0.1:9881

curl -sS http://127.0.0.1:9881/api/v1/health
```

TTS supports GPT-SoVITS (`api_v2`) and Irodori-TTS (OpenAI-compatible `/v1/audio/speech`), configured via `tts.provider` using the same `tts` schema as [MySekaiStoryteller-API](https://github.com/yonglanws/MySekaiStoryteller-API). Voices are configured in `tts.voices` or `tts.voicesFile: voices.yaml` (see `voices.example.yaml` and [TTS guide](docs/tts.md)).

```sh
npm run tts:check                          # inspect the voice table
npm run tts:check -- --synthesize          # synthesize one test line per voice into output/tts-check/
```

Generate a video (with no local site configured, the host bootstraps `cache/cloud-site` on startup and materializes assets on demand):

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A quiet talk after school about the next live","timeout":1800000}'
```

Add `"wait": false` for an async task, then poll `GET /api/v1/tasks/:id` and download the MP4 from `GET /api/v1/download/<file>`. See [Render host](docs/host.md) for the full API, configuration, pipeline, and security details.

## Optional offline tools

For offline pre-downloading or rendering an existing local episode without AI/TTS:

```sh
# Optional: download a published episode, UI/fonts, audio, and Live2D models to resources/site
npm run host:fetch-story -- --adv 10610 --lang ja --out resources/site

# Render that episode directly
npm run host:render-story -- --site resources/site --story stories/10610.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job bdon-10610
```

Compile and render a local director script:

```sh
npm run host:site-story -- --site resources/site --base stories/10610.json \
  --script host/fixtures/director-demo.json --adv 90001 --lang ja --title "ライブのあとで"
npm run host:render-story -- --site resources/site --story stories/90001.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job director-demo
```

Local assets stay in `resources/` and `cache/` (git-ignored); the repository redistributes no game data or Live2D runtimes.

## Documentation

| Topic | Doc |
| --- | --- |
| API, cloud runtime, queue, AI, TTS, deployment, security | [Render host](docs/host.md) |
| Host performance tuning and long-render stability notes | [Host tuning](docs/host-tuning.md) |
| TTS voice table, reference audio, weights/LoRA, emotions, voice test | [TTS guide](docs/tts.md) |
| Standalone AstrBot plugin: `/视频对话`, `/剧本生成` | [astrbot_plugin_ournotes_script](https://github.com/yonglanws/astrbot_plugin_ournotes_script) |
| Director script, camera/acting, AI direction rules | [Story director](docs/story-director.md) |
| CLI authoring, checks, builds, shot sheets (experimental) | [Story author](docs/story-author.md) |
| Story data, fonts, audio, models | [Story data format](docs/story-data-format.md) |
| Product and model data formats | [Data format](docs/data-format.md) |
| Story engine feature coverage | [Story features](docs/story-features.md) |
| CRI Lips | [CRI Lips](docs/crilips.md) |

## Development & testing

```sh
npm test                  # unit tests (engine, story-author, Live2D, director script)
npm run test:host         # host tests (queue, AI, TTS, cloud materialization, audio mix, API, browser smoke)
npm run test:stories      # official baseline, AI quality, and command audit gates
npm run lint              # ESLint
```

See [Render host](docs/host.md#测试) for additional scripts (`baseline:stories`, `eval:stories`, `audit:stories`, `audit:frames`) and E2E environment variables.

## License

Based on [empty-sekai/ournotes-player](https://github.com/empty-sekai/ournotes-player) (AGPL-3.0-only). Game assets, trademarks, Live2D Cubism Core, LLM, and TTS services keep their own licenses; this repository ships none of them.
