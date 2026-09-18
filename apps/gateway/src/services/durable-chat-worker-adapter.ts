import {
  canonicalJsonString,
  sealRemoteWorkerChatContextForTurn,
  trySealRemoteWorkerChatContextForTurn,
  verifyRemoteWorkerChatContextBinding,
  type DurableRunRecord,
  type RemoteWorkerChatContextSnapshot,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { RemoteWorkerChatExecution } from "./remote-worker-chat-execution-service.js";

interface DurableChatWorkerPort {
  storage: { remoteWorkerChatContexts?: Pick<AsyncStorage["remoteWorkerChatContexts"], "findForRun"> };
  resolveRemoteWorkerChatExecution?(
    run: DurableRunRecord,
    prepared: PreparedAgentChatTurn,
  ): Promise<RemoteWorkerChatExecution | undefined>;
}

/** Frozen worker input is authority, not a cache that can fall back to live history. */
export async function loadDurableChatWorkerContext(
  host: DurableChatWorkerPort,
  run: DurableRunRecord,
): Promise<RemoteWorkerChatContextSnapshot | undefined> {
  const remoteContext =
    run.metadata?.remoteWorkerChatContextSha256 === undefined
      ? undefined
      : await host.storage.remoteWorkerChatContexts?.findForRun(run.runId);
  if (
    run.metadata?.remoteWorkerChatContextSha256 !== undefined &&
    (!remoteContext ||
      verifyRemoteWorkerChatContextBinding(remoteContext, run.payload).contextSha256 !==
        run.metadata.remoteWorkerChatContextSha256)
  )
    throw new Error(`Durable Chat run ${run.runId} lost its frozen worker context.`);
  return remoteContext;
}

/** Preserve the admitted baseline and append only an explicit input-interrupt answer. */
export function injectDurableChatWorkerContext(
  prepared: PreparedAgentChatTurn,
  remoteContext: RemoteWorkerChatContextSnapshot,
  run: DurableRunRecord,
  originalContent: string,
  resumedContent: string,
): void {
  const frozen = verifyRemoteWorkerChatContextBinding(remoteContext, run.payload);
  prepared.history = JSON.parse(canonicalJsonString(frozen.messages));
  if (resumedContent !== originalContent) prepared.history.push({ role: "user", content: resumedContent });
}

/** Resolve retained placement before either the local or remote runner starts. */
export async function resolveDurableChatWorkerExecution(
  host: DurableChatWorkerPort,
  run: DurableRunRecord,
  prepared: PreparedAgentChatTurn,
): Promise<RemoteWorkerChatExecution | undefined> {
  return host.resolveRemoteWorkerChatExecution?.(run, prepared);
}

interface DurableChatWorkerAdmissionPort {
  remoteWorkerChatContexts?: Pick<AsyncStorage["remoteWorkerChatContexts"], "freezeForAdmission">;
}

/** Build the immutable reference before creating the run inside admission's transaction. */
export function prepareDurableChatWorkerContext(
  deps: DurableChatWorkerAdmissionPort,
  prepared: PreparedAgentChatTurn,
  runId: string,
  payload: unknown,
  required: boolean,
): RemoteWorkerChatContextSnapshot | undefined {
  return prepared.turnAdmission && prepared.capabilityProfile && deps.remoteWorkerChatContexts
    ? (required ? sealRemoteWorkerChatContextForTurn : trySealRemoteWorkerChatContextForTurn)(
        runId,
        payload,
        prepared.history,
      )
    : undefined;
}

/** Retain the context after run creation, before committing the same admission transaction. */
export async function retainDurableChatWorkerContext(
  deps: DurableChatWorkerAdmissionPort,
  prepared: PreparedAgentChatTurn,
  runId: string,
  context: RemoteWorkerChatContextSnapshot | undefined,
): Promise<void> {
  if (context && deps.remoteWorkerChatContexts) {
    if (!prepared.turnAdmission?.requestClaim)
      throw new Error(`Remote Chat context for ${prepared.turnId} requires its request-runtime admission.`);
    await deps.remoteWorkerChatContexts.freezeForAdmission({
      durableRunId: runId,
      messages: prepared.history,
      requestRuntimeClaim: prepared.turnAdmission.requestClaim,
    });
  }
}
