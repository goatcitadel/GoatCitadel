import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildApprovalEvidenceModel,
  findTraceMetadata,
  formatInferredIds,
  getCanonicalDurableRunId,
  hasRecoveryLinkage,
  isBlockedDurableStatus,
  isExpiredApproval,
  mergeApprovals,
} from "./approval-helpers";

function approval(
  input: Partial<ApprovalRequest> & Pick<ApprovalRequest, "approvalId" | "createdAt">,
): ApprovalRequest {
  return {
    approvalId: input.approvalId,
    status: input.status ?? "pending",
    riskLevel: input.riskLevel ?? "safe",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    requestedBy: "test",
    action: "test.action",
    summary: "Test approval",
    payload: {},
    ...input,
  } as ApprovalRequest;
}

describe("approval helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds trace metadata nested inside arbitrary payloads", () => {
    expect(findTraceMetadata(null)).toBeNull();
    expect(findTraceMetadata({ request: { nested: [{ traceId: "trace-1" }] } })).toEqual({ traceId: "trace-1" });
    expect(findTraceMetadata({ context: { correlationId: "corr-1", traceId: "trace-2" } })).toEqual({
      correlationId: "corr-1",
      traceId: "trace-2",
    });
    expect(findTraceMetadata({ context: { unrelated: true } })).toBeNull();
  });

  it("merges approval groups by id and keeps the newest record first", () => {
    const oldApproval = approval({
      approvalId: "approval-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: "old",
    });
    const newerApproval = approval({
      approvalId: "approval-1",
      createdAt: "2026-01-01T01:00:00.000Z",
      summary: "new",
    });
    const otherApproval = approval({
      approvalId: "approval-2",
      createdAt: "2026-01-01T02:00:00.000Z",
    });

    expect(mergeApprovals([[oldApproval], [otherApproval, newerApproval]])).toMatchObject([
      { approvalId: "approval-2" },
      { approvalId: "approval-1", summary: "new" },
    ]);
  });

  it("classifies recovery linkage, expiry, and durable run identity", () => {
    expect(hasRecoveryLinkage(approval({ approvalId: "plain", createdAt: "2026-01-01T00:00:00.000Z" }))).toBe(false);
    expect(
      hasRecoveryLinkage(
        approval({
          approvalId: "linked",
          createdAt: "2026-01-01T00:00:00.000Z",
          linkage: { durableRunId: "run-1", correlationId: "corr-1" },
        }),
      ),
    ).toBe(true);
    expect(
      isExpiredApproval(
        approval({
          approvalId: "expired",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T11:59:59.000Z",
        }),
      ),
    ).toBe(true);
    expect(
      isExpiredApproval(
        approval({
          approvalId: "resolved",
          status: "approved",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T11:59:59.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      getCanonicalDurableRunId({
        canonical: { runId: "canonical-run" },
      } as RuntimeLifecycleResponse),
    ).toBe("canonical-run");
    expect(
      getCanonicalDurableRunId({
        approval: {
          linkage: { durableRunId: "linked-run" },
        },
      } as RuntimeLifecycleResponse),
    ).toBe("linked-run");
    expect(getCanonicalDurableRunId({} as RuntimeLifecycleResponse)).toBeNull();
    expect(isBlockedDurableStatus("paused")).toBe(true);
    expect(isBlockedDurableStatus("waiting")).toBe(true);
    expect(isBlockedDurableStatus("completed")).toBe(false);
    expect(formatInferredIds(["run-1", "run-2"], "run-1")).toBe("run-2");
    expect(formatInferredIds(["run-1"], "run-1")).toBe("none");
  });

  it("builds bounded evidence models from nested approval payloads", () => {
    const repeatedPatch = "diff --git a/file.ts b/file.ts\n+const answer = 42;";
    const model = buildApprovalEvidenceModel(
      {
        path: "src/index.ts",
        command: "pnpm test -- --runInBand --watch=false",
        reason: "Operator requested validation",
        patches: [repeatedPatch, repeatedPatch],
        nested: {
          targetFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
          scripts: ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"],
          prompt: "Review the changes",
        },
      },
      {
        content: "before\n".repeat(800),
        url: "http://localhost:8787/status",
      },
    );

    expect(model?.targets).toEqual([
      "Path: src/index.ts",
      expect.stringMatching(/^Target Files: src\/a\.ts, src\/b\.ts, src\/c\.ts, src\/d\.ts\u2026$/),
    ]);
    expect(model?.commands).toEqual([
      "Command: pnpm test -- --runInBand --watch=false",
      expect.stringMatching(/^Scripts: pnpm lint \| pnpm typecheck \| pnpm test\u2026$/),
    ]);
    expect(model?.supporting).toEqual(
      expect.arrayContaining(["Reason: Operator requested validation", "Prompt: Review the changes"]),
    );
    expect(model?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Content" }),
        expect.objectContaining({ label: "Patches", content: repeatedPatch }),
      ]),
    );
    expect(model?.changes.find((change) => change.label === "Content")?.content.endsWith("\n...")).toBe(true);
  });

  it("returns null when no evidence-bearing fields are present", () => {
    expect(buildApprovalEvidenceModel({ count: 1, nested: [false, null] })).toBeNull();
  });
});
