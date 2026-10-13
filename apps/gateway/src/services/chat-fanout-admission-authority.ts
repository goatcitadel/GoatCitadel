import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  isDurableRunTerminal,
  type AutonomousActivationGrantEvaluationInput,
  type AutonomousActivationGrantRecord,
  type ChatFanoutInvocationRecord,
  type ChatProjectRecord,
  type ChatTurnFeatureReferences,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CapabilitySystemService } from "./capability-system-service.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import {
  buildFanoutAdmissionReference,
  buildFanoutChildAdmissionReference,
} from "./chat-fanout-admission-reference.js";

export interface FanoutAdmissionAuthorityHost {
  storage: Pick<
    AsyncStorage,
    | "chatFanoutInvocations"
    | "chatDelegationSteps"
    | "durableRuns"
    | "sessionMutationAdmissions"
    | "sessionControls"
    | "chatSessionPrefs"
    | "chatSessionProjects"
    | "chatProjects"
  >;
  capabilitySystem: Pick<
    CapabilitySystemService,
    "listAutonomousActivationGrants" | "evaluateAutonomousActivationGrantAuthorityById"
  >;
  isEnabled(): Promise<boolean>;
  isLiveAdmissionEnabled?(): Promise<boolean>;
  assertParentToolUseOpen(parentRunId: string, sessionId: string): Promise<void>;
}

export async function assertFanoutInitialSelection(
  host: Pick<FanoutAdmissionAuthorityHost, "isLiveAdmissionEnabled">,
  prepared: Pick<PreparedAgentChatTurn, "capabilityProfile" | "featureAdmission" | "prefs">,
): Promise<void> {
  if (
    !prepared.capabilityProfile &&
    (!prepared.featureAdmission?.references.childWork ||
      !(await host.isLiveAdmissionEnabled?.()) ||
      prepared.prefs.subagentPolicy !== "auto_when_useful")
  ) {
    throw new FanoutAuthorityError("Automatic fanout requires an enabled, explicitly selected parent admission.");
  }
}

/** Only current admission/project/grant checks. Reservation, launch, settlement and wake remain with the durable owner. */

export async function assertFanoutInvocationAuthority(
  host: FanoutAdmissionAuthorityHost,
  invocationId: string,
): Promise<void> {
  const invocation = await host.storage.chatFanoutInvocations.get(invocationId);
  if (!invocation.parentAdmission || isTerminal(invocation.status)) {
    throw new FanoutAuthorityError("Automatic child has no active admission-bound fanout owner.");
  }
  await assertFanoutLiveAuthority(host, invocation);
}

export async function assertFanoutFeatureDispatchCurrent(
  host: FanoutAdmissionAuthorityHost,
  input: {
    featureAdmission?: { references: ChatTurnFeatureReferences; referenceSha256: string };
    policyRunId?: string;
    canonicalDurableRunId?: string;
    parentDelegationStepId?: string;
    sessionId: string;
    turnId: string;
    workspaceId?: string;
    canonicalWriteFence?: <T>(work: () => T | Promise<T>) => Promise<Awaited<T>>;
  },
): Promise<void> {
  const expected = input.featureAdmission;
  if (!expected?.references.childWork) return;
  if (!input.canonicalWriteFence) throw new FanoutAuthorityError("Fanout dispatch requires a canonical write fence.");
  await input.canonicalWriteFence(async () => {
    const step = input.parentDelegationStepId
      ? await host.storage.chatDelegationSteps.get(input.parentDelegationStepId)
      : undefined;
    const runId = input.canonicalDurableRunId ?? step?.durableRunId ?? input.policyRunId;
    if (!runId) throw new FanoutAuthorityError("Fanout dispatch has no durable owner.");
    const run = await host.storage.durableRuns.getRun(runId);
    const authority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: runId,
      payload: run.payload,
    });
    if (
      !authority ||
      run.status !== "running" ||
      authority.sessionId !== input.sessionId ||
      authority.turnId !== input.turnId ||
      authority.workspaceId !== input.workspaceId ||
      authority.featureReferenceSha256 !== expected.referenceSha256
    ) {
      throw new FanoutAuthorityError("Fanout dispatch differs from its admitted durable turn.");
    }
    const admission: ActiveTurnAdmission = {
      identity: {
        admissionId: authority.admissionId,
        sessionIncarnationId: authority.sessionIncarnationId,
        sessionId: authority.sessionId,
        turnId: authority.turnId,
        workspaceId: authority.workspaceId,
        materialSha256: authority.admissionMaterialSha256,
        aggregateRevision: authority.admissionAggregateRevision,
        controllerGeneration: authority.admissionControllerGeneration,
      },
      admittedRequest: authority.request as ActiveTurnAdmission["admittedRequest"],
      requestActor: authority.requestActor as ActiveTurnAdmission["requestActor"],
    };
    const features = await host.storage.sessionMutationAdmissions.findFeatureReferences(admission.identity);
    const binding = await host.storage.sessionMutationAdmissions.findDurableRunBinding(admission.identity);
    if (
      binding?.durableRunId !== runId ||
      features?.referenceSha256 !== expected.referenceSha256 ||
      canonicalJsonString(features.references) !== canonicalJsonString(expected.references)
    ) {
      throw new FanoutAuthorityError("Fanout dispatch feature binding is stale.");
    }
    if (step) {
      const invocation = await host.storage.chatFanoutInvocations.get(expected.references.childWork!.ownerId);
      if (
        step.durableRunId !== runId ||
        step.childSessionId !== input.sessionId ||
        step.childTurnId !== input.turnId ||
        step.runId !== invocation.delegationRunId ||
        authority.request.policyRunId !== step.runId ||
        canonicalJsonString(buildFanoutChildAdmissionReference(admission, invocation, step.stepId)) !==
          canonicalJsonString(expected.references.childWork)
      )
        throw new FanoutAuthorityError("Automatic child dispatch binding changed.");
      await assertFanoutInvocationAuthority(host, invocation.invocationId);
    } else {
      const project = await resolveFanoutActiveProject(host, input.sessionId, authority.workspaceId);
      await assertFanoutParentAdmissionCurrent(
        host,
        {
          parentRunId: runId,
          sessionId: input.sessionId,
          workspaceId: authority.workspaceId,
          parentAdmission: {
            admissionId: authority.admissionId,
            sessionIncarnationId: authority.sessionIncarnationId,
            materialSha256: authority.admissionMaterialSha256,
            featureReferenceSha256: expected.referenceSha256,
          },
        },
        project,
      );
    }
  });
}

export async function assertFanoutLiveAuthority(
  host: FanoutAdmissionAuthorityHost,
  invocation: ChatFanoutInvocationRecord,
): Promise<void> {
  await host.assertParentToolUseOpen(invocation.parentRunId, invocation.sessionId);
  const project = await resolveFanoutActiveProject(host, invocation.sessionId, invocation.workspaceId);
  if (invocation.parentAdmission) await assertFanoutParentAdmissionCurrent(host, invocation, project);
  if (project.projectId !== invocation.projectId) {
    throw new FanoutAuthorityError("The Chat session project changed after fan-out admission.");
  }
  const currentProjectBindingHash = hash({
    projectId: project.projectId,
    workspaceId: project.workspaceId ?? "default",
    revision: project.revision,
    lifecycleStatus: project.lifecycleStatus,
  });
  if (currentProjectBindingHash !== invocation.projectBindingHash) {
    throw new FanoutAuthorityError("The admitted project binding changed after fan-out admission.");
  }
  const liveGrant = await findFanoutGrant(host, invocation.grantId);
  if (!liveGrant || hash(freezeGrantBinding(liveGrant)) !== invocation.grantBindingHash) {
    throw new FanoutAuthorityError("The admitted automatic fan-out grant binding changed after admission.");
  }
  const evaluated = await host.capabilitySystem.evaluateAutonomousActivationGrantAuthorityById(
    invocation.grantId,
    buildGrantEvaluationInput({
      workspaceId: invocation.workspaceId,
      projectId: invocation.projectId,
      estimatedCostUsd: 0,
    }),
  );
  if (!evaluated.allowed) {
    throw new FanoutAuthorityError(
      `The admitted automatic fan-out grant is no longer valid. ${evaluated.blockers.join(" ")}`.trim(),
    );
  }
  // Grant checks can yield while an operator closes the parent turn.
  await host.assertParentToolUseOpen(invocation.parentRunId, invocation.sessionId);
}

export async function assertFanoutParentAdmissionCurrent(
  host: FanoutAdmissionAuthorityHost,
  invocation: Pick<ChatFanoutInvocationRecord, "parentRunId" | "parentAdmission" | "sessionId" | "workspaceId">,
  project: ChatProjectRecord,
): Promise<void> {
  if (!(await host.isEnabled()) || !(await host.isLiveAdmissionEnabled?.())) {
    throw new FanoutAuthorityError("Automatic fanout was disabled.");
  }
  const run = await host.storage.durableRuns.getRun(invocation.parentRunId);
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  const expected = invocation.parentAdmission!;
  if (
    !authority ||
    isDurableRunTerminal(run.status) ||
    authority.capabilityProfileId ||
    authority.admissionId !== expected.admissionId ||
    authority.sessionIncarnationId !== expected.sessionIncarnationId ||
    authority.admissionMaterialSha256 !== expected.materialSha256 ||
    authority.featureReferenceSha256 !== expected.featureReferenceSha256 ||
    authority.sessionId !== invocation.sessionId ||
    authority.workspaceId !== invocation.workspaceId ||
    authority.requestActor.actorKind !== "operator" ||
    authority.request.parentDelegationStepId
  ) {
    throw new FanoutAuthorityError("Automatic fanout parent admission no longer matches its durable owner.");
  }
  const identity = {
    admissionId: authority.admissionId,
    sessionIncarnationId: authority.sessionIncarnationId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    workspaceId: authority.workspaceId,
    aggregateRevision: authority.admissionAggregateRevision,
    controllerGeneration: authority.admissionControllerGeneration,
    materialSha256: authority.admissionMaterialSha256,
  };
  const [binding, features, admission, prefs] = await Promise.all([
    host.storage.sessionMutationAdmissions.findDurableRunBinding(identity),
    host.storage.sessionMutationAdmissions.findFeatureReferences(identity),
    host.storage.sessionMutationAdmissions.get(identity.admissionId),
    host.storage.chatSessionPrefs.get(invocation.sessionId),
  ]);
  const currentReference = buildFanoutAdmissionReference(
    {
      identity,
      admittedRequest: authority.request as ActiveTurnAdmission["admittedRequest"],
      requestActor: authority.requestActor as ActiveTurnAdmission["requestActor"],
    },
    project,
  );
  if (
    binding?.durableRunId !== run.runId ||
    !features ||
    features.referenceSha256 !== expected.featureReferenceSha256 ||
    canonicalJsonString(features.references.childWork) !== canonicalJsonString(currentReference) ||
    !admission ||
    admission.status !== "active" ||
    admission.admissionKind !== "turn_write" ||
    admission.admissionId !== identity.admissionId ||
    admission.sessionIncarnationId !== identity.sessionIncarnationId ||
    admission.sessionId !== identity.sessionId ||
    admission.workspaceId !== identity.workspaceId ||
    admission.turnId !== identity.turnId ||
    admission.aggregateRevision !== identity.aggregateRevision ||
    admission.controllerGeneration !== identity.controllerGeneration ||
    admission.materialSha256 !== identity.materialSha256 ||
    admission.actorKind !== "operator" ||
    admission.actorId !== authority.requestActor.actorId ||
    prefs?.subagentPolicy !== "auto_when_useful"
  ) {
    throw new FanoutAuthorityError("Automatic fanout selection or admission evidence changed.");
  }
  // A parked parent has no execution lease. Validate the existing session
  // controller owner without manufacturing a claim; the wake still uses the
  // durable owner's waiting-state CAS and execution acquires a fresh lease.
  await host.storage.sessionControls.resolveMutationAuthority({
    actorKind: "operator",
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    expectedGeneration: identity.controllerGeneration,
  });
}

export async function resolveFanoutActiveProject(
  host: FanoutAdmissionAuthorityHost,
  sessionId: string,
  workspaceId: string,
): Promise<ChatProjectRecord> {
  const storage = host.storage;
  const binding = await storage.chatSessionProjects.get(sessionId);
  if (!binding?.projectId) {
    throw new FanoutAuthorityError("Automatic fan-out requires an active project-bound Chat session.");
  }
  const project = await storage.chatProjects.find(binding.projectId);
  if (!project || project.lifecycleStatus !== "active") {
    throw new FanoutAuthorityError("Automatic fan-out requires a non-archived active project.");
  }
  if ((project.workspaceId ?? "default") !== workspaceId) {
    throw new FanoutAuthorityError("The active project belongs to a different workspace.");
  }
  return project;
}

export async function findFanoutGrant(
  host: FanoutAdmissionAuthorityHost,
  grantId: string,
): Promise<AutonomousActivationGrantRecord | undefined> {
  return (await host.capabilitySystem.listAutonomousActivationGrants(true)).find((grant) => grant.grantId === grantId);
}

export class FanoutAuthorityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FanoutAuthorityError";
  }
}

export function buildGrantEvaluationInput(input: {
  workspaceId: string;
  projectId: string;
  estimatedCostUsd: number;
}): AutonomousActivationGrantEvaluationInput {
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    surface: "chat",
    riskLevel: "caution",
    activationKind: "subagent_fanout",
    capabilityId: "agent.fanout",
    toolName: "agent.fanout",
    estimatedCostUsd: input.estimatedCostUsd,
  };
}

export function freezeGrantBinding(grant: AutonomousActivationGrantRecord): Record<string, unknown> {
  return {
    grantId: grant.grantId,
    status: grant.status,
    workspaceId: grant.workspaceId,
    projectId: grant.projectId ?? null,
    activationKinds: grant.activationKinds,
    maxActivations: grant.maxActivations ?? null,
    budgetUsd: grant.budgetUsd ?? null,
    expiresAt: grant.expiresAt,
  };
}

export function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}

function isTerminal(status: ChatFanoutInvocationRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked"
  );
}

export async function assertFanoutRuntimeEnabled(host: Pick<FanoutAdmissionAuthorityHost, "isEnabled">): Promise<void> {
  if (!(await host.isEnabled())) {
    throw new Error("Automatic fan-out is unavailable because the durable Chat fan-out rollout is disabled.");
  }
}
