import { describe, expect, it } from "vitest";
import type { DurableDeadLetterRecord, DurableRunRecord, OperatorInboxItem } from "@goatcitadel/contracts";
import { canRequestRunRecovery, sameRunRecoveryEvidence } from "./run-recovery-guard";

const run: DurableRunRecord = {
  runId: "run-a", workflowKey: "maintenance.repair", status: "failed", attemptCount: 1, maxAttempts: 3,
  version: 4, payload: { workspaceId: "workspace-a" }, metadata: { workspaceId: "workspace-a" },
  createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T01:00:00Z",
};
const item: OperatorInboxItem = {
  id: "failed_run:run-a", kind: "failed_run", group: "needs_attention", title: "Recover failed run",
  summary: "Failed", createdAt: run.createdAt, updatedAt: run.updatedAt,
  source: { workspaceId: "workspace-a", runId: run.runId }, href: "/ops/runtime?runId=run-a",
};
const letter: DurableDeadLetterRecord = {
  deadLetterId: "dead-a", runId: run.runId, reason: "Stopped", payload: {}, createdAt: "2026-09-28T02:00:00Z",
};
const deadItem: OperatorInboxItem = {
  ...item, id: "dead_letter:dead-a", kind: "dead_letter", createdAt: letter.createdAt,
  source: { ...item.source, deadLetterId: letter.deadLetterId },
};

describe("Inbox run recovery guard", () => {
  it("requires a fresh, unambiguous workspace owner and retry budget", () => {
    expect(canRequestRunRecovery(item, { run }, "workspace-a")).toBe(true);
    expect(canRequestRunRecovery(item, { run }, "workspace-b")).toBe(false);
    expect(canRequestRunRecovery(item, { run: { ...run, updatedAt: "later" } }, "workspace-a")).toBe(false);
    expect(canRequestRunRecovery(item, { run: { ...run, metadata: { workspaceId: "workspace-b" } } }, "workspace-a")).toBe(false);
    expect(canRequestRunRecovery(item, { run: { ...run, attemptCount: 3 } }, "workspace-a")).toBe(false);
    expect(canRequestRunRecovery(item, { run: { ...run, status: "queued" } }, "workspace-a")).toBe(false);
  });

  it("keeps admitted Chat replay out of manual retry", () => {
    expect(canRequestRunRecovery(item, { run: {
      ...run, workflowKey: "chat.turn.execute", payload: { workspaceId: "workspace-a", version: "chat.turn.execute.v2" },
    } }, "workspace-a")).toBe(false);
  });

  it("requires the exact unresolved dead letter and rejects exhausted recovery", () => {
    const stopped = { ...run, status: "dead_lettered" as const };
    expect(canRequestRunRecovery(deadItem, { run: stopped, deadLetter: letter }, "workspace-a")).toBe(true);
    expect(canRequestRunRecovery(deadItem, { run: stopped }, "workspace-a")).toBe(false);
    expect(canRequestRunRecovery(deadItem, { run: stopped, deadLetter: { ...letter, resolvedAt: "later" } }, "workspace-a")).toBe(false);
    expect(canRequestRunRecovery(deadItem, { run: stopped, deadLetter: { ...letter, runId: "other" } }, "workspace-a")).toBe(false);
    expect(canRequestRunRecovery(deadItem, { run: { ...stopped, attemptCount: 20 }, deadLetter: letter }, "workspace-a")).toBe(false);
  });

  it("detects a changed owner between review and mutation", () => {
    expect(sameRunRecoveryEvidence({ run }, { run: { ...run } })).toBe(true);
    expect(sameRunRecoveryEvidence({ run }, { run: { ...run, version: 5 } })).toBe(false);
    expect(sameRunRecoveryEvidence({ run }, { run: { ...run, attemptCount: 2 } })).toBe(false);
    expect(sameRunRecoveryEvidence({ run, deadLetter: letter }, { run, deadLetter: { ...letter, resolvedAt: "later" } })).toBe(false);
  });
});
