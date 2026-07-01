#!/usr/bin/env python3
"""
Download Forwarder 本地服务器安装脚本。

功能：
1. 切换 pip 到清华镜像源
2. 检查并安装依赖（仅使用标准库，无需安装）
3. 添加开机自启条目（Windows 注册表 / Linux systemd/crontab / macOS LaunchAgent）
4. 启动本地服务器

v1.9.0 新增：
- macOS 平台 LaunchAgent 自启动支持
- 修正末尾 `exec(open(...).read())` 反模式，改用 runpy.run_path 在独立进程命名空间运行
"""

import os
import sys
import subprocess
import platform

SERVER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.py')
APP_NAME = 'DownloadForwarder'
SERVER_EXE = sys.executable

def switch_pip_to_tsinghua():
    """切换 pip 到清华镜像源"""
    print('[1/3] 检查 pip 镜像源...')
    try:
        import pip
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'config', 'get', 'global.index-url'],
            capture_output=True, text=True
        )
        if 'pypi.tuna.tsinghua.edu.cn' not in result.stdout:
            print('正在切换 pip 到清华镜像源...')
            subprocess.run(
                [sys.executable, '-m', 'pip', 'config', 'set', 'global.index-url',
                 'https://pypi.tuna.tsinghua.edu.cn/simple'],
                capture_output=True
            )
            print('pip 镜像源切换成功。')
        else:
            print('已使用清华镜像源。')
    except Exception as e:
        print(f'切换 pip 镜像源失败: {e}')

def install_dependencies():
    """检查并安装依赖（本项目无需安装外部依赖）"""
    print('[2/3] 检查依赖...')
    # 本项目仅使用标准库模块，无需 pip install
    print('无需外部依赖（仅使用标准库）。')

def setup_auto_start():
    """根据操作系统添加开机自启条目"""
    print('[3/3] 配置开机自启...')

    system = platform.system()
    if system == 'Windows':
        _setup_windows_auto_start()
    elif system == 'Linux':
        _setup_linux_auto_start()
    elif system == 'Darwin':
        # v1.9.0: macOS 通过 LaunchAgent 实现开机自启
        _setup_macos_auto_start()
    else:
        print(f'不支持的操作系统: {system}')

def _setup_windows_auto_start():
    """通过 Windows 注册表添加开机自启"""
    try:
        import winreg
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Run'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{SERVER_EXE}" "{SERVER_FILE}"')
        winreg.CloseKey(key)
        print('Windows 开机自启已添加（注册表）。')
    except ImportError:
        # 回退：使用 schtasks 创建计划任务
        cmd = f'schtasks /create /tn "{APP_NAME}" /tr "\"{SERVER_EXE}\" \"{SERVER_FILE}\"" /sc onlogon /rl limited'
        subprocess.run(cmd, shell=True, check=False)
        print('Windows 计划任务已创建。')
    except Exception as e:
        print(f'设置 Windows 开机自启失败: {e}')

def _setup_linux_auto_start():
    """在 Linux 上通过 systemd 用户服务实现开机自启"""
    service_content = f"""[Unit]
Description={APP_NAME} - Download Forwarder Local Server
After=network.target

[Service]
Type=simple
ExecStart={SERVER_EXE} {SERVER_FILE}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""
    service_name = 'download-forwarder.service'
    service_path = os.path.expanduser(f'~/.config/systemd/user/{service_name}')

    try:
        os.makedirs(os.path.dirname(service_path), exist_ok=True)
        with open(service_path, 'w') as f:
            f.write(service_content)

        # 重新加载并启用、启动服务
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=False)
        subprocess.run(['systemctl', '--user', 'enable', service_name], check=False)
        subprocess.run(['systemctl', '--user', 'start', service_name], check=False)
        print(f'Linux systemd 服务已创建: {service_path}')
        print('使用 systemctl --user status download-forwarder.service 查看状态。')
    except Exception as e:
        # 回退：添加到 crontab
        print(f'systemd 配置失败，回退到 crontab: {e}')
        cron_entry = f'@reboot {SERVER_EXE} {SERVER_FILE}\n'
        result = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
        current_cron = result.stdout if result.returncode == 0 else ''
        if SERVER_FILE not in current_cron:
            with open(os.path.expanduser('~/.cron_tmp'), 'w') as f:
                f.write(current_cron + cron_entry)
            subprocess.run(['crontab', os.path.expanduser('~/.cron_tmp')], check=False)
            os.remove(os.path.expanduser('~/.cron_tmp'))
            print('已添加到 crontab 实现开机自启。')
        else:
            print('已存在于 crontab 中。')

def _setup_macos_auto_start():
    """v1.9.0: 在 macOS 上通过 LaunchAgent 实现开机自启。

    在 ~/Library/LaunchAgents/ 下放置 com.github.diaoyunxi.download-forwarder.plist，
    使用 launchctl load -w 注册并启动。相比旧 crontab 方案，LaunchAgent 是 macOS
    官方推荐的用户级守护进程管理方式，支持进程意外退出后自动重启。
    """
    label = 'com.github.diaoyunxi.download-forwarder'
    plist_dir = os.path.expanduser('~/Library/LaunchAgents')
    plist_path = os.path.join(plist_dir, f'{label}.plist')

    # 标准 LaunchAgent plist 配置
    # - KeepAlive=true: 进程退出后自动重启
    # - RunAtLoad=true: 加载时立即启动
    # - StandardOutPath / StandardErrorPath: 重定向输出到日志文件
    log_dir = os.path.expanduser('~/.download_forwarder')
    os.makedirs(log_dir, exist_ok=True)
    plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{SERVER_EXE}</string>
        <string>{SERVER_FILE}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{os.path.join(log_dir, 'launchd.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>{os.path.join(log_dir, 'launchd.err.log')}</string>
</dict>
</plist>
"""
    try:
        os.makedirs(plist_dir, exist_ok=True)
        with open(plist_path, 'w') as f:
            f.write(plist_content)

        # 先卸载已有的同名 LaunchAgent（避免 load 报 "already loaded"）
        subprocess.run(['launchctl', 'unload', plist_path], check=False)
        # 重新加载并启用
        result = subprocess.run(
            ['launchctl', 'load', '-w', plist_path],
            capture_output=True, text=True, check=False
        )
        if result.returncode == 0:
            print(f'macOS LaunchAgent 已创建并启动: {plist_path}')
            print(f'使用 launchctl list | grep {label} 查看状态。')
        else:
            print(f'macOS LaunchAgent 加载失败: {result.stderr.strip() or result.stdout.strip()}')
            print(f'plist 文件已写入: {plist_path}，可手动执行 launchctl load -w {plist_path}')
    except Exception as e:
        print(f'设置 macOS LaunchAgent 失败: {e}')
        # 回退：添加到 crontab
        print('回退到 crontab 方案...')
        cron_entry = f'@reboot {SERVER_EXE} {SERVER_FILE}\n'
        result = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
        current_cron = result.stdout if result.returncode == 0 else ''
        if SERVER_FILE not in current_cron:
            with open('/tmp/.df_cron_tmp', 'w') as f:
                f.write(current_cron + cron_entry)
            subprocess.run(['crontab', '/tmp/.df_cron_tmp'], check=False)
            os.remove('/tmp/.df_cron_tmp')
            print('已添加到 crontab 实现开机自启。')
        else:
            print('已存在于 crontab 中。')


def start_server():
    """启动本地服务器。

    v1.9.0: 修正了旧版本 `exec(open(SERVER_FILE).read())` 的反模式（exec 在当前
    进程的 globals 中执行，会污染 setup.py 的命名空间并导致 server.py 中的
    `if __name__ == '__main__'` 守卫失效）。改用 runpy.run_path 在独立的命名空间
    中以 `__main__` 身份执行 server.py，行为更接近直接 `python server.py`。
    """
    print()
    print('安装完成！正在启动服务器...')
    print()

    import runpy
    # run_name='__main__' 让 server.py 中的 `if __name__ == '__main__'` 守卫生效，
    # 与直接运行 `python server.py` 行为完全一致。
    runpy.run_path(SERVER_FILE, run_name='__main__')


if __name__ == '__main__':
    print('=' * 50)
    print('Download Forwarder 安装程序')
    print('=' * 50)
    print()

    switch_pip_to_tsinghua()
    install_dependencies()
    setup_auto_start()

    start_server()
