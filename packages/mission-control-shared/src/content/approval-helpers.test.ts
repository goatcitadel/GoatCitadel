import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildApprovalEvidenceModel,
  buildApprovalReviewEvidenceModel,
  approvalResolutionLabel,
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
  it("renders typed denial and withdrawal without interpreting old notes", () => {
    const old = approval({
      approvalId: "legacy",
      createdAt: "2026-01-01T11:00:00.000Z",
      status: "rejected",
      resolutionNote: "Stopped by the user",
    });
    expect(approvalResolutionLabel(old)).toBe("denied");
    expect(approvalResolutionLabel({ ...old, resolutionOutcome: "denied" })).toBe("denied");
    expect(approvalResolutionLabel({ ...old, resolutionOutcome: "withdrawn" })).toBe("withdrawn");
    expect(approvalResolutionLabel({ ...old, resolutionOutcome: "policy_blocked" })).toBe("blocked by policy");
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds trace metadata nested inside arbitrary payloads", () => {
    expect(findTraceMetadata(null)).toBeNull();
    expect(findTraceMetadata({ request: [0, "skip", { nested: false }] })).toBeNull();
    expect(findTraceMetadata({ request: { nested: [{ traceId: "trace-1" }] } })).toEqual({ traceId: "trace-1" });
    expect(findTraceMetadata({ context: { correlationId: "corr-1", traceId: "trace-2" } })).toEqual({
      correlationId: "corr-1",
      traceId: "trace-2",
    });
    expect(findTraceMetadata({ context: { correlationId: "corr-only" } })).toEqual({
      correlationId: "corr-only",
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
    expect(mergeApprovals([[newerApproval], [oldApproval]])).toMatchObject([
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
          approvalId: "pending-without-expiry",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(false);
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
      isExpiredApproval(
        approval({
          approvalId: "invalid-expiry",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "not-a-date",
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
      null,
      "ignore primitive",
      {
        path: "src/index.ts",
        command: "pnpm test -- --runInBand --watch=false",
        reason: "Operator requested validation",
        emptyPatch: "\n\t",
        patches: [repeatedPatch, repeatedPatch, "no newline patch"],
        nested: {
          targetFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
          scripts: ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"],
          prompt: "Review the changes",
          urls: ["http://localhost:8787/status", "https://example.test/a", "https://example.test/b", "extra"],
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
      expect.arrayContaining([
        "Reason: Operator requested validation",
        "Prompt: Review the changes",
        expect.stringMatching(
          /^Urls: http:\/\/localhost:8787\/status, https:\/\/example\.test\/a, https:\/\/example\.test\/b/,
        ),
      ]),
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

it("exposes exact capability identity and scope before a lifecycle decision", () => {
  const model = buildApprovalEvidenceModel(
    { candidateId: "candidate-1", versionId: "version-2", title: "Approve candidate" },
    { capabilityLifecycle: { subjectId: "candidate-1", subjectKind: "capability_candidate", scopeKind: "global" } },
  );
  expect(model?.targets).toEqual(
    expect.arrayContaining([
      "Candidate Id: candidate-1",
      "Version Id: version-2",
      "Subject Id: candidate-1",
      "Subject Kind: capability_candidate",
      "Scope Kind: global",
    ]),
  );
});

it("keeps every exact target and full command in approval review", () => {
  const targets = Array.from({ length: 10 }, (_, index) => "file-" + index);
  const command = "run " + "x".repeat(2000);
  const review = buildApprovalReviewEvidenceModel({ targets, command });
  expect(review!.targets.join(" ")).toContain("file-9");
  expect(review!.commands.join(" ")).toContain(command);
  expect(buildApprovalEvidenceModel({ targets, command })!.commands.join(" ")).not.toContain(command);
});
it.each(["memory.write", "memory.upsert"])("keeps full %s content readable for exact review without broadening arbitrary content fields", toolName => {
  const content = "  " + "Memory sentence ".repeat(200) + "\nSecond line\n";
  expect(buildApprovalReviewEvidenceModel({ toolName, content })?.changes).toEqual([{ label: "Memory content", content }]);
  expect(buildApprovalReviewEvidenceModel({ toolName, content: "One line" })?.changes).toEqual([{ label: "Memory content", content: "One line" }]);
  expect(buildApprovalEvidenceModel({ toolName, content })?.changes[0]?.content.length).toBeLessThan(content.length);
  expect(buildApprovalReviewEvidenceModel({ toolName: "unrelated", content: "One line" })).toBeNull();
});

it("preserves exact lifecycle content and title while keeping compact review bounded", () => {
  const requestedContent = "  " + "Memory value ".repeat(200) + "\nSecond line\n";
  const preview = { reviewKind: "memory.lifecycle.patch", requestedTitle: "Updated title", requestedContent, pinnedSummary: "Requested pinned state: unpinned", ttlSummary: "Requested TTL: 60 seconds" };
  expect(buildApprovalReviewEvidenceModel(preview)?.changes).toEqual([{ label: "Requested memory title", content: "Updated title" }, { label: "Requested memory content", content: requestedContent }]);
  expect(buildApprovalEvidenceModel(preview)?.changes[1]?.content.length).toBeLessThan(requestedContent.length);
  expect(buildApprovalReviewEvidenceModel({ ...preview, requestedContent: "  \n" })?.changes[1]?.content).toBe("  \n");
});

it("keeps every exact batch target paired with its scope and requested values", () => {
 const model = buildApprovalReviewEvidenceModel({ reviewKind: "memory.lifecycle.batch", reviewedItems: [{ target: "First memory", scopeSummary: "Workspace one; namespace decisions", consequence: "Apply reviewed changes", pinnedSummary: "Unpin item" }, { target: "Second memory", scopeSummary: "Workspace one; namespace workspace", consequence: "Forget this item from active recall." }] });
 expect(model?.changes).toEqual([{ label: "Memory target 1", content: "Target: First memory\nWorkspace one; namespace decisions\nConsequence: Apply reviewed changes\nUnpin item" }, { label: "Memory target 2", content: "Target: Second memory\nWorkspace one; namespace workspace\nConsequence: Forget this item from active recall." }]);
});

it("shows memory review summaries as the Gateway wrote them and pairs each target with its own label", () => {
  const preview = { reviewKind: "memory.lifecycle.patch", title: "Approve memory item update", target: "Target: launch plan", scopeSummary: "Workspace: ws-1; namespace: notes", contentSummary: "Requested content: 41 UTF-8 bytes before redaction.", pinnedSummary: "Requested pinned state: unpinned", ttlSummary: "Requested TTL: 600 seconds", withheldSummary: "Secret-looking values are redacted." };
  const model = buildApprovalReviewEvidenceModel(preview);
  // The user-supplied title is kept exactly, even when it starts with "Target:".
  expect(model?.targetEntries).toEqual([{ label: "Target", value: "Target: launch plan" }]);
  expect(model?.targets).toEqual(["Target: Target: launch plan"]);
  expect(model?.supporting).toEqual(expect.arrayContaining(["Workspace: ws-1; namespace: notes", "Requested content: 41 UTF-8 bytes before redaction.", "Requested pinned state: unpinned", "Requested TTL: 600 seconds", "Secret-looking values are redacted."]));
  expect(model?.supporting.some((line) => /Summary: /.test(line))).toBe(false);
});
