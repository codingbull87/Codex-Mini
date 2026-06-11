# Codex Mini Self Build

This branch is a personal-use fork of Codex Mini.

Version label: Android keyboard input handling complete; conversation index fixed.

## Changes

- Keeps Codex Mini local-only for Tailscale access.
- Disables the beta tunnel path for self-hosted use.
- Adds a fast conversation list backed by an async thread-detail index worker.
- Keeps Android keyboard/composer handling from the current working build.
- Disables Sparkle automatic update metadata during local macOS app builds.

## Runtime Defaults

- Port: `8788`
- State directory: `~/.codex-mini-beta`
- Fast thread list: enabled
- Thread detail index: up to the latest 200 session files, refreshed every 5 minutes

## Upstream

Original project attribution is kept in `README.md` and `LICENSE`.
Upstream project: https://github.com/CoimgRain/Codex-Mini
