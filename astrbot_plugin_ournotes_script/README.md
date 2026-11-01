# astrbot_plugin_ournotes_script

AstrBot 插件：在聊天里用一条指令生成 **Our Notes 导演剧本**。它调用
[ournotes-render](https://github.com/yonglanws/ournotes-render) 后端的 `POST /api/v1/script/generate`，把结果整理成
可读预览，并附上完整的 `ournotes.story-script/1` JSON 文件。

## 功能

- `/剧本生成 <场景描述>`：AI 选角、写台词、写分镜，返回剧本预览 + JSON 附件。
- 预览包含标题、角色、场景、站位、台词、旁白；可选显示动作、表情、视线、镜头、焦段、横移和慢推镜。
- JSON 可以直接回填给后端渲染，或交给 `host/tools/site-story.mjs` 编译进站点。
- 插件数据目录只保留最近若干份剧本，旧的自动清理。
- 平台不支持文件消息时自动回退为纯文本预览。

## 前置条件

1. 已部署 ournotes-render，并且 `paths.site` 指向 nnnotes 产品站点、`llm` 可用。
2. AstrBot 4.5 或更新版本。
3. AstrBot 能访问到 host 的 HTTP 地址（同一台机器用 `http://127.0.0.1:9881`，跨机器用内网地址）。

## 安装

把本目录放到 AstrBot 的插件目录：

```text
AstrBot/data/plugins/astrbot_plugin_ournotes_script/
```

然后安装依赖（AstrBot 的插件管理器通常会自动安装；手动方式如下）：

```sh
pip install -r requirements.txt
```

在 AstrBot WebUI → 插件管理里重载插件，或重启 AstrBot。看到日志
`[ournotes] script plugin ready` 即加载成功。

> 本目录在 ournotes-render 仓库的 `astrbot_plugin_ournotes_script/` 下。也可以单独复制这个目录到
> `data/plugins/`，不需要复制整个渲染仓库。

## 配置

在 AstrBot WebUI → 插件管理 → `Our Notes 剧本生成` → 配置中修改：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `api_base` | `http://127.0.0.1:9881` | ournotes-render 地址；可带 `/api/v1` 后缀 |
| `api_key` | 空 | host 开启 API 鉴权时填写；对应 `security.apiKeyEnv` 指向的环境变量 |
| `language` | `zh-Hans` | `auto` = 跟随底本站点；也可选 `zh-Hant` / `ja` / `en` / `ko` |
| `base_story` | 空 | 底本 manifest，如 `stories/10610.json`；留空自动选第一篇 Normal |
| `target_minutes` | `2` | 目标时长（分钟） |
| `max_lines` | `40` | 最大台词条数 |
| `timeout_seconds` | `300` | 生成请求超时 |
| `max_prompt_chars` | `500` | 场景描述长度上限 |
| `preview_lines` | `20` | 聊天预览的台词条数，`0` = 全部 |
| `max_text_chars` | `1800` | 聊天预览字符上限，适配平台单条消息限制 |
| `send_json_file` | `true` | 发送完整 JSON 附件；平台不支持时自动回退文本 |
| `include_directions` | `true` | 预览中显示动作/表情/镜头 |
| `max_files` | `50` | 数据目录保留的最近剧本数 |

`api_base` 只接受 `http` / `https`；不接受带用户名密码或查询参数的地址。

## 使用

```text
/剧本生成 放学后的教室里，灯和爽世聊起下次 Live
/剧本生成 雨天的天台，爱音发现素世一个人在练习
/写剧本 三个人在 Live 结束后讨论新曲
```

别名为 `/写剧本` 和 `/storygen`。不带参数时返回用法和当前配置。

输出示例（实际内容由 AI 生成）：

```text
《天台上的告别》
角色：千早爱音、长崎素世、高松灯
共 18 句 · 1 个场景

【场景】学校天台 · 背景 adv_bkg_stage_000189 · BGM sound_bgm_adv_nows_the_time
【站位】千早爱音 far-left
千早爱音：上来啦上来啦，夕阳正好哦！（动作 mtn_smile02 · 表情 exp_smile02）
【站位】千早爱音 far-left，长崎素世 far-right
长崎素世：突然叫我们上来，就是为了拍照？（表情 exp_idle02 · 视线 anon）
...
……（完整剧本见附件）
```

附件是一个 `标题-时间.json` 文件，内容形如：

```json
{
  "format": "ournotes.story-script/1",
  "base": "stories/10610.json",
  "language": "zh-Hans",
  "title": "天台上的告别",
  "font": "sans",
  "cast": { "anon": { "model": "...", "name": "千早爱音" } },
  "beats": [
    { "scene": "...", "positions": { "anon": "far-left" }, "camera": "middle" },
    { "say": "anon", "text": "上来啦上来啦，夕阳正好哦！", "motion": "mtn_smile02" }
  ]
}
```

## 用生成的 JSON 渲染

把附件内容作为 `script` 提交给同一个 host：

```sh
curl -sS -X POST http://127.0.0.1:9881/api/v1/render \
  -H 'Content-Type: application/json' \
  -d '{"script": <附件 JSON>, "tts": true}'
```

异步调用加 `"wait": false`，然后轮询 `GET /api/v1/tasks/:id`，完成后从
`GET /api/v1/download/<file>` 取 MP4。详细的渲染参数、TTS 音色和部署说明见
[ournotes-render 文档](https://github.com/yonglanws/ournotes-render/blob/main/docs/host.md)。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| `宿主还不能生成剧本（HTTP 503）` | host 的 `paths.site` 是否指向 nnnotes 产品站点，`llm` 是否启用并有密钥 |
| `宿主鉴权失败（HTTP 401/403）` | 插件 `api_key` 是否与 host 的 `security.apiKeyEnv` 环境变量一致 |
| `无法连接 ournotes-render` | `api_base` 是否正确；从 AstrBot 所在机器执行 `curl <api_base>/api/v1/health` |
| 生成超时 | 提高 `timeout_seconds`；确认 LLM 端点和模型正常 |
| 只有文字没有附件 | 平台不支持文件消息，或 `send_json_file` 关闭；插件会回退为文本预览 |
| 指令没有反应 | 检查插件是否加载、指令权限是否被 Dashboard 的动态配置限制；日志中搜索 `[ournotes]` |
| 剧本里没有动作/镜头 | 预览的 `include_directions` 被关闭；JSON 附件始终包含完整演出 |

## 安全

- `api_key` 保存在 AstrBot 的插件配置里，不要把它提交到 Git。
- host 默认只监听 `127.0.0.1`。跨机器访问时，建议只在内网开放，并给 host 设置
  `security.apiKeyEnv` 对应的令牌。
- 插件不接受用户提供的 host 地址；`api_base` 只来自管理员配置。

## 许可

本插件是 ournotes-render 的一部分，遵循 AGPL-3.0-only（见 [LICENSE](LICENSE) 与
[LICENSE-EXCEPTION](LICENSE-EXCEPTION)）。
