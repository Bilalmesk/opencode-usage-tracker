import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Builds a tiny, deterministic OpenCode-shaped database for the smoke test.
 * One free success, one Go success, and two external (Anthropic) successes —
 * one current, one older — plus a free-tier 429. No real account data.
 */
export function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-tracker-test-"));
  const dbPath = path.join(dir, "opencode.db");
  const logPath = path.join(dir, "opencode.log");
  const statePath = path.join(dir, "console-sync.json");
  const configPath = path.join(dir, "tracker.config.json");
  const now = Date.now();

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  const insertSession = db.prepare("INSERT INTO session_v2 (id, title) VALUES (?, ?)");
  insertSession.run("ses_free", "Free session");
  insertSession.run("ses_go", "Go session");
  insertSession.run("ses_ext", "External session");

  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );

  const assistant = (id, sessionId, at, data) =>
    insertMessage.run(id, sessionId, "assistant", at, JSON.stringify(data));

  assistant("msg_free", "ses_free", now - 60_000, {
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
    cost: 0,
  });

  assistant("msg_go", "ses_go", now - 120_000, {
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  });

  assistant("msg_ext", "ses_ext", now - 180_000, {
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    tokens: { input: 30, output: 15, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.0123,
  });

  assistant("msg_ext_old", "ses_ext", now - 10 * 86_400_000, {
    model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0.5,
  });

  assistant("msg_limit", "ses_free", now - 30_000, {
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    cost: 0,
    error: {
      type: "provider.free-limit",
      status: 429,
      retryAfterMs: 3_600_000,
      message: "Free usage limit reached",
    },
  });

  insertMessage.run(
    "msg_prompt",
    "ses_free",
    "user",
    now - 90_000,
    JSON.stringify({ text: "hello" }),
  );

  db.close();
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        port: 0,
        host: "127.0.0.1",
        refreshMs: 5000,
        historyDays: 120,
        chartDays: 30,
        minHitPointsForEstimate: 3,
        console: {
          baseUrl: "https://opencode.ai",
          cookie: "",
          orgId: "",
          trackGo: true,
          syncIntervalMs: 300000,
          maxPages: 30,
        },
      },
      null,
      2,
    ),
  );

  return {
    dir,
    dbPath,
    logPath,
    statePath,
    configPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
