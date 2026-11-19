# 智博X PC

一个 Electron 桌面客户端，自带**自研播放内核**与**离线缓存**，不依赖浏览器外壳、不依赖 ffmpeg、不依赖 hls.js 作为唯一播放通路。

> 说明：本项目是非官方的第三方客户端，用于个人学习场景下访问自己的课程。仓库不含任何账号、票据、Cookie 或个人信息。

---

## 下载

**[最新版本 v1.9.0](https://github.com/SSenjiahui/zhibox-pc/releases/latest)**

| 文件 | 说明 |
| --- | --- |
| [ZhiboX-1.9.0-portable-x64.exe](https://github.com/SSenjiahui/zhibox-pc/releases/download/v1.9.0/ZhiboX-1.9.0-portable-x64.exe) | 便携版，免安装，双击即用（数据解包到临时目录，退出后清理） |
| [ZhiboX-1.9.0-setup-x64.exe](https://github.com/SSenjiahui/zhibox-pc/releases/download/v1.9.0/ZhiboX-1.9.0-setup-x64.exe) | 安装版，可选安装路径，建桌面与开始菜单快捷方式 |

Windows x64，未做代码签名，首次运行 SmartScreen 可能提示「未知发布者」，选「更多信息 → 仍要运行」即可。

> 本仓库不含任何账号、票据、Cookie 或个人信息。首次启动需你自己登录，登录态只存本机 `state/session.json`。

---

## 它和"网页套壳"的区别

常见套壳做法是把网页塞进 `<webview>`，或用 `<video>` + hls.js 直接吃 HLS。本项目把整条媒体链路自己实现了：

```
远端加密 HLS
   │  ① 拉 m3u8 / 分片（自带并发闸门 + 离线开关）
   ▼
AES-128 解密（IV / key 全在本地处理）
   ▼
明文 MPEG-TS
   │  ② 自研解复用：PAT/PMT → PES → H.264 Annex-B / ADTS AAC
   ▼
   ├── ③ fMP4 封装器（fmp4.js）──────► MSE `appendBuffer` 边下边播
   └── ④ MP4 封装器（ts2mp4.js）─────► 落盘成可离线播放的 .mp4
                                          │
                                          ▼
                                  自定义协议 zbfile:// 回放
```

- ③ 与 ④ 都只用 Node 内置模块（`fs` / `Buffer` / `crypto`），**零第三方媒体依赖**。
- 播放侧是手写的 MSE 播放器（`kernel-player.js`），自己管 SourceBuffer 水位、缓冲回收、seek 重建、播放完毕回拖。

## 目录结构

```
src/
  main.js                 主进程：窗口 / 托盘 / 单实例 / IPC / 自定义协议 / 自检
  preload.js              contextBridge 暴露面（渲染进程无 Node）
  core/
    config.js             服务端地址与应用标识（全部可用环境变量覆盖）
    auth.js               登录（密码 / 短信验证码）、票据归一化、自动登录、探测
    api.js                业务 API + 内存缓存 + 断网兜底 + 登录失效广播
    vod.js                播放签名 → 播放信息 → m3u8 → key → 明文 TS
    net.js                统一 HTTP 层：并发闸门 / 重试 / 重定向 / 解压 / 离线开关
    fmp4.js               ★ TS → fMP4（moof + mdat），零依赖
    ts2mp4.js             ★ TS → MP4（mdat + moov），零依赖
    hls-server.js         本机流服务：/hls 明文 TS、/fmp4 分片、离线会话
    kernel.js             内核门面：boot / openLesson / 下载 / 封装 / 进度 / 状态
    downloader.js         任务队列：并发下载 + 自动封装
    library.js            离线库：元数据、扫描、容量治理、回收站
    settings.js           16 项设置及其作用点
    store.js              原子写 JSON 存储
    logger.js             常驻滚动日志（按天分文件，UI 内可看）
    paths.js              数据根探测（便携 / 受限令牌 / 任意盘符）
  renderer/
    index.html            界面骨架
    app.js                业务界面：课程 / 目录 / 播放器 / 离线库 / 下载 / 设置 / 日志
    kernel-player.js      ★ 手写 MSE 播放器，零依赖
    style.css
launcher/main.go          Go 启动器：选可写数据目录并拉起 Electron 主体
build.js                  两步打包：--dir → 换入口为 launcher → --prepackaged
```

★ 标记的是三块可独立复用的媒体实现，不依赖本项目的其它部分（`fmp4.js`、`kernel-player.js` 零 `require`）。

## 功能

| 模块 | 内容 |
| --- | --- |
| 登录 | 密码登录 / 短信验证码登录 / 游客模式；票据自动归一化，旧会话可自愈 |
| 选课 | 课程列表、分类筛选、分页、推荐位、横幅轮播、课程名/老师搜索 |
| 我的课程 | 套课按子科目分组、科目筛选条、组内折叠、进度百分比、课程搜索 |
| 播放 | 在线（本机 fMP4 流）、离线（分片回放）、本地（MP4 直读）三条通路 |
| 续播 | 课程详情页顶部的「继续学习」条，自动定位到进度最新且未看完的课时 |
| 目录 | 课时搜索（名称/序号）、详情页滚动位置记忆 |
| 字幕 | 服务端 WebVTT 轨，逐句上屏；CC 按钮开关，Shift+点击切字号 |
| 离线库 | 整课缓存、单节缓存、自动封装 MP4、容量上限、回收站、一键清理、**多选批量删除** |
| 下载 | 任务队列、并发可调、暂停/继续/取消、托盘显示计数 |
| 设置 | 网络并发 / 队列并发 / 分片并发 / 自动封装 / 缓存上限 / 倍速 / 画质 / 音量 / 托盘 / 通知 / 防休眠 |
| 桌面 | 托盘常驻、关闭最小化、全局唤起快捷键、单实例、下载完成通知 |
| 日志 | 按天滚动、级别过滤、UI 内实时查看、一键打开日志目录 |

## 开发

需要 Node.js 18+ 与 Electron 31。

```bash
npm install
npm start                 # 直接以开发模式启动
```

### 打包

```bash
npm run dist              # 只出 win-unpacked
node build.js             # 完整两步：win-unpacked → 换入口为 Go launcher → nsis + portable
```

产物在 `dist/`。构建期缓存与临时目录都在工程内的 `.cache/`，不写系统临时目录。

`launcher/main.go` 是可选的：它负责在受限令牌 / 便携解包目录下挑一个真正可写的数据根，再拉起 Electron 主体，自身住留到主体退出（NSIS 便携 stub 会跟随入口进程生命周期清理解包目录，必须有人在中间等着）。不编译 launcher 也能跑，只是数据根会退回 Electron 默认逻辑。

```bash
cd launcher && go build -ldflags "-s -w" -o zhibo-launcher.exe .
```

## 配置

`src/core/config.js` 里的三个值都可以用环境变量覆盖，换后端不用改代码：

| 环境变量 | 含义 |
| --- | --- |
| `ZHIBO_API_BASE` | 业务 API 根地址 |
| `ZHIBO_APP_TOKEN` | 客户端应用标识（公开常量，非账号票据） |
| `ZHIBO_IMAGE_REFERER` | 图片请求的 Referer |

运行时环境变量：

| 环境变量 | 含义 |
| --- | --- |
| `ZB_DATA_DIR` | 强制指定数据根（日志 / 会话 / 离线库都在它下面） |

## 自检

主进程内置一套端到端自检，覆盖启动、登录态、内核分片、MSE 真播、UI 真播、下载、封装、离线播放、自定义协议、进度、设置、托盘、窗口唤起等 39 步：

```bash
ZB_SELFTEST=/tmp/report.json ZB_DATA_DIR=/tmp/zbdata npx electron . --no-sandbox
```

未登录时，依赖账号的步骤会被显式记为 `skipped`（`ok: null`），不会冒充通过。

## 数据根

按以下顺序探测第一个真正可写的目录，全部失败时退化为纯内存态：

`ZB_DATA_DIR` → `%LOCALAPPDATA%/ZhiboX` → `%APPDATA%/ZhiboX` → `<exe 目录>/data` → `<cwd>/ZhiboXData` → `<tmp>/ZhiboX` → 其它盘符 `X:/ZhiboXData`

数据根下分 `logs/`、`state/`、`library/`、`cache/`、`tmp/`。

## 第三方

- [Electron](https://www.electronjs.org/) — MIT
- [hls.js](https://github.com/video-dev/hls.js) — Apache-2.0（仅作为兜底通路，内核不可用时才会用到）

## 许可

MIT，见 [LICENSE](LICENSE)。
