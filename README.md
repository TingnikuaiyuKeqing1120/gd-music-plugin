# GD音乐台 · MyGo Music 音源插件

把 [GD音乐台](https://music.gdstudio.xyz/) 接进 [MyGo Music](https://github.com/egoist/mygo-music) 的音源插件。**纯 JavaScript，无辅助程序、无需浏览器**：直接调用 GD Studio 的[官方开发者 API](https://music-api.gdstudio.xyz/api.php)。

> **出处与许可**：本插件使用 GD音乐台 (music.gdstudio.xyz) 的开发者 API，该 API 以 **CC BY-NC 4.0** 提供——**仅限学习、非商用**，使用时请注明出处「GD音乐台 (music.gdstudio.xyz)」。插件代码本身为 MIT。请遵守 API 与各自音源服务的条款，非商用、尊重作者。

## 版本选择
- **V1（[v1.0.0](https://github.com/TingnikuaiyuKeqing1120/gd-music-plugin/releases/tag/v1.0.0)）**：功能更稳定、全面、可靠，自带离线缓存与封面懒加载。**若不介意使用 helper（需本机装有 Chrome/Edge），推荐 V1。**
- **V2（当前 main / [v2.0.0](https://github.com/TingnikuaiyuKeqing1120/gd-music-plugin/releases/tag/v2.0.0)）**：纯 JS、零依赖、最轻量；但时长需播放一次后回填、首搜个别封面可能暂缺、离线播放交给 App。

## 功能
- 搜索歌曲（音源可选；当前稳定可用 netease / joox / bilibili）
- 在线播放，音质可选（标准 128k / 高 320k / 无损）
- 歌词（含翻译）
- 喜欢、歌单（创建 / 改名 / 删除 / 增删 / 排序）——**存在本机**，GD 无账号接口，换机不同步
- 听歌历史、最近播放
- 封面渐进补齐：解析结果持久缓存，列表先出、封面随后

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

## 开发者 API 约束（已内置应对）
- **限频 5 分钟 50 次**：所有请求经令牌桶节流；封面解析结果持久缓存，重复不耗额度。
- **封面**：`types=pic` 仅 300/500，取 500；搜索先回列表，未缓存封面并发限时补齐，超时留默认封面、下次渲染再补。
- **时长**：开发者 API 搜索不返回时长，行内时长暂显未知（播放后 App 自知）。
- **size**：接口返回字节数。

## 隐私
- 喜欢、歌单、历史、封面缓存都只存**本机**（`host.storage`），不上传、无账号。
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