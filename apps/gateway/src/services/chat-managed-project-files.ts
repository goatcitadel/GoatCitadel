import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  type ManagedProjectFileScope,
  type ToolAccessEvaluateRequest,
  type ToolAccessEvaluateResponse,
} from "@goatcitadel/contracts";
import { MANAGED_PROJECT_FILE_MAX_BYTES, managedProjectFilePathKey, type AsyncStorage } from "@goatcitadel/storage";
import { z } from "zod";
import { getChatApprovalMode, type ChatApprovalModeDependencies } from "./chat-approval-mode-service.js";

export type ManagedProjectFiles = AsyncStorage["managedProjectFiles"];
const pathSchema = z.string().min(1).max(512);
const revisionSchema = z.string().min(1).max(128);
const listSchema = z.strictObject({
  prefix: pathSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const readSchema = z.strictObject({ path: pathSchema });
const saveSchema = z.strictObject({
  path: pathSchema,
  expectedRevision: revisionSchema.nullable(),
  text: z.string().max(MANAGED_PROJECT_FILE_MAX_BYTES),
});
export const managedDeleteSchema = z.strictObject({ path: pathSchema, expectedRevision: revisionSchema });
export const managedDownloadSchema = z.strictObject({ path: pathSchema, revisionId: revisionSchema });
export const managedListQuerySchema = z.strictObject({
  prefix: pathSchema
    .refine((path) => {
      try {
        managedProjectFilePathKey(path);
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
});
export const managedRestoreSchema = managedDeleteSchema.extend({
  expectedModeRevision: z.string().regex(/^[a-f0-9]{64}$/u),
});

/** Advisory catalog scope check. Execution still requires frozen turn authority. */
export async function inspectManagedProjectFileAvailability(
  deps: ChatApprovalModeDependencies,
  request: ToolAccessEvaluateRequest,
  inspect: () => Promise<ToolAccessEvaluateResponse>,
): Promise<ToolAccessEvaluateResponse> {
  const blocked: ToolAccessEvaluateResponse = {
    toolName: request.toolName,
    allowed: false,
    requiresApproval: false,
    reasonCodes: ["managed_project_auto_required"],
    riskLevel: request.toolName === "project.files.delete" ? "danger" : "safe",
  };
  if (!deps.chatAutoApprovalEnabled || !request.sessionId) return blocked;
  try {
    const mode = await getChatApprovalMode(deps, request.sessionId);
    if (
      !mode.autoAvailable ||
      mode.mode !== "auto" ||
      (request.workspaceId && mode.workspaceId !== request.workspaceId)
    ) {
      return blocked;
    }
    return await inspect();
  } catch (error) {
    if (error instanceof NotFoundError) return blocked;
    throw error;
  }
}

export function managedFileEffectId(...material: string[]): string {
  return createHash("sha256").update(canonicalJsonString(material), "utf8").digest("hex");
}

export async function executeManagedProjectFile(
  store: ManagedProjectFiles,
  scope: ManagedProjectFileScope,
  toolName: string,
  args: Record<string, unknown>,
  effectId: string,
): Promise<Record<string, unknown>> {
  if (toolName === "project.files.list") {
    return { items: await store.list(scope, listSchema.parse(args)) };
  }
  if (toolName === "project.files.read") {
    const file = await store.read({ ...scope, ...readSchema.parse(args) });
    if (!file || file.deleted || file.contentBase64 === null) throw new NotFoundError({ entity: "Managed file" });
    const { contentBase64, ...revision } = file;
    // Do not hand the model unbounded text or binary content.
    if (revision.byteLength > 64 * 1024)
      return { ...revision, previewUnavailable: "File exceeds the text preview limit." };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(contentBase64, "base64"));
    } catch {
      return { ...revision, previewUnavailable: "File is not UTF-8 text." };
    }
    return { ...revision, text };
  }
  if (toolName === "project.files.save") {
    const { text, ...input } = saveSchema.parse(args);
    const receipt = await store.save({
      ...scope,
      ...input,
      effectId,
      contentBase64: Buffer.from(text, "utf8").toString("base64"),
    });
    return { kind: "managed_project_file", ...receipt };
  }
  throw new ConflictError({ message: "Unsupported managed file operation." });
}

export interface ManagedProjectFileOperatorDependencies extends ChatApprovalModeDependencies {
  storage: ChatApprovalModeDependencies["storage"] & Pick<AsyncStorage, "managedProjectFiles">;
  checkPolicy(
    sessionId: string,
    scope: ManagedProjectFileScope,
    actorId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void>;
}

export function createManagedProjectFileOperator(deps: ManagedProjectFileOperatorDependencies) {
  async function withScope<T>(
    sessionId: string,
    work: (scope: ManagedProjectFileScope, modeRevision: string) => Promise<T>,
  ): Promise<T> {
    return deps.storage.runImmediateTransaction(async () => {
      const state = await getChatApprovalMode(deps, sessionId);
      if (!state.autoAvailable || state.mode !== "auto" || !state.projectId) {
        throw new ConflictError({ message: "This session has no active managed Auto workspace." });
      }
      return work({ workspaceId: state.workspaceId, projectId: state.projectId }, state.modeRevision);
    });
  }
  return {
    list(sessionId: string, actorId: string, input: z.infer<typeof managedListQuerySchema> = {}) {
      return withScope(sessionId, async (scope) => {
        await deps.checkPolicy(sessionId, scope, actorId, "project.files.list", input);
        return { items: await deps.storage.managedProjectFiles.list(scope, input) };
      });
    },
    download(sessionId: string, actorId: string, input: z.infer<typeof managedDownloadSchema>) {
      return withScope(sessionId, async (scope) => {
        await deps.checkPolicy(sessionId, scope, actorId, "project.files.read", { path: input.path });
        const file = await deps.storage.managedProjectFiles.read({ ...scope, path: input.path });
        if (!file || file.deleted || file.contentBase64 === null) throw new NotFoundError({ entity: "Managed file" });
        if (file.revisionId !== input.revisionId) {
          throw new ConflictError({ message: "The managed file changed. Refresh the workspace before downloading." });
        }
        return { path: file.path, bytes: Buffer.from(file.contentBase64, "base64") };
      });
    },
    restore(sessionId: string, actorId: string, input: z.infer<typeof managedRestoreSchema>) {
      return withScope(sessionId, async (scope, modeRevision) => {
        if (input.expectedModeRevision !== modeRevision) {
          throw new ConflictError({ message: "The managed workspace changed. Reload the session." });
        }
        await deps.checkPolicy(sessionId, scope, actorId, "project.files.save", { path: input.path });
        return deps.storage.managedProjectFiles.restore({
          ...scope,
          path: input.path,
          expectedRevision: input.expectedRevision,
          effectId: managedFileEffectId("operator-restore", sessionId, modeRevision, input.expectedRevision),
        });
      });
    },
  };
}
