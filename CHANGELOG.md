# Changelog

## Unreleased

- Self build 4.2.1: 安卓键盘输入处理完成；对话索引修复。
- Added a fast conversation list backed by an async thread-detail index worker so large `.codex/sessions` histories do not block phone access.
- Disabled the beta tunnel path for local-only Tailscale use and made the default self-use service run on port 8788.
- Disabled Sparkle automatic update metadata during local app builds so this fork is not overwritten by the upstream appcast.
- Converted this branch into a local-only open-source edition.
- Removed hosted access, payment, activation, and test-build distribution code paths.
- Kept the core local phone-to-Codex bridge, thread list, send, status, model menu, and macOS wrapper app.
