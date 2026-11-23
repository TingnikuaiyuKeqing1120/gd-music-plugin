# GD音乐台 · MyGo Music 音源插件

把 GD音乐台接进 MyGo Music 的音源插件。V2 使用纯 JavaScript，提供开发者 API、国内网页和国际网页三种服务线路，支持歌曲搜索、播放、封面和歌词。[GD音乐台国际站](https://music.gdstudio.xyz/) · [国内站](https://music.gdstudio.org/) · [MyGo Music](https://github.com/egoist/mygo-music)

音源服务由 GD Studio 提供。可以到作者 B 站了解更新，也可以关注其开源的 Embeat 音乐推荐系统。[原作者 B 站 · GD-Studio](https://space.bilibili.com/13715770) · [Embeat · 基于声学特征的音乐推荐系统](https://github.com/gdstudio-org/Embeat)

> **出处与许可**：本插件使用 GD音乐台 (music.gdstudio.xyz) 的开发者 API，该 API 以 **CC BY-NC 4.0** 提供——**仅限学习、非商用**，使用时请注明出处「GD音乐台 (music.gdstudio.xyz)」。插件代码本身为 MIT。请遵守 API 与各自音源服务的条款，非商用、尊重作者。

## 版本选择

- **V2 当前版本为 2.2.0**。新增国内、国际网页实验线路，包含请求合并、限流退避、封面缓存更新与本地列表补图。[发布页](https://github.com/TingnikuaiyuKeqing1120/gd-music-plugin/releases/tag/v2.2.0)
- **V1 v1.0.0** 使用桌面 helper 与 Chrome/Edge/Chromium，提供网页接口字段、封面懒加载和插件离线缓存。当前网页接口与平台兼容性需要独立验证。[V1 发布页](https://github.com/TingnikuaiyuKeqing1120/gd-music-plugin/releases/tag/v1.0.0)

## 功能
- 搜索歌曲（音源可选；当前稳定可用 netease / joox / bilibili）
- 在线播放，音质可选（标准 128k / 高 320k / 无损）
- 歌词（含翻译）
- 喜欢、歌单（创建 / 改名 / 删除 / 增删 / 排序）保存于插件数据，MyGo Music Plus 开启插件数据同步后可跨端同步
- 听歌历史、最近播放
- 搜索、喜欢、歌单和历史页共用封面缓存，每次打开列表限时补齐缺图或刷新过期地址

离线播放交给 **App 自身**的歌曲缓存与下载管理器（设置 › 歌曲缓存 / 下载按钮 / 已下载页），插件不再自有离线层。

## 环境要求
- MyGo Music ≥ 0.1.20 可使用基础插件能力
- Android 网页线路、作者链接展示和线路设置仅在本设备保存，需要 MyGo Music Plus 0.5.3 及以上。播放器通过 `GDWebRequests`、`Info.links` 与 `sync.localSettings` 提供这些能力
- 普通浏览器 Web 版使用开发者 API，网页线路受站点 CORS 限制
- 无需 Chrome / Edge / Go / 任何二进制

## 安装
纯 JS 插件，仓库即插件本体：
- 在 MyGo Music「设置 › 插件」用 `+` 从 GitHub 仓库 `owner/gd-music-plugin` 安装；或
- 下载仓库 zip 后从文件夹安装；或
- 把本目录放进 App 的 plugins 目录。

插件网络权限覆盖 `music-api.gdstudio.xyz`、`music.gdstudio.xyz` 和 `music.gdstudio.org`。

## 设置项
| 键 | 说明 |
| --- | --- |
| `service` | 服务线路。空值使用开发者 API，`domestic` 使用国内网页，`international` 使用国际网页 |
| `source` | 搜索与播放使用的音乐平台。开发者 API 当前开放 netease / joox / bilibili，网页线路可以尝试其他平台 |

首次使用继续选择开发者 API，可在「设置 → 插件 → GD音乐台 → 服务线路」手动切换。切换作用于新的请求，搜索与封面缓存按线路区分，歌单、喜欢、历史和歌曲 ID 沿用已有数据。新播放器将线路作为设备本地设置保存，手机和电脑可以使用不同线路。[国内与国际线路调查](API-REQUESTS.md#国内与国际线路调查)

网页线路读取站点版本和服务器时间，在设备内计算公开网页使用的校验参数。初始化请求合并，版本和时钟偏差缓存 10 分钟，401 时在原请求期限内刷新一次并重试。元数据初始化也计入辅助请求预算。403/429 的等待状态由三条线路共用，保持明确的手动线路选择。

2026-11-23 在 Windows 插件宿主和 Android 15 模拟器完成了两条网页线路验证。模拟器通过两端取得同一网易云样本的搜索结果、封面、歌词与地址，且在应用内完成原生播放。其他平台音源、真实手机网络及长期稳定性仍待验证。

## 开发者 API 约束（已内置应对）

开发者接口与说明入口为下方链接，后续排查和接口确认从这里开始。2026-11-23 站方告知的参考额度为 **5 分钟 50 次请求**，实际额度可能动态调整，播放请求以服务端响应为准。[GD Studio 开发者 API](https://music-api.gdstudio.xyz/api.php)

| 功能 | 请求类型 | 主要参数 |
| --- | --- | --- |
| 搜索 | `types=search` | `source/name/count/pages` |
| 播放地址 | `types=url` | `source/id/br` |
| 封面 | `types=pic` | `source/id/size` |
| 歌词 | `types=lyric` | `source/id` |

- **辅助请求预算**采用持久化滚动窗口。5 分钟内已用次数达到 35 次时暂停封面补齐，达到 45 次时暂停搜索和歌词请求。播放地址在超过 50 次后继续尝试，收到服务端拒绝时按下述规则退避。重复的进行中请求合并，最近 10 页搜索结果缓存 2 分钟。
- **等待时间**由插件主动控制。普通 API 请求最多 15 秒，整次列表封面补齐最多 2.5 秒并发 3 路，超时会中止 HTTP 请求。宿主当前通过一次结果返回列表，缺图在再次打开列表时继续补齐。
- **服务器退避**识别 429 和 403，并读取 `Retry-After` 的秒数或 HTTP 日期。未提供该头时，429 默认等待 5 分钟，403 默认等待 1 分钟。403 提示保留“可能限流或站点访问限制”，具体原因仍需响应或站方确认。额度不足会直接显示建议等待秒数。
- **封面**先请求 500，仅在成功响应缺少 URL 时尝试 300。相同封面共用进行中的请求，URL 缓存 24 小时，失败退避至少 1 分钟，刷新暂时失败时继续使用已有 URL。
- **时长**优先读取带明确单位的 `duration_ms`，并兼容网页额外字段 `extra_data.duration` 的秒数。未知时长显示未知，由播放器解码后获知。旧估算值退出列表显示，歌单和收藏 ID 继续保留。
- **文件大小**仅把明确的 `size_bytes` 交给播放器。官方开发者文档标注 `size` 为 KB，换算基数和跨源一致性仍待确认，当前下载以 HTTP 响应和实际文件长度为依据。音质采用响应里的实际档位。

客户端计数覆盖本设备的插件请求。多设备、浏览器或其他客户端共享出口 IP 时，服务器可能更早限制请求。接口扩展需求与此前 V1/V2 调查保存在独立文档。[接口需求与对照](API-REQUESTS.md)

## 验证

以下测试使用 Node 内置测试框架和可控时钟，覆盖限频、超时取消、请求合并、缓存恢复和旧歌单数据读取。

```powershell
node --experimental-vm-modules --test tests/plugin.test.mjs
```

MyGo Music Plus 内置副本位于 `internal/app/bundled/gdstudio`，更新插件时同步 `index.js` 与 `plugin.json`，并运行播放器的插件宿主回归测试。

## 应用内更新

从 GitHub 仓库或播放器内置入口安装的插件，会保存仓库来源。播放器每 24 小时自动检查更新，发现新版本后，在「设置 → 插件」的 GD音乐台条目显示「更新至…」按钮。也可通过该条目的更多菜单手动检查更新。点击更新后下载并加载新版本，新增权限时会请求确认。

更新检查读取插件仓库的 GitHub Release。新版本发布后，已安装用户才能通过此入口获取该版本。手动复制或从本地文件夹安装的插件，需要带有正确的仓库来源记录才能自动检查。

## 隐私
- 喜欢、歌单和历史保存在 `host.storage`。MyGo Music Plus 的插件数据同步可将这些记录同步到用户配置的 GitHub 仓库。
- 封面缓存、旧时长估算和请求计数在清单的 `sync.localKeys` 中声明为设备本地数据。
- API 和网页请求按选定线路发送到 GD 的三个指定域名，音频与封面由 App 连接返回的资源地址。Android 网页请求通过设备自身网络栈执行。
- 开发者 API 使用普通 GET，网页线路校验使用公开的版本、时间和请求参数。

## 结构
```
plugin.json   插件清单（能力、导航、设置、网络权限）
index.js      插件逻辑（搜索/播放/歌词/喜欢/歌单/历史）
LICENSE       MIT
```

## 许可证
[MIT](LICENSE)。使用的 GD音乐台开发者 API 为 CC BY-NC 4.0（非商用、需署名），见顶部说明。
