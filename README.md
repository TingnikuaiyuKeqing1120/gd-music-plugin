# GD音乐台 · MyGo Music 音源插件

把 GD音乐台接进 MyGo Music 的音源插件。V2 使用纯 JavaScript，通过 GD Studio 开发者 API 提供歌曲搜索、播放、封面和歌词。[GD音乐台](https://music.gdstudio.xyz/) · [MyGo Music](https://github.com/egoist/mygo-music)

> **出处与许可**：本插件使用 GD音乐台 (music.gdstudio.xyz) 的开发者 API，该 API 以 **CC BY-NC 4.0** 提供——**仅限学习、非商用**，使用时请注明出处「GD音乐台 (music.gdstudio.xyz)」。插件代码本身为 MIT。请遵守 API 与各自音源服务的条款，非商用、尊重作者。

## 版本选择

- **V2 当前源码为 2.1.0**。适用于桌面和 Android/Web，包含请求合并、限流退避、封面缓存更新与本地列表补图。正式发布版本可在 releases 页查看。[发布页](https://github.com/TingnikuaiyuKeqing1120/gd-music-plugin/releases)
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
- MyGo Music ≥ 0.1.20
- 无需 Chrome / Edge / Go / 任何二进制

## 安装
纯 JS 插件，仓库即插件本体：
- 在 MyGo Music「设置 › 插件」用 `+` 从 GitHub 仓库 `owner/gd-music-plugin` 安装；或
- 下载仓库 zip 后从文件夹安装；或
- 把本目录放进 App 的 plugins 目录。

首次使用需在插件设置里允许其网络权限（仅 `music-api.gdstudio.xyz`）。

## 设置项
| 键 | 说明 |
| --- | --- |
| `source` | 搜索与播放使用的音源（当前稳定：netease / joox / bilibili） |

当前插件服务入口为 `music-api.gdstudio.xyz`。国内网页已有网易云搜索与地址解析成功样本，其 `api.php` 带网页校验，兼容 V2 的国内开发者入口仍待站方确认。双线路接入建议和网站音源获取机制已记录在调查文档中。[国内与国际线路调查](API-REQUESTS.md#国内与国际线路调查)

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
- 网络权限仅指向 `music-api.gdstudio.xyz`；音频与封面由 App 直连各自 CDN。
- 仓库源码不含任何密钥、cookie、token 或个人信息；API 无签名、无密钥。

## 结构
```
plugin.json   插件清单（能力、导航、设置、网络权限）
index.js      插件逻辑（搜索/播放/歌词/喜欢/歌单/历史）
LICENSE       MIT
```

## 许可证
[MIT](LICENSE)。使用的 GD音乐台开发者 API 为 CC BY-NC 4.0（非商用、需署名），见顶部说明。
