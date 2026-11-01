# Changelog

## v0.1.0

- Add the `/剧本生成` command (aliases `/写剧本`, `/storygen`).
- Call `POST /api/v1/script/generate` on an ournotes-render host and send a readable preview plus the complete
  `ournotes.story-script/1` JSON as a file.
- Configurable language, target duration, line limit, base story, timeout, preview length and attachment mode.
- Retain the latest generated scripts in the plugin data directory and prune older ones.
