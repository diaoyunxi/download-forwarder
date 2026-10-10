# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.10.1] - 2026-09-30

### Added
- Auto-update check via chrome.alarms API
- Batch download with concurrent task management
- History tracking with configurable limits

### Fixed
- Version sync between manifest.json and server.py
- Process cleanup on task cancellation (SIGTERM + SIGKILL)
- History race condition with lock protection
