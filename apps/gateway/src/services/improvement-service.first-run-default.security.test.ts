import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression coverage for CODEX_FINDING #27: `ensureWeeklyImprovementCronJob`
// previously created the persistent cron-job record with `enabled:
// existing?.enabled ?? true` — so a fresh install with no prior cron-jobs
// record got the audit enabled by default, overriding the example file's
// `enabled: false`. The fix flips the code-side default to `false`.
//
// This test pins the literal in source so a future refactor cannot
// silently revert the default. Constructing the full ImprovementService
// would require stubbing dozens of context fields; the source-level pin
// is the cheapest reliable guard.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const improvementServicePath = path.resolve(__dirname, "improvement-service.ts");

describe("ensureWeeklyImprovementCronJob first-run default (codex #27)", () => {
  const source = readFileSync(improvementServicePath, "utf8");

  it("defaults `enabled` to false when no prior record exists", () => {
    expect(source).toMatch(/enabled:\s*existing\?\.enabled\s*\?\?\s*false/);
  });

  it("does NOT default `enabled` to true on first run", () => {
    // A regression to `?? true` would re-introduce the codex #27 default-on egress.
    expect(source).not.toMatch(/enabled:\s*existing\?\.enabled\s*\?\?\s*true/);
  });
});
