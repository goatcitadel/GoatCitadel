import {
  REMOTE_WORKER_INFERENCE_EXECUTION_TIMEOUT_MS,
  REMOTE_WORKER_BUDGET_OWNER_ID,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerInferenceCanonicalSha256,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerChatInferenceStepIndex,
  type ChatTurnCapabilityProfileRecord,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceAuthorizedSubmission,
} from "@goatcitadel/contracts";
import { createHash } from "node:crypto";
import type { AsyncStorage, RemoteWorkerInferenceRequestRecord } from "@goatcitadel/storage";
import { resolveRemoteWorkerChatProfile, type RemoteWorkerChatAuthorityDependencies } from "./remote-worker-chat-authority.js";
import { buildRemoteWorkerChatSequenceContext, readCanonicalWorkerChatInput } from "./remote-worker-chat-output-service.js";
import type { LlmService } from "./llm-service.js";
import { RemoteWorkerInferenceLlmServiceAdapter } from "./remote-worker-inference-llm-service-adapter.js";
import { createGovernedChatCompletion, type GovernedLlmCompletionHost } from "./llm-completion-service.js";
import {
  RemoteWorkerInferenceService,
  routeReceiptFor,
  type RemoteWorkerInferencePerformInput,
  type RemoteWorkerInferenceResolvedAuthority,
} from "./remote-worker-inference-service.js";

type RuntimeStorage = Pick<
  AsyncStorage,
  | "remoteWorkerAssignments"
  | "remoteWorkerInference"
  | "remoteWorkerBudgets"
  | "chatTurnCapabilityProfiles"
  | "capabilityCatalogSnapshots"
  | "skillLifecycle"
  | "modelUsageEvents"
  | "remoteWorkerEffects"
  | "chatToolRuns"
  | "approvals"
>;
type ExecutionRef = {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  leaseTokenSha256?: string;
  continuingInference?: { operationId: string; dispatchGeneration: string };
};
type Execution = Awaited<ReturnType<RuntimeStorage["remoteWorkerAssignments"]["resolveActiveChatExecution"]>>;

export interface RemoteWorkerInferenceRuntimeDependencies extends RemoteWorkerChatAuthorityDependencies {
  storage: RuntimeStorage;
  llm: Pick<LlmService, "resolveDispatchRoute" | "chatCompletionsWithDispatchGuard">;
  completionHost: GovernedLlmCompletionHost;
  dispatchOwnerId: string;
}

/**
 * Native request composition over canonical owners. Each call captures its own
 * protected transport fence; concurrent workers cannot share a mutable context.
 * The first workload is bounded text inference. Tool effects use their separate
 * governed effect route, and a budget grant never grants a tool capability.
 */
export class RemoteWorkerInferenceRuntime {
  public constructor(private readonly dependencies: RemoteWorkerInferenceRuntimeDependencies) {
    if (!Object.is(dependencies.completionHost.llmService, dependencies.llm))
      throw new Error("Worker completion and routing must share the canonical model owner.");
  }

  public async performInference(input: RemoteWorkerInferencePerformInput) {
    const fence = input.protectedAuthority;
    if (!fence) throw new Error("Worker inference requires protected native admission authority.");
    const { storage, llm } = this.dependencies;
    const load = async (ref: ExecutionRef) =>
      await storage.remoteWorkerAssignments.resolveActiveChatExecution(ref, fence);
    const readProfile = async (execution: Execution) =>
      (await resolveRemoteWorkerChatProfile(this.dependencies, execution)).profile;
    const selectRoute = async (execution: Execution, profile: ChatTurnCapabilityProfileRecord) => {
      const { effectiveProviderId, effectiveModel } = profile.selection;
      if (!effectiveProviderId || !effectiveModel) throw new Error("Worker inference has no admitted provider route.");
      const resolution = await llm.resolveDispatchRoute(effectiveProviderId, effectiveModel);
      if (
        resolution.providerId !== effectiveProviderId ||
        resolution.modelId !== effectiveModel ||
        !execution.authority.assignment.manifest.requiredCapabilityClasses.includes("gateway_inference")
      ) {
        throw new Error("Worker inference route is outside its admitted capability scope.");
      }
      return resolution;
    };
    const evaluate = async (
      authority: RemoteWorkerInferenceResolvedAuthority,
      submission: RemoteWorkerInferenceAuthorizedSubmission,
    ) => {
      const execution = await load(authority);
      assertBinding(authority, execution);
      const profile = await readProfile(execution);
      await assertCanonicalInput(storage, execution, profile, submission);
      const resolution = await selectRoute(execution, profile);
      const governance: RemoteWorkerInferenceGovernanceReceipt = {
        schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
        decision: "allowed",
        policyRevision: 1,
        policySha256: remoteWorkerInferenceCanonicalSha256({
          version: 1,
          profile: profile.hashes.profileHash,
          permission: profile.governance.permission,
          manifest: execution.authority.assignment.manifestSha256,
        }),
        effectiveRouteSha256: remoteWorkerInferenceEffectiveRouteSha256(routeReceiptFor(resolution)),
        outputTokenCeiling: Math.min(4_096, submission.outputTokenCeiling),
        reasoningTokenCeiling: 0,
        // Governance/spending is bounded by the task and model deadline. It is
        // distinct from the rotating worker lease, which readOperationExecution
        // revalidates before dispatch, every second, and before returning output.
        expiresAt: new Date(
          Math.min(
            Date.parse(execution.authority.assignment.manifest.deadlineAt),
            Date.now() + REMOTE_WORKER_INFERENCE_EXECUTION_TIMEOUT_MS,
          ),
        ).toISOString(),
      };
      return { governance, resolution };
    };
    const readOperationExecution = async (operationId: string, dispatchGeneration: string) => {
      const record = await storage.remoteWorkerInference.findOperationForUpdate(operationId, dispatchGeneration);
      if (!record) throw new Error("Worker inference operation is unavailable.");
      const execution = await load({ ...record, continuingInference: { operationId, dispatchGeneration } });
      assertOperationBinding(record, execution);
      return { record, execution };
    };
    const adapter = new RemoteWorkerInferenceLlmServiceAdapter({
      llm,
      complete: (request, attribution, guard) =>
        createGovernedChatCompletion(this.dependencies.completionHost, request, attribution, guard),
      budgets: storage.remoteWorkerBudgets,
      usage: storage.modelUsageEvents,
      assertAuthorityCurrent: async (request) => {
        const { record, execution } = await readOperationExecution(
          request.attribution.operationId!,
          request.attribution.dispatchGeneration!,
        );
        const profile = await readProfile(execution);
        await assertCanonicalInput(storage, execution, profile, { ...record, messages: request.messages });
        const resolution = await selectRoute(execution, profile);
        if (
          canonicalJsonString(resolution) !== canonicalJsonString(request.resolution) ||
          remoteWorkerInferenceEffectiveRouteSha256(routeReceiptFor(resolution)) !== record.effectiveRouteSha256
        ) {
          throw new Error("Worker inference current route changed.");
        }
      },
    });
    const service = new RemoteWorkerInferenceService({
      repository: storage.remoteWorkerInference,
      authority: {
        resolveActiveAuthority: async ({ leaseTokenSha256 }) => {
          const active = await storage.remoteWorkerAssignments.resolveActiveAuthorityByLeaseTokenHash(
            leaseTokenSha256,
            fence,
          );
          if (!active) return undefined;
          const execution = await load({
            registryWorkspaceId: active.assignment.registryWorkspaceId,
            assignmentId: active.assignment.assignmentId,
            assignmentGeneration: active.generation.assignmentGeneration,
            leaseTokenSha256,
          });
          return authorityOf(execution);
        },
      },
      governance: { evaluate: async ({ authority, submission }) => (await evaluate(authority, submission)).governance },
      // Pure model requests do not mint tool-approval continuations. The explicit
      // operator spending grant is still required by the separate budget owner.
      approval: { resolve: async () => undefined },
      routing: {
        resolve: async ({ authority }) => {
          const execution = await load(authority);
          assertBinding(authority, execution);
          return await selectRoute(execution, await readProfile(execution));
        },
      },
      budget: {
        reserve: async ({ operation, operationSha256 }) =>
          await storage.remoteWorkerBudgets.reserveForWorker({ operation, operationSha256 }),
        settle: async (settlement) => await storage.remoteWorkerBudgets.settle(settlement),
        release: async (release) => await storage.remoteWorkerBudgets.release(release),
      },
      adapter: {
        dispatch: async (request) =>
          await withAuthorityWatch(
            input.signal,
            async () => {
              await readOperationExecution(request.attribution.operationId!, request.attribution.dispatchGeneration!);
              const reservation = await storage.remoteWorkerBudgets.getReservationForOperation(
                request.attribution.operationId!,
                request.attribution.dispatchGeneration!,
              );
              if (!reservation) throw new Error("Worker inference budget is unavailable.");
              await storage.remoteWorkerBudgets.assertDispatchAllowed(reservation);
            },
            async (signal) => {
              const { execution } = await readOperationExecution(
                request.attribution.operationId!,
                request.attribution.dispatchGeneration!,
              );
              const profile = await readProfile(execution);
              return await adapter.dispatch({
                ...request,
                signal,
                tools: profile.selection.tools.map((tool) => tool.providerDefinition),
                memory: {
                  enabled: profile.selection.memory.mode !== "off",
                  mode: profile.selection.memory.mode === "off" ? "off" : "qmd",
                  sessionId: profile.identity.sessionId,
                  turnId: profile.identity.turnId,
                  runId: request.attribution.durableRunId,
                  taskId: request.attribution.taskId,
                },
              });
            },
          ),
      },
      budgetOwnerId: REMOTE_WORKER_BUDGET_OWNER_ID,
      dispatchOwnerId: this.dependencies.dispatchOwnerId,
      clock: () => new Date().toISOString(),
    });
    return await service.performInference(input);
  }
}

function authorityOf(execution: Execution): RemoteWorkerInferenceResolvedAuthority {
  const { assignment, generation, lease } = execution.authority;
  const manifest = assignment.manifest;
  if (!manifest.sessionId || !manifest.turnId || !manifest.requiredCapabilityClasses.includes("gateway_inference"))
    throw new Error("Worker inference requires a task-bound Chat inference assignment.");
  return {
    registryWorkspaceId: assignment.registryWorkspaceId,
    executionWorkspaceId: manifest.executionWorkspaceId,
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    workerId: generation.workerId,
    workerGeneration: generation.workerGeneration,
    sessionId: manifest.sessionId,
    turnId: manifest.turnId,
    durableRunId: manifest.durableRunId,
    taskId: manifest.taskId,
    leaseRevision: lease.leaseRevision,
    capabilityProfileSha256: manifest.capabilityProfileSha256,
    routedContextSha256: manifest.contextSnapshotSha256,
    capabilityClaims: ["worker_runtime", "gateway_inference"],
  };
}

function assertBinding(expected: RemoteWorkerInferenceResolvedAuthority, execution: Execution): void {
  const current = authorityOf(execution);
  const { leaseRevision: previousRevision, ...previous } = expected;
  const { leaseRevision: currentRevision, ...next } = current;
  if (currentRevision < previousRevision || canonicalJsonString(previous) !== canonicalJsonString(next))
    throw new Error("Worker inference assignment authority changed.");
}

function assertOperationBinding(record: RemoteWorkerInferenceRequestRecord, execution: Execution): void {
  const current = authorityOf(execution);
  for (const field of [
    "registryWorkspaceId",
    "executionWorkspaceId",
    "assignmentId",
    "assignmentGeneration",
    "workerId",
    "workerGeneration",
    "sessionId",
    "turnId",
    "durableRunId",
    "taskId",
    "capabilityProfileSha256",
    "routedContextSha256",
  ] as const) {
    if (record[field] !== current[field]) throw new Error("Worker inference operation authority changed.");
  }
  if (!record.admittedLeaseRevision || current.leaseRevision < record.admittedLeaseRevision)
    throw new Error("Worker inference lease revision moved backwards.");
}

async function assertCanonicalInput(
  storage: RuntimeStorage,
  execution: Execution,
  profile: ChatTurnCapabilityProfileRecord,
  submission: Pick<RemoteWorkerInferenceAuthorizedSubmission,
    "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "inferenceRequestId" | "attempt" |
    "idempotencyKey" | "messages" | "inputSha256" | "contextSha256" | "modelIntentSha256">,
): Promise<void> {
  const request = execution.workload.payload.request as Record<string, unknown> | undefined;
  const content = request?.content;
  const messages = await readCanonicalWorkerChatInput(storage.remoteWorkerInference, submission,
    remoteWorkerChatInferenceStepIndex(submission), buildRemoteWorkerChatSequenceContext(storage, profile, execution));
  if (
    typeof content !== "string" ||
    remoteWorkerInferenceCanonicalSha256(content) !== profile.selection.contentHash ||
    canonicalJsonString(submission.messages) !== canonicalJsonString(messages) ||
    remoteWorkerInferenceCanonicalSha256(submission.messages) !== submission.inputSha256 ||
    submission.contextSha256 !== execution.workload.contextSnapshotSha256 ||
    submission.modelIntentSha256 !== createHash("sha256").update("gateway-assignment-route-v1").digest("hex")
  ) {
    throw new Error("Worker inference prompt differs from its admitted Chat workload.");
  }
}

/** No overlapping polls; shutdown drains an owned check before returning. */
async function withAuthorityWatch<T>(
  signal: AbortSignal | undefined,
  check: () => Promise<void>,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let stopped = false;
  const schedule = () => {
    timer = setTimeout(() => {
      pending = check()
        .catch(() => controller.abort(new Error("Worker inference authority is unavailable.")))
        .finally(() => {
          pending = undefined;
          if (!stopped && !combined.aborted) schedule();
        });
    }, 1_000);
    timer.unref();
  };
  combined.throwIfAborted();
  schedule();
  try {
    return await run(combined);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  }
}
