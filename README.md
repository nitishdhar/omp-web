# omp-web

`omp-web` is a localhost web console for a single user on their own machine who already uses
[OMP](https://omp.sh/). Each session lives in its own tmux server. Chat runs
`omp` headless (`--mode rpc-ui`) only while it is working, so an idle session
uses no agent process; opening Terminal starts the real OMP TUI on the same
transcript. A session never has two agent processes at once.

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
5. checks the two [install links](#what-installing-changes-on-this-machine)
   and prints what it created or repaired; and
6. offers to hand off to native OMP onboarding.

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
| `omp-web artifact <new\|list\|path\|url\|check\|touch>` | Create and maintain [artifacts](#artifacts); `omp-web artifact --help` lists the options. |
| `omp-web addresses [--json]` | List the addresses this console answers on, whether each is reachable with the current bind, and which one links use. Works while the server is down. See [Addresses](#addresses). |
| `omp-web credential <list\|set\|import\|rm>` | Manage [credentials](#credentials) without the browser; values are read from stdin or imported once, never shown. Works while the server is down. |
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

## What installing changes on this machine

Beyond the package itself, omp-web keeps exactly two links in your home
directory, so agents can use it without any per-profile setup:

| Link | Points at | Why |
| --- | --- | --- |
| `~/.agents/skills/omp-web-artifacts` | `<OMP_WEB_HOME>/skills/artifacts` | Every omp profile reads skills from `~/.agents/skills` (other agents that read that folder see it too), so every session gets the [Artifacts](#artifacts) skill. |
| `~/.local/bin/omp-web` | this install's `bin/omp-web.js` | Puts `omp-web` on `PATH` for agents running `omp-web artifact ...`, as long as `~/.local/bin` is on your `PATH`. |

A global install (`npm install --global ...`) creates them during install and
prints one line per link (npm shows it with `--foreground-scripts`); `npm ci`
in a source checkout does not touch your home directory. Every server start
and `omp-web setup` check them again and
repair them, which covers source checkouts and a reinstall followed by a
restart. Only a missing link, a dangling link, or a link omp-web made earlier
is ever replaced: a real file or directory at either path, or a
`~/.local/bin/omp-web` that links to some other program, is left alone and
reported. `omp-web doctor` shows both links and warns when `~/.local/bin` is
not on `PATH`.

To manage neither link, set `OMP_WEB_NO_INSTALL_LINKS=1` in the environment
or in `OMP_WEB_HOME/env` before installing or starting. Removing omp-web
leaves both links dangling; delete them by hand.

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
| `OMP_WEB_ARTIFACTS_DIR` | `<OMP_WEB_HOME>/artifacts` | Folder holding one subfolder per [artifact](#artifacts). |
| `OMP_WEB_NO_INSTALL_LINKS` | empty | Set to `1` to stop install, start and setup from creating or repairing `~/.agents/skills/omp-web-artifacts` and `~/.local/bin/omp-web`. See [What installing changes](#what-installing-changes-on-this-machine). |
| `OMP_WEB_TMUX_BIN` | first available of `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/usr/bin/tmux`, then `tmux` | tmux executable. |
| `OMP_WEB_TMUX_SOCKET` | `omp-web` | Dedicated tmux socket label. |
| `OMP_WEB_RPC_IDLE_MINUTES` | `10` | Minutes a Chat session's headless `omp` stays up after it settles before it exits. The next message starts it again. Also settable in Settings → Sessions & memory (1–1440); when this variable is set it wins and Settings shows it locked. |
| `OMP_WEB_TUI_IDLE_MINUTES` | `30` | Minutes an idle Terminal (TUI) session with no open terminal waits before it is handed back to the headless Chat runner. Also settable in Settings → Sessions & memory (5–1440); when this variable is set it wins and Settings shows it locked. |
| `OMP_WEB_TOKEN` | empty | Access token. When set, HTTP and WebSocket endpoints require it; `setup --token` creates the file instead. Keep it private; do not commit or share it. |
| `OMP_WEB_ALLOW_OPEN` | empty | Set to `1` to run with no access token on a non-loopback bind. Accepts that anyone reaching the port controls the sessions; the server refuses open LAN binds without it. |
| `OMP_WEB_PANELS` | empty | JSON array of local web apps to show inside omp-web. Panels can also be added in Settings; panels from this variable are locked there. See [Panels](#panels). |

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

**Updating omp.** Settings → OMP shows the installed and latest omp version
(`omp update --check`, cached for six hours) and can update omp on the host:
it runs `omp update` as the user the omp-web server runs as, using whatever
install method omp detects. Nothing updates on its own; only the button runs
it. Running sessions keep the old binary until restarted, so **Reload
profiles** then refreshes every profile's model catalog
(`omp --profile=<name> models refresh`) and restarts idle sessions still on the
old version; busy ones are skipped.

### Credentials

omp-web keeps its own named secrets (provider API keys) and never shows a value
again after it is saved: the API, Settings, logs and error messages carry only
the name, a label, the store and the last four characters (for values of 12 or
more characters). Manage them in **Settings → Credentials** or with the CLI.
Each credential lives in one store:

| Store | Where the value lives |
| --- | --- |
| File (default) | `OMP_WEB_HOME/credentials.json`, mode 0600, written atomically. Names and metadata live in `settings.json`; values never do. |
| Keychain (macOS) | The login keychain, service `omp-web`, account = credential name. Values up to about 3,900 characters. |

The Keychain answers only a server running in your login session (started
from a terminal). A server started by a background service such as a
LaunchAgent is refused it ("User interaction is not allowed"); omp-web probes
this once per start, and Settings shows Keychain as unavailable with the
reason instead of failing later. Changing a credential's store moves the
value; a credential still used by Voice or passed to OMP cannot be deleted.

```bash
some-vault-cli get voice-key | omp-web credential set voice-api-key --label "Voice API key"
omp-web credential import voice-api-key --env VOICE_KEY           # copy once from this shell's environment
omp-web credential import voice-api-key --file ~/old.env --key VOICE_KEY   # or a KEY=value line (whole file without --key)
pbpaste | omp-web credential set work-key --store keychain        # Keychain, from a terminal
omp-web credential list [--json]
omp-web credential rm work-key
```

`set` reads one line from stdin and refuses a terminal prompt or an empty
value, so the value never appears in arguments or shell history. `import`
copies the value once; the variable or file is not needed afterwards. A running
server sees CLI changes on its next request.

### Voice input

Configure voice input in **Settings → Voice**: an OpenAI-compatible base URL
(e.g. `https://api.example.com/v1`), a model (e.g. `whisper-1`) and the
credential holding the API key. **Test** calls `GET <base URL>/models` with the
key. The browser sends a recorded clip to omp-web, which forwards it to
`<base URL>/audio/transcriptions`; the key never reaches the browser. Changes
apply without a restart, and the composer's mic button follows readiness.

Earlier versions read `OMP_WEB_TRANSCRIBE_BASE_URL`, `OMP_WEB_TRANSCRIBE_API_KEY`
and `OMP_WEB_TRANSCRIBE_MODEL`. On the first start without voice settings,
omp-web moves them into Settings (credential `voice-api-key`, file store) and
ignores them from then on; `omp-web doctor` warns while any is still set so you
can remove it from `OMP_WEB_HOME/env` or the service environment.

### Keys passed to OMP

**Settings → Keys passed to OMP** maps environment variables to credentials
(e.g. `OPENAI_API_KEY` → `openai-key`). Every omp that omp-web launches gets
them: Terminal and Chat sessions, and the omp runs behind the model catalog,
usage, version checks, updates and skills settings. Values are added on top of
the server's environment. If `OMP_WEB_OMP_BIN` is a wrapper script that sets
the same variable itself, the wrapper's value wins.

A session resolves the keys inside its pane: the pane command carries only the
variable names, and a small resolver passes the values to the pane shell over
a pipe, so they never appear in process arguments, tmux options or commands,
shell history, logs, or any file besides the credential store. A credential
that cannot be read (missing, or Keychain from a background service) leaves
that variable unset; the session still starts and its pane shows one line
naming the variable. Changes apply to the next omp launch. Like any
environment variable, the values are visible to processes of the same user
that can read omp's environment.

### Addresses

omp-web works out its own addresses, so links it hands out (artifact links,
**Copy link**, `omp-web artifact url`) open on other devices without any
configuration. In order:

| Kind | Where it comes from |
| --- | --- |
| Public | The public address saved in **Settings → General → Addresses**, for when a reverse proxy or Tailscale Serve publishes this console. An origin only (`https://console.example`), no path. |
| Tailscale name / IP | `tailscale status --json` when Tailscale is running: the machine's MagicDNS name (`http://<machine>.<tailnet>:<port>`) and first IPv4 (`http://100.x.y.z:<port>`). The CLI is found on `PATH`, else inside the macOS app; absent or stopped Tailscale just means no entries. Checked at most every 30 seconds. |
| Local network | `http://<host>.local:<port>` on macOS, else the first non-loopback IPv4. |
| This machine | `http://127.0.0.1:<port>`. |

Each address is marked reachable or not from the server's bind (`OMP_WEB_HOST`;
the running server records it in `OMP_WEB_HOME/run/server.json`, so the CLI
uses the real bind even from a shell that doesn't set it): a loopback bind
reaches only this machine, a bind to one address reaches only that address
(binding the Tailscale IP also covers the Tailscale name), and `0.0.0.0` or
`::` reaches all. The public address is always treated as reachable, since a
proxy, not the bind, routes it. Links use the first reachable address in the
order above. **Settings → General → Addresses** lists them with Copy buttons
and edits the public address; `omp-web addresses` prints the same list.

### Panels

A panel shows a local web app inside omp-web: it gets an entry in the sidebar
footer and opens in the main pane, served through omp-web at `/panels/<id>/`.
List panels in `OMP_WEB_PANELS` (environment or `OMP_WEB_HOME/env`) and
restart the server, or add them in **Settings → Panels**, which applies on save
without a restart:

```sh
OMP_WEB_PANELS='[{"id":"example","label":"Example","url":"http://127.0.0.1:8090"}]'
```

`id` is 1–40 characters of `a-z`, `0-9` and `-`, unique; `label` is up to 40
characters. An invalid `OMP_WEB_PANELS` entry stops startup with a message
naming it. Panels from the variable come first and cannot be edited or
shadowed in Settings; Settings-added panels (at most 20) are stored in
`OMP_WEB_HOME/settings.json`, and an invalid stored entry is skipped with a
warning rather than stopping startup.

The contract a panel app can rely on:

- **Loopback only.** `url` is exactly `http://127.0.0.1:<port>` or
  `http://localhost:<port>`: no path, query, credentials, https, or other host.
- **Relative URLs only.** The app is served under `/panels/<id>/`, so links,
  scripts, styles and `fetch` calls must be relative (`./app.js`, `api/x`), never
  root-absolute (`/app.js`).
- omp-web adds `X-Forwarded-Host` (the browser's `Host`), `X-Forwarded-Proto`
  and `X-Forwarded-Prefix` (`/panels/<id>`), passes `Origin` and custom headers
  unchanged, and strips its own token (query parameter and header) and panel
  cookie. It guarantees nothing else: the app does its own CSRF and origin
  checks, for example comparing `Origin` with `X-Forwarded-Host`.
- No WebSockets in this version.
- **Trust boundary.** A panel is served from omp-web's origin, so its scripts
  can reach everything omp-web's page can, including the stored access token.
  Configure only apps you trust as much as omp-web itself.

With a token configured, panel requests accept the token or a cookie derived
from it (path-scoped to `/panels/`, `HttpOnly`, `SameSite=Strict`) that omp-web
sets after the first token-authenticated load; `/api` and the WebSocket never
accept that cookie.

### Artifacts

An artifact is a small static web page an agent builds and keeps updated: a
to-do list, a tracker, a report. omp-web serves it at a private link that
works from a phone or a chat message, and lists every artifact in the sidebar's
**Artifacts** gallery.

Each artifact is a folder `<OMP_WEB_HOME>/artifacts/<slug>/` (or under
`OMP_WEB_ARTIFACTS_DIR`) holding an `artifact.json` manifest (`title`, optional
`description`, `project` folder, `entry` page and `updatedAt`), the page files,
and usually a `data.json` the page renders. Agents update the data; the page
stays the same.

```sh
omp-web artifact new todo --title "To-do" --template list   # list, table, cards or blank
omp-web artifact list [--json]
omp-web artifact path todo     # the folder
omp-web artifact url todo      # the link, absolute (see Addresses)
omp-web artifact check todo    # manifest, entry, file types, size, JSON, external URLs, symlinks
omp-web artifact touch todo    # bump updatedAt after changing files
```

Served files follow fixed rules: no dotfiles, symlinks must stay inside the
folder, only html, css, js, json, txt, md, svg, image and woff2 files, and no
directory listings. `check` also flags folders over 20 MB.

**The skill.** omp-web ships an `artifacts` skill that teaches agents this
workflow (update instead of duplicating, write `data.json` atomically, run
`check`, reply with the link). omp-web copies its bundled skills to
`<OMP_WEB_HOME>/skills/`, a path that survives package upgrades, and links it
into `~/.agents/skills`, so every omp profile has the skill with no setup (see
[What installing changes](#what-installing-changes-on-this-machine)). To turn
it off for one profile, use the switch in **Settings → Profiles**, which adds
`artifacts` to that profile's `skills.ignoredSkills` through `omp config set`
(other entries are kept); switching it back on removes that entry. By hand,
`omp [--profile=<name>] config set skills.ignoredSkills '[...existing entries,
"artifacts"]'` does the same; the value replaces the whole list. Profiles that
had the old opt-in switch on (`<OMP_WEB_HOME>/skills` in
`skills.customDirectories`) have that entry removed on the next server start,
since the skill would otherwise load twice.

**Trust model.** A link `/a/<capability>/<slug>/` is a bearer capability:
anyone holding it can read every file of that artifact, with no token and no
login, so never put secrets in an artifact. Capabilities are signed with
`<OMP_WEB_HOME>/artifacts.key` (created on first use, mode 0600), independent
of the access token. Deleting that file revokes every link at once; new links
are issued on next use. Pages run sandboxed (`Content-Security-Policy:
sandbox` without `allow-same-origin`), so even though they are served from
omp-web's address they get an opaque origin: they cannot read omp-web's stored
token, cookies or localStorage, cannot call `/api`, and cannot load anything
outside their own folder. They also cannot save state; `data.json` is the
source of truth.

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
removes the program only. It does not remove tmux sessions, OMP data,
`OMP_WEB_HOME`, or the two install links. Delete those separately only if you
explicitly want to discard them.

## Security boundary

omp-web is for **one trusted OS user on one machine**. By default it runs open
on loopback with no access token: anyone who can use that OS account can
control the exposed tmux/OMP sessions and, through OMP, run tools in the
selected workspace. Pass `setup --token` (or set `OMP_WEB_TOKEN`) to protect
the localhost HTTP and WebSocket endpoints with a private token — required
before binding any non-loopback address (the server refuses to start open
outside loopback unless `OMP_WEB_ALLOW_OPEN=1` explicitly accepts that risk).
Either way it is not a sandbox, multi-user system, or remote-access product.
Keep the server on loopback, protect the token and the credential store
(`OMP_WEB_HOME/credentials.json`, or the Keychain), and choose a workspace
whose contents that user is allowed to access. Credential values are
write-only through the API and the CLI; anyone who can run commands as this OS
user can still read them from the store or from a running omp's environment.

If you independently put a trusted reverse proxy in front of the server, it
must preserve the request `Host` header. omp-web compares browser `Origin`
against that host for its HTTP and WebSocket origin checks. This is not part of
the default localhost setup and does not turn omp-web into a multi-user
service.

## License

omp-web is declared [ISC](LICENSE). Third-party notices for its production
dependencies and vendored terminal assets are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
