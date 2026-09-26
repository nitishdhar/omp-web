# omp web - design system

Mission control for many parallel OMP agent sessions, running on a Mac at
`127.0.0.1:7799` and over a VPN. Two views over one tmux-owned session:
**Terminal** (full-fidelity xterm passthrough) and **Chat** (a structured read
projection of the session's own JSONL).

Source of truth: the repo at `~/workspace/omp-web`. These pages mirror the real
`public/*.css` - they are not a parallel invention.

## Design language: quiet console

Dense, calm, typographic. This is an operator console, not a chat app.
Information density is a feature; chrome is not. Every surface shares one
header grammar, one dot grammar, one keyboard grammar.

- **Foundations / Color and surface tokens** - the token contract from `base.css`.
- **Foundations / Typography** - the shipped Inter Variable scale, JetBrains Mono values, and 760px measure.
- **Foundations / Status and attention grammar** - seven states, one priority order.

## Surfaces

- **Navigation / Sidebar** - 288px, text-first rows, Needs you before Pinned.
- **Shell / Header and terminal** - 56px header, destination-labelled mode toggle.
- **Chat / Transcript** - message silhouettes, send states, boundaries, empty state.
- **Chat / Tool calls and receipts** - one collapsed row per turn, lazy detail.
- **Chat / Composer, runtime and workflow** - the mission-control input.
- **Surfaces / Dialogs and file viewer** - one card, one backdrop, one contract.

## Patterns

- **Patterns / Attention system** - the north star and its four escalating channels.
- **Patterns / Compact and mobile** - 390px triage, 44px targets, 16px inputs.
- **Patterns / Constraints behind the design** - what the architecture forbids.

## Hard constraints

No build step, no framework, no bundler - native ES modules, static-served.
`state.js` is the only shared mutable store. Views emit events, `main.js` owns
actions, and every event ships with its subscriber. Element ids are API. tmux
options and sessionStorage are the only state stores. Dark and light share one
token contract; the terminal stays dark in both themes.

## Working on this

These pages are generated. `build.py` holds the shared token block, the preview
chrome, and one `page()` call per card - edit it, then run `python3 build.py`
from this directory to rewrite every HTML file in place. Editing the HTML
directly works for a quick look but is overwritten on the next build.

Each file's first line is a `<!-- @dsCard group="..." -->` marker. The published
copy lives in the claude.ai design-system project **omp web**
(`633d0cdc-cb30-48a3-9926-5e0a5feed8e1`); pushing a change means uploading the
same relative paths to that project.

## Status

Phases 0-6 of the 2026-09 UX refresh are shipped and live. Remaining by choice:
mobile approval bottom sheet and edge-swipe drawer.
Physical iOS verification is still open.
