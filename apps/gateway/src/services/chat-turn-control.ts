import {
  ConflictError,
  NotFoundError,
  type ApprovalResolutionOutcome,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

/** Server-owned state, retained in durable metadata across waits and retries. */
export interface ChatTurnControl {
  artifactRetryIssued?: boolean;
  delegationProposal?: import("./chat-confirmed-delegation-service.js").ConfirmedDelegationProposal;
  toolClosure?: { outcome: ApprovalResolutionOutcome; approvalId?: string; actorId: string; closedAt: string };
}

export const CHAT_TURN_CONTROL_KEY = "chatTurnControlV1";
type ControlStorage = Pick<Storage, "chatTurnTraces" | "durableRuns" | "runImmediateTransaction"> &
  Partial<Pick<Storage, "chatMessages" | "chatDelegationSteps" | "chatDelegationRuns">>;

/** The root operator turn owns consent for every child admitted by that turn. */
export async function resolveChatTurnControlOwner(
  storage: ControlStorage,
  sessionId: string,
  turnId: string,
  stopAtTurnId?: string,
): Promise<{ sessionId: string; turnId: string }> {
  const seen = new Set<string>();
  while (true) {
    if (seen.has(turnId) || seen.size >= 16)
      throw new ConflictError({ message: "Chat delegation lineage is invalid." });
    seen.add(turnId);
    if (turnId === stopAtTurnId) return { sessionId, turnId };
    let trace: ChatTurnTraceRecord;
    try {
      trace = await storage.chatTurnTraces.get(turnId);
    } catch (error) {
      if (error instanceof NotFoundError) return { sessionId, turnId };
      throw error;
    }
    if (trace.sessionId !== sessionId) throw new ConflictError({ message: "Chat turn belongs to another session." });
    if (!storage.chatMessages || !storage.chatDelegationSteps || !storage.chatDelegationRuns)
      return { sessionId, turnId };
    const message = await storage.chatMessages.get(trace.userMessageId);
    if (!message?.parentDelegationStepId) return { sessionId, turnId };
    const step = await storage.chatDelegationSteps.get(message.parentDelegationStepId);
    if (step.childSessionId !== sessionId || step.childTurnId !== turnId)
      throw new ConflictError({ message: "Chat delegation lineage belongs to another turn." });
    const delegation = await storage.chatDelegationRuns.get(step.runId);
    if (!delegation.parentRunId) return { sessionId, turnId }; // Legacy explicit manual delegation.
    const parent = await storage.durableRuns.getRun(delegation.parentRunId);
    if (typeof parent.payload.sessionId !== "string" || typeof parent.payload.turnId !== "string")
      throw new ConflictError({ message: "Chat delegation has no canonical parent turn." });
    sessionId = parent.payload.sessionId;
    turnId = parent.payload.turnId;
  }
}

export async function closeChatTurnToolUse(
  storage: ControlStorage,
  sessionId: string,
  turnId: string,
  closure: NonNullable<ChatTurnControl["toolClosure"]>,
): Promise<void> {
  const owner = await resolveChatTurnControlOwner(storage, sessionId, turnId);
  await updateChatTurnControl(storage, owner.sessionId, owner.turnId, (state) => ({
    ...state,
    toolClosure: state.toolClosure ?? closure,
  }));
}

function readControl(value: unknown): ChatTurnControl {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ChatTurnControl) : {};
}

export async function readChatTurnControl(
  storage: ControlStorage,
  sessionId: string,
  turnId: string,
  ancestors = new Set<string>(),
): Promise<ChatTurnControl> {
  if (ancestors.has(turnId) || ancestors.size >= 16)
    throw new ConflictError({ message: "Chat delegation lineage is invalid." });
  ancestors.add(turnId);
  let trace: ChatTurnTraceRecord;
  try {
    trace = await storage.chatTurnTraces.get(turnId);
  } catch (error) {
    if (error instanceof NotFoundError) return {};
    throw error;
  }
  if (trace.sessionId !== sessionId)
    throw new ConflictError({ message: "Chat turn control belongs to another session." });
  if (trace.status === "cancelled")
    return {
      toolClosure: {
        outcome: "withdrawn",
        actorId: "system:turn-cancelled",
        closedAt: trace.finishedAt ?? trace.startedAt,
      },
    };
  let control = readControl(trace.routing?.turnControl);
  if (trace.durable?.runId) {
    const run = await storage.durableRuns.getRun(trace.durable.runId);
    if (run.payload.sessionId !== sessionId || run.payload.turnId !== turnId)
      throw new ConflictError({ message: "Chat turn control has a mismatched durable owner." });
    control = readControl(run.metadata?.[CHAT_TURN_CONTROL_KEY]);
  }
  if (!control.toolClosure && storage.chatMessages && storage.chatDelegationSteps && storage.chatDelegationRuns) {
    const message = await storage.chatMessages.get(trace.userMessageId);
    if (message?.parentDelegationStepId) {
      const step = await storage.chatDelegationSteps.get(message.parentDelegationStepId);
      if (step.childSessionId !== sessionId || step.childTurnId !== turnId)
        throw new ConflictError({ message: "Chat delegation lineage belongs to another turn." });
      const delegation = await storage.chatDelegationRuns.get(step.runId);
      if (delegation.parentRunId) {
        const parent = await storage.durableRuns.getRun(delegation.parentRunId);
        if (typeof parent.payload.sessionId === "string" && typeof parent.payload.turnId === "string") {
          const parentControl = await readChatTurnControl(
            storage,
            parent.payload.sessionId,
            parent.payload.turnId,
            ancestors,
          );
          if (parentControl.toolClosure) control = { ...control, toolClosure: parentControl.toolClosure };
        }
      }
    }
  }
  return control;
}

/** Caller may already own a transaction; storage supplies a nested savepoint. */
export async function updateChatTurnControl(
  storage: ControlStorage,
  sessionId: string,
  turnId: string,
  update: (current: ChatTurnControl) => ChatTurnControl,
): Promise<ChatTurnControl> {
  const work = async () => {
    let trace: ChatTurnTraceRecord;
    try {
      trace = await storage.chatTurnTraces.get(turnId);
    } catch (error) {
      if (error instanceof NotFoundError) return {};
      throw error;
    }
    if (trace.sessionId !== sessionId)
      throw new ConflictError({ message: "Chat turn control belongs to another session." });
    if (!trace.durable?.runId) {
      const next = update(readControl(trace.routing?.turnControl));
      await storage.chatTurnTraces.patch(turnId, { routing: { ...trace.routing, turnControl: next } });
      return next;
    }
    const run = await storage.durableRuns.getRunForUpdate(trace.durable.runId);
    if (run.payload.sessionId !== sessionId || run.payload.turnId !== turnId)
      throw new ConflictError({ message: "Chat turn control has a mismatched durable owner." });
    const next = update(readControl(run.metadata?.[CHAT_TURN_CONTROL_KEY]));
    await storage.durableRuns.updateRun({
      runId: run.runId,
      status: run.status,
      expectedVersion: run.version,
      metadata: { ...run.metadata, [CHAT_TURN_CONTROL_KEY]: next },
    });
    return next;
  };
  // Compatibility-only runner fixtures and legacy non-durable turns retain the
  // state in the existing routing JSON. Admitted production turns use the lock above.
  return storage.runImmediateTransaction ? await storage.runImmediateTransaction(work) : await work();
}

export async function claimArtifactRetry(storage: ControlStorage, sessionId: string, turnId: string): Promise<boolean> {
  let claimed = false;
  await updateChatTurnControl(storage, sessionId, turnId, (current) => {
    if (current.artifactRetryIssued || current.toolClosure) return current;
    claimed = true;
    return { ...current, artifactRetryIssued: true };
  });
  return claimed;
}

export function toolClosureSummary(closure: NonNullable<ChatTurnControl["toolClosure"]>): string {
  return closure.outcome === "denied"
    ? "You denied the action. This turn will not start any more tools or request another approval. Send a new message to continue."
    : "The action is no longer authorized. This turn will not start any more tools. Send a new message to continue.";
}

export class ChatTurnToolUseClosedError extends ConflictError {
  constructor(public readonly closure: NonNullable<ChatTurnControl["toolClosure"]>) {
    super({ message: toolClosureSummary(closure) });
  }
}

export async function assertChatTurnToolUseOpen(
  storage: ControlStorage,
  sessionId: string,
  turnId?: string,
): Promise<void> {
  if (!turnId) return; // Non-Chat tool routes have their own authority.
  const control = await readChatTurnControl(storage, sessionId, turnId);
  if (control.toolClosure) throw new ChatTurnToolUseClosedError(control.toolClosure);
}
