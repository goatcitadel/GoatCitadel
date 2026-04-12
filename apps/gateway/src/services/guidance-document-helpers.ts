import fs from "node:fs/promises";
import path from "node:path";
import type { GuidanceDocType, GuidanceDocumentRecord } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import { GUIDANCE_DOC_FILE_MAP } from "./guidance-doc-files.js";

export interface GuidanceDocumentHost {
  readonly config: Pick<GatewayRuntimeConfig, "rootDir">;
  normalizeWorkspaceId(workspaceId?: string): string;
}

export function resolveGuidancePath(
  host: GuidanceDocumentHost,
  docType: GuidanceDocType,
  scope: "global" | "workspace",
  workspaceId?: string,
): { fileName: string; absolutePath: string } {
  const fileName = GUIDANCE_DOC_FILE_MAP[docType];
  if (!fileName) {
    throw new Error(`Unsupported guidance doc type: ${docType}`);
  }
  if (scope === "global") {
    return {
      fileName,
      absolutePath: path.resolve(host.config.rootDir, fileName),
    };
  }
  const normalizedWorkspaceId = host.normalizeWorkspaceId(workspaceId);
  return {
    fileName,
    absolutePath: path.resolve(host.config.rootDir, "workspaces", normalizedWorkspaceId, fileName),
  };
}

export async function readGuidanceDocument(
  host: GuidanceDocumentHost,
  docType: GuidanceDocType,
  scope: "global" | "workspace",
  workspaceId?: string,
): Promise<GuidanceDocumentRecord> {
  const normalizedWorkspaceId = scope === "workspace" ? host.normalizeWorkspaceId(workspaceId) : undefined;
  const resolved = resolveGuidancePath(host, docType, scope, normalizedWorkspaceId);
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(resolved.absolutePath, "utf8"),
      fs.stat(resolved.absolutePath),
    ]);
    return {
      docType,
      scope,
      workspaceId: normalizedWorkspaceId,
      fileName: resolved.fileName,
      absolutePath: resolved.absolutePath,
      exists: true,
      content,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      docType,
      scope,
      workspaceId: normalizedWorkspaceId,
      fileName: resolved.fileName,
      absolutePath: resolved.absolutePath,
      exists: false,
      content: "",
    };
  }
}

export async function writeGuidanceDocument(
  host: GuidanceDocumentHost,
  docType: GuidanceDocType,
  scope: "global" | "workspace",
  workspaceId: string | undefined,
  content: string,
): Promise<void> {
  const resolved = resolveGuidancePath(host, docType, scope, workspaceId);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  const normalizedContent = content.replace(/\r\n/g, "\n").trimEnd() + "\n";
  await fs.writeFile(resolved.absolutePath, normalizedContent, "utf8");
}
