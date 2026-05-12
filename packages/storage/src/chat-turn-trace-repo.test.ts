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
});
