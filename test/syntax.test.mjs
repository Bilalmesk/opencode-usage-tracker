import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("server.mjs passes node --check", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", path.join(root, "server.mjs")], {
      stdio: "pipe",
    });
  });
});

for (const page of ["public/index.html", "public/compact.html"]) {
  test(`${page} inline JavaScript parses`, () => {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, "page has an inline script");
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), "inline script compiles");
    }
  });
}
