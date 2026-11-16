# GD音乐台 · MyGo Music 音源插件

把 [GD音乐台](https://music.gdstudio.xyz/) 接进 [MyGo Music](https://github.com/egoist/mygo-music) 的音源插件：搜索、播放、歌词、喜欢、歌单、听歌历史，以及加入歌单时自动离线缓存到本机。

> **免责声明**：本插件仅供学习与个人使用。它聚合第三方音源，可能涉及相关服务的使用条款与版权。请在下载、使用或分发前自行确认合规性，并尊重各音源服务的条款。使用者自担风险。

## 功能
- 搜索歌曲（12 个音源可选：网易云 / 酷我 / QQ / 咪咕 / 酷狗 / YouTube Music / JOOX / Tidal / Qobuz / Deezer / Spotify / Apple Music）
- 在线播放，音质可选（标准 128k / 高 320k / 无损 FLAC）
- 歌词（含翻译）
- 喜欢、歌单（创建 / 改名 / 删除 / 增删 / 排序）——**存在本机**，GD 无账号接口，换机不同步
- 听歌历史、最近播放
- 离线缓存：加入歌单时后台下载到本机，断网也能播；可设音质、可一键清空
- 封面渐进加载：列表先出，封面一张张补上

## 环境要求
- MyGo Music ≥ 0.1.20
- 本机装有 **Chrome、Edge 或 Chromium**（辅助程序 `gd-helper` 用无头浏览器在站点页面上下文内发请求，以通过站点的指纹校验；可用环境变量 `CHROME_PATH` 指定浏览器）
- 自行构建 helper 时需要 Go（版本见 `helper-src/go.mod`）

## 安装
**Windows（开箱即用）**：仓库已带 `bin/gd-helper.exe`。在 MyGo Music 的「设置 › 插件」里用 `+` 从 GitHub 仓库 `owner/gd-music-plugin` 安装，或下载本仓库 zip 后从文件夹安装。首次使用需在插件设置里允许它启动辅助程序。

**macOS / Linux**：下载对应平台的 release zip（`gd-music-plugin-darwin.zip` / `gd-music-plugin-linux.zip`），或自行构建 helper（见下）。

> 平台支持现状：helper 的浏览器自动发现已覆盖 Windows / macOS / Linux（含 Chromium，可用 `CHROME_PATH` 覆盖）。macOS / Linux 尚未真机验证，留待使用者反馈；Linux 若以 root 运行无头浏览器可能需自行加 `--no-sandbox`。

## 从源码构建 helper
```bash
# 本机平台
bash scripts/build.sh          # macOS / Linux / Git Bash
pwsh scripts/build.ps1         # Windows PowerShell

# 或手动
cd helper-src
go build -trimpath -ldflags "-s -w" -o ../bin/gd-helper.exe .   # Windows
go build -trimpath -ldflags "-s -w" -o ../bin/gd-helper .       # macOS / Linux
```
产物放进 `bin/`，文件名须为 `gd-helper.exe`（Windows）或 `gd-helper`（其它平台），与 `plugin.json` 的 `process` 权限 `bin/gd-helper*` 对应。

打 tag（`v*`）会触发 `.github/workflows/build.yml`，为三个平台构建 helper 并打包成各自的插件 zip 附到 release。

## 设置项
| 键 | 说明 |
| --- | --- |
| `source` | 搜索与播放使用的音源 |
| `autoOffline` | 加入歌单时自动离线缓存（默认开） |
| `offlineQuality` | 离线缓存音质（standard / high / lossless） |
| `clearOffline` | 打开后下次进「离线缓存」页清空一次（再清需先关再开） |

## 隐私
- 喜欢、歌单、历史、离线歌曲都只存在**本机**（插件的 `host.storage` 与 `dataDir/offline`），不上传、无账号。
- 辅助程序用临时浏览器配置目录，退出即删。
- 仓库源码不含任何密钥、cookie、token 或个人信息；站点地址为公开 URL，请求签名复用站点页面自带的 crc32。

## 结构
```
plugin.json          插件清单（能力、导航、设置、权限）
index.js             插件逻辑（搜索/播放/歌词/喜欢/歌单/历史/离线）
helper-src/          gd-helper 源码（Go + chromedp）
bin/                 辅助程序二进制（Windows 已带）
scripts/             本机构建脚本
.github/workflows/   跨平台构建与打包
```

## 发布前待办
- [x] 补全 `helper-src/main.go` 的 `findBrowser()`：macOS / Linux 的 Chrome/Edge/Chromium 路径（含 `CHROME_PATH` 覆盖）
- [x] 许可证：MIT（见 `LICENSE`）
- [x] 合规确认：GD Studio 方表示提供开发者 API、可自行调用（见下「后续改进」）
- [ ] macOS / Linux 真机验证（含 arm64）——留待使用者反馈

## 后续改进
GD Studio 方表示有**开发者 API**。改用官方开发者 API 可去掉无头浏览器这一层，更轻量也更稳妥；当前实现仍走站点页面上下文，作为过渡。

## 许可证
[MIT](LICENSE)。