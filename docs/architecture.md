# omp-web — architecture

## Purpose

Web console to run and manage **native `omp` (oh-my-pi) sessions** from a
browser (desktop or mobile), organized by **folder** and **profile**. It streams
the real omp TUI — Agent Hub (`Alt+A`), thinking, tool cards, everything — with
no feature loss.

## Why tmux remains the single writer

OMP is terminal-first and exposes no read-only subscription API for an existing
session. The terminal remains the faithful control surface: `xterm.js` attaches
through `node-pty` to the session's tmux pane, and tmux owns all input.

Chat mode does **not** launch a second OMP process. It projects the same
session's owned JSONL into structured items and injects messages back through
tmux. Terminal and chat are interchangeable views of one runtime:

```
browser terminal ─WebSocket─> node-pty ─> tmux ─> OMP TUI
browser chat ─GET byte pages─> JSONL projection ─┘
browser chat ─POST message/keys──────────> tmux ─┘
```

This avoids the retired RPC design's second-writer lease and preserves instant
switch-back to the complete TUI. REST (`/api/*`) manages sessions and chat
projection/input; `/ws` carries the live terminal.

## Local installation boundary

The distributable app is a single-user macOS companion to an independently
installed OMP. Each user supplies their own subscriptions, native OMP profiles,
workspace, and optional integrations. No provider accounts or profile templates
are bundled. Native OMP owns provider login and model selection.

`omp-web setup` configures a new local installation without replacing existing
configuration, tokens, profiles, or services. `omp-web doctor` checks local
prerequisites; `omp-web start` runs the server in the foreground. The default
listener is `127.0.0.1:7799`. Installation does not register a LaunchAgent.
The npm package includes an explicit runtime-file allowlist; operator handoff,
plans, repository agent instructions, and local runtime data are excluded.

`OMP_WEB_HOME` relocates omp-web's env/token/attachment directory; it defaults
to `~/.omp-web`. This is separate from OMP's profile and transcript storage.
Existing environment overrides and the existing operator deployment remain
supported. Terminal sessions clear inherited `OMP_PROFILE` and `PI_PROFILE`,
then set the default agent directory explicitly before applying a selected
named profile. Native setup also clears inherited profile/directory selectors.
Doctor runs OMP help probes in a disposable HOME because upstream help can
initialize profile files; checking prerequisites must not mutate user profiles.

## Components

| File | Role |
|---|---|
| `server.js` | Node HTTP + WebSocket only: static shell serving, `/api` dispatch (delegated), `/ws` PTY bridge, process guards. |
| `bin/omp-web.js` | macOS CLI: foreground start, non-destructive local setup, prerequisite checks, and explicit handoff to native OMP profile onboarding. |
| `bin/postinstall.js` | Repairs executable permissions on installed node-pty spawn helpers, including hoisted dependency layouts. |
| `api/routes.js` | REST route table. Session create/list/scroll/profile-reload/pin/delete operations use shared bounded request/error handling; `/api/meta` projects native profile names plus bounded, identifier-validated `modelRoles` provider/model/effort metadata; chat routes and session attachments delegate to their owning modules. |
| `api/util.js` | Shared JSON response/error mapping and a 1 MB, strict-UTF-8 request-body reader. API responses are `no-store`. |
| `api/usage.js` | One-minute native `omp usage --json --redact` adapter. It aggregates configured profiles, deduplicates accounts by allowlisted usage fields, and strips account/credential metadata before returning dynamic provider limit data to the browser. |
| `api/attachments.js` | Bounded, authenticated image/document upload parser; validates allowed types and stores private per-session attachments outside workspaces. |
| `api/file-preview.js` | Authenticated raw file preview endpoint: opens the resolved file with `O_NOFOLLOW`, re-checks containment on the **opened descriptor's** path (no check/open race), applies the viewer-folder credential filter, and streams only regular allowlisted files up to 10 MiB. |
| `api/file-resolve.js` | Where a cited path lives. A relative path resolves in order: `<session folder>/<path>`, then `<workspace>/<repo>/<path>` for exactly one top-level repo, then a unique suffix match under the session folder (`api/file-find.js`), then a unique suffix match in the user's viewer folders. Several matches return `409 ECONFLICT` rather than a guess. `~` expands to `$HOME` and `…/` elisions are treated as suffixes, but every result must still fall inside an allowed root: the session folder, sibling workspace repos, that session's attachments, and Settings → File viewer folders. |
| `api/file-find.js` | Bounded async suffix search behind the preview resolver. Agents cite documents by bare name (`action-docket.md`), and resolution used to stop at the folder's top level, so a nested file was a dead link while its top-level sibling opened. It skips dot/build dirs, never follows symlinks, refuses `..`, stops at depth 8 or 25k files (a session rooted at the whole workspace is ~85k), and treats a capped walk as unproven rather than unique. |
| `api/preview-roots.js` | **File viewer folders**, edited in Settings (`GET`/`PUT /api/settings/preview-roots`) and stored in `~/.omp-web/settings.json` (0600, atomic write), read on every request so changes apply without a restart. Extra roots must be existing absolute (or `~/`) directories; `/`, `$HOME` and its ancestors, and anything overlapping omp-web's own data directory are refused. Inside an extra root, hidden paths, credential-shaped names (`auth`, `oauth`, `credentials`, `secret`, `token`, `password`, `api_key`) and `mcp.json`/`settings.local.json` are never served; the check runs on the opened descriptor's path. Elided citations (`…/Gift Deed/x.pdf`) resolve by unique suffix in the session folder, then in these roots. This is not a boundary against the token holder (the terminal is a full shell); it keeps the web route from serving the whole home directory. |
| `sessions.js` | tmux-backed agent and shell sessions (`tmux -L omp-web`). Every operation resolves the exact pane id before acting; chat input, keys, kill, and profile reload share a bounded per-session queue. Per-session state lives in `@omp_*` user options (folder/profile/type/status/status_at/activity/title/created/pinned/transcript/thinking/thinking_at/model/model_at — it dies with the session). Shell sessions stop after tmux opens its configured login shell; agent sessions launch OMP with the status extension. Lists reconcile the bounded title record and a cached 128 KiB transcript tail for agent sessions, so `/rename` and lifecycle status reach the dashboard even for live processes launched before the extension. `lastActivity` comes from tmux `session_activity`. |
| `extensions/session-status.mjs` | OMP lifecycle adapter. Session start, agent, ask, approval, retry/compaction, and shutdown hooks publish precise status plus a heartbeat into the owning tmux session without adding a sidecar process or state file. **Only the interactive top-level session publishes**: subagents run in-process with their own runner and inherit this extension plus `OMP_WEB_STATUS_TARGET`, so every handler guards on `ctx.hasUI`. Writes dedupe against the last value tmux accepted, so a failed write retries on the next transition. Auto-compaction additionally publishes a bounded `compaction` activity until `auto_compaction_end`. A successful terminal agent turn publishes Recently done, then the heartbeat settles it to Idle after five minutes unless new work supersedes it. `message_update` reasoning deltas publish a throttled one-line headline into `@omp_thinking`/`@omp_thinking_at`, cleared when text, a tool call, or the turn begins. |
| `transcripts.js` | Owned OMP JSONL discovery and bounded title reads; OMP remains the title writer and session record authority. The `@omp_transcript` tmux pin is a **hint, not an override**: resolution picks the most recently written transcript this session id owns (its profile directory, the legacy id directory, and every sibling profile directory), so a profile/model switch inside the TUI cannot strand chat on a dead file. Subagent transcripts live one level deeper and are never adopted. |
| `transcript-read.js` | Bounded incremental JSONL reader. Detects shrink/misalignment and same-offset rewrites with a 64-byte cursor anchor. Oversized records are scanned with fixed memory and skipped only after their newline is found; scan omissions are reported to the client. |
| `chat-project.js` | Pure event classifier/projection. Maps conversation records to bounded typed items, hashes full user text before truncating its preview, merges tool and hub-job lifecycle records, derives current runtime/Todo/active agents, and keeps reasoning and control-plane messages out of transcript prose. Changed-file summaries come only from structured successful edit/AST-edit result metadata. |
| `api/chat-routes.js` | Authenticated chat read/input endpoints. Immutable projector states are retained in an LRU/age-bounded checkpoint set (64 per session, 512 process-wide, 30 minutes), keyed by session, transcript identity, exact byte cursor, and cursor anchor. Unknown or rewritten cursors force a clean replay without one client invalidating another. |
| `api/git-status.js` | Five-second cwd-keyed git probe for the Chat runtime rail. It returns branch/upstream, ahead/behind counts, and tracked or untracked dirty-file count; non-repositories and git failures resolve to a neutral state without exposing file contents. |
| `config.js` | Env-driven config; PATH/locale injection for children; `sessionsDir` + `ompHome` for profile and transcript discovery. |
| `public/js/main.js` | ES-module entry: boot, wiring, app-level actions (kill/pin/reload). Views emit intent events (`session:pin`, `session:kill`, `meta:refreshed`, …); main owns them. `profile-info.js` renders the active profile's bounded role/model/effort projection in the header action menu. |
| `public/js/state.js` | Single mutable store (token/meta/sessions/current/sockets/view) + tiny pub-sub. The only shared mutable module. |
| `public/js/api.js` | REST client. Clones caller headers, adds `x-omp-web-token`, preserves `AbortSignal`, and lets the browser set multipart boundaries for `FormData`. It normalizes structured API failures and raises the auth gate on 401. |
| `public/js/voice.js` | Factory for the main-owned capability-gated MediaRecorder/transcription controller. Chat and mobile Terminal register separate buttons, status targets, and session-owned insertion callbacks. Starting, recording, stopping, and transcribing remain explicit button states; terminal transcription appends text without synthesizing Return. |
| `public/js/file-viewer.js` | Session-scoped modal viewer for linked local paths. Authenticated raw responses render Markdown/text, images, and PDFs; unsupported binary documents retain a download action. Blob URLs are revoked on close or replacement. |
| `public/js/session-status.js` | Shared normalization and accessible labels for lifecycle status. Sidebar rows and the active terminal title consume the same status semantics. |
| `public/js/terminal.js` | xterm init/fit, serialized output writes with byte acknowledgements, coalesced touch scrolling + absolute history scrubber, confirmed deferred-input settlement, WebSocket reconnection/identity guards, synchronized active-title lifecycle status, and compact-layout focus protection. Terminal connection health remains separate metadata; a closed socket adds a red ring without replacing the lifecycle fill color. |
| `public/js/quickkeys.js` | Quick-key toolbar plus the mobile Terminal composer: session-owned input drafts, attachment insertion, shared-controller dictation, Return submission, deferred-input settlement, and retry state. |
| `public/js/chat.js` | Chat poll/cursor lifecycle, reload epoch invalidation, adaptive active-turn refresh, and per-session optimistic sends. Failed or delivery-unknown messages remain visible with explicit **Retry** and **Edit**; authoritative echoes reconcile by full-text SHA-256 or, within the same send window, a whitespace-normalized full preview. Idle sessions poll at the normal cadence; live turn activity temporarily tightens refresh latency without introducing a second writer or event channel. |
| `public/js/chat/` | A centered safe-Markdown transcript, a 240-entry DOM history window with 200-entry paging, lazy nested tool details, compact visible tool-name/count receipts, message actions, a **Jump to now** control, a persistent current-workflow strip with expandable Todo + active agents, persistent live-intent/runtime metadata, and a composer with session-scoped drafts, voice input, image upload/drop, draft-aware send readiness, and compact-screen transcription that does not summon the software keyboard before the user chooses to edit. |
| `public/js/sidebar/` | `index.js` (search + one render key), `projects.js` (Needs you / Working / Pinned, folder groups that carry only their remaining sessions, and the collapsed **Not running** section), `activity.js` (age-bucket labels), `resize.js` (persisted desktop column width), `rows.js`, and one shared popover in `menu.js`. |
| `public/js/notice.js` | The single transient-feedback surface, rendered into `#copy-flash`. Every app-level action (pin, kill, restore, forget, reload, copy path) reports success and failure through it; no `alert()` remains. |
| `public/js/new-session.js` | Session creation shared by the modal and the landing composer: remembered folder/profile choice, message-derived session name, and the bounded `POST /api/sessions` call. |
| `scripts/check-events.mjs` | `npm run check:events`. Fails when a `public/js` module emits an event with no `get()` subscriber, or subscribes to one nothing emits — both previously shipped as silently dead buttons. |
| `public/js/paths.js` | The only path abbreviator. `~` means `$HOME` and nothing else — abbreviating the workspace root to `~` printed paths that do not exist (`~/omp-web` for `$HOME/workspace/omp-web`). Project surfaces show the workspace-relative segment and keep the real absolute path in the tooltip. `/api/meta` supplies `homeDir` for this. |
| `public/{base,sidebar,terminal,modals,chat}.css` | Split stylesheets: tokens+frame, sidebar rows/menus, terminal, modals, structured chat. CSS custom props in `:root` shared across views. |

## Structured chat event policy

The backend classifier is the security and fidelity boundary:

| OMP record | Projection | Browser component |
|---|---|---|
| `message/user` | `kind:user` with full-text SHA-256 plus bounded display text | Right-aligned user bubble with six-line/500-character **Show more** preview; optimistic sends carry **Queued**, and failed/unknown deliveries remain with **Retry** and **Edit** until reconciled or explicitly edited |
| `message/assistant` text | `kind:assistant` with bounded display text | Safe Markdown body: headings, lists, semantic blockquotes (including quoted lists), code, HTTP(S) links, and text-only inline/display TeX formatting; supported local file paths in inline code or Markdown links open the authenticated file viewer; truncated previews are labeled |
| assistant `thinking` blocks | `kind:thinking` with bounded (8 KB) text; consecutive blocks merge into one item, empty/redacted blocks drop | Rendered inline **inside the turn's tool-group disclosure**, in document order, so reasoning never splits one tool run into separate timeline rows; the collapsed summary carries a one-line headline (last `**bold**` span, else the first line) and a group with reasoning but no tools is labeled **Thought** |
| `thinking_level_change` | Bounded `derived.effort`; no timeline item | Runtime status shows the current effort for every provider and clears it on session exit; resumed runtimes missing a new event use the cached profile default only when its configured provider/model identifier matches the live runtime |
| (no record yet) after a reload | `derived.model`/`provider`/`effort` from the **launch model**, `modelSource: "launch"`, response only | The transcript names a model only when a reply completes, and OMP doesn't reliably write `model_change` at startup. So after a reload the rail showed "`<profile>` profile" (a cross-profile fork ends in `session_exit`) or the old runtime's model as if current (a same-profile resume has no exit record). Reload stamps `@omp_model`/`@omp_model_at` (the `--model` it passed, else the profile default); until the transcript names a model *after* that stamp, the rail shows the launch model in italic. Liveness comes from tmux status, not the transcript, because the old runtime writes its `session_exit` just after the relaunch. `modelAt` rides through `cloneState`. |
| assistant `toolCall` + `tool_execution_start` + `toolResult` | One upserted `kind:tool` | Calls in one active turn share a muted **Working/Worked** disclosure with visible tool-name/count and changed-file receipts plus accumulated tool time; expanding it reveals calls, then lazily creates args/results. Failures remain visible and the full summary remains in the accessible label and tooltip |
| structured successful edit result metadata | `changes[]` on its tool item | Bounded changed-file path/count summary; prose and tool arguments are never treated as evidence |
| assistant `stopReason:error|aborted` | `kind:error` | Persistent alert card with provider/session error |
| title/model/completed compaction/session-exit | `kind:event` | Slim timeline event; while auto-compaction is running, the lifecycle extension supplies **Compacting context…** through the live activity row before the completed record is written |
| Todo results / task calls / async-result job metadata | Derived state only | Persistent current-workflow summary above the composer; expansion exposes the Todo tree / active-agent roster and bounded omissions |
| `custom/todo_hud_state`; `custom_message` (`async-result`, `irc:incoming`, nudges, skill prompts) | Presentation/control-plane effects only; raw content dropped | No transcript prose |
| Unknown top-level records | Bounded generic event with a readable label (`mode_change` → "Switched to \<mode\> mode") | Slim timeline fallback |

The current-work indicator is turn-level, not only tool-level: a user message
starts `Thinking`, a running tool enriches it with tool/intent, settling the
last outstanding tool returns it to `Thinking`, and assistant
`stop`, `error`, `aborted`, or `session_exit` clears it. A session exit closes
the runtime epoch; later records copied into a reloaded profile open a new epoch
without reviving old model/provider/agents.

A completed transcript record is the only place reasoning is written, so a long
thinking turn would otherwise show nothing while it is the only thing happening.
The lifecycle extension therefore publishes a throttled (1s) one-line headline
into `@omp_thinking`; `sessions.js` surfaces it for 15s of freshness while the
session is `working`, and `api/chat-routes.js` substitutes it for the generic
`Thinking` intent only while no tool is running. It is an ephemeral tmux
option — never a sidecar file, never a second transcript.

OMP sessions publish `starting`, `working`, `waiting`, `done`, `idle`, or
`shell` into `@omp_status`, with a 30-second heartbeat in `@omp_status_at`.
Fresh lifecycle events are authoritative. A successful terminal agent turn
stays `done` for five minutes; new work cancels it immediately, and provider
errors/aborts settle directly to Idle. If publication is absent or older than
90 seconds, the server derives the last observable Idle, Working, Waiting, or
recently completed state from a cached, bounded 128 KiB tail of the owned OMP
transcript; the live pane command still determines Shell. This gives legacy
live sessions useful state without restarting them or scraping terminal ANSI;
missing or unparseable evidence remains `unknown`. Sidebar rows and the active
title use the same shared status normalizer and color classes: solid gray Idle,
solid blue Recently done, pulsing green Working, blinking amber Waiting, pulsing
gray Starting, solid purple Shell, and hollow gray Unknown. The written lifecycle
status remains in accessible labels and tooltips. Terminal connection health is
separate: the title indicator announces it alongside lifecycle state, and a
closed socket adds a red ring without changing the lifecycle fill.
`session_attached` remains independent and never changes the status color.
Agent sessions launch OMP through a non-interactive login-shell wrapper so
startup inherits the user's PATH without simulated typing. On normal exit the
wrapper revokes Chat by marking the pane `shell`, flushes input bytes accepted
during the OMP-exit race, and only then exposes a recoverable interactive
shell; failure to mark or flush leaves a non-interactive holding process
instead. Saved Chat transcript reads remain available in that state. Every Chat
text/key sink guards the write: legacy panes prove OMP through
`pane_current_command`, while wrapped panes (whose parent is the login shell)
prove it with a lifecycle status other than `shell` whose heartbeat is newer
than the 90-second staleness window. The guard never consults `@omp_type`:
sessions created before that option existed carry no type and would be refused
while OMP is running.
Status writes are serialized, capped at 1.5 seconds, and scheduled without
awaiting them in OMP lifecycle hooks; telemetry failure can neither delay a tool
nor terminate the OMP session.

The transcript follows new items only while its viewport is at the live tail.
Manual upward scrolling pauses follow and exposes **Jump to now**; returning to
the bottom manually or using the control resumes it. Session switches start at
the bottom. Terminal copy-mode/history scrolling is independent.

### Session types

- **Agent** is the default and launches OMP under the selected profile.
- **Shell only** appears only in the New session profile picker. It records
  `@omp_type=shell` and leaves tmux's `exec $SHELL -l` process untouched: no
  OMP session directory or transcript is created.
- Shell sessions are Terminal-only. Selecting one applies a session-local
  Terminal constraint without overwriting the persisted agent-session view
  preference; returning to an agent restores that preferred view. Shell
  selection hides Chat and profile reload controls and removes Reload profile
  from its sidebar menu. Authenticated Chat endpoints reject shell-only
  sessions, which never own an OMP transcript.
  On compact layouts, focusing the composer keeps the current-workflow strip
  visible above it; the active-only icon Stop control remains in the composer
  without competing for the textarea's cursor area.

### Chat lifecycle, bounds, and workflow

- The conversation and composer share the same centered reading axis. Live
  intent plus model/effort/provider/profile/cwd/context remain below the
  composer. An icon-only **Stop** control appears inside the composer only
  during active work. When Todo or agent state exists, a persistent strip
  immediately above the composer shows the current phase/task, progress, and
  active-agent count. Expanding it reveals the full Todo tree and active-agent
  roster; it stays visible while the compact composer is focused, is persisted
  as a user preference, and is dismissed by outside click or Escape. The
  runtime rail also shows the active worktree branch and compact dirty /
  ahead / behind state when the session folder is a Git repository; the UI and
  backend both cache that probe for five seconds.
- When the runtime derives an advisor note, a compact card renders collapsed
  (badge/guidance header only). A chevron button expands the card to show the
  full advisor text and collapses it again; an **x** dismisses the current
  note without affecting a later one. Expand state is gated by a separate
  `advisorSeenId` latch keyed to `advisor.id`, so it resets only when the
  advisor id changes — not on every render — and a new advisor id also clears
  any prior dismissal.
- Draft text and attachment trays belong to a session. Switching sessions
  restores each draft; sending or profile reload advances that session's
  attachment/draft epoch so a late upload cannot land in a newer draft.
- Optimistic user messages are kept per session. A successful POST stays
  **Queued** until the matching JSONL user record arrives. A rejected or
  indeterminate POST stays in the timeline with **Retry** and **Edit**; it is
  never silently replayed. Matching first uses a SHA-256 hash of the complete
  UTF-8 message. A bounded timestamp-owned fallback accepts a whitespace-
  normalized full preview because native multiline paste can normalize text
  before OMP records it; truncated previews never use that fallback.
- Long user messages collapse to a six-line preview capped at 500 characters.
  **Show more/less** preserves full-text Copy/Retry/Edit and survives same-id
  updates and history remounts; removal/session clear resets expansion.
  Copy/time icon actions sit outside the blue bubble, with explicit copy
  success/failure feedback and 44px compact-layout targets.
- Chat type is scaled to the app chrome: 13.5px/1.6 assistant prose and user
  bubbles on desktop (14px on compact layouts), 15.5px h1/h2, 12px code, and a
  13.5px composer that still rises to 16px on compact layouts so iOS does not
  zoom the field.
- A cold open replays the transcript in byte pages. Those pages are buffered
  and mounted once, already pinned to the tail, instead of painting each page
  and re-pinning; the buffer is bounded to 1.5s so a fast-writing session can
  never stay blank. The log scrolls instantly — no smooth animation. While a
  selected session is replaying, `#chat-loading` shows a shimmer placeholder;
  the `#chat-empty` landing copy is reserved for having no session selected.
- iOS keyboard open/close animates the viewport and Safari scrolls the log
  itself during that window, which used to read as the user leaving the tail
  (stuck **Jump to now** after sending). The compact chat pane is pinned below
  the live header; `--kb-inset` may lift it only while `#chat-input` owns focus.
  Focus/blur plus viewport triggers re-sync at +150/400/900ms, and focus loss
  clears a stale inset immediately. Scroll events inside a 450ms window around
  viewport resizes cannot flip followTail; sending always re-pins. Profile
  reload lives in the terminal header and sidebar menu only.
- Pending `ask` options remain read-only because JSONL does not expose the
  TUI's current selector position. **Answer in Terminal** switches to the
  authoritative control surface; Chat never guesses with relative arrow-key
  input.
- The terminal layer keeps real dimensions under the chat overlay for instant
  switch-back, but Chat mode makes the terminal canvas, mobile composer, and
  quick keys invisible and non-interactive. `#term-wrap`/`.content-host` also
  clip overflow, and window resizes refit xterm behind the overlay.
- The in-memory timeline may be long, but only a 240-entry window is present in
  the DOM. Earlier/later controls move by 200 entries. Tool call bodies are
  created only when their group and call disclosures are opened.
- Payload caps are explicit rather than silent: truncation chips label bounded
  text/arguments/results/changes, Todo/agent/ask panels report omitted records,
  and malformed or oversized transcript records produce attributed notices.

## Sidebar views (updated 2026-09-22)

- Desktop navigation defaults to 288px and is drag-resizable between 240 and
  480px (`#sidebar-resize`, persisted in `omp_web_sidebar_width`; double-click
  resets). Compact layouts keep the overlay/full-screen drawer at
  `min(420px, 100%)` and hide the resize handle, and raise interactive rows,
  search, and primary controls to 44px touch targets.
- One list, no view tabs. Order is **Needs you** -> **Working** -> **Pinned** ->
  every workspace folder -> a **Restore all N not running…** button. A session
  appears in exactly one place: an attention or pinned section wins over its
  folder.
- **Every folder is listed** — the workspace root (the configured
  `OMP_WEB_WORKSPACE`, shown as **Workspace**) first, then each top-level
  folder alphabetically. A folder with sessions is a collapsible group whose
  count is every row it lists: its live sessions, then its not-running sessions
  (dimmed ghost rows). A folder with none is one quiet line (dimmed until hover)
  whose menu offers **New session here**. Hiding empty folders read as lost
  work when a folder's last session ended (reverted 2026-09-23).
- **Restore all** confirms first, because each restore starts its own OMP
  process.
- **Moved projects.** `restorable()` flags a ghost whose recorded folder no
  longer exists (`folderMissing`) and, when exactly one listed folder has the
  same name, offers it (`relocatedFolder`). Such a ghost sits under the folder
  it moved to, its row reads "folder moved", and Restore (menu and detail view)
  reopens it there via `POST /api/sessions/restore {ids:[id], folder}`. The
  override applies only to a single-session restore, never to Restore all. A
  folder with no same-name match reads "folder missing" and its Restore is
  disabled. A failed restore names the session and the reason. `registry.remove`
  now keeps the forgotten list; it used to drop it on every kill or Forget,
  bringing forgotten sessions back.
- Search replaces grouping with one flat, created-order list of live matches,
  then ghost matches under a **Not running** heading, then folders whose *name*
  matches (so a project can be found to start in). `/` focuses search and
  Escape clears it.
- `renderKey` deliberately excludes `lastActivity`: every section sorts by a
  stable key, so including recency only forced repaints that pulled rows out
  from under a tap.
- **Pin** is tmux option `@omp_pinned`, changed through
  `PUT /api/sessions/:id/pin`. Pin dies with the session. Desktop ≥1100px may
  show a tmux window-count badge; compact layouts expose a persistent 40px
  action target. Session actions: Pin/Unpin, Reload profile…, Kill. Folder
  actions: copy full path, New session here. Every one of these reports through
  the shared notice toast (`public/js/notice.js`, rendered in `#copy-flash`).

## Auth model

- A token from `OMP_WEB_TOKEN` or the configured omp-web home's `token` file
  is required before the server listens. Setup creates a private token file;
  neither the server startup log nor doctor prints its value.
- **Static shell is public** (no secrets); **`/api` and `/ws` require the
  token**. The browser's REST wrapper sends `x-omp-web-token` and never puts
  credentials in API URLs. The WebSocket uses `?token=` because browser
  WebSocket construction cannot set custom headers; the server accepts either
  query or header at the gate.
- The client persists the token in `localStorage` (per-origin) and drops the
  one-time `?token=` bootstrap value from the address bar. A 401 shows the
  token-prompt gate.
- Browser API requests and WebSocket upgrades reject an Origin whose host
  differs from the request Host. Native clients without Origin still require
  the token. Reverse proxies must preserve the public Host header.
- This is trusted-owner access to a host shell, not a sandbox or multi-user
  service. Non-local use requires a trusted private network or secured HTTPS
  proxy. Provider credentials stay with OMP, not the browser.
- JSON callers set `content-type: application/json`; attachment uploads pass
  `FormData` without overriding `content-type`, allowing the browser to supply
  the multipart boundary.
- `Cache-Control: no-cache` on the static shell and first-party assets prevents
  stale responses. A loaded standalone PWA is still a long-lived document, so
  it polls authenticated `GET /api/version` without browser caching and
  compares the current `main.js?v=` value against its own loaded script. A
  mismatch reveals an **Update** control below the measured header boundary
  rather than disrupting an active terminal or overlapping header controls.

## Subscription usage

- The terminal header opens a compact **Subscription usage** popover containing
  every distinct provider, account, limit window, unit, reset, and
  unsupported-provider note returned by native `omp usage`; omp-web has no
  provider allowlist or fixed meter count.
- `GET /api/usage` invokes `omp usage --json --redact` for the default and each
  configured native profile at most once per minute. The same credential seen
  through several profiles collapses to one account, keyed on redacted native
  identity metadata (account/org/email) and falling back to the window-id
  signature; the freshest fetch wins, because per-profile fetches report
  slightly different amounts and reset timestamps. OMP owns credential lookup,
  OAuth refresh, provider discovery, usage adapters, and the native schema.
- The adapter emits only bounded provider ids, window labels/status, finite
  usage values/percentages, reset timestamps, and bounded notes. Account ids,
  emails, organization/plan metadata, credentials, disabled-credential detail,
  raw diagnostics, stderr, and the complete native payload never reach browser
  clients. Failure degrades to an unavailable state without affecting sessions.

## Mobile recovery

- The off-canvas compact sidebar drops its shadow while hidden, preventing the
  drawer shadow from darkening the left edge of Terminal or Chat.
- The PWA has an in-app reload control. It also reveals an **Update** control
  within 15 seconds of a shell change; reloads are safe because tmux keeps the
  native omp session alive.
- On iPhone standalone mode, the main panel and sidebar use CSS safe-area
  insets so toolbar and quick-key controls stay clear of the notch and home
  indicator. The main frame owns these insets once; the chat composer adds
  only its normal 8px compact padding, not a second bottom safe-area inset.
- The terminal has no horizontal compact-layout padding. `☰` opens the
  workspace/session drawer; phones use a full-screen drawer and tablets through
  1099px use a 420px overlay. Selecting a session closes it without focusing
  an input; tapping terminal or chat content also leaves focus unchanged.
  Persistent split-pane navigation begins at 1100px.
- Compact layouts use a visible native textarea that forwards typed and pasted
  text to the active terminal. The off-screen xterm helper is guarded from
  focus and virtual-keyboard input; only explicit input/keyboard controls open
  the keyboard.
- **Attach** keeps the native image picker in Terminal; Chat additionally
  accepts PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ODT/ODS/ODP, RTF, and common UTF-8
  text formats (TXT, MD, CSV/TSV, JSON, XML, YAML/YML, LOG). Each file is capped
  at 10 MiB. Documents require an allowed extension, compatible MIME, and
  format signature or strict UTF-8 without NUL; images retain MIME/magic checks.
  HTML, SVG, executable formats, and mismatches are rejected.
- Uploads use token-authenticated multipart POST and private session-scoped
  `~/.omp-web/attachments/` storage (0700 directories, 0600 files, opaque random
  names). Authenticated metadata returns the configured attachment root so the
  transcript can distinguish uploads from look-alike workspace paths. The
  upload response carries a sanitized original display name independently of
  the stored path. Bytes are unchanged: this is not a conversion or malware
  scanning service, and native OMP reader support determines usable content.
- Terminal and Chat attachment state is session-scoped; late uploads belong
  only to the draft epoch that started them. Terminal sends a safely quoted
  path to the native composer; Chat appends a JSON-quoted path token to its
  draft and supports file drag/drop. Image thumbnails and document filename
  chips last until removal/send/reload; only image previews allocate object
  URLs. Sent image attachment paths render as lazy, authenticated transcript
  thumbnails; their object URLs and requests are released when the bounded
  message window detaches them. Selecting a thumbnail opens the existing in-app
  file viewer.
- Supported local paths rendered as inline code or Markdown links in assistant
  messages become file buttons. Preview requests keep the token in the authenticated header,
  never the URL. Relative paths resolve from the live session workspace first.
  If missing there, the server checks first-level folders under the configured
  workspace root and opens the file only when exactly one folder contains that
  relative path; ambiguous matches require an explicit path. Absolute paths
  remain limited to the active session workspace or the same session's
  attachment directory. Canonical realpath checks reject traversal and symlink
  escapes; the opened file descriptor is checked again so a directory swap
  cannot redirect the streamed bytes after validation. Markdown/text, images,
  and PDFs render in-app according to the canonical response MIME; other
  allowlisted document types expose a download action.
- Terminal wheel, touch drag, and explicit Scroll ↑/↓ controls enter tmux copy
  mode and scroll the exact native pane. A capture-phase wheel handler prevents
  xterm's alternate-screen fallback from translating wheel motion into Up/Down
  input that navigates OMP prompt history. Touch movement likewise cancels the
  browser/xterm default while preserving the existing selection gesture path.
  Movement distance is calibrated to rendered row height. The client keeps one
  request in flight, coalesces later distance, and replaces unsent work
  immediately when direction reverses; each relative request is one atomic tmux
  command capped at 24 rows. A slim draggable history rail uses tmux
  `history_size`/`scroll_position`; absolute targets replace intermediate
  targets and Live exits copy mode.
- Terminal input and session switches drain the active copy-mode request,
  discard stale scroll intent, and cancel copy mode before releasing deferred
  input or starting work on another pane. Deferred drafts/attachments receive
  a confirmed delivered/failed callback. Failed input remains explicitly
  unsent for user retry; it is never silently replayed on reconnect.
- Terminal selection, copy, scroll-status, and history-scrubber overlays are
  explicitly suppressed while the chat overlay is active; the transcript uses
  native browser scrolling.
- Long-pressing shows immediate progress feedback, then opens Open/Copy for a
  terminal URL or selects the complete logical line for Copy. Two-finger drag
  still selects arbitrary text; draggable endpoints refine it. Successful
  copies show an explicit confirmation and clear selection only after clipboard
  success.
- The quick-key strip is controlled by a keyboard icon beside **Attach** in the
  composer. It starts expanded on every page load; collapsing it removes the
  entire strip for the current page and returns all of that height to the
  terminal without carrying stale layout state into the next load.
- `visibilitychange`, `pageshow`, and `online` replace the active WebSocket
  attachment after a mobile browser returns from suspension. Stale socket events
  cannot overwrite the replacement connection state.

## Terminal transport reliability

- The WebSocket resolves the requested session to an exact tmux pane before
  spawning the attachment. Session targets use `=omp_<id>`; pane and
  session-option targets use `=omp_<id>:` so tmux cannot prefix-match another
  session. Stale connection events are ignored unless socket, session id, and
  connection generation still match.
- Browser output is written to xterm serially, combining adjacent pending
  chunks from the same socket/session/generation into batches up to 64 KiB.
  Reset markers remain ordering barriers. Waiting for a separate xterm
  callback per network chunk caused visible history replay when revealing TUI.
  With `flow=ack`, each batch's UTF-8 byte count is acknowledged only after its
  write callback. The server pauses PTY reads at 1 MiB outstanding and resumes
  at 512 KiB, bounding output queued between node-pty and the renderer.
- Input received during PTY attachment startup is bounded to 64 KiB. Backend
  mutations that can race on a pane—chat text/keys, kill, and profile
  reload—share a bounded per-session queue. Profile reload invalidates that
  session's chat, quick-key, draft, and attachment caches even when it is not
  selected; the visible terminal buffer is reset when the reloaded session is
  active.

## Session persistence boundary

- tmux is the source of truth for session liveness, and per-session metadata
  (`@omp_folder`, `@omp_profile`, `@omp_type`, `@omp_status`, `@omp_title`,
  `@omp_transcript`, …) lives in tmux user options that die with the session
  (`sessions.js`). The **one sanctioned durable exception** is
  `<OMP_WEB_HOME>/sessions.json` (`registry.js`, `config.registryFile`): a
  write-through `{entries, forgotten}` record. `entries` is the durable
  live-set (`id/folder/profile/type/title/created/pinned`, no runtime status)
  used to offer ghost restore after a tmux-server death; `forgotten` is a
  bounded list of ids the operator explicitly dismissed. The registry never
  auto-resurrects sessions and is never read for live behavior; tmux stays
  truth.
- A Mac reboot or `tmux -L omp-web kill-server` therefore destroys live
  sessions **unrecoverably by design**: the OMP processes, their panes, and
  every `@omp_*` pin vanish together. Owned JSONL transcripts under
  `OMP_WEB_SESSIONS_DIR` (default `~/.omp/web-sessions/<id>/`) survive on disk
  and remain readable history, but they can never be reattached — a recreated
  session is a new session that may resume the same transcript directory.
- A process supervisor keeps the **node server** alive, not the tmux server.
  On macOS a user LaunchAgent with `KeepAlive` + `RunAtLoad` that runs
  `node <checkout>/server.js` and logs to `~/Library/Logs/omp-web.log` works
  well. Restarting that service (for example `launchctl kickstart -k
  gui/$(id -u)/<label>`) preserves tmux sessions because the tmux server is a
  separate process tree; only the death of the tmux server itself loses them.
  Static files apply on next request; server-side changes need a restart.
- `sessions.js bootstrap()` keeps the server configured where possible
  (`exit-empty off`, `window-size latest`, `default-command exec $SHELL -l`,
  and `terminal-features[0]` with `sync`) so an otherwise-empty server survives
  to be configured. It never recreates
  sessions, and nothing in the boot path resurrects them: no auto-resurrect,
  ever. Browser WebSocket drops reconnect (`terminal.js`
  `visibilitychange`/`pageshow`/`online` handling); a server restart only
  requires reopening the session at the same URL.
- **Synchronized output.** OMP repaints about 30 times a second while working
  and wraps each frame in DEC 2026 synchronized-update markers. tmux forwards
  those to a client only if its terminal features include `sync`, and the
  default for `xterm*` doesn't, so xterm.js painted every half-drawn frame and
  the TUI flickered. `bootstrap()` sets `terminal-features[0]` (indexed, so it
  is idempotent across omp-web restarts) and xterm.js 6 honours the markers.
  Features are fixed at attach time, so an already-open tab picks it up on its
  next reconnect.
- `omp-web doctor` ends with a warning-only persistence check: tmux server
  holding 0 `omp_` sessions while transcript-backed directories exist prints
  `WARN tmux session persistence` with counts of both. A healthy server with
  live sessions prints `ok` and never warns. Loss never fails doctor's exit
  code — after a restart it is expected, not a broken prerequisite.
- `omp-web recover --list` is the sanctioned, explicit-only recovery helper.
  It prints up to 20 transcript-owned candidates, newest first (id, title,
  size, path), and recreates nothing. Re-creation is always explicit through
  the New session dialog or `POST /api/sessions`.
- `sessions.js create()` launches resume-aware: when the recreated id already
  owns a substantive transcript under the target profile, the pane starts
  with `-r <largest-substantive-file>` (same selection rule as reloads —
  largest non-sanitized `.jsonl` at least 5 KiB, fresh-empty launches
  ignored, never another profile's directory). A brand-new id with an empty
  dir keeps the original fresh launch. `create()` omitted `-r` historically
  because a new id had nothing to resume; after tmux-server loss the same id
  carries surviving transcripts, and omitting `-r` dropped the operator at
  the resume picker instead of the work. The request body carries explicit
  intent: `{"resume":true|false}`, defaulting to true when history exists
  (`resume:false` forces a clean start). Shell sessions never resume.
- **Ghost restore** (post-restart path): `GET /api/sessions` carries an
  additive `restorable` array composed by `sessions.js restorable()` from two
  sources, each carrying a `source` field — registry entries with no live
  tmux session (`source: "registry"`) and transcript-backed directories that
  are neither live nor registered (`source: "transcript"`; substantive owned
  transcript ≥ 5 KiB **and** a recorded cwd; ids without a resolvable folder
  are omitted and stay recoverable via `omp-web recover --list`). The
  registry's `forgotten` id list suppresses transcript-fallback ghosts only —
  registry-sourced ghosts are unaffected — is capped at `FORGOTTEN_LIMIT`
  (200 ids, oldest dropped first), and is cleared for an id by `upsert()`, so
  a restored or recreated session reappears normally. The sidebar renders
  dimmed ghost rows under their folder (row menu: Restore / Copy folder
  path / Forget) with a **Restore all** banner; clicking a ghost row opens a
  detail view in the main pane (`#ghost-mode`: full folder path, type/profile,
  history source, activity dates, Restore / Copy folder path / Forget) so the
  restore decision has room. Selecting a ghost is mutually exclusive with a
  live session; restoring a single ghost opens it live.
  `POST /api/sessions/restore` accepts `{"ids":[...]|"all"}`, restores
  sequentially with 750 ms pacing, reuses `create()` (agent restores resume
  with `-r`, shells start fresh), re-applies saved titles/pins, and returns
  per-id `{ok, session|code}` — one failure never aborts the batch.
  `DELETE /api/sessions/:id/ghost` calls `sessions.js forgetGhost(id)`: it
  drops a registry entry, or marks a transcript-fallback ghost forgotten via
  `registry.forget(id)`, or throws `ENOSESSION` when neither exists (the
  route maps that to 404). Neither path ever deletes a transcript. `list()`
  also adopts live sessions missing from the registry (never the reverse:
  registry-only entries are ghosts, never auto-created).
- `omp-web doctor`'s persistence check additionally reads the registry: a
  corrupt file warns and degrades to transcript discovery; 0 live sessions
  with a non-empty registry warns naming the restorable count and points at
  the sidebar **Restore all** action. Exit code semantics unchanged (0).

1. `tmux -L omp-web ls` → `no server running` or empty, while transcript
   directories exist and the server's service shows a recent start: **reboot/tmux-kill loss**. Runtime state is gone by
   design; open omp-web and use **Restore all** (or click a dimmed ghost row
   for its detail view with per-ghost Restore) to recreate the registered
   sessions with their saved history. Sessions absent from the ghost list
   are recoverable candidates only via `omp-web recover --list`.
2. Sessions visible under a different socket but not in the dashboard: check
   `OMP_WEB_TMUX_SOCKET` in the server's environment against the shell
   (`echo ${OMP_WEB_TMUX_SOCKET:-omp-web}`) and compare
   `tmux -L <other-label> ls`. That is a **socket mismatch**, not loss.
3. `tmux -L omp-web ls` shows `omp_*` names but authenticated
   `GET /api/sessions` returns `[]`: suspected **parse/list bug**. Capture
   both outputs verbatim and report them; do not restart the server first,
   since a restart cannot fix parsing and may confuse the evidence.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `OMP_WEB_HOST` | `127.0.0.1` | Listen host. Set `0.0.0.0` for LAN access; every request still needs the token. |
| `OMP_WEB_PORT` | `7799` | Listen port. |
| `OMP_WEB_WORKSPACE` | `~/workspace` | Root for the folder picker. |
| `OMP_WEB_EXTRA_ROOTS` | empty | Colon-separated extra folder trees (e.g. `~/private`). Their children are listed after the workspace folders as `<root name>/<folder>`, and cross-project file links search them too. Discovery only: sessions could always run in any folder. |
| `OMP_WEB_OMP_BIN` | `omp` | omp binary. |
| `OMP_WEB_PROFILES_DIR` | `~/.omp/profiles` | Profile picker source. |
| `OMP_WEB_TMUX_SOCKET` | `omp-web` | Dedicated tmux server label. |
| `OMP_WEB_ATTACHMENTS_DIR` | `~/.omp-web/attachments` | Private, session-scoped attachment storage. |
| `OMP_WEB_TOKEN` | *(file)* | API and WebSocket access token; falls back to `~/.omp-web/token`. |

## Decisions & gotchas (learned the hard way)

- **node-pty prebuilt `spawn-helper` loses its exec bit on install** ->
  `posix_spawnp failed`. A `postinstall` hook `chmod +x`es it.
- **launchd has a thin env**: must inject PATH (Homebrew) and a **UTF-8 locale**
  -- without a locale, tmux mangles its tab-separated `-F` output (broke session
  parsing) and omp loses Unicode rendering.
- **One type scale across surfaces.** The transcript is the only long-form
  reading surface, but at 14.5px prose and 16px bubbles it looked like a
  different application next to the 11–13.5px chrome. `--chat-text` in
  `base.css` drives transcript prose, user bubbles, and the composer; the
  mobile composer keeps an explicit 16px so iOS does not zoom on focus.
- **`~` is `$HOME`, never the workspace root.** Abbreviating
  `$HOME/workspace/omp-web` to `~/omp-web` printed a path that does not exist.
- **`.modal { display:flex }` overrode the `hidden` attribute** (author rule
  beats UA `[hidden]{display:none}`), leaving modals permanently visible;
  fixed with `.modal[hidden]{display:none}`.
- **Per-origin token**: every origin (localhost, a LAN IP, a reverse-proxy
  hostname) has its own `localStorage`, so the token is entered once per
  origin (the gate handles it).
- **Run it where OMP lives.** The server needs the host's `omp` binary,
  `~/.omp` accounts and profiles, and the workspace; a remote container host
  cannot serve it.
- **Subagents share the OMP process and inherit loaded extensions**, each with
  its own runner and the parent's env. `extensions/session-status.mjs` was
  therefore stomped by every `task` call (subagent `session_start` -> `idle`,
  its `agent_end` -> `done`, then its 30s heartbeat re-asserting that), which
  is what made the Working/Idle dot stick or flip mid-turn. Only `ctx.hasUI`
  separates the interactive top-level session from subagent runners; every
  handler that publishes status guards on it.
- **Dedupe status writes against what tmux accepted, not what was intended**:
  recording the intent before the write meant one failed `tmux set-option`
  suppressed every retry until the next heartbeat.

## Known limitations / TODO

- Open-source polish: `LICENSE`, `.env.example`, generalize host paths.
- Multi-client terminal sizing uses tmux `window-size latest` (shared view).
- **TODO — Settings panel redesign + basic OMP config editing.** The panel is
  overloaded (a full read-only dump of every profile's roles) while doing little.
  Wanted: set per-profile model roles with an effort picker, and similar basic
  OMP config, from Settings. This reverses the current "profiles are read-only,
  native OMP owns them" rule, so it needs its own design first — in particular,
  writing through the `omp` CLI (e.g. `omp --profile=<name> config set …`) rather
  than editing `config.yml` directly, so omp-web never diverges from what OMP
  believes.
