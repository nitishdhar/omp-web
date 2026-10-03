# Changelog

All notable changes to omp-web are listed here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-10-03

### Added

- `omp-web service install|uninstall|status [--label L] [--dry-run]` runs the
  server as a per-user service: a LaunchAgent on macOS, a systemd user unit on
  Linux. Install records the current shell's `node`, `omp-web` and `PATH`,
  never writes the access token into the service file, and refuses a
  non-loopback bind without a token.
- `omp-web doctor` fails on tmux older than 3.2 (`terminal-features` needs
  it) and on any flag omp-web launches omp with that `omp --help` does not
  list (`--mode`, `--no-ui`, `--no-title` and `--resume` join the existing
  checks).
- `omp-web doctor` and the install script name the build toolchain node-pty
  needs when it fails to load (Linux: `build-essential` and `python3`; macOS:
  Xcode Command Line Tools).
- `omp-web setup` prints the exact line to put `~/.local/bin` on `PATH` for
  zsh, bash or fish when it is missing.
- This changelog.

### Changed

- README requirements list tmux 3.2+ and the node-pty build toolchain, the
  clone URL points at the public repository, and the release install snippet
  takes the version as a variable.
- Docs describe omp-web as a macOS and Linux companion throughout.

### Fixed

- Sending the first message from the empty Chat screen opens the new session
  straight away, with the message shown as Queued.
- `omp-web doctor` matches OMP flags as whole words, so `--model` no longer
  satisfies a `--mode` check.

### Removed

- The hand-written systemd unit in the README, replaced by
  `omp-web service install`.

## [0.10.0] - 2026-10-03

### Added

- Credential store for omp-web's own secrets: a private file by default, or
  the macOS Keychain. Values are never shown again after saving; manage them
  in Settings → Credentials or with `omp-web credential`.
- Settings → Voice: base URL, model and API-key credential for voice input,
  with a Test button.
- Keys passed to OMP: map environment variables to credentials for every omp
  launch omp-web makes, without the values reaching process arguments, tmux or
  logs.

### Changed

- `OMP_WEB_TRANSCRIBE_*` variables are migrated into Settings → Voice on the
  first start and ignored afterwards; `omp-web doctor` warns while one is set.

## [0.9.3] - 2026-10-03

### Fixed

- Artifacts load their data on iOS and Safari: the sandbox CSP names the
  artifact's folder so WebKit allows the fetch.

## [0.9.2] - 2026-10-03

### Fixed

- The CLI falls back to the running server's bind per field (host and port
  separately) when building links.

## [0.9.1] - 2026-10-03

### Fixed

- CLI links (`omp-web artifact url`, `omp-web addresses`) use the running
  server's bind instead of the CLI shell's environment.

## [0.9.0] - 2026-10-03

### Added

- Artifacts: small static web pages agents build and keep updated, served at
  private capability links and listed in the sidebar gallery, with the
  `omp-web artifact` CLI and a bundled `artifacts` skill.
- The console works out its own addresses (public address, Tailscale name and
  IP, local network, this machine) for absolute links; `omp-web addresses`.
- Install links: the artifacts skill is linked into `~/.agents/skills` for
  every profile, and `omp-web` into `~/.local/bin`.
- Settings becomes a page with General, OMP (version check and one-click
  `omp update`), Panels, Sessions & memory, and Storage sections.

### Changed

- The Settings → Profiles skill switch is an opt-out through
  `skills.ignoredSkills`; old `skills.customDirectories` entries are removed
  on start.
- The OMP version check counts the omp behind a wrapper `OMP_WEB_OMP_BIN`.

### Removed

- `OMP_WEB_PUBLIC_URL`: the public address is set only in Settings →
  General → Addresses.

### Fixed

- The sidebar's unread dot is centred with the row actions.

## [0.8.0] - 2026-10-03

### Added

- Panels: `OMP_WEB_PANELS` proxies local loopback web apps into the console at
  `/panels/<id>/`, with token-derived cookie authentication for the app's own
  requests.

## [0.7.0] - 2026-10-03

### Added

- Chat sessions run omp headless (`--mode rpc-ui`) only while working; opening
  Terminal starts the TUI on the same transcript, and idle TUIs are handed
  back after `OMP_WEB_TUI_IDLE_MINUTES`.
- Delete session, with forgotten sessions kept hidden.
- Model and effort menus in the Chat run row.
- Turn rail: one tick per user message beside the transcript.

### Changed

- Calmer navigation and chat: folder grouping, a breadcrumb header and roomier
  type.

### Fixed

- Subagents settle from job snapshots in any tool result.
- The terminal fits once after layout settles.
- Profile reload relaunches the pane again.

## [0.6.0] - 2026-10-02

### Added

- Keep session name: a per-session auto-title opt-out (`--no-title`) that
  survives profile reload and restore.
- Left navigation redesign: inline rename, command palette search, keyboard
  rail and sticky projects.
- Chat: Retry on every error card, Regenerate and edit-and-resend,
  plain-language tool summaries, multi-file uploads.

## [0.5.0] - 2026-09-26

### Added

- Per-session terminal pool: switching between recent sessions is instant,
  with one socket per session.
- The console is installable as a PWA.

### Changed

- Terminal replay is revealed only after output settles, behind a loader.
- Pinned rows stay in their folders.

## [0.4.1] - 2026-09-26

### Added

- `OMP_WEB_ALLOW_OPEN=1` explicitly allows an open console on a non-loopback
  bind.

## [0.4.0] - 2026-09-26

### Changed

- The access token is opt-in: the console runs open on loopback by default,
  and `omp-web setup --token` creates one.

## [0.3.0] - 2026-09-26

### Added

- Install from GitHub releases: each version tag attaches the npm tarball.
- Linux support: `omp-web doctor` warns rather than fails on Linux, and the
  README documents a systemd user unit.
- Architecture and design-system docs, and a contributor guide.

### Changed

- Session status derivation moved into `sessions/status.js`; registry reads
  are cached.

### Removed

- The unreachable Recent sidebar view.

[Unreleased]: https://github.com/nitishdhar/omp-web/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/nitishdhar/omp-web/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/nitishdhar/omp-web/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/nitishdhar/omp-web/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/nitishdhar/omp-web/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/nitishdhar/omp-web/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/nitishdhar/omp-web/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/nitishdhar/omp-web/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/nitishdhar/omp-web/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/nitishdhar/omp-web/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nitishdhar/omp-web/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/nitishdhar/omp-web/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/nitishdhar/omp-web/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nitishdhar/omp-web/releases/tag/v0.3.0
