import type {
  ApprovalEffectRecord,
  DurableRunRecord,
  ChatTurnTraceRecord,
  ChatMessageRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

/** Persistence fences for approval materialization. Production requires the
 * transaction and row-lock owners; test-only fallbacks preserve existing fixtures. */
export interface ApprovalEffectMaterializationStorage {
  runImmediateTransaction: Storage["runImmediateTransaction"];
  approvalEffects: Pick<Storage["approvalEffects"], "lockFreshClaimForUpdate">;
  durableRuns: Pick<Storage["durableRuns"], "getRunForUpdate" | "getRun">;
  chatTurnTraces: Pick<Storage["chatTurnTraces"], "getForUpdate" | "get">;
  chatMessages: Pick<Storage["chatMessages"], "get">;
}

export async function runApprovalEffectTransaction<T>(
  storage: ApprovalEffectMaterializationStorage,
  callback: () => T | Promise<T>,
): Promise<Awaited<T>> {
  const transaction = (
    storage as {
      runImmediateTransaction?: <R>(work: () => R | Promise<R>) => Promise<Awaited<R>>;
    }
  ).runImmediateTransaction;
  if (transaction) {
    return (await transaction.call(storage, callback)) as Awaited<T>;
  }
  if (process.env.NODE_ENV === "test") {
    return await callback();
  }
  throw new Error("Approval effect durable completion is missing immediate transaction ownership");
}

export async function runClaimedApprovalEffectTransaction<T>(
  storage: ApprovalEffectMaterializationStorage,
  effect: ApprovalEffectRecord,
  workerId: string,
  callback: () => T | Promise<T>,
): Promise<Awaited<T>> {
  return await runApprovalEffectTransaction(storage, async () => {
    const approvalEffects = storage.approvalEffects;
    const lockFreshClaim = approvalEffects?.lockFreshClaimForUpdate;
    if (typeof lockFreshClaim !== "function") {
      if (process.env.NODE_ENV === "test") {
        return await callback();
      }
      throw new Error("Approval effect materialization is missing its database claim lock");
    }
    const locked = await lockFreshClaim.call(approvalEffects, effect.effectId, workerId, effect.version);
    if (!locked) {
      throw new Error(`Approval effect ${effect.effectId} lost its materialization lease.`);
    }
    return await callback();
  });
}

export async function lockApprovalMaterializationRun(
  storage: ApprovalEffectMaterializationStorage,
  runId: string,
): Promise<DurableRunRecord> {
  const durableRuns = storage.durableRuns as Storage["durableRuns"] & {
    getRunForUpdate?: (currentRunId: string) => Promise<DurableRunRecord>;
  };
  if (typeof durableRuns.getRunForUpdate === "function") {
    return await durableRuns.getRunForUpdate(runId);
  }
  if (process.env.NODE_ENV === "test") {
    return await durableRuns.getRun(runId);
  }
  throw new Error("Approval materialization is missing durable-run row-lock ownership");
}

export async function lockApprovalMaterializationTrace(
  storage: ApprovalEffectMaterializationStorage,
  turnId: string,
): Promise<ChatTurnTraceRecord | undefined> {
  const chatTurnTraces = storage.chatTurnTraces as
    | (Storage["chatTurnTraces"] & {
        getForUpdate?: (currentTurnId: string) => Promise<ChatTurnTraceRecord>;
      })
    | undefined;
  if (typeof chatTurnTraces?.getForUpdate === "function") {
    return await chatTurnTraces.getForUpdate(turnId);
  }
  if (process.env.NODE_ENV === "test") {
    return await chatTurnTraces?.get(turnId);
  }
  throw new Error("Approval materialization is missing Chat-turn row-lock ownership");
}

export async function hasCanonicalAssistantMessage(
  storage: ApprovalEffectMaterializationStorage,
  trace: ChatTurnTraceRecord,
): Promise<boolean> {
  if (!trace.assistantMessageId) {
    return false;
  }
  const chatMessages = storage.chatMessages as Storage["chatMessages"] & {
    get?: (messageId: string) => Promise<ChatMessageRecord | undefined>;
  };
  if (typeof chatMessages.get !== "function") {
    return false;
  }
  const message = await chatMessages.get(trace.assistantMessageId);
  return message?.role === "assistant" && message.sessionId === trace.sessionId;
}
