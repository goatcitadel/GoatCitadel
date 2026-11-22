import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessageRecord, ChatToolRunRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import {
  buildWorkspaceFileDownloadHref,
  getExecutedWorkspaceFileWriteReceipt,
  mergeWorkspaceFileDownloadContent,
} from "./chat-turn-agent-runner/artifact-write-helpers.js";
import { MAX_INLINE_FILE_DOWNLOAD_BYTES } from "./files-route-service.js";

const ARTIFACT_TOOL_NAMES = new Set([
  "artifacts.create",
  "documents.create",
  "presentations.create",
  "gmail.download_attachment",
]);
const ARTIFACT_PATH_KEYS = ["path", "fallbackPath"] as const;

/** Forward-slash path of a file inside the workspace root; undefined for anything else. */
export function toWorkspaceRelativePath(candidate: string, workspaceRootDir: string | undefined): string | undefined {
  const root = workspaceRootDir?.trim();
  const target = candidate.trim();
  if (!root || !target || !path.isAbsolute(target)) {
    return undefined;
  }
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.replaceAll("\\", "/");
}

/**
 * What the model sees of an artifact tool result (#505): the workspace-relative path instead of the
 * absolute local one, and the design report cut to its style and plain-language caveats. Validation
 * checks and design-instruction receipts stay in the stored tool run, which the trace and the
 * download receipt read.
 */
export function projectArtifactToolResultForModel(
  toolName: string,
  result: Record<string, unknown>,
  workspaceRootDir: string | undefined,
): Record<string, unknown> {
  if (!ARTIFACT_TOOL_NAMES.has(toolName)) {
    return result;
  }
  const projected: Record<string, unknown> = { ...result };
  for (const key of ARTIFACT_PATH_KEYS) {
    const value = result[key];
    const relative = typeof value === "string" ? toWorkspaceRelativePath(value, workspaceRootDir) : undefined;
    if (relative) {
      projected[key] = relative;
    }
  }
  if (isRecord(result.designReport)) {
    projected.designReport = summarizeDesignReportForModel(result.designReport);
  }
  return projected;
}

/**
 * Rewrites this turn's artifact paths in the final answer to their workspace-relative form, then
 * any other mention of the workspace root, so the answer never carries the local profile path.
 */
export function projectArtifactPathsInAnswer(
  content: string,
  toolRuns: readonly ChatToolRunRecord[],
  workspaceRootDir: string | undefined,
): string {
  const root = workspaceRootDir?.trim();
  if (!content || !root) {
    return content;
  }
  let projected = content;
  let wroteArtifact = false;
  for (const run of toolRuns) {
    const receipt = getExecutedWorkspaceFileWriteReceipt(run);
    const relative = receipt ? toWorkspaceRelativePath(receipt.artifactPath, root) : undefined;
    if (!receipt || !relative) {
      continue;
    }
    wroteArtifact = true;
    for (const variant of pathVariants(receipt.artifactPath)) {
      projected = projected.replace(new RegExp(escapeRegExp(variant), regExpFlags(variant)), () => relative);
    }
  }
  if (!wroteArtifact) {
    return projected;
  }
  for (const variant of pathVariants(root)) {
    const escaped = escapeRegExp(variant.replace(/[\\/]+$/u, ""));
    if (!escaped) {
      continue;
    }
    projected = projected
      .replace(new RegExp(`${escaped}[\\\\/]([^\\s\`'"<>)\\]]*)`, regExpFlags(variant)), (_match, rest: string) =>
        rest.replaceAll("\\", "/"),
      )
      .replace(new RegExp(`${escaped}(?=$|[\\s.,;:!?)\\]'"\`])`, regExpFlags(variant)), "the workspace folder");
  }
  return projected;
}

function summarizeDesignReportForModel(design: Record<string, unknown>): Record<string, unknown> {
  const caveats = Array.isArray(design.residualRisks)
    ? [
        ...new Set(
          design.residualRisks.filter((risk): risk is string => typeof risk === "string" && risk.trim() !== ""),
        ),
      ]
    : [];
  const google = isRecord(design.google) ? design.google : undefined;
  return {
    ...(typeof design.preset === "string" ? { style: design.preset } : {}),
    caveats,
    ...(google?.requested === true
      ? {
          googleImport: {
            status: google.status,
            ...(typeof google.url === "string" ? { url: google.url } : {}),
            ...(typeof google.reason === "string" ? { reason: google.reason } : {}),
          },
        }
      : {}),
  };
}

function pathVariants(value: string): Set<string> {
  const raw = value.trim();
  const resolved = path.resolve(raw);
  return new Set(
    [raw, resolved].flatMap((candidate) => [
      candidate,
      candidate.replaceAll("\\", "/"),
      candidate.replaceAll("/", "\\"),
    ]),
  );
}

function regExpFlags(variant: string): string {
  return path.win32.isAbsolute(variant) && /^[A-Za-z]:/u.test(variant) ? "giu" : "gu";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function projectAssistantWorkspaceFileDownloads(
  assistantMessage: ChatMessageRecord | undefined,
  trace: ChatTurnTraceRecord,
  workspaceFileRootDir: string | undefined,
): Promise<ChatMessageRecord | undefined> {
  if (!assistantMessage || !workspaceFileRootDir) {
    return assistantMessage;
  }
  let content = assistantMessage.content;
  for (const toolRun of trace.toolRuns) {
    if (toolRun.sessionId !== trace.sessionId || toolRun.turnId !== trace.turnId) {
      continue;
    }
    const receipt = getExecutedWorkspaceFileWriteReceipt(toolRun);
    if (!receipt) {
      continue;
    }
    const downloadHref = await resolveLiveWorkspaceDownloadHref(receipt.artifactPath, workspaceFileRootDir);
    if (!downloadHref) {
      continue;
    }
    content = mergeWorkspaceFileDownloadContent(content, toolRun, downloadHref);
  }
  return content === assistantMessage.content ? assistantMessage : { ...assistantMessage, content };
}

async function resolveLiveWorkspaceDownloadHref(
  artifactPath: string,
  workspaceFileRootDir: string,
): Promise<string | undefined> {
  if (!path.isAbsolute(artifactPath)) {
    return undefined;
  }
  try {
    const [realWorkspaceRoot, realArtifactPath] = await Promise.all([
      fs.realpath(workspaceFileRootDir),
      fs.realpath(artifactPath),
    ]);
    const relative = path.relative(realWorkspaceRoot, realArtifactPath);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      return undefined;
    }
    const href = buildWorkspaceFileDownloadHref(realArtifactPath, realWorkspaceRoot);
    if (!href) {
      return undefined;
    }
    const stat = await fs.stat(realArtifactPath);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_INLINE_FILE_DOWNLOAD_BYTES ? href : undefined;
  } catch {
    return undefined;
  }
}
