/* eslint-disable no-control-regex -- Reject or strip control characters in untrusted Google content and filenames. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertNativeGoogleArguments,
  canonicalJsonString,
  isNativeGoogleTool,
  nativeGoogleAction,
  GOOGLE_MAIL_COMPOSE_PROPERTIES,
  type ToolInvokeRequest,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import {
  assertToolWritePath,
  googleMailMaterial,
  prepareGoogleMail,
  projectGoogleMessage,
  type GoogleFilePort,
  type PreparedGoogleMail,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import { ExternalSourceArtifactStore } from "./external-source-artifact-store.js";

const MAX_SNAPSHOT = 48 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAIL_ACTIONS = new Set([
  "gmail.send",
  "gmail.reply",
  "gmail.forward",
  "gmail.save_draft",
  "gmail.delete_draft",
  "gmail.send_draft",
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export interface GoogleReviewDependencies {
  storage: Pick<AsyncStorage, "chatToolRuns" | "chatSessionMeta">;
  dataRoot: string;
  sandbox: () => ToolPolicyConfig["sandbox"];
  snapshotStore?: Pick<ExternalSourceArtifactStore, "publish" | "read">;
}
/** Immutable account/session-scoped evidence; raw MIME and attachment bytes never enter model-facing results. */
export class GoogleWorkspaceReviewService {
  private readonly snapshots: Pick<ExternalSourceArtifactStore, "publish" | "read">;
  public constructor(private readonly deps: GoogleReviewDependencies) {
    this.snapshots = deps.snapshotStore ?? new ExternalSourceArtifactStore(deps.dataRoot);
  }
  public async captureSource(
    request: ToolInvokeRequest,
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.assertScope(request);
    const bytes = Buffer.from(
      canonicalJsonString({
        version: 1,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        connectionId: request.args.connectionId,
        signInId: request.googleReadSignInId,
        source,
      }),
    );
    if (bytes.length > MAX_SNAPSHOT) throw new Error("blocked: Google message snapshot exceeds the review size limit.");
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const chunk = bytes.subarray(offset, offset + CHUNK);
      const published = await this.snapshots.publish({
        bytes: chunk,
        expectedSha256: digest(chunk),
        signal: AbortSignal.timeout(30_000),
      });
      parts.push({ artifactRelPath: published.artifactRelPath, artifactSha256: published.artifactSha256 });
    }
    return { version: 1, sha256: digest(bytes), parts };
  }
  public async readSnapshot(request: ToolInvokeRequest, reference: unknown): Promise<Record<string, unknown>> {
    await this.assertScope(request);
    const ref = record(reference);
    if (
      ref.version !== 1 ||
      !/^[a-f0-9]{64}$/u.test(String(ref.sha256)) ||
      !Array.isArray(ref.parts) ||
      !ref.parts.length ||
      ref.parts.length > MAX_SNAPSHOT / CHUNK
    )
      throw new Error("blocked: Invalid Google review snapshot.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const value of ref.parts) {
      const part = record(value);
      const loaded = await this.snapshots.read({
        artifactRelPath: String(part.artifactRelPath),
        expectedSha256: String(part.artifactSha256),
        signal: AbortSignal.timeout(30_000),
      });
      total += loaded.bytes.length;
      if (total > MAX_SNAPSHOT) throw new Error("blocked: Google review snapshot exceeds its byte limit.");
      chunks.push(loaded.bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== ref.sha256) throw new Error("blocked: Google review snapshot changed.");
    const envelope = record(JSON.parse(bytes.toString("utf8")));
    if (
      envelope.version !== 1 ||
      envelope.workspaceId !== request.workspaceId ||
      envelope.sessionId !== request.sessionId ||
      envelope.connectionId !== request.args.connectionId ||
      envelope.signInId !== request.googleReadSignInId
    )
      throw new Error(
        "blocked: This Google review belongs to another Chat, workspace, account or sign-in. Read the source again.",
      );
    return record(envelope.source);
  }
  public async normalize(request: ToolInvokeRequest): Promise<ToolInvokeRequest> {
    if (!isNativeGoogleTool(request.toolName)) return request;
    const preparedMail = MAIL_ACTIONS.has(request.toolName) && request.args._googlePreparedSnapshot;
    if (!preparedMail) assertNativeGoogleArguments(request.toolName, request.args);
    if (!MAIL_ACTIONS.has(request.toolName) && request.toolName !== "gmail.download_attachment") return request;
    if (request.args._googlePreparedSnapshot) {
      const saved = await this.readSnapshot(request, request.args._googlePreparedSnapshot);
      const prepared = record(saved.prepared) as unknown as PreparedGoogleMail;
      if (
        saved.kind !== "prepared-mail" ||
        prepared.toolName !== request.toolName ||
        prepared.materialHash !== googleMailMaterial(request.args)
      )
        throw new Error("blocked: The reviewed email changed. Request a fresh approval.");
      return {
        ...request,
        args: {
          ...record(saved.reviewArgs),
          _googlePreparedSnapshot: request.args._googlePreparedSnapshot,
          _googleMimeSha256: prepared.sha256,
        },
      };
    }
    const definition = nativeGoogleAction(request.toolName);
    const properties = record(definition?.argSchema.properties ?? GOOGLE_MAIL_COMPOSE_PROPERTIES);
    const args = Object.fromEntries(Object.entries(request.args).filter(([key]) => !key.startsWith("_google")));
    if (Object.keys(args).some((key) => !Object.hasOwn(properties, key)))
      throw new Error("blocked: Unsupported email action fields. Use the native tool's declared arguments.");
    let source: Record<string, unknown> | undefined;
    if (args.sourceToolRunId) source = await this.readSource(request, String(args.sourceToolRunId));
    if (
      ["gmail.reply", "gmail.forward", "gmail.send_draft", "gmail.delete_draft", "gmail.download_attachment"].includes(
        request.toolName,
      ) &&
      !source
    )
      throw new Error("blocked: Read the original message or draft with its native Google tool before this action.");
    if (args.draftId && request.toolName === "gmail.save_draft" && source?.kind !== "draft")
      throw new Error("blocked: Read the saved draft before updating it.");
    if (request.toolName === "gmail.download_attachment") {
      if (source?.kind !== "message") throw new Error("blocked: Attachment download requires a complete message read.");
      const message = projectGoogleMessage(source.full);
      if (
        message.id !== args.messageId ||
        !message.attachments.some((item) => item.attachmentId === args.attachmentId && item.filename === args.filename)
      )
        throw new Error("blocked: The attachment does not belong to the reviewed message.");
      return { ...request, args: { ...args, _googleAttachmentSourceHash: message.contentHash } };
    }
    const prepared = await prepareGoogleMail(
      request.toolName,
      args,
      this.filePort(request),
      source,
      new Date().toISOString(),
    );
    const reference = await this.captureSource(request, {
      kind: "prepared-mail",
      prepared: prepared.prepared,
      reviewArgs: prepared.args,
    });
    return {
      ...request,
      args: { ...prepared.args, _googlePreparedSnapshot: reference, _googleMimeSha256: prepared.prepared.sha256 },
    };
  }
  public async resolvePreparedMail(request: ToolInvokeRequest): Promise<PreparedGoogleMail | undefined> {
    if (!request.args._googlePreparedSnapshot) return undefined;
    const saved = await this.readSnapshot(request, request.args._googlePreparedSnapshot);
    if (saved.kind !== "prepared-mail" || record(saved.prepared).toolName !== request.toolName)
      throw new Error("blocked: Invalid prepared email review.");
    return record(saved.prepared) as unknown as PreparedGoogleMail;
  }
  public filePort(request: ToolInvokeRequest): GoogleFilePort {
    return {
      read: async (reference) => {
        await this.assertScope(request);
        const resolved = assertToolWritePath(reference.path, this.deps.sandbox());
        const file = await fs.open(resolved, "r");
        try {
          const before = await file.stat();
          const real = assertToolWritePath(await fs.realpath(resolved), this.deps.sandbox());
          const observed = await fs.stat(real);
          if (
            !before.isFile() ||
            before.size > MAX_ATTACHMENT ||
            before.dev !== observed.dev ||
            before.ino !== observed.ino
          )
            throw new Error("blocked: Attachment is not a stable governed file.");
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await file.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          const after = await file.stat();
          if (
            offset !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            digest(bytes) !== reference.sha256
          )
            throw new Error("blocked: Attachment changed after review.");
          return bytes;
        } finally {
          await file.close();
        }
      },
      write: async (input) => {
        await this.assertScope(request);
        if (
          input.bytes.length > MAX_ATTACHMENT ||
          !/^[^\\/:<>"|?*\x00-\x1f]{1,255}$/u.test(input.filename) ||
          /[. ]$/u.test(input.filename)
        )
          throw new Error("blocked: Unsafe attachment filename or size.");
        const sandbox = this.deps.sandbox();
        const root = sandbox.writeJailRoots[0];
        if (!root) throw new Error("blocked: No governed artifact write root is configured.");
        const sha256 = digest(input.bytes);
        const target = assertToolWritePath(path.resolve(root, ".google-attachments", sha256, input.filename), sandbox);
        await fs.mkdir(path.dirname(target), { recursive: true });
        assertToolWritePath(target, this.deps.sandbox());
        try {
          await fs.writeFile(target, input.bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const reference = { path: target, sha256, filename: input.filename, contentType: input.contentType };
        await this.filePort(request).read(reference);
        return reference;
      },
    };
  }
  private async readSource(request: ToolInvokeRequest, toolRunId: string): Promise<Record<string, unknown>> {
    const run = await this.deps.storage.chatToolRuns.get(toolRunId);
    if (
      run.status !== "executed" ||
      run.sessionId !== request.sessionId ||
      !["gmail.get_message", "gmail.get_draft"].includes(run.toolName) ||
      (run.args?.connectionId !== undefined && run.args.connectionId !== request.args.connectionId)
    )
      throw new Error("blocked: Use a successful complete message/draft read from this Chat and Google account.");
    return this.readSnapshot(request, run.result?.googleSourceSnapshot);
  }
  private async assertScope(request: ToolInvokeRequest): Promise<void> {
    const session = await this.deps.storage.chatSessionMeta.get(request.sessionId);
    const operatorComms =
      request.sessionId === "session:operator:comms" && request.agentId === "operator" && !request.turnId;
    if (
      !request.workspaceId ||
      (!operatorComms && session?.workspaceId !== request.workspaceId) ||
      !request.googleReadSignInId ||
      !request.args.connectionId
    )
      throw new Error("blocked: A bound Chat, workspace and Google sign-in are required for message review.");
  }
}
