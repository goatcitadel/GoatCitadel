import type { GuidanceBundleRecord, GuidanceDocType, GuidanceDocumentRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { GUIDANCE_DOC_FILE_MAP } from "./guidance-doc-files.js";
import { readGuidanceDocument, writeGuidanceDocument, type GuidanceDocumentHost } from "./guidance-document-helpers.js";
import type { ResolvedRuntimeGuidance } from "./chat-turn-planning-helpers.js";

const WORKSPACE_GUIDANCE_DOC_TYPES: GuidanceDocType[] = ["goatcitadel", "agents", "claude", "vision"];
const RUNTIME_GUIDANCE_DOC_TYPES: GuidanceDocType[] = ["goatcitadel", "agents", "claude"];
const MAX_RUNTIME_GUIDANCE_CHARS = 6000;
const GUIDANCE_DEBUG_KILL_SWITCH_ENV = "GOATCITADEL_DISABLE_GUIDANCE_INJECTION";

export interface GuidanceServiceContext extends GuidanceDocumentHost {
  readonly storage: Pick<Storage, "workspaces">;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
}

export class GuidanceService {
  public constructor(private readonly ctx: GuidanceServiceContext) {}

  public async listGlobalGuidance(): Promise<GuidanceDocumentRecord[]> {
    return Promise.all(
      (Object.keys(GUIDANCE_DOC_FILE_MAP) as GuidanceDocType[]).map((docType) =>
        readGuidanceDocument(this.ctx, docType, "global"),
      ),
    );
  }

  public async listWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    this.ctx.storage.workspaces.get(normalizedWorkspaceId);
    const [globalDocs, workspaceDocs] = await Promise.all([
      this.listGlobalGuidance(),
      Promise.all(
        WORKSPACE_GUIDANCE_DOC_TYPES.map((docType) =>
          readGuidanceDocument(this.ctx, docType, "workspace", normalizedWorkspaceId),
        ),
      ),
    ]);
    return {
      workspaceId: normalizedWorkspaceId,
      global: globalDocs,
      workspace: workspaceDocs,
    };
  }

  public async updateGlobalGuidance(docType: GuidanceDocType, content: string): Promise<GuidanceDocumentRecord> {
    await writeGuidanceDocument(this.ctx, docType, "global", undefined, content);
    this.ctx.publishRealtime("guidance_updated", "system", {
      scope: "global",
      docType,
    });
    return readGuidanceDocument(this.ctx, docType, "global");
  }

  public async updateWorkspaceGuidance(
    workspaceId: string,
    docType: GuidanceDocType,
    content: string,
  ): Promise<GuidanceDocumentRecord> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    this.ctx.storage.workspaces.get(normalizedWorkspaceId);
    if (!WORKSPACE_GUIDANCE_DOC_TYPES.includes(docType)) {
      throw new Error(`Workspace override is not supported for ${docType}; use global guidance instead.`);
    }
    await writeGuidanceDocument(this.ctx, docType, "workspace", normalizedWorkspaceId, content);
    this.ctx.publishRealtime("guidance_updated", "system", {
      scope: "workspace",
      workspaceId: normalizedWorkspaceId,
      docType,
    });
    return readGuidanceDocument(this.ctx, docType, "workspace", normalizedWorkspaceId);
  }

  public async resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance> {
    const normalizedWorkspaceId = this.ctx.normalizeWorkspaceId(workspaceId);
    if (isTruthy(process.env[GUIDANCE_DEBUG_KILL_SWITCH_ENV])) {
      return {
        workspaceId: normalizedWorkspaceId,
        globalFilesUsed: [],
        workspaceFilesUsed: [],
        truncated: false,
      };
    }

    const globalFilesUsed: string[] = [];
    const workspaceFilesUsed: string[] = [];
    const selectedBlocks: Array<{ title: string; content: string }> = [];

    for (const docType of RUNTIME_GUIDANCE_DOC_TYPES) {
      const [workspaceDoc, globalDoc] = await Promise.all([
        readGuidanceDocument(this.ctx, docType, "workspace", normalizedWorkspaceId),
        readGuidanceDocument(this.ctx, docType, "global"),
      ]);
      const selected = workspaceDoc.exists ? workspaceDoc : globalDoc.exists ? globalDoc : undefined;
      if (!selected || !selected.content.trim()) {
        continue;
      }
      if (selected.scope === "workspace") {
        workspaceFilesUsed.push(selected.fileName);
      } else {
        globalFilesUsed.push(selected.fileName);
      }
      selectedBlocks.push({
        title: `${selected.fileName} (${selected.scope})`,
        content: selected.content.trim(),
      });
    }

    const header = [
      `Workspace context: ${normalizedWorkspaceId}.`,
      "Apply these runtime guidance notes with workspace overrides taking precedence over global defaults.",
    ].join("\n");
    const immutableSafetyFooter = [
      "Non-overridable safety invariants:",
      "- Approval requirements remain authoritative.",
      "- Deny-wins policy remains authoritative.",
      "- Tool grants and host/network/path security boundaries remain authoritative.",
    ].join("\n");
    const budgetForBlocks = Math.max(
      1200,
      MAX_RUNTIME_GUIDANCE_CHARS - header.length - immutableSafetyFooter.length - 12,
    );

    let consumed = 0;
    let truncated = false;
    const blockLines: string[] = [];
    for (const block of selectedBlocks) {
      if (consumed >= budgetForBlocks) {
        truncated = true;
        break;
      }
      const rendered = `## ${block.title}\n${block.content}`;
      if (consumed + rendered.length <= budgetForBlocks) {
        blockLines.push(rendered);
        consumed += rendered.length;
        continue;
      }
      const remaining = budgetForBlocks - consumed;
      if (remaining > 80) {
        blockLines.push(`${rendered.slice(0, remaining)}\n...[truncated]`);
      }
      truncated = true;
      break;
    }

    const systemInstruction = [header, ...blockLines, immutableSafetyFooter].filter(Boolean).join("\n\n");
    return {
      workspaceId: normalizedWorkspaceId,
      systemInstruction: systemInstruction.trim().length > 0 ? systemInstruction : undefined,
      globalFilesUsed,
      workspaceFilesUsed,
      truncated,
    };
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
