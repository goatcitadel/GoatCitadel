import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChatSpecialistCandidateRepository } from "./chat-specialist-candidate-repo.js";
import { createDatabase } from "./sqlite.js";

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

function createRepoWithDb(): { repo: ChatSpecialistCandidateRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-specialist-candidate-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new ChatSpecialistCandidateRepository(db),
    db,
  };
}

describe("ChatSpecialistCandidateRepository", () => {
  it("creates, patches, lists, and filters specialist candidates", () => {
    const { repo, db } = createRepoWithDb();

    assert.equal(repo.find("missing-candidate"), undefined);
    assert.throws(() => repo.get("missing-candidate"), /Specialist candidate/);
    assert.throws(
      () => repo.listBySession("  "),
      (error: unknown) => error instanceof Error && /required/.test(error.message),
    );
    assert.throws(
      () =>
        repo.create("session-1", {
          title: " ",
          role: "QA",
          summary: "Summary",
          reason: "Reason",
          source: "manual",
          confidence: 0.5,
          routingHints: { preferredModes: ["cowork"] },
          evidence: [],
        }),
      (error: unknown) => error instanceof Error && /required/.test(error.message),
    );

    const active = repo.create(
      " session-1 ",
      {
        workspaceId: " workspace-1 ",
        leadTurnId: " turn-1 ",
        leadRunId: " run-1 ",
        title: " Research QA ",
        role: " QA specialist ",
        summary: " Checks research claims ",
        reason: " Repeated citation misses ",
        source: "runtime_gap",
        status: "active",
        routingMode: "strong_match_only",
        confidence: 1.4,
        suggestedTools: [" web.search ", "web.search", "", " file.read "],
        suggestedSkills: [" source-check ", "source-check", " "],
        routingHints: {
          preferredModes: ["cowork", "code"],
          objectiveKeywords: ["citations"],
          requiresProjectBinding: true,
          maxInvocationsPerRun: 2,
        },
        evidence: [
          {
            evidenceId: "evidence-1",
            kind: "tool_gap",
            summary: "Missed a citation check.",
            turnId: "turn-1",
            runId: "run-1",
            toolName: "web.search",
            confidence: 0.8,
          },
        ],
      },
      "2026-03-22T10:00:00.000Z",
    );

    assert.match(active.candidateId, /^[0-9a-f-]{36}$/);
    assert.equal(active.workspaceId, "workspace-1");
    assert.equal(active.sessionId, "session-1");
    assert.equal(active.leadTurnId, "turn-1");
    assert.equal(active.leadRunId, "run-1");
    assert.equal(active.title, "Research QA");
    assert.equal(active.role, "QA specialist");
    assert.equal(active.summary, "Checks research claims");
    assert.equal(active.reason, "Repeated citation misses");
    assert.equal(active.confidence, 1);
    assert.equal(active.requiresApproval, true);
    assert.deepEqual(active.suggestedTools, ["web.search", "file.read"]);
    assert.deepEqual(active.suggestedSkills, ["source-check"]);
    assert.equal(active.activatedAt, "2026-03-22T10:00:00.000Z");
    assert.equal(active.retiredAt, undefined);

    const disabled = repo.create(
      "session-1",
      {
        title: "Local debugger",
        role: "Debugger",
        summary: "Debug local runtime failures.",
        reason: "Repeated tool failures.",
        source: "manual",
        confidence: Number.NaN,
        requiresApproval: false,
        routingHints: { preferredModes: ["code"] },
        evidence: [],
      },
      "2026-03-22T10:05:00.000Z",
    );
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.routingMode, "manual_only");
    assert.equal(disabled.confidence, 0);
    assert.equal(disabled.requiresApproval, false);
    assert.equal(disabled.suggestedTools, undefined);
    assert.equal(disabled.suggestedSkills, undefined);

    assert.deepEqual(
      repo.listBySession("session-1", 0).map((candidate) => candidate.candidateId),
      [disabled.candidateId],
    );
    assert.deepEqual(
      repo.listBySession("session-1", 5000).map((candidate) => candidate.candidateId),
      [disabled.candidateId, active.candidateId],
    );
    assert.deepEqual(repo.listAutoRoutable("session-1", "cowork", false), []);
    assert.deepEqual(
      repo.listAutoRoutable("session-1", "cowork", true).map((candidate) => candidate.candidateId),
      [active.candidateId],
    );
    assert.deepEqual(repo.listAutoRoutable("session-1", "chat", true), []);

    assert.throws(
      () => repo.patch(active.candidateId, { reason: " " }, "2026-03-22T10:10:00.000Z"),
      (error: unknown) => error instanceof Error && /required/.test(error.message),
    );

    const retired = repo.patch(
      active.candidateId,
      {
        status: "retired",
        title: "Retired research QA",
        summary: "No longer needed.",
        reason: "Catalog replacement exists.",
        confidence: -1,
        suggestedTools: [],
        suggestedSkills: [],
        routingHints: { preferredModes: ["cowork"] },
        evidence: [],
      },
      "2026-03-22T10:15:00.000Z",
    );
    assert.equal(retired.status, "retired");
    assert.equal(retired.confidence, 0);
    assert.equal(retired.activatedAt, undefined);
    assert.equal(retired.retiredAt, "2026-03-22T10:15:00.000Z");
    assert.deepEqual(retired.suggestedTools, undefined);
    assert.deepEqual(retired.evidence, []);

    const reactivated = repo.patch(
      retired.candidateId,
      {
        status: "active",
        routingMode: "strong_match_only",
        confidence: 0.75,
      },
      "2026-03-22T10:20:00.000Z",
    );
    assert.equal(reactivated.status, "active");
    assert.equal(reactivated.activatedAt, "2026-03-22T10:20:00.000Z");
    assert.equal(reactivated.retiredAt, undefined);

    db.prepare(
      `
      INSERT INTO chat_specialist_candidates (
        candidate_id,
        workspace_id,
        session_id,
        lead_turn_id,
        lead_run_id,
        title,
        role,
        summary,
        reason,
        source,
        status,
        routing_mode,
        confidence,
        requires_approval,
        suggested_tools_json,
        suggested_skills_json,
        routing_hints_json,
        evidence_json,
        created_at,
        updated_at,
        activated_at,
        retired_at
      ) VALUES (
        'candidate-legacy',
        NULL,
        'session-legacy',
        NULL,
        NULL,
        'Legacy',
        'Legacy role',
        'Legacy summary',
        'Legacy reason',
        'catalog',
        'approved',
        'manual_only',
        0.5,
        1,
        '[" ", "tool.one", "tool.two"]',
        'not-json',
        'not-json',
        'not-json',
        '2026-03-22T09:00:00.000Z',
        '2026-03-22T09:00:00.000Z',
        NULL,
        NULL
      )
    `,
    ).run();

    const legacy = repo.get("candidate-legacy");
    assert.equal(legacy.workspaceId, undefined);
    assert.equal(legacy.leadTurnId, undefined);
    assert.deepEqual(legacy.suggestedTools, ["tool.one", "tool.two"]);
    assert.equal(legacy.suggestedSkills, undefined);
    assert.deepEqual(legacy.routingHints, { preferredModes: ["cowork", "code"] });
    assert.deepEqual(legacy.evidence, []);
  });
});
