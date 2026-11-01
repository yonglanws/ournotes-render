# host

无头、纯 API 的 Our Notes 风格 Live2D 视频渲染后端。它运行本仓库的 `StorySession`（游戏剧情 UI、Live2D
着色器、13:6 舞台），并在后端完成队列、AI 分镜/剧本、GPT-SoVITS TTS、逐帧渲染、混音和 MP4 编码。

完整说明见 [../docs/host.md](../docs/host.md)，导演脚本格式见 [../docs/story-director.md](../docs/story-director.md)，
TTS 配置与试音见 [../docs/tts.md](../docs/tts.md)。

```sh
# 在仓库根目录执行（host 是 npm workspace）
npm install
cp config.example.yaml config.yaml
npm run check        # 配置/ffmpeg/Chrome/站点/音色
npm start            # API: http://127.0.0.1:9881
npm run tts:check    # 列出音色；加 -- --synthesize 逐角色试音
```

- `paths.site` 必须指向 nnnotes 构建出的产品站点（仓库不附带游戏资源）才能使用 AI 队列。
- 站点格式（bdon.moe）可下载后直接渲染，或用 `node host/tools/site-story.mjs` 编译导演脚本。
- `render.core` 指向 Live2D Cubism Core（本地文件或 URL）。
- LLM / TTS 的密钥只从环境变量读取（`*Env` 字段）。
- TTS 音色表是本项目自己的格式（`tts.voices` / `voices.yaml`），不读取 AstrBot 的配置。

工具：

```sh
node host/tools/fetch-story.mjs --adv 10610 --lang ja --out resources/site
node host/tools/render-story.mjs --site resources/site --story stories/10610.json --lang ja \
  --core resources/site/vendor/live2dcubismcore.min.js --out output --job bdon-10610
node host/tools/site-story.mjs --site resources/site --base stories/10610.json --list --lang ja
node host/tools/ai-site-story.mjs --site resources/site --base stories/10610.json --lang ja \
  --prompt "ライブのあとの会話" --adv 90002 --minutes 2
```
