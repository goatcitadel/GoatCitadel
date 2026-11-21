import { canonicalJsonString, NotFoundError, type TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { collectChatContinuityLinks } from "./chat-continuity-links.js";

export async function validateConsolidationCandidate(
  learnings: Pick<AsyncStorage["memoryLearnings"], "readConsolidationSource">,
  candidate: TraceMemoryCandidateRecord,
): Promise<boolean> {
  const source = candidate.metadata?.consolidationSource as
    | { workspaceId?: string; sessionId?: string; turnIds?: string[]; sourceHash?: string }
    | undefined;
  if (
    !source ||
    typeof source.workspaceId !== "string" ||
    typeof source.sessionId !== "string" ||
    source.workspaceId !== candidate.workspaceId ||
    source.sessionId !== candidate.sourceSessionId ||
    !Array.isArray(source.turnIds) ||
    typeof source.sourceHash !== "string"
  )
    return false;
  return (
    (
      await learnings.readConsolidationSource({
        workspaceId: source.workspaceId,
        sessionId: source.sessionId,
        turnIds: source.turnIds,
      })
    )?.sourceHash === source.sourceHash
  );
}

export async function validateQueuedLearningCandidate(
  storage: Pick<AsyncStorage, keyof Parameters<typeof collectChatContinuityLinks>[0] | "backgroundLearningJobs">,
  candidate: TraceMemoryCandidateRecord,
): Promise<boolean> {
  const jobId = candidate.metadata?.learningJobId;
  if (typeof jobId !== "string" || !/^blj-[a-f0-9]{40}$/u.test(jobId)) return false;
  const job = await storage.backgroundLearningJobs.get(jobId);
  const refs = candidate.metadata?.learningReviewSources;
  if (
    !job ||
    job.workspaceId !== candidate.workspaceId ||
    job.sessionId !== candidate.sourceSessionId ||
    !job.candidateIds.includes(candidate.candidateId) ||
    !Array.isArray(refs) ||
    refs.length < 1 ||
    refs.length > 50
  )
    return false;
  for (const ref of refs) {
    const source = job.sources.find((source) => canonicalJsonString(source) === canonicalJsonString(ref));
    if (!source) return false;
    const { sourceHash, ...identity } = source;
    const current = await storage.backgroundLearningJobs.readEligibleSource(identity);
    if (current?.source.sourceHash !== sourceHash) return false;
    const evidence = await collectChatContinuityLinks(storage, source.sessionId, [source.sourceTurnId]);
    if (!evidence.complete || evidence.links.some((link) => link.kind === "effect" && !link.completed)) return false;
  }
  return true;
}

export async function readConsolidationChatScope(
  storage: Pick<AsyncStorage, "sessions" | "chatSessionMeta" | "chatSessionPrefs">,
  sessionId: string,
): Promise<{ workspaceId: string } | undefined> {
  try {
    const [session, meta] = await Promise.all([
      storage.sessions.getBySessionId(sessionId),
      storage.chatSessionMeta.get(sessionId),
    ]);
    if (
      session.sessionId !== sessionId ||
      session.kind !== "dm" ||
      meta?.origin !== "operator" ||
      meta.lifecycleStatus !== "active"
    )
      return undefined;
    if ((await storage.chatSessionPrefs.get(sessionId))?.memoryMode === "off") return undefined;
    return { workspaceId: meta.workspaceId };
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}
