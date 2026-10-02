# AGENTS.md

omp-web is a web console that streams native `omp` TUI sessions over tmux and
node-pty, served as static files by a small Node server. There is no build step.
Read `README.md` and `docs/architecture.md` first; UI work follows
`docs/design-system/`.

If an `AGENTS.local.md` exists next to this file, read it before starting. It
holds the rules of the environment this checkout runs in and is never committed.

## Commands

```bash
npm ci                                                  # install (keeps the node-pty postinstall)
npm start                                               # run the server from this checkout
node --check server.js                                  # syntax-check a CommonJS backend file
node --input-type=module --check < public/js/<file>.js  # syntax-check a browser ES module
npm run check:events                                    # every emitted event has a subscriber
```

There is no test suite by design. Verify with syntax checks and a real browser
against a running server, at desktop width *and* at 390px mobile width. Files
under `public/` are served on the next request; changes to `server.js`, `api/`,
`sessions.js`, or `config.js` need a server restart.

## Non-negotiables

1. **No build step, bundler, or framework.** Vendored static files plus plain
   Node: CommonJS backend, native ES modules in the browser. If a change seems
   to need a bundler, restructure it instead.
2. **`public/js/state.js` is the only shared mutable module.** Other modules
   read `state` and `emit` intent events; `main.js` owns the actions behind
   them. Views never import or mutate each other.
3. **Every `emit` has a `get` subscriber in `main.js`.** An event without a
   listener fails silently; wire both in the same change.
4. **tmux is the source of truth.** Session liveness lives in tmux; per-session
   metadata lives in `@omp_*` tmux user options so it dies with the session.
   Never add a sidecar state file.
5. **No new runtime dependencies** without a reason vendored code can't cover.
   Keep the `node-pty` postinstall hook.

## Layout

| Area | Rule |
|---|---|
| Backend | One concern per file: `server.js` is HTTP, static, and the WebSocket bridge; routing is `api/routes.js`; shared HTTP helpers `api/util.js`; tmux logic `sessions.js`; env config `config.js`. A file past ~200 logic lines needs refactoring. |
| Frontend | One concern per module under `public/js/`; sidebar views in `public/js/sidebar/`. `main.js` is wiring and app-level actions only, no rendering. |
| CSS | Split by surface (`base`, `sidebar`, `terminal`, `modals`, `chat`); design tokens are custom properties in `:root` in `base.css`. |
| DOM | Builders return elements (`dom.js` `elem()`); no `innerHTML` with unescaped dynamic values (use `escapeHtml`). Every new element id goes in `initDom()` in `dom.js`. |
| Ids | Existing element ids are API. Rename or remove one only by migrating every referencing module in the same commit. |

## Conventions

- Backend errors carry `e.code` (`ENOSESSION`, `EEXIST`, `ENOTFOUND`, ...);
  `api/util.js` maps code to HTTP status in one place. Add new codes there,
  never a second mapping.
- Sidebar folder and status rows sort by the stable `created` key. tmux
  `session_activity` changes on every attach and would reshuffle rows under the
  cursor. The Recent section is the one activity-ordered list: it duplicates
  rows (they stay in their folders) and freezes its order while the sidebar is
  hovered or focused, repainting only once released.
- Every shipped frontend change bumps the `?v=` query for that file in
  `public/index.html`, or browsers keep the stale asset.
- Comments explain why (invariants, tmux quirks, iOS workarounds), never what.
- Auth is a token sent as a header or query parameter, plus a same-origin check
  on `/api` and `/ws`. Never switch it to cookies or relax the origin check,
  and verify the 401 path after any auth change.
- The mobile layout is a first-class surface: touch scroll, quick keys,
  safe-area insets, the full-screen drawer, and the visible `#mobile-input`
  textarea (xterm's hidden helper doesn't reliably raise the iOS keyboard).

## tmux details that must not drift

A dedicated socket (`config.tmuxSocket`), `window-size latest` plus
`aggressive-resize on`, `default-command "exec $SHELL -l"`, `status off`, a
UTF-8 locale for every tmux call, and `sync` in `terminal-features` (without it
full-screen TUIs flicker). To unset a tmux option use
`set-option -t <target> -u <opt>`; `unset-option` does not exist.

## Pitfalls

- A wrong relative import in an ES module (e.g. `./dom.js` from
  `public/js/sidebar/`) shows up only as "Failed to fetch dynamically imported
  module". Check import paths first.
- Check a diff against the contract it was given (ids, markup shape), not
  against its summary.
