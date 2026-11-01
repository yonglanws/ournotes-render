# ournotes-render

**A headless, pure-API video renderer for Our Notes style Live2D story scenes.**

Give it a scene prompt or an `ournotes.story-script/1` director script; the backend casts the characters, writes the
dialogue, directs the shots, synthesizes GPT-SoVITS voices, compiles the episode, renders it frame by frame in headless
Chrome with the game's own `StorySession`, rebuilds the audio timeline and encodes an MP4. The queue, AI director, TTS
and renderer all live in the backend; a bot or any other client only calls the HTTP API.

This repository keeps only the video rendering framework. The chart player, UI preview, browser player and AstrBot
plugin have been removed.

## Features

- **Official ADV-style direction**: `scene` / `positions` / `say` / `narrate` / `camera` / `fade` / `pause` /
  `action`, with camera focus points, distance, `track` pans, gaze, Live2D motions and expressions, pre-line listener
  reactions, fades and silent beats. The prompt follows measured official pacing (two-person scenes run 36--44
  lines, cut every 3--4 lines, use about 1.1 motions per line, attach expressions to motions, use `lookAt` every
  2--3 lines) and the camera distribution of 30 official episodes. See [Story director](docs/story-director.md).
- **Backend pipeline**: queue, AI casting / dialogue / storyboard, validation and repair, TTS, rendering, audio mix and
  encoding are all in `host/`. The default `staged` pipeline gives the full character personas only to the dialogue
  pass; after that the storyboard references `line` ids and cannot rewrite a line. TTS voices are this project's own
  format (`tts.defaultVoice` + `tts.voices` / `voices.yaml`); no AstrBot or other bot config is read at runtime.
- **Deterministic frames**: a fixed 1/30 s virtual clock; audio is rebuilt from the page's playback events on the same
  timeline, so render speed never changes the result.
- **Two data sources**: nnnotes product sites (`nnnotes.product/1`) for the AI queue + TTS, and published bdon.moe
  story sites (`ournotes.story-manifest/2`) for direct rendering or `ai-site-story` authoring with TTS.
- **Safe defaults**: secrets come from environment variables only; download URLs are http/https with private,
  loopback and reserved addresses rejected; optional Bearer auth; CORS off by default.

## Quick start

Node.js 22+, Chrome/Chromium/Edge, and ffmpeg (`npm install` at the repository root installs `ffmpeg-static`; if that
download fails, point `video.ffmpegPath` at a system ffmpeg).

```sh
npm install                    # one install; host/ is an npm workspace
cp config.example.yaml config.yaml
# edit the lines marked ← in paths.site / llm / tts
npm run check                  # config, ffmpeg, Chrome, site and voices
npm start                      # API: http://127.0.0.1:9881

curl -sS http://127.0.0.1:9881/api/v1/health
```

TTS voices are configured in this project's own format: inline `tts.voices`, or `tts.voicesFile: voices.yaml` for a
larger cast (see `voices.example.yaml`). [TTS guide](docs/tts.md) covers reference audio, weights, emotions and
`npm run tts:check`.

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"A quiet talk after school","timeout":1800000}'
```

Add `"wait": false` for an async task, then poll `GET /api/v1/tasks/:id` and download the MP4 from
`GET /api/v1/download/<file>`. See [Render host](docs/host.md) for the API, configuration, pipeline and security.

## Download published assets and render

```sh
node host/tools/fetch-story.mjs --adv 10610 --lang ja --out resources/site
node host/tools/render-story.mjs --site resources/site --story stories/10610.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job bdon-10610
```

Render a director script with focus points, `track` pans, group changes, reactions and a silent reaction shot:

```sh
node host/tools/site-story.mjs --site resources/site --base stories/10610.json \
  --script host/fixtures/director-demo.json --adv 90001 --lang ja --title "ライブのあとで"
node host/tools/render-story.mjs --site resources/site --story stories/90001.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js \
  --motionsync resources/site/vendor/live2dcubismmotionsynccore.min.js \
  --out output --job director-demo
```

Assets stay in `resources/` (ignored); the repository redistributes no game data or Live2D runtime.

## Documentation

| Topic | Doc |
| --- | --- |
| API, queue, AI, TTS, deployment, security | [Render host](docs/host.md) |
| TTS voice table, reference audio, weights, emotions, voice test | [TTS guide](docs/tts.md) |
| Director script, camera/acting, AI direction rules | [Story director](docs/story-director.md) |
| CLI authoring, checks, builds, shot sheets | [Story author](docs/story-author.md) |
| Story data, fonts, audio, models | [Story data format](docs/story-data-format.md) |
| Story engine support | [Story features](docs/story-features.md) |
| CRI Lips | [CRI Lips](docs/crilips.md) |

## Development

```sh
npm test
npm run test:host
npm run lint
```

The real-site and director end-to-end tests need a downloaded site and `OURNOTES_E2E_SITE` / `OURNOTES_E2E_CORE`;
see [Render host](docs/host.md).

## License

Based on [empty-sekai/ournotes-player](https://github.com/empty-sekai/ournotes-player) (AGPL-3.0-only). Game assets,
trademarks, Live2D Cubism Core, LLM and TTS services keep their own licenses; this repository ships none of them.
