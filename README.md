# Download Forwarder

浏览器扩展，捕获下载请求并转发到本地下载管理器（wget / curl / IDM / NDM / Gopeed）。

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
- 选择下载管理器（wget / curl / IDM / NDM）
- 可添加额外参数

## 支持的平台

- Windows (IDM / NDM / wget / curl)
- Linux (wget / curl / Gopeed)

## 文件结构

```
├── manifest.json          # 扩展配置
├── background.js          # 后台服务（拦截下载 + 转发）
├── popup.html             # 弹出界面
├── popup.js               # 界面逻辑
├── icons/                 # 扩展图标
├── server/
│   ├── setup.py           # 安装脚本（开机自启 + 启动服务器）
│   └── server.py          # 本地 HTTP 服务器
└── README.md
```