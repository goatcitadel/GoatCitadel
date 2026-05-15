import { describe, expect, it } from "vitest";
import { buildApprovalEvidenceModel, findTraceMetadata } from "./approvals-page-helpers";

describe("approvals-page-helpers loop 17 branches", () => {
  it("walks arrays, skips primitive trace nodes, and returns null when no trace exists", () => {
    expect(findTraceMetadata({ nested: [false, null, { payload: 123 }] })).toBeNull();
    expect(findTraceMetadata({ nested: [false, { payload: { correlationId: "corr-17" } }] })).toEqual({
      correlationId: "corr-17",
      traceId: undefined,
    });
  });

  it("collects array evidence, object evidence, truncates support text, and drops duplicate code blocks", () => {
    const longSummary = `${"operator-note ".repeat(30)}done`;
    const evidence = buildApprovalEvidenceModel({
      roots: ["F:/code/personal-ai", "F:/code/other"],
      shellScripts: ["pnpm lint", "pnpm test", "pnpm typecheck", "pnpm coverage"],
      patches: ["-old\n+new", "-old\n+new", "single-line"],
      nested: {
        summaryText: longSummary,
        artifact: { targetFile: "apps/mission-control/src/pages/ApprovalsPage.tsx" },
      },
    });

    expect(evidence?.targets).toEqual([
      "Roots: F:/code/personal-ai, F:/code/other",
      "Target File: apps/mission-control/src/pages/ApprovalsPage.tsx",
    ]);
    expect(evidence?.commands).toEqual(["Shell Scripts: pnpm lint | pnpm test | pnpm typecheck..."]);
    expect(evidence?.changes).toEqual([{ label: "Patches", content: "-old\n+new" }]);
    expect(evidence?.supporting[0]).toContain("Summary Text: operator-note");
    expect(evidence?.supporting[0]).toContain("...");
  });
});
