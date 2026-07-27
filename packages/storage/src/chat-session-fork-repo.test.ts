import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_SESSION_FORK_MANIFEST_VERSION, type ChatSessionForkManifest } from "@goatcitadel/contracts";
import { Storage } from "./index.js";

describe("ChatSessionForkRepository", () => {
  it("keeps immutable fork provenance after the source session is deleted", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    const now = "2026-07-27T20:00:00.000Z";
    for (const sessionId of ["source", "forked"]) {
      storage.sessions.upsert({
        sessionId,
        sessionKey: `mission:operator:${sessionId}`,
        kind: "dm",
        channel: "mission",
        account: "operator",
        timestamp: now,
      });
      storage.chatSessionMeta.ensure(sessionId, now, "workspace-1");
    }
    const manifest: ChatSessionForkManifest = {
      manifestVersion: CHAT_SESSION_FORK_MANIFEST_VERSION,
      forkId: "fork-1",
      sourceSessionId: "source",
      sourceTurnId: "turn-1",
      newSessionId: "forked",
      workspaceId: "workspace-1",
      transcriptPathHash: "a".repeat(64),
      turnMappings: [],
      messageMappings: [],
      attachmentCopies: [],
      artifactCopies: [],
      contextSnapshotHashes: [],
      sourceEvidenceHashes: [],
      createdByActorId: "operator",
      createdAt: now,
    };
    storage.chatSessionForks.create(manifest);
    assert.equal(storage.chatSessionForks.listRelationships("source", "workspace-1")[0]?.direction, "forked_to");
    assert.equal(storage.chatSessionForks.listRelationships("forked", "workspace-1")[0]?.direction, "forked_from");
    assert.deepEqual(storage.chatSessionForks.listRelationships("forked", "other-workspace"), []);

    storage.deleteChatSessionDataWithRevision("source", storage.chatSessionMeta.get("source")!.revision);
    assert.deepEqual(storage.chatSessionForks.get("fork-1"), manifest);
    assert.equal(storage.chatSessionForks.listRelationships("forked", "workspace-1")[0]?.relatedSessionId, "source");
    storage.close();
  });
});
