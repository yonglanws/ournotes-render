# 宿主调优记录（2026-11-12，服务器 /vol2/1000/ournotes-player）

本文只记录部署环境相关的调优，不改代码路径。服务器硬件与两项目共用：i5-4590（4 核）、15.9 GB 内存、CMP 40HX 8 GB 显存、Irodori-TTS `:8088`。

## 1. 编码：改用系统 ffmpeg（NVENC）

`ffmpeg-static` 的构建不包含 `h264_nvenc`，宿主会依次尝试 nvenc/amf/qsv 失败后回退 `libx264`。服务器配置：

```yaml
video:
  ffmpegPath: /usr/bin/ffmpeg   # mediasrv 7.1.3，带 h264_nvenc
  crf: 28                        # NVENC 的 -cq 也用这个值
```

实测（12 句、36 秒、1079 帧）：

| 配置 | 编码器 | 渲染段 | 成片 |
| --- | --- | --- | --- |
| 优化前 | libx264 | 195.2 s | 4.33 MB（0.96 Mbps） |
| 优化后 crf20 | h264_nvenc | 96.8 s | 20.6 MB（4.6 Mbps） |
| 优化后 crf28 | h264_nvenc | 96.8 s | 5.87 MB（1.31 Mbps） |

`-cq 20` 的 NVENC 码率远高于 x264 crf20；crf28 与 MSST 成片码率一致，画质在 1300x600 下没有可见劣化。

## 2. 并发

`queue.concurrency: 2`。两个 36 秒任务同时运行时：

- 各任务 163 s 完成（单任务 109 s），吞吐 1 个/109 s → 2 个/163 s（约 1.34 倍）。
- 显存峰值 5.3 GB（当时 Irodori 缓存 8 个 LoRA）；把 Irodori 的 `IRODORI_LORA_CACHE_SIZE` 降到 3 后，同一场景显存余量约 4 GB。
- CPU 4 核接近饱和，不建议再提高并发。更多请求由队列（`maxSize: 20`）承接。

## 3. 与共享 TTS 的关系

Irodori 只有一个合成槽位，聊天 TTS 高峰时每分钟 7-9 个请求。视频每句 TTS 需要排队 30-70 秒，是导出耗时的主要部分：

- 已验证的 2 句视频（TTS + 渲染）整单约 74 s（低峰）；
- 12 句纯渲染（无 TTS）约 109 s；
- 4 句 TTS 在混合负载下的整单时间见 `docs/` 测试记录。

因此插件侧 `export_timeout` 建议 3600 秒，`max_concurrent_requests: 2`。不要在 Irodori 饱和时提高宿主并发或 TTS 并发。

## 4. 稳定性

- 客户端断连会 abort 剧本生成并取消渲染任务；排队中/运行中取消都会释放 Chrome。
- **浏览器崩溃快速失败**：渲染器用 `Browser.onClosed()` 与页面结果做 race。`kill -9` Chrome 主进程后任务在 5 秒内失败（`the browser closed before the render page reported a result`），队列立即释放，不会占槽到 `render.taskTimeoutMs`。服务器把该上限从 1 小时降到 30 分钟，作为卡死兜底。
- `render-healthcheck.timer` 每 2 分钟探测 `/api/v1/health`，连续 3 次失败才重启 unit。
- 站点写入由 `_withSiteWrite` 串行化，manifest / stories.json 原子写入；并发渲染不会互相覆盖。

## 5. 实测

| 场景 | 结果 |
| --- | --- |
| 12 句纯渲染（36 s，1079 帧） | 207.5 s → 108.6 s（NVENC + 空闲 GPU 修复） |
| 2 个 36 s 任务并发 | 各 163 s，吞吐约 1.34 倍，显存峰值 5.3 GB |
| 2 句 + TTS（11.4 s） | 107.9 s，2/2 句有声，mean -22.7 dB / max -6.9 dB |
| 渲染中 kill Chrome | 5 s 内任务失败，队列释放；下一个任务 54 s 成功 |
| 插件测试 | 23 passed + 3 subtests |
| 单元/宿主测试 | 525 + 178 passed（1/3 skip），lint 干净 |
