import { NotFoundError, type LearningUseLink, type TurnLearningReceipt } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";

const log = logger.child("chat-learning-receipt");

function readAdmittedChatTurnContext(storage: Pick<AsyncStorage, "contextManifests">, turnId: string) {
  return storage.contextManifests.maybeGetDetailByTurn(turnId);
}

export async function hasOtherAdmittedRecallEvidence(
  storage: Pick<AsyncStorage, "contextManifests">,
  input: { memoryMode: "auto" | "on" | "off"; turnId: string; userMessageId: string },
): Promise<boolean> {
  if (input.memoryMode === "off") return false;
  try {
    const admitted = await readAdmittedChatTurnContext(storage, input.turnId);
    if (!admitted) return true;
    return admitted.entries.some((entry) => {
      const { admittedMemories, sourceCitations, citationsCount } = entry.metadata;
      if (Array.isArray(admittedMemories) && admittedMemories.length > 0) return true;
      if (entry.kind !== "memory_context") return false;
      // Retrieval can cite the current user message itself. It adds no prior evidence.
      return (
        !Array.isArray(sourceCitations) ||
        (sourceCitations.length === 0 && Boolean(entry.contentText?.trim())) ||
        (typeof citationsCount === "number" && citationsCount > sourceCitations.length) ||
        sourceCitations.some(
          (source) => source?.sourceType !== "transcript" || source.sourceRef !== input.userMessageId,
        )
      );
    });
  } catch {
    log.warn("Could not inspect admitted context for a chat history miss", { turnId: input.turnId });
    return true;
  }
}

export interface ChatLearningReceiptDeps {
  storage: Pick<
    AsyncStorage,
    | "chatSessionMeta"
    | "sessions"
    | "chatTurnTraces"
    | "contextManifests"
    | "modelUsageEvents"
    | "memoryLearnings"
    | "backgroundLearningJobs"
    | "capabilityProposals"
    | "candidateSkillVersions"
  >;
  memory: Pick<MemoryLifecycleService, "listTraceMemoryCandidatesForTurn">;
  readMemoryReady(sessionId: string, workspaceId: string): Promise<boolean>;
}
function admittedSkillHref(ref: string): string {
  const skills = "/capabilities/skills";
  // Derived runtime IDs do not identify an exact catalog version in old receipts.
  return ref.startsWith("extra:reviewed-") ? skills : `${skills}?item=${encodeURIComponent(`skill:${ref}`)}`;
}

export class ChatLearningReceiptService {
  public constructor(private readonly deps: ChatLearningReceiptDeps) {}
  public async getTurnLearningReceipt(
    sessionId: string,
    turnId: string,
    workspaceId?: string,
  ): Promise<TurnLearningReceipt> {
    const [meta, session, trace] = await Promise.all([
      this.deps.storage.chatSessionMeta.get(sessionId),
      this.deps.storage.sessions.getBySessionId(sessionId),
      this.deps.storage.chatTurnTraces.get(turnId),
    ]);
    if (
      !meta ||
      meta.lifecycleStatus !== "active" ||
      meta.origin !== "operator" ||
      session.kind !== "dm" ||
      trace.sessionId !== sessionId ||
      trace.turnId !== turnId ||
      (workspaceId !== undefined && workspaceId !== meta.workspaceId)
    )
      throw new NotFoundError({ entity: "Chat turn", id: turnId });
    const result: TurnLearningReceipt = {
      version: 1,
      workspaceId: meta.workspaceId,
      sessionId,
      turnId,
      proposals: [],
      applied: [],
      usedSources: [],
      jobs: [],
      warnings: [],
      truncated: false,
    };
    const library = `/library/memory?workspaceId=${encodeURIComponent(meta.workspaceId)}`;
    try {
      const [candidates, ready] = await Promise.all([
        this.deps.memory.listTraceMemoryCandidatesForTurn({
          workspaceId: meta.workspaceId,
          sessionId,
          turnId,
          messageIds: [trace.userMessageId, trace.assistantMessageId ?? ""],
        }),
        this.deps.readMemoryReady(sessionId, meta.workspaceId),
      ]);
      result.truncated ||= candidates.truncated;
      for (const candidate of candidates.items) {
        result.proposals.push({ kind: "memory", candidate, href: library });
        if (candidate.promotedLearningId) {
          const learning = await this.deps.storage.memoryLearnings.get(candidate.promotedLearningId);
          if (learning?.workspaceId === meta.workspaceId)
            result.applied.push({
              kind: "memory",
              ref: learning.learningId,
              state:
                learning.status === "trusted"
                  ? ready
                    ? "recall_ready"
                    : "saved_not_ready"
                  : learning.status === "forgotten"
                    ? "forgotten"
                    : learning.status === "superseded"
                      ? "superseded"
                      : "unknown",
              sourceHash: learning.sourceHash,
              href: library,
            });
          else result.warnings.push("A saved-memory receipt is unavailable. Refresh its owner record.");
        }
      }
    } catch {
      result.warnings.push(
        "Memory proposals or reader readiness could not be checked. Open Memory to inspect their current state.",
      );
    }
    const jobs = await this.deps.storage.backgroundLearningJobs.listForSourceTurn(meta.workspaceId, sessionId, turnId);
    result.truncated ||= jobs.length > 50;
    for (const job of jobs.slice(0, 50)) {
      result.jobs.push({
        jobId: job.jobId,
        state: job.status,
        reason: job.reasonCode,
        href: `/work/runs/${encodeURIComponent(job.runId)}`,
      });
      const sourceIndex = job.sources.findIndex((source) => source.sourceTurnId === turnId);
      const scopedSkillIds = job.stageResults
        ? job.stageResults
            .filter((stage) => stage.stage === "skill" && sourceIndex >= stage.from && sourceIndex < stage.through)
            .flatMap((stage) => stage.skillProposalIds)
        : [];
      for (const proposalId of [...new Set(scopedSkillIds)].slice(0, 10)) {
        const proposal = await this.deps.storage.capabilityProposals.find(proposalId);
        if (!proposal?.candidateId) continue;
        const versionId = typeof proposal.payload.versionId === "string" ? proposal.payload.versionId : undefined,
          version = versionId ? await this.deps.storage.candidateSkillVersions.find(versionId) : undefined;
        if (!version || version.workspaceId !== meta.workspaceId || version.candidateId !== proposal.candidateId)
          continue;
        result.proposals.push({
          kind: "skill",
          proposalId,
          candidateId: proposal.candidateId,
          versionId,
          sourceHash: version.instructionArtifact.sha256,
          state: version.lifecycleState,
          href: `/library/candidate_skill/${encodeURIComponent(`candidate:${proposal.candidateId}:${version.versionId}`)}?workspaceId=${encodeURIComponent(meta.workspaceId)}`,
        });
      }
    }
    const { storage } = this.deps;
    const [manifest, usage] = await Promise.all([
      readAdmittedChatTurnContext(storage, turnId),
      storage.modelUsageEvents.list({ workspaceId: meta.workspaceId, sessionId, turnId, limit: 200 }),
    ]);
    if (usage.nextCursor) {
      result.truncated = true;
      result.warnings.push("Some older dispatch evidence is outside this bounded receipt.");
    }
    if (manifest?.manifest.sessionId === sessionId && manifest.manifest.turnId === turnId) {
      for (const entry of manifest.entries.slice(0, 200)) {
        const binding = entry.metadata.usageBinding as
          | { operationId?: unknown; dispatchGeneration?: unknown }
          | undefined;
        if (
          !binding ||
          typeof binding.operationId !== "string" ||
          typeof binding.dispatchGeneration !== "string" ||
          !usage.items.some(
            (attempt) =>
              attempt.workspaceId === meta.workspaceId &&
              attempt.sessionId === sessionId &&
              attempt.turnId === turnId &&
              attempt.operationId === binding.operationId &&
              attempt.dispatchGeneration === binding.dispatchGeneration &&
              attempt.transportStatus === "accepted" &&
              attempt.terminalOutcome === "succeeded",
          )
        )
          continue;
        for (const { skill, sources } of [
          {
            skill: false,
            sources: entry.kind === "memory_context" ? entry.metadata.sourceCitations : entry.metadata.admittedMemories,
          },
          { skill: true, sources: entry.metadata.admittedSkills },
        ]) {
          if (!Array.isArray(sources)) continue;
          if (sources.length > 40) result.truncated = true;
          for (const raw of sources.slice(0, 40)) {
            if (!raw || typeof raw !== "object") continue;
            const source = raw as Record<string, unknown>,
              ref = skill ? source.skillId : source.sourceRef,
              hash = skill ? source.instructionSha256 : source.sourceHash;
            if (
              typeof ref !== "string" ||
              !ref ||
              ref.length > 1024 ||
              typeof hash !== "string" ||
              !/^[a-f0-9]{64}$/u.test(hash)
            )
              continue;
            const used: LearningUseLink = {
              kind: skill ? "skill" : "memory",
              ref,
              sourceHash: hash,
              state: "used_in_turn",
              href: skill ? admittedSkillHref(ref) : library,
            };
            if (
              !result.usedSources.some(
                (link) => link.kind === used.kind && link.ref === ref && link.sourceHash === hash,
              )
            ) {
              if (result.usedSources.length < 80) result.usedSources.push(used);
              else result.truncated = true;
            }
          }
        }
      }
      if (manifest.entries.length > 200) result.truncated = true;
    } else
      result.warnings.push(
        "This turn has no scoped frozen context receipt. Available memory or skills are not counted as used.",
      );
    return result;
  }
}
