import { expect, it } from "vitest";
import type { ApprovalEffectRecord, ApprovalRequest, DurableRunRecord } from "@goatcitadel/contracts";
import { isKnownExpiredReviewWaitEffect } from "./chat-continuation-wait-evidence.js";

const approval = { approvalId: "expired", kind: "change_plan_effect", status: "rejected", resolutionOutcome: "expired", linkage: { durableRunId: "wait" } } as ApprovalRequest;
const reservation = { approvalId: "expired", runId: "wait" };
const run = { runId: "wait", workflowKey: "approval.wait", payload: { version: "approval.wait.v1", approvalId: "expired", approvalKind: "change_plan_effect" } } as DurableRunRecord;
const effect = { approvalId: "expired", effectKind: "approval_wait_materialize", targetKind: "durable_run", targetId: "wait", status: "completed", payload: { approvalId: "expired", runId: "wait" }, result: { approvalId: "expired", runId: "wait", materialized: true } } as ApprovalEffectRecord;
const wake = { ...effect, effectKind: "approval_wait_wake", payload: { eventKey: "approval.resolved", correlationId: "expired", payload: { approvalId: "expired", status: "rejected", decision: "reject", resolvedBy: "system:approval-expiry" } }, result: { approvalId: "expired", runId: "wait", targetId: "wait", outcome: "woke" } } as ApprovalEffectRecord;
const base = { approval, effect, reservation, run };

it("recognizes only the expired review's completed, canonical pure-wait effects", () => {
  expect(isKnownExpiredReviewWaitEffect(base)).toBe(true);
  expect(isKnownExpiredReviewWaitEffect({ ...base, effect: wake })).toBe(true);
});

it.each([
  ["an action workflow", { ...base, run: { ...run, workflowKey: "connector.delivery" } }],
  ["an unknown wait version", { ...base, run: { ...run, payload: { ...run.payload, version: "approval.wait.v9" } } }],
  ["another reservation", { ...base, reservation: { ...reservation, approvalId: "foreign" } }],
  ["a missing reservation", { ...base, reservation: undefined }],
  ["another reserved run", { ...base, reservation: { ...reservation, runId: "foreign" } }],
  ["another linked run", { ...base, approval: { ...approval, linkage: { durableRunId: "foreign" } } }],
  ["another effect target", { ...base, effect: { ...effect, targetId: "foreign" } }],
  ["another payload approval", { ...base, run: { ...run, payload: { ...run.payload, approvalId: "foreign" } } }],
  ["another approval kind", { ...base, run: { ...run, payload: { ...run.payload, approvalKind: "tool_execution" } } }],
  ["another effect approval", { ...base, effect: { ...effect, approvalId: "foreign" } }],
  ["a pending wait effect", { ...base, effect: { ...effect, status: "pending" } }],
  ["a denied review", { ...base, approval: { ...approval, resolutionOutcome: "denied" } }],
  ["an approved review", { ...base, approval: { ...approval, status: "approved" } }],
  ["an action effect", { ...base, effect: { ...effect, effectKind: "tool_execution" } }],
  ["a mismatched materialization payload", { ...base, effect: { ...effect, payload: { approvalId: "foreign", runId: "wait" } } }],
  ["an approved wake", { ...base, effect: { ...wake, payload: { ...wake.payload, payload: { approvalId: "expired", status: "approved", decision: "approve", resolvedBy: "operator" } } } }],
  ["a foreign wake event", { ...base, effect: { ...wake, payload: { ...wake.payload, correlationId: "foreign" } } }],
  ["an unverified wake result", { ...base, effect: { ...wake, result: { approvalId: "expired", runId: "foreign" } } }],
] as const)("keeps %s unknown", (_name, input) => {
  expect(isKnownExpiredReviewWaitEffect(input as typeof base)).toBe(false);
});
