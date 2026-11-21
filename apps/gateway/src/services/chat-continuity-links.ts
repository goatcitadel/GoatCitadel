import { NotFoundError, isToolEffectEvidenceRecord, type ChatContinuityCanonicalLink } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

type ContinuityStorage = Pick<
  AsyncStorage,
  | "chatSessionMeta"
  | "chatTurnTraces"
  | "chatToolRuns"
  | "chatGeneratedArtifacts"
  | "approvalEffects"
  | "externalSideEffectRuns"
>;
export async function collectChatContinuityLinks(
  storage: ContinuityStorage,
  sessionId: string,
  turnIds: string[],
): Promise<{ links: ChatContinuityCanonicalLink[]; complete: boolean }> {
  if (!sessionId.trim() || turnIds.length > 64) return { links: [], complete: false };
  const meta = await storage.chatSessionMeta.get(sessionId);
  if (!meta || meta.lifecycleStatus !== "active") return { links: [], complete: false };
  const traces = await storage.chatTurnTraces.getByTurnIds(turnIds);
  if (turnIds.some((turnId) => traces.get(turnId)?.sessionId !== sessionId)) return { links: [], complete: false };
  const links: ChatContinuityCanonicalLink[] = [];
  for (const turnId of turnIds) {
    const [tools, artifacts] = await Promise.all([
      storage.chatToolRuns.listByTurnPage(turnId, undefined, 32),
      storage.chatGeneratedArtifacts.listByTurn(turnId, 17),
    ]);
    if (tools.length === 32) {
      const last = tools.at(-1)!;
      if (
        (await storage.chatToolRuns.listByTurnPage(turnId, { startedAt: last.startedAt, toolRunId: last.toolRunId }, 1))
          .length
      )
        return { links: [], complete: false };
    }
    if (artifacts.length > 16) return { links: [], complete: false };
    for (const artifact of artifacts) {
      if (artifact.sessionId !== sessionId || artifact.workspaceId !== meta.workspaceId || artifact.turnId !== turnId)
        continue;
      links.push({
        kind: "artifact",
        canonicalRef: `artifact:${artifact.artifactId}:v${artifact.version}:${artifact.contentHash}`,
        label: artifact.title,
        completed: true,
      });
    }
    for (const tool of tools) {
      if (tool.sessionId !== sessionId || tool.turnId !== turnId) continue;
      const evidence = tool.effectEvidence;
      if (
        !isToolEffectEvidenceRecord(evidence) ||
        evidence.reason === "legacy_or_malformed_effect_truth" ||
        evidence.outcomeKind === "none"
      )
        continue;
      let confirmed = false;
      if (evidence.outcomeKind === "concrete" && evidence.reason === "canonical_effect_receipt_linked") {
        for (const ref of evidence.refs.slice(0, 8)) {
          try {
            if (ref.owner === "approval_effect") {
              const effect = await storage.approvalEffects.get(ref.refId);
              const targetMatches =
                effect.targetKind === "chat_turn"
                  ? effect.targetId === turnId
                  : effect.targetKind === "durable_run" && effect.targetId === traces.get(turnId)?.durable?.runId;
              if (effect.status !== "completed" || !targetMatches) continue;
            } else if (ref.owner === "external_side_effect") {
              const effect = await storage.externalSideEffectRuns.get(ref.refId);
              if (effect.status !== "completed" || effect.workspaceId !== meta.workspaceId) continue;
            } else continue;
            // The persisted v1 projection was correlated out-of-band by its execution owner.
            // Recheck the live owner; never rebuild proof from provider result JSON.
            links.push({
              kind: "effect",
              canonicalRef: `${ref.owner}:${ref.refId}`,
              label: `Recorded effect for ${tool.toolName}`,
              completed: true,
            });
            confirmed = true;
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
          }
        }
      }
      if (!confirmed)
        links.push({
          kind: "effect",
          canonicalRef: `tool-run:${tool.toolRunId}`,
          label: `${tool.toolName}: outcome uncertain; reconciliation required before retry`,
          completed: false,
        });
    }
    if (links.length > 64) return { links: [], complete: false };
  }
  const current = await storage.chatSessionMeta.get(sessionId);
  if (current?.workspaceId !== meta.workspaceId || current.lifecycleStatus !== "active")
    return { links: [], complete: false };
  return { links: [...new Map(links.map((link) => [link.canonicalRef, link])).values()], complete: true };
}
