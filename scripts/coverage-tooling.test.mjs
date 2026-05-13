import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

describe("coverage tooling", () => {
  it("includes current Mission Control surfaces in production risk tiers", () => {
    const source = fs.readFileSync(path.join(scriptsDir, "coverage-collect.mjs"), "utf8");
    for (const prefix of [
      "apps/mission-control-next/src/",
      "packages/mission-control-shared/src/",
      "packages/threaded-surface-core/src/",
    ]) {
      assert.match(source, new RegExp(JSON.stringify(prefix).slice(1, -1)));
    }
  });

  it("fails uncovered-line reporting on malformed coverage policy", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-policy-"));
    try {
      fs.writeFileSync(path.join(tempDir, "coverage-policy.json"), "{not-json", "utf8");
      const result = spawnSync(process.execPath, [path.join(scriptsDir, "coverage-uncovered-lines.mjs"), "--json"], {
        cwd: tempDir,
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, /Invalid JSON in coverage-policy\.json/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
