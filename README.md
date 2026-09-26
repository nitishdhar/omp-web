# omp-web

`omp-web` is a localhost web console for a single user on their own machine who already uses
[OMP](https://omp.sh/). It runs the native `omp` terminal inside its own tmux
server, so the Terminal view is the real OMP TUI. The optional Chat view is a
projection of that same session's transcript; it never starts a competing
agent process.

It is intentionally a local companion, not a hosted service. A new
installation listens at `http://127.0.0.1:7799`.

## Requirements

- macOS or Linux, and Node.js **22 or newer**
- `tmux`
- OMP (`omp`) on your shell `PATH`

Install Node with your preferred toolchain and confirm it is Node 22+:

```sh
node --version
```

For tmux, Homebrew users can run:

```sh
brew install tmux
```

On Linux, use the system package manager instead:

```sh
sudo apt install tmux
# or
sudo dnf install tmux
```

If OMP is not installed yet, use one of the methods in the
[official OMP installation instructions](https://github.com/can1357/oh-my-pi#install).
For example, the official macOS/Linux installer is:

```sh
curl -fsSL https://omp.sh/install | sh
```

Confirm the prerequisites before continuing:

```sh
tmux -V
omp --version
```

## Install from source

`omp-web` is private and is **not published to an npm registry**. Clone the
source, install its locked dependencies, then use the guided setup:

```sh
git clone https://github.com/<owner>/omp-web.git
cd omp-web
npm ci
npm run doctor
npm run setup
npm start
```

Open `http://127.0.0.1:7799` in the same user's browser on that machine. With
the default setup there is no access token: the console opens straight into
the session list.

If you set up with `--token` (or `OMP_WEB_TOKEN`), the first visit shows an
**Enter access token** dialog instead. Copy the token to the clipboard without
printing it:

```sh
pbcopy < "${OMP_WEB_HOME:-$HOME/.omp-web}/token" # macOS
xclip -selection clipboard < "${OMP_WEB_HOME:-$HOME/.omp-web}/token" # Linux (X11)
wl-copy < "${OMP_WEB_HOME:-$HOME/.omp-web}/token" # Linux (Wayland)
```

Paste it into the dialog and select **Unlock**. Setup and startup report the
token's file path, never its value. `npm start` continues to run the
server directly from the checkout; it does not install a background service.

### What setup does

`npm run setup` (or `omp-web setup` after a local package install):

1. asks for an existing workspace directory the folder picker may expose (or
   suggests the current directory if the default workspace is absent);
2. asks for an existing or new local OMP profile name when `--profile` is not
   supplied;
3. creates a random local access token only with `--token` (or when
   `OMP_WEB_TOKEN` supplies one) — otherwise the console runs open on
   loopback;
4. stores its own missing configuration values under `~/.omp-web` by default;
   and
5. offers to hand off to native OMP onboarding.

It does **not** copy, inspect, replace, or store OMP accounts, profiles,
transcripts, or provider credentials. Existing `~/.omp-web` configuration and
token files are kept. A generated token file is private to the OS user (mode
`600`).

For a repeatable non-interactive workspace choice, use:

```sh
omp-web setup --workspace "$HOME/Developer" --skip-omp-login
```

`--profile NAME` supplies an arbitrary OMP profile name to the offered native
handoff:

```sh
omp-web setup --workspace "$HOME/Developer" --profile personal
```

The full setup form is:

```text
omp-web setup [--workspace PATH] [--profile NAME] [--skip-omp-login] [--token]
```

## Native OMP account and profile onboarding

Choose your provider, subscription, accounts, and profile names in OMP—not in
omp-web. To create or use a profile called `personal`, for example:

```sh
omp --profile personal
```

Inside the native OMP session, use `/login` to select a supported provider or
`/login <provider>` to go directly to one. OMP stores and resolves those local
credentials itself. You can use any profile name and repeat the flow for
separate local profiles; omp-web only launches the profile you select.

`omp setup` is different: its installed help describes optional OMP components
such as `python` and `speech`. It is not an account or profile command.

## Commands

| Command | Purpose |
| --- | --- |
| `omp-web` | Start the localhost server in the foreground. |
| `omp-web start` | Same as bare `omp-web`. |
| `omp-web doctor` | Report platform, Node, tmux, OMP, workspace, and node-pty prerequisites without starting sessions or reading/changing native OMP credentials or profiles. |
| `omp-web setup [--workspace PATH] [--profile NAME] [--skip-omp-login]` | Set up only omp-web and optionally hand off to native OMP. |
| `omp-web --help` | Show command help. |
| `npm start` | Start the server directly from a source checkout. |
| `npm run doctor` / `npm run setup` | Source-checkout equivalents of the CLI commands. |

The server remains attached to the foreground terminal. It does not create,
load, modify, or remove a launchd job on macOS, nor a systemd unit on Linux.
A minimal Linux user-unit equivalent, managed entirely by you. Use
`command -v npm` for the `ExecStart` path (nvm/fnm shims are not on systemd's
`PATH`) and your checkout for `WorkingDirectory`:

```ini
# ~/.config/systemd/user/omp-web.service
[Unit]
Description=omp-web localhost console

[Service]
WorkingDirectory=/path/to/omp-web
ExecStart=/path/to/npm start
# The tmux server shares this unit's cgroup: the default control-group mode
# would take live sessions down on every stop, restart, or crash-restart.
KillMode=process
Restart=on-failure

[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable --now omp-web`.

## Install from a release

Download the tarball attached to the
[latest release](https://github.com/nitishdhar/omp-web/releases/latest),
then install it globally:

```sh
curl -fsSLO https://github.com/nitishdhar/omp-web/releases/download/v0.3.0/omp-web-0.3.0.tgz
npm install --global ./omp-web-0.3.0.tgz
omp-web doctor
omp-web setup
omp-web
```

Setup creates no access token by default: the console runs open on loopback,
relying on the OS user boundary. Pass `omp-web setup --token` (or set
`OMP_WEB_TOKEN`) to require a token instead — mandatory if the server will
ever bind a non-loopback address.

Use the version attached to the release you are installing if it differs.
Registry-style commands such as `npm install -g omp-web` are intentionally
unsupported: releases are the only distribution.

## Local tarball installation

`npm pack` makes a shareable local installer; it is the path for a recipient
who does not have access to the source repository. On a machine with the
checked-out project:

```sh
npm pack
```

Transfer the resulting `omp-web-0.3.0.tgz` by a method appropriate for the
recipient, then on that recipient's machine:

```sh
npm install --global /path/to/omp-web-0.3.0.tgz
omp-web doctor
omp-web setup
omp-web
```

## Configuration and optional features

`OMP_WEB_HOME` selects the omp-web data/config root and defaults to
`~/.omp-web`. Setup writes only missing omp-web values there. An inherited
environment variable has precedence over a value in `OMP_WEB_HOME/env`, and
both take precedence over the application default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_WEB_HOME` | `~/.omp-web` | omp-web's own configuration, token, and attachment root. |
| `OMP_WEB_OMP_HOME` | `~/.omp` | Native OMP root used only to discover profiles and omp-web session transcripts; omp-web does not configure it. |
| `OMP_WEB_HOST` | `127.0.0.1` | Listen address. Keep the default. |
| `OMP_WEB_PORT` | `7799` | Listen port. |
| `OMP_WEB_WORKSPACE` | `~/workspace` | Root exposed to the folder picker. |
| `OMP_WEB_EXTRA_ROOTS` | empty | Colon-separated extra folder trees to list beside the workspace, e.g. `~/private`. |
| `OMP_WEB_OMP_BIN` | `omp` | OMP executable, resolved through a login shell. |
| `OMP_WEB_PROFILES_DIR` | `<OMP_WEB_OMP_HOME>/profiles` | Native OMP profile directory used by the profile picker. |
| `OMP_WEB_SESSIONS_DIR` | `<OMP_WEB_OMP_HOME>/web-sessions` | Per-session OMP transcript directory. |
| `OMP_WEB_ATTACHMENTS_DIR` | `<OMP_WEB_HOME>/attachments` | Private, per-session uploaded-attachment directory. |
| `OMP_WEB_TMUX_BIN` | first available of `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/usr/bin/tmux`, then `tmux` | tmux executable. |
| `OMP_WEB_TMUX_SOCKET` | `omp-web` | Dedicated tmux socket label. |
| `OMP_WEB_TOKEN` | empty | Access token. When set, HTTP and WebSocket endpoints require it; `setup --token` creates the file instead. Keep it private; do not commit or share it. |
| `OMP_WEB_ALLOW_OPEN` | empty | Set to `1` to run with no access token on a non-loopback bind. Accepts that anyone reaching the port controls the sessions; the server refuses open LAN binds without it. |
| `OMP_WEB_TRANSCRIBE_BASE_URL` | empty | OpenAI-compatible transcription service base URL. |
| `OMP_WEB_TRANSCRIBE_API_KEY` | empty | Key kept on this machine and sent only to the configured transcription service. |
| `OMP_WEB_TRANSCRIBE_MODEL` | empty | Transcription model name. |

**Profile information** is projected from each native OMP profile's
`modelRoles` block. The New session and Reload profile dialogs show the default
model and effort, and the header's info control lists every configured role for
the active profile. Only role names, identifier-validated provider/model
identifiers, and effort levels reach the browser; malformed role scalars and
the rest of `config.yml` remain server-side.

**Subscription usage** comes directly from native
`omp usage --json --redact` output across the configured OMP profiles. The
panel dynamically shows every distinct provider, account, and limit window OMP
reports. Provider credentials and account metadata never reach the browser.
Providers without a quota API retain OMP's no-limits explanation.

Voice input is disabled unless **all three** transcription variables—the base
URL, API key, and model—are configured. The browser sends a recorded clip to
omp-web; omp-web forwards it to the configured OpenAI-compatible
`/audio/transcriptions` endpoint. The transcription key is not sent to the
browser. Add those variables to the private `OMP_WEB_HOME/env` file or provide
them through the process environment, then restart the foreground server.

## Reconnect, update, and remove

OMP sessions live in omp-web's dedicated tmux server. If the browser
disconnects or you stop and restart the foreground server, reconnect at the
same localhost URL and reopen the session; the tmux session remains until you
explicitly end it.

To update a source checkout:

```sh
git pull
npm ci
npm run doctor
```

Then start it again with `npm start`. An existing tarball installation is
upgraded in place by installing a newer tarball over it:

```sh
npm install --global /path/to/omp-web-<version>.tgz
omp-web doctor
```

Installing over the previous version keeps `OMP_WEB_HOME`, the saved access
token, tmux sessions, and OMP data; only the program is replaced. Restart the
running `omp-web` afterwards so the new server code is live, then hard-reload
the browser tab.

Removing the source checkout or running `npm uninstall --global omp-web`
removes the program only. It does not remove tmux sessions, OMP data, or
`OMP_WEB_HOME`. Delete those separately only if you explicitly want to discard
them.

## Security boundary

omp-web is for **one trusted OS user on one machine**. By default it runs open
on loopback with no access token: anyone who can use that OS account can
control the exposed tmux/OMP sessions and, through OMP, run tools in the
selected workspace. Pass `setup --token` (or set `OMP_WEB_TOKEN`) to protect
the localhost HTTP and WebSocket endpoints with a private token — required
before binding any non-loopback address (the server refuses to start open
outside loopback unless `OMP_WEB_ALLOW_OPEN=1` explicitly accepts that risk).
Either way it is not a sandbox, multi-user system, or remote-access product.
Keep the server on loopback, protect the token and any optional transcription
key, and choose a workspace whose contents that user is allowed to access.

If you independently put a trusted reverse proxy in front of the server, it
must preserve the request `Host` header. omp-web compares browser `Origin`
against that host for its HTTP and WebSocket origin checks. This is not part of
the default localhost setup and does not turn omp-web into a multi-user
service.

## License

omp-web is declared [ISC](LICENSE). Third-party notices for its production
dependencies and vendored terminal assets are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
