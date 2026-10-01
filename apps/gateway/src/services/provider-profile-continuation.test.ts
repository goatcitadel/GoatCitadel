import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangePlanRecord, LlmProviderConfig } from "@goatcitadel/contracts";
import { ChangePlanRepository, createDatabase, createChangePlanSchema } from "@goatcitadel/storage";
import {
  EvolutionControlPlaneService,
  type EvolutionControlPlaneRepositoryPort,
} from "./evolution-control-plane-service.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { ProviderConnectionChangePlanAdapter } from "./provider-connection-change-plan-adapter.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);
const actor = { workspaceId: "default", actorId: "operator", surface: "settings" as const };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-provider-checkpoint-"));
  const db = createDatabase({ dbPath: path.join(directory, "test.db") });
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  createChangePlanSchema(db);
  const repo = new ChangePlanRepository(db);
  const repository: EvolutionControlPlaneRepositoryPort = {
    create: async (input) => repo.create(input),
    get: async (id) => repo.get(id),
    list: async (input) => repo.list(input),
    listActive: async (limit) => repo.listActive(limit),
    transition: async (id, input) => repo.transition(id, input),
  };
  let config: LlmProviderConfig | undefined;
  let revision = 7,
    temporary = false,
    promoted = false,
    promotionResponseLost = false;
  const getSettings = vi.fn(
    async () =>
      ({ revision, llm: { providers: config ? [{ ...config, hasApiKey: promoted }] : [] } }) as RuntimeSettings,
  );
  const updateSettings = vi.fn(async (input) => {
    expect(input.expectedRevision).toBe(revision);
    config = input.llm.upsertProvider;
    revision += 1;
    return getSettings();
  });
  const promoteTemporarySecret = vi.fn(
    async (_planId: string, _providerId: string, expected: number, storage?: string, envVar?: string) => {
      expect(expected).toBe(revision);
      expect(storage).toBe("env");
      expect(envVar).toBe("FIXTURE_KEY");
      promoted = true;
      revision += 1;
      if (promotionResponseLost) throw new Error("Credential owner committed but its response was lost");
      return { revision, evidenceRefs: ["fixture:credential-owner:committed"] };
    },
  );
  const adapter = new ProviderConnectionChangePlanAdapter({
    getSettings,
    getProviderConfig: () => config,
    updateSettings,
    hasTemporarySecret: () => temporary,
    promoteTemporarySecret,
    removeProviderApiKey: vi.fn(),
    getProviderApiKeyStatus: () => ({ hasSecret: promoted, source: promoted ? "env" : "none" }),
    discardTemporarySecret: vi.fn(),
    verifyProvider: vi.fn(async () => ({ evidenceRefs: ["fixture:live-catalog"] })),
  });
  const service = new EvolutionControlPlaneService({
    repository,
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
  });
  const request = {
    kind: "provider_connection" as const,
    providerId: "fixture",
    credentialStorage: "env" as const,
    credentialEnvVar: "FIXTURE_KEY",
    profile: {
      label: "Fixture",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiStyle: "openai-chat-completions" as const,
      authMode: "api-key" as const,
      defaultModel: "fixture-model",
      apiKeyEnv: "FIXTURE_KEY",
    },
  };
  const confirm = (plan: ChangePlanRecord) =>
    service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
  const stage = (plan: ChangePlanRecord) => {
    temporary = true;
    return service.resumeOwnerInput(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
      actionKind: "secure_input",
      actionId: plan.requiredAction!.actionId,
      ownerId: "provider_temporary_secret",
      ownerResourceId: "fixture",
      evidenceRefs: ["fixture:temporary-owner"],
    });
  };
  return {
    repo,
    service,
    request,
    confirm,
    stage,
    updateSettings,
    promoteTemporarySecret,
    drift: () => {
      config = { ...config!, label: "Other" };
    },
    remoteRevision: () => {
      revision += 1;
    },
    losePromotionResponse: () => { promotionResponseLost = true; },
  };
}

describe("provider profile checkpoint through the real control plane and SQLite ledger", () => {
  it("retains committed profile truth and manual uncertainty after a credential promotion response is lost", async () => {
    const f = fixture();
    const initial = await f.service.create({ actor, request: f.request });
    const waiting = await f.confirm(initial);
    const staged = await f.stage(waiting);
    f.losePromotionResponse();
    const uncertain = await f.confirm(staged);
    expect(uncertain.status).toBe("manual_required");
    expect(uncertain.result?.providerProfileCheckpoint).toEqual(waiting.result?.providerProfileCheckpoint);
    expect(uncertain.requiredAction).toBeUndefined();
    await expect(f.service.confirm(actor, uncertain.planId, uncertain.revision, staged.requiredAction!.actionNonce)).rejects.toThrow();
    expect(f.updateSettings).toHaveBeenCalledOnce(); expect(f.promoteTemporarySecret).toHaveBeenCalledOnce();
  });
  it("commits once, resumes the same plan through secure input and confirmation, and retains exact checkpoint evidence", async () => {
    const f = fixture();
    const initial = await f.service.create({ actor, request: f.request });
    expect(f.updateSettings).not.toHaveBeenCalled();
    const waiting = await f.confirm(initial);
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.requiredAction?.kind).toBe("secure_input");
    expect(waiting.target.expectedRevision).toBe(8);
    expect(waiting.result?.providerProfileCheckpoint).toEqual({
      version: "provider_profile_checkpoint.v1",
      providerId: "fixture",
      originalRevision: 7,
      appliedRevision: 8,
      intentHash: initial.intentHash,
    });
    expect(f.promoteTemporarySecret).not.toHaveBeenCalled();
    await expect(f.service.get({ ...actor, workspaceId: "foreign" }, waiting.planId)).rejects.toThrow();
    await expect(f.confirm(initial)).rejects.toThrow();
    const staged = await f.stage(waiting);
    expect(staged.status).toBe("awaiting_confirmation");
    expect(staged.result?.providerProfileCheckpoint).toEqual(waiting.result?.providerProfileCheckpoint);
    const completed = await f.confirm(staged);
    expect(completed.status).toBe("completed");
    expect(completed.planId).toBe(initial.planId);
    expect(completed.result?.providerProfileCheckpoint).toEqual(waiting.result?.providerProfileCheckpoint);
    expect(completed.result?.appliedRevision).toBe(9);
    expect(f.updateSettings).toHaveBeenCalledOnce();
    expect(f.promoteTemporarySecret).toHaveBeenCalledOnce();
    expect(f.repo.listEvents(initial.planId).map((event) => event.toStatus)).toContain("awaiting_input");
  });
  it.each(["profile", "revision"] as const)(
    "rejects %s drift before credential promotion without replaying the profile",
    async (kind) => {
      const f = fixture();
      const initial = await f.service.create({ actor, request: f.request });
      const waiting = await f.confirm(initial);
      const staged = await f.stage(waiting);
      if (kind === "profile") f.drift();
      else f.remoteRevision();
      const blocked = await f.confirm(staged);
      expect(blocked.status).toBe("manual_required");
      expect(blocked.result?.providerProfileCheckpoint).toEqual(waiting.result?.providerProfileCheckpoint);
      expect(f.promoteTemporarySecret).not.toHaveBeenCalled();
      expect(f.updateSettings).toHaveBeenCalledOnce();
    },
  );
  it("does not allow generic or unbound applying-to-input transitions or checkpoint rewriting", async () => {
    const f = fixture();
    const initial = await f.service.create({ actor, request: f.request });
    const applying = f.repo.transition(initial.planId, {
      expectedRevision: initial.revision,
      status: "applying",
      actionNonce: initial.requiredAction!.actionNonce,
      requiredAction: null,
    });
    const checkpoint = {
      version: "provider_profile_checkpoint.v1" as const,
      providerId: "fixture",
      originalRevision: 7,
      appliedRevision: 8,
      intentHash: initial.intentHash,
    };
    const valid = {
      expectedRevision: applying.revision,
      internal: true,
      status: "awaiting_input" as const,
      target: { ...initial.target, expectedRevision: 8 },
      result: {
        summary: "Profile committed; credential pending",
        appliedRevision: 8,
        providerProfileCheckpoint: checkpoint,
      },
      evidenceRefs: ["provider_profile:fixture:settings_revision:8"],
      requiredAction: {
        kind: "secure_input" as const,
        actionId: "secure",
        actionNonce: "nonce-secure",
        title: "Credential",
        targetId: "fixture",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    for (const invalid of [
      { ...valid, internal: false },
      { ...valid, result: { summary: "No checkpoint" } },
      { ...valid, evidenceRefs: [] },
      {
        ...valid,
        result: { ...valid.result, providerProfileCheckpoint: { ...checkpoint, intentHash: "f".repeat(64) } },
      },
      { ...valid, requiredAction: { ...valid.requiredAction, targetId: "foreign" } },
      { ...valid, target: { ...valid.target, expectedRevision: 9 } },
    ]) {
      expect(() => f.repo.transition(initial.planId, invalid)).toThrow();
      expect(f.repo.get(initial.planId).revision).toBe(applying.revision);
    }
    const waiting = f.repo.transition(initial.planId, valid);
    expect(() =>
      f.repo.transition(initial.planId, {
        expectedRevision: waiting.revision,
        internal: true,
        status: "cancelled",
        result: { summary: "Altered", providerProfileCheckpoint: { ...checkpoint, originalRevision: 6 } },
      }),
    ).toThrow();
    const cancelled = f.repo.transition(initial.planId, {
      expectedRevision: waiting.revision,
      internal: true,
      status: "cancelled",
      result: { summary: "Cancelled remainder" },
    });
    expect(cancelled.result?.providerProfileCheckpoint).toEqual(checkpoint);
  });
});
