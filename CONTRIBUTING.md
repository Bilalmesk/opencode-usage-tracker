# Contributing

Thanks for helping improve the OpenCode Usage Tracker. This project is a
single-process, dependency-free Node app: `server.mjs` reads OpenCode's local
SQLite database and serves a static dashboard.

## Ground rules

- **Never commit credentials or usage data.** `tracker.config.json`,
  `.console-sync.json*`, `*.log`, and anything containing a Console cookie,
  bearer token, organization id, email, or session id must stay out of git
  (they are already in `.gitignore`).
- **Never invent quota.** The free-tier cap is unpublished. Go meters and
  Console activity are exact snapshots; external providers only expose local
  usage. Do not add a "remaining quota" for a provider that has no API.
- **No dependency or build step** unless it is clearly necessary. The app uses
  `node:sqlite`, `node:http`, and vanilla HTML/CSS/JS.
- Keep the tracker **read-only** with respect to OpenCode: open the database
  read-only and never write into `~/.local/share/opencode`.
- Do not add IP rotation, proxy evasion, or other limit-bypass features.

## Requirements

- Node.js 24 or newer (Node 24 LTS recommended).
- No `npm install` is required; there are no runtime dependencies.

## Run it

```bash
node server.mjs --open
# dashboard: http://127.0.0.1:4319
# widget:    http://127.0.0.1:4319/compact
```

For an isolated instance, use env vars:

```bash
PORT=4400 OPENCODE_DB=/path/to/opencode.db node server.mjs
```

## Tests

```bash
npm test
```

The suite has two parts:

- `test/syntax.test.mjs` — `node --check` for the server and compiles both
  inline page scripts.
- `test/smoke.test.mjs` — builds a temporary synthetic SQLite database
  (`test-support/fixture.mjs`), starts the server on an ephemeral port, and verifies
  the free/Go/external-provider API, CSVs, dashboard, widget, and that no
  credential fields leak.

Useful env vars for tests:

- `PORT=0` — the server prints the real port it bound to.
- `TRACKER_CONFIG` — alternate config path.
- `OPENCODE_DB`, `OPENCODE_LOG` — alternate data sources.
- `OPENCODE_CONSOLE_STATE` — alternate `.console-sync.json` path, so tests
  never read your real Console cache.

Please add or update a fixture when you change classification, aggregation, or
an API shape. A bug fix without a regression test is likely to be asked for
one.

## Project map

| Path | Purpose |
| ---- | ------- |
| `server.mjs` | SQLite reader, classification, free/Go/all aggregation, Console sync, HTTP API |
| `public/index.html` | Dashboard markup, CSS, and client render functions |
| `public/compact.html` | Compact widget |
| `test-support/fixture.mjs` | Synthetic OpenCode database |
| `test/smoke.test.mjs` | End-to-end API/UI smoke test |
| `test/syntax.test.mjs` | Offline syntax checks |
| `.github/workflows/ci.yml` | CI on pushes and pull requests |

## Adding a provider

Provider ids come from OpenCode's `model.providerID`. Classification lives in
`classify()` in `server.mjs`:

- `opencode` + free model → `free`
- `opencode-go` / `opencode-go-*` → `go`
- `opencode` + paid model → `zen`
- everything else → `external`

For a friendlier name, add an entry to `PROVIDER_NAMES` (for example
`"merge-gateway": "Merge Gateway"`). Unknown ids are title-cased automatically,
so a missing name is cosmetic, not a functional bug.

External providers have **local usage only**. Do not add a fake “remaining
quota”; if a provider exposes a public usage endpoint, add it as a separate,
clearly labelled source.

## Changing the UI

- Both pages are self-contained: inline CSS and a single inline script.
- Keep the render functions dependency-free and defensive: API fields may be
  absent when a feature is disabled or a sync has not run yet.
- Test at narrow widths; the provider tables scroll horizontally and the
  topbar wraps.
- Respect `prefers-reduced-motion` and keep focus-visible styles.
- Prefer `textContent` over `innerHTML`; all data is local but may contain
  arbitrary model/provider names.

## Pull requests

1. Open an issue first for large behaviour changes.
2. Keep the change focused and describe the user-visible effect.
3. Run `npm test` and `npm run check`.
4. Update `README.md` for new endpoints, fields, env vars, or quota sources.
5. Include a screenshot for visual changes when possible.
6. Confirm your diff contains no config, cookie, database, or sync-state file.

CI runs on every pull request with Node 24: syntax check, inline-script
compilation, and the synthetic-database smoke test.

## Reporting a bug

Include:

- tracker version (`package.json`) and Node version
- the **shape** of `/api/usage` with secrets removed (or the failing assertion)
- whether Console sync is configured, and which `providerID`/model is involved
- steps to reproduce, ideally with a synthetic row rather than your real data

Never paste a Console cookie, bearer token, `tracker.config.json`, or
`.console-sync.json` into an issue.
