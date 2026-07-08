import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackRunRecord } from "@goatcitadel/contracts";
import { buildPromptPackReportSummary, renderPromptPackMarkdownReport } from "./prompt-pack-service.js";
import { createPack, createRun, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

const DETERMINISM_ALARM_PREFIX = "- Determinism alarm:";
const DETERMINISM_ALARM_LINE =
  "- Determinism alarm: response text is byte-identical to 1 other run(s) of this test (suspected non-model content).";

function createLongRun(
  runId: string,
  packId: string,
  testId: string,
  finishedAt: string,
  responseText: string,
): PromptPackRunRecord {
  return {
    ...createRun(runId, "completed", finishedAt),
    packId,
    testId,
    responseText,
    trace: createTrace(`sess-${runId}`),
  };
}

function renderReport(
  pack: ReturnType<typeof createPack>,
  test: ReturnType<typeof createTest>,
  runs: PromptPackRunRecord[],
): string {
  return renderPromptPackMarkdownReport(
    {
      pack,
      tests: [test],
      runs,
      scores: [],
      autoScoresV2: [],
      humanReviewsV2: [],
      latestAssessments: [],
      summary: buildPromptPackReportSummary([test], runs, [], [], []),
    },
    { generatedAt: "2026-07-08T11:00:00.000Z" },
  );
}

describe("prompt-pack determinism tripwire", () => {
  const longText = (seed: string): string => `${seed} ${"determinism payload ".repeat(15)}`.trim();

  it("raises the determinism alarm when two runs of the same test return byte-identical long responses", () => {
    // Guards the tripwire that caught fabricated harness-authored responses: the
    // population and lookup sites build the occurrence key independently, and a
    // separator drift between them makes this alarm silently never fire.
    const pack = createPack("pack-determinism");
    const test = { ...createTest("test-determinism", "TEST-DETERMINISM-1"), packId: pack.packId };
    const identical = longText("Canned harness response.");
    expect(identical.length).toBeGreaterThan(200);

    const markdown = renderReport(pack, test, [
      createLongRun("run-determinism-1", pack.packId, test.testId, "2026-07-08T10:00:00.000Z", identical),
      createLongRun("run-determinism-2", pack.packId, test.testId, "2026-07-08T10:05:00.000Z", identical),
    ]);

    expect(markdown).toContain(DETERMINISM_ALARM_LINE);
  });

  it("stays quiet when the runs of a test return different long responses", () => {
    const pack = createPack("pack-determinism-quiet");
    const test = { ...createTest("test-determinism-quiet", "TEST-DETERMINISM-2"), packId: pack.packId };
    const first = longText("First sampled response.");
    const second = longText("Second sampled response.");
    expect(first.length).toBeGreaterThan(200);
    expect(second.length).toBeGreaterThan(200);
    expect(first).not.toBe(second);

    const markdown = renderReport(pack, test, [
      createLongRun("run-determinism-quiet-1", pack.packId, test.testId, "2026-07-08T10:00:00.000Z", first),
      createLongRun("run-determinism-quiet-2", pack.packId, test.testId, "2026-07-08T10:05:00.000Z", second),
    ]);

    expect(markdown).not.toContain(DETERMINISM_ALARM_PREFIX);
  });

  it("keeps gateway source free of raw NUL bytes so text tooling can search every file", () => {
    // A raw NUL (byte 0x00) once landed in the tripwire key separator of
    // prompt-pack-service.ts; ripgrep then treated the whole 10k-line file as
    // binary and silently stopped searching it. The separator must stay written
    // as an escape sequence, and no source file may carry raw NUL bytes.
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const name = entry.name;
        const isTypeScriptSource =
          name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts") || name.endsWith(".cts");
        if (!isTypeScriptSource) {
          continue;
        }
        if (fs.readFileSync(entryPath).includes(0)) {
          offenders.push(path.relative(srcRoot, entryPath).split(path.sep).join("/"));
        }
      }
    };
    visit(srcRoot);
    expect(offenders).toEqual([]);
  });
});
