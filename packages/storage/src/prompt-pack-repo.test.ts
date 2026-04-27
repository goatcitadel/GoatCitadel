import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { hashPromptPackPolicyV2 } from "./prompt-pack-policy.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";
import { DEFAULT_PROMPT_PACK_POLICY_V2, type PromptPackPolicyV2 } from "@goatcitadel/contracts";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): PromptPackRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-prompt-pack-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new PromptPackRepository(db);
}

describe("PromptPackRepository", () => {
  it("uses the current default policy for inherited_default packs on replacement", () => {
    const repo = createRepo();
    const legacyInheritedPolicy: PromptPackPolicyV2 = {
      ...DEFAULT_PROMPT_PACK_POLICY_V2,
      minScores: {
        ...DEFAULT_PROMPT_PACK_POLICY_V2.minScores,
        honesty: 3,
      },
    };

    repo.replacePackTests({
      packId: "pack-1",
      name: "Original Pack",
      tests: [
        {
          code: "TEST-01",
          title: "Original test",
          prompt: "Original prompt",
          orderIndex: 0,
          mode: "chat",
          toolTier: "implicit-tools",
          diagnosticMetadata: {
            capabilityTargets: ["routing", "truthfulness"],
            expectedRuntimeSignals: ["single assistant reply"],
            likelyFailureClasses: ["parser"],
          },
        },
      ],
      policyV2: legacyInheritedPolicy,
      policySource: "pack_override",
    });

    repo.replacePackTests({
      packId: "pack-1",
      name: "Updated Pack",
      tests: [
        {
          code: "TEST-02",
          title: "Updated test",
          prompt: "Updated prompt",
          orderIndex: 0,
          mode: "chat",
          toolTier: "implicit-tools",
        },
      ],
      policySource: "inherited_default",
    });

    const pack = repo.getPack("pack-1");
    const tests = repo.listTests("pack-1");
    assert.equal(pack.policySource, "inherited_default");
    assert.deepEqual(pack.policyV2, DEFAULT_PROMPT_PACK_POLICY_V2);
    assert.equal(pack.policyV2?.minScores.honesty, 2);
    assert.deepEqual(tests[0]?.diagnosticMetadata, undefined);
  });

  it("rolls back pack test replacement if an insert fails mid-stream", () => {
    const repo = createRepo();
    const original = repo.replacePackTests({
      packId: "pack-1",
      name: "Original Pack",
      tests: [
        {
          code: "TEST-01",
          title: "Original test",
          prompt: "Original prompt",
          orderIndex: 0,
          mode: "chat",
          toolTier: "implicit-tools",
        },
      ],
    });

    const originalInsert = (repo as unknown as { insertTestStmt: { run: (input: Record<string, unknown>) => unknown } })
      .insertTestStmt;
    let insertCount = 0;
    const originalRun = originalInsert.run.bind(originalInsert);
    originalInsert.run = (input: Record<string, unknown>) => {
      insertCount += 1;
      if (insertCount === 2) {
        throw new Error("simulated insert failure");
      }
      return originalRun(input);
    };

    assert.throws(
      () =>
        repo.replacePackTests({
          packId: "pack-1",
          name: "Updated Pack",
          tests: [
            {
              code: "TEST-02",
              title: "Replacement one",
              prompt: "Replacement prompt one",
              orderIndex: 0,
              mode: "chat",
              toolTier: "implicit-tools",
            },
            {
              code: "TEST-03",
              title: "Replacement two",
              prompt: "Replacement prompt two",
              orderIndex: 1,
              mode: "code",
              toolTier: "explicit-tools",
            },
          ],
        }),
      /simulated insert failure/,
    );

    const pack = repo.getPack("pack-1");
    const tests = repo.listTests("pack-1");
    assert.equal(pack.name, original.pack.name);
    assert.equal(pack.testCount, 1);
    assert.deepEqual(
      tests.map((test) => test.code),
      ["TEST-01"],
    );
  });

  it("returns the current default hash for inherited-default legacy rows with stale snapshots", () => {
    const repo = createRepo();
    const policyHash = "historic-policy-hash";
    const now = "2026-04-16T00:00:00.000Z";
    const upsertPackStmt = (
      repo as unknown as {
        upsertPackStmt: { run: (input: Record<string, unknown>) => unknown };
      }
    ).upsertPackStmt;
    const insertTestStmt = (
      repo as unknown as {
        insertTestStmt: { run: (input: Record<string, unknown>) => unknown };
      }
    ).insertTestStmt;

    upsertPackStmt.run({
      packId: "pack-historic",
      name: "Historic Pack",
      sourceLabel: "legacy",
      testCount: 1,
      policyV2Json: JSON.stringify({
        ...DEFAULT_PROMPT_PACK_POLICY_V2,
        minScores: {
          ...DEFAULT_PROMPT_PACK_POLICY_V2.minScores,
          honesty: 3,
        },
      }),
      policyV2Hash: policyHash,
      policyV2Source: "inherited_default",
      createdAt: now,
      updatedAt: now,
    });
    insertTestStmt.run({
      testId: "ppt-historic-1",
      packId: "pack-historic",
      code: "TEST-01",
      title: "Historic test",
      prompt: "Historic prompt",
      orderIndex: 0,
      mode: "chat",
      toolTier: "implicit-tools",
      diagnosticMetadataJson: null,
      createdAt: now,
    });

    const pack = repo.getPack("pack-historic");

    assert.equal(pack.policySource, "inherited_default");
    assert.deepEqual(pack.policyV2, DEFAULT_PROMPT_PACK_POLICY_V2);
    assert.notEqual(pack.policyHash, policyHash);
    assert.equal(pack.policyHash, hashPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2));
  });

  it("returns the current default hash when an inherited-default row has a blank stored hash", () => {
    const repo = createRepo();
    const now = "2026-04-16T00:00:00.000Z";
    const historicPolicy: PromptPackPolicyV2 = {
      ...DEFAULT_PROMPT_PACK_POLICY_V2,
      minScores: {
        ...DEFAULT_PROMPT_PACK_POLICY_V2.minScores,
        honesty: 3,
      },
    };
    const upsertPackStmt = (
      repo as unknown as {
        upsertPackStmt: { run: (input: Record<string, unknown>) => unknown };
      }
    ).upsertPackStmt;
    const insertTestStmt = (
      repo as unknown as {
        insertTestStmt: { run: (input: Record<string, unknown>) => unknown };
      }
    ).insertTestStmt;

    upsertPackStmt.run({
      packId: "pack-no-hash",
      name: "No Hash Pack",
      sourceLabel: null,
      testCount: 1,
      policyV2Json: JSON.stringify(historicPolicy),
      policyV2Hash: "   ",
      policyV2Source: "inherited_default",
      createdAt: now,
      updatedAt: now,
    });
    insertTestStmt.run({
      testId: "ppt-no-hash-1",
      packId: "pack-no-hash",
      code: "TEST-02",
      title: "No hash test",
      prompt: "Prompt",
      orderIndex: 0,
      mode: "chat",
      toolTier: "implicit-tools",
      diagnosticMetadataJson: null,
      createdAt: now,
    });

    const pack = repo.getPack("pack-no-hash");

    assert.deepEqual(pack.policyV2, DEFAULT_PROMPT_PACK_POLICY_V2);
    assert.equal(pack.policyHash, hashPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2));
  });

  it("produces the same hash for semantically identical policies with different key insertion order", () => {
    const left: PromptPackPolicyV2 = {
      scoringSchemaVersion: "v2",
      threshold: DEFAULT_PROMPT_PACK_POLICY_V2.threshold,
      weights: {
        taskSuccess: 4,
        honesty: 2,
        executionQuality: 3,
        robustness: 1,
        usability: 5,
      },
      minScores: {
        honesty: 2,
        taskSuccess: 3,
      },
      judgeRequired: true,
      reviewOnDisagreementAt: 2,
      criticalDimensionsMustBeApplicable: true,
      hardFailSignals: ["run_failed", "tool_tier_violation"],
    };
    const right: PromptPackPolicyV2 = {
      scoringSchemaVersion: "v2",
      threshold: DEFAULT_PROMPT_PACK_POLICY_V2.threshold,
      weights: {
        usability: 5,
        robustness: 1,
        executionQuality: 3,
        honesty: 2,
        taskSuccess: 4,
      },
      minScores: {
        taskSuccess: 3,
        honesty: 2,
      },
      judgeRequired: true,
      reviewOnDisagreementAt: 2,
      criticalDimensionsMustBeApplicable: true,
      hardFailSignals: ["run_failed", "tool_tier_violation"],
    };

    assert.equal(hashPromptPackPolicyV2(left), hashPromptPackPolicyV2(right));
  });

  it("round-trips prompt-pack diagnostic metadata on tests", () => {
    const repo = createRepo();

    repo.replacePackTests({
      packId: "pack-diagnostics",
      name: "Diagnostics Pack",
      tests: [
        {
          code: "TEST-01",
          title: "Diagnostic test",
          prompt: "Prompt body",
          orderIndex: 0,
          mode: "cowork",
          toolTier: "explicit-tools",
          diagnosticMetadata: {
            capabilityTargets: ["routing", "approval"],
            expectedRuntimeSignals: ["role ordered handoff", "approval checkpoint"],
            likelyFailureClasses: ["routing", "tool-policy"],
          },
        },
      ],
    });

    const [test] = repo.listTests("pack-diagnostics");
    assert.deepEqual(test?.diagnosticMetadata, {
      capabilityTargets: ["routing", "approval"],
      expectedRuntimeSignals: ["role ordered handoff", "approval checkpoint"],
      likelyFailureClasses: ["routing", "tool-policy"],
    });
  });
});
