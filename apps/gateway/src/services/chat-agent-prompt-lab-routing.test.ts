import { describe, expect, it } from "vitest";
import { resolvePromptLabCronReportEvidencePaths } from "./chat-agent-prompt-lab-routing.js";

describe("chat-agent-prompt-lab-routing", () => {
  it("resolves cron report evidence paths from observed files", () => {
    expect(
      resolvePromptLabCronReportEvidencePaths([
        "packages/storage/src/cron-job-repo.ts",
        "apps/gateway/src/services/cron-scheduler-service.ts",
        "apps/mission-control/src/api/prompt-packs.ts",
      ]),
    ).toEqual({
      cronPath: "packages/storage/src/cron-job-repo.ts",
      executionPath: "apps/gateway/src/services/cron-scheduler-service.ts",
      reportPath: "apps/mission-control/src/api/prompt-packs.ts",
    });
  });

  it("falls back to canonical cron report paths when evidence is missing", () => {
    expect(resolvePromptLabCronReportEvidencePaths([])).toEqual({
      cronPath: "apps/gateway/src/services/gateway/cron-automation-service.ts",
      executionPath: "apps/gateway/src/services/gateway/update-review.ts",
      reportPath: "apps/gateway/src/routes/prompt-packs.ts",
    });
  });
});
