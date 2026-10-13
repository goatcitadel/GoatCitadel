import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { seedLocalDelegationAuthority } from "../../test/fixtures/local-delegation.js";
import { assertLocalDelegationTurnAuthority } from "./chat-local-delegation-authority.js";
import {
  buildFanoutAdmissionReference,
  CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
} from "./chat-fanout-admission-reference.js";

it("admits only the exact automatic child under a real parent admission and current aggregate authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-automatic-child-"));
  const raw = new Storage({
    dbPath: path.join(root, "test.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const storage = createSqliteAsyncStorage(raw);
  let featureReferenceSha256 = "";
  try {
    const fixture = await seedLocalDelegationAuthority(storage, {
      parentSubagentPolicy: "auto_when_useful",
      childRole: "worker",
      prepareParent: async (admission) => {
        const references = {
          version: "chat.turn.feature-references.v1" as const,
          childWork: buildFanoutAdmissionReference(admission, {
            projectId: "project",
            workspaceId: "default",
            lifecycleStatus: "active",
            revision: 1,
          } as never),
        };
        const binding = await storage.sessionMutationAdmissions.bindFeatureReferences({
          ...admission.identity,
          requestRuntimeClaim: admission.requestClaim,
          references,
        });
        featureReferenceSha256 = binding.referenceSha256;
        return { featureReferenceSha256 };
      },
    });
    const parent = fixture.parentAdmission.identity;
    await storage.chatFanoutInvocations.createOrGet({
      invocationId: "automatic",
      parentRunId: "local-parent-run",
      toolRunId: "tool",
      delegationRunId: "local-delegation",
      sessionId: parent.sessionId,
      workspaceId: parent.workspaceId,
      projectId: "project",
      status: "dispatching",
      childCount: 1,
      subtasks: [{ objective: "One reviewed child" }],
      grantId: "grant",
      reservedActivations: 1,
      reservedBudgetUsd: 0.25,
      objective: "Parent",
      projectBindingHash: "a".repeat(64),
      grantBindingHash: "b".repeat(64),
      parentAdmission: {
        admissionId: parent.admissionId,
        sessionIncarnationId: parent.sessionIncarnationId,
        materialSha256: parent.materialSha256,
        featureReferenceSha256,
      },
      createdAt: new Date().toISOString(),
    });
    await storage.chatDelegationRuns.patch("local-delegation", {
      workflowTemplate: CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE,
      executionPlanId: "automatic",
    });
    const assertAutomaticFanoutAuthority = vi.fn(async () => undefined);
    await expect(
      assertLocalDelegationTurnAuthority(storage, fixture.input, { assertAutomaticFanoutAuthority }),
    ).resolves.toBeUndefined();
    expect(assertAutomaticFanoutAuthority).toHaveBeenCalledWith("automatic");
    const invocation = await storage.chatFanoutInvocations.get("automatic");
    const driftedStorage = new Proxy(storage, {
      get(target, property) {
        return property === "chatFanoutInvocations"
          ? {
              get: async () => ({
                ...invocation,
                subtasks: [{ ...invocation.subtasks[0]!, resultSchema: { type: "object" } }],
              }),
            }
          : Reflect.get(target, property);
      },
    });
    await expect(
      assertLocalDelegationTurnAuthority(driftedStorage, fixture.input, { assertAutomaticFanoutAuthority }),
    ).rejects.toThrow();
    await expect(assertLocalDelegationTurnAuthority(storage, fixture.input)).rejects.toThrow();
    assertAutomaticFanoutAuthority.mockRejectedValueOnce(new Error("grant revoked"));
    await expect(
      assertLocalDelegationTurnAuthority(storage, fixture.input, { assertAutomaticFanoutAuthority }),
    ).rejects.toThrow(/grant revoked/);
    expect(raw.chatTurnCapabilityProfiles.findByTurn(fixture.input.turnId)).toBeUndefined();
    expect(raw.durableRuns.listRuns()).toHaveLength(1);
  } finally {
    raw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
