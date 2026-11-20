import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createFixture } from "../test-support/fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startServer(fixture) {
  const env = { ...process.env };
  delete env.OPENCODE_CONSOLE_COOKIE;
  delete env.OPENCODE_CONSOLE_ORG_ID;
  Object.assign(env, {
    PORT: "0",
    HOST: "127.0.0.1",
    TRACKER_CONFIG: fixture.configPath,
    OPENCODE_DB: fixture.dbPath,
    OPENCODE_LOG: fixture.logPath,
    OPENCODE_CONSOLE_STATE: fixture.statePath,
  });

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not report a port within 20s:\n${output}`));
    }, 20_000);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Dashboard\s*:\s*http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}:\n${output}`));
    });
  });

  return { child, port, output: () => output };
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

async function get(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { res, text };
}

test("server exposes free, Go, and external-provider data", async (t) => {
  const fixture = createFixture();
  const server = await startServer(fixture);
  t.after(async () => {
    await stopServer(server.child);
    fixture.cleanup();
  });

  const health = await get(server.port, "/api/health");
  assert.equal(health.res.status, 200);
  assert.equal(JSON.parse(health.text).ok, true);

  const usage = JSON.parse((await get(server.port, "/api/usage")).text);
  assert.equal(usage.meta.plan, "go");
  assert.equal(usage.meta.goDetected, true);
  assert.equal(usage.meta.paidDetected, true);
  assert.equal(usage.meta.status, "limited");
  assert.equal(usage.meta.resetSource, "server");

  assert.equal(usage.all.providerCount, 3);
  assert.equal(usage.all.tracked.requests, 4);
  assert.deepEqual(
    [...usage.all.kinds].sort(),
    ["external", "free", "go"],
  );

  assert.equal(usage.totals.tracked.requests, 1, "free bucket stays free-only");
  assert.equal(usage.go.local.tracked.requests, 1, "Go rows stay out of free");

  const anthropic = usage.all.providers.find((p) => p.provider === "anthropic");
  assert.ok(anthropic, "external provider is detected");
  assert.equal(anthropic.plan, "API");
  assert.equal(anthropic.requests, 2);
  assert.equal(anthropic.costUsd, 0.5123);

  const goProvider = usage.all.providers.find((p) => p.kind === "go");
  assert.equal(goProvider.requests, 1);
  assert.equal(goProvider.costUsd, 0, "Go is subscription-included locally");

  assert.ok(usage.all.plans.includes("API"));
  assert.ok(usage.all.plans.includes("Free tier"));
  assert.ok(usage.all.plans.includes("Go"));

  const allCsv = await get(server.port, "/api/export-all.csv");
  assert.equal(allCsv.res.status, 200);
  assert.match(allCsv.text, /^utc_day,provider,plan,requests,/);
  assert.match(allCsv.text, /anthropic/);
  assert.match(allCsv.text, /API/);

  const goCsv = await get(server.port, "/api/export-go.csv");
  assert.equal(goCsv.res.status, 200);
  assert.match(goCsv.text, /^utc_day,go_requests,go_tokens,go_cost_usd/);

  const freeCsv = await get(server.port, "/api/export.csv");
  assert.equal(freeCsv.res.status, 200);
  assert.match(freeCsv.text, /^utc_day,free_requests,/);

  const dashboard = await get(server.port, "/");
  assert.equal(dashboard.res.status, 200);
  assert.match(dashboard.text, /id="allSection"/);
  assert.match(dashboard.text, /id="goSection"/);
  assert.doesNotMatch(dashboard.text, /undefined is not a function/);

  const widget = await get(server.port, "/compact");
  assert.equal(widget.res.status, 200);
  assert.match(widget.text, /renderGoWidget/);

  const combined = health.text + usage.toString() + allCsv.text + goCsv.text + freeCsv.text;
  assert.doesNotMatch(combined, /console_session|subscriberUserId|payment_method_/);
});
