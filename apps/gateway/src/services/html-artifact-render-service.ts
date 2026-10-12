import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ConflictError,
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

/**
 * Renders `html` generated artifacts into PNG evidence stored as chat attachments. Renders are
 * keyed by the artifact's content hash: a repeat request for unchanged content returns the stored
 * attachments without launching the browser again.
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
    bytesBase64: string;
    analysis?: "skip";
  }): Promise<ChatAttachmentRecord>;
  /** Injectable for tests; defaults to the policy-engine renderer. */
  renderHtmlSnapshot?: typeof renderHtmlSnapshotDefault;
}

const RENDER_FILE_PREFIX = "render-";
const RENDER_FILE_SUFFIX = ".png";
const RENDER_SCRATCH_DIR = ".artifact-renders";
const ATTACHMENT_LIST_LIMIT = 2000;

export async function renderChatGeneratedArtifact(
  deps: HtmlArtifactRenderDependencies,
  artifactId: string,
  workspaceId: string,
): Promise<ChatArtifactRenderResponse> {
  const artifact = await loadRenderableArtifact(deps, artifactId, workspaceId);
  const contentHash = resolveContentHash(artifact);
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
        bytesBase64: bytes.toString("base64"),
        analysis: "skip",
      });
      uploaded.push(
        toRenderRecord(artifact.artifactId, contentHash, attachment, {
          name: snapshot.viewport,
          width: snapshot.width,
          height: snapshot.height,
        }),
      );
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
  const artifact = await deps.getChatGeneratedArtifact(artifactId.trim(), { workspaceId: workspaceId.trim() });
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
  const artifact = await deps.getChatGeneratedArtifact(artifactId.trim(), { workspaceId: workspaceId.trim() });
  if (artifact.kind !== "html") {
    throw new ConflictError({ code: "STATE_CONFLICT", message: "Only html artifacts can be rendered." });
  }
  if (artifact.publicProjection?.contentRedacted || artifact.publicProjection?.artifactRedacted) {
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
  const prefix = `${RENDER_FILE_PREFIX}${hash16(contentHash)}-`;
  const attachments = await deps.storage.chatAttachments.listBySession(
    artifact.sessionId,
    ATTACHMENT_LIST_LIMIT,
    artifact.workspaceId,
  );
  const byViewport = new Map<string, ChatArtifactRenderRecord>();
  for (const attachment of attachments) {
    if (!attachment.fileName.startsWith(prefix) || !attachment.fileName.endsWith(RENDER_FILE_SUFFIX)) continue;
    const viewportName = attachment.fileName.slice(prefix.length, -RENDER_FILE_SUFFIX.length);
    const viewport = HTML_RENDER_DEFAULT_VIEWPORTS.find((candidate) => candidate.name === viewportName);
    if (!viewport || byViewport.has(viewport.name)) continue;
    byViewport.set(viewport.name, toRenderRecord(artifact.artifactId, contentHash, attachment, viewport));
  }
  return HTML_RENDER_DEFAULT_VIEWPORTS.flatMap((viewport) => {
    const record = byViewport.get(viewport.name);
    return record ? [record] : [];
  });
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

function toRenderRecord(
  artifactId: string,
  contentHash: string,
  attachment: ChatAttachmentRecord,
  viewport: HtmlRenderViewport,
): ChatArtifactRenderRecord {
  return {
    artifactId,
    contentHash,
    viewport: viewport.name,
    attachmentId: attachment.attachmentId,
    sha256: attachment.sha256,
    width: viewport.width,
    height: viewport.height,
    createdAt: attachment.createdAt,
  };
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
