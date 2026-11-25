#!/usr/bin/env node
/**
 * OpenCode Usage Tracker
 * Local, read-only dashboard for OpenCode's free tier and Go plan.
 *
 * Data sources:
 *   ~/.local/share/opencode/opencode.db   (sessions, messages, token usage, errors)
 *   ~/.local/share/opencode/log/opencode.log (free-limit lines)
 *
 * Nothing is written to OpenCode's data, and nothing leaves this machine.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { exec } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  port: 4319,
  host: "127.0.0.1",
  refreshMs: 5000,
  historyDays: 120,
  chartDays: 30,
  defaultMetric: "requests",
  minHitPointsForEstimate: 3,
  // Clearly labelled inference, never presented as the published cap.
  // 512 is the best fit to the one fully logged boundary: 511 server-side
  // free successes followed by a 429 on 2026-11-18 (512 events). The old
  // limiter gave a fresh network a 2x allowance.
  freeQuota: {
    inferredDailyRequests: 512,
    inferredNewNetworkRequests: 1024,
  },
  freeModels: [
    "big-pickle",
    "iceman-free",
    "inkling-2-small-free",
    "glm-5.3-flash-free",
    "deepseek-v4.1-flash-free",
    "minimax-m3.1-flash-free",
    "beam-free",
    "flint-40b-free",
    "longcat-2.5-free",
    "mimo-v2.6-flash-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "nemotron-3.5-super-vl-free",
    "jev-1.13-free",
  ],
  // Estimated list prices in USD per 1M tokens, used only for the
  // "est. list value" display. Free requests are actually billed at $0.
  prices: {
    "deepseek-v4.1-flash-free": { input: 0.3, output: 1.2, cacheRead: 0.006 },
    "glm-5.3-flash-free": { input: 0.15, output: 0.5, cacheRead: 0.03 },
    "minimax-m3.1-flash-free": { input: 0.15, output: 0.6, cacheRead: 0.015 },
    "mimo-v2.6-flash-free": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
    "nemotron-3-ultra-free": { input: 0.6, output: 2.4, cacheRead: 0.12 },
    "nemotron-3.5-lightning-free": { input: 0.6, output: 2.4, cacheRead: 0.12 },
    "nemotron-3.5-super-vl-free": { input: 0.6, output: 2.4, cacheRead: 0.12 },
  },
  fallback: {
    requests: 350,
    listValue: 1.2,
    tokens: 35_000_000,
  },
  // Optional server-side sync via the OpenCode Console request-log API
  // (GET /console/api/request-logs). Needs a signed-in Console session:
  // paste the browser Cookie header and the x-org-id into tracker.config.json.
  console: {
    baseUrl: "https://opencode.ai",
    cookie: "",
    orgId: "",
    syncIntervalMs: 300_000,
    maxPages: 30,
    // Synthetic session ids and request ids used for manual endpoint probes;
    // their requests are real server traffic but not real usage and must not
    // drive the UI. A probe may reuse a real session id, so ids are the only
    // reliable exclusion.
    ignoreSessionIds: ["ses_probe"],
    ignoreRequestIds: [],
  },
};

function loadConfig() {
  const file = process.env.TRACKER_CONFIG || path.join(__dirname, "tracker.config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      prices: { ...DEFAULT_CONFIG.prices, ...(raw.prices || {}) },
      fallback: { ...DEFAULT_CONFIG.fallback, ...(raw.fallback || {}) },
      freeQuota: { ...DEFAULT_CONFIG.freeQuota, ...(raw.freeQuota || {}) },
      console: { ...DEFAULT_CONFIG.console, ...(raw.console || {}) },
      freeModels: Array.isArray(raw.freeModels) ? raw.freeModels : DEFAULT_CONFIG.freeModels,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

const config = loadConfig();
const PORT = Number(process.env.PORT || config.port);
const HOST = process.env.HOST || config.host;
const DB_PATH =
  process.env.OPENCODE_DB ||
  path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const LOG_PATH =
  process.env.OPENCODE_LOG ||
  path.join(path.dirname(DB_PATH), "log", "opencode.log");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const FREE_IDS = new Set(config.freeModels.map((id) => id.toLowerCase()));

const PRETTY_MODELS = {
  "deepseek-v4.1-flash-free": "DeepSeek V4.1 Flash Free",
  "glm-5.3-flash-free": "GLM-5.3-Flash Free",
  "minimax-m3.1-flash-free": "MiniMax M3.1 Flash Free",
  "mimo-v2.6-flash-free": "MiMo-V2.6-Flash Free",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra Free",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning Free",
  "nemotron-3.5-super-vl-free": "Nemotron 3.5 Super VL Free",
  "longcat-2.5-free": "LongCat 2.5 Free",
  "big-pickle": "Big Pickle",
  "iceman-free": "Iceman Free",
  "inkling-2-small-free": "Inkling 2 Small Free",
  "beam-free": "Beam Free",
  "flint-40b-free": "Flint 40B Free",
  "jev-1.13-free": "Jev 1.13 Free",
};

/** Thousands separator without locale weirdness. */
function n(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDayStart(ms = Date.now()) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function nextUtcMidnight(ms = Date.now()) {
  return utcDayStart(ms) + DAY_MS;
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(999, (part / whole) * 100));
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(sorted) {
  return quantile(sorted, 0.5);
}

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function isFreeModel(providerID, modelID) {
  if (!modelID) return false;
  const id = String(modelID).toLowerCase();
  const provider = String(providerID || "").toLowerCase();
  if (provider && provider !== "opencode") return false;
  return id.endsWith("-free") || FREE_IDS.has(id);
}

const PROVIDER_NAMES = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "google-vertex": "Google Vertex",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  xai: "xAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  mistral: "Mistral",
  "amazon-bedrock": "Amazon Bedrock",
  azure: "Azure",
  cerebras: "Cerebras",
  togetherai: "Together AI",
  "together-ai": "Together AI",
  minimax: "MiniMax",
  moonshotai: "Moonshot",
  zhipuai: "Zhipu",
  "opencode-go-plus": "OpenCode Go Plus",
};

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Classify every successful assistant row:
 *   free     — anonymous/free provider with a free model (24h bucket)
 *   go       — provider opencode-go (subscription, cost 0 in the local DB)
 *   zen      — provider opencode with a paid Zen model (pay-as-you-go)
 *   external — any other provider (Anthropic, OpenAI, OpenRouter, …)
 * Free/Go aggregations stay separate; `external` and `zen` feed the
 * all-provider view so every plan/API is visible.
 */
function classify(providerID, modelID) {
  const provider = String(providerID || "").toLowerCase() || "unknown";
  if (provider === "opencode-go" || provider.startsWith("opencode-go-")) {
    return {
      kind: "go",
      provider: "opencode-go",
      providerName: PROVIDER_NAMES[provider] || "OpenCode Go",
      plan: "Go",
    };
  }
  if (isFreeModel(providerID, modelID)) {
    return {
      kind: "free",
      provider: "opencode",
      providerName: "OpenCode Free",
      plan: "Free tier",
    };
  }
  if (provider === "opencode") {
    return {
      kind: "zen",
      provider: "opencode",
      providerName: "OpenCode Zen",
      plan: "Zen pay-as-you-go",
    };
  }
  return {
    kind: "external",
    provider,
    providerName: PROVIDER_NAMES[provider] || titleCase(provider),
    plan: "API",
  };
}

function priceFor(modelID) {
  return config.prices[String(modelID).toLowerCase()] || null;
}

function listValueOf(modelID, tokens) {
  const price = priceFor(modelID);
  if (!price) return { value: 0, priced: false };
  const input = n(tokens.input);
  const output = n(tokens.output) + n(tokens.reasoning);
  const cacheRead = n(tokens.cacheRead);
  const value =
    (input * price.input + output * price.output + cacheRead * price.cacheRead) / 1_000_000;
  return { value, priced: true };
}

function prettyModel(id) {
  if (!id) return "Unknown model";
  if (PRETTY_MODELS[id]) return PRETTY_MODELS[id];
  return String(id)
    .replace(/-free$/i, " Free")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeReadJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/* ------------------------------------------------------------------ */
/* Console request-log sync (optional, server-side truth)              */
/*                                                                     */
/* OpenCode's Console exposes one record per inference request:        */
/*   GET {base}/console/api/request-logs                               */
/*       ?category=inference&limit=100&since=<ms>&until=<ms>&cursor=.. */
/* Headers: x-org-id + the signed-in session cookie. Newest-first,     */
/* cursor pagination (cursor must be sent together with the same       */
/* `until`), ~30 day retention, free rows carry cost: 0.               */
/* This is the only public source of server-observed request counts,   */
/* including other devices behind the same IP.                         */
/* ------------------------------------------------------------------ */

const CONSOLE = {
  baseUrl: (process.env.OPENCODE_CONSOLE_BASE_URL || config.console.baseUrl).replace(/\/+$/, ""),
  cookie: process.env.OPENCODE_CONSOLE_COOKIE || config.console.cookie || "",
  orgId: process.env.OPENCODE_CONSOLE_ORG_ID || config.console.orgId || "",
  intervalMs: Math.max(60_000, Number(config.console.syncIntervalMs) || 300_000),
  maxPages: Math.max(1, Number(config.console.maxPages) || 30),
  // The Go plan exposes exact meters and period activity on Console endpoints
  // (cookie-authenticated). Enabled by default; set console.trackGo=false to
  // keep the old free-tier-only behaviour.
  trackGo: config.console.trackGo !== false,
  ignoreSessionIds: new Set(
    (Array.isArray(config.console.ignoreSessionIds) ? config.console.ignoreSessionIds : []).map(String),
  ),
  ignoreRequestIds: new Set(
    (Array.isArray(config.console.ignoreRequestIds) ? config.console.ignoreRequestIds : []).map(String),
  ),
};
const CONSOLE_STATE_PATH =
  process.env.OPENCODE_CONSOLE_STATE || path.join(__dirname, ".console-sync.json");
// The request-log cursor is time-based. If `until` is "right now", rows that
// arrive while page 2 is being read invalidate the cursor and Console answers
// HTTP 400. Snapshot a slightly older instant; the next sync starts back at
// maxStarted - 60s and catches the gap.
const CONSOLE_SYNC_LAG_MS = 30_000;
// Bump when the persisted shape changes; older files are backfilled once.
const CONSOLE_STATE_SCHEMA = 6;

const consoleData = {
  configured: false,
  syncing: false,
  orgId: null, // auto-discovered from /console/api/orgs when not configured
  lastSyncAt: null,
  lastError: null,
  lastItemCount: 0,
  serverSeen: false, // at least one server-side free (cost 0) request observed
  days: new Map(), // day -> { requests, tokens, failed }
  rows: [], // { t, tokens, listValue } of server-side free requests, ascending
  events: [], // { time, statusCode, errorCode } of server-side refusals
  seen: new Map(), // item id -> startedAt, dedupes the 1-minute overlap
  exportDays: new Map(), // day -> exact server-side free rollup (UTC day, account-wide)
  exportAt: null,
  // Go plan: exact meters + billing-period activity from Console.
  // Persisted so the dashboard still shows the last known values when a sync
  // fails or the cookie expires.
  goStatus: null, // { detected, plan, meters }
  goActivity: null, // { startsAt, daily, models, totals }
  goAt: null,
  goError: null,
  backfill: false, // legacy state: rebuild rows for the last 26h without recounting days
};

function readConsoleState() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONSOLE_STATE_PATH, "utf8"));
    if (Number.isFinite(raw.since)) return raw;
  } catch {
    /* no state yet */
  }
  return { since: null };
}

/**
 * Restore persisted aggregates once at startup. The Console API only covers
 * the newest window, so without this every restart would erase the server-side
 * history that was already synced.
 */
function hydrateConsoleState(raw) {
  if (raw && raw.days && typeof raw.days === "object") {
    for (const [day, entry] of Object.entries(raw.days)) {
      const requests = Number(entry && entry.requests) || 0;
      const tokens = Number(entry && entry.tokens) || 0;
      const failed = Number(entry && entry.failed) || 0;
      if (requests || tokens || failed) consoleData.days.set(day, { requests, tokens, failed });
    }
  }
  if (raw && raw.seen && typeof raw.seen === "object") {
    const cutoff = Date.now() - 35 * DAY_MS;
    for (const [id, startedAt] of Object.entries(raw.seen)) {
      const ms = Number(startedAt);
      if (Number.isFinite(ms) && ms > 0 && ms >= cutoff) consoleData.seen.set(id, ms);
    }
  }
  if (Array.isArray(raw && raw.rows)) {
    for (const row of raw.rows) {
      const t = Number(row && row.t);
      const tokens = Number(row && row.tokens);
      if (Number.isFinite(t) && Number.isFinite(tokens)) {
        consoleData.rows.push({
          t,
          tokens,
          listValue: Number(row.listValue) || 0,
          model: row.model ? String(row.model) : null,
        });
      }
    }
    consoleData.rows.sort((a, b) => a.t - b.t);
  }
  if (Array.isArray(raw && raw.events)) {
    for (const event of raw.events) {
      const time = Number(event && event.time);
      if (Number.isFinite(time) && time > 0) {
        consoleData.events.push({
          time,
          statusCode: Number(event.statusCode) || 429,
          errorCode: event.errorCode || null,
        });
      }
    }
    consoleData.events.sort((a, b) => a.time - b.time);
  }
  if (raw && (raw.serverSeen || Object.values(raw.days || {}).some((d) => (d && d.requests) > 0))) {
    consoleData.serverSeen = true;
  }
  if (raw && raw.exportDays && typeof raw.exportDays === "object") {
    for (const [day, entry] of Object.entries(raw.exportDays)) {
      if (!entry || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const requests = Number(entry.requests) || 0;
      if (!requests) continue;
      consoleData.exportDays.set(day, {
        day,
        requests,
        inputTokens: Number(entry.inputTokens) || 0,
        outputTokens: Number(entry.outputTokens) || 0,
        cacheReadTokens: Number(entry.cacheReadTokens) || 0,
        cacheWriteTokens: Number(entry.cacheWriteTokens) || 0,
        costUsd: Number(entry.costUsd) || 0,
      });
    }
  }
  if (raw && raw.go && typeof raw.go === "object") {
    if (raw.go.status && typeof raw.go.status === "object") consoleData.goStatus = raw.go.status;
    if (raw.go.activity && typeof raw.go.activity === "object") consoleData.goActivity = raw.go.activity;
    consoleData.goAt = Number(raw.go.at) || null;
    consoleData.goError = raw.go.error || null;
  }
  if (raw) {
    consoleData.lastSyncAt = Number(raw.lastSyncAt) || null;
    consoleData.lastError = raw.lastError || null;
    consoleData.lastItemCount = Number(raw.lastCount) || 0;
    consoleData.exportAt = Number(raw.exportAt) || null;
    consoleData.backfill = raw.backfill === true;
  }

  if (raw && Number.isFinite(raw.since) && Number(raw.schema || 0) < CONSOLE_STATE_SCHEMA) {
    // Older state files only stored day aggregates. Per-request rows were
    // added later; because `seen` suppresses already-processed ids, those
    // rows could never appear without a one-time backfill. Rewind to the
    // start of yesterday, drop that day's aggregates, and rebuild both the
    // rows and the aggregates for the covered days.
    const since = utcDayStart(Date.now()) - DAY_MS;
    for (const [id, startedAt] of [...consoleData.seen]) {
      if (startedAt >= since) consoleData.seen.delete(id);
    }
    for (const day of [...consoleData.days.keys()]) {
      const dayStart = Date.parse(`${day}T00:00:00.000Z`);
      if (Number.isFinite(dayStart) && dayStart >= since) consoleData.days.delete(day);
    }
    consoleData.events = consoleData.events.filter((e) => e.time < since);
    consoleData.rows = [];
    consoleData.lastSyncAt = null;
    consoleData.lastItemCount = 0;
    consoleData.backfill = true;
    saveConsoleState(since);
  }

  // A backfill interrupted by an error or a rate limit resumes immediately.
  if (consoleData.backfill) consoleData.lastSyncAt = null;
}

function saveConsoleState(since) {
  try {
    fs.writeFileSync(
      CONSOLE_STATE_PATH,
      JSON.stringify(
        {
          schema: CONSOLE_STATE_SCHEMA,
          since,
          lastSyncAt: consoleData.lastSyncAt,
          lastError: consoleData.lastError,
          lastCount: consoleData.lastItemCount,
          backfill: Boolean(consoleData.backfill),
          serverSeen: consoleData.serverSeen,
          days: Object.fromEntries(consoleData.days),
          seen: Object.fromEntries(consoleData.seen),
          rows: consoleData.rows,
          events: consoleData.events,
          exportDays: Object.fromEntries(consoleData.exportDays),
          exportAt: consoleData.exportAt,
          go: {
            status: consoleData.goStatus,
            activity: consoleData.goActivity,
            at: consoleData.goAt,
            error: consoleData.goError,
          },
        },
        null,
        2,
      ),
    );
  } catch {
    /* state is optional */
  }
}

hydrateConsoleState(readConsoleState());

function consoleDayEntry(day) {
  let entry = consoleData.days.get(day);
  if (!entry) {
    entry = { requests: 0, tokens: 0, failed: 0 };
    consoleData.days.set(day, entry);
  }
  return entry;
}

function aggregateConsoleItems(items) {
  let maxStarted = 0;
  let added = 0;
  for (const item of items) {
    const startedAt = Number(item && item.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) continue;
    if (item.sessionID && CONSOLE.ignoreSessionIds.has(String(item.sessionID))) continue;
    if (item.id && CONSOLE.ignoreRequestIds.has(String(item.id))) continue;
    maxStarted = Math.max(maxStarted, startedAt);
    const id = item.id != null ? String(item.id) : `${startedAt}:${item.model || ""}:${item.requestID || ""}`;
    if (consoleData.seen.has(id)) continue;
    consoleData.seen.set(id, startedAt);
    const entry = consoleDayEntry(dayKey(startedAt));
    const model = String(item.model || "").toLowerCase();
    const isFreeModel = model.endsWith("-free") || FREE_IDS.has(model);
    if (item.outcome && item.outcome !== "succeeded") {
      // A failed request has no reliable cost; attribute it only when the
      // model itself is a free model.
      if (isFreeModel) {
        entry.failed += 1;
        added += 1;
        const statusCode = Number(item.statusCode);
        const code = `${item.errorCode || ""} ${item.errorMessage || ""}`;
        if (statusCode === 429 || /freelimit|free-limit|freeusagelimit|free.usage.limit/i.test(code)) {
          consoleData.events.push({
            time: startedAt,
            statusCode: statusCode || 429,
            errorCode: item.errorCode || null,
          });
        }
      }
      continue;
    }
    const cost = Number(item.cost);
    if (!Number.isFinite(cost) || cost !== 0) continue; // paid requests are out of scope
    if (!isFreeModel) continue; // a cost-0 promo on a paid model is not free-tier usage
    consoleData.serverSeen = true;
    const input = n(item.inputTokens);
    const output = n(item.outputTokens); // already includes reasoningTokens
    const cacheRead = n(item.cacheReadTokens);
    const cacheWrite = n(item.cacheWriteTokens);
    const tokens = input + output + cacheRead + cacheWrite;
    entry.requests += 1;
    entry.tokens += tokens;
    consoleData.rows.push({
      t: startedAt,
      tokens,
      listValue: listValueOf(item.model || item.requestedModel, {
        input,
        output,
        reasoning: 0,
        cacheRead,
        cacheWrite,
      }).value,
      model: String(item.model || item.requestedModel || "unknown"),
    });
    added += 1;
  }
  consoleData.rows.sort((a, b) => a.t - b.t);
  if (consoleData.events.length > 500) consoleData.events = consoleData.events.slice(-500);
  consoleData.events.sort((a, b) => a.time - b.time);
  // Keep roughly the Console's own retention window.
  const cutoffMs = Date.now() - 35 * DAY_MS;
  for (const [id, startedAt] of consoleData.seen) {
    if (startedAt < cutoffMs) consoleData.seen.delete(id);
  }
  consoleData.rows = consoleData.rows.filter((r) => r.t >= cutoffMs);
  consoleData.events = consoleData.events.filter((e) => e.time >= cutoffMs);
  return { maxStarted, added };
}

/**
 * Console's daily rollup export:
 *   GET /console/api/v2/usage/export?range=90d  -> text/csv
 *   day,user_type,user_id,user_name,provider,model,requests,input_tokens,...
 *
 * It is account-wide (every device and app signed in to the workspace), so it
 * is the only exact server-side count of requests per UTC day. One row per
 * (day, user, provider, model); we sum the rows per day.
 */
function parseUsageCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const iDay = col("day");
  const iReq = col("requests");
  const iProvider = col("provider");
  const iModel = col("model");
  const iIn = col("input_tokens");
  const iOut = col("output_tokens");
  const iRead = col("cache_read_tokens");
  const iWrite5 = col("cache_write_5m_tokens");
  const iWrite1 = col("cache_write_1h_tokens");
  const iCost = col("cost_usd");
  if (iDay === -1 || iReq === -1) return [];

  const byDay = new Map();
  for (const line of lines.slice(1)) {
    const cells = line
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
      ?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replaceAll('""', '"'));
    if (!cells) continue;
    const day = cells[iDay];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    // Keep this rollup free-tier-only. Go (and other paid) rows are tracked
    // separately: mixing them would turn the free "Server day" column and the
    // free export totals into an all-plan total.
    if (iProvider > -1) {
      const provider = String(cells[iProvider] || "").toLowerCase();
      const model = String((iModel > -1 && cells[iModel]) || "").toLowerCase();
      const isFree = provider === "opencode" && (model.endsWith("-free") || FREE_IDS.has(model));
      if (!isFree) continue;
    }
    let entry = byDay.get(day);
    if (!entry) {
      entry = {
        day,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
      byDay.set(day, entry);
    }
    entry.requests += n(cells[iReq]);
    if (iIn > -1) entry.inputTokens += n(cells[iIn]);
    if (iOut > -1) entry.outputTokens += n(cells[iOut]);
    if (iRead > -1) entry.cacheReadTokens += n(cells[iRead]);
    if (iWrite5 > -1) entry.cacheWriteTokens += n(cells[iWrite5]);
    if (iWrite1 > -1) entry.cacheWriteTokens += n(cells[iWrite1]);
    if (iCost > -1) entry.costUsd += n(cells[iCost]);
  }
  return [...byDay.values()];
}

/** Refreshes the daily rollups; 503 means Console has not built them yet. */
async function syncUsageExport(orgId) {
  const url = new URL("/console/api/v2/usage/export", CONSOLE.baseUrl);
  url.searchParams.set("range", "90d");
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "text/csv", "x-org-id": orgId, cookie: CONSOLE.cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (netError) {
    return { ok: false, error: `Console export unreachable: ${netError.cause?.code || netError.message}` };
  }
  if (res.status === 503) return { ok: false, pending: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "Console export refused the session cookie." };
  }
  if (!res.ok) return { ok: false, error: `Console export returned HTTP ${res.status}.` };
  const rows = parseUsageCsv(await res.text().catch(() => ""));
  if (!rows.length) return { ok: false, error: "Console export returned no usable rows." };
  for (const row of rows) consoleData.exportDays.set(row.day, row);
  const keep = dayKey(Date.now() - 95 * DAY_MS);
  for (const day of [...consoleData.exportDays.keys()]) {
    if (day < keep) consoleData.exportDays.delete(day);
  }
  consoleData.exportAt = Date.now();
  return { ok: true, days: rows.length };
}

/* ------------------------------------------------------------------ */
/* OpenCode Go plan                                                     */
/*                                                                     */
/* The Go plan is not a request-count bucket. Console exposes exact      */
/* money meters (5-hour / week / month) plus the current billing        */
/* period's activity, both cookie-authenticated:                        */
/*   GET /console/api/go/status?fresh=true                              */
/*   GET /console/api/activity/go                                       */
/* Amounts are micro-cents: 1 USD = 100,000,000.                        */
/* ------------------------------------------------------------------ */

const GO_PRODUCT_NAMES = {
  go: "Go",
  "go-plus": "Go Plus",
  "go-teams": "Go Teams",
};

/** micro-cents -> USD. 1 USD = 1e8 micro-cents. */
function microToUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round(n / 100_000_000, 4) : 0;
}

function normalizeGoMeter(key, meter) {
  const limitMicroCents = Number(meter && meter.limitMicroCents) || 0;
  const usedMicroCents = Number(meter && meter.usedMicroCents) || 0;
  const labels = { fiveHour: "5-hour", week: "Week", month: "Month" };
  return {
    key,
    label: labels[key] || key,
    startsAt: meter && meter.startsAt ? meter.startsAt : null,
    resetsAt: meter && meter.resetsAt ? meter.resetsAt : null,
    limitMicroCents,
    usedMicroCents,
    limitUsd: microToUsd(limitMicroCents),
    usedUsd: microToUsd(usedMicroCents),
    remainingUsd: microToUsd(Math.max(0, limitMicroCents - usedMicroCents)),
    percent: limitMicroCents > 0 ? round((usedMicroCents / limitMicroCents) * 100, 2) : null,
  };
}

function normalizeGoStatus(raw) {
  if (!raw || typeof raw !== "object") return null;
  const access = raw.access && typeof raw.access === "object" ? raw.access : null;
  const meters = access && access.meters && typeof access.meters === "object" ? access.meters : null;
  // A 404 (no subscription) is stored as { detected: false }; a real status
  // always carries a product and/or an access period.
  const detected = Boolean(raw.product || access);
  const out = {};
  if (meters) {
    for (const key of ["fiveHour", "week", "month"]) {
      if (meters[key]) out[key] = normalizeGoMeter(key, meters[key]);
    }
  }
  return {
    detected,
    plan: {
      product: raw.product || null,
      productName: GO_PRODUCT_NAMES[raw.product] || raw.product || null,
      renewalProduct: raw.renewalProduct || null,
      renewalProductName: GO_PRODUCT_NAMES[raw.renewalProduct] || raw.renewalProduct || null,
      accessStartsAt: access && access.startsAt ? access.startsAt : null,
      accessEndsAt: access && access.endsAt ? access.endsAt : null,
      cancelAtPeriodEnd: Boolean((access && access.cancelAtPeriodEnd) ?? raw.cancelAtPeriodEnd),
      resumability: raw.resumability || null,
      renewalPending: Boolean(raw.renewalPending),
      renewalCurrency: raw.renewalCurrency || null,
    },
    meters: out,
  };
}

function normalizeGoActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const daily = (Array.isArray(raw.daily) ? raw.daily : [])
    .filter((row) => row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)))
    .map((row) => {
      const costMicroCents = num(row.totalCostMicroCents);
      return {
        date: String(row.date),
        requests: num(row.totalRequests),
        tokens: num(row.totalTokens),
        costMicroCents,
        costUsd: microToUsd(costMicroCents),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .filter((row) => row && row.model)
    .map((row) => ({
      provider: row.provider || "opencode-go",
      model: String(row.model),
      requests: num(row.totalRequests),
    }))
    .sort((a, b) => b.requests - a.requests);
  const totals = daily.reduce(
    (acc, row) => {
      acc.requests += row.requests;
      acc.tokens += row.tokens;
      acc.costMicroCents += row.costMicroCents;
      return acc;
    },
    { requests: 0, tokens: 0, costMicroCents: 0 },
  );
  totals.costUsd = microToUsd(totals.costMicroCents);
  return {
    startsAt: raw.startsAt || null,
    daily,
    models,
    totals,
  };
}

/**
 * Fetch the Go plan status and current-period activity. This is separate from
 * the free-tier request-log sync: a Go failure must not discard free data, and
 * a free-tier error must not hide Go meters.
 */
async function syncGo(orgId) {
  if (!CONSOLE.trackGo) return { ok: false, disabled: true };
  const headers = { accept: "application/json", "x-org-id": orgId, cookie: CONSOLE.cookie };
  const statusUrl = new URL("/console/api/go/status", CONSOLE.baseUrl);
  statusUrl.searchParams.set("fresh", "true");

  let statusRes;
  try {
    statusRes = await fetch(statusUrl, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch (netError) {
    consoleData.goError = `Go status unreachable: ${netError.cause?.code || netError.message}`;
    return { ok: false, error: consoleData.goError };
  }
  if (statusRes.status === 404) {
    // No Go subscription on this workspace. Not an error.
    consoleData.goStatus = { detected: false, plan: null, meters: {} };
    consoleData.goActivity = null;
    consoleData.goAt = Date.now();
    consoleData.goError = null;
    return { ok: true, detected: false };
  }
  if (statusRes.status === 401 || statusRes.status === 403) {
    consoleData.goError = "Go plan data refused the Console session cookie.";
    return { ok: false, error: consoleData.goError };
  }
  if (!statusRes.ok) {
    consoleData.goError = `Go status returned HTTP ${statusRes.status}.`;
    return { ok: false, error: consoleData.goError };
  }
  const rawStatus = await statusRes.json().catch(() => null);
  const status = normalizeGoStatus(rawStatus);
  if (!status) {
    consoleData.goError = "Unexpected Go status response shape.";
    return { ok: false, error: consoleData.goError };
  }

  let activity = null;
  let activityError = null;
  try {
    const activityRes = await fetch(new URL("/console/api/activity/go", CONSOLE.baseUrl), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (activityRes.ok) {
      activity = normalizeGoActivity(await activityRes.json().catch(() => null));
      if (!activity) activityError = "Unexpected Go activity response shape.";
    } else if (activityRes.status !== 404) {
      activityError =
        activityRes.status === 401 || activityRes.status === 403
          ? "Go activity refused the Console session cookie."
          : `Go activity returned HTTP ${activityRes.status}.`;
    }
  } catch (netError) {
    activityError = `Go activity unreachable: ${netError.cause?.code || netError.message}`;
  }

  consoleData.goStatus = status;
  consoleData.goActivity = activity;
  consoleData.goAt = Date.now();
  consoleData.goError = activityError;
  return { ok: true, detected: status.detected, activity: Boolean(activity), error: activityError };
}

/** The request-logs API requires x-org-id; discover it from the session. */
async function resolveConsoleOrgId() {
  if (CONSOLE.orgId) return CONSOLE.orgId;
  if (consoleData.orgId) return consoleData.orgId;
  const res = await fetch(new URL("/console/api/orgs", CONSOLE.baseUrl), {
    headers: { accept: "application/json", cookie: CONSOLE.cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Console session expired. Paste a fresh Cookie header into tracker.config.json (console.cookie).");
  }
  if (!res.ok) throw new Error(`Console /api/orgs returned HTTP ${res.status}.`);
  const orgs = await res.json().catch(() => null);
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error("Console session has no organizations.");
  }
  consoleData.orgId = orgs[0].id;
  return consoleData.orgId;
}

async function runConsoleSync({ force = false } = {}) {
  if (!CONSOLE.cookie) {
    consoleData.configured = false;
    return { ok: false, configured: false };
  }
  consoleData.configured = true;
  if (consoleData.syncing) return { ok: false, configured: true, busy: true };
  const state = readConsoleState();
  const age = Date.now() - (consoleData.lastSyncAt || state.lastSyncAt || 0);
  // Fetch once even when the free sync is still fresh, so upgrading the
  // tracker does not leave the Go section empty for a whole interval.
  const goMissing = CONSOLE.trackGo && !consoleData.goAt;
  if (!force && age < CONSOLE.intervalMs && !goMissing) {
    return { ok: true, configured: true, skipped: true };
  }
  consoleData.syncing = true;
  try {
    let orgId;
    try {
      orgId = await resolveConsoleOrgId();
    } catch (orgError) {
      consoleData.lastError = orgError.message;
      consoleData.goError = orgError.message;
      consoleData.lastSyncAt = Date.now();
      return { ok: false, configured: true, error: orgError.message };
    }

    const since = Number.isFinite(state.since) ? state.since : Date.now() - 30 * DAY_MS;
    const until = Date.now() - CONSOLE_SYNC_LAG_MS;
    const items = [];
    let cursor = null;
    let pages = 0;
    let error = null;
    let done = false;
    let restarted = false;

    while (pages < CONSOLE.maxPages) {
      const url = new URL("/console/api/request-logs", CONSOLE.baseUrl);
      url.searchParams.set("category", "inference");
      url.searchParams.set("limit", "100");
      url.searchParams.set("since", String(Math.max(0, since)));
      url.searchParams.set("until", String(until));
      if (cursor) url.searchParams.set("cursor", cursor);

      let res;
      try {
        res = await fetch(url, {
          headers: { accept: "application/json", "x-org-id": orgId, cookie: CONSOLE.cookie },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (netError) {
        error = `Console unreachable: ${netError.cause?.code || netError.message}`;
        break;
      }

      if (res.status === 401 || res.status === 403) {
        error = "Console session expired. Paste a fresh Cookie header into tracker.config.json (console.cookie).";
        break;
      }
      if (res.status === 409 || res.status === 400) {
        // A stale/expired cursor and an occasional Console 400 both recover
        // by restarting the walk once from `since`. Repeating page 1 is safe:
        // aggregateConsoleItems dedupes request ids.
        if (cursor && !restarted) {
          restarted = true;
          cursor = null;
          pages += 1;
          continue;
        }
        const detail = res.status === 400
          ? (await res.text().catch(() => "")).trim().slice(0, 300)
          : "";
        error = `Console API returned HTTP ${res.status}${detail ? `: ${detail}` : ""}.`;
        break;
      }
      if (res.status === 429 || res.status === 503) {
        error = "Console API rate-limited this sync. Retrying on the next interval.";
        break;
      }
      if (!res.ok) {
        error = `Console API returned HTTP ${res.status}.`;
        break;
      }
      const json = await res.json().catch(() => null);
      if (!json || !Array.isArray(json.items)) {
        error = "Unexpected Console API response shape.";
        break;
      }
      items.push(...json.items);
      if (!json.nextCursor) {
        done = true;
        break;
      }
      cursor = json.nextCursor;
      pages += 1;
    }

    const { maxStarted } = aggregateConsoleItems(items);
    // Daily rollups come from a different Console endpoint and cover the whole
    // account. A failure here must not discard the request-log walk.
    let exportResult = null;
    try {
      exportResult = await syncUsageExport(orgId);
    } catch (exportError) {
      exportResult = { ok: false, error: exportError.message };
    }
    if (!error && exportResult && exportResult.error) error = exportResult.error;

    // Go plan meters are independent of the free-tier walk; a failure here is
    // reported in `go.error` and never discards free data (or vice versa).
    let goResult = null;
    try {
      goResult = await syncGo(orgId);
    } catch (goError) {
      consoleData.goError = `Go sync failed: ${goError.message}`;
      goResult = { ok: false, error: consoleData.goError };
    }

    consoleData.lastError = error;
    consoleData.lastItemCount = items.length;
    consoleData.lastSyncAt = Date.now();
    // Only advance the cursor after a complete walk. Advancing after an error,
    // a 429, or a page-cap stop would permanently skip unread records.
    const nextSince = done
      ? maxStarted > 0
        ? Math.max(since, maxStarted - 60_000)
        : until
      : since;
    if (done) consoleData.backfill = false;
    saveConsoleState(nextSince);
    return {
      ok: !error,
      configured: true,
      count: items.length,
      exportDays: exportResult && exportResult.ok ? exportResult.days : null,
      error,
      go: goResult,
    };
  } finally {
    consoleData.syncing = false;
  }
}

function sumExportDays(rows) {
  const total = {
    days: rows.length,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens: 0,
    costUsd: 0,
    firstDay: rows.length ? rows[0].day : null,
    lastDay: rows.length ? rows[rows.length - 1].day : null,
  };
  for (const row of rows) {
    total.requests += row.requests;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cacheWriteTokens += row.cacheWriteTokens;
    total.costUsd += row.costUsd;
  }
  total.tokens =
    total.inputTokens + total.outputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  total.costUsd = round(total.costUsd, 4);
  return total;
}

function consoleSummary() {
  const exportDays = [...consoleData.exportDays.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    configured: Boolean(CONSOLE.cookie),
    orgId: CONSOLE.orgId || consoleData.orgId,
    syncing: consoleData.syncing,
    lastSyncAt: consoleData.lastSyncAt ? new Date(consoleData.lastSyncAt).toISOString() : null,
    exportAt: consoleData.exportAt ? new Date(consoleData.exportAt).toISOString() : null,
    error: consoleData.lastError,
    lastItemCount: consoleData.lastItemCount,
    days: [...consoleData.days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-30)
      .map(([day, entry]) => ({ day, ...entry })),
    // Exact server-side totals per UTC day, account-wide (all devices/apps).
    exportDays: exportDays.slice(-30),
    exportTotals: {
      last7Days: sumExportDays(exportDays.slice(-7)),
      last30Days: sumExportDays(exportDays.slice(-30)),
      all: sumExportDays(exportDays),
    },
    go: {
      enabled: CONSOLE.trackGo,
      detected: Boolean(consoleData.goStatus && consoleData.goStatus.detected),
      fetchedAt: consoleData.goAt ? new Date(consoleData.goAt).toISOString() : null,
      error: consoleData.goError,
    },
  };
}

/**
 * Go plan summary for the dashboard. `detected` is true when either Console
 * reports a Go subscription or the local DB contains opencode-go rows; the
 * second case keeps the section visible even before the cookie is configured.
 */
function goSummary(local) {
  const status = consoleData.goStatus;
  const activity = consoleData.goActivity;
  const configured = Boolean(CONSOLE.cookie);
  const age = consoleData.goAt ? Date.now() - consoleData.goAt : null;
  return {
    detected: Boolean((status && status.detected) || (local && local.detected)),
    configured,
    enabled: CONSOLE.trackGo,
    fetchedAt: consoleData.goAt ? new Date(consoleData.goAt).toISOString() : null,
    // Saved meters remain useful, but flag them when the cookie was removed
    // or the last sync is much older than the interval.
    stale: Boolean(
      status &&
        status.detected &&
        (!configured || !CONSOLE.trackGo || (age != null && age > CONSOLE.intervalMs * 3)),
    ),
    error: consoleData.goError || null,
    plan: status && status.plan ? status.plan : null,
    meters: status && status.meters ? status.meters : null,
    activity: activity || null,
    local,
  };
}

/* ------------------------------------------------------------------ */
/* Data collection                                                     */
/* ------------------------------------------------------------------ */

const ASSISTANT_QUERY = `
  SELECT
    time_created AS t,
    session_id AS sid,
    json_extract(data, '$.model.providerID') AS provider,
    json_extract(data, '$.model.id') AS model,
    json_extract(data, '$.tokens.input') AS input,
    json_extract(data, '$.tokens.output') AS output,
    json_extract(data, '$.tokens.reasoning') AS reasoning,
    json_extract(data, '$.tokens.cache.read') AS cache_read,
    json_extract(data, '$.tokens.cache.write') AS cache_write,
    json_extract(data, '$.cost') AS cost,
    json_extract(data, '$.error.type') AS error_type,
    json_extract(data, '$.error.status') AS error_status,
    json_extract(data, '$.error.retryAfterMs') AS retry_after_ms,
    json_extract(data, '$.error.message') AS error_message
  FROM session_message
  WHERE type = 'assistant' AND time_created >= ?
  ORDER BY time_created ASC
`;

const USER_QUERY = `
  SELECT time_created AS t, session_id AS sid
  FROM session_message
  WHERE type = 'user' AND time_created >= ?
  ORDER BY time_created ASC
`;

const SESSION_QUERY = `SELECT id, title FROM session_v2`;

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(target, source) {
  target.input += n(source.input);
  target.output += n(source.output);
  target.reasoning += n(source.reasoning);
  target.cacheRead += n(source.cacheRead);
  target.cacheWrite += n(source.cacheWrite);
  target.total = target.input + target.output + target.reasoning + target.cacheRead + target.cacheWrite;
}

function emptyDay(day) {
  return {
    day,
    requests: 0,
    prompts: 0,
    sessions: new Set(),
    tokens: emptyTokens(),
    listValue: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    limitEvents: [],
    firstSuccessAt: null,
    lastSuccessAt: null,
    firstEventAt: null,
  };
}

function serializeDay(d, estimate) {
  const hit = d.limitEvents.find((e) => e.requestsAt != null && e.requestsAt > 0) || null;
  const lastEvent = d.limitEvents.length ? d.limitEvents[d.limitEvents.length - 1] : null;
  return {
    day: d.day,
    requests: d.requests,
    prompts: d.prompts,
    sessions: d.sessions.size,
    tokens: { ...d.tokens },
    listValue: round(d.listValue, 4),
    pricedRequests: d.pricedRequests,
    unpricedRequests: d.unpricedRequests,
    limitEvents: d.limitEvents.length,
    firstEventAt: d.firstEventAt ? new Date(d.firstEventAt).toISOString() : null,
    lastEventAt: lastEvent ? new Date(lastEvent.time).toISOString() : null,
    firstSuccessAt: d.firstSuccessAt ? new Date(d.firstSuccessAt).toISOString() : null,
    lastSuccessAt: d.lastSuccessAt ? new Date(d.lastSuccessAt).toISOString() : null,
    hit: hit
      ? {
          at: new Date(hit.time).toISOString(),
          requests: hit.requestsAt,
          tokens: hit.tokensAt,
          listValue: round(hit.valueAt, 4),
          source: hit.source,
          retryAfterMs: hit.retryAfterMs,
          resetAt: hit.resetAt ? new Date(hit.resetAt).toISOString() : null,
        }
      : null,
  };
}

/**
 * Rolls up a list of per-day entries. Used for the range totals on the
 * dashboard (7d / 30d / whole tracked history). Tokens are kept split by
 * component so the UI can show where the tokens actually went; the local
 * database is the only source with a reasoning-token column.
 */
function aggregateDayEntries(entries) {
  const tokens = emptyTokens();
  const sessions = new Set();
  let requests = 0;
  let prompts = 0;
  let listValue = 0;
  let activeDays = 0;
  let firstDay = null;
  let lastDay = null;

  for (const entry of entries) {
    if (!entry) continue;
    requests += entry.requests;
    prompts += entry.prompts;
    listValue += entry.listValue;
    addTokens(tokens, entry.tokens);
    for (const sid of entry.sessions) sessions.add(sid);
    if (entry.requests > 0) {
      activeDays += 1;
      if (firstDay == null || entry.day < firstDay) firstDay = entry.day;
      if (lastDay == null || entry.day > lastDay) lastDay = entry.day;
    }
  }

  const days = entries.length;
  return {
    days,
    activeDays,
    requests,
    prompts,
    sessions: sessions.size,
    tokens: { ...tokens },
    listValue: round(listValue, 4),
    firstDay,
    lastDay,
    avgTokensPerDay: days > 0 ? Math.round(tokens.total / days) : 0,
    avgRequestsPerDay: days > 0 ? round(requests / days, 2) : 0,
  };
}

function readLogLimitEvents(windowStart) {
  const events = [];
  try {
    const stat = fs.statSync(LOG_PATH);
    const bytes = Math.min(stat.size, 1_500_000);
    if (bytes <= 0) return events;
    const buf = Buffer.alloc(bytes);
    const fd = fs.openSync(LOG_PATH, "r");
    try {
      fs.readSync(fd, buf, 0, bytes, stat.size - bytes);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.toString("utf8");
    const re = /^timestamp=([^\s]+)\s+level=ERROR\s+/;
    for (const line of text.split(/\r?\n/)) {
      if (!/Free usage limit|FreeUsageLimitError/i.test(line)) continue;
      const m = line.match(re);
      if (!m) continue;
      const time = Date.parse(m[1]);
      if (!Number.isFinite(time) || time < windowStart) continue;
      const sid = (line.match(/sessionID=([^\s]+)/) || [])[1] || null;
      events.push({ time, sessionId: sid });
    }
  } catch {
    /* log is optional */
  }

  // De-duplicate repeated error lines for the same event.
  events.sort((a, b) => a.time - b.time);
  const unique = [];
  for (const event of events) {
    const prev = unique[unique.length - 1];
    if (prev && Math.abs(prev.time - event.time) < 1500 && prev.sessionId === event.sessionId) {
      continue;
    }
    unique.push(event);
  }
  return unique;
}

function buildEstimates(hitPoints) {
  const units = ["requests", "listValue", "tokens"];

  const result = {};
  for (const unit of units) {
    const values = hitPoints
      .map((h) => (unit === "requests" ? h.requests : unit === "listValue" ? h.listValue : h.tokens))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);

    if (values.length < config.minHitPointsForEstimate) {
      result[unit] = {
        source: "fallback",
        n: values.length,
        safe: config.fallback[unit],
        likely: config.fallback[unit],
        max: config.fallback[unit],
        min: config.fallback[unit],
      };
      continue;
    }

    result[unit] = {
      source: "history",
      n: values.length,
      safe: round(quantile(values, 0.25), unit === "listValue" ? 4 : 0),
      likely: round(median(values), unit === "listValue" ? 4 : 0),
      max: round(values[values.length - 1], unit === "listValue" ? 4 : 0),
      min: round(values[0], unit === "listValue" ? 4 : 0),
    };
  }
  return result;
}

function recentRate(rows, unit, now, windowMs = 2 * 3_600_000) {
  const start = now - windowMs;
  const recent = rows.filter((r) => r.t >= start);
  if (!recent.length) return 0;
  const total = recent.reduce((acc, r) => {
    if (unit === "requests") return acc + 1;
    if (unit === "listValue") return acc + listValueOf(r.model, r.tokens).value;
    return acc + r.tokens.total;
  }, 0);
  return total / windowMs; // units per millisecond
}

function buildData() {
  const now = Date.now();
  const windowStart = now - config.historyDays * DAY_MS;

  if (!fs.existsSync(DB_PATH)) {
    return {
      error: {
        code: "db_missing",
        message: "OpenCode database not found.",
        path: DB_PATH,
      },
      meta: {
        generatedAt: new Date(now).toISOString(),
        dbPath: DB_PATH,
        logPath: LOG_PATH,
      },
    };
  }

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (error) {
    return {
      error: {
        code: "db_open_failed",
        message: `Could not open OpenCode database: ${error.message}`,
        path: DB_PATH,
      },
      meta: {
        generatedAt: new Date(now).toISOString(),
        dbPath: DB_PATH,
        logPath: LOG_PATH,
      },
    };
  }

  let assistantRows;
  let userRows;
  let sessionRows;
  try {
    assistantRows = db.prepare(ASSISTANT_QUERY).all(windowStart);
    userRows = db.prepare(USER_QUERY).all(windowStart);
    sessionRows = db.prepare(SESSION_QUERY).all();
  } finally {
    db.close();
  }

  const sessionTitles = new Map(sessionRows.map((s) => [s.id, s.title]));

  const days = new Map();
  const successRows = [];
  const sessionStats = new Map();
  const modelStats = new Map();

  // Go plan: local rows only. Console supplies exact money meters and the
  // billing-period activity; local rows add per-model tokens and the
  // request-count view that Console does not store per token type.
  const goDays = new Map();
  const goRows = [];
  const goModels = new Map();
  const goHourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: 0,
    tokens: 0,
  }));

  // All providers/plans: free, Go, Zen pay-as-you-go, and external APIs.
  const allRows = [];
  const allProviders = new Map(); // "kind:provider" -> aggregate
  const allProviderRows = new Map(); // "kind:provider" -> rows
  const allPlanDays = new Map(); // day -> { requests, tokens, costUsd, providers: Map }
  const allHourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: 0,
    tokens: 0,
    costUsd: 0,
  }));
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: 0,
    tokens: 0,
    listValue: 0,
    limitEvents: 0,
  }));

  const todayStart = utcDayStart(now);

  const getDay = (day) => {
    if (!days.has(day)) days.set(day, emptyDay(day));
    return days.get(day);
  };

  const getGoDay = (day) => {
    let entry = goDays.get(day);
    if (!entry) {
      entry = {
        day,
        requests: 0,
        sessions: new Set(),
        tokens: emptyTokens(),
        models: new Map(),
        firstAt: null,
        lastAt: null,
      };
      goDays.set(day, entry);
    }
    return entry;
  };

  const getAllProvider = (info) => {
    const key = `${info.kind}:${info.provider}`;
    let entry = allProviders.get(key);
    if (!entry) {
      entry = {
        key,
        kind: info.kind,
        provider: info.provider,
        providerName: info.providerName,
        plan: info.plan,
        requests: 0,
        tokens: emptyTokens(),
        costUsd: 0,
        sessions: new Set(),
        models: new Set(),
        firstAt: null,
        lastAt: null,
      };
      allProviders.set(key, entry);
    }
    return entry;
  };

  const getAllDay = (day) => {
    let entry = allPlanDays.get(day);
    if (!entry) {
      entry = {
        day,
        requests: 0,
        sessions: new Set(),
        tokens: emptyTokens(),
        costUsd: 0,
        providers: new Map(),
      };
      allPlanDays.set(day, entry);
    }
    return entry;
  };

  for (const row of assistantRows) {
    const t = Number(row.t);
    const isLimit = row.error_type === "provider.free-limit";
    const info = classify(row.provider, row.model);
    const kind = info.kind;
    if (!isLimit && !row.model) continue;
    // Only free-limit refusals are usage-adjacent events; other provider
    // errors are not successful requests and must not enter any counter.
    if (!isLimit && row.error_type) continue;

    const day = dayKey(t);
    const dayEntry = getDay(day);

    if (isLimit) {
      const retry = Number(row.retry_after_ms);
      const resetAt = Number.isFinite(retry) && retry > 0 ? t + retry : nextUtcMidnight(t);
      const event = {
        time: t,
        at: new Date(t).toISOString(),
        source: "session",
        sessionId: row.sid,
        status: Number(row.error_status) || 429,
        message: row.error_message || "Free usage limit reached",
        retryAfterMs: Number.isFinite(retry) ? retry : null,
        resetAt,
        // Filled in after the scan: requests inside the announced 24h window
        // (resetAt - 24h through the refusal), not the UTC-day-to-date count.
        requestsAt: null,
        tokensAt: 0,
        valueAt: 0,
        windowStartAt: null,
      };
      dayEntry.limitEvents.push(event);
      if (!dayEntry.firstEventAt) dayEntry.firstEventAt = t;
      if (t >= todayStart) hourly[new Date(t).getUTCHours()].limitEvents += 1;
      continue;
    }

    const tokens = {
      input: n(row.input),
      output: n(row.output),
      reasoning: n(row.reasoning),
      cacheRead: n(row.cache_read),
      cacheWrite: n(row.cache_write),
    };
    tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;

    const model = row.model || "unknown";
    const sid = row.sid;
    const costUsd = Number(row.cost) || 0;

    // All-plan aggregation. This is the cross-provider view; it deliberately
    // includes free and Go as well so totals cover every request.
    {
      const provider = getAllProvider(info);
      provider.requests += 1;
      provider.sessions.add(sid);
      provider.models.add(model);
      addTokens(provider.tokens, tokens);
      provider.costUsd += costUsd;
      if (!provider.firstAt) provider.firstAt = t;
      provider.lastAt = t;

      const allDay = getAllDay(day);
      allDay.requests += 1;
      allDay.sessions.add(sid);
      addTokens(allDay.tokens, tokens);
      allDay.costUsd += costUsd;

      let providerDay = allDay.providers.get(provider.key);
      if (!providerDay) {
        providerDay = {
          key: provider.key,
          kind: info.kind,
          provider: info.provider,
          providerName: info.providerName,
          plan: info.plan,
          requests: 0,
          tokens: emptyTokens(),
          costUsd: 0,
        };
        allDay.providers.set(provider.key, providerDay);
      }
      providerDay.requests += 1;
      addTokens(providerDay.tokens, tokens);
      providerDay.costUsd += costUsd;

      const allRow = {
        t,
        sid,
        kind,
        provider: info.provider,
        providerName: info.providerName,
        plan: info.plan,
        model,
        tokens,
        costUsd,
      };
      allRows.push(allRow);
      if (!allProviderRows.has(provider.key)) allProviderRows.set(provider.key, []);
      allProviderRows.get(provider.key).push(allRow);

      if (t >= todayStart) {
        const h = new Date(t).getUTCHours();
        allHourly[h].requests += 1;
        allHourly[h].tokens += tokens.total;
        allHourly[h].costUsd += costUsd;
      }
    }

    if (kind === "go") {
      const goDay = getGoDay(day);
      goDay.requests += 1;
      goDay.sessions.add(sid);
      addTokens(goDay.tokens, tokens);
      goDay.models.set(model, (goDay.models.get(model) || 0) + 1);
      if (!goDay.firstAt) goDay.firstAt = t;
      goDay.lastAt = t;
      goRows.push({ t, sid, model, tokens });

      if (t >= todayStart) {
        const h = new Date(t).getUTCHours();
        goHourly[h].requests += 1;
        goHourly[h].tokens += tokens.total;
      }

      if (!goModels.has(model)) {
        goModels.set(model, {
          id: model,
          requests: 0,
          tokens: emptyTokens(),
          sessions: new Set(),
          firstAt: t,
          lastAt: t,
          todayRequests: 0,
          todayTokens: emptyTokens(),
        });
      }
      const goModel = goModels.get(model);
      goModel.requests += 1;
      goModel.lastAt = Math.max(goModel.lastAt, t);
      addTokens(goModel.tokens, tokens);
      goModel.sessions.add(sid);
      if (t >= todayStart) {
        goModel.todayRequests += 1;
        addTokens(goModel.todayTokens, tokens);
      }
      continue;
    }

    // Zen pay-as-you-go and external providers are fully covered by the
    // all-provider aggregation; they do not enter the free-tier bucket.
    if (kind !== "free") continue;

    const price = listValueOf(row.model, tokens);

    dayEntry.requests += 1;
    dayEntry.sessions.add(sid);
    addTokens(dayEntry.tokens, tokens);
    dayEntry.listValue += price.value;
    if (price.priced) dayEntry.pricedRequests += 1;
    else dayEntry.unpricedRequests += 1;
    if (!dayEntry.firstSuccessAt) dayEntry.firstSuccessAt = t;
    dayEntry.lastSuccessAt = t;

    successRows.push({ t, sid, model, tokens, listValue: price.value, priced: price.priced });

    if (t >= todayStart) {
      const h = new Date(t).getUTCHours();
      hourly[h].requests += 1;
      hourly[h].tokens += tokens.total;
      hourly[h].listValue += price.value;
    }

    if (!sessionStats.has(sid)) {
      sessionStats.set(sid, {
        id: sid,
        title: sessionTitles.get(sid) || "Untitled session",
        requests: 0,
        tokens: emptyTokens(),
        listValue: 0,
        firstAt: t,
        lastAt: t,
        requestsToday: 0,
        tokensToday: emptyTokens(),
        listValueToday: 0,
        firstAtToday: null,
        lastAtToday: 0,
        limitEvents: 0,
        models: new Set(),
        modelsToday: new Set(),
      });
    }
    const session = sessionStats.get(sid);
    session.requests += 1;
    session.lastAt = Math.max(session.lastAt, t);
    session.firstAt = Math.min(session.firstAt, t);
    addTokens(session.tokens, tokens);
    session.listValue += price.value;
    session.models.add(model);

    if (t >= todayStart) {
      session.requestsToday += 1;
      if (session.firstAtToday == null) session.firstAtToday = t;
      session.lastAtToday = Math.max(session.lastAtToday, t);
      addTokens(session.tokensToday, tokens);
      session.listValueToday += price.value;
      session.modelsToday.add(model);
    }

    if (!modelStats.has(model)) {
      modelStats.set(model, {
        id: model,
        requests: 0,
        tokens: emptyTokens(),
        listValue: 0,
        lastAt: 0,
        priced: price.priced,
      });
    }
    const modelStat = modelStats.get(model);
    modelStat.requests += 1;
    modelStat.lastAt = Math.max(modelStat.lastAt, t);
    addTokens(modelStat.tokens, tokens);
    modelStat.listValue += price.value;
  }

  const sumGoRows = (rows) => {
    const tokens = emptyTokens();
    const sessions = new Set();
    for (const row of rows) {
      addTokens(tokens, row.tokens);
      sessions.add(row.sid);
    }
    return { requests: rows.length, sessions: sessions.size, tokens };
  };

  const goLocal = {
    detected: goRows.length > 0,
    today: sumGoRows(goRows.filter((r) => r.t >= todayStart)),
    last5Hours: sumGoRows(goRows.filter((r) => r.t >= now - 5 * 3_600_000)),
    last7Days: sumGoRows(goRows.filter((r) => r.t >= now - 7 * DAY_MS)),
    last30Days: sumGoRows(goRows.filter((r) => r.t >= now - 30 * DAY_MS)),
    tracked: sumGoRows(goRows),
    firstAt: goRows.length ? new Date(goRows[0].t).toISOString() : null,
    lastAt: goRows.length ? new Date(goRows[goRows.length - 1].t).toISOString() : null,
    hourly: goHourly,
    days: [],
    models: [...goModels.values()]
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10)
      .map((model) => ({
        id: model.id,
        requests: model.requests,
        sessions: model.sessions.size,
        tokens: { ...model.tokens },
        firstAt: new Date(model.firstAt).toISOString(),
        lastAt: new Date(model.lastAt).toISOString(),
        todayRequests: model.todayRequests,
        todayTokens: { ...model.todayTokens },
      })),
  };

  const goDayCount = Math.min(30, config.chartDays);
  for (let i = goDayCount - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS);
    const dayEntry = goDays.get(key);
    goLocal.days.push(
      dayEntry
        ? {
            day: key,
            requests: dayEntry.requests,
            sessions: dayEntry.sessions.size,
            tokens: { ...dayEntry.tokens },
            models: Object.fromEntries(dayEntry.models),
          }
        : { day: key, requests: 0, sessions: 0, tokens: emptyTokens(), models: {} },
    );
  }

  const sumAllRows = (rows) => {
    const tokens = emptyTokens();
    const sessions = new Set();
    let costUsd = 0;
    for (const row of rows) {
      addTokens(tokens, row.tokens);
      sessions.add(row.sid);
      costUsd += row.costUsd;
    }
    return {
      requests: rows.length,
      sessions: sessions.size,
      tokens,
      costUsd: round(costUsd, 4),
    };
  };

  const thirtyDayRows = allRows.filter((r) => r.t >= now - 30 * DAY_MS);
  const thirtyDayRequests = thirtyDayRows.length;

  const providerSummaries = [...allProviders.values()]
    .map((provider) => {
      const rows = allProviderRows.get(provider.key) || [];
      return {
        key: provider.key,
        kind: provider.kind,
        provider: provider.provider,
        providerName: provider.providerName,
        plan: provider.plan,
        requests: provider.requests,
        sessions: provider.sessions.size,
        tokens: { ...provider.tokens },
        costUsd: round(provider.costUsd, 4),
        firstAt: provider.firstAt ? new Date(provider.firstAt).toISOString() : null,
        lastAt: provider.lastAt ? new Date(provider.lastAt).toISOString() : null,
        today: sumAllRows(rows.filter((r) => r.t >= todayStart)),
        last7Days: sumAllRows(rows.filter((r) => r.t >= now - 7 * DAY_MS)),
        last30Days: sumAllRows(rows.filter((r) => r.t >= now - 30 * DAY_MS)),
        sharePct: thirtyDayRequests > 0 ? round((rows.filter((r) => r.t >= now - 30 * DAY_MS).length / thirtyDayRequests) * 100, 1) : 0,
        models: [...provider.models],
      };
    })
    .sort((a, b) => b.last30Days.requests - a.last30Days.requests || b.requests - a.requests);

  const allModelMap = new Map();
  for (const row of allRows) {
    const key = `${row.kind}:${row.provider}:${row.model}`;
    let entry = allModelMap.get(key);
    if (!entry) {
      entry = {
        key,
        kind: row.kind,
        provider: row.provider,
        providerName: row.providerName,
        plan: row.plan,
        model: row.model,
        requests: 0,
        sessions: new Set(),
        tokens: emptyTokens(),
        costUsd: 0,
        lastAt: null,
        last30Days: { requests: 0, tokens: emptyTokens(), costUsd: 0 },
      };
      allModelMap.set(key, entry);
    }
    entry.requests += 1;
    entry.sessions.add(row.sid);
    addTokens(entry.tokens, row.tokens);
    entry.costUsd += row.costUsd;
    entry.lastAt = row.t;
    if (row.t >= now - 30 * DAY_MS) {
      entry.last30Days.requests += 1;
      addTokens(entry.last30Days.tokens, row.tokens);
      entry.last30Days.costUsd += row.costUsd;
    }
  }

  const allUsage = {
    detected: allRows.length > 0,
    providerCount: providerSummaries.length,
    kinds: [...new Set(providerSummaries.map((p) => p.kind))],
    plans: [...new Set(providerSummaries.map((p) => p.plan))],
    today: sumAllRows(allRows.filter((r) => r.t >= todayStart)),
    last7Days: sumAllRows(allRows.filter((r) => r.t >= now - 7 * DAY_MS)),
    last30Days: sumAllRows(thirtyDayRows),
    tracked: sumAllRows(allRows),
    firstAt: allRows.length ? new Date(allRows[0].t).toISOString() : null,
    lastAt: allRows.length ? new Date(allRows[allRows.length - 1].t).toISOString() : null,
    hourly: allHourly,
    providers: providerSummaries,
    models: [...allModelMap.values()]
      .sort((a, b) => b.last30Days.requests - a.last30Days.requests || b.requests - a.requests)
      .slice(0, 15)
      .map((model) => ({
        key: model.key,
        kind: model.kind,
        provider: model.provider,
        providerName: model.providerName,
        plan: model.plan,
        model: model.model,
        requests: model.requests,
        sessions: model.sessions.size,
        tokens: { ...model.tokens },
        costUsd: round(model.costUsd, 4),
        lastAt: model.lastAt ? new Date(model.lastAt).toISOString() : null,
        last30Days: {
          requests: model.last30Days.requests,
          tokens: { ...model.last30Days.tokens },
          costUsd: round(model.last30Days.costUsd, 4),
        },
      })),
    days: [],
    costNote: "Cost is OpenCode's reported local cost; Go is subscription-included and can show $0 here — use the Go meters above.",
  };

  const allDayCount = Math.min(30, config.chartDays);
  for (let i = allDayCount - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS);
    const dayEntry = allPlanDays.get(key);
    allUsage.days.push(
      dayEntry
        ? {
            day: key,
            requests: dayEntry.requests,
            sessions: dayEntry.sessions.size,
            tokens: { ...dayEntry.tokens },
            costUsd: round(dayEntry.costUsd, 4),
            providers: [...dayEntry.providers.values()].map((p) => ({
              key: p.key,
              kind: p.kind,
              provider: p.provider,
              providerName: p.providerName,
              plan: p.plan,
              requests: p.requests,
              tokens: { ...p.tokens },
              costUsd: round(p.costUsd, 4),
            })),
          }
        : {
            day: key,
            requests: 0,
            sessions: 0,
            tokens: emptyTokens(),
            costUsd: 0,
            providers: [],
          },
    );
  }

  const go = goSummary(goLocal);
  const goDetected = go.detected;
  // Use the exact Console product name (Go / Go Plus / Go Teams) in the
  // all-provider table instead of the generic provider label.
  if (goDetected && go.plan && go.plan.productName) {
    for (const provider of allUsage.providers) {
      if (provider.kind === "go") provider.plan = go.plan.productName;
    }
    for (const model of allUsage.models) {
      if (model.kind === "go") model.plan = go.plan.productName;
    }
    allUsage.plans = [...new Set(allUsage.providers.map((provider) => provider.plan))];
  }
  const allDetected = allUsage.detected;
  const paidDetected = allUsage.kinds.some((kind) => kind === "zen" || kind === "external");

  for (const row of userRows) {
    const t = Number(row.t);
    const dayEntry = getDay(dayKey(t));
    dayEntry.prompts += 1;
  }

  // Merge zero-usage days so charts keep their shape.
  const allDays = [];
  for (let i = config.historyDays - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * DAY_MS);
    allDays.push(getDay(key));
  }

  // Session limit-event counts (for badges).
  for (const dayEntry of days.values()) {
    for (const event of dayEntry.limitEvents) {
      const session = sessionStats.get(event.sessionId);
      if (session) session.limitEvents += 1;
    }
  }

  // Merge log-only free-limit events. Most app errors also exist in the DB;
  // this catches a failure that was logged before the message row was written.
  const logEvents = readLogLimitEvents(windowStart);
  for (const logEvent of logEvents) {
    const dayEntry = getDay(dayKey(logEvent.time));
    const match = dayEntry.limitEvents.find(
      (e) => Math.abs(e.time - logEvent.time) < 5000 || (e.sessionId && e.sessionId === logEvent.sessionId && Math.abs(e.time - logEvent.time) < 60_000),
    );
    if (match) {
      if (match.source !== "session") match.source = "both";
      if (!match.sessionId && logEvent.sessionId) match.sessionId = logEvent.sessionId;
      continue;
    }
    const successBefore = successRows.filter((r) => r.t <= logEvent.time && dayKey(r.t) === dayEntry.day);
    dayEntry.limitEvents.push({
      time: logEvent.time,
      at: new Date(logEvent.time).toISOString(),
      source: "log",
      sessionId: logEvent.sessionId,
      status: 429,
      message: "Free usage limit reached (from OpenCode log)",
      retryAfterMs: null,
      resetAt: nextUtcMidnight(logEvent.time),
      requestsAt: null,
      tokensAt: 0,
      valueAt: 0,
      windowStartAt: null,
    });
    if (!dayEntry.firstEventAt) dayEntry.firstEventAt = logEvent.time;
  }

  // Merge Console-side refusals (server-observed 429s from any connected
  // client — the desktop app, the CLI signed in, or third-party apps).
  for (const ev of consoleData.events) {
    if (ev.time < windowStart || ev.time > now) continue;
    const dayEntry = getDay(dayKey(ev.time));
    const dup = dayEntry.limitEvents.some((e) => Math.abs(e.time - ev.time) < 5000);
    if (dup) continue;
    dayEntry.limitEvents.push({
      time: ev.time,
      at: new Date(ev.time).toISOString(),
      source: "console",
      sessionId: null,
      status: ev.statusCode,
      message: "Free-limit refusal recorded server-side (Console request log)",
      retryAfterMs: null,
      resetAt: null,
      requestsAt: null,
      tokensAt: 0,
      valueAt: 0,
    });
    if (!dayEntry.firstEventAt) dayEntry.firstEventAt = ev.time;
  }

  // Requests this machine observed inside each announced 24h window. A 429
  // with retryAfterMs ends its window exactly at retryAfterMs, so the window
  // start is resetAt - 24h and the count before the refusal is the local
  // contribution to the bucket the server refused. It is still only this
  // machine's requests — other clients on the same network are invisible.
  {
    const times = new Float64Array(successRows.length);
    const prefReq = new Float64Array(successRows.length + 1);
    const prefTok = new Float64Array(successRows.length + 1);
    const prefVal = new Float64Array(successRows.length + 1);
    for (let i = 0; i < successRows.length; i += 1) {
      const r = successRows[i];
      times[i] = r.t;
      prefReq[i + 1] = prefReq[i] + 1;
      prefTok[i + 1] = prefTok[i] + r.tokens.total;
      prefVal[i + 1] = prefVal[i] + r.listValue;
    }
    const lowerBound = (value) => {
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const dayEntry of days.values()) {
      for (const event of dayEntry.limitEvents) {
        if (event.source === "console") continue;
        // A 429 with retryAfterMs announces the exact end of its 24h window,
        // so the window starts at resetAt - 24h. That is the bucket the server
        // refused, not the trailing 24h before the refusal (which can include
        // the previous day's requests and overstate the boundary).
        const from =
          event.retryAfterMs != null && event.resetAt != null
            ? Math.min(event.resetAt - DAY_MS, event.time)
            : event.time - DAY_MS;
        const a = lowerBound(from);
        const b = lowerBound(event.time);
        if (b <= a) continue;
        event.requestsAt = b - a;
        event.tokensAt = prefTok[b] - prefTok[a];
        event.valueAt = round(prefVal[b] - prefVal[a], 4);
        event.windowStartAt = from;
        // Server-side rollup for the UTC day of the refusal (account-wide,
        // from the Console export). Exact, but a day is not the 24h window.
        const rollup = consoleData.exportDays.get(dayKey(event.time));
        event.serverDayRequests = rollup ? rollup.requests : null;
        event.serverDayTokens = rollup
          ? rollup.inputTokens + rollup.outputTokens + rollup.cacheReadTokens + rollup.cacheWriteTokens
          : 0;
      }
    }
  }

  for (const dayEntry of days.values()) {
    dayEntry.limitEvents.sort((a, b) => a.time - b.time);
  }

  const today = getDay(dayKey(now));
  const yesterday = getDay(dayKey(now - DAY_MS));

  // Limit-hit observations: one point per distinct server reset boundary, with
  // the window usage observed at the refusal that announced it.
  const hitPoints = [];
  let lastBoundary = null;
  const allLimitEvents = [...days.values()]
    .flatMap((d) => d.limitEvents)
    .sort((a, b) => a.time - b.time);
  for (const event of allLimitEvents) {
    if (event.requestsAt == null || event.requestsAt <= 0) continue;
    const boundary = event.resetAt ?? event.time;
    // Repeated refusals of the same window report the reset a few hundred
    // milliseconds apart (one retryAfterMs per request), so cluster.
    if (lastBoundary != null && Math.abs(boundary - lastBoundary) <= 120_000) continue;
    lastBoundary = boundary;
    hitPoints.push({
      day: dayKey(event.time),
      at: new Date(event.time).toISOString(),
      requests: event.requestsAt,
      tokens: event.tokensAt,
      listValue: round(event.valueAt, 4),
      resetAt: event.resetAt ? new Date(event.resetAt).toISOString() : null,
      windowStartAt: event.windowStartAt ? new Date(event.windowStartAt).toISOString() : null,
      source: event.source,
      serverDayRequests: event.serverDayRequests ?? null,
      serverDayTokens: event.serverDayTokens ?? 0,
    });
  }

  /* Quota window: the last public limiter (deleted 2026-10-11) used a fixed
     UTC day — Redis key <stage>:ratelimit:ip:<ip>:<YYYYMMDD>, with retry-after
     = seconds to 00:00 UTC. The live inference service now returns its own
     reset instant: 18 of 21 local 429s before 2026-11-01 landed within ±3 min
     of 00:00 UTC, then from 2026-11-01 every reset was +15.8..+52.3 min after
     midnight and drifted day to day. Every refusal inside one period still
     points to the same instant, and capacity can free up before it. The
     server-confirmed reset (from the latest 429) always wins over any local
     projection. */
  const serverResets = [];
  for (const dayEntry of days.values()) {
    for (const event of dayEntry.limitEvents) {
      if (Number.isFinite(event.retryAfterMs) && event.retryAfterMs > 0) {
        serverResets.push(event.time + event.retryAfterMs);
      }
    }
  }
  serverResets.sort((a, b) => a - b);

  let windowBoundaryAt = null; // latest server reset that has already passed
  for (const reset of serverResets) {
    if (reset <= now) windowBoundaryAt = reset;
    else break;
  }
  const pendingServerReset = serverResets.length ? serverResets[serverResets.length - 1] : null;
  const pendingServerResetActive = pendingServerReset != null && pendingServerReset > now;

  // Server-side success rows (Console) — they include usage from other
  // devices/apps on the account that the local database never sees.
  const serverSeen = consoleData.serverSeen === true;
  // Local successes only. The free bucket is per network, while Console rows
  // can include account clients on other networks; a remote row must not
  // tighten this network's window-start bound.
  const firstSuccessAfter = (from) => {
    for (const r of successRows) {
      if (r.t > from) return r.t;
    }
    return null;
  };

  // Window start: the last passed server boundary while it is still fresh
  // (matches the server's own period); otherwise a rolling 24h lookback so an
  // idle stretch never sums several days of usage into one number.
  const boundaryFresh = windowBoundaryAt != null && now - windowBoundaryAt < DAY_MS;
  const windowFrom = boundaryFresh ? windowBoundaryAt : now - DAY_MS;
  const windowLocalRows = successRows.filter((r) => r.t >= windowFrom);
  const windowServerRows = serverSeen ? consoleData.rows.filter((r) => r.t >= windowFrom) : [];
  // Prefer whichever source observed more: the Console is a superset once
  // account attribution is active, but its sync can lag the local database.
  const preferServer = serverSeen && windowServerRows.length >= windowLocalRows.length;
  const windowUsedRows = preferServer ? windowServerRows : windowLocalRows;
  // The Console request-log rows only carry a scalar token count, so a
  // component breakdown exists only for the local rows. Keep it separate from
  // usedTokens rather than pretending it covers a server-wide window.
  const localWindowTokens = emptyTokens();
  for (const row of windowLocalRows) addTokens(localWindowTokens, row.tokens);
  const windowUsed = {
    requests: windowUsedRows.length,
    tokens:
      preferServer
        ? windowServerRows.reduce((acc, r) => acc + r.tokens, 0)
        : windowLocalRows.reduce((acc, r) => acc + r.tokens.total, 0),
    listValue: round(
      preferServer
        ? windowServerRows.reduce((acc, r) => acc + r.listValue, 0)
        : windowLocalRows.reduce((acc, r) => acc + r.listValue, 0),
      4,
    ),
    source: preferServer ? "server" : "local",
  };

  // Projection: if the limit were hit right now, the reset would land 24h
  // after the current period's first request.
  const projectedAnchor = firstSuccessAfter(boundaryFresh ? windowBoundaryAt : now - DAY_MS);
  const projectedResetAt =
    projectedAnchor != null && projectedAnchor + DAY_MS > now ? projectedAnchor + DAY_MS : null;

  // Only the five most recent refusals inform the estimate. Older points
  // predate the drifting reset (or are one-off heavy days) and would widen the
  // range with a regime the live service no longer uses.
  const estimateHits = hitPoints.slice(-5);
  const estimates = buildEstimates(estimateHits);

  // Attach the current window's live numbers and pace to each estimate.
  for (const [unit, estimate] of Object.entries(estimates)) {
    const used =
      unit === "requests"
        ? windowUsed.requests
        : unit === "listValue"
          ? windowUsed.listValue
          : windowUsed.tokens;
    const rate = recentRate(successRows, unit, now);
    const remaining = Math.max(0, estimate.likely - used);
    let etaMs = null;
    if (rate > 0 && remaining > 0) etaMs = remaining / rate;
    estimate.used = round(used, unit === "listValue" ? 4 : 0);
    estimate.remaining = round(remaining, unit === "listValue" ? 4 : 0);
    estimate.pct = round(pct(used, estimate.likely), 1);
    estimate.etaMs = etaMs == null ? null : Math.min(etaMs, 7 * DAY_MS);
    estimate.usedAtHit = null;
  }

  const todayHit = today.limitEvents.find((e) => e.requestsAt != null) || null;
  if (todayHit) {
    for (const unit of ["requests", "listValue", "tokens"]) {
      const value =
        unit === "requests"
          ? todayHit.requestsAt
          : unit === "listValue"
            ? todayHit.valueAt
            : todayHit.tokensAt;
      if (Number.isFinite(value)) estimates[unit].usedAtHit = round(value, unit === "listValue" ? 4 : 0);
    }
  }

  // Current status: only refusals that belong to the active window and whose
  // reset has not already passed. A refusal from a window that has reset is
  // history, not an open incident, even if requests succeeded after it.
  const recentEvents = [];
  for (const dayEntry of days.values()) {
    for (const event of dayEntry.limitEvents) {
      if (event.time >= now - 2 * DAY_MS) recentEvents.push(event);
    }
  }
  recentEvents.sort((a, b) => b.time - a.time);
  const lastEvent = recentEvents[0] || null;

  const eventReset = (event) => {
    if (!event) return null;
    if (Number.isFinite(event.retryAfterMs) && event.retryAfterMs > 0) return event.time + event.retryAfterMs;
    if (event.resetAt) {
      const parsed = Date.parse(event.resetAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null; // Console-side refusals carry no retryAfterMs
  };
  const lastEventReset = eventReset(lastEvent);
  const activeEvents = recentEvents.filter(
    (event) => event.time >= windowFrom && (eventReset(event) == null || eventReset(event) > now),
  );
  const activeEvent = activeEvents[0] || null;
  const activeEventReset = eventReset(activeEvent);

  // A success after the refusal counts from either source — the desktop app
  // writes locally, other apps only show up in the Console log.
  const successesAfter = (event) =>
    event
      ? Math.max(
          successRows.filter((r) => r.t > event.time).length,
          consoleData.rows.filter((r) => r.t > event.time).length,
        )
      : 0;
  const successAfterLastEvent = successesAfter(lastEvent);
  const successAfterActiveEvent = successesAfter(activeEvent);

  let status = "open";
  if (activeEvent && successAfterActiveEvent > 0) {
    status = "limit-banner";
  } else if (activeEvent) {
    status = "limited";
  } else if (!windowUsed.requests && !recentEvents.length && !today.prompts) {
    status = "unknown";
  }

  const lastRefusalPoint = hitPoints.length ? hitPoints[hitPoints.length - 1] : null;
  // How many requests this window could still take before it matches the
  // largest boundary ever observed at a refusal. This is a historical
  // ceiling, not the server's unpublished cap: the free tier is counted per
  // network, so other clients on the same network consume the same bucket.
  const headroomRequests =
    lastRefusalPoint && lastRefusalPoint.requests > 0
      ? Math.max(0, lastRefusalPoint.requests - windowUsed.requests)
      : null;

  // The next reset is not knowable exactly until the server sends another
  // 429. When the last server boundary is still fresh, the window cannot have
  // opened before that boundary, and it must have opened by the first local
  // success. That gives an honest [earliest, latest] range instead of
  // presenting the first local request as the only possibility. Console rows
  // are deliberately excluded here: they are account-wide and may come from a
  // different network, so they must not tighten this network's bound.
  const resetRangeEarliest =
    boundaryFresh && projectedAnchor != null ? windowBoundaryAt + DAY_MS : null;
  const resetRangeLatest =
    boundaryFresh && projectedAnchor != null ? projectedAnchor + DAY_MS : null;
  const resetRange =
    resetRangeEarliest != null && resetRangeLatest != null && resetRangeLatest > now
      ? {
          earliest: new Date(resetRangeEarliest).toISOString(),
          latest: new Date(resetRangeLatest).toISOString(),
          basis: "last server boundary → first local request",
        }
      : null;

  const window = {
    hours: 24,
    startsAt: new Date(windowFrom).toISOString(),
    boundaryAt: boundaryFresh ? new Date(windowBoundaryAt).toISOString() : null,
    anchorAt: projectedAnchor != null ? new Date(projectedAnchor).toISOString() : null,
    firstSeenAt: projectedAnchor != null ? new Date(projectedAnchor).toISOString() : null,
    projectedResetAt: projectedResetAt != null ? new Date(projectedResetAt).toISOString() : null,
    resetRange,
    serverResetAt: pendingServerResetActive ? new Date(pendingServerReset).toISOString() : null,
    resetAt: null, // filled in below
    resetSource: "none",
    usedSource: windowUsed.source,
    // Successes observed while the server's reset is still pending: capacity
    // frees up continuously, so the limit is not a hard block until reset.
    recoveredEarly: Boolean(activeEvent && pendingServerResetActive && successAfterActiveEvent > 0),
    usedRequests: windowUsed.requests,
    usedTokens: windowUsed.tokens,
    usedListValue: windowUsed.listValue,
    lastRefusal: lastRefusalPoint
      ? {
          at: lastRefusalPoint.at,
          requests: lastRefusalPoint.requests,
          tokens: lastRefusalPoint.tokens,
          listValue: lastRefusalPoint.listValue,
          resetAt: lastRefusalPoint.resetAt,
          windowStartAt: lastRefusalPoint.windowStartAt,
        }
      : null,
    headroomRequests,
  };

  // The server-confirmed reset always wins — observed: successes between
  // refusals do not move the target instant. Once it has passed, the next
  // reset is unknown until the next 429. The estimate is 24h after the first
  // request this machine observed in the new window; another client on the
  // same network may have opened the window earlier, which would move the
  // real reset earlier too.
  const resetAt = pendingServerResetActive ? pendingServerReset : projectedResetAt;
  window.resetAt = resetAt != null ? new Date(resetAt).toISOString() : null;
  window.resetSource = resetAt == null ? "none" : pendingServerResetActive ? "server" : "estimated";
  window.usedTokensByType = preferServer ? null : { ...localWindowTokens };

  // Range totals for the dashboard. `tracked` covers config.historyDays (120
  // by default) of local free-model usage, while the Console export can reach
  // only the last 30 days via the request-log API.
  const totals = {
    window: {
      hours: 24,
      requests: windowUsed.requests,
      tokens: windowUsed.tokens,
      tokensByType: window.usedTokensByType,
      listValue: windowUsed.listValue,
      source: windowUsed.source,
    },
    last7Days: aggregateDayEntries(allDays.slice(-7)),
    last30Days: aggregateDayEntries(allDays.slice(-30)),
    tracked: aggregateDayEntries(allDays),
  };

  // Server-observed free window / inferred boundary. This is deliberately
  // separate from the free-tier quota itself: Console rows are exact for
  // account-attributed successes, but the real bucket is network-scoped and
  // the published cap does not exist.
  const serverRowsIn = (from, to) => {
    const models = new Map();
    let tokens = 0;
    let requests = 0;
    for (const row of consoleData.rows) {
      if (row.t < from || row.t > to) continue;
      requests += 1;
      tokens += Number(row.tokens) || 0;
      const model = row.model || "unknown";
      let entry = models.get(model);
      if (!entry) {
        entry = { model, requests: 0, tokens: 0 };
        models.set(model, entry);
      }
      entry.requests += 1;
      entry.tokens += Number(row.tokens) || 0;
    }
    return {
      requests,
      tokens,
      models: [...models.values()].sort((a, b) => b.requests - a.requests),
    };
  };

  const currentServerWindow = serverRowsIn(windowFrom, now);
  let boundaryEvidence = null;
  const boundaryRows = [];
  for (const hit of hitPoints) {
    if (!hit.resetAt) continue;
    const at = Date.parse(hit.at);
    const reset = Date.parse(hit.resetAt);
    if (!Number.isFinite(at) || !Number.isFinite(reset)) continue;
    const from = reset - DAY_MS;
    if (at < from) continue;
    const server = serverRowsIn(from, at);
    const boundary = {
      serverSuccesses: server.requests,
      tokens: server.tokens,
      models: server.models,
      at: hit.at,
      resetAt: hit.resetAt,
      windowStart: new Date(from).toISOString(),
      localRequests: hit.requests,
    };
    boundaryRows.push(boundary);
    if (!boundaryEvidence || server.requests > boundaryEvidence.serverSuccesses) {
      boundaryEvidence = boundary;
    }
  }

  const configuredInferred = Math.max(1, Number(config.freeQuota.inferredDailyRequests) || 512);
  const impliedAtBoundary = boundaryEvidence ? boundaryEvidence.serverSuccesses + 1 : null;
  const inferredDaily = Math.max(configuredInferred, impliedAtBoundary || 0);
  const inferredNewNetwork = Math.max(
    Number(config.freeQuota.inferredNewNetworkRequests) || inferredDaily * 2,
    inferredDaily * 2,
  );
  const evidenceStrong =
    impliedAtBoundary != null && impliedAtBoundary >= configuredInferred * 0.75;
  const freeQuota = {
    published: false,
    inferred: {
      dailyRequests: inferredDaily,
      newNetworkRequests: inferredNewNetwork,
      confidence: evidenceStrong ? "medium" : "low",
      basis: evidenceStrong
        ? `At least ${boundaryEvidence.serverSuccesses} retained server-logged free successes plus one 429 (${impliedAtBoundary}+ events) at ${boundaryEvidence.at}; the inferred 512 boundary comes from a fully logged refusal.`
        : `No high-count server boundary is retained; ${configuredInferred} is carried from the strongest prior observation.`,
      evidence: boundaryEvidence
        ? {
            ...boundaryEvidence,
            totalEvents: impliedAtBoundary,
            strong: evidenceStrong,
          }
        : null,
      note:
        "Inference only. The free cap is private and network-scoped; 512 fits the one fully logged boundary, and a fresh network may get a 2x allowance. Not an official quota.",
    },
    serverWindow: {
      from: new Date(windowFrom).toISOString(),
      to: new Date(now).toISOString(),
      requests: currentServerWindow.requests,
      tokens: currentServerWindow.tokens,
      models: currentServerWindow.models,
      source: "console-request-log",
      accountOnly: true,
      syncedAt: consoleData.lastSyncAt ? new Date(consoleData.lastSyncAt).toISOString() : null,
      lagging:
        !consoleData.lastSyncAt || now - consoleData.lastSyncAt > CONSOLE.intervalMs * 2,
      beyondInferred: currentServerWindow.requests > inferredDaily,
    },
    headroomUpperBound: Math.max(0, inferredDaily - currentServerWindow.requests),
    boundaries: boundaryRows
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-20)
      .map((boundary) => ({
        ...boundary,
        strong:
          boundary.serverSuccesses + 1 >= configuredInferred * 0.75,
      })),
    forecast: (() => {
      const recent1h = serverRowsIn(now - 3_600_000, now);
      const recent6h = serverRowsIn(now - 6 * 3_600_000, now);
      const remaining = Math.max(0, inferredDaily - currentServerWindow.requests);
      const perHour = recent1h.requests;
      const etaMs = perHour > 0 ? (remaining / perHour) * 3_600_000 : null;
      const resetMs = resetAt != null ? resetAt : null;
      return {
        recent1h: { requests: recent1h.requests, tokens: recent1h.tokens },
        recent6h: { requests: recent6h.requests, tokens: recent6h.tokens },
        requestsPerHour: perHour,
        remaining,
        etaMs: etaMs == null ? null : Math.min(etaMs, 7 * DAY_MS),
        resetAt: resetMs != null ? new Date(resetMs).toISOString() : null,
        likelyBeforeReset:
          etaMs == null || resetMs == null ? null : now + etaMs < resetMs,
      };
    })(),
    note:
      "Upper bound only: account-attributed Console rows are exact, but other clients on the same public network are invisible.",
  };

  // Live rates and a simple spike detector for the Overview alert card.
  const recentAll = (ms) => sumAllRows(allRows.filter((row) => row.t >= now - ms));
  const todayKey = dayKey(now);
  const todayDay =
    allUsage.days.find((day) => day.day === todayKey) || {
      requests: 0,
      tokens: emptyTokens(),
      costUsd: 0,
    };
  const previousDays = allUsage.days.filter((day) => day.day !== todayKey).slice(-7);
  const previousAvg = {
    requests: previousDays.length
      ? previousDays.reduce((sum, day) => sum + day.requests, 0) / previousDays.length
      : 0,
    tokens: previousDays.length
      ? previousDays.reduce((sum, day) => sum + day.tokens.total, 0) / previousDays.length
      : 0,
    costUsd: previousDays.length
      ? previousDays.reduce((sum, day) => sum + day.costUsd, 0) / previousDays.length
      : 0,
  };
  const requestRatio = previousAvg.requests > 0 ? todayDay.requests / previousAvg.requests : null;
  const costRatio = previousAvg.costUsd > 0 ? todayDay.costUsd / previousAvg.costUsd : null;
  const insights = {
    rates: {
      last1h: recentAll(3_600_000),
      last6h: recentAll(6 * 3_600_000),
      last24h: recentAll(24 * 3_600_000),
    },
    spike: {
      today: {
        requests: todayDay.requests,
        tokens: todayDay.tokens.total,
        costUsd: todayDay.costUsd,
      },
      previous7dAverage: previousAvg,
      requestRatio: requestRatio == null ? null : round(requestRatio, 2),
      costRatio: costRatio == null ? null : round(costRatio, 2),
      active:
        todayDay.requests >= 20 &&
        ((requestRatio != null && requestRatio >= 2) || (costRatio != null && costRatio >= 2.5)),
    },
  };

  const todayHours = hourly;

  const topSessions = [...sessionStats.values()]
    .filter((s) => s.requestsToday > 0)
    .sort((a, b) => b.requestsToday - a.requestsToday)
    .slice(0, 12)
    .map((s) => ({
      id: s.id,
      title: s.title,
      requests: s.requestsToday,
      tokens: { ...s.tokensToday },
      listValue: round(s.listValueToday, 4),
      firstAt: new Date(s.firstAtToday || s.firstAt).toISOString(),
      lastAt: new Date(s.lastAtToday || s.lastAt).toISOString(),
      limitEvents: s.limitEvents,
      models: [...s.modelsToday].map(prettyModel),
    }));

  const models = [...modelStats.values()]
    .sort((a, b) => b.requests - a.requests)
    .map((m) => ({
      id: m.id,
      name: prettyModel(m.id),
      requests: m.requests,
      tokens: { ...m.tokens },
      listValue: round(m.listValue, 4),
      priced: m.priced,
      lastAt: m.lastAt ? new Date(m.lastAt).toISOString() : null,
    }));

  const chartDays = allDays.slice(-config.chartDays).map((d) => serializeDay(d, estimates));

  const recentLimitEvents = (() => {
    // Refusals often arrive in bursts while a session keeps retrying. Collapse
    // consecutive refusals with identical usage into one row that keeps the
    // burst count, so the list reflects distinct boundary crossings.
    const grouped = [];
    for (const event of recentEvents.slice(0, 60)) {
      const prev = grouped[grouped.length - 1];
      if (
        prev &&
        prev.requestsAt === event.requestsAt &&
        prev.tokensAt === event.tokensAt &&
        Math.abs(prev.lastTime - event.time) <= 3_600_000
      ) {
        prev.count += 1;
        prev.firstTime = event.time;
        continue;
      }
      grouped.push({ ...event, count: 1, firstTime: event.time, lastTime: event.time });
    }
    return grouped.slice(0, 20).map((e) => ({
      at: new Date(e.firstTime).toISOString(),
      time: e.firstTime,
      lastAt: new Date(e.lastTime).toISOString(),
      count: e.count,
      source: e.source,
      sessionId: e.sessionId,
      sessionTitle: e.sessionId ? sessionTitles.get(e.sessionId) || "Untitled session" : null,
      status: e.status,
      retryAfterMs: e.retryAfterMs,
      resetAt: e.resetAt ? new Date(e.resetAt).toISOString() : null,
      requestsAt: e.requestsAt,
      tokensAt: e.tokensAt,
      listValueAt: e.valueAt,
      windowStartAt: e.windowStartAt ? new Date(e.windowStartAt).toISOString() : null,
      serverDayRequests: e.serverDayRequests ?? null,
      message: e.message,
    }));
  })();

  const dbSize = (() => {
    try {
      return fs.statSync(DB_PATH).size;
    } catch {
      return 0;
    }
  })();

  const describeEvent = (event, reset) =>
    event
      ? {
          at: event.at,
          time: event.time,
          source: event.source,
          sessionId: event.sessionId,
          sessionTitle: event.sessionId ? sessionTitles.get(event.sessionId) || "Untitled session" : null,
          status: event.status,
          retryAfterMs: event.retryAfterMs,
          resetAt: reset != null ? new Date(reset).toISOString() : null,
          requestsAt: event.requestsAt,
          tokensAt: event.tokensAt,
          listValueAt: event.valueAt,
          windowStartAt: event.windowStartAt ? new Date(event.windowStartAt).toISOString() : null,
          serverDayRequests: event.serverDayRequests ?? null,
        }
      : null;

  // Progress follows the window start. A server-confirmed boundary is exact;
  // otherwise the anchor is the first request observed after the last reset
  // and the progress is labelled as estimated.
  const progressFrom = boundaryFresh ? windowBoundaryAt : projectedAnchor;
  const windowProgress =
    progressFrom != null ? round(Math.max(0, Math.min(1, (now - progressFrom) / DAY_MS)), 4) : 0;
  const windowProgressSource = boundaryFresh ? "server" : projectedAnchor != null ? "estimated" : "none";

  return {
    meta: {
      generatedAt: new Date(now).toISOString(),
      dbPath: DB_PATH,
      logPath: LOG_PATH,
      dbSize,
      windowDays: config.historyDays,
      chartDays: config.chartDays,
      refreshMs: config.refreshMs,
      resetAt: resetAt != null ? new Date(resetAt).toISOString() : null,
      resetSource: window.resetSource,
      accountBucket: serverSeen,
      serverSeen,
      // The active plan is inferred from exact Console data and/or local rows.
      // It never changes the free-tier bucket. `plan` is the primary badge;
      // `plans` lists every detected plan/provider label.
      plan: goDetected ? "go" : paidDetected ? "paid" : "free",
      plans: allUsage.plans.length ? allUsage.plans : ["Free tier"],
      goDetected,
      paidDetected,
      allDetected,
      providerCount: allUsage.providerCount,
      utcDayEndsAt: new Date(nextUtcMidnight(now)).toISOString(),
      dayStart: new Date(todayStart).toISOString(),
      dayProgress: round((now - todayStart) / DAY_MS, 4),
      windowProgress,
      windowProgressSource,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
      status,
      statusReason:
        status === "limited"
          ? activeEventReset != null
            ? `A free-model request refused at ${new Date(activeEvent.time).toISOString()} is still inside its pending reset. The reset time is OpenCode's own (refusal time + retryAfterMs).`
            : `A server-side free-limit refusal at ${new Date(activeEvent.time).toISOString()} carries no retry-after value; the reset shown is an estimate.`
          : status === "limit-banner"
            ? window.recoveredEarly
              ? "Free requests are working again even though OpenCode's reset time is still pending — the free tier frees capacity continuously, so the limit is not a hard block until reset. The server-confirmed reset below still stands."
              : "A free-limit message was recorded, but free requests have succeeded since then."
            : status === "unknown"
              ? goDetected
                ? "No free-tier usage in the selected window. Go plan usage is shown separately from the exact Console meters."
                : "No free-model usage found in the selected window."
              : "No active free-limit refusal. The reset shown is an estimate: the window opened somewhere between the last server boundary and the first free request this machine observed, so the reset is 24h after an unknown instant in that range. Another client on the same network may have opened the window earlier still. OpenCode does not publish the quota or a remaining-count endpoint.",
      logLimitEvents: logEvents.length,
      dataWarning: null,
    },
    window,
    totals,
    freeQuota,
    insights,
    go,
    all: allUsage,
    server: consoleSummary(),
    today: serializeDay(today, estimates),
    yesterday: serializeDay(yesterday, estimates),
    days: chartDays,
    allDaysCount: days.size,
    hourly: todayHours,
    limit: {
      status,
      lastEvent: describeEvent(lastEvent, lastEventReset),
      // The refusal that currently blocks the window, which can be older than
      // the last refusal when a newer one has already reset.
      activeEvent: describeEvent(activeEvent, activeEventReset),
      resetAt: lastEventReset ? new Date(lastEventReset).toISOString() : null,
      successAfterLastEvent,
      successAfterActiveEvent,
      recentEvents: recentLimitEvents,
      hitPoints: hitPoints.slice(-20),
      estimates,
      todayHit: todayHit
        ? {
            at: todayHit.at,
            requestsAt: todayHit.requestsAt,
            tokensAt: todayHit.tokensAt,
            listValueAt: todayHit.valueAt,
            resetAt: todayHit.resetAt ? new Date(todayHit.resetAt).toISOString() : null,
            source: todayHit.source,
          }
        : null,
    },
    sessions: topSessions,
    models,
    config: {
      freeModels: config.freeModels,
      prices: config.prices,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

let cache = { at: 0, data: null };
let building = null;

function getData({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < 2500) return cache.data;
  if (building) return building;

  const promise = new Promise((resolve) => {
    try {
      const data = buildData();
      cache = { at: Date.now(), data };
      resolve(data);
    } catch (error) {
      console.error("[tracker] build failed:", error);
      if (cache.data) {
        const fallback = structuredClone(cache.data);
        fallback.meta = {
          ...fallback.meta,
          dataWarning: `Refresh failed: ${error.message}. Showing the last successful read.`,
        };
        resolve(fallback);
      } else {
        resolve({
          error: { code: "build_failed", message: error.message },
          meta: { generatedAt: new Date().toISOString(), dbPath: DB_PATH, logPath: LOG_PATH },
        });
      }
    }
  });

  // Assign before attaching `finally`: the executor above runs synchronously,
  // and clearing `building` inside it would be overwritten by this assignment,
  // freezing every later request on the first result.
  building = promise;
  promise.finally(() => {
    if (building === promise) building = null;
  });
  return promise;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function sendCsv(res, data) {
  const header = [
    "utc_day",
    "free_requests",
    "prompts",
    "sessions",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "est_list_value_usd",
    "limit_events",
    "first_limit_at",
    "requests_at_first_limit",
    "tokens_at_first_limit",
    "list_value_at_first_limit",
  ];
  const rows = data.days.map((d) => [
    d.day,
    d.requests,
    d.prompts,
    d.sessions,
    d.tokens.input,
    d.tokens.output,
    d.tokens.reasoning,
    d.tokens.cacheRead,
    d.tokens.cacheWrite,
    d.tokens.total,
    d.listValue,
    d.limitEvents,
    d.hit?.at || "",
    d.hit?.requests ?? "",
    d.hit?.tokens ?? "",
    d.hit?.listValue ?? "",
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="opencode-free-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Cache-Control": "no-store",
  });
  res.end(csv);
}

/** Go plan daily activity from Console (requests, tokens, list cost). */
function sendGoCsv(res, data) {
  const activity = data.go && data.go.activity ? data.go.activity : null;
  const rows = activity && activity.daily.length
    ? activity.daily.map((day) => [day.date, day.requests, day.tokens, day.costUsd])
    : (data.go && data.go.local && data.go.local.days ? data.go.local.days : [])
        .filter((day) => day.requests > 0)
        .map((day) => [day.day, day.requests, day.tokens ? day.tokens.total : 0, ""]);
  const csv = [
    ["utc_day", "go_requests", "go_tokens", "go_cost_usd"],
    ...rows,
  ]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="opencode-go-usage-${new Date()
      .toISOString()
      .slice(0, 10)}.csv"`,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(csv),
  });
  res.end(csv);
}

/** Every provider/plan, one row per UTC day (last 30 days). */
function sendAllCsv(res, data) {
  const all = data.all || {};
  const header = [
    "utc_day",
    "provider",
    "plan",
    "requests",
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "cost_usd",
  ];
  const rows = [];
  for (const day of all.days || []) {
    for (const provider of day.providers || []) {
      rows.push([
        day.day,
        provider.provider,
        provider.plan,
        provider.requests,
        provider.tokens.input,
        provider.tokens.output,
        provider.tokens.reasoning,
        provider.tokens.cacheRead,
        provider.tokens.cacheWrite,
        provider.tokens.total,
        provider.costUsd,
      ]);
    }
  }
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="opencode-all-providers-${new Date()
      .toISOString()
      .slice(0, 10)}.csv"`,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(csv),
  });
  res.end(csv);
}

function serveStatic(req, res, urlPath) {
  let relative =
    urlPath === "/" ? "index.html" : urlPath === "/compact" ? "compact.html" : urlPath.replace(/^\/+/, "");
  let filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // App code must update immediately after a pull; only assets like icons
      // are worth caching.
      "Cache-Control": [".html", ".js", ".css"].includes(ext)
        ? "no-cache"
        : "public, max-age=300",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      dbPath: DB_PATH,
      logPath: LOG_PATH,
      node: process.version,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const force = url.searchParams.get("refresh") === "1";
    if (CONSOLE.cookie) runConsoleSync().catch(() => {});
    const data = await getData({ force });
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/refresh") {
    const data = await getData({ force: true });
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/console/status") {
    sendJson(res, 200, consoleSummary());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/console/sync") {
    const result = await runConsoleSync({ force: true });
    sendJson(res, result.configured ? 200 : 400, {
      ...result,
      summary: consoleSummary(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export.csv") {
    const data = await getData();
    if (data.error) {
      sendJson(res, 500, data);
      return;
    }
    sendCsv(res, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export-go.csv") {
    const data = await getData();
    if (data.error) {
      sendJson(res, 500, data);
      return;
    }
    sendGoCsv(res, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export-all.csv") {
    const data = await getData();
    if (data.error) {
      sendJson(res, 500, data);
      return;
    }
    sendAllCsv(res, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/export.json") {
    const data = await getData();
    if (data.error) {
      sendJson(res, 500, data);
      return;
    }
    const body = JSON.stringify(data, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="opencode-free-usage-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    const send = async (force = false) => {
      if (closed) return;
      const data = await getData({ force });
      res.write(`event: usage\ndata: ${JSON.stringify(data)}\n\n`);
    };
    await send(false);
    const timer = setInterval(() => send(false), Math.max(2000, config.refreshMs));
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, decodeURIComponent(url.pathname));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error("[tracker] request failed:", error);
    if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: error.message } });
  });
});

function openBrowser(target) {
  const command =
    process.platform === "win32"
      ? `start "" "${target}"`
      : process.platform === "darwin"
        ? `open "${target}"`
        : `xdg-open "${target}"`;
  exec(command, { windowsHide: true }, () => {});
}

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : PORT;
  const url = `http://${HOST}:${actualPort}`;
  const wantsOpen = process.argv.includes("--open");
  const wantsCompact = process.argv.includes("--open-compact");
  const consoleConfigured = Boolean(CONSOLE.cookie);
  console.log("");
  console.log("  OpenCode Usage Tracker");
  console.log("  ───────────────────────────");
  console.log(`  Dashboard : ${url}`);
  console.log(`  Widget    : ${url}/compact`);
  console.log(`  Database  : ${DB_PATH}`);
  console.log(`  Log       : ${LOG_PATH}`);
  console.log("  Window    : 24h bucket — counted from the last server-confirmed boundary");
  console.log("  Reset     : taken from each 429's retryAfterMs (server-confirmed);");
  console.log("              otherwise estimated from the window's first observed request");
  console.log(
    `  Console   : ${
      consoleConfigured
        ? CONSOLE.trackGo
          ? "free request-log + Go meters sync enabled"
          : "free request-log sync enabled (Go off)"
        : "sync not configured (optional; local Go detection still works)"
    }`,
  );
  console.log("");
  console.log("  Read-only. Nothing leaves this machine. Ctrl+C to stop.");
  console.log("");
  if (wantsOpen) openBrowser(wantsCompact ? `${url}/compact` : url);

  if (consoleConfigured) {
    runConsoleSync().catch((error) => console.error("[tracker] console sync failed:", error.message));
    const syncTimer = setInterval(() => {
      runConsoleSync().catch((error) => console.error("[tracker] console sync failed:", error.message));
    }, CONSOLE.intervalMs);
    syncTimer.unref();
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Open http://${HOST}:${PORT} or set PORT to another value.`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
