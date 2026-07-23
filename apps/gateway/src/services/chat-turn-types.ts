import type {
  ChatSendMessageRequest,
  ChatStreamChunk,
  ChatStreamChunkDraft,
  ChatTurnBranchKind,
  ChatUserInputPromptResponse,
} from "@goatcitadel/contracts";
import type { OrchestrationPlan as ModeOrchestrationPlan, OrchestrationRouterInput } from "../orchestration/types.js";

export type PersistableChatStreamChunk = ChatStreamChunkDraft extends infer T
  ? T extends { turnId?: string }
    ? T & { turnId: string }
    : never
  : never;

export type InspectableChatStreamChunk = ChatStreamChunk | ChatStreamChunkDraft;

/**
 * Request-scoped signal from the canonical Chat write owner back to the HTTP
 * stream/idempotency boundary. Calls are idempotent; the first successful
 * durable mutation permanently owns the request key.
 */
export interface ChatStreamMutationLifecycle {
  commitAlongsideCanonicalWrite?(): void;
  markCommitted(): void;
}

/**
 * Immutable authority for every canonical write produced by one Chat turn.
 *
 * The identity is admitted before routing or preparation mutates session state
 * and is carried explicitly across process and durable-run boundaries. It must
 * never be reconstructed from the session's current lifecycle metadata: a
 * deleted and reactivated session may already be in a later incarnation by the
 * time an old callback arrives.
 */
export interface TurnAdmissionIdentity {
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  aggregateRevision: number;
  controllerGeneration: number;
  materialSha256: string;
}

/** Database-clock request owner used before a turn is bound to a durable run. */
export interface TurnAdmissionRequestClaim {
  runtimeOwnerId: string;
  leaseRevision: number;
}

/** Exact durable worker claim required for authority-bearing durable writes. */
export interface TurnAdmissionDurableClaim {
  durableRunId: string;
  leaseOwnerId: string;
  attemptCount: number;
}

/**
 * The immutable executable request identity a Chat turn admission freezes.
 * Transport signal and actor projection are excluded (they are admission
 * ACTOR material), and so are routed-context refs: the C1 routed-context
 * ward strips raw refs from every durable payload — their identity freezes
 * into the routed-context snapshot chain instead (sourceRequestHash,
 * snapshotHash, capability-profile and trace bindings) — so the admission
 * material must hash the same refs-less request every durable
 * re-verification reconstructs.
 */
export type FrozenChatTurnExecutionRequest = Omit<
  ChatSendMessageRequest,
  "signal" | "operatorId" | "authActorId" | "authActorSource" | "contextRefs"
>;

export interface FrozenChatTurnRequestActor {
  actorKind: "operator" | "external_companion" | "system";
  actorId: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
}

/**
 * Server-authored discriminator for the one heartbeat occurrence that owns a
 * system Chat admission. Generic system turns deliberately do not receive it.
 */
export interface SystemHeartbeatOccurrenceTurnAdmission {
  kind: "system_heartbeat_occurrence";
  operation: "chat_system_heartbeat";
  occurrenceId: string;
  correlationId: string;
  claimSha256: string;
  durableRunId: string;
}

export interface ChatTurnSurfaceDerivation {
  version: 1;
  originalMode: ChatSendMessageRequest["mode"] | null;
  originalAutoRoute: boolean | null;
  effectiveMode: "chat";
  effectiveAutoRoute: false;
}

export interface ActiveTurnAdmission {
  identity: TurnAdmissionIdentity;
  /** Request-runtime-only snapshot; durable payloads retain only one effective request plus a reversible derivation. */
  admittedRequest: FrozenChatTurnExecutionRequest;
  /** Exact server-derived actor authority frozen at admission. */
  requestActor: FrozenChatTurnRequestActor;
  /** Exact occurrence authority, present only for a storage-admitted heartbeat. */
  systemHeartbeatOccurrence?: Readonly<SystemHeartbeatOccurrenceTurnAdmission>;
  requestClaim?: TurnAdmissionRequestClaim;
  durableClaim?: TurnAdmissionDurableClaim;
}

export interface PreparedAgentChatTurnDispatchOptions {
  abortSignal?: AbortSignal;
  onChildDurableRunLaunched?: (runId: string) => void;
  assertDispatchOwnership?: () => void;
  durableRunId?: string;
  mutationLifecycle?: ChatStreamMutationLifecycle;
  requireDurableExecution?: boolean;
}

export interface PreparedChatExecutionPlanResolution {
  routerInput: OrchestrationRouterInput;
  orchestrationPlan: ModeOrchestrationPlan;
  executionPlanDraft: {
    source: "planner" | "workflow_template" | "planner_with_template_fallback";
    advisoryOnly: boolean;
    objective: string;
    summary: string;
    steps: Array<{
      stepId: string;
      index: number;
      objective: string;
      successCriteria?: string;
      suggestedTools?: string[];
      expectedOutput?: string;
      parallelizable: boolean;
      dependsOnStepIds?: string[];
      delegatedRole?: string;
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
      summary?: string;
      error?: string;
      startedAt?: string;
      finishedAt?: string;
      childRunId?: string;
      childSessionId?: string;
      childTurnId?: string;
    }>;
  };
}

export interface DurableChatTurnExecutionPayload {
  version: "chat.turn.execute.v2";
  admissionId: string;
  sessionIncarnationId: string;
  admissionMaterialSha256: string;
  workspaceId: string;
  admissionAggregateRevision: number;
  admissionControllerGeneration: number;
  effectiveRequestMaterialSha256: string;
  /** Exact server-owned derivation used only when the admitted request omitted policyRunId. */
  policyRunIdDerivation?: {
    version: 1;
    kind: "durable_run_id";
    runId: string;
  };
  surfaceDerivation?: ChatTurnSurfaceDerivation;
  requestActor: FrozenChatTurnRequestActor;
  sessionId: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  capabilityProfileId?: string;
  capabilityProfileHash?: string;
  /** Durable replay binding placeholder; replay loading is owned by the durable runtime. */
  routedContextSnapshotId?: string;
  routedContextSnapshotHash?: string;
  branchKind: ChatTurnBranchKind;
  parentTurnId?: string;
  sourceTurnId?: string;
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited";
  request: FrozenChatTurnExecutionRequest;
  userInputResponses?: DurableChatTurnUserInputResumeRecord[];
}

export interface DurableChatTurnUserInputResumeRecord {
  promptId: string;
  kind: "single_select" | "text";
  title?: string;
  question: string;
  answeredAt: string;
  response: ChatUserInputPromptResponse;
  selectedOption?: {
    optionId: string;
    label: string;
    description?: string;
  };
}

export function isPersistableChatStreamChunk(chunk: ChatStreamChunkDraft): chunk is PersistableChatStreamChunk {
  return typeof chunk.turnId === "string" && chunk.turnId.length > 0;
}
