---
name: artifacts
description: Use when asked to make or update a page, tracker, dashboard, report, small web app, or artifact the user can open in a browser.
---

# Artifacts

An artifact is a small static web page that omp-web serves at a private link.
The user opens it from omp-web's Artifacts gallery or straight from the link
(phone, chat message). You build it once; later runs update its data.

Everything goes through the `omp-web artifact` command. Installing omp-web
puts `omp-web` on `PATH` through `~/.local/bin`. If `omp-web` is still not on
`PATH`, run `node <omp-web install folder>/bin/omp-web.js artifact ...`.

## 1. Look before you create

```bash
omp-web artifact list
```

If an artifact already covers the request, update it. Never create a second
one for the same purpose.

## 2. Create one from a template

```bash
omp-web artifact new <slug> --title "To-do" [--description "..."] [--project /abs/folder] [--template list|table|cards|blank]
```

- `slug`: lowercase letters, digits, dashes; at most 40 characters.
- `--project`: the folder this artifact belongs to, when there is one.
- It prints the artifact folder and its link. `omp-web artifact path <slug>`
  prints the folder again later.

Each folder holds `artifact.json` (the manifest), `index.html`, `app.js`,
`app.css` and `data.json`.

## 3. The page renders data; you change data

Keep layout in `index.html`/`app.js`/`app.css` and every fact in `data.json`.
Routine updates rewrite `data.json` only. Template data shapes:

- **list**: `{"title", "updatedAt", "sections": [{"title", "items": [{"text", "detail"?, "due"?, "done"?, "tag"?, "link"?}]}]}`
- **table**: `{"title", "updatedAt", "columns": [{"key", "label"}], "rows": [{"<key>": value, ...}]}`
- **cards**: `{"title", "updatedAt", "cards": [{"title", "body"?, "meta"?, "link"?}]}`
- **blank**: `{"title", "updatedAt"}`; write your own `render()` in `app.js`.

`updatedAt` is an ISO timestamp (`2026-01-09T08:00:00Z`); `due` is a date or
timestamp. Links render only for `http(s):` and `mailto:` URLs.

If you change `app.js`, escape all text: build elements with the template's
`h()` helper or `textContent`. Never put data into `innerHTML`.

## 4. Write atomically, then bump the time

A page can load `data.json` at any moment, so never leave it half written:

```bash
dir=$(omp-web artifact path <slug>)
# write the complete new JSON to "$dir/data.json.tmp", then:
mv "$dir/data.json.tmp" "$dir/data.json"
omp-web artifact touch <slug>
```

Set `updatedAt` in `data.json` to now on every update; `touch` bumps the
manifest's time shown in the gallery.

## 5. Check, then share the link

```bash
omp-web artifact check <slug>   # exit 1 on errors; fix them, re-run
omp-web artifact url <slug>
```

End your reply with the URL from `omp-web artifact url <slug>`, exactly as
printed. It is already absolute and points at an address other devices reach
(the public address, else Tailscale, else the local network), so it opens on
the user's phone. Never rewrite its host or prefix it with anything.

## Updating from a routine

A scheduled prompt can finish with a line like: "Finally, update the `todo`
artifact's data.json with this summary (artifacts skill) and include its
link." Do steps 1, 3, 4 and 5: list to find it, rewrite `data.json`
atomically, `touch`, `check`, end with the `url`.

## Limits

- Static files only: html, css, js, json, txt, md, svg, images, woff2.
  No server code, no write-back: the page cannot save state (localStorage and
  cookies are blocked). The source of truth is `data.json`.
- No external URLs: the page may load only its own files. CDN scripts, fonts
  and remote fetches are blocked; vendor any library into the folder.
- No secrets. Anyone holding the link can read every file in the artifact.
- Dotfiles are never served; symlinks must stay inside the folder; 20 MB per
  artifact.

## Where artifacts live

`<OMP_WEB_HOME>/artifacts/<slug>/` (by default `~/.omp-web/artifacts`, or
`OMP_WEB_ARTIFACTS_DIR`). `omp-web artifact path <slug>` prints the exact folder.
