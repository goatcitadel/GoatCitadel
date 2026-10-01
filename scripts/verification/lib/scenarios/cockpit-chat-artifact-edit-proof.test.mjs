import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertArtifactEditVersion, assertArtifactProposal } from "./cockpit-chat-artifact-edit-proof.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const base = { artifactId: "original", workspaceId: "workspace", sessionId: "session", turnId: "turn",
  kind: "markdown", version: 2, content: "Original", contentHash: hash("Original") };
const content = "# Revised\n\nSynthetic text.";
const saved = { ...base, artifactId: "next", version: 3, supersedesArtifactId: base.artifactId,
  content, contentHash: hash(content) };
const proposal = { proposalId: "proposal", workspaceId: base.workspaceId, sessionId: base.sessionId,
  targetKind: "generated_artifact", targetId: base.artifactId, baseContentHash: base.contentHash,
  proposedContent: content, authorKind: "operator", authorId: "operator", state: "pending",
  derivedDiff: "--- current\n+++ proposed\n@@ full replacement @@\n-Original\n+# Revised\n+\n+Synthetic text." };

test("artifact edits require a new exact scoped identity, version chain, and independently computed hash", () => {
  assert.equal(assertArtifactEditVersion(saved, base, content), saved);
  for (const patch of [
    { artifactId: base.artifactId }, { workspaceId: "foreign" }, { sessionId: "other" }, { turnId: "other" },
    { kind: "code" }, { version: 2 }, { version: 4 }, { supersedesArtifactId: "other" },
    { content: "different" }, { contentHash: base.contentHash },
  ]) assert.throws(() => assertArtifactEditVersion({ ...saved, ...patch }, base, content));
});

test("proposal review requires exact scope, base hash, operator provenance, and owner-derived diff", () => {
  assert.equal(assertArtifactProposal(proposal, base, content), proposal);
  for (const patch of [
    { proposalId: undefined }, { workspaceId: "foreign" }, { sessionId: "other" }, { targetKind: "personal_note" },
    { targetId: "other" }, { baseContentHash: "stale" }, { proposedContent: "different" },
    { authorKind: "assistant" }, { authorId: "" }, { state: "applied" }, { derivedDiff: "No changes." },
  ]) assert.throws(() => assertArtifactProposal({ ...proposal, ...patch }, base, content));
});

test("terminal proposal evidence cannot satisfy a different decision or stale draft", () => {
  for (const state of ["applied", "rejected", "conflicted"]) {
    const terminal = { ...proposal, state };
    assert.equal(assertArtifactProposal(terminal, base, content, state), terminal);
    assert.throws(() => assertArtifactProposal(terminal, base, content));
    assert.throws(() => assertArtifactProposal(terminal, base, `${content}\nNew draft`, state));
  }
});
