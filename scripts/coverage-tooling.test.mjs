import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildCoverageSourceFingerprint } from "./coverage-source-fingerprint.mjs";

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

  it("enforces strict100 across file, line, branch, and function coverage", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-gate-"));
    try {
      fs.mkdirSync(path.join(tempDir, "artifacts", "coverage"), { recursive: true });
      const perfectBucket = {
        id: "apps/demo",
        label: "apps/demo",
        sourceFiles: 2,
        executableSourceFiles: 1,
        nonExecutableSourceFiles: 1,
        coveredFiles: 1,
        uncoveredFiles: 0,
        fileCoveragePercent: 100,
        linePercent: 100,
        branchPercent: 100,
        functionPercent: 100,
        lineTotals: { covered: 3, uncovered: 0, total: 3 },
        branchTotals: { covered: 2, uncovered: 0, total: 2 },
        functionTotals: { covered: 1, uncovered: 0, total: 1 },
      };
      fs.writeFileSync(
        path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
        JSON.stringify({
          status: "success",
          sourceFingerprint: await buildCoverageSourceFingerprint(tempDir),
          sourceFiles: 2,
          executableSourceFiles: 1,
          nonExecutableSourceFiles: 1,
          coveredFiles: 1,
          uncoveredFiles: 0,
          fileCoveragePercent: 100,
          linePercent: 100,
          branchPercent: 100,
          functionPercent: 100,
          lineTotals: { covered: 3, total: 3 },
          branchTotals: { covered: 2, total: 2 },
          functionTotals: { covered: 1, total: 1 },
          packageCoverage: [perfectBucket],
          riskTierCoverage: [{ ...perfectBucket, id: "demo-risk" }],
        }),
        "utf8",
      );

      const result = spawnSync(process.execPath, [path.join(scriptsDir, "coverage-gate.mjs"), "--profile=strict100"], {
        cwd: tempDir,
        encoding: "utf8",
      });

      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /profile strict100/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a successful coverage summary from different source content", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-stale-"));
    try {
      fs.mkdirSync(path.join(tempDir, "apps", "demo", "src"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "artifacts", "coverage"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "apps", "demo", "src", "index.ts"), "export const current = true;\n");
      fs.writeFileSync(
        path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
        JSON.stringify({
          status: "success",
          sourceFingerprint: "sha256:stale",
          linePercent: 100,
          branchPercent: 100,
          functionPercent: 100,
        }),
      );

      const result = spawnSync(process.execPath, [path.join(scriptsDir, "coverage-gate.mjs")], {
        cwd: tempDir,
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}\n${result.stdout}`, /does not match current source content/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("excludes generated coverage directories from source provenance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-fingerprint-"));
    try {
      fs.mkdirSync(path.join(tempDir, "apps", "demo", "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "apps", "demo", "src", "index.ts"), "export const stable = true;\n");
      const before = await buildCoverageSourceFingerprint(tempDir);
      fs.mkdirSync(path.join(tempDir, "apps", "demo", "coverage-smoke", "tmp"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "apps", "demo", "coverage-smoke", "tmp", "coverage.json"),
        JSON.stringify({ generated: Math.random() }),
      );
      const after = await buildCoverageSourceFingerprint(tempDir);

      assert.equal(after, before);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes shared test discovery configuration in source provenance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-config-fingerprint-"));
    try {
      fs.writeFileSync(path.join(tempDir, "vitest.shared.ts"), "export const restoredTestExclude = [];\n");
      const before = await buildCoverageSourceFingerprint(tempDir);
      fs.writeFileSync(path.join(tempDir, "vitest.shared.ts"), "export const restoredTestExclude = ['**/*.test.ts'];\n");
      const after = await buildCoverageSourceFingerprint(tempDir);

      assert.notEqual(after, before);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ratchets fresh gateway and shared coverage with a stability margin", () => {
    const source = fs.readFileSync(path.join(scriptsDir, "coverage-collect.mjs"), "utf8");
    const tier = source.match(/id: "gateway-shared-contracts",[\s\S]*?sourcePrefixes:/)?.[0] ?? "";
    assert.match(tier, /lineThreshold:\s*58/);
    assert.match(tier, /currentLinePercent:\s*60\.6/);
    assert.match(tier, /enforcedLineThreshold:\s*58/);
    assert.match(tier, /nextLineThreshold:\s*60/);
  });

  it("reports uncovered branch and function locations", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-uncovered-"));
    try {
      const packageDir = path.join(tempDir, "apps", "demo");
      const sourceFile = path.join(packageDir, "src", "index.ts");
      const coverageDir = path.join(packageDir, "coverage");
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.mkdirSync(coverageDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, "coverage-policy.json"), JSON.stringify({ version: 1, exclusions: [] }), "utf8");
      fs.writeFileSync(sourceFile, "export function covered() {}\nif (true) {}\nelse {}\nfunction missed() {}\n", "utf8");
      fs.writeFileSync(
        path.join(coverageDir, "coverage-final.json"),
        JSON.stringify({
          [sourceFile]: {
            path: sourceFile,
            statementMap: {},
            s: {},
            l: { 1: 1 },
            branchMap: {
              0: {
                type: "if",
                loc: { start: { line: 2, column: 0 }, end: { line: 3, column: 7 } },
                locations: [
                  { start: { line: 2, column: 0 }, end: { line: 2, column: 12 } },
                  { start: { line: 3, column: 0 }, end: { line: 3, column: 7 } },
                ],
              },
            },
            b: { 0: [1, 0] },
            fnMap: {
              0: {
                name: "covered",
                loc: { start: { line: 1, column: 7 }, end: { line: 1, column: 28 } },
              },
              1: {
                name: "missed",
                loc: { start: { line: 4, column: 0 }, end: { line: 4, column: 20 } },
              },
            },
            f: { 0: 1, 1: 0 },
          },
        }),
        "utf8",
      );

      const result = spawnSync(process.execPath, [path.join(scriptsDir, "coverage-uncovered-lines.mjs"), "--json"], {
        cwd: tempDir,
        encoding: "utf8",
      });

      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      const rows = JSON.parse(result.stdout);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].uncoveredBranches, 1);
      assert.equal(rows[0].uncoveredFunctions, 1);
      assert.deepEqual(rows[0].branchMisses.map((miss) => miss.location), ["3:1-3:8"]);
      assert.deepEqual(rows[0].functionMisses.map((miss) => miss.name), ["missed"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
