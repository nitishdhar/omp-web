# omp-web

`omp-web` is a localhost web console for a single Mac user who already uses
[OMP](https://omp.sh/). It runs the native `omp` terminal inside its own tmux
server, so the Terminal view is the real OMP TUI. The optional Chat view is a
projection of that same session's transcript; it never starts a competing
agent process.

It is intentionally a local companion, not a hosted service. A new
installation listens at `http://127.0.0.1:7799`.

## Requirements

- macOS and Node.js **22 or newer**
- `tmux`
- OMP (`omp`) on your shell `PATH`

Install Node with your preferred macOS toolchain and confirm it is Node 22+:

```sh
node --version
```

For tmux, Homebrew users can run:

```sh
brew install tmux
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
git clone https://github.com/nitishdhar/omp-web.git
cd omp-web
npm ci
npm run doctor
npm run setup
npm start
```

Open `http://127.0.0.1:7799` in the same Mac user's browser. On the first
visit, copy the default private token to the macOS clipboard without printing
it:

```sh
pbcopy < "${OMP_WEB_HOME:-$HOME/.omp-web}/token"
```

Paste it into the browser's **Enter access token** dialog and select
**Unlock**. Setup and startup report the token's file path, never its value.
If you instead provide `OMP_WEB_TOKEN`, setup leaves the token file absent or
unchanged; copy that separately managed secret into the same dialog without
printing it or putting it in shell history. `npm start` continues to run the
server directly from the checkout; it does not install a background service.

### What setup does

`npm run setup` (or `omp-web setup` after a local package install):

1. asks for an existing workspace directory the folder picker may expose (or
   suggests the current directory if the default workspace is absent);
2. asks for an existing or new local OMP profile name when `--profile` is not
   supplied;
3. creates a random local access token only when neither `OMP_WEB_TOKEN` nor
   an existing token file supplies one;
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
omp-web setup [--workspace PATH] [--profile NAME] [--skip-omp-login]
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
| `omp-web doctor` | Report macOS, Node, tmux, OMP, workspace, and node-pty prerequisites without starting sessions or reading/changing native OMP credentials or profiles. |
| `omp-web setup [--workspace PATH] [--profile NAME] [--skip-omp-login]` | Set up only omp-web and optionally hand off to native OMP. |
| `omp-web --help` | Show command help. |
| `npm start` | Start the server directly from a source checkout. |
| `npm run doctor` / `npm run setup` | Source-checkout equivalents of the CLI commands. |

The server remains attached to the foreground terminal. It does not create,
load, modify, or remove a launchd job.

## Local tarball installation

`npm pack` makes a shareable local installer; it is the path for a recipient
who does not have access to the source repository. On a Mac with the checked
out project:

```sh
npm pack
```

Transfer the resulting `omp-web-0.2.10.tgz` by a method appropriate for the
recipient, then on that recipient's Mac:

```sh
npm install --global /path/to/omp-web-0.2.10.tgz
omp-web doctor
omp-web setup
omp-web
```

Use the filename that `npm pack` prints if the version differs. Registry-style
commands such as `npm install -g omp-web` are intentionally unsupported until
there is an explicit public release.

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
| `OMP_WEB_TOKEN` | generated local token, unless explicitly supplied | Access token. Setup preserves an existing file and does not create one when this variable is set. Keep it private; do not commit or share it. |
| `OMP_WEB_TRANSCRIBE_BASE_URL` | empty | OpenAI-compatible transcription service base URL. |
| `OMP_WEB_TRANSCRIBE_API_KEY` | empty | Key kept on this Mac and sent only to the configured transcription service. |
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

omp-web is for **one trusted OS user on one Mac**. It protects its localhost
HTTP and WebSocket endpoints with the private token created during setup, but
it is not a sandbox, multi-user system, or remote-access product. Anyone who
can use that OS account and obtain the token can control the exposed tmux/OMP
sessions and, through OMP, run tools in the selected workspace. Keep the
server on loopback, protect the token and any optional transcription key, and
choose a workspace whose contents that user is allowed to access.

If you independently put a trusted reverse proxy in front of the server, it
must preserve the request `Host` header. omp-web compares browser `Origin`
against that host for its HTTP and WebSocket origin checks. This is not part of
the default localhost setup and does not turn omp-web into a multi-user
service.

## License

omp-web is declared [ISC](LICENSE). Third-party notices for its production
dependencies and vendored terminal assets are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
