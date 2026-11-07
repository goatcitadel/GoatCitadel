import {
  attachExternalSourceToSession,
  detachExternalSourceAttachment,
  requestExternalSourceKnowledgeSnapshot,
} from "@goatcitadel/mission-control-shared/api/external-source-chat";
import type { ExternalSessionAttachmentRecord } from "@goatcitadel/contracts";
import type { ExternalSourceAttachInputSeed } from "./useExternalSourceAttachments";

export type ExternalAttachmentAction =
  | { kind: "attach"; seed: ExternalSourceAttachInputSeed }
  | { kind: "detach" | "knowledge"; attachment: ExternalSessionAttachmentRecord };

export async function dispatchExternalAttachmentAction(
  action: ExternalAttachmentAction,
  scope: { workspaceId: string; sessionId: string; expectedSessionIncarnationId: string },
): Promise<{ message: string; tone: "neutral" | "success" }> {
  if (action.kind === "attach") {
    await attachExternalSourceToSession({
      ...scope,
      sourceId: action.seed.sourceId,
      importId: action.seed.importId,
      itemId: action.seed.itemId,
    });
    return { message: "Attached the imported item read-only.", tone: "success" };
  }
  const { attachmentId, importId, itemId, revision } = action.attachment;
  if (action.kind === "detach") {
    await detachExternalSourceAttachment({ ...scope, attachmentId, expectedRevision: revision });
    return { message: "Detached the external source. Imported evidence remains immutable.", tone: "neutral" };
  }
  const receipt = await requestExternalSourceKnowledgeSnapshot({
    ...scope,
    attachmentId,
    importId,
    itemId,
    expectedAttachmentRevision: revision,
  });
  return {
    message: receipt.approvalId
      ? `Knowledge copy requested. Resolve approval ${receipt.approvalId.slice(-8)} in the approvals inbox.`
      : "Knowledge copy requested. Resolve it in the approvals inbox.",
    tone: "success",
  };
}
