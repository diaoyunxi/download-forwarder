# Download Forwarder

浏览器扩展，捕获下载请求并转发到本地下载管理器（wget / curl / IDM / NDM / Gopeed / ffmpeg / aria2c）。

> 当前版本：**v1.9.0**

## 架构

```
浏览器下载 → 扩展(拦截) → POST http://127.0.0.1:18735/download → 本地Python服务器 → 外部下载程序
```

## 安装

### 1. 启动本地服务器

```bash
python server/setup.py
```

此脚本会：
- 切换 pip 到清华源（如未配置）
- 检查并安装依赖
- 添加开机自启（Windows 注册表 / Linux systemd/crontab / macOS LaunchAgent）
- 启动本地服务器

### 2. 安装浏览器扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目根目录

### 3. 使用

点击扩展图标：
- 绿色「已连接」表示本地服务器运行正常
- 切换开关启用下载捕获
- 选择下载管理器（wget / curl / IDM / NDM / Gopeed / ffmpeg / aria2c）
- 可添加额外参数
- 「主面板」支持单 URL 转发、批量转发（开关切换）、文件大小预检
- 「嗅探」标签页可扫描当前页面的可下载链接并批量转发
- 「规则」标签页可启用自动分类，按扩展名归档到子文件夹
- 「任务」标签页（v1.9.0）可查看服务器上正在运行和最近完成的下载任务，支持单个或批量取消
- 「高级」标签页可配置 Bearer Token 鉴权（v1.9.0）、查看服务器日志、备份 / 恢复设置
- 快捷键：`Alt+Shift+D` 切换拦截 / `Alt+Shift+F` 转发当前页 / 嗅探命令可在 `chrome://extensions/shortcuts` 自定义

## 功能特性

### 基础功能
- 自动拦截浏览器下载，转发到本地下载管理器
- 支持 7 个下载器：wget / curl / Gopeed / IDM / NDM / ffmpeg / aria2c
- 服务器端检测可用程序
- 失败自动重试（默认 3 次）
- 下载历史记录与统计（总计 / 成功 / 失败 / 按程序分类）
- 导出历史为 JSON / CSV

### v1.9.0 新增功能
- **aria2c 多连接下载**：新增 `aria2c` 作为第 7 个下载器。服务端 `_build_command` 为 aria2c 生成 `aria2c -c -x16 -s16 -k1M --file-allocation=none --console-log-level=error --summary-interval=0 -d <dir> [-o <name>] [--max-download-limit=<speed>k] [--header=Cookie: ...] [--header=Key: Value] [--all-proxy=<proxy>] <url>` 命令，支持 16 路并发连接、断点续传、自动转发 Cookie / 自定义请求头 / 代理。适用于大文件高速下载
- **活动任务追踪与管理**：服务端新增进程级任务注册表，每个下载子进程启动后注册到 `_tasks` 字典并由 daemon watcher 线程监控。扩展新增「任务」标签页，可查看所有运行中 / 已完成 / 失败 / 已取消的任务（含 PID、开始 / 结束时间、退出码），可单个或批量取消正在运行的任务（POSIX 下通过 `os.killpg` 终止整个进程组，Windows 下通过 `taskkill /T /F` 终止进程树）。已完成任务 30 分钟后自动清理
- **Bearer Token 鉴权**：新增可选的 Bearer Token 访问鉴权。在「高级」标签页设置令牌后，扩展与服务器之间的所有请求（除 `/ping` 和 OPTIONS 外）都需要携带 `Authorization: Bearer <token>` 头部。留空则关闭鉴权（默认，向后兼容）。令牌同时保存到扩展和服务器配置中，支持 `?token=...` 查询参数备用通道
- **ThreadingHTTPServer 并发处理**：服务器从单线程 `HTTPServer` 升级为 `ThreadingHTTPServer`，并发请求不再互相阻塞。`daemon_threads = True` 确保主进程退出时所有工作线程自动终止
- **macOS LaunchAgent 自启动**：`setup.py` 新增 macOS 平台的 LaunchAgent 自启动支持。在 `~/Library/LaunchAgents/` 下创建 `com.github.diaoyunxi.download-forwarder.plist`，支持 `KeepAlive`（进程退出后自动重启）和 `RunAtLoad`（加载时立即启动），并重定向标准输出 / 错误到日志文件
- **新增端点**：`GET /tasks`（获取活动任务列表）、`POST /cancel`（取消一个或多个任务）
- **新增配置项**：`auth_token`（可选 Bearer 令牌）

### v1.8.0 新增功能
- **M3U8 / HLS / DASH 流媒体下载**：新增 `ffmpeg` 作为第 6 个下载器。服务端 `is_stream_url()` 识别 `.m3u8` / `.m3u` / `.mpd`；`_build_command` 为 ffmpeg 生成 `ffmpeg -y -hide_banner -loglevel error -i <url> -c copy <out>` 命令，自动转发 Cookie / 自定义请求头（经 `-headers`，对 HLS 分片请求同样生效），无文件名时按流类型回退为 `stream.ts` / `stream.mp4`
- **流媒体自动路由**：新增「流媒体自动用 ffmpeg」开关（规则标签页，默认开启）。启用后服务端在 `/download` 与 `/batch` 中检测到流媒体 URL 且 ffmpeg 已安装时，自动从当前下载器切换到 ffmpeg，无需手动切换；可通过 `auto_ffmpeg_streams` 配置项关闭
- **历史记录重试**：历史面板每条记录新增「重试」按钮，一键通过 `manual-forward` 路径重新提交该 URL；另提供「重试全部失败」按钮，批量重试当前历史中所有失败记录并汇总成功 / 失败数
- **历史记录高级筛选**：历史面板新增状态筛选 chip（全部 / 成功 / 失败，带实时计数）、下载器筛选下拉、分类筛选下拉，可与原有文本搜索叠加；筛选状态下下拉选项随历史数据自动更新并保留当前选择
- **三态主题（跟随系统）**：主题按钮由原深 / 浅二态扩展为 **浅色 → 深色 → 跟随系统 → 浅色** 三态循环。「跟随系统」模式通过 `window.matchMedia('(prefers-color-scheme: dark)')` 实时监听 OS 主题变化；存储字段由 `darkMode: boolean` 迁移为 `themeMode: "light"|"dark"|"auto"`，并兼容旧备份（自动迁移）
- **重复下载提醒**：扩展后台在转发前扫描本地最近历史，若 URL 在可配置时间窗口内（默认 30 分钟）已下载过，弹出额外提醒通知（不阻断下载）。自动拦截 / 手动转发 / 批量转发 / 右键 / 快捷键 均生效；批量转发时合并为单条汇总提醒。可在「网络」标签页关闭或调整窗口时长（0~1440 分钟，0 = 关闭）

### v1.7.0 新增功能
- **批量下载**：弹窗「手动 / 批量转发」卡片新增批量模式开关，可在文本框中粘贴多行 URL（每行一个，`#` 开头的行视为注释）一次性提交。服务端新增 `POST /batch` 端点统一处理，自动去重、记录每条结果并返回汇总（成功 / 失败 / 总数）
- **文件大小预检**：单 URL 模式新增「预检」按钮，通过服务端 `GET /check?url=...` 向目标发起 HEAD 请求（被拒绝时自动回退到 0 字节 Range GET），返回文件名 / 大小（人类可读）/ Content-Type / 是否重定向等信息，便于在下载前确认目标
- **页面链接嗅探**：新增「嗅探」标签页和 `content.js` 内容脚本，扫描当前标签页中所有可下载链接（带文件扩展名、`download` 属性或匹配下载路径特征的 `<a>` / `<img>` / `<video>` / `<audio>` / `<source>` / `<embed>`）。支持过滤、全选 / 清空、勾选后批量转发。还注册了 `sniff-links` 键盘命令（可在 `chrome://extensions/shortcuts` 自定义按键），一键嗅探并批量转发当前页全部链接
- **自动分类归档**：新增「自动分类」开关与可视化规则编辑器（位于「规则」标签页）。启用后按文件扩展名自动将下载归入下载目录下的子文件夹（默认提供 Documents / Archives / Video / Audio / Images / Software 六类，可自由编辑、恢复默认）。规则在浏览器端编辑后同步到服务端，`/download` 和 `/batch` 两条路径均生效
- **新增端点**：`GET /check`、`POST /batch`
- **新增权限**：`scripting`（用于在未注入内容脚本的页面动态注入以支持嗅探）
- **新增内容脚本**：`content.js`（在所有页面注入，监听 `sniff-links` 消息）
- **历史记录增强**：每条历史记录新增 `category` 字段，标注本次下载被归入的分类（若有）

### v1.6.0 新增功能
- **Cookie 转发**：自动捕获浏览器中当前站点的登录 Cookie 并转发给下载器（wget / curl），支持需要登录认证的下载。可在「网络」标签页开关
- **自定义请求头**：可配置 `Referer` 与 `User-Agent`。自动拦截时默认使用来源标签页的 URL 作为 Referer；许多站点要求正确的 Referer / UA 才允许下载
- **HTTP / HTTPS 代理**：可为 wget / curl 设置代理（支持 http / socks5），同时通过命令行参数与环境变量双通道下发，兼容性最佳
- **URL 规则管理 UI**：在「规则」标签页可视化管理「按站点指定下载器」的正则规则（服务端早已支持，现在有了图形界面）。匹配规则的 URL 会自动切换到对应下载器，优先级高于默认选择
- **通知偏好**：可静音所有通知声音、或仅保留失败通知，减少打扰
- **新增「网络」标签页**：集中管理 Cookie / 请求头 / 代理 / 通知偏好
- **修复**：弹窗「关于」面板版本号显示与实际版本不同步的问题

### v1.5.0 新增功能
- **自动更新检查**：扩展安装/更新时以及每 24 小时（通过 `chrome.alarms`）自动检查 GitHub 上的最新版本。优先调用 GitHub Releases API，失败时回退到 Tags API；发现新版本时弹出系统通知提示用户更新，点击通知即可在浏览器新标签页打开 GitHub Releases 页面下载最新版本

### v1.4.0 新增功能
- **右键菜单**：在链接 / 图片 / 视频 / 页面上右键，选择「转发到下载管理器」即可绕过拦截开关强制下载
- **键盘快捷键**：
  - `Alt+Shift+D` — 切换下载拦截开关
  - `Alt+Shift+F` — 转发当前页面到下载管理器
- **工具栏徽章**：实时显示活跃下载数量；服务器断开时显示红色 `!`
- **深色模式**：弹窗右上角月亮图标切换主题，自动持久化
- **URL 白名单**：仅拦截匹配白名单规则的站点（与黑名单互不冲突，可叠加使用）
- **手动转发**：弹窗内直接粘贴 URL 提交下载，不依赖拦截开关
- **历史搜索**：按 URL 或文件名实时过滤历史记录
- **服务器日志查看器**：弹窗「高级」标签页查看服务器最近日志
- **设置备份与恢复**：一键导出 / 导入扩展 + 服务器配置（JSON 格式），便于跨设备迁移
- **恢复默认**：清除扩展自定义设置并重置服务器配置
- **关于面板**：显示扩展版本、服务器版本、平台与可用程序
- **来源标记**：每条历史记录标注来源（auto / manual / context-menu / shortcut）
- **服务端过滤**：白名单 / 黑名单 / 文件类型过滤同时在浏览器与服务器两侧生效（手动转发可绕过）
- **标签页 UI**：弹窗内容拆分为「主面板 / 规则 / 历史 / 高级」四个标签页

### 早期版本
- v1.9.0：aria2c 多连接下载、活动任务追踪与管理、Bearer Token 鉴权、ThreadingHTTPServer 并发、macOS LaunchAgent 自启动
- v1.8.0：ffmpeg 流媒体下载、流媒体自动路由、历史重试与高级筛选、三态主题（跟随系统）、重复下载提醒
- v1.7.0：批量下载、文件大小预检、页面链接嗅探、自动分类归档
- v1.6.0：Cookie 转发、自定义请求头、代理、URL 规则 UI、通知偏好、网络标签页
- v1.5.0：自动更新检查
- v1.4.0：右键菜单、键盘快捷键、工具栏徽章、深色模式、URL 白名单、手动转发、历史搜索、服务器日志查看器、设置备份与恢复、关于面板、来源标记、服务端过滤、标签页 UI
- v1.3.0：文件类型过滤、URL 黑名单、并发与速度限制
- v1.2.0：下载目录配置、URL 规则匹配
- v1.1.0：下载统计与按程序分类
- v1.0.0：初始版本，支持基本转发

## 支持的平台

- Windows (IDM / NDM / wget / curl / ffmpeg / aria2c)
- Linux (wget / curl / Gopeed / ffmpeg / aria2c)
- macOS (wget / curl / ffmpeg / aria2c)

## 本地服务器 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/ping` | 健康检查，返回版本、平台、可用程序、`auth_required` 字段（v1.9.0） |
| GET | `/config` | 获取服务器配置（v1.8.0 起含 `auto_ffmpeg_streams`；v1.9.0 起含 `auth_enabled`，不回传 `auth_token`） |
| POST | `/config` | 更新服务器配置（部分字段，v1.9.0 起支持 `auth_token`） |
| POST | `/config/reset` | 重置服务器配置为默认值 |
| POST | `/download` | 提交下载任务（支持 `cookies` / `headers` / `proxy` 字段，v1.6.0；自动分类 v1.7.0；流媒体自动路由至 ffmpeg，v1.8.0；aria2c 下载器，v1.9.0） |
| POST | `/batch` | 批量提交下载任务（v1.7.0，请求体含 `urls` 数组；v1.8.0 起流媒体自动路由至 ffmpeg） |
| GET | `/tasks` | 获取活动任务列表（v1.9.0，返回运行中 / 最近完成的任务及其状态） |
| POST | `/cancel` | 取消一个或多个下载任务（v1.9.0，请求体含 `task_id` 或 `task_ids` 数组） |
| GET | `/check?url=...` | 预检文件大小 / 文件名 / 类型（v1.7.0，HEAD 失败自动回退 Range GET） |
| GET | `/history` | 获取下载历史（v1.7.0 起每条记录含 `category` 字段） |
| POST | `/history/clear` | 清空下载历史 |
| GET | `/stats` | 获取下载统计 |
| GET | `/logs?limit=N` | 获取最近 N 条服务器日志（1-500，默认 50） |
| GET | `/export?format=json\|csv` | 导出历史 |

> v1.9.0：当 `auth_token` 配置非空时，除 `/ping` 和 OPTIONS 外的所有端点都需要 `Authorization: Bearer <token>` 头部（或 `?token=...` 查询参数）。

### `/download` 请求体（v1.6.0）

```json
{
  "url": "https://example.com/file.zip",
  "filename": "file.zip",
  "program": "wget",
  "arguments": "-c",
  "speed_limit": 0,
  "concurrent_limit": 5,
  "manual": false,
  "source": "auto",
  "cookies": "session=abc; token=xyz",
  "headers": { "Referer": "https://example.com", "User-Agent": "Mozilla/5.0 ..." },
  "proxy": "http://127.0.0.1:7890"
}
```

> `cookies` / `headers` / `proxy` 由浏览器扩展自动捕获并下发；直接调用 API 时如未提供，服务器会回退到自身配置中的 `proxy_url` / `custom_referer` / `custom_user_agent`。

> v1.8.0：`program` 可选值新增 `ffmpeg`（适合 M3U8 / HLS / DASH 流媒体）。当配置 `auto_ffmpeg_streams=true`（默认）且 URL 为 `.m3u8` / `.m3u` / `.mpd`、且 ffmpeg 已安装时，服务端会自动改用 ffmpeg，无需在请求中显式指定。

> v1.9.0：`program` 可选值新增 `aria2c`（多连接高速下载）。aria2c 支持 16 路并发连接（`-x16 -s16`）、断点续传（`-c`）、自动转发 Cookie / 自定义请求头 / 代理。下载响应中新增 `task_id` 和 `pid` 字段，可用于后续取消。

### `/batch` 请求体（v1.7.0）

```json
{
  "urls": [
    "https://example.com/file1.zip",
    "https://example.com/file2.pdf"
  ],
  "program": "wget",
  "arguments": "-c",
  "speed_limit": 0,
  "concurrent_limit": 5,
  "manual": true,
  "source": "batch",
  "cookies": "session=abc; token=xyz",
  "headers": { "Referer": "https://example.com", "User-Agent": "Mozilla/5.0 ..." },
  "proxy": "http://127.0.0.1:7890"
}
```

响应：

```json
{
  "status": "ok",
  "total": 2,
  "success": 2,
  "failed": 0,
  "results": [
    { "url": "https://example.com/file1.zip", "status": "success", "message": "Download started via wget", "program": "wget", "filename": "file1.zip" },
    { "url": "https://example.com/file2.pdf", "status": "success", "message": "Download started via wget", "program": "wget", "filename": "file2.pdf" }
  ]
}
```

### `/check` 响应（v1.7.0）

```
GET /check?url=https://example.com/file.zip
```

```json
{
  "status": "ok",
  "url": "https://example.com/file.zip",
  "final_url": "https://cdn.example.com/real-file.zip",
  "filename": "real-file.zip",
  "size": 1048576,
  "size_human": "1.00 MB",
  "content_type": "application/zip",
  "redirected": true
}
```

### `/tasks` 响应（v1.9.0）

```
GET /tasks
```

```json
{
  "status": "ok",
  "tasks": [
    {
      "task_id": "a1b2c3d4e5f6",
      "pid": 12345,
      "url": "https://example.com/large-file.zip",
      "program": "aria2c",
      "filename": "large-file.zip",
      "source": "auto",
      "started_at": "2026-07-02 14:30:00",
      "started_ts": 1782933000.0,
      "status": "running",
      "ended_at": "",
      "ended_ts": 0.0,
      "exit_code": null
    }
  ]
}
```

### `/cancel` 请求与响应（v1.9.0）

```
POST /cancel
```

请求体（支持单个或批量）：

```json
{
  "task_ids": ["a1b2c3d4e5f6", "b2c3d4e5f6g7"]
}
```

或单个任务：

```json
{
  "task_id": "a1b2c3d4e5f6"
}
```

响应：

```json
{
  "status": "ok",
  "cancelled": 2,
  "failed": 0,
  "results": [
    { "task_id": "a1b2c3d4e5f6", "ok": true, "message": "cancelled" },
    { "task_id": "b2c3d4e5f6g7", "ok": true, "message": "cancelled" }
  ]
}
```

## 文件结构

```
├── manifest.json          # 扩展配置（v1.9.0，新增 aria2c 下载器描述、Bearer Token 鉴权；v1.8.0 ffmpeg；v1.7.0 scripting 权限、content_scripts、sniff-links 命令）
├── background.js          # 后台服务（拦截 + 转发 + 右键菜单 + 快捷键 + 徽章 + Cookie 捕获 + 自动更新 + 批量 / 预检 / 嗅探 + v1.8.0 重复下载提醒 + v1.9.0 任务管理 / token 注入）
├── content.js             # 内容脚本（v1.7.0 页面链接嗅探；v1.8.0 嗅探列表扩展 .m3u8/.m3u/.mpd）
├── popup.html             # 弹出界面（标签页 + 三态主题 + 模态框 + 网络面板 + 嗅探面板 + 批量 / 预检 / 分类 + v1.8.0 历史筛选 / 重试 / 重复提醒 / ffmpeg 按钮 / 自动流媒体开关 + v1.9.0 任务面板 / token 配置 / aria2 按钮）
├── popup.js               # 界面逻辑（含备份/恢复、日志查看、搜索、URL 规则管理、批量 / 预检 / 嗅探 / 自动分类 + v1.8.0 主题三态、历史筛选与重试、ffmpeg / 自动流媒体、重复提醒同步 + v1.9.0 任务列表渲染 / 取消、token 配置、postJSON 鉴权封装）
├── icons/                 # 扩展图标
├── server/
│   ├── setup.py           # 安装脚本（v1.9.0 新增 macOS LaunchAgent 自启动；Windows 注册表 / Linux systemd/crontab；runpy 启动服务器）
│   └── server.py          # 本地 HTTP 服务器（v1.9.0，新增 aria2c 下载器、ThreadingHTTPServer、Bearer Token 鉴权、任务追踪与取消、/tasks 和 /cancel 端点；v1.8.0 ffmpeg、流媒体自动路由；v1.7.0 /check、/batch 端点与自动分类）
└── README.md
```
