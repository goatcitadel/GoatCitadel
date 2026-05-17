import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatCitationRecord,
  ChatExecutionPlanRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatToolRunRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import {
  attachTurnTraceDetails,
  ChatTurnTraceRepository,
  type ChatTurnTraceCreateInput,
  type ChatTurnTracePatchInput,
} from "./chat-turn-trace-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: ChatTurnTraceRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-turn-trace-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatTurnTraceRepository(db) };
}

function baseTrace(overrides: Partial<ChatTurnTraceCreateInput> = {}): ChatTurnTraceCreateInput {
  return {
    turnId: "turn-a",
    sessionId: "session-a",
    userMessageId: "user-message-a",
    mode: "cowork",
    webMode: "deep",
    memoryMode: "on",
    thinkingLevel: "extended",
    startedAt: "2026-03-26T00:00:01.000Z",
    ...overrides,
  };
}

function citation(): ChatCitationRecord {
  return {
    citationId: "citation-a",
    title: "GoatCitadel",
    url: "https://example.test/goat",
    snippet: "source",
    sourceType: "web",
  };
}

function capabilitySuggestion(): ChatCapabilityUpgradeSuggestion {
  return {
    kind: "skill_import",
    title: "Researcher",
    summary: "Adds a researcher workflow.",
    reason: "Useful for long-running synthesis.",
    sourceProvider: "local",
    sourceRef: "local",
    riskLevel: "low",
    recommendedAction: "install_skill_enable",
    candidateId: "candidate-a",
    requiresUserApproval: true,
  };
}

function specialistSuggestion(): ChatSpecialistCandidateSuggestionRecord {
  return {
    candidateId: "specialist-a",
    title: "QA Specialist",
    role: "QA",
    summary: "Checks validation evidence.",
    reason: "Coverage work needs focused verification.",
    source: "runtime_gap",
    confidence: 0.82,
    suggestedStatus: "suggested",
    suggestedRoutingMode: "manual_only",
    requiresApproval: true,
    suggestedTools: ["test"],
    suggestedSkills: ["qa"],
    routingHints: {
      preferredModes: ["cowork"],
      objectiveKeywords: ["coverage"],
      requiresProjectBinding: true,
      maxInvocationsPerRun: 1,
    },
    evidence: [
      {
        evidenceId: "evidence-a",
        kind: "role_gap",
        summary: "No dedicated QA role was active.",
        confidence: 0.7,
      },
    ],
  };
}

function executionPlan(): ChatExecutionPlanRecord {
  return {
    planId: "plan-a",
    sessionId: "session-a",
    turnId: "turn-a",
    mode: "cowork",
    planningMode: "advisory",
    status: "running",
    source: "planner",
    advisoryOnly: false,
    objective: "Increase coverage",
    summary: "Cover trace repository behavior.",
    steps: [
      {
        stepId: "step-a",
        index: 0,
        objective: "Write tests",
        parallelizable: false,
        status: "running",
      },
    ],
    createdAt: "2026-03-26T00:00:01.000Z",
    updatedAt: "2026-03-26T00:00:02.000Z",
  };
}

function toolRun(): ChatToolRunRecord {
  return {
    toolRunId: "tool-run-a",
    turnId: "turn-a",
    sessionId: "session-a",
    toolName: "shell.run",
    status: "executed",
    startedAt: "2026-03-26T00:00:02.000Z",
  };
}

function setRawField(db: DatabaseClient, turnId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_turn_traces SET ${field} = ? WHERE turn_id = ?`).run(value, turnId);
}

describe("ChatTurnTraceRepository", () => {
  it("creates, patches, lists, and preserves operator routing metadata", () => {
    const { repo } = createStore();
    const created = repo.create(
      baseTrace({
        parentTurnId: "parent-turn",
        branchKind: "retry",
        sourceTurnId: "source-turn",
        assistantMessageId: "assistant-message-a",
        executionPlanId: "plan-a",
        status: "waiting_for_tool",
        model: "gpt-test",
        speedMode: "fast",
        subagentPolicy: "auto_when_useful",
        effectiveToolAutonomy: "safe_auto",
        routing: {
          effectiveProviderId: "openai",
          effectiveModel: "gpt-test",
          liveDataIntent: true,
        },
        retrieval: {
          l0Used: true,
          l1Used: true,
          l2Used: false,
          confidenceL0: 0.9,
          confidenceL1: 0.7,
          escalationReason: "workspace context",
        },
        reflection: {
          attempted: true,
          attemptCount: 1,
          outcome: "recovered",
        },
        proactive: {
          runId: "proactive-a",
          actionCount: 2,
          mode: "suggest",
        },
        completion: {
          status: "interrupted",
          repaired: false,
        },
        durable: {
          runId: "durable-a",
          status: "running",
          checkpointKind: "turn",
        },
        orchestration: {
          runId: "delegation-a",
          objective: "Cover trace behavior",
          workflowTemplate: "qa",
          status: "running",
          modePolicy: "cowork",
          visibility: "explicit",
          integritySignals: ["trace"],
          routeDecision: {
            modePolicy: "cowork",
            workflowTemplate: "qa",
            hidden: false,
            visibility: "explicit",
            intensity: "deep",
            providerPreference: "quality",
            reviewDepth: "strict",
            parallelism: "sequential",
            selectedRoles: ["QA"],
            selectedProviders: [{ role: "QA", providerId: "openai", model: "gpt-test" }],
            triggerReason: "coverage",
          },
          steps: [
            {
              stepId: "step-a",
              role: "QA",
              index: 0,
              status: "running",
              startedAt: "2026-03-26T00:00:01.500Z",
            },
          ],
        },
        guidance: {
          workspaceId: "workspace-a",
          globalFilesUsed: ["AGENTS.md"],
          workspaceFilesUsed: ["workspaces/ws/AGENTS.md"],
          truncated: false,
        },
        loopGuard: {
          enabled: true,
          historySize: 1,
          events: [
            {
              eventId: "loop-a",
              detector: "repeated_same_call",
              severity: "warning",
              toolName: "shell.run",
              message: "Repeated call",
              repetitionCount: 2,
              historySize: 4,
              suppressed: false,
              createdAt: "2026-03-26T00:00:02.000Z",
            },
          ],
        },
        pendingUserInput: {
          promptId: "prompt-a",
          turnId: "turn-a",
          kind: "single_select",
          title: "Choose path",
          question: "Continue?",
          required: true,
          options: [{ optionId: "yes", label: "Yes", description: "Continue" }],
        },
        citations: [citation()],
        capabilityUpgradeSuggestions: [capabilitySuggestion()],
        specialistCandidateSuggestions: [specialistSuggestion()],
        failure: {
          failureClass: "tool_failed",
          message: "Tool failed once.",
          retryable: true,
          recommendedAction: "retry_narrower",
        },
        finishedAt: "2026-03-26T00:00:03.000Z",
      }),
    );

    assert.equal(created.branchKind, "retry");
    assert.equal(created.sourceTurnId, "source-turn");
    assert.equal(created.status, "waiting_for_tool");
    assert.equal(created.speedMode, "fast");
    assert.equal(created.subagentPolicy, "auto_when_useful");
    assert.equal(created.effectiveToolAutonomy, "safe_auto");
    assert.deepEqual(created.routing, {
      effectiveProviderId: "openai",
      effectiveModel: "gpt-test",
      liveDataIntent: true,
    });
    assert.equal(created.retrieval?.l1Used, true);
    assert.equal(created.reflection?.outcome, "recovered");
    assert.equal(created.proactive?.runId, "proactive-a");
    assert.equal(created.completion?.status, "interrupted");
    assert.equal(created.durable?.runId, "durable-a");
    assert.equal(created.orchestration?.routeDecision.reviewDepth, "strict");
    assert.equal(created.guidance?.workspaceId, "workspace-a");
    assert.equal(created.loopGuard?.events[0]?.detector, "repeated_same_call");
    assert.equal(created.pendingUserInput?.promptId, "prompt-a");
    assert.equal(created.citations[0]?.citationId, "citation-a");
    assert.equal(created.capabilityUpgradeSuggestions?.[0]?.candidateId, "candidate-a");
    assert.equal(created.specialistCandidateSuggestions?.[0]?.candidateId, "specialist-a");
    assert.equal(created.failure?.failureClass, "tool_failed");

    const clearFailure = { failure: undefined } satisfies ChatTurnTracePatchInput;
    const patched = repo.patch("turn-a", {
      ...clearFailure,
      parentTurnId: "parent-turn-updated",
      branchKind: "edit",
      sourceTurnId: "source-turn-updated",
      assistantMessageId: "assistant-message-b",
      executionPlanId: "plan-b",
      status: "completed",
      model: "gpt-updated",
      effectiveToolAutonomy: "manual",
      routing: { fallbackUsed: true },
      retrieval: { l0Used: false, l1Used: false, l2Used: true },
      reflection: { attempted: false, attemptCount: 0, reason: "not needed" },
      proactive: { stopReason: "budget_exhausted" },
      completion: { status: "complete", repaired: true },
      durable: { status: "completed", recoverySummary: "done" },
      orchestration: {
        runId: "delegation-a",
        objective: "Cover trace behavior",
        workflowTemplate: "qa",
        status: "completed",
        modePolicy: "cowork",
        visibility: "explicit",
        finalSummary: "done",
        routeDecision: {
          modePolicy: "cowork",
          workflowTemplate: "qa",
          hidden: false,
          visibility: "explicit",
          intensity: "balanced",
          providerPreference: "balanced",
          reviewDepth: "standard",
          parallelism: "sequential",
          selectedRoles: ["QA"],
          selectedProviders: [],
          triggerReason: "coverage",
        },
        steps: [],
      },
      guidance: {
        workspaceId: "workspace-b",
        globalFilesUsed: [],
        workspaceFilesUsed: [],
        truncated: true,
      },
      loopGuard: { enabled: false, historySize: 0, events: [] },
      pendingUserInput: null,
      citations: [],
      capabilityUpgradeSuggestions: [],
      specialistCandidateSuggestions: [],
      finishedAt: "2026-03-26T00:00:04.000Z",
    });

    assert.equal(patched.parentTurnId, "parent-turn-updated");
    assert.equal(patched.branchKind, "edit");
    assert.equal(patched.executionPlanId, "plan-b");
    assert.equal(patched.status, "completed");
    assert.equal(patched.model, "gpt-updated");
    assert.equal(patched.speedMode, "fast");
    assert.equal(patched.subagentPolicy, "auto_when_useful");
    assert.equal(patched.effectiveToolAutonomy, "manual");
    assert.deepEqual(patched.routing, { fallbackUsed: true });
    assert.equal(patched.pendingUserInput, undefined);
    assert.equal(patched.failure, undefined);
    assert.deepEqual(patched.citations, []);
    assert.deepEqual(patched.capabilityUpgradeSuggestions, []);
    assert.deepEqual(patched.specialistCandidateSuggestions, []);

    const defaulted = repo.create(
      baseTrace({
        turnId: "turn-b",
        userMessageId: "user-message-b",
        mode: "chat",
        webMode: "off",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: "2026-03-26T00:00:05.000Z",
      }),
    );
    assert.equal(defaulted.branchKind, "append");
    assert.equal(defaulted.status, "running");
    assert.equal(defaulted.toolRuns.length, 0);
    assert.deepEqual(defaulted.citations, []);
    assert.deepEqual(defaulted.routing, {});

    assert.deepEqual(
      repo.listBySession("session-a").map((trace) => trace.turnId),
      ["turn-b", "turn-a"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 0).map((trace) => trace.turnId),
      ["turn-b"],
    );
    assert.throws(() => repo.get("missing-turn"), /Chat turn trace missing-turn not found/);
    assert.throws(() => repo.patch("missing-turn", { status: "failed" }), /Chat turn trace missing-turn not found/);
  });

  it("attaches loaded trace details without mutating missing detail fields", () => {
    const { repo } = createStore();
    const trace = repo.create(baseTrace());
    const plan = executionPlan();
    const enriched = attachTurnTraceDetails(trace, {
      toolRuns: [toolRun()],
      citations: [citation()],
      executionPlan: plan,
      capabilityUpgradeSuggestions: [capabilitySuggestion()],
    });

    assert.deepEqual(enriched.toolRuns, [toolRun()]);
    assert.deepEqual(enriched.citations, [citation()]);
    assert.deepEqual(enriched.executionPlan, plan);
    assert.deepEqual(enriched.capabilityUpgradeSuggestions, [capabilitySuggestion()]);
    assert.equal(attachTurnTraceDetails(trace, {}).toolRuns, trace.toolRuns);
    assert.equal(attachTurnTraceDetails(trace, {}).citations, trace.citations);
  });

  it("treats duplicate trace starts for the same turn as idempotent", () => {
    const { repo } = createStore();
    const created = repo.create(
      baseTrace({
        status: "running",
        model: "gpt-original",
        startedAt: "2026-03-26T00:00:01.000Z",
      }),
    );

    const duplicate = repo.create(
      baseTrace({
        status: "failed",
        model: "gpt-duplicate",
        failure: {
          failureClass: "unknown",
          message: "duplicate should not replace the running trace",
          retryable: true,
        },
        startedAt: "2026-03-26T00:00:02.000Z",
      }),
    );

    assert.equal(duplicate.turnId, created.turnId);
    assert.equal(duplicate.status, "running");
    assert.equal(duplicate.model, "gpt-original");
    assert.equal(duplicate.failure, undefined);
    assert.equal(duplicate.startedAt, "2026-03-26T00:00:01.000Z");

    assert.throws(
      () => repo.create(baseTrace({ sessionId: "other-session" })),
      /already belongs to session session-a and message user-message-a/,
    );
  });

  it("filters malformed rows and falls back on malformed persisted JSON", () => {
    const { db, repo } = createStore();
    repo.create(
      baseTrace({
        routing: { primaryProviderId: "openai" },
        retrieval: { l0Used: true, l1Used: false, l2Used: false },
        citations: [citation()],
      }),
    );

    setRawField(db, "turn-a", "routing_json", "[]");
    setRawField(db, "turn-a", "retrieval_json", "{bad json");
    setRawField(db, "turn-a", "citations_json", "{bad json");
    const malformedJson = repo.get("turn-a");
    assert.deepEqual(malformedJson.routing, {});
    assert.equal(malformedJson.retrieval, undefined);
    assert.deepEqual(malformedJson.citations, []);

    setRawField(db, "turn-a", "started_at", new Uint8Array([1]));
    assert.throws(() => repo.get("turn-a"), /Chat turn trace turn-a not found/);
    assert.deepEqual(repo.listBySession("session-a"), []);
  });

  it("preserves existing trace fields when patch inputs are omitted", () => {
    const { db, repo } = createStore();
    const created = repo.create(
      baseTrace({
        startedAt: undefined,
        parentTurnId: "parent-existing",
        sourceTurnId: "source-existing",
        assistantMessageId: "assistant-existing",
        executionPlanId: "plan-existing",
        model: "gpt-existing",
        routing: { effectiveProviderId: "openai" },
        effectiveToolAutonomy: "safe_auto",
        retrieval: { l0Used: true, l1Used: false, l2Used: false },
        reflection: { attempted: true, attemptCount: 1 },
        proactive: { runId: "proactive-existing" },
        completion: { status: "complete", repaired: false },
        durable: { runId: "durable-existing" },
        orchestration: {
          runId: "delegation-existing",
          objective: "Preserve",
          workflowTemplate: "qa",
          status: "running",
          modePolicy: "cowork",
          visibility: "explicit",
          routeDecision: {
            modePolicy: "cowork",
            workflowTemplate: "qa",
            hidden: false,
            visibility: "explicit",
            intensity: "balanced",
            providerPreference: "balanced",
            reviewDepth: "standard",
            parallelism: "sequential",
            selectedRoles: [],
            selectedProviders: [],
            triggerReason: "existing trace",
          },
          steps: [],
        },
        guidance: { workspaceId: "workspace-existing", globalFilesUsed: [], workspaceFilesUsed: [], truncated: false },
        loopGuard: { enabled: true, historySize: 1, events: [] },
        pendingUserInput: {
          promptId: "prompt-existing",
          turnId: "turn-a",
          kind: "text",
          title: "Input",
          question: "Continue?",
          required: false,
        },
        citations: [citation()],
        capabilityUpgradeSuggestions: [capabilitySuggestion()],
        specialistCandidateSuggestions: [specialistSuggestion()],
        failure: { failureClass: "tool_failed", message: "failed", retryable: true },
        finishedAt: "2026-03-26T00:00:05.000Z",
      }),
    );
    assert.ok(created.startedAt);

    const preserved = repo.patch("turn-a", {});
    assert.equal(preserved.parentTurnId, "parent-existing");
    assert.equal(preserved.sourceTurnId, "source-existing");
    assert.equal(preserved.assistantMessageId, "assistant-existing");
    assert.equal(preserved.executionPlanId, "plan-existing");
    assert.equal(preserved.status, "running");
    assert.equal(preserved.model, "gpt-existing");
    assert.equal(preserved.effectiveToolAutonomy, "safe_auto");
    assert.deepEqual(preserved.routing, { effectiveProviderId: "openai" });
    assert.equal(preserved.retrieval?.l0Used, true);
    assert.equal(preserved.reflection?.attempted, true);
    assert.equal(preserved.proactive?.runId, "proactive-existing");
    assert.equal(preserved.completion?.status, "complete");
    assert.equal(preserved.durable?.runId, "durable-existing");
    assert.equal(preserved.orchestration?.runId, "delegation-existing");
    assert.equal(preserved.guidance?.workspaceId, "workspace-existing");
    assert.equal(preserved.loopGuard?.enabled, true);
    assert.equal(preserved.pendingUserInput?.promptId, "prompt-existing");
    assert.equal(preserved.citations.length, 1);
    assert.equal(preserved.capabilityUpgradeSuggestions?.[0]?.candidateId, "candidate-a");
    assert.equal(preserved.specialistCandidateSuggestions?.[0]?.candidateId, "specialist-a");
    assert.equal(preserved.failure?.failureClass, "tool_failed");
    assert.equal(preserved.finishedAt, "2026-03-26T00:00:05.000Z");

    setRawField(db, "turn-a", "citations_json", "{}");
    setRawField(db, "turn-a", "capability_upgrade_suggestions_json", "{}");
    setRawField(db, "turn-a", "specialist_candidate_suggestions_json", "{}");
    const malformedArrays = repo.get("turn-a");
    assert.deepEqual(malformedArrays.citations, []);
    assert.equal(malformedArrays.capabilityUpgradeSuggestions, undefined);
    assert.equal(malformedArrays.specialistCandidateSuggestions, undefined);

    const internal = repo as unknown as {
      listBySessionStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listBySessionStmt = { all: () => ({ not: "an array" }) };
    assert.deepEqual(repo.listBySession("session-a"), []);
  });

  it("preserves nullish structured trace fields while clearing explicit nullable fields", () => {
    const { repo } = createStore();
    repo.create(
      baseTrace({
        parentTurnId: "parent-clear",
        sourceTurnId: "source-clear",
        assistantMessageId: "assistant-clear",
        executionPlanId: "plan-clear",
        status: "failed",
        model: "gpt-clear",
        routing: { effectiveProviderId: "openai" },
        effectiveToolAutonomy: "safe_auto",
        retrieval: { l0Used: true, l1Used: false, l2Used: false },
        reflection: { attempted: true, attemptCount: 1 },
        proactive: { runId: "proactive-clear" },
        completion: { status: "interrupted", repaired: false },
        durable: { runId: "durable-clear" },
        orchestration: {
          runId: "delegation-clear",
          objective: "Clear trace fields",
          workflowTemplate: "qa",
          status: "running",
          modePolicy: "cowork",
          visibility: "explicit",
          routeDecision: {
            modePolicy: "cowork",
            workflowTemplate: "qa",
            hidden: false,
            visibility: "explicit",
            intensity: "balanced",
            providerPreference: "balanced",
            reviewDepth: "standard",
            parallelism: "sequential",
            selectedRoles: [],
            selectedProviders: [],
            triggerReason: "coverage",
          },
          steps: [],
        },
        guidance: { workspaceId: "workspace-clear", globalFilesUsed: [], workspaceFilesUsed: [], truncated: false },
        loopGuard: { enabled: true, historySize: 1, events: [] },
        pendingUserInput: {
          promptId: "prompt-clear",
          turnId: "turn-a",
          kind: "text",
          title: "Input",
          question: "Continue?",
          required: false,
        },
        failure: { failureClass: "tool_failed", message: "failed", retryable: false },
        finishedAt: "2026-03-26T00:00:05.000Z",
      }),
    );

    const cleared = repo.patch("turn-a", {
      parentTurnId: null,
      sourceTurnId: null,
      assistantMessageId: null,
      executionPlanId: null,
      model: null,
      routing: null,
      retrieval: null,
      reflection: null,
      proactive: null,
      completion: null,
      durable: null,
      orchestration: null,
      guidance: null,
      loopGuard: null,
      pendingUserInput: null,
      failure: null,
      finishedAt: null,
    } as unknown as ChatTurnTracePatchInput);

    assert.equal(cleared.parentTurnId, undefined);
    assert.equal(cleared.sourceTurnId, undefined);
    assert.equal(cleared.assistantMessageId, undefined);
    assert.equal(cleared.executionPlanId, undefined);
    assert.equal(cleared.model, undefined);
    assert.deepEqual(cleared.routing, { effectiveProviderId: "openai" });
    assert.equal(cleared.retrieval?.l0Used, true);
    assert.equal(cleared.reflection?.attempted, true);
    assert.equal(cleared.proactive?.runId, "proactive-clear");
    assert.equal(cleared.completion?.status, "interrupted");
    assert.equal(cleared.durable?.runId, "durable-clear");
    assert.equal(cleared.orchestration?.runId, "delegation-clear");
    assert.equal(cleared.guidance?.workspaceId, "workspace-clear");
    assert.equal(cleared.loopGuard?.enabled, true);
    assert.equal(cleared.pendingUserInput, undefined);
    assert.equal(cleared.failure, undefined);
    assert.equal(cleared.finishedAt, undefined);
  });

  it("patches sparse traces through null/default structured-field branches", () => {
    const { repo } = createStore();
    repo.create(
      baseTrace({
        turnId: "turn-sparse",
        userMessageId: "message-sparse",
        startedAt: "2026-03-27T00:00:00.000Z",
      }),
    );

    const preserved = repo.patch("turn-sparse", {});
    assert.equal(preserved.assistantMessageId, undefined);
    assert.equal(preserved.executionPlanId, undefined);
    assert.equal(preserved.model, undefined);
    assert.deepEqual(preserved.retrieval, undefined);
    assert.deepEqual(preserved.reflection, undefined);
    assert.deepEqual(preserved.proactive, undefined);
    assert.deepEqual(preserved.completion, undefined);
    assert.deepEqual(preserved.durable, undefined);
    assert.deepEqual(preserved.orchestration, undefined);
    assert.deepEqual(preserved.guidance, undefined);
    assert.deepEqual(preserved.loopGuard, undefined);
    assert.deepEqual(preserved.citations, []);
    assert.equal(preserved.pendingUserInput, undefined);
    assert.equal(preserved.failure, undefined);
    assert.equal(preserved.finishedAt, undefined);

    const completed = repo.patch("turn-sparse", {
      status: "completed",
      citations: undefined,
      finishedAt: "2026-03-27T00:01:00.000Z",
    } as unknown as ChatTurnTracePatchInput);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.citations, []);
    assert.equal(completed.finishedAt, "2026-03-27T00:01:00.000Z");
  });
});
