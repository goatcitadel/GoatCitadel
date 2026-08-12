import type {
  DurableBackgroundTaskControlAction,
  DurableBackgroundTaskControlResponse,
  DurableBackgroundTaskRailResponse,
} from "@goatcitadel/contracts";
import { z } from "zod";

const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const hasForbiddenControlCharacter = (value: string, allowDisplayWhitespace = false) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (allowDisplayWhitespace && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)) {
      return false;
    }
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= max && !hasForbiddenControlCharacter(value),
      "Invalid bounded text",
    );
const boundedDisplayText = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= max && !hasForbiddenControlCharacter(value, true),
      "Invalid bounded display text",
    );
const semanticId = boundedText(200);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const semanticLink = z
  .object({
    kind: z.enum(["durable_run", "chat_session", "chat_turn", "approval", "delegation_run", "delegation_step", "task"]),
    id: semanticId,
    label: boundedText(96),
  })
  .strict();
const scope = z.object({ workspaceId: semanticId, sessionId: semanticId, verified: z.boolean() }).strict();
const coverage = z
  .object({
    complete: z.boolean(),
    observedCount: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .strict();
const runStatus = z.enum([
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "dead_lettered",
]);
const terminalStatuses = new Set(["completed", "failed", "cancelled", "dead_lettered"]);

const tool = z
  .object({
    toolRunId: semanticId,
    toolName: boundedText(96),
    status: z.enum(["started", "executed", "blocked", "approval_required", "failed"]),
    approvalId: semanticId.optional(),
    startedAt: isoTimestamp,
    finishedAt: isoTimestamp.optional(),
    error: boundedDisplayText(324).optional(),
    failureGuidance: boundedDisplayText(324).optional(),
    links: z.array(semanticLink).max(8),
  })
  .strict();
const approval = z
  .object({
    approvalId: semanticId,
    status: z.enum(["pending", "approved", "rejected", "edited", "missing"]),
    riskLevel: z.enum(["safe", "caution", "danger", "nuclear"]).optional(),
    createdAt: isoTimestamp.optional(),
    expiresAt: isoTimestamp.optional(),
    links: z.array(semanticLink).max(8),
  })
  .strict();
const output = z
  .object({
    availability: z.enum(["available", "missing", "not_terminal", "unknown"]),
    source: z.enum(["delegation_step", "assistant_message"]).optional(),
    sourceId: semanticId.optional(),
    summary: boundedDisplayText(1_204).optional(),
    sha256: sha256.optional(),
    byteCount: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const evidence = [value.source, value.sourceId, value.summary, value.sha256, value.byteCount];
    if (value.availability === "available" && evidence.some((item) => item === undefined)) {
      context.addIssue({ code: "custom", message: "Available output is missing evidence" });
    }
    if (value.availability !== "available" && evidence.some((item) => item !== undefined)) {
      context.addIssue({ code: "custom", message: "Unavailable output contains evidence" });
    }
  });
const blocker = z
  .object({
    kind: z.enum([
      "approval_required",
      "paused",
      "waiting",
      "failed",
      "cancelled",
      "dead_lettered",
      "detached",
      "missing_child",
      "missing_output",
      "projection_incomplete",
      "scope_unverified",
      "signal_integrity",
    ]),
    message: boundedDisplayText(320),
    link: semanticLink.optional(),
  })
  .strict();
const attention = z
  .object({
    state: z.enum(["foreground", "background", "stopped"]),
    reason: z.enum(["watcher_attached", "operator_continued_in_background", "watcher_closed"]),
    updatedAt: isoTimestamp,
    required: z.boolean(),
    requiredReason: blocker.shape.kind.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.required !== (value.requiredReason !== undefined)) {
      context.addIssue({ code: "custom", message: "Attention requirement is inconsistent" });
    }
    if (
      (value.state === "foreground" && value.reason !== "watcher_attached") ||
      (value.state === "background" && value.reason !== "operator_continued_in_background") ||
      (value.state === "stopped" && value.reason !== "watcher_closed")
    ) {
      context.addIssue({ code: "custom", message: "Attention state and reason are inconsistent" });
    }
  });
const signalIntegrity = z
  .object({
    observedCount: z.number().int().nonnegative(),
    acceptedCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    outOfOrderCount: z.number().int().nonnegative(),
    conflictingSequenceCount: z.number().int().nonnegative(),
    highestAcceptedSequence: z.number().int().positive().optional(),
    observationComplete: z.boolean(),
    posture: z.enum(["clean", "degraded", "unobserved"]),
  })
  .strict();
const controlState = z.object({ enabled: z.boolean(), reason: boundedDisplayText(240).optional() }).strict();
const task = z
  .object({
    watcherId: semanticId,
    watcherRevision: z.number().int().positive(),
    watcherState: z.enum(["attached", "detached", "closed"]),
    watcherUpdatedAt: isoTimestamp,
    childRunId: semanticId,
    delegationRunId: semanticId.optional(),
    delegationStepId: semanticId.optional(),
    canonicalStatus: z.union([runStatus, z.enum(["missing", "unknown"])]),
    childVersion: z.number().int().nonnegative().optional(),
    workerHealth: z.enum(["unknown", "idle", "active", "stale_heartbeat", "expired_lease", "released"]).optional(),
    recoveryState: z
      .enum(["none", "reclaiming", "reclaimable", "retry_budget_exhausted", "dead_lettered", "incomplete_worker_exit"])
      .optional(),
    recoverySummary: boundedDisplayText(324).optional(),
    label: boundedText(100),
    role: boundedText(84).optional(),
    startedAt: isoTimestamp.optional(),
    finishedAt: isoTimestamp.optional(),
    scope,
    tools: z.array(tool).max(200),
    toolCoverage: coverage,
    approvals: z.array(approval).max(200),
    output,
    blockers: z.array(blocker).max(32),
    attention,
    signalIntegrity,
    controls: z.object({ detach: controlState, reattach: controlState, cancel: controlState }).strict(),
    links: z.array(semanticLink).max(12),
  })
  .strict();
const lineage = z
  .object({
    watcherId: semanticId,
    childRunId: semanticId,
    source: z.enum(["delegation_step", "assistant_message"]),
    sourceId: semanticId,
    sha256,
    byteCount: z.number().int().nonnegative(),
    links: z.array(semanticLink).max(12),
  })
  .strict();

const railSchema = z
  .object({
    version: z.literal("durable.background_task_rail.v1"),
    generatedAt: isoTimestamp,
    scope,
    parent: z
      .object({
        runId: semanticId,
        status: runStatus,
        version: z.number().int().nonnegative(),
        workerHealth: z.enum(["unknown", "idle", "active", "stale_heartbeat", "expired_lease", "released"]).optional(),
        recoveryState: z
          .enum([
            "none",
            "reclaiming",
            "reclaimable",
            "retry_budget_exhausted",
            "dead_lettered",
            "incomplete_worker_exit",
          ])
          .optional(),
        links: z.array(semanticLink).max(8),
      })
      .strict(),
    coverage: z.object({ watchers: coverage, parentSignals: coverage }).strict(),
    tasks: z.array(task).max(500),
    synthesis: z
      .object({
        availability: z.enum(["available", "partial", "missing", "not_terminal"]),
        summary: boundedDisplayText(1_204).optional(),
        delegationRunId: semanticId.optional(),
        lineage: z.array(lineage).max(500),
        missingTerminalChildRunIds: z.array(semanticId).max(500),
        uncoveredChildRunIds: z.array(semanticId).max(500),
        uncoveredStepIds: z.array(semanticId).max(500),
      })
      .strict(),
    unknowns: z.array(boundedDisplayText(512)).max(64),
  })
  .strict();

const controlResponseSchema = z
  .object({
    version: z.literal("durable.background_task_control.v1"),
    action: z.enum(["detach", "reattach", "cancel"]),
    watcherId: semanticId,
    childRunId: semanticId,
    outcome: z.enum(["applied", "converged"]),
    rail: z.unknown(),
  })
  .strict();

export function parseDurableBackgroundTaskRail(
  payload: unknown,
  expected: { parentRunId: string; workspaceId: string; sessionId: string },
): DurableBackgroundTaskRailResponse {
  const parsed = railSchema.safeParse(payload);
  if (!parsed.success) throw invalidRail();
  const rail = parsed.data;
  if (
    rail.parent.runId !== expected.parentRunId ||
    rail.scope.workspaceId !== expected.workspaceId ||
    rail.scope.sessionId !== expected.sessionId ||
    !rail.scope.verified ||
    rail.coverage.watchers.observedCount !== rail.tasks.length
  ) {
    throw invalidRail();
  }
  const watchers = new Map(rail.tasks.map((item) => [item.watcherId, item]));
  if (
    watchers.size !== rail.tasks.length ||
    rail.tasks.some(
      (item) =>
        item.scope.workspaceId !== expected.workspaceId ||
        (item.watcherState === "attached" && item.attention.state !== "foreground") ||
        (item.watcherState === "detached" && item.attention.state !== "background") ||
        (item.watcherState === "closed" && item.attention.state !== "stopped") ||
        (item.attention.requiredReason !== undefined &&
          !item.blockers.some((blockerItem) => blockerItem.kind === item.attention.requiredReason)),
    )
  ) {
    throw invalidRail();
  }
  for (const entry of rail.synthesis.lineage) {
    const item = watchers.get(entry.watcherId);
    if (
      !item ||
      item.childRunId !== entry.childRunId ||
      item.output.availability !== "available" ||
      item.output.source !== entry.source ||
      item.output.sourceId !== entry.sourceId ||
      item.output.sha256 !== entry.sha256 ||
      item.output.byteCount !== entry.byteCount ||
      !terminalStatuses.has(item.canonicalStatus)
    ) {
      throw invalidRail();
    }
  }
  const childIds = new Set(rail.tasks.map((item) => item.childRunId));
  if (
    !areUniqueSubset(rail.synthesis.missingTerminalChildRunIds, childIds) ||
    !areUniqueSubset(rail.synthesis.uncoveredChildRunIds, childIds) ||
    new Set(rail.synthesis.uncoveredStepIds).size !== rail.synthesis.uncoveredStepIds.length ||
    (rail.synthesis.availability === "available" &&
      (!rail.synthesis.summary ||
        !rail.coverage.watchers.complete ||
        rail.synthesis.missingTerminalChildRunIds.length > 0 ||
        rail.synthesis.uncoveredChildRunIds.length > 0 ||
        rail.synthesis.uncoveredStepIds.length > 0))
  ) {
    throw invalidRail();
  }
  return rail as DurableBackgroundTaskRailResponse;
}

export function parseDurableBackgroundTaskControlResponse(
  payload: unknown,
  expected: {
    parentRunId: string;
    watcherId: string;
    workspaceId: string;
    sessionId: string;
    action: DurableBackgroundTaskControlAction;
  },
): DurableBackgroundTaskControlResponse {
  const parsed = controlResponseSchema.safeParse(payload);
  if (!parsed.success) throw invalidRail();
  const record = parsed.data;
  if (record.action !== expected.action || record.watcherId !== expected.watcherId || !record.childRunId) {
    throw invalidRail();
  }
  const rail = parseDurableBackgroundTaskRail(record.rail, expected);
  const task = rail.tasks.find((item) => item.watcherId === expected.watcherId);
  if (!task || task.childRunId !== record.childRunId) throw invalidRail();
  return { ...record, rail } as DurableBackgroundTaskControlResponse;
}

function areUniqueSubset(values: string[], allowed: ReadonlySet<string>): boolean {
  return new Set(values).size === values.length && values.every((value) => allowed.has(value));
}

function invalidRail(): Error {
  return new Error("Gateway returned an invalid durable background-task envelope.");
}
