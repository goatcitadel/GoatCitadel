import {
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE,
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256,
  remoteWorkerArtifactManifestSha256,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  RemoteWorkerArtifactSettlementService,
  type OpenUploadInput,
  type AppendPartInput,
  type CommitArtifactInput,
} from "./remote-worker-artifact-settlement-service.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { RemoteWorkerVerificationService } from "./remote-worker-verification-service.js";
import { buildRemoteWorkerChatSequenceContext, readCanonicalWorkerChatOutput } from "./remote-worker-chat-output-service.js";

type ArtifactStorage = Pick<
  AsyncStorage,
  "remoteWorkerAssignments" | "remoteWorkerArtifacts" | "remoteWorkerInference" | "runImmediateTransaction" |
  "chatTurnCapabilityProfiles" | "remoteWorkerEffects" | "chatToolRuns" | "approvals"
>;
type AuthorityInput = Pick<
  OpenUploadInput,
  "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "leaseTokenSha256" | "protectedAuthority"
> & {
  continuingArtifact?: NonNullable<Parameters<AsyncStorage["remoteWorkerAssignments"]["resolveActiveChatExecution"]>[0]["continuingArtifact"]>;
};

/** CAS publication and the exact server-owned verifier for a Chat text result. */
export class RemoteWorkerArtifactRuntime {
  private readonly store: RemoteWorkerArtifactStore;
  public constructor(
    private readonly storage: ArtifactStorage,
    root: string,
  ) {
    this.store = new RemoteWorkerArtifactStore(root);
  }

  public async openUpload(input: OpenUploadInput) {
    const execution = await this.authority(input);
    const expiry = Date.parse(input.expiresAt);
    const now = Date.now();
    if (
      !Number.isFinite(expiry) ||
      expiry <= now ||
      expiry > now + 900_000 ||
      input.expiresAt > execution.authority.assignment.manifest.deadlineAt ||
      input.declaredFileCount !== 1 ||
      input.declaredTotalBytes < 1 ||
      input.declaredTotalBytes > REMOTE_WORKER_CHAT_OUTPUT_PROFILE.maxBytes
    )
      throw new Error("Worker Chat upload exceeds its time or output bounds.");
    return await this.owner(input).openUpload(input);
  }
  public async appendPart(input: AppendPartInput) {
    return await this.owner(input).appendPart(input);
  }

  public async commitArtifact(input: CommitArtifactInput) {
    const execution = await this.authority(input);
    if (
      input.manifest.requiredVerifierProfileSha256 !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256 ||
      input.manifest.pathJailSha256 !== execution.authority.assignment.manifest.pathJailSha256 ||
      input.manifest.fileCount !== 1 ||
      input.files.length !== 1 ||
      input.manifest.entries.length !== 1 ||
      input.manifest.totalBytes > REMOTE_WORKER_CHAT_OUTPUT_PROFILE.maxBytes ||
      input.manifest.entries[0]!.logicalPath !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE.logicalPath ||
      input.manifest.entries[0]!.mimeType !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE.mimeType
    ) {
      throw new Error("Worker output does not match the server-owned Chat artifact profile.");
    }
    const entry = input.manifest.entries[0]!,
      file = input.files[0]!;
    if (
      file.logicalPath !== entry.logicalPath ||
      file.logicalPathSha256 !== entry.logicalPathSha256 ||
      file.mimeType !== entry.mimeType ||
      file.bytes.byteLength !== entry.byteCount
    )
      throw new Error("Worker output file differs from its manifest metadata.");
    // The request entered through the exact worker lease fence above. Keep its
    // parent and payload binding while the same upload crosses asynchronous CAS
    // I/O; a routine heartbeat must not revoke our own in-flight publication.
    const publication: AuthorityInput = { ...input, continuingArtifact: {
      uploadId: input.uploadId,
      leaseRevision: execution.authority.lease.leaseRevision,
      parentDispatchAuthority: execution.authority.lease.parentDispatchAuthority,
      durableRunPayloadSha256: execution.workload.durableRunPayloadSha256,
    } };
    await this.owner(publication).commitArtifact(input);
    // Verification is a bounded read/compare, with no uploaded code execution.
    // Keep the canonical verification transitions atomic so a restart cannot
    // mistake a partially written verifier receipt for a passed gate.
    const upload = await this.storage.runImmediateTransaction(async () => {
      await this.authority(publication);
      const current = await this.storage.remoteWorkerArtifacts.getUpload(
        input.registryWorkspaceId,
        input.assignmentId,
        input.assignmentGeneration,
        input.uploadId,
      );
      const manifestSha256 = remoteWorkerArtifactManifestSha256(input.manifest);
      if (current.committedManifestSha256 !== manifestSha256)
        throw new Error("Worker artifact commit identity changed.");
      if (current.verificationGateState === "satisfied") {
        await this.assertCanonicalOutput(
          publication,
          await this.store.readBlob({
            executionWorkspaceId: current.identity.executionWorkspaceId,
            blobSha256: input.manifest.entries[0]!.blobSha256,
            signal: input.signal,
          }),
        );
        return current;
      }
      const verifier = new RemoteWorkerVerificationService({
        repository: this.storage.remoteWorkerArtifacts,
        store: this.store,
        verifier: {
          verify: async ({ profileSha256, manifestSha256: verifying, files }) => {
            if (
              profileSha256 !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256 ||
              verifying !== manifestSha256 ||
              files.length !== 1
            )
              return { outcome: "blocked", summary: "chat_output_profile_mismatch", capturedOutputBytes: 0 };
            await this.assertCanonicalOutput(publication, files[0]!.bytes);
            return { outcome: "passed", summary: "canonical_inference_output_matches", capturedOutputBytes: 0 };
          },
        },
      });
      await verifier.runGatewayVerification({
        registryWorkspaceId: input.registryWorkspaceId,
        assignmentId: input.assignmentId,
        assignmentGeneration: input.assignmentGeneration,
        executionWorkspaceId: current.identity.executionWorkspaceId,
        attemptIndex: 1,
        verifierProfileSha256: REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256,
        manifestSha256,
        blobs: [input.manifest.entries[0]!.blobSha256],
        wallDeadlineAt: current.expiresAt,
        idempotencyKey: `verify-chat:${input.assignmentId}:${input.assignmentGeneration}`,
        signal: input.signal,
      });
      await this.authority(publication);
      return await this.storage.remoteWorkerArtifacts.getUpload(
        input.registryWorkspaceId,
        input.assignmentId,
        input.assignmentGeneration,
        input.uploadId,
      );
    });
    if (upload.verificationGateState !== "satisfied")
      throw new Error("Worker artifact requires verification reconciliation.");
    return upload;
  }

  private owner(input: AuthorityInput): RemoteWorkerArtifactSettlementService {
    const underFence = async <T>(work: () => Promise<T>) =>
      await this.storage.runImmediateTransaction(async () => {
        await this.authority(input);
        return await work();
      });
    return new RemoteWorkerArtifactSettlementService({
      store: this.store,
      authority: {
        assertLiveAuthority: async () => {
          await this.authority(input);
        },
      },
      repository: {
        openUpload: async (command) => await underFence(() => this.storage.remoteWorkerArtifacts.openUpload(command)),
        appendPart: async (command) => await underFence(() => this.storage.remoteWorkerArtifacts.appendPart(command)),
        commitArtifact: async (command) =>
          await underFence(() => this.storage.remoteWorkerArtifacts.commitArtifact(command)),
      },
    });
  }

  private async authority(input: AuthorityInput) {
    if (!input.protectedAuthority) throw new Error("Worker artifact requires protected native admission authority.");
    const execution = await this.storage.remoteWorkerAssignments.resolveActiveChatExecution(
      { registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId,
        assignmentGeneration: input.assignmentGeneration,
        ...(input.continuingArtifact ? { continuingArtifact: input.continuingArtifact } : { leaseTokenSha256: input.leaseTokenSha256 }) },
      input.protectedAuthority,
    );
    if (!execution.authority.assignment.manifest.requiredCapabilityClasses.includes("artifact_stage"))
      throw new Error("Worker assignment does not allow artifact staging.");
    return execution;
  }

  private async assertCanonicalOutput(input: AuthorityInput, bytes: Uint8Array) {
    const execution = await this.authority(input);
    const profile = await this.storage.chatTurnCapabilityProfiles.get(execution.workload.capabilityProfileId);
    if (!profile || profile.hashes.profileHash !== execution.workload.capabilityProfileSha256)
      throw new Error("Worker Chat output lost its admitted capability profile.");
    const { text } = await readCanonicalWorkerChatOutput(this.storage.remoteWorkerInference, input,
      buildRemoteWorkerChatSequenceContext(this.storage, profile, execution));
    if (
      bytes.byteLength > REMOTE_WORKER_CHAT_OUTPUT_PROFILE.maxBytes ||
      !Buffer.from(bytes).equals(Buffer.from(text, "utf8"))
    )
      throw new Error("Worker artifact differs from canonical model output.");
  }
}
