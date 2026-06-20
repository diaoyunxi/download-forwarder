#!/usr/bin/env python3
"""
Setup script for Download Forwarder Local Server.
Handles:
1. Switch pip to Tsinghua mirror
2. Install dependencies (if any)
3. Add auto-start entry (Windows registry / Linux systemd)
4. Start the server
"""

import os
import sys
import subprocess
import platform

SERVER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.py')
APP_NAME = 'DownloadForwarder'
SERVER_EXE = sys.executable

def switch_pip_to_tsinghua():
    """Switch pip to Tsinghua mirror"""
    print('[1/3] Checking pip mirror...')
    try:
        import pip
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'config', 'get', 'global.index-url'],
            capture_output=True, text=True
        )
        if 'pypi.tuna.tsinghua.edu.cn' not in result.stdout:
            print('Switching pip to Tsinghua mirror...')
            subprocess.run(
                [sys.executable, '-m', 'pip', 'config', 'set', 'global.index-url',
                 'https://pypi.tuna.tsinghua.edu.cn/simple'],
                capture_output=True
            )
            print('Pip mirror switched successfully.')
        else:
            print('Already using Tsinghua mirror.')
    except Exception as e:
        print(f'Failed to switch pip mirror: {e}')

def install_dependencies():
    """Install required dependencies (none needed for this project)"""
    print('[2/3] Checking dependencies...')
    # This project uses only stdlib modules, no pip install needed
    print('No external dependencies required (stdlib only).')

def setup_auto_start():
    """Add auto-start entry based on OS"""
    print('[3/3] Setting up auto-start...')

    if platform.system() == 'Windows':
        _setup_windows_auto_start()
    elif platform.system() == 'Linux':
        _setup_linux_auto_start()
    else:
        print(f'Unsupported OS: {platform.system()}')

def _setup_windows_auto_start():
    """Add to Windows Registry for auto-start"""
    try:
        import winreg
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Run'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{SERVER_EXE}" "{SERVER_FILE}"')
        winreg.CloseKey(key)
        print('Windows auto-start added successfully.')
    except ImportError:
        # Fallback: use schtasks
        cmd = f'schtasks /create /tn "{APP_NAME}" /tr "\"{SERVER_EXE}\" \"{SERVER_FILE}\"" /sc onlogon /rl limited'
        subprocess.run(cmd, shell=True, check=False)
        print('Windows scheduled task created.')
    except Exception as e:
        print(f'Failed to set Windows auto-start: {e}')

def _setup_linux_auto_start():
    """Add systemd service for auto-start on Linux"""
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

        # Enable and start the service
        subprocess.run(['systemctl', '--user', 'daemon-reload'], check=False)
        subprocess.run(['systemctl', '--user', 'enable', service_name], check=False)
        subprocess.run(['systemctl', '--user', 'start', service_name], check=False)
        print(f'Linux systemd service created: {service_path}')
        print('Run: systemctl --user status download-forwarder.service to check status.')
    except Exception as e:
        # Fallback: add to crontab
        print(f'systemd setup failed, falling back to crontab: {e}')
        cron_entry = f'@reboot {SERVER_EXE} {SERVER_FILE}\n'
        result = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
        current_cron = result.stdout if result.returncode == 0 else ''
        if SERVER_FILE not in current_cron:
            with open(os.path.expanduser('~/.cron_tmp'), 'w') as f:
                f.write(current_cron + cron_entry)
            subprocess.run(['crontab', os.path.expanduser('~/.cron_tmp')], check=False)
            os.remove(os.path.expanduser('~/.cron_tmp'))
            print('Added to crontab for auto-start.')
        else:
            print('Already in crontab.')

if __name__ == '__main__':
    print('=' * 50)
    print('Download Forwarder Setup')
    print('=' * 50)
    print()

    switch_pip_to_tsinghua()
    install_dependencies()
    setup_auto_start()

    print()
    print('Setup complete! Starting server...')
    print()

    # Start the server
    exec(open(SERVER_FILE).read())