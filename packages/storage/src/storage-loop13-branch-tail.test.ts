import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  AdversarialSettings,
  AssemblyArtifactRecord,
  AssemblyProblem,
  AssemblyRunRecord,
  AssemblySettings,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { AssemblyRepository } from "./assembly-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RealtimeEventRepository } from "./realtime-event-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createDb(prefix: string): DatabaseClient {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createDatabase({ dbPath });
}

function buildProblem(runId: string): AssemblyProblem {
  return {
    runId,
    domain: "coding",
    title: "Loop 13 tail probe",
    originalPrompt: "Exercise fallback assembly branches.",
    normalizedStatement: "Exercise fallback assembly branches.",
    objectives: [],
    constraints: [],
    evaluationCriteria: [],
    contextRefs: [],
    createdAt: "2026-05-14T00:00:00.000Z",
  };
}

function buildSettings(): AssemblySettings {
  return {
    mode: "consensus",
    participantModels: [],
    maxRounds: 1,
    maxCritiquePasses: 0,
    maxInterModelExchanges: 0,
    convergenceThreshold: 0.5,
    stagnationWindow: 1,
    timeBudgetMs: 1000,
    tokenBudget: 1000,
    costBudgetUsd: 1,
    domainPreset: "coding",
    synthesisStyle: "balanced",
    exportTargets: [],
  };
}

function buildAdversarialSettings(): AdversarialSettings {
  return {
    enabled: false,
    reviewerCount: 0,
    selectionStrategy: "user_selected",
    strictness: "balanced",
    requireMitigations: false,
    requireEvidenceTags: false,
    defenseRoundEnabled: false,
    repetitiveObjectionCutoff: false,
    minorityReportRequired: false,
  };
}

function buildRun(runId: string): AssemblyRunRecord {
  return {
    runId,
    title: "Loop 13 assembly run",
    status: "queued",
    currentStage: "S0_normalize",
    currentRoundIndex: 0,
    problem: buildProblem(runId),
    settings: buildSettings(),
    adversarialSettings: buildAdversarialSettings(),
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}

describe("storage loop13 branch tails", () => {
  it("covers assembly optional timestamps, invalid optional objects, and artifact fallback payloads", () => {
    const db = createDb("goatcitadel-storage-loop13-assembly");
    const repo = new AssemblyRepository(db);
    const runId = "assembly-loop13";
    repo.createRun(buildRun(runId));

    repo.saveRound({
      roundId: "round-loop13",
      runId,
      roundIndex: 1,
      stage: "S1_submit",
      status: "running",
      participantIds: [],
      artifactIds: [],
      convergenceSnapshot: [] as never,
      stopCheck: [] as never,
      startedAt: "2026-05-14T00:01:00.000Z",
    });
    repo.completeRound("round-loop13", { status: "completed" });

    const [round] = repo.listRounds(runId);
    assert.equal(round?.convergenceSnapshot, undefined);
    assert.equal(round?.stopCheck, undefined);
    assert.match(round?.finishedAt ?? "", /^20/);

    const artifacts: AssemblyArtifactRecord[] = [
      {
        artifactId: "proposal-fallback",
        runId,
        roundIndex: 1,
        stage: "S1_submit",
        artifactType: "proposal",
        payload: "not-an-object" as never,
        createdAt: "2026-05-14T00:02:00.000Z",
      },
      {
        artifactId: "peer-fallback",
        runId,
        roundIndex: 1,
        stage: "S2_blind_review",
        artifactType: "peer_review",
        payload: "not-an-object" as never,
        createdAt: "2026-05-14T00:03:00.000Z",
      },
      {
        artifactId: "adversarial-fallback",
        runId,
        roundIndex: 1,
        stage: "A3_adversarial_challenge",
        artifactType: "adversarial_review",
        payload: "not-an-object" as never,
        createdAt: "2026-05-14T00:04:00.000Z",
      },
      {
        artifactId: "defense-fallback",
        runId,
        roundIndex: 1,
        stage: "S4_convergence",
        artifactType: "defense_response",
        payload: "not-an-object" as never,
        createdAt: "2026-05-14T00:05:00.000Z",
      },
    ];

    repo.saveArtifacts(artifacts);

    const proposalPayload = repo.listArtifacts(runId, "proposal")[0]?.payload as unknown as Record<string, unknown>;
    assert.equal(proposalPayload.authorModelRef, "");
    assert.equal(proposalPayload.blindedAuthorToken, "");

    const payloads = repo
      .listArtifacts(runId)
      .map((artifact) => artifact.payload as unknown as Record<string, unknown>);
    assert.equal(
      payloads.some((payload) => payload.blindedReviewerToken === ""),
      true,
    );
    assert.equal(
      payloads.some((payload) => payload.usefulnessPending === true),
      true,
    );
    assert.equal(
      payloads.some((payload) => Array.isArray(payload.unresolvedDisputes)),
      true,
    );

    db.close?.();
  });

  it("covers durable claim and lease defaults without mutating terminal fields", () => {
    const db = createDb("goatcitadel-storage-loop13-durable");
    const repo = new DurableRunRepository(db);

    repo.createRun({
      runId: "durable-loop13",
      workflowKey: "loop13.default-lease",
      payload: { kind: "loop13" },
      metadata: undefined,
    });

    const claimed = repo.tryClaimQueuedRun({
      runId: "durable-loop13",
      workerId: "worker-1",
      leaseHeartbeatAt: "2026-05-14T00:10:00.000Z",
      leaseExpiresAt: "2026-05-14T00:15:00.000Z",
    });

    assert.equal(claimed?.startedAt, "2026-05-14T00:10:00.000Z");
    assert.equal(claimed?.finishedAt, undefined);
    assert.equal(claimed?.lastError, undefined);
    assert.equal(claimed?.leaseOwnerId, "worker-1");
    assert.equal(
      repo.tryClaimQueuedRun({
        runId: "durable-loop13",
        workerId: "worker-2",
        leaseHeartbeatAt: "2026-05-14T00:11:00.000Z",
        leaseExpiresAt: "2026-05-14T00:16:00.000Z",
      }),
      undefined,
    );
    assert.equal(
      repo.renewLease({
        runId: "durable-loop13",
        workerId: "other-worker",
        leaseHeartbeatAt: "2026-05-14T00:12:00.000Z",
        leaseExpiresAt: "2026-05-14T00:17:00.000Z",
      }),
      undefined,
    );

    db.close?.();
  });

  it("covers realtime empty bounds, inferred metadata, invalid envelopes, and prune no-op counts", () => {
    const db = createDb("goatcitadel-storage-loop13-events");
    const repo = new RealtimeEventRepository(db);

    assert.deepEqual(repo.getSequenceBounds(), { oldestSequence: undefined, newestSequence: undefined });
    assert.equal(repo.pruneOlderThan("2026-05-01T00:00:00.000Z"), 0);
    assert.equal(repo.pruneToMaxRows(10), 0);

    const inferred = repo.append(
      "memory_summary_projection",
      "memory",
      {
        workspace: { workspaceId: "workspace-1" },
        traceId: "trace-1",
        originSurface: "cowork",
      },
      { links: { runId: "run-1", blank: "   " } as unknown as Record<string, string> },
      "2026-05-14T00:20:00.000Z",
    );

    assert.equal(inferred.eventClass, "operational_signal");
    assert.equal(inferred.eventAuthority, "derived_projection");
    assert.equal(inferred.links?.runId, "run-1");
    assert.equal(inferred.links?.workspaceId, "workspace-1");

    db.prepare("UPDATE realtime_events SET payload_json = ? WHERE event_id = ?").run(
      '"not-an-object"',
      inferred.eventId,
    );
    const [stored] = repo.list(1);
    assert.equal(stored?.eventClass, undefined);
    assert.deepEqual(stored?.payload, {});

    db.close?.();
  });
});
