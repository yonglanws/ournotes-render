# Contributing

Thank you for helping. This document covers the branches, the commit conventions, the tests, and the data policy.

## Data policy

**Never commit game data.** This repository contains no game assets: no charts, story files, textures, shaders, audio,
or files derived from them, and no screenshots or recordings of them in tests or fixtures. Tests use synthetic inputs
only. `resources/` (downloaded by `host/tools/fetch-story.mjs`), `output/`, `cache/`, `config.yaml` and `voices.yaml`
are operator-local and ignored by Git.

## Development

Node.js 22 or later. Install once at the repository root; `host/` is an npm workspace, so this also installs
`js-yaml`, `ffmpeg-static` and the site-format engine. There is no build step.

```sh
npm install
npm test               # unit tests: node --test tests/unit/*.test.mjs
npm run test:host      # queue, AI, TTS, audio, API, headless browser
npm run lint           # ESLint's recommended rules (eslint.config.js)
npm run check          # config.yaml, ffmpeg, Chrome, story site, voices
npm run tts:check      # list voices; add -- --synthesize to hear one sample per voice
npm start              # node host/main.js, API on http://127.0.0.1:9881
```

The host is plain ESM in `host/`; the story engine is `src/`. When you change the configuration surface, update
`config.example.yaml`, `voices.example.yaml`, `docs/host.md`, `docs/tts.md` and the loader tests together.

### Tests

- `tests/unit/`: the story engine, Live2D and director script, synthetic inputs only. Test behaviour the code documents:
  an expected value should come from the definition the module states, not from the current output of the code.
- `host/tests/`: the queue, AI writer, TTS client and voice table, audio mix, HTTP API, page server and renderer.
  The end-to-end render tests are opt-in and need a downloaded story site plus Cubism Core:

  ```sh
  OURNOTES_E2E_SITE=resources/site \
  OURNOTES_E2E_CORE=resources/site/vendor/live2dcubismcore.min.js \
  node --test host/tests/e2e-director.test.mjs
  ```

- `npm run check` is the first stop for a configuration report; it collects every problem at once (unknown keys with a
  spelling suggestion, wrong types, old TTS fields, missing site/voices, unusable ffmpeg/Chrome, a non-loopback server
  without an API key) instead of failing on the first one.
- `astrbot_plugin_ournotes_script/tests/`: Python `unittest` for the plugin's formatter, storage, host client and a
  stubbed AstrBot command flow. Run it with `python -m unittest discover -s astrbot_plugin_ournotes_script/tests -v`
  (only `aiohttp` is needed; the AstrBot modules are stubbed by the test).

Rendering changes cannot be verified by the tests alone; describe how you checked them in the pull request.

### Fidelity

The player follows the game's own code. Comments name the game class and method a piece of code follows. Behaviour that
lives in the engine's native code (Unity, CRI) rather than in the game's managed code is implemented from the engine's
documented semantics and marked with a comment starting `ENGINE:`. [docs/story-features.md](docs/story-features.md)
lists the supported story features and their limits.

## Branches and pull requests

Work goes to `dev` (or a branch of your own) and reaches `main` through a pull request. `main` takes rebase merges
only, after the `test` and `conventional commit lint` checks pass; it is never force-pushed or deleted. Releases are
tagged on `main`.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), in English:

```
<type>(<optional scope>): <summary in the imperative, at most 100 characters>
```

Types: `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style`, `revert`. A breaking change
is marked with `!` after the type or a `BREAKING CHANGE:` footer. The `lint-commits` workflow checks the titles.

Release notes are generated from the commits with [git-cliff](https://git-cliff.org/) (`cliff.toml`): `feat`, `fix`,
`perf`, `docs` and breaking changes appear in them; the other types do not.

## Releases

Versions follow [SemVer](https://semver.org/). This repository is a headless application, not an npm library: releases
are GitHub releases, and nothing is published to npm. A release is a tag `vX.Y.Z` matching `version` in
`package.json`; the release workflow runs the unit and host suites plus lint on a clean workspace install, checks the
tag against `package.json` and `CHANGELOG.md`, and creates the GitHub release with notes from git-cliff.

The commit that sets the new `version` also regenerates [CHANGELOG.md](CHANGELOG.md):

```sh
npx git-cliff@2.14.2 --tag vX.Y.Z -o CHANGELOG.md
```

The release workflow fails when `CHANGELOG.md` has no `## [X.Y.Z]` section for the tagged version.

## License

By contributing you agree that your contributions are licensed under the repository's license (AGPL-3.0-only, with
the browser exception in [LICENSE-EXCEPTION](LICENSE-EXCEPTION)).
