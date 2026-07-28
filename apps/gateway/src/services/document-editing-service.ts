import { createHash, randomUUID } from "node:crypto";
import {
  DOCUMENT_EDITABLE_ARTIFACT_KINDS,
  DOCUMENT_PATCH_PROPOSAL_SCHEMA_VERSION,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ChatGeneratedArtifactRecord,
  type CreateDocumentPatchProposalRequest,
  type CreateGeneratedArtifactVersionRequest,
  type DocumentPatchProposalRecord,
  type DocumentPatchProposalToolInput,
} from "@goatcitadel/contracts";
import { PersonalOpsStorageRepository, type Storage } from "@goatcitadel/storage";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface DocumentEditingDependencies {
  storage: Pick<Storage, "db" | "chatGeneratedArtifacts" | "chatTurnTraces" | "documentPatchProposals">;
  requireChatSession(sessionId: string): { sessionId: string; workspaceId?: string };
}

export class DocumentEditingService {
  private readonly notes: PersonalOpsStorageRepository;

  public constructor(private readonly deps: DocumentEditingDependencies) {
    this.notes = new PersonalOpsStorageRepository(deps.storage.db);
  }

  public listProposals(input: {
    workspaceId: string;
    sessionId?: string;
    state?: DocumentPatchProposalRecord["state"];
  }) {
    return { items: this.deps.storage.documentPatchProposals.list({ ...input, limit: 200 }) };
  }

  public createProposal(
    input: CreateDocumentPatchProposalRequest & { sessionId?: string },
    actorId: string,
  ): DocumentPatchProposalRecord {
    const workspaceId = required(input.workspaceId, "workspaceId");
    const sessionId = input.sessionId?.trim() || undefined;
    if (sessionId) this.assertSessionWorkspace(sessionId, workspaceId);
    return this.createBoundProposal(input, {
      workspaceId,
      sessionId,
      authorKind: "operator",
      authorId: required(actorId, "actorId"),
    });
  }

  public createAssistantProposal(
    input: DocumentPatchProposalToolInput,
    binding: { workspaceId: string; sessionId: string; turnId: string; authorId: string },
  ): DocumentPatchProposalRecord {
    const workspaceId = required(binding.workspaceId, "workspaceId");
    const sessionId = required(binding.sessionId, "sessionId");
    const turnId = required(binding.turnId, "turnId");
    const trace = this.deps.storage.chatTurnTraces.get(turnId);
    if (trace.sessionId !== sessionId) throw new NotFoundError({ entity: "Assistant turn", id: turnId });
    this.assertSessionWorkspace(sessionId, workspaceId);
    return this.createBoundProposal(input, {
      workspaceId,
      sessionId,
      turnId,
      authorKind: "assistant",
      authorId: required(binding.authorId, "authorId"),
    });
  }

  private createBoundProposal(
    input: DocumentPatchProposalToolInput,
    binding: {
      workspaceId: string;
      sessionId?: string;
      turnId?: string;
      authorKind: DocumentPatchProposalRecord["authorKind"];
      authorId: string;
    },
  ): DocumentPatchProposalRecord {
    const workspaceId = binding.workspaceId;
    const proposedContent = boundedContent(input.proposedContent);
    const base = this.readBase(input.targetKind, input.targetId, workspaceId);
    if (input.targetKind === "personal_note") {
      if (input.baseRevision !== base.revision) {
        throw new ConflictError({ message: "The note changed before this proposal was created." });
      }
    } else if (input.baseContentHash !== base.contentHash) {
      throw new ConflictError({ message: "The generated artifact changed before this proposal was created." });
    }
    const now = new Date().toISOString();
    return this.deps.storage.documentPatchProposals.create({
      proposalId: `dpp_${randomUUID()}`,
      schemaVersion: DOCUMENT_PATCH_PROPOSAL_SCHEMA_VERSION,
      workspaceId,
      sessionId: binding.sessionId,
      targetKind: input.targetKind,
      targetId: input.targetId.trim(),
      baseRevision: base.revision,
      baseContentHash: base.contentHash,
      proposedContent,
      derivedDiff: buildReplacementDiff(base.content, proposedContent),
      authorKind: binding.authorKind,
      authorId: binding.authorId,
      turnId: binding.turnId,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }

  public applyProposal(proposalId: string, workspaceId: string, actorId: string): DocumentPatchProposalRecord {
    const proposal = this.requireProposalScope(proposalId, workspaceId);
    if (proposal.state !== "pending") throw new ConflictError({ message: "Only pending proposals can be applied." });
    const now = new Date().toISOString();
    try {
      if (proposal.targetKind === "personal_note") {
        const note = this.notes.updateNote(
          proposal.targetId,
          {
            body: proposal.proposedContent,
            expectedRevision: proposal.baseRevision,
            actorId,
            proposalId: proposal.proposalId,
          },
          { workspaceId: proposal.workspaceId },
          now,
        );
        return this.deps.storage.documentPatchProposals.settle(proposal.proposalId, "applied", {
          updatedAt: now,
          resolvedBy: actorId,
          appliedTargetId: note.noteId,
          appliedRevision: note.revision,
          appliedContentHash: hashText(note.body),
        });
      }
      const artifact = this.createArtifactVersion(proposal.targetId, {
        workspaceId: proposal.workspaceId,
        baseContentHash: required(proposal.baseContentHash, "baseContentHash"),
        content: proposal.proposedContent,
      });
      return this.deps.storage.documentPatchProposals.settle(proposal.proposalId, "applied", {
        updatedAt: now,
        resolvedBy: actorId,
        appliedTargetId: artifact.artifactId,
        appliedRevision: artifact.version,
        appliedContentHash: artifact.contentHash,
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        this.deps.storage.documentPatchProposals.settle(proposal.proposalId, "conflicted", {
          updatedAt: now,
          resolvedBy: actorId,
          conflictReason: error.message,
        });
      }
      throw error;
    }
  }

  public rejectProposal(proposalId: string, workspaceId: string, actorId: string): DocumentPatchProposalRecord {
    const proposal = this.requireProposalScope(proposalId, workspaceId);
    if (proposal.state !== "pending") throw new ConflictError({ message: "Only pending proposals can be rejected." });
    return this.deps.storage.documentPatchProposals.settle(proposal.proposalId, "rejected", {
      updatedAt: new Date().toISOString(),
      resolvedBy: actorId,
    });
  }

  public createArtifactVersion(
    artifactId: string,
    input: CreateGeneratedArtifactVersionRequest,
  ): ChatGeneratedArtifactRecord {
    const base = this.deps.storage.chatGeneratedArtifacts.get(required(artifactId, "artifactId"));
    if ((base.workspaceId ?? "default") !== required(input.workspaceId, "workspaceId")) {
      throw new NotFoundError({ entity: "Generated artifact", id: artifactId });
    }
    if (!(DOCUMENT_EDITABLE_ARTIFACT_KINDS as readonly string[]).includes(base.kind)) {
      throw new ValidationError({ message: `Generated ${base.kind} artifacts are read-only.` });
    }
    const verifiedBaseHash = hashText(base.content);
    if (
      !HASH_PATTERN.test(input.baseContentHash) ||
      base.contentHash !== verifiedBaseHash ||
      input.baseContentHash !== verifiedBaseHash
    ) {
      throw new ConflictError({ message: "The artifact base hash is stale or invalid." });
    }
    if (this.deps.storage.chatGeneratedArtifacts.findDirectSuccessor(base.artifactId)) {
      throw new ConflictError({ message: "A newer artifact version already supersedes this base." });
    }
    const content = boundedContent(input.content);
    const contentHash = hashText(content);
    const now = new Date().toISOString();
    return this.deps.storage.chatGeneratedArtifacts.create({
      ...base,
      artifactId: `gartv_${randomUUID()}`,
      title: input.title?.trim() || base.title,
      content,
      version: base.version + 1,
      supersedesArtifactId: base.artifactId,
      contentHash,
      sourceBlockIndex: undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  private readBase(kind: DocumentPatchProposalRecord["targetKind"], id: string, workspaceId: string) {
    if (kind === "personal_note") {
      const note = this.notes.getNote(required(id, "targetId"));
      if (note.workspaceId !== workspaceId) throw new NotFoundError({ entity: "Note", id });
      return { content: note.body, contentHash: hashText(note.body), revision: note.revision };
    }
    const artifact = this.deps.storage.chatGeneratedArtifacts.get(required(id, "targetId"));
    if ((artifact.workspaceId ?? "default") !== workspaceId)
      throw new NotFoundError({ entity: "Generated artifact", id });
    if (!(DOCUMENT_EDITABLE_ARTIFACT_KINDS as readonly string[]).includes(artifact.kind)) {
      throw new ValidationError({ message: `Generated ${artifact.kind} artifacts are read-only.` });
    }
    return {
      content: artifact.content,
      contentHash: artifact.contentHash ?? hashText(artifact.content),
      revision: undefined,
    };
  }

  private requireProposalScope(proposalId: string, workspaceId: string) {
    const proposal = this.deps.storage.documentPatchProposals.get(proposalId);
    if (proposal.workspaceId !== workspaceId.trim())
      throw new NotFoundError({ entity: "Document patch proposal", id: proposalId });
    return proposal;
  }

  private assertSessionWorkspace(sessionId: string, workspaceId: string): void {
    const session = this.deps.requireChatSession(sessionId);
    if ((session.workspaceId ?? "default") !== workspaceId)
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
  }
}

function required(value: string | undefined, field: string): string {
  const result = value?.trim();
  if (!result) throw new ValidationError({ code: "FIELD_REQUIRED", field });
  return result;
}

function boundedContent(value: string): string {
  if (typeof value !== "string") throw new ValidationError({ field: "content" });
  if (Buffer.byteLength(value, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new ValidationError({ message: `Document content exceeds ${MAX_DOCUMENT_BYTES} bytes.` });
  }
  return value.replaceAll("\u0000", "");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildReplacementDiff(before: string, after: string): string {
  if (before === after) return "No changes.";
  const beforeLines = before.split(/\r?\n/u);
  const afterLines = after.split(/\r?\n/u);
  return [
    "--- current",
    "+++ proposed",
    "@@ full replacement @@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}
