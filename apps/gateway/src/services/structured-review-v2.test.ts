import { describe, expect, it } from "vitest";
import { buildStructuredReviewRoster, validateStructuredFinding } from "./review-readiness-service.js";

describe("structured review v2", () => {
  it("builds a risk-shaped reviewer roster from the frozen inventory", () => {
    const roster = buildStructuredReviewRoster([
      "apps/gateway/src/auth/policy.ts",
      "packages/storage/src/postgres/migrations.ts",
      "apps/mission-control-next/src/Route.tsx",
      "apps/gateway/src/services/chat-delegation-service.ts",
      ".github/workflows/release.yml",
    ]);
    expect(roster).toEqual(
      expect.arrayContaining([
        "general_correctness",
        "test_coverage",
        "security",
        "storage",
        "ui_accessibility",
        "agentic_runtime",
        "ops_release",
      ]),
    );
  });

  it("requires concrete evidence for high-confidence and high-severity findings", () => {
    expect(
      validateStructuredFinding({
        source: "reviewer",
        component: "gateway",
        title: "Unsupported claim",
        files: ["apps/gateway/src/app.ts"],
        severity: "p2",
        confidence: 75,
      }),
    ).toBe(false);
    expect(
      validateStructuredFinding({
        source: "reviewer",
        component: "gateway",
        title: "Approval bypass",
        files: ["apps/gateway/src/app.ts"],
        severity: "p1",
        confidence: 100,
        whyItMatters: "A mutation could occur without operator approval.",
        requiresVerification: true,
        evidence: [{ path: "apps/gateway/src/app.ts", startLine: 10, quote: "mutate();" }],
      }),
    ).toBe(true);
  });
});
