import fs from "node:fs";
import type { SkillContextDocType } from "@goatcitadel/skills";
import { resolveGuidancePath, type GuidanceDocumentHost } from "./guidance-document-helpers.js";
import type { SkillContextDocReader } from "./governed-skill-instruction-service.js";

/**
 * Reads a workspace's PRODUCT.md / DESIGN.md for governed skill injection. Workspace scope only:
 * a missing workspace copy is reported missing, never substituted by a global file (plan D3).
 * Synchronous on purpose: receipts are built and re-verified inside the synchronous
 * exact-byte verification path.
 */
export function createWorkspaceSkillContextDocReader(
  host: GuidanceDocumentHost,
  workspaceId: string,
): SkillContextDocReader {
  const normalizedWorkspaceId = host.normalizeWorkspaceId(workspaceId);
  return (docType: SkillContextDocType) => {
    const resolved = resolveGuidancePath(host, docType, "workspace", normalizedWorkspaceId);
    try {
      return { exists: true, content: fs.readFileSync(resolved.absolutePath, "utf8") };
    } catch {
      return { exists: false, content: "" };
    }
  };
}
