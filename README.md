# OpenCode Usage Tracker

[![CI](https://github.com/Bilalmesk/opencode-usage-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/Bilalmesk/opencode-usage-tracker/actions/workflows/ci.yml)

A local, read-only dashboard for **OpenCode free-tier, Go, Zen, and external-provider usage**.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests, and PR rules.

It answers these questions:

- **Free tier:** how many free-model requests has this machine made in the
  current 24h bucket, when was the last refusal, and when does it reset?
- **Go plan:** how much of the exact 5-hour / week / month money meters is
  used, when does each reset, and what has the current billing period consumed
  in requests, tokens, and list cost?
- **Everything else:** what did this machine use through **Zen pay-as-you-go**
  or **any external provider** (Anthropic, OpenAI, Google, OpenRouter, Groq,
  GitHub Copilot, …), in requests, tokens, and OpenCode-reported cost?
- **History:** what did this machine use per UTC day, per model, and per
  session — across every detected plan and provider?

The tracker reports **exact local observations**, the **server-confirmed reset**
from OpenCode's own 429 responses, the **exact Go meters and period activity**
from Console, and the **exact account-wide free daily rollup** from Console's
CSV export. It does not invent a free-tier quota: that cap is a deployment
secret, is counted **per network**, and no remaining free-tier count endpoint
exists. Go is different: its money meters are exact and available.

Go detection is automatic. The tracker recognises
`providerID = "opencode-go"` in the local database, so Go usage appears even
before any cookie is configured; Console adds the exact money meters.

![widget](https://img.shields.io/badge/dashboard-local%20only-8b5cf6)

## Run it

Requires **Node.js 24+**. It uses the built-in `node:sqlite` module, so there
are no dependencies to install. Tested on Node 24 (CI) and Node 26 (local).

Run the test suite with `npm test`; CI runs it for every push and pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md).

```powershell
cd opencode-usage-tracker
node server.mjs --open
```

or double-click `start.cmd`.

| URL                              | What it is                              |
| -------------------------------- | --------------------------------------- |
| `http://127.0.0.1:4319`          | Full dashboard                          |
| `http://127.0.0.1:4319/compact`   | Small widget (good for a second screen) |
| `http://127.0.0.1:4319/compact?transparent=1` | Widget without background (OBS) |
| `http://127.0.0.1:4319/api/usage` | JSON data                           |
| `http://127.0.0.1:4319/api/export.csv` | Free daily history as CSV (30 days) |
| `http://127.0.0.1:4319/api/export-go.csv` | Go daily activity as CSV (Console period, or local fallback) |
| `http://127.0.0.1:4319/api/export-all.csv` | Every provider/plan, one row per UTC day (30 days) |
| `http://127.0.0.1:4319/api/export.json` | Full `/api/usage` payload as a download |
| `http://127.0.0.1:4319/api/console/status` | Console sync state          |

Add `--open` to open the browser, `--open-compact` to open the widget.
Set `PORT` to use a different port.

## How the free quota actually works (verified 2026-11-13 → 2026-11-18)

The free tier is a **24-hour bucket counted per network, not per session**. The
client's own free-limit panel says exactly that: *"Free usage is counted per
network, not per session, so one refusal anywhere holds until it resets.
Connecting a paid provider ends it early."* A refusal on one app therefore
holds for every app on the same network.

### The 429 is the only authoritative signal

When a free request is refused, the inference service returns HTTP 429:

```json
{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}
```

with a `retry-after` header (seconds). The client maps it to `retryAfterMs`, and
the app banner — *"You've used today's free messages. They reset at …"* — is
computed as **refusal time + retryAfterMs**, nothing more. The tracker uses the
same value and marks it **OpenCode-confirmed**.

There is **no** `X-RateLimit-*` header, no `resetsAt` field in the body, and no
usage/limit endpoint on the inference host. Console's request-log detail stores
`responseHeaders: null` even for successful requests, so the 429 response is the
only place the reset appears.

### The reset is 24h after the window opens — not UTC midnight

Observed boundaries from the local database and Console logs:

| Refused at (UTC) | Server reset (UTC) | Window start = reset − 24h | Local requests in that window |
| ---------------- | ------------------ | -------------------------- | ----------------------------- |
| Nov 13 02:06:26  | Nov 14 00:41:58    | Nov 13 00:41:58            | 262 |
| Nov 14 15:39:54  | Nov 15 00:29:05    | Nov 14 00:29:05            | 484 |
| Nov 15 13:24:57  | Nov 16 00:52:15    | Nov 15 00:52:15            | 210 |
| Nov 16 23:12:40  | Nov 17 00:53:02    | Nov 16 00:53:02            | 221 |

What this shows:

- **Every refusal inside one window points to the same reset instant.** On
  Nov 14, refusals at 15:39, 16:43 and 16:51 all targeted
  `2026-11-15T00:29:06Z`.
- The reset is exactly **24h after the window opened**, which is generally
  **not** 00:00 UTC. The old public limiter used a fixed UTC-day key and
  `retry-after = seconds to 00:00 UTC`; the live service has moved to this
  delayed form.
- The window start can be **earlier than this machine's first request**. On
  Nov 14 the tracker's first local success was 12:29, but the window opened at
  00:29 — the anchor came from outside this database (another client on the
  same network, or a request OpenCode did not write as an assistant message).
  That is why the local count at refusal varies (210–484 for the same model)
  even though the bucket is shared.
- **Capacity frees up continuously.** 48 requests succeeded *between* two
  refusals while the reset was still pending. The limit is not a hard block
  until the reset time, so a recovery never invalidates the server-confirmed
  reset; the tracker flags that state as **Recovered**.

The exact rule that chooses the window start is still private. The best-supported
model is a 24h bucket whose anchor is set by the first request after the UTC
day begins (from any client on the network); the reset is that instant + 24h.
The tracker therefore treats `retryAfterMs` as authoritative and only estimates
when no refusal is pending.

### What the tracker shows

- **OpenCode-confirmed reset** whenever a 429 exists whose `retryAfterMs` still
  points to the future (exactly what the OpenCode banner shows).
- An **estimated reset** otherwise. The window opened somewhere between the
  last passed server boundary (the earliest it could have opened) and the first
  free request this machine observed (the latest it could have opened), so the
  reset is shown as a **range**, not a single instant. Another client on the
  same network can open it earlier still; the range therefore narrows to the
  truth only when a 429 confirms it. `/api/usage` exposes the same range as
  `window.resetRange` (`earliest`, `latest`, `basis`).
- **Current window requests** since the last passed boundary when that boundary
  is less than 24h old; otherwise a rolling 24h lookback.
- **Last refused window**: this machine's requests inside the announced window
  (`resetAt − 24h` through the refusal). The **headroom** card is
  `lastRefusedWindow − currentWindow` and is explicitly labelled a historical
  boundary, **not** the server's unpublished cap. The refusal table can show
  the last 5 rows or all recorded refusals.
- **A plan badge and automatic plan detection.** `providerID = "opencode-go"`
  marks a Go request; free rows still require the free provider and a
  free-model id. The badge shows **Go** or **Free**, and the two views never
  mix their counts.
- **Go plan meters and activity** whenever Go is detected: exact 5-hour / week
  / month money meters with reset countdowns, the billing period’s requests,
  tokens, and list cost, a daily activity strip, and per-model rows. See
  *OpenCode Go plan* below.
- **An All providers section** for Zen pay-as-you-go and any external API
  (Anthropic, OpenAI, Google, OpenRouter, GitHub Copilot, …): requests, tokens,
  OpenCode-reported cost, per-provider share, and top models. See *All
  providers and plans* below.
- **Free token totals** for the current window, last 7 days, last 30 days, and
  the whole tracked history (`config.historyDays`, 120 by default), from
  `totals.*` in `/api/usage`. The mix card splits input / output / reasoning /
  cache-read / cache-write tokens; the per-day table uses the same local
  token columns as the CSV export. Go token totals are reported separately in
  `go.local.*` because Go costs money and is not part of the free bucket.
- **A “What is exact — and what isn’t” card** that states the private/dynamic
  cap, the request-counted (not token-counted) rule, the reset range, and what
  “headroom” really means. The full JSON payload is downloadable from the
  header with **JSON** as well as **CSV**.
- `/api/usage` keeps the raw evidence beside the estimates: `window.boundaryAt`
  (last passed server boundary), `window.firstSeenAt` (first local success
  after it), `window.resetRange`, `window.projectedResetAt`, and
  `meta.serverSeen` (Console sync configured *and* returning data, as opposed
  to merely configured).
- Daily charts remain UTC-day aggregates and are local-only. The Console
  export adds exact account-wide UTC-day rollups (see below), including
  `server.exportTotals` for the 7-day, 30-day, and full export range. The cards
  say how many completed UTC days actually exist, because the export lags the
  current day and can cover fewer than 7 or 30 days.

### OpenCode Go plan (verified 2026-11-20)

Go is **not** a request-count bucket. Console exposes exact money meters and
the current billing period's activity; both use the same Console session
cookie as the free sync:

| Endpoint | Returns |
| -------- | ------- |
| `GET /console/api/go/status?fresh=true` | `product`, `renewalProduct`, access period, and the `fiveHour` / `week` / `month` meters |
| `GET /console/api/activity/go` | `startsAt`, `daily[]` (`requests`, `tokens`, `costMicroCents`), and `models[]` for the billing period |

Amounts are **micro-cents: 1 USD = 100,000,000**. Each meter carries
`startsAt`, `resetsAt`, `limitMicroCents`, and `usedMicroCents`. The tracker
converts them to `limitUsd`, `usedUsd`, `remainingUsd`, and `percent` and
shows the exact reset countdown.

Snapshot for this workspace on 2026-11-20:

- `product: "go"`, access `2026-11-20T10:43:31Z → 2026-12-20T10:43:31Z`
- **5-hour** meter: $12 limit, resets five hours after its window opens
- **week** meter: $30 limit, resets Monday `00:00Z`
- **month** meter: $60 limit, resets at the end of the billing period
- period activity: 278 requests, 47.2M tokens, $0.336 list cost

The meters are the quota; requests and tokens are cost drivers, not a second
limit. `usedMicroCents` and `activity.cost` are separate snapshots and can
differ because of plan pricing, credits, and sync timing; use the meter for the
quota. The local database stores Go rows with
`providerID = "opencode-go"`, model id without `-free`, and `cost = 0`; those
rows supply per-model tokens, sessions, and the request count. They are
**never** added to the free-tier 24h bucket.

If Console is not configured or its cookie expires, the Go section still
appears from local detection and shows local requests/tokens with a clear
“meters unavailable” state.

`/api/usage` exposes the whole block as `go`:

- `go.detected`, `go.configured`, `go.enabled`, `go.fetchedAt`, `go.stale`,
  `go.error`
- `go.plan` — product, renewal product, access start/end, cancel/renewal flags
- `go.meters.fiveHour|week|month` — `{ startsAt, resetsAt, limitMicroCents,
  usedMicroCents, limitUsd, usedUsd, remainingUsd, percent }`
- `go.activity` — `{ startsAt, daily[], models[], totals }` for the billing
  period
- `go.local` — `{ today, last5Hours, last7Days, last30Days, tracked, hourly,
  days[], models[] }` from the local database

The Go daily CSV is `GET /api/export-go.csv`; the free daily CSV remains
`GET /api/export.csv`.

### All providers and plans (local)

The tracker classifies **every successful assistant row**, not just free and
Go:

| Kind | Detection | Plan label |
| ---- | --------- | ---------- |
| `free` | provider `opencode` (or unspecified) + free model | Free tier |
| `go` | provider `opencode-go` (or `opencode-go-*`) | Go / Go Plus / Go Teams |
| `zen` | provider `opencode` + a non-free model | Zen pay-as-you-go |
| `external` | any other provider id (`anthropic`, `openai`, `google`, `openrouter`, `github-copilot`, `groq`, …) | API |

On this machine the view currently detects three sources: **OpenCode Free**,
**OpenCode Go**, and an external **Merge Gateway** provider (2,343 requests,
722.8K tokens, $0.43 reported cost). That is the case this section exists for:
any provider id OpenCode records is picked up automatically.

The **All providers** section shows:

- today / 7d / 30d / all-time requests, tokens, and OpenCode-reported cost
- one row per provider/plan with today and 7d requests, 30d tokens, 30d cost,
  share of 30d requests, and last use
- the top models across providers with 30d requests, tokens, and cost
- `GET /api/export-all.csv` for the same provider/day breakdown

**What is exact:** every local request, its provider/model, tokens, sessions,
and the `cost` OpenCode wrote for it. **What is not available:** a shared quota
or remaining-budget API for Zen pay-as-you-go and external providers. Those
providers bill on their own side; OpenCode only records the request and cost.
The dashboard therefore shows local usage, not “remaining Anthropic/OpenAI
quota”. Go is the exception because Console exposes its meters.

Cost notes:

- Free and Go rows report `$0` in the local database; Go’s list cost is shown
  from Console in the Go section.
- External and Zen rows use OpenCode’s reported `cost` (list pricing, or `$0`
  for OAuth subscription models that do not bill per token).
- The all-provider CSV uses the same local cost; it is not an invoice.

`/api/usage` exposes this as `all`:

- `all.detected`, `all.providerCount`, `all.kinds`, `all.plans`
- `all.today`, `all.last7Days`, `all.last30Days`, `all.tracked` — `{ requests,
  sessions, tokens, costUsd }`
- `all.providers[]` — per plan/provider totals, windows, `sharePct`, models
- `all.models[]` — top 15 models with 30d totals
- `all.days[]` — last 30 UTC days with per-provider rows
- `all.hourly` — today by UTC hour
- `all.costNote`

### Why a raw Node probe is not the app's bucket

Direct `fetch()` calls to `https://opencode.ai/inference/openai/v1/chat/completions`
from Node returned 429s whose `retry-after` always landed on
`00:00:00Z` — even with the desktop's exact `User-Agent`
(`opencode/latest/2.3.0/desktop`), `x-opencode-client: desktop`, a real session
id and `Authorization: Bearer public`. At the same time the desktop app's own
requests were succeeding. This is a **different bucket** (likely distinguished
by TLS/Cloudflare signals or a cookie the app does not export). Do not use the
Node probe's 00:00Z reset to reason about the desktop window.

## Where the cap is enforced (verified 2026-11-16)

There is no "free usage" query API. The limit is enforced inside the inference
service when a request is made, and the client learns about it only from the
429.

- The client calls **`https://opencode.ai/inference/openai/v1/…`** directly.
  Console's `/zen/v1/*` routes are a thin proxy: since commit
  [`83f2b6f`](https://github.com/anomalyco/opencode/commit/83f2b6f67a5245214f4bb365ff55f7dcba9ce7fa)
  ("refactor(console): make Zen routes a thin inference proxy", 2026-10-11),
  `packages/console/app/src/lib/inference-proxy.ts` forwards each path to
  `Resource.ConsoleMigration.inferenceUrl`, which is
  `https://opencode.ai/inference` in production.
- When the client is **not signed in**, the provider plugin sets
  `provider.settings.apiKey = "public"`. Free requests therefore carry
  `Authorization: Bearer public`; when signed in, the Console credential is
  used instead (`packages/core/src/plugin/provider/opencode.ts`).
- The **last public enforcement code** is in commit `7945de2`,
  `packages/console/app/src/routes/zen/util/ipRateLimiter.ts`. The refactor
  above deleted it, so the live post-October algorithm is private. The public
  code did this:
  - Redis per-IP daily counter, key `<stage>:ratelimit:ip:<ip>:<YYYYMMDD>`
    (UTC date). `dailyLimit = ZEN_LIMITS.free.dailyRequests`, or the model's
    own `rateLimit` when set — a model limit uses a model-prefixed key and has
    no new-IP allowance.
  - A new IP may use `2 × dailyLimit` per day until its lifetime counter
    reaches `7 × dailyLimit`; after that the normal `dailyLimit` applies.
  - On overflow it threw `FreeUsageLimitError` with
    `retry-after = ceil((86_400_000 − now % 86_400_000) / 1000)` — seconds to
    **00:00 UTC** — and expired the counter at that instant.
- `ZEN_LIMITS` is an SST secret, not source. Its schema
  (`packages/console/core/src/subscription.ts`, `getFreeLimits()`) is
  `free.{promoTokens,dailyRequests,dailyRequestsFallback,checkHeaders}`,
  `lite.{rollingLimit,rollingWindow,weeklyLimit,monthlyLimit}` and `black.*`.
  The numeric `dailyRequests` is not published and can be changed per
  deployment, so it cannot be derived exactly from the client or the catalog.

**Live behavior has drifted from that public rule.** Local 429 history is
mostly UTC-midnight through October: 18 of 21 recorded resets before
2026-11-01 land within ±3 minutes of 00:00 UTC, with three outliers on
2026-10-29 (+57.5 min) and 2026-10-31 (+8.1, +40.6 min). From 2026-11-01 every
recorded reset is offset by **+15.8 to +52.3 minutes** and moves from day to
day (e.g. all refusals on 2026-11-14 point to
`2026-11-15T00:29:06Z`; the 2026-11-15 refusal points to
`2026-11-16T00:52:15Z`). The private service chooses that instant, so the
tracker treats the server's `retryAfterMs` as authoritative and only estimates
when no refusal is pending.

## Four usage cases

| Case | Local DB | Console log | How the tracker counts |
| ---- | -------- | ----------- | ---------------------- |
| **A — anonymous** (OpenCode CLI/desktop, no account) | ✓ everything | ✗ nothing attributed | Local database alone; refusals from DB error rows + OpenCode log. |
| **B — signed-in client** (desktop app / CLI after *Connect provider*) | ✓ | ✓ same requests | Both sources see the same requests; the tracker takes whichever observed more per window (never double-counts). |
| **C — other apps on the account** (third-party clients using your Console credentials) | ✗ invisible | ✓ | Only the Console sync sees them; when the server view is larger, the headline counts switch to it automatically — labelled **account-wide**, because those clients may be on a different public IP and are not automatically in the same free-tier bucket. |
| **D — Go plan** (`providerID = "opencode-go"`) | ✓ requests, tokens, sessions | ✓ attributed + meters | Local rows feed the Go section’s per-model tokens and request counts; Console supplies the exact money meters and billing-period activity. These rows never enter the free 24h bucket. |

Refusals are picked up from all three surfaces — DB error rows
(`provider.free-limit`), OpenCode log lines, and Console request-log rows with
`statusCode: 429` — and deduplicated by timestamp, so a refusal that is visible
on several surfaces appears once. The dashboard marks the active count source
(*local window* or *server-side window, account-wide*) and shows a per-day
local-vs-server comparison in the **Console server log** panel; when the server
saw fewer requests than the local database, the difference is shown as `—`.

## How it collects data

OpenCode writes every request to a local SQLite database:

```
%USERPROFILE%\.local\share\opencode\opencode.db
```

The tracker opens it **read-only** and reads `session_message`:

- `type = 'assistant'` rows contain the model, token usage (`tokens.input`,
  `output`, `reasoning`, `cache.read/write`), cost, and timestamp.
- Failed requests contain `error.type = 'provider.free-limit'`, the HTTP
  `status` (429), and `error.retryAfterMs` — the server's own reset
  countdown.

A free request is counted when:

- the provider is `opencode` (or unspecified), and
- the model id ends in `-free`, or the id is listed in `freeModels`.
  `big-pickle` is the only current zero-cost model without the `-free` suffix,
  so it is kept explicitly in that list.

Go requests are recognised separately: any row with
`providerID = "opencode-go"` is Go usage, regardless of model name. Go rows are
kept out of the free bucket and aggregated into `go.local.*` (requests, tokens,
sessions, models, daily history).

Refusals that never made it into the database are also picked up from
`~/.local/share/opencode/log/opencode.log` (`Free usage limit` lines).

The window counters use a prefix sum over successful free requests, so the
24h-window totals are computed in one pass even with a large history.

## What is exact, and what is not

Exact:

- every successful request and its timestamp — free, Go, Zen pay-as-you-go,
  or any external provider
- token usage, model id, session, provider, and the cost OpenCode recorded
  (plus an estimated list value for free models)
- every recorded refusal (HTTP 429) and the **server-confirmed reset time**
  from its `retryAfterMs`
- the reset window end when a 429 is pending; otherwise a labelled estimate
  range: the last passed server boundary + 24h (earliest) through the first
  observed local request + 24h (latest), or a single rolling fallback when no
  boundary is known. Only the next 429 narrows it to an instant.
- the **Console daily rollup** for each UTC day (account-wide, all devices and
  apps attached to the workspace), via
  `GET /console/api/v2/usage/export?range=90d` (CSV). It is the only exact
  account-wide per-day request/token source. It lags the newest requests
  until Console builds the day's rollup, and it only contains
  account-attributed traffic. The tracker filters this export to free rows, so
  it remains a free-tier rollup.
- **Go plan meters** (`fiveHour`, `week`, `month`) from
  `GET /console/api/go/status?fresh=true`: exact limits, used amounts, and
  reset instants.
- **Go billing-period activity** from `GET /console/api/activity/go`: exact
  requests, tokens, and list cost for the period, plus per-model request
  counts. Console can lag the newest local rows by a few requests.
- **Local Go rows** from `opencode-go`: exact request/token/session history on
  this machine, including per-model token splits that Console does not store.

Not knowable locally:

- **remaining server quota.** OpenCode keeps the free-tier limit in a
  deployment secret (`ZEN_LIMITS`), exposes no remaining-quota endpoint, and
  sends no `X-RateLimit-*` headers. The bucket is keyed by **public network**,
  so an API key could not reveal it even in principle. The number is
  deployment-configurable; see *Where the cap is enforced*.
- **usage from other devices or users on the same public network.** They
  consume the same allowance and are invisible to this database — unless they
  are signed into your Console account and appear in the request log/export.
  Even then, they may be on a different network and not share the bucket.

The dashboard therefore shows the current window count, the last refused
window, and the history-derived boundaries (min / median / max usage observed
just before real 429s). Those are observations, not a published quota. The
main progress bar compares current usage with the last refused window; it does
not pretend to know the remaining allowance.

## Console server-log sync (optional, partial server view)

OpenCode's Console exposes one record per inference request:

```
GET https://opencode.ai/console/api/request-logs?category=inference&limit=100&since=<ms>&until=<ms>&cursor=<opaque>
x-org-id: <org_…/wrk_…>
Cookie: <the signed-in Console session cookie>
```

- newest-first, cursor pagination (`cursor` must be sent together with the
  same `until`), server-capped at 100 rows per page, **30-day retention**
- requires `x-org-id` (auto-discovered via `GET /console/api/orgs`) **and**
  the signed-in session cookie
- free requests are the free-model rows with `cost: 0`; rejected rows omit
  `cost`
- includes requests attributed to **your Console account**, which can include
  other devices signed into the same account — the piece the local database
  cannot see
- it is **not a complete free-tier ledger**: anonymous, network-bucketed
  requests stay invisible, and the log may start later than your local
  history. A negative **server − local** value is therefore normal and is
  shown as `—`.
- the Console API itself rate-limits syncs (429/503) — the tracker backs off
  to its next interval
- `responseHeaders` is `null` even on successful rows, so the Console cannot
  supply the rate-limit headers the inference host never sends.

### Daily rollup export

```
GET https://opencode.ai/console/api/v2/usage/export?range=90d
x-org-id: <org_…/wrk_…>
Cookie: <the signed-in Console session cookie>
```

Returns `text/csv` with one row per `(day, user, provider, model)`:

```
day,user_type,user_id,user_name,provider,model,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,cost_micro_cents,cost_usd
```

The tracker keeps **free rows only** (`provider = opencode` with a free model
id) and exposes them as `server.exportDays` in `/api/usage`, as the **Server
day** column in the refusal table, and rolls them up into
`server.exportTotals` (`last7Days`, `last30Days`, `all`) with input / output /
cache-read / cache-write token counts. The Console request log itself stores
only a scalar token total per request, so a server-wide window has no component
breakdown; the token mix uses the local daily data. The export is account-wide
and exact for the days Console has built, but it can be lower than the local
window count when local requests were anonymous (not attributed to the
account) and it lags the current day. Go rows are excluded here and handled by
the Go endpoints below.

### Go meters and activity

```
GET https://opencode.ai/console/api/go/status?fresh=true
GET https://opencode.ai/console/api/activity/go
x-org-id: <org_…/wrk_…>
Cookie: <the signed-in Console session cookie>
```

- `go/status` returns the plan product, access period, renewal state, and the
  `fiveHour` / `week` / `month` meters in micro-cents.
- `activity/go` returns `startsAt`, one row per UTC day with requests, tokens,
  and cost, plus per-model request totals for the current billing period.
- A `404` on `go/status` means this workspace has no Go subscription; the
  tracker stores `detected: false` and does not treat it as an error. `401/403`
  means the cookie expired; the last known meters stay visible with an error.
- Set `console.trackGo: false` to skip these calls. Go **local detection** and
  history still work; only the exact meters/activity disappear.

To enable:

1. Open [opencode.ai/console](https://opencode.ai/console) and sign in.
2. Copy the session `Cookie` header: DevTools → Network → any
   `/console/api/` request → Request Headers.
3. Put it into `tracker.config.json` (copy
   `tracker.config.json.example`):

   ```json
   {
     "console": { "cookie": "__Host-console_session=…" }
   }
   ```

4. Restart the tracker (or press **Sync now** on the dashboard).

The org id is auto-discovered from the session; set `console.orgId` manually
only if auto-discovery fails. The cookie stays in the local config file
(gitignored) and is never rendered or logged. `.console-sync.json` stores the
cursor, the per-day aggregates, the recent per-request rows, the exported
daily rollups, and the last Go status/activity snapshot; a legacy state file is rewound to the start of yesterday and its
rows and aggregates are rebuilt once. The sync only advances the cursor after a
complete page walk; an error, rate-limit, or page-cap stop retries the same
range next time.

`console.ignoreSessionIds` and `console.ignoreRequestIds` exclude synthetic
probe traffic (for example a manual `ses_probe` call) from the dashboard. The
probe requests are still real server traffic, but they are not real usage and
must not drive the status or the window count.

Billing endpoints the tracker deliberately does **not** use (`billing/status`,
`policies/current-budgets`, `usage/cost-by-day`, `zen/go/v1/usage`) cover
**paid** budgets and OpenCode Go meters, not the free cap.

## What the colors mean

| Status            | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| **Active**        | Free requests succeeded and no unresolved refusal is recorded. |
| **At limit**      | The latest free request was refused and nothing succeeded since. |
| **Recovered**     | A refusal is still inside its pending reset, but later free requests succeeded (capacity frees up before the stated reset). |
| **Idle**          | No free-model usage in the selected window.                    |

## Data sources and privacy

- Database: `~/.local/share/opencode/opencode.db` (read-only)
- Log: `~/.local/share/opencode/log/opencode.log` (only scanned for free-limit
  lines, to catch refusals that were not written to the database)
- Console API: only when you opt in via `console.cookie`/`console.orgId`
  (request logs + the daily CSV export)
- Server binds to `127.0.0.1` by default.
- No telemetry; the only outbound calls are the Console syncs you enable.
- The WAL database can be read while OpenCode is running.

Nothing from `auth.json` or `credential` is read by the dashboard. Session
titles, token counts, and model ids are displayed locally; the CSV export
contains aggregates only.

## Configuration

Edit `tracker.config.json` (optional) or set environment variables:

```json
{
  "port": 4319,
  "host": "127.0.0.1",
  "refreshMs": 5000,
  "historyDays": 120,
  "chartDays": 30,
  "minHitPointsForEstimate": 3,
  "fallback": { "requests": 350, "tokens": 35000000, "listValue": 1.2 },
  "console": {
    "baseUrl": "https://opencode.ai",
    "orgId": "",
    "cookie": "",
    "syncIntervalMs": 300000,
    "maxPages": 30,
    "trackGo": true,
    "ignoreSessionIds": ["ses_probe"],
    "ignoreRequestIds": []
  }
}
```

`console.trackGo` (default `true`) controls the two Go Console calls. Go
**local** detection is independent of this flag and of the cookie.

`fallback` and `minHitPointsForEstimate` only affect the internal JSON
(`limit.estimates`) and the "not enough refusals" state. The `350` /
`35,000,000` / `1.2` defaults are arbitrary placeholders, **not** the real
server cap, and are not shown as a quota.

| Variable                    | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `PORT`                      | HTTP port                                      |
| `HOST`                      | Bind address                                   |
| `OPENCODE_DB`               | Override the database path                     |
| `OPENCODE_LOG`              | Override the log path                          |
| `TRACKER_CONFIG`            | Path to a different config JSON                |
| `OPENCODE_CONSOLE_ORG_ID`   | `x-org-id` for the Console sync                |
| `OPENCODE_CONSOLE_COOKIE`   | Session cookie for the Console sync            |
| `OPENCODE_CONSOLE_BASE_URL` | Console base URL (default `https://opencode.ai`) |
| `OPENCODE_CONSOLE_STATE`    | Override `.console-sync.json` (tests/portable installs) |

`tracker.config.json` also accepts `prices` (USD per 1M tokens, used only for
the "estimated list value" column) and `freeModels` (extra model ids to treat
as free).

## Public API landscape (research summary)

| Source | What it gives you |
| ------ | ----------------- |
| `GET /console/api/request-logs` | Per-request server truth: status, model, cost, `outcome`, `errorCode`, `errorMessage`, tokens, session, user agent. The only refusal list the server exposes. |
| `GET /console/api/v2/usage/export?range=7d/30d/90d` | **CSV daily rollup** per `(day, user, provider, model)`: requests, input/output/cache tokens, cost. Account-wide, exact for built days, lags the current day. |
| `GET /console/api/usage/summary`, `/usage/models` | Account-wide totals (requests, tokens, cost in micro-cents) for `range=7d/30d/…`; no free-tier denominator and no refusal list. |
| `GET /console/api/providers/opencode` | Model catalog with `labels: ["Free"]` and zero pricing. `limits` are context/output tokens, never a request quota. |
| `GET /inference/v1/models` (also `/inference/openai/v1/models`, `/inference/anthropic/v1/models`) | Live gateway catalog (87 models on 2026-11-16). Same `limit`/`cost` meaning; no usage or quota fields. |
| `GET /console/api/go/status?fresh=true` | **Exact Go meters**: product, access period, `fiveHour`/`week`/`month` `{ startsAt, resetsAt, limitMicroCents, usedMicroCents }`. Cookie + `x-org-id`; 404 = no subscription. This is what the dashboard uses. |
| `GET /console/api/activity/go` | Go billing-period usage: `startsAt`, daily requests/tokens/`costMicroCents`, and per-model request totals. Cookie + `x-org-id`. |
| `GET /zen/go/v1/usage` | The inference path for Go meters; returns **401** with the Console cookie. It needs a bearer credential, so the tracker uses the Console endpoints instead. |
| `GET /console/api/policies/current-budgets`, `billing/status`, `billing/account`, `billing/auto-recharge`, `usage/cost-by-day` | Paid budget/balance routes (Bearer token from `opencode auth login opencode`, `x-org-id` header). Used by `slkiser/opencode-quota`. Micro-cent amounts (1 USD = 1e8). |
| 429 response | Body `{"type":"error","error":{"type":"FreeUsageLimitError",…}}`, header `retry-after` (seconds). **No** `X-RateLimit-*`, no `resetsAt` in the body — the reset comes from `retryAfterMs`, and `reset − 24h` reveals the window start. |
| `thelabcorner/opencode-zen-fut-api` | Reconstruction of the **old** (pre-Nov 2026) UTC-day limiter: IP scope, per-request counting, model-prefix buckets, 2× new-IP allowance. Its "resets 00:00 UTC" verdict matches the old public code but not the live service. |
| `mudhairless/opencode-usage-tracker` | Independent local-SQLite tracker (Rust tray). Also assumes 00:00 UTC. |
| `wyhxhh/opencode-zen-usage-monitor` | Confirms: no public remaining-quota API; estimates locally (~200 req/24h, IP-enforced). |

Verified negative results (read-only probes, 2026-11-16 → 2026-11-18):

- `GET /zen/v1/usage`, `/zen/v1/limits`, `/zen/v1/free-usage` — no such routes.
- `GET /inference/usage`, `/inference/v1/usage`, `/inference/limits`,
  `/inference/v1/limits`, `/inference/openai/v1/usage` — 404.
- `GET /console/api/activity/usage` — 400 for every tested `view`, `userId`,
  and no-param form on this plan, even with a valid Cookie and `x-org-id`. Use
  `/console/api/usage/*`, `/console/api/v2/usage/export` plus
  `/console/api/request-logs` instead.
- `GET /console/api/{openapi.json,spec,docs,swagger.json}` — 404; the Console
  publishes no OpenAPI document.
- `/zen/v1/models` and `/inference/*/models` carry `limit.context`,
  `limit.output`, and `cost` only — no request counter, no remaining quota.
- The desktop server's authenticated `GET /api/experimental/usage/limits`
  (OpenAPI operation `experimental.usage.limits`, reachable with
  `opencode api get /api/experimental/usage/limits`) returns only the
  signed-in Console workspace plus its Go allowance and budgets. On this free
  workspace it returned `budgets: []` and no `go` field — it is **not** a
  free-tier counter. The local `/openapi.json` lists 142 paths; this is the
  only usage/limit route.

Repos that rotate IPs to bypass the limit are intentionally out of scope.

## Caveats

- **Go is money-metered, not request-limited.** The 5-hour / week / month
  meters are exact, but they are dollar budgets; a request's cost depends on
  model and tokens. `usedMicroCents` and `activity.cost` are separate
  snapshots, so the meter card and the period activity card can differ; the
  meter is the quota.
- **External providers have no shared quota view.** Zen pay-as-you-go,
  Anthropic, OpenAI, Google, OpenRouter, and others bill on their own side.
  OpenCode records the request, tokens, and cost, but not a remaining balance.
  The All providers section is local usage, not a provider-side quota.
- **Go requires Console for the exact meters.** Local detection always works,
  but the meters and billing-period activity use the Console cookie
  (`console.trackGo`, enabled by default). If the cookie expires, the section
  keeps the last values and shows the error; local Go counters continue.
- The bucket is counted **per network**, so usage from other machines behind
  the same NAT/CGNAT/VPN consumes the same allowance and is invisible here.
  Console sync only adds requests attributed to your account; those clients may
  be on another network and do **not** necessarily share this bucket. Its count
  is therefore labelled **account-wide**, not "remaining quota".
- The exact server rule that chooses the window anchor is private; after
  2026-11-01 the reset no longer lands on UTC midnight. The estimate range is
  last boundary + 24h through first observed request + 24h; the real reset can
  be earlier than even that range if another client opened the window first.
  The server-confirmed `retryAfterMs` always wins while it is pending.
- The Console daily rollup can be lower than the local window count. On
  Nov 14 the local window had 484 requests but the export had 57 — the local
  traffic was not attributed to the account, so it never entered the rollup.
- A manual request to `https://opencode.ai/inference/...` is outside the
  tracked client flow and may land in a different bucket; a Node probe's
  00:00Z reset is not the app's reset.
- Refusals are recorded when OpenCode writes the failed assistant message.
  If a failure interrupts a stream, the token usage attributed to it may be
  partial.
- List value uses public per-token prices and is informational only. Free
  requests cost $0. Models without a configured price show `–`.

## Testing

```bash
npm test
npm run check   # syntax checks only
```

The suite creates a temporary synthetic SQLite database (`test-support/fixture.mjs`)
with free, Go, and external-provider rows plus a free 429, starts the server on
an ephemeral port, and verifies the API, all three CSVs, the dashboard, the
widget, and that no credential fields leak. It never reads your real database,
config, or `.console-sync.json`.

CI (`.github/workflows/ci.yml`) runs the same tests on every push to `main` and
every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Files

```
opencode-usage-tracker/
├── server.mjs              # read-only SQLite reader + HTTP server + Console sync
├── public/index.html       # dashboard
├── public/compact.html     # widget
├── test/                   # smoke + syntax tests
├── test-support/           # synthetic SQLite fixture
├── .github/workflows/ci.yml
├── CONTRIBUTING.md
├── tracker.config.json.example
├── start.cmd
└── package.json
```

`.console-sync.json` (gitignored) stores the Console cursor, daily aggregates,
recent per-request rows, and the exported daily rollups. It is a rebuildable
cache: delete it to force a fresh 30-day walk.
