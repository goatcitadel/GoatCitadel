import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  buildCronCreatorAuthority,
  SCHEDULED_RESTRICTED_PROFILE,
  type CronRunRecord,
  type PermissionProfileRecord,
} from "@goatcitadel/contracts";
import {
  assertScheduledChatDispatchCurrent,
  assertScheduledOccurrenceCurrent,
  buildCronChatAdmissionIdentity,
  buildScheduledOccurrenceReference,
  type ScheduledChatAuthorityHost,
} from "./scheduled-chat-authority.js";
import { buildAutonomousTurnContext } from "./gateway/autonomous-turn-policy.js";
import { buildScheduledCreatorIntersectionProfile } from "./gateway/scheduled-profile-intersection.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { resolveChatFeatureAdmission, type ChatFeatureAdmissionHost } from "./chat-feature-admission-service.js";
import { runCronAgentTurn, type ChatAutonomousTurnDeps } from "./chat-autonomous-turn-service.js";
import { normalizeAgentTurnCronActionConfig } from "./gateway/cron-agent-turn-support.js";

const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
function fixture() {
  const run = {
    runId: "occurrence",
    jobId: "job",
    executionGeneration: 3,
    action: "agent_turn",
    status: "admitting",
    createdAt: "2026-10-11T12:00:00Z",
    actionSnapshot: {
      action: "agent_turn",
      actionConfig: {
        agentTurn: {
          prompt: "Read the approved fixture",
          sessionId: "session",
          createdBy: { operatorId: "creator", permissionProfileId: "creator-profile" },
        },
      },
    },
  } as CronRunRecord;
  const identity = buildCronChatAdmissionIdentity(run);
  const reference = buildScheduledOccurrenceReference(identity);
  const job = {
    jobId: "job",
    activeRunId: run.runId,
    executionGeneration: 3,
    creatorAuthority: buildCronCreatorAuthority(
      { jobId: "job", action: "agent_turn", actionConfig: run.actionSnapshot.actionConfig as never },
      { actorId: "creator", source: "authenticated_operator" },
    ),
  };
  const creator: PermissionProfileRecord = {
    ...SCHEDULED_RESTRICTED_PROFILE,
    profileId: "creator-profile",
    scope: "workspace",
    scopeRef: "workspace",
    toolPatterns: ["fs.*"],
  };
  const policyContext = buildAutonomousTurnContext({
    kind: "scheduled",
    systemActorId: "system:cron:job",
    runId: run.runId,
    sessionId: "session",
  }).policyContext;
  const intersection = buildScheduledCreatorIntersectionProfile({
    creatorProfile: creator,
    runId: run.runId,
    knownToolNames: ["fs.read"],
    now: run.createdAt,
  });
  Object.assign(policyContext, {
    permissionProfileId: intersection.profileId,
    permissionProfile: intersection,
    workspaceId: "workspace",
  });
  const request = {
    content: "Read the approved fixture",
    permissionProfileId: SCHEDULED_RESTRICTED_PROFILE.profileId,
    policyContext,
  };
  const admission = {
    identity: {
      admissionId: "admission",
      sessionId: "session",
      turnId: identity.turnId,
      sessionIncarnationId: "incarnation",
      workspaceId: "workspace",
      aggregateRevision: 1,
      controllerGeneration: 1,
      materialSha256: hash({ version: 2, request }),
    },
    requestActor: { actorKind: "system", actorId: "system:cron:job" },
    admittedRequest: request,
  } as ActiveTurnAdmission;
  const storage = {
    cronRuns: { get: vi.fn(async () => run) },
    cronJobs: { get: vi.fn(async () => job) },
    permissionProfiles: { getProfile: vi.fn(async () => creator) },
  };
  const isFeatureEnabled = vi.fn(async (flag: string) => flag === "scheduledChatTurnsV1Enabled");
  const host = { storage, listToolNames: () => ["fs.read"], isFeatureEnabled } as unknown as ScheduledChatAuthorityHost;
  return { host, storage, run, job, creator, reference, identity, admission, request, isFeatureEnabled };
}

describe("current scheduled Chat authority", () => {
  it("keeps unproven historical creator fields Inbox-only without creating a session or model turn", async () => {
    const f = fixture();
    delete (f.job as { creatorAuthority?: unknown }).creatorAuthority;
    const createCronInboxTask = vi.fn(async () => ({ taskId: "inbox" }));
    const createChatSession = vi.fn();
    const prepareAgentChatTurn = vi.fn();
    const config = normalizeAgentTurnCronActionConfig(
      f.run.actionSnapshot.actionConfig as Record<string, unknown>,
    )!.agentTurn!;
    const deps = {
      ...f.host,
      createCronInboxTask,
      createChatSession,
      prepareAgentChatTurn,
    } as unknown as ChatAutonomousTurnDeps;
    await expect(
      runCronAgentTurn(deps, {
        job: { ...f.job, action: "agent_turn" } as never,
        runId: f.run.runId,
        config,
        cronRun: f.run,
      }),
    ).resolves.toMatchObject({ mode: "inbox", taskId: "inbox", profilePosture: "creator_profile_missing" });
    expect(createChatSession).not.toHaveBeenCalled();
    expect(prepareAgentChatTurn).not.toHaveBeenCalled();
  });

  it("reuses deterministic occurrence and creator intersection material across repeated validation", async () => {
    const f = fixture();
    await expect(assertScheduledOccurrenceCurrent(f.host, f)).resolves.toMatchObject({ identity: f.identity });
    await expect(assertScheduledOccurrenceCurrent(f.host, f)).resolves.toMatchObject({ identity: f.identity });
    expect(f.storage.permissionProfiles.getProfile).toHaveBeenCalledTimes(2);
  });

  it.each([
    "disabled",
    "kill-switch",
    "terminal",
    "generation",
    "hash",
    "actor",
    "workspace",
    "child",
    "prompt",
    "archived-creator",
    "creator-scope",
    "creator-policy",
    "missing-creator-receipt",
    "forged-creator-receipt",
  ])("rejects %s changes before execution", async (change) => {
    const f = fixture();
    if (change === "disabled") f.isFeatureEnabled.mockResolvedValue(false);
    if (change === "kill-switch") f.isFeatureEnabled.mockResolvedValue(true);
    if (change === "terminal") f.run.status = "completed";
    if (change === "generation") f.job.executionGeneration += 1;
    if (change === "hash") f.reference.sha256 = "0".repeat(64);
    if (change === "actor") f.admission.requestActor.actorKind = "operator";
    if (change === "workspace") f.admission.identity.workspaceId = "another-workspace";
    if (change === "child") f.run.childDurableRunId = "another-run";
    if (change === "prompt") f.admission.admittedRequest.content = "Different objective";
    if (change === "archived-creator") f.creator.status = "archived";
    if (change === "creator-scope") f.creator.scopeRef = "another-workspace";
    if (change === "creator-policy") f.creator.deny = [...f.creator.deny, "fs.read"];
    if (change === "missing-creator-receipt") delete (f.job as { creatorAuthority?: unknown }).creatorAuthority;
    if (change === "forged-creator-receipt") f.job.creatorAuthority.actorId = "foreign";
    await expect(assertScheduledOccurrenceCurrent(f.host, f)).rejects.toThrow();
  });

  it("binds a complete occurrence reference once and refuses a client actor or changed immutable reference", async () => {
    const f = fixture();
    const features = {
      references: { version: "chat.turn.feature-references.v1" as const, scheduledOccurrence: f.reference },
      referenceSha256: "f".repeat(64),
    };
    const findFeatureReferences = vi.fn(async () => undefined as typeof features | undefined);
    const bindFeatureReferences = vi.fn(async () => features);
    const host = {
      ...f.host,
      storage: { ...f.storage, sessionMutationAdmissions: { findFeatureReferences, bindFeatureReferences } },
      assertTurnAdmissionWrite: vi.fn(async () => undefined),
      routeFingerprint: () => "b".repeat(64),
    } as unknown as ChatFeatureAdmissionHost;
    const input = {
      admission: f.admission,
      content: f.request.content,
      scheduledOccurrence: f.reference,
      route: { effectiveProviderId: "fixture", effectiveModel: "fixture" } as never,
    };
    await expect(resolveChatFeatureAdmission(host, input)).resolves.toEqual(features);
    expect(bindFeatureReferences).toHaveBeenCalledTimes(1);
    expect(bindFeatureReferences).toHaveBeenCalledWith(
      expect.objectContaining({
        references: expect.objectContaining({
          providerRoute: { primary: { providerId: "fixture", model: "fixture" }, fingerprint: "b".repeat(64) },
        }),
      }),
    );
    findFeatureReferences.mockResolvedValue(features);
    await resolveChatFeatureAdmission(host, input);
    expect(bindFeatureReferences).toHaveBeenCalledTimes(1);
    await expect(
      resolveChatFeatureAdmission(host, { ...input, scheduledOccurrence: { ...f.reference, ownerId: "other" } }),
    ).rejects.toThrow();
    f.admission.requestActor.actorKind = "operator";
    await expect(resolveChatFeatureAdmission(host, input)).rejects.toThrow();
  });

  it("revalidates persisted payload and current creator under the canonical fence on each dispatch", async () => {
    const f = fixture();
    const references = { version: "chat.turn.feature-references.v1" as const, scheduledOccurrence: f.reference };
    const features = { references, referenceSha256: hash(references) };
    const payload = {
      version: "chat.turn.execute.v2",
      admissionId: "admission",
      sessionIncarnationId: "incarnation",
      workspaceId: "workspace",
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      admissionMaterialSha256: f.admission.identity.materialSha256,
      effectiveRequestMaterialSha256: hash({
        version: 1,
        admissionMaterialSha256: f.admission.identity.materialSha256,
        request: f.request,
      }),
      requestActor: f.admission.requestActor,
      sessionId: "session",
      turnId: f.identity.turnId,
      userMessageId: f.identity.userMessageId,
      assistantMessageId: f.identity.assistantMessageId,
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: f.identity.durableRunId },
      featureReferenceSha256: features.referenceSha256,
      cronAdmission: f.identity,
      request: f.request,
    };
    const host = {
      ...f.host,
      storage: {
        ...f.storage,
        durableRuns: { getRun: vi.fn(async () => ({ workflowKey: "chat.turn.execute", status: "running", payload })) },
        sessionMutationAdmissions: {
          findDurableRunBinding: vi.fn(async () => ({ durableRunId: f.identity.durableRunId })),
          get: vi.fn(async () => ({
            status: "active",
            actorKind: "system",
            actorId: f.admission.requestActor.actorId,
          })),
          findFeatureReferences: vi.fn(async () => features),
        },
      },
    } as unknown as Parameters<typeof assertScheduledChatDispatchCurrent>[0];
    const canonicalWriteFence = vi.fn(async <T>(operation: () => T | Promise<T>) => await operation());
    const input = {
      featureAdmission: features,
      policyRunId: f.identity.durableRunId,
      sessionId: "session",
      turnId: f.identity.turnId,
      workspaceId: "workspace",
      canonicalWriteFence,
    };
    await assertScheduledChatDispatchCurrent(host, input);
    f.creator.deny = [...f.creator.deny, "fs.read"];
    await expect(assertScheduledChatDispatchCurrent(host, input)).rejects.toThrow("policy changed");
    expect(canonicalWriteFence).toHaveBeenCalledTimes(2);
    await expect(
      assertScheduledChatDispatchCurrent(host, { ...input, canonicalWriteFence: undefined }),
    ).rejects.toThrow("fence");
  });
});
