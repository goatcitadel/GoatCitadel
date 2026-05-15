import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import {
  buildApprovalEvidenceModel,
  findTraceMetadata,
  formatInferredIds,
  getCanonicalDurableRunId,
  hasRecoveryLinkage,
  isBlockedDurableStatus,
  isExpiredApproval,
  mergeApprovals,
} from "./approvals-page-helpers";

function approval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: "tool",
    riskLevel: "caution",
    status: "pending",
    payload: {},
    preview: {},
    createdAt: "2026-05-14T10:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  } as ApprovalRequest;
}

describe("approvals-page-helpers", () => {
  it("finds nested trace metadata without accepting primitives", () => {
    expect(findTraceMetadata(null)).toBeNull();
    expect(findTraceMetadata({ nested: { traceId: "trace-1" } })).toEqual({ traceId: "trace-1" });
    expect(findTraceMetadata({ one: { two: { correlationId: "corr-1", traceId: "trace-2" } } })).toEqual({
      correlationId: "corr-1",
      traceId: "trace-2",
    });
  });

  it("merges duplicate approvals by newest timestamp and sorts newest first", () => {
    const older = approval({ approvalId: "same", createdAt: "2026-05-14T09:00:00.000Z", payload: { marker: "older" } });
    const newer = approval({ approvalId: "same", createdAt: "2026-05-14T11:00:00.000Z", payload: { marker: "newer" } });
    const other = approval({ approvalId: "other", createdAt: "2026-05-14T10:30:00.000Z" });

    expect(
      mergeApprovals([[older], [other, newer]]).map((item) => `${item.approvalId}:${item.payload.marker ?? ""}`),
    ).toEqual(["same:newer", "other:"]);
  });

  it("detects recovery linkage, expiry, lifecycle ids, blocked statuses, and inferred ids", () => {
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    expect(hasRecoveryLinkage(approval({ linkage: { durableRunId: "run-1" } }))).toBe(true);
    expect(hasRecoveryLinkage(approval({ linkage: {} }))).toBe(false);
    expect(isExpiredApproval(approval({ expiresAt: "2026-05-14T11:59:00.000Z" }))).toBe(true);
    expect(isExpiredApproval(approval({ status: "approved", expiresAt: "2026-05-14T11:59:00.000Z" }))).toBe(false);
    expect(isExpiredApproval(approval({ expiresAt: "bad-date" }))).toBe(false);
    expect(getCanonicalDurableRunId({ canonical: { runId: "canonical-run" } } as any)).toBe("canonical-run");
    expect(getCanonicalDurableRunId({ approval: { linkage: { durableRunId: "linked-run" } } } as any)).toBe(
      "linked-run",
    );
    expect(getCanonicalDurableRunId({} as any)).toBeNull();
    expect(isBlockedDurableStatus("paused")).toBe(true);
    expect(isBlockedDurableStatus("waiting")).toBe(true);
    expect(isBlockedDurableStatus("running")).toBe(false);
    expect(formatInferredIds(["a", "b"], "a")).toBe("b");
    expect(formatInferredIds(["a"], "a")).toBe("none");
  });

  it("builds a deduplicated evidence model from nested approval payloads", () => {
    const evidence = buildApprovalEvidenceModel(
      {
        path: "apps/mission-control/src/App.tsx",
        command: "pnpm test",
        diff: "-old\n+new",
        url: "https://example.test/evidence",
        children: [
          {
            files: ["one.ts", "two.ts", "three.ts", "four.ts", "five.ts"],
            scripts: ["lint", "test", "typecheck", "coverage"],
            patches: ["-a\n+b", "single-line"],
            prompt: "review this change",
          },
        ],
      },
      undefined,
    );

    expect(evidence).toMatchObject({
      targets: ["Path: apps/mission-control/src/App.tsx", "Files: one.ts, two.ts, three.ts, four.ts..."],
      commands: ["Command: pnpm test", "Scripts: lint | test | typecheck..."],
      supporting: ["Url: https://example.test/evidence", "Prompt: review this change"],
    });
    expect(evidence?.changes).toEqual([
      { label: "Diff", content: "-old\n+new" },
      { label: "Patches", content: "-a\n+b" },
    ]);
    expect(buildApprovalEvidenceModel({ ignored: 123 })).toBeNull();
  });
});
