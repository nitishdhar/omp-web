# Contributing to omp-web

Branch + PR flow: never push `main` directly. Open a pull request from a
topic branch; `main` must always be deployable.

How work goes: try risky server changes on a dev instance first
(`OMP_WEB_PORT=7812 OMP_WEB_TMUX_SOCKET=omp-web-dev node server.js`, stop when
done), run the checks below, curl the instance's own port for `200`, and verify
in a real browser at desktop width and 390px mobile. `AGENTS.md` is the
contract (module boundaries, tmux as source of truth, no build step);
`docs/architecture.md` is the spec.

Verify every change with all four before opening the PR:

```sh
node --check <changed backend files>
node --input-type=module --check < public/js/<changed>.js
npm run check:events
npm run doctor
```

`check:events` must stay green: every emitted event needs a subscriber in
`main.js`. Frontend changes also need a real browser pass at desktop width
and 390px mobile — there is no test suite by design.

Shipped frontend files get a `?v=` bump in `public/index.html`, one per
changed file, or browsers keep the stale asset. Backend changes
(`server.js`, `api/`, `sessions.js`, `config.js`) need a server restart;
`public/` files go live on reload.
