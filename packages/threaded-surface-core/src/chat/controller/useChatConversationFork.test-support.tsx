import type { ChatSessionForkResponse, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";

const now = "2026-09-30T00:00:00Z";
const digest = "a".repeat(64);
export const session = (id: string, workspaceId = "one"): ChatSessionRecord => ({
  sessionId: id,
  workspaceId,
  revision: 3,
  sessionKey: id,
  title: `Conversation ${id}`,
  scope: "mission",
  mode: "chat",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "operator",
  updatedAt: now,
  lastActivityAt: now,
  tokenTotal: 0,
  costUsdTotal: 0,
});
export const thread = (sessionId: string): ChatThreadResponse => ({
  sessionId,
  turns: [
    {
      turnId: `turn-${sessionId}`,
      branchKind: "append",
      toolRuns: [],
      citations: [],
      userMessage: {
        messageId: `message-${sessionId}`,
        sessionId,
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "Fork this",
        timestamp: now,
      },
      trace: {
        turnId: `turn-${sessionId}`,
        sessionId,
        userMessageId: `message-${sessionId}`,
        branchKind: "append",
        status: "completed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        startedAt: now,
        finishedAt: now,
        toolRuns: [],
        citations: [],
        routing: {},
      },
      branch: {
        siblingTurnIds: [`turn-${sessionId}`],
        activeSiblingIndex: 0,
        siblingCount: 1,
        isSelectedPath: true,
        newestLeafTurnId: `turn-${sessionId}`,
      },
    },
  ],
});
export function receipt(id = "a", workspaceId = "one"): ChatSessionForkResponse {
  const forkId = `fork-${id}`,
    newSessionId = `copy-${id}`,
    turnId = `turn-${id}`;
  return {
    session: {
      ...session(newSessionId, workspaceId),
      forkRelationships: [
        {
          forkId,
          direction: "forked_from",
          relatedSessionId: id,
          sourceTurnId: turnId,
          transcriptPathHash: digest,
          createdAt: now,
        },
      ],
    },
    manifest: {
      manifestVersion: "chat.session-fork-manifest.v1",
      forkId,
      sourceSessionId: id,
      sourceTurnId: turnId,
      newSessionId,
      workspaceId,
      transcriptPathHash: digest,
      turnMappings: [
        { sourceTurnId: turnId, copiedTurnId: `copy-${turnId}`, sourceTraceHash: digest, copiedTraceHash: digest },
      ],
      messageMappings: [],
      attachmentCopies: [],
      artifactCopies: [],
      contextSnapshotHashes: [],
      sourceEvidenceHashes: [digest],
      createdByActorId: "operator",
      createdAt: now,
    },
  };
}
