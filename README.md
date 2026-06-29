# Download Forwarder

浏览器扩展，捕获下载请求并转发到本地下载管理器（wget / curl / IDM / NDM / Gopeed）。

> 当前版本：**v1.7.0**

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
- 添加开机自启（Windows 注册表 / Linux systemd）
- 启动本地服务器

### 2. 安装浏览器扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目根目录

### 3. 使用

点击扩展图标：
- 绿色「已连接」表示本地服务器运行正常
- 切换开关启用下载捕获
- 选择下载管理器（wget / curl / IDM / NDM / Gopeed）
- 可添加额外参数
- 「主面板」支持单 URL 转发、批量转发（开关切换）、文件大小预检
- 「嗅探」标签页可扫描当前页面的可下载链接并批量转发
- 「规则」标签页可启用自动分类，按扩展名归档到子文件夹
- 快捷键：`Alt+Shift+D` 切换拦截 / `Alt+Shift+F` 转发当前页 / 嗅探命令可在 `chrome://extensions/shortcuts` 自定义

## 功能特性

### 基础功能
- 自动拦截浏览器下载，转发到本地下载管理器
- 支持 5 个下载器：wget / curl / Gopeed / IDM / NDM
- 服务器端检测可用程序
- 失败自动重试（默认 3 次）
- 下载历史记录与统计（总计 / 成功 / 失败 / 按程序分类）
- 导出历史为 JSON / CSV

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
- v1.6.0：Cookie 转发、自定义请求头、代理、URL 规则 UI、通知偏好、网络标签页
- v1.5.0：自动更新检查
- v1.4.0：右键菜单、键盘快捷键、工具栏徽章、深色模式、URL 白名单、手动转发、历史搜索、服务器日志查看器、设置备份与恢复、关于面板、来源标记、服务端过滤、标签页 UI
- v1.3.0：文件类型过滤、URL 黑名单、并发与速度限制
- v1.2.0：下载目录配置、URL 规则匹配
- v1.1.0：下载统计与按程序分类
- v1.0.0：初始版本，支持基本转发

## 支持的平台

- Windows (IDM / NDM / wget / curl)
- Linux (wget / curl / Gopeed)

## 本地服务器 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/ping` | 健康检查，返回版本、平台、可用程序 |
| GET | `/config` | 获取服务器配置 |
| POST | `/config` | 更新服务器配置（部分字段） |
| POST | `/config/reset` | 重置服务器配置为默认值 |
| POST | `/download` | 提交下载任务（支持 `cookies` / `headers` / `proxy` 字段，v1.6.0；自动分类 v1.7.0） |
| POST | `/batch` | 批量提交下载任务（v1.7.0，请求体含 `urls` 数组） |
| GET | `/check?url=...` | 预检文件大小 / 文件名 / 类型（v1.7.0，HEAD 失败自动回退 Range GET） |
| GET | `/history` | 获取下载历史（v1.7.0 起每条记录含 `category` 字段） |
| POST | `/history/clear` | 清空下载历史 |
| GET | `/stats` | 获取下载统计 |
| GET | `/logs?limit=N` | 获取最近 N 条服务器日志（1-500，默认 50） |
| GET | `/export?format=json\|csv` | 导出历史 |

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

## 文件结构

```
├── manifest.json          # 扩展配置（v1.7.0，新增 scripting 权限、content_scripts、sniff-links 命令）
├── background.js          # 后台服务（拦截 + 转发 + 右键菜单 + 快捷键 + 徽章 + Cookie 捕获 + 自动更新 + 批量 / 预检 / 嗅探）
├── content.js             # 内容脚本（v1.7.0，页面链接嗅探）
├── popup.html             # 弹出界面（标签页 + 深色模式 + 模态框 + 网络面板 + 嗅探面板 + 批量 / 预检 / 分类）
├── popup.js               # 界面逻辑（含备份/恢复、日志查看、搜索、URL 规则管理、批量 / 预检 / 嗅探 / 自动分类）
├── icons/                 # 扩展图标
├── server/
│   ├── setup.py           # 安装脚本（开机自启 + 启动服务器）
│   └── server.py          # 本地 HTTP 服务器（v1.7.0，新增 /check、/batch 端点与自动分类）
└── README.md
```
