import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  type ChatArtifactRenderRecord,
  type ChatArtifactRenderResponse,
  type ChatAttachmentRecord,
  type ChatGeneratedArtifactRecord,
} from "@goatcitadel/contracts";
import {
  BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE,
  HTML_RENDER_DEFAULT_VIEWPORTS,
  isMissingPlaywrightBrowserError,
  renderHtmlSnapshot as renderHtmlSnapshotDefault,
  type HtmlRenderViewport,
} from "@goatcitadel/policy-engine";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { AttachmentReadLimitError, MAX_CHAT_ATTACHMENT_BYTES, readChatAttachmentContent } from "./chat-attachment-service.js";
import { projectChatGeneratedArtifactForPublic } from "./chat-secret-projection.js";

/**
 * Renders `html` generated artifacts into PNG evidence stored as chat attachments. Renders are
 * reused only through scoped, versioned renderer receipts whose stored PNG bytes still verify.
 */

export interface HtmlArtifactRenderDependencies {
  readonly config: Pick<GatewayRuntimeConfig, "rootDir" | "assistant" | "toolPolicy">;
  readonly storage: Pick<Storage, "chatAttachments">;
  getChatGeneratedArtifact(artifactId: string, options: { workspaceId: string }): Promise<ChatGeneratedArtifactRecord>;
  uploadChatAttachment(input: {
    sessionId: string;
    projectId?: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
    analysis?: "skip";
  }): Promise<ChatAttachmentRecord>;
  /** Injectable for tests; defaults to the policy-engine renderer. */
  renderHtmlSnapshot?: typeof renderHtmlSnapshotDefault;
}

const RENDER_FILE_PREFIX = "render-";
const RENDER_FILE_SUFFIX = ".png";
const RENDER_SCRATCH_DIR = ".artifact-renders";
/** Bump when rendering semantics or the viewport profile changes. */
export const HTML_ARTIFACT_RENDERER_VERSION = "html-snapshot.v1";

/** One render per artifact and content hash at a time; concurrent callers share the same promise. */
const inFlightRenders = new Map<string, Promise<ChatArtifactRenderResponse>>();

export async function renderChatGeneratedArtifact(
  deps: HtmlArtifactRenderDependencies,
  artifactId: string,
  workspaceId: string,
): Promise<ChatArtifactRenderResponse> {
  const artifact = await loadRenderableArtifact(deps, artifactId, workspaceId);
  const contentHash = resolveContentHash(artifact);
  const flightKey = JSON.stringify(renderIdentity(artifact, contentHash));
  const inFlight = inFlightRenders.get(flightKey);
  if (inFlight) return inFlight;
  const flight = renderOrReuse(deps, artifact, contentHash).finally(() => {
    inFlightRenders.delete(flightKey);
  });
  inFlightRenders.set(flightKey, flight);
  return flight;
}

async function renderOrReuse(
  deps: HtmlArtifactRenderDependencies,
  artifact: ChatGeneratedArtifactRecord,
  contentHash: string,
): Promise<ChatArtifactRenderResponse> {
  const existing = await listStoredRenders(deps, artifact, contentHash);
  if (coversEveryViewport(existing)) {
    return { artifactId: artifact.artifactId, contentHash, renders: existing };
  }

  const render = deps.renderHtmlSnapshot ?? renderHtmlSnapshotDefault;
  const writeJailRoots = deps.config.toolPolicy.sandbox.writeJailRoots;
  const outputDir = path.resolve(
    deps.config.rootDir,
    deps.config.assistant.workspaceDir,
    RENDER_SCRATCH_DIR,
    `${sanitizePathSegment(artifact.artifactId)}-${randomUUID()}`,
  );
  const uploaded: ChatArtifactRenderRecord[] = [];
  try {
    const result = await render({ html: artifact.content, outputDir, writeJailRoots }).catch((error: unknown) => {
      throw mapRenderFailure(error);
    });
    for (const snapshot of result.renders) {
      const bytes = await fs.readFile(snapshot.path);
      const attachment = await deps.uploadChatAttachment({
        sessionId: artifact.sessionId,
        projectId: artifact.projectId,
        fileName: renderFileName(contentHash, snapshot.viewport),
        mimeType: "image/png",
        bytes,
        analysis: "skip",
      });
      const viewport = HTML_RENDER_DEFAULT_VIEWPORTS.find((item) => item.name === snapshot.viewport);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!viewport || snapshot.width !== viewport.width || snapshot.height !== viewport.height ||
          !matchesPngViewport(bytes, viewport) || attachment.sessionId !== artifact.sessionId ||
          (attachment.workspaceId ?? "default") !== (artifact.workspaceId ?? "default") ||
          attachment.mimeType !== "image/png" || attachment.mediaType !== "image" ||
          attachment.sha256 !== sha256 || attachment.sizeBytes !== bytes.length) {
        throw new ConflictError({ code: "STATE_CONFLICT", message: "Renderer output does not match its attachment evidence." });
      }
      uploaded.push(await deps.storage.chatAttachments.recordArtifactRender({ ...renderIdentity(artifact, contentHash),
        viewport: viewport.name, width: viewport.width, height: viewport.height, attachmentId: attachment.attachmentId, sha256 }));
    }
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { artifactId: artifact.artifactId, contentHash, renders: uploaded };
}

export async function listChatArtifactRenders(
  deps: HtmlArtifactRenderDependencies,
  artifactId: string,
  workspaceId: string,
): Promise<ChatArtifactRenderResponse> {
  const artifact = await loadArtifact(deps, artifactId, workspaceId);
  const contentHash = resolveContentHash(artifact);
  return {
    artifactId: artifact.artifactId,
    contentHash,
    renders: await listStoredRenders(deps, artifact, contentHash),
  };
}

async function loadRenderableArtifact(
  deps: HtmlArtifactRenderDependencies,
  artifactId: string,
  workspaceId: string,
): Promise<ChatGeneratedArtifactRecord> {
  const artifact = await loadArtifact(deps, artifactId, workspaceId);
  if (artifact.kind !== "html") {
    throw new ConflictError({ code: "STATE_CONFLICT", message: "Only html artifacts can be rendered." });
  }
  // The composed service receives the stored record; apply the same secret projection the artifact
  // routes apply so a secret in the markup never reaches a PNG or an image provider.
  const projection = projectChatGeneratedArtifactForPublic(artifact).publicProjection ?? artifact.publicProjection;
  if (projection?.contentRedacted || projection?.artifactRedacted) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: "Redacted artifacts cannot be rendered; the stored content would not match the projection.",
    });
  }
  return artifact;
}

async function listStoredRenders(
  deps: HtmlArtifactRenderDependencies,
  artifact: ChatGeneratedArtifactRecord,
  contentHash: string,
): Promise<ChatArtifactRenderRecord[]> {
  const receipts = await deps.storage.chatAttachments.listArtifactRenders(renderIdentity(artifact, contentHash));
  const verified: ChatArtifactRenderRecord[] = [];
  for (const viewport of HTML_RENDER_DEFAULT_VIEWPORTS) {
    const receipt = receipts.find((item) => item.viewport === viewport.name && item.artifactId === artifact.artifactId &&
      item.contentHash === contentHash && item.width === viewport.width && item.height === viewport.height);
    if (!receipt) continue;
    let attachment: Awaited<ReturnType<typeof readChatAttachmentContent>>;
    try {
      attachment = await readChatAttachmentContent(deps, receipt.attachmentId, {
        sessionId: artifact.sessionId, maxBytes: MAX_CHAT_ATTACHMENT_BYTES,
      });
    } catch (error) {
      if (
        error instanceof AttachmentReadLimitError ||
        error instanceof NotFoundError ||
        (error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        continue;
      }
      throw error;
    }
    const { record, bytes } = attachment;
    if (record.attachmentId !== receipt.attachmentId || record.sessionId !== artifact.sessionId ||
        (record.workspaceId ?? "default") !== (artifact.workspaceId ?? "default") || record.mimeType !== "image/png" ||
        record.mediaType !== "image" || record.sha256 !== receipt.sha256 || record.sizeBytes !== bytes.length ||
        createHash("sha256").update(bytes).digest("hex") !== receipt.sha256 || !matchesPngViewport(bytes, viewport)) continue;
    verified.push(receipt);
  }
  return verified;
}

async function loadArtifact(deps: HtmlArtifactRenderDependencies, artifactId: string, workspaceId: string): Promise<ChatGeneratedArtifactRecord> {
  return await deps.getChatGeneratedArtifact(artifactId.trim(), { workspaceId: workspaceId.trim() });
}

function renderIdentity(artifact: ChatGeneratedArtifactRecord, contentHash: string) {
  return { artifactId: artifact.artifactId, artifactVersion: artifact.version, sessionId: artifact.sessionId,
    workspaceId: artifact.workspaceId ?? "default", contentHash, rendererVersion: HTML_ARTIFACT_RENDERER_VERSION };
}

/** IHDR is the PNG's canonical pixel geometry; the receipt also binds every file byte. */
function matchesPngViewport(bytes: Buffer, viewport: HtmlRenderViewport): boolean {
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) === viewport.width && bytes.readUInt32BE(20) === viewport.height;
}
/**
 * Renderer failures the operator must read: a missing Chromium is a 503 carrying the manual-install
 * diagnostic, oversize markup is a 409; anything else stays a plain error (500, redacted).
 */
function mapRenderFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isMissingPlaywrightBrowserError(error) || message.startsWith(BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE)) {
    return new ServiceUnavailableError(message, { code: BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE });
  }
  if (message.startsWith("html_render_too_large")) {
    return new ConflictError({ code: "STATE_CONFLICT", message });
  }
  return error instanceof Error ? error : new Error(message);
}

function coversEveryViewport(renders: ChatArtifactRenderRecord[]): boolean {
  const present = new Set(renders.map((render) => render.viewport));
  return HTML_RENDER_DEFAULT_VIEWPORTS.every((viewport) => present.has(viewport.name));
}

function resolveContentHash(artifact: ChatGeneratedArtifactRecord): string {
  const stored = artifact.contentHash?.trim().toLowerCase();
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return stored;
  return createHash("sha256").update(artifact.content, "utf8").digest("hex");
}

function hash16(contentHash: string): string {
  return contentHash.slice(0, 16);
}

export function renderFileName(contentHash: string, viewport: string): string {
  return `${RENDER_FILE_PREFIX}${hash16(contentHash)}-${sanitizePathSegment(viewport)}${RENDER_FILE_SUFFIX}`;
}

function sanitizePathSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "artifact";
}
