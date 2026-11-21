import { ConflictError, type ChatCompletionRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

export interface StandingMemoryContext {
  instruction: string;
  sources: Array<{ learningId: string; sourceHash: string }>;
}
export interface StandingMemoryManifestDeps {
  storage: Pick<AsyncStorage, "sessions" | "chatSessionMeta">;
  isEnabled(): Promise<boolean>;
  composeContext(workspaceId: string): Promise<StandingMemoryContext | undefined>;
}

export function completionSystemText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
      : "";
}

/** Current eligibility plus actual model-input bytes, never a naked source marker. */
export async function resolveChatLearningMemoryManifest(
  deps: StandingMemoryManifestDeps,
  request: ChatCompletionRequest,
): Promise<StandingMemoryContext | undefined> {
  const texts = request.messages
    .filter((message) => message.role === "system")
    .map((message) => completionSystemText(message.content));
  const profileTexts = texts.filter((text) => text.includes("Operator profile (durable; persists across sessions):"));
  const refs = profileTexts.flatMap((text) =>
    [...text.matchAll(/\[memory_learning:([a-zA-Z0-9_-]{1,100}) sha256:([a-f0-9]{64})\]/gu)].map((match) => ({
      learningId: match[1]!,
      sourceHash: match[2]!,
    })),
  );
  if (!refs.length) return undefined;
  const refused = () =>
    new ConflictError({
      message:
        "The saved preferences in this turn changed or are unavailable. Refresh this turn's context before continuing.",
    });
  if (refs.length > 64 || request.memory?.enabled === false || !(await deps.isEnabled())) throw refused();
  const sessionId = request.memory?.sessionId;
  if (!sessionId) throw refused();
  const [session, meta] = await Promise.all([
    deps.storage.sessions.getBySessionId(sessionId),
    deps.storage.chatSessionMeta.get(sessionId),
  ]);
  if (
    !meta ||
    session.sessionId !== sessionId ||
    session.kind !== "dm" ||
    meta.origin !== "operator" ||
    meta.lifecycleStatus !== "active"
  )
    throw refused();
  // memory.workspace is a filesystem hint; canonical session metadata owns the workspace.
  const current = await deps.composeContext(meta.workspaceId);
  if (!current?.instruction || !profileTexts.some((text) => text.includes(current.instruction))) throw refused();
  if (
    refs.some(
      (ref) =>
        !current.sources.some((source) => source.learningId === ref.learningId && source.sourceHash === ref.sourceHash),
    )
  )
    throw refused();
  return {
    instruction: current.instruction,
    sources: current.sources
      .filter((source) =>
        refs.some((ref) => ref.learningId === source.learningId && ref.sourceHash === source.sourceHash),
      )
      .map((source) => ({ ...source })),
  };
}
