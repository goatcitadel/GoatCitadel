import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { mergeCoverageEntries } from "./coverage-merge.mjs";
import { normalizeCoveragePathForLookup } from "./coverage-paths.mjs";
import { buildCoverageSourceFingerprint } from "./coverage-source-fingerprint.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const requiredProductionRiskTiers = [
  {
    id: "storage-policy-security-critical",
    lineThreshold: 90,
    branchThreshold: 80,
  },
  {
    id: "gateway-shared-contracts",
    lineThreshold: 58,
    branchThreshold: 70,
  },
  {
    id: "mission-control",
    lineThreshold: 75,
    branchThreshold: 60,
  },
];

describe("coverage tooling", () => {
  it("merges incompatible collector IDs by source location without collisions", () => {
    const left = {
      path: "/repo/src/example.ts",
      statementMap: {
        0: location(1),
        1: location(2),
      },
      s: { 0: 2, 1: 0 },
      l: { 1: 2, 2: 0 },
      fnMap: {
        0: functionLocation("alpha", 3),
      },
      f: { 0: 1 },
      branchMap: {
        0: branchLocation("if", 10, [location(11), location(12)]),
      },
      b: { 0: [1, -5] },
    };
    const right = {
      path: "/repo/src/example.ts",
      statementMap: {
        0: location(2),
        7: location(1),
        8: location(5),
      },
      s: { 0: 3, 7: 4, 8: 1 },
      l: { 1: 4, 2: 3, 5: 1 },
      fnMap: {
        0: functionLocation("beta", 6),
        9: functionLocation("alpha-renamed", 3),
      },
      f: { 0: 5, 9: 2 },
      branchMap: {
        0: branchLocation("branch", 20, [location(20)]),
        9: branchLocation("if", 10, [location(12), location(11), location(13)]),
      },
      b: { 0: [7], 9: [2, 3, 4] },
    };

    const merged = mergeCoverageEntries(left, right);
    const statementHitsByLine = Object.fromEntries(
      Object.entries(merged.statementMap).map(([id, item]) => [item.start.line, merged.s[id]]),
    );
    assert.deepEqual(statementHitsByLine, { 1: 6, 2: 3, 5: 1 });
    assert.deepEqual(merged.l, { 1: 6, 2: 3, 5: 1 });

    const functionHitsByLine = Object.groupBy(
      Object.entries(merged.fnMap).map(([id, item]) => ({ line: item.loc.start.line, hits: merged.f[id] })),
      (item) => item.line,
    );
    assert.deepEqual(
      functionHitsByLine[3].map((item) => item.hits).sort((a, b) => a - b),
      [1, 2],
    );
    assert.deepEqual(
      functionHitsByLine[6].map((item) => item.hits),
      [5],
    );

    const branchEntries = Object.entries(merged.branchMap);
    assert.equal(branchEntries.length, 3);
    const ifHitsByLine = branchEntries
      .filter(([, item]) => item.type === "if")
      .map(([ifId, ifBranch]) =>
        Object.fromEntries(ifBranch.locations.map((item, index) => [item.start.line, merged.b[ifId][index]])),
      );
    assert.deepEqual(ifHitsByLine, [
      { 11: 1, 12: 0 },
      { 11: 3, 12: 2, 13: 4 },
    ]);
    const [branchId] = branchEntries.find(([, item]) => item.type === "branch");
    assert.deepEqual(merged.b[branchId], [7]);
  });

  it("preserves repeated same-location counters without losing occurrences", () => {
    const left = {
      path: "/repo/src/repeated.ts",
      statementMap: { 0: location(30), 1: location(30) },
      s: { 0: 1, 1: 2 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    const right = {
      path: "/repo/src/repeated.ts",
      statementMap: { 8: location(30), 4: location(30) },
      s: { 8: 3, 4: 4 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };

    const merged = mergeCoverageEntries(left, right);

    assert.equal(Object.keys(merged.statementMap).length, 4);
    assert.equal(
      Object.values(merged.s).reduce((total, count) => total + count, 0),
      10,
    );
  });

  it("preserves locationless implicit branch arms conservatively across collectors", () => {
    const implicitArm = { start: {}, end: {} };
    const left = {
      path: "/repo/src/implicit-branch.ts",
      statementMap: {},
      s: {},
      l: {},
      fnMap: {},
      f: {},
      branchMap: {
        0: branchLocation("if", 7, [location(7), implicitArm]),
      },
      b: { 0: [1, 0] },
    };
    const right = {
      path: "/repo/src/implicit-branch.ts",
      statementMap: {},
      s: {},
      l: {},
      fnMap: {},
      f: {},
      branchMap: {
        9: branchLocation("if", 7, [location(7), implicitArm]),
      },
      b: { 9: [0, 1] },
    };

    const merged = mergeCoverageEntries(left, right);

    assert.equal(Object.keys(merged.branchMap).length, 2);
    assert.deepEqual(Object.values(merged.b), [
      [1, 0],
      [0, 1],
    ]);
    assert.deepEqual(
      Object.values(merged.branchMap).map((branch) => branch.locations[1]),
      [implicitArm, implicitArm],
    );
  });

  it("rejects malformed non-null coordinates in implicit branch arms", () => {
    const malformed = {
      path: "/repo/src/malformed-implicit-branch.ts",
      statementMap: {},
      s: {},
      l: {},
      fnMap: {},
      f: {},
      branchMap: {
        0: branchLocation("if", 7, [location(7), { start: { line: 0 }, end: { line: 7 } }]),
      },
      b: { 0: [1, 0] },
    };

    assert.throws(() => mergeCoverageEntries(malformed, malformed), /invalid source line 0/i);
  });

  it("rejects missing endpoints and partially located branch arms", () => {
    for (const [label, arm] of [
      ["missing endpoints", {}],
      ["missing start endpoint", { end: {} }],
      ["mixed partial lines", { start: { line: 7, column: 0 }, end: {} }],
      ["column without line", { start: { column: 0 }, end: {} }],
    ]) {
      const malformed = {
        path: `/repo/src/${label.replaceAll(" ", "-")}.ts`,
        statementMap: {},
        s: {},
        l: {},
        fnMap: {},
        f: {},
        branchMap: {
          0: branchLocation("if", 7, [location(7), arm]),
        },
        b: { 0: [1, 0] },
      };

      assert.throws(
        () => mergeCoverageEntries(malformed, malformed),
        /valid start and end locations|partially located branch arm/i,
        label,
      );
    }
  });

  it("keeps permuted duplicate counters conservative and prevents a false production-gate pass", async () => {
    const sharedLocation = location(50);
    const sharedFunction = functionLocation("shared", 50);
    const sharedBranch = branchLocation("if", 50, [location(51), location(52)]);
    const left = {
      path: "/repo/src/permuted.ts",
      statementMap: { 0: sharedLocation, 1: sharedLocation },
      s: { 0: 1, 1: 0 },
      l: { 50: 1 },
      fnMap: { 0: sharedFunction, 1: sharedFunction },
      f: { 0: 1, 1: 0 },
      branchMap: { 0: sharedBranch, 1: sharedBranch },
      b: { 0: [1, 0], 1: [0, 1] },
    };
    // The collector-local IDs are reversed, but the semantic A/B coverage is
    // unchanged: A remains first-arm-only and B remains second-arm-only.
    const right = {
      path: "/repo/src/permuted.ts",
      statementMap: { 0: sharedLocation, 1: sharedLocation },
      s: { 0: 0, 1: 1 },
      l: { 50: 1 },
      fnMap: { 0: sharedFunction, 1: sharedFunction },
      f: { 0: 0, 1: 1 },
      branchMap: { 0: sharedBranch, 1: sharedBranch },
      b: { 0: [0, 1], 1: [1, 0] },
    };

    const merged = mergeCoverageEntries(left, right);
    assert.equal(Object.keys(merged.statementMap).length, 4);
    assert.equal(Object.values(merged.s).filter((count) => count > 0).length, 2);
    assert.equal(Object.keys(merged.fnMap).length, 4);
    assert.equal(Object.values(merged.f).filter((count) => count > 0).length, 2);
    const branchHits = Object.values(merged.b).flat();
    assert.equal(Object.keys(merged.branchMap).length, 4);
    assert.equal(branchHits.filter((count) => count > 0).length, 4);
    assert.equal(branchHits.length, 8);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-permutation-gate-"));
    try {
      fs.mkdirSync(path.join(tempDir, "artifacts", "coverage"), { recursive: true });
      const branchPercent = (branchHits.filter((count) => count > 0).length / branchHits.length) * 100;
      fs.writeFileSync(
        path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
        JSON.stringify({
          status: "success",
          sourceFingerprint: await buildCoverageSourceFingerprint(tempDir),
          collector: { platform: "linux", arch: "x64", nodeVersion: "v22.0.0" },
          linePercent: 100,
          branchPercent,
          functionPercent: 50,
          lineTotals: { covered: 1, total: 1 },
          branchTotals: {
            covered: branchHits.filter((count) => count > 0).length,
            total: branchHits.length,
          },
          functionTotals: { covered: 2, total: 4 },
          riskTierCoverage: requiredProductionRiskTiers.map((tier, index) => ({
            ...tier,
            linePercent: 100,
            branchPercent: index === 0 ? branchPercent : 100,
            lineTotals: { covered: 1, total: 1 },
            branchTotals:
              index === 0
                ? {
                    covered: branchHits.filter((count) => count > 0).length,
                    total: branchHits.length,
                  }
                : { covered: 1, total: 1 },
          })),
        }),
        "utf8",
      );

      const result = spawnSync(process.execPath, [path.join(scriptsDir, "coverage-gate.mjs"), "--profile=production"], {
        cwd: tempDir,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(`${result.stderr}\n${result.stdout}`, /storage-policy-security-critical failed/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not conflate unknown and zero source columns", () => {
    const unknownEndColumn = location(40);
    unknownEndColumn.end.column = null;
    const zeroEndColumn = location(40, 0, 0);

    const merged = mergeCoverageEntries(
      {
        path: "/repo/src/columns.ts",
        statementMap: { 0: unknownEndColumn },
        s: { 0: 1 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
      {
        path: "/repo/src/columns.ts",
        statementMap: { 0: zeroEndColumn },
        s: { 0: 1 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    );

    assert.equal(Object.keys(merged.statementMap).length, 2);
  });

  it("keeps cross-collector locations with unknown columns conservative", () => {
    const unknownColumns = location(40);
    unknownColumns.start.column = null;
    unknownColumns.end.column = null;

    const merged = mergeCoverageEntries(
      {
        path: "/repo/src/unknown-columns.ts",
        statementMap: { 0: unknownColumns },
        s: { 0: 1 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
      {
        path: "/repo/src/unknown-columns.ts",
        statementMap: { 0: unknownColumns },
        s: { 0: 0 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    );

    assert.equal(Object.keys(merged.statementMap).length, 2);
    assert.deepEqual(
      Object.values(merged.s).sort((left, right) => left - right),
      [0, 1],
    );
  });

  it("rejects malformed source coordinates instead of merging them as unknown locations", () => {
    const malformedLeft = location(41);
    malformedLeft.end.column = "collector-a-invalid";
    const malformedRight = location(41);
    malformedRight.end.column = "collector-b-invalid";

    assert.throws(
      () =>
        mergeCoverageEntries(
          {
            path: "/repo/src/malformed.ts",
            statementMap: { 0: malformedLeft },
            s: { 0: 0 },
            fnMap: {},
            f: {},
            branchMap: {},
            b: {},
          },
          {
            path: "/repo/src/malformed.ts",
            statementMap: { 0: malformedRight },
            s: { 0: 1 },
            fnMap: {},
            f: {},
            branchMap: {},
            b: {},
          },
        ),
      /invalid source column/i,
    );
  });

  it("preserves Linux path case while normalizing Windows coverage keys", () => {
    const upper = "/repo/src/Widget.ts";
    const lower = "/repo/src/widget.ts";

    assert.notEqual(
      normalizeCoveragePathForLookup(upper, { platform: "linux" }),
      normalizeCoveragePathForLookup(lower, { platform: "linux" }),
    );
    assert.equal(
      normalizeCoveragePathForLookup(upper, { platform: "win32" }),
      normalizeCoveragePathForLookup(lower, { platform: "win32" }),
    );
  });

  it("normalizes file URLs with the requested platform path semantics", () => {
    assert.equal(
      normalizeCoveragePathForLookup("file:///C:/Repo/src/Widget%20File.ts", {
        platform: "win32",
        cwd: "C:/Repo",
      }),
      "c:/repo/src/widget file.ts",
    );
    assert.equal(
      normalizeCoveragePathForLookup("file:///repo/src/Widget%20File.ts", {
        platform: "linux",
        cwd: "/repo",
      }),
      "/repo/src/Widget File.ts",
    );
  });

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

  it("rejects non-Linux artifacts as production coverage evidence", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-platform-"));
    try {
      fs.mkdirSync(path.join(tempDir, "artifacts", "coverage"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
        JSON.stringify({
          status: "success",
          sourceFingerprint: await buildCoverageSourceFingerprint(tempDir),
          collector: { platform: "win32", arch: "x64", nodeVersion: "v22.0.0" },
          linePercent: 100,
          branchPercent: 100,
          functionPercent: 100,
          riskTierCoverage: requiredProductionRiskTiers.map((tier) => ({
            ...tier,
            linePercent: 100,
            branchPercent: 100,
          })),
        }),
        "utf8",
      );

      const result = spawnSync(process.execPath, [path.join(scriptsDir, "coverage-gate.mjs"), "--profile=production"], {
        cwd: tempDir,
        encoding: "utf8",
      });

      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stderr}\n${result.stdout}`,
        /requires an actual Linux runtime|does not match the gating runtime/i,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects incomplete, unknown, duplicate, or weakened production risk tiers", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-production-tiers-"));
    try {
      fs.mkdirSync(path.join(tempDir, "artifacts", "coverage"), { recursive: true });
      const fingerprint = await buildCoverageSourceFingerprint(tempDir);
      const validTiers = requiredProductionRiskTiers.map((tier) => ({
        ...tier,
        linePercent: 100,
        branchPercent: 100,
        lineTotals: { covered: 1, total: 1 },
        branchTotals: { covered: 1, total: 1 },
      }));
      fs.writeFileSync(
        path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
        JSON.stringify({
          status: "success",
          sourceFingerprint: fingerprint,
          collector: { platform: "linux", arch: "x64", nodeVersion: "v22.0.0" },
          linePercent: 100,
          branchPercent: 100,
          functionPercent: 100,
          lineTotals: { covered: 1, total: 1 },
          branchTotals: { covered: 1, total: 1 },
          functionTotals: { covered: 1, total: 1 },
          riskTierCoverage: validTiers,
        }),
        "utf8",
      );
      const validResult = spawnSync(
        process.execPath,
        [path.join(scriptsDir, "coverage-gate.mjs"), "--profile=production"],
        { cwd: tempDir, encoding: "utf8" },
      );
      if (process.platform === "linux") {
        assert.equal(validResult.status, 0, `${validResult.stderr}\n${validResult.stdout}`);
      } else {
        assert.notEqual(validResult.status, 0);
        assert.match(`${validResult.stderr}\n${validResult.stdout}`, /requires an actual Linux runtime/i);
      }

      const cases = [
        {
          label: "missing",
          tiers: validTiers.slice(1),
          expected: /missing required production risk tier/i,
        },
        {
          label: "unknown",
          tiers: [
            ...validTiers,
            { id: "invented-tier", linePercent: 100, branchPercent: 100, lineThreshold: 0, branchThreshold: 0 },
          ],
          expected: /unknown production risk tier/i,
        },
        {
          label: "duplicate",
          tiers: [...validTiers, validTiers[0]],
          expected: /duplicate production risk tier/i,
        },
        {
          label: "weakened",
          tiers: validTiers.map((tier, index) =>
            index === 0 ? { ...tier, lineThreshold: 1, branchThreshold: 1 } : tier,
          ),
          expected: /threshold mismatch for production risk tier/i,
        },
      ];

      for (const testCase of cases) {
        fs.writeFileSync(
          path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
          JSON.stringify({
            status: "success",
            sourceFingerprint: fingerprint,
            collector: { platform: "linux", arch: "x64", nodeVersion: "v22.0.0" },
            linePercent: 100,
            branchPercent: 100,
            functionPercent: 100,
            lineTotals: { covered: 1, total: 1 },
            branchTotals: { covered: 1, total: 1 },
            functionTotals: { covered: 1, total: 1 },
            riskTierCoverage: testCase.tiers,
          }),
          "utf8",
        );

        const result = spawnSync(
          process.execPath,
          [path.join(scriptsDir, "coverage-gate.mjs"), "--profile=production"],
          { cwd: tempDir, encoding: "utf8" },
        );

        assert.notEqual(result.status, 0, `${testCase.label}: ${result.stderr}\n${result.stdout}`);
        assert.match(`${result.stderr}\n${result.stdout}`, testCase.expected, testCase.label);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects impossible, contradictory, or non-integer production coverage totals", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-forged-totals-"));
    try {
      fs.mkdirSync(path.join(tempDir, "artifacts", "coverage"), { recursive: true });
      const fingerprint = await buildCoverageSourceFingerprint(tempDir);
      const validTiers = requiredProductionRiskTiers.map((tier) => ({
        ...tier,
        linePercent: 100,
        branchPercent: 100,
        lineTotals: { covered: 1, total: 1 },
        branchTotals: { covered: 1, total: 1 },
      }));
      const cases = [
        {
          label: "out-of-range",
          override: { linePercent: 999 },
          expected: /expected values from 0 to 100/i,
        },
        {
          label: "contradictory",
          override: { linePercent: 100, lineTotals: { covered: 0, total: 100 } },
          expected: /does not match totals/i,
        },
        {
          label: "non-integer",
          override: { linePercent: 50, lineTotals: { covered: 0.5, total: 1 } },
          expected: /non-negative integers/i,
        },
        {
          label: "file-totals",
          override: {
            fileCoveragePercent: 100,
            executableSourceFiles: 2,
            coveredFiles: 2,
            uncoveredFiles: 1,
          },
          expected: /covered\/uncovered file totals are inconsistent/i,
        },
      ];

      for (const testCase of cases) {
        fs.writeFileSync(
          path.join(tempDir, "artifacts", "coverage", "coverage-summary.json"),
          JSON.stringify({
            status: "success",
            sourceFingerprint: fingerprint,
            collector: { platform: "linux", arch: "x64", nodeVersion: "v22.0.0" },
            linePercent: 100,
            branchPercent: 100,
            functionPercent: 100,
            lineTotals: { covered: 1, total: 1 },
            branchTotals: { covered: 1, total: 1 },
            functionTotals: { covered: 1, total: 1 },
            riskTierCoverage: validTiers,
            ...testCase.override,
          }),
          "utf8",
        );

        const result = spawnSync(
          process.execPath,
          [path.join(scriptsDir, "coverage-gate.mjs"), "--profile=production"],
          { cwd: tempDir, encoding: "utf8" },
        );
        assert.notEqual(result.status, 0, testCase.label);
        assert.match(`${result.stderr}\n${result.stdout}`, testCase.expected, testCase.label);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
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

  it("includes nested coverage-prefixed source directories in provenance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-source-prefix-"));
    try {
      const sourceDir = path.join(tempDir, "apps", "demo", "src", "coverage-runtime");
      fs.mkdirSync(sourceDir, { recursive: true });
      const sourcePath = path.join(sourceDir, "index.ts");
      fs.writeFileSync(sourcePath, "export const version = 1;\n");
      const before = await buildCoverageSourceFingerprint(tempDir);
      fs.writeFileSync(sourcePath, "export const version = 2;\n");
      const after = await buildCoverageSourceFingerprint(tempDir);

      assert.notEqual(after, before);

      const buildSourceDir = path.join(tempDir, "apps", "demo", "src", "build");
      fs.mkdirSync(buildSourceDir, { recursive: true });
      fs.writeFileSync(path.join(buildSourceDir, "runtime.ts"), "export const runtime = true;\n");
      const afterBuildSource = await buildCoverageSourceFingerprint(tempDir);
      assert.notEqual(afterBuildSource, after);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes shared test discovery configuration in source provenance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-config-fingerprint-"));
    try {
      fs.writeFileSync(path.join(tempDir, "vitest.shared.ts"), "export const restoredTestExclude = [];\n");
      const before = await buildCoverageSourceFingerprint(tempDir);
      fs.writeFileSync(
        path.join(tempDir, "vitest.shared.ts"),
        "export const restoredTestExclude = ['**/*.test.ts'];\n",
      );
      const after = await buildCoverageSourceFingerprint(tempDir);

      assert.notEqual(after, before);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes the Linux coverage workflow in source provenance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-coverage-workflow-fingerprint-"));
    try {
      const workflowDir = path.join(tempDir, ".github", "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      const workflowPath = path.join(workflowDir, "verification-fast.yml");
      fs.writeFileSync(workflowPath, "- run: pnpm coverage:collect && pnpm coverage:gate:production\n");
      const before = await buildCoverageSourceFingerprint(tempDir);
      fs.writeFileSync(workflowPath, "- run: pnpm coverage:gate:production\n");
      const after = await buildCoverageSourceFingerprint(tempDir);

      assert.notEqual(after, before);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("retains only redaction-checked coverage summary evidence in the Linux workflow", () => {
    const workflow = fs.readFileSync(
      path.join(scriptsDir, "..", ".github", "workflows", "verification-fast.yml"),
      "utf8",
    );

    assert.match(workflow, /pnpm coverage:collect && pnpm coverage:gate:production/);
    assert.match(workflow, /node scripts\/verify-artifact-redaction\.mjs artifacts\/coverage/);
    assert.match(workflow, /artifacts\/coverage\/coverage-summary\.json/);
    assert.match(workflow, /artifacts\/coverage\/coverage-summary\.md/);
    assert.match(workflow, /if-no-files-found:\s*error/);
    assert.doesNotMatch(workflow, /artifacts\/coverage\/coverage-final\.json/);
    assert.doesNotMatch(workflow, /(?:apps|packages)\/\*\*\/coverage/);
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
      fs.writeFileSync(
        path.join(tempDir, "coverage-policy.json"),
        JSON.stringify({ version: 1, exclusions: [] }),
        "utf8",
      );
      fs.writeFileSync(
        sourceFile,
        "export function covered() {}\nif (true) {}\nelse {}\nfunction missed() {}\n",
        "utf8",
      );
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
      assert.deepEqual(
        rows[0].branchMisses.map((miss) => miss.location),
        ["3:1-3:8"],
      );
      assert.deepEqual(
        rows[0].functionMisses.map((miss) => miss.name),
        ["missed"],
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function location(line, startColumn = 0, endColumn = 1) {
  return {
    start: { line, column: startColumn },
    end: { line, column: endColumn },
  };
}

function functionLocation(name, line) {
  return {
    name,
    decl: location(line),
    loc: location(line),
    line,
  };
}

function branchLocation(type, line, locations) {
  return {
    type,
    line,
    loc: location(line),
    locations,
  };
}
