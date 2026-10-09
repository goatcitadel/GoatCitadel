import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChatAttachmentRecord, ChatSessionPrefsPatch } from "@goatcitadel/contracts";
import { downloadFile, uploadChatAttachment } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { applyComposerSuggestion } from "./useChatComposerInteractions";
import type { ComposerPaletteItem } from "./composer-palette";
import type { useChatSessionControls } from "./useChatSessionControls";
import type { useRunVariablePanel } from "./useRunVariablePanel";

type Input = {
  workspaceId: string;
  ensureSession: ReturnType<typeof useChatSessionControls>["ensureSession"];
  setPendingAttachments: Dispatch<SetStateAction<ChatAttachmentRecord[]>>;
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
  setComposerPaletteGlobalOpen: Dispatch<SetStateAction<boolean>>;
  setComposerPaletteQuery: Dispatch<SetStateAction<string>>;
  setDraft: Dispatch<SetStateAction<string>>;
  requestThreadModelPatch: (patch: ChatSessionPrefsPatch) => void;
  setSelectedPresetId: Dispatch<SetStateAction<string>>;
  handleApplyPresetById: (agentId: string) => Promise<void>;
  handleAssignProject: ReturnType<typeof useChatSessionControls>["handleAssignProject"];
  handleAttachKnowledgeUrlValue: (value: string) => Promise<void>;
  openRunVariableForm: ReturnType<typeof useRunVariablePanel>["openForm"];
  setUiError: (value: string | null) => void;
};

export function useChatComposerPaletteActions({
  workspaceId,
  ensureSession,
  setPendingAttachments,
  pushLocalNotice,
  setComposerPaletteGlobalOpen,
  setComposerPaletteQuery,
  setDraft,
  requestThreadModelPatch,
  setSelectedPresetId,
  handleApplyPresetById,
  handleAssignProject,
  handleAttachKnowledgeUrlValue,
  openRunVariableForm,
  setUiError,
}: Input) {
  const handleAttachPaletteFile = useCallback(
    async (relativePath: string) => {
      const session = await ensureSession();
      const downloaded = await downloadFile(relativePath, {
        workspaceId: session.workspaceId ?? workspaceId,
      });
      const fileName = relativePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? "attachment";
      const payload =
        downloaded.encoding === "base64"
          ? Uint8Array.from(globalThis.atob(downloaded.content), (character) => character.charCodeAt(0))
          : downloaded.content;
      const uploaded = await uploadChatAttachment({
        sessionId: session.sessionId,
        projectId: session.projectId,
        file: new File([payload], fileName, { type: downloaded.contentType || "application/octet-stream" }),
      });
      setPendingAttachments((current) =>
        current.some((attachment) => attachment.attachmentId === uploaded.attachmentId)
          ? current
          : [...current, uploaded],
      );
      pushLocalNotice(`Attached ${fileName} for the next turn.`, "success");
    },
    [ensureSession, pushLocalNotice, setPendingAttachments, workspaceId],
  );
  const handleComposerPaletteSelect = useCallback(
    async (item: ComposerPaletteItem) => {
      setComposerPaletteGlobalOpen(false);
      setComposerPaletteQuery("");
      try {
        switch (item.action.type) {
          case "insert_command": {
            const command = item.action.value;
            setDraft((current) => applyComposerSuggestion(current, command));
            break;
          }
          case "select_model": {
            requestThreadModelPatch({ providerId: item.action.providerId, model: item.action.model });
            break;
          }
          case "select_preset":
            setSelectedPresetId(item.action.agentId);
            await handleApplyPresetById(item.action.agentId);
            break;
          case "switch_project":
            await handleAssignProject(item.action.projectId);
            break;
          case "attach_file":
            await handleAttachPaletteFile(item.action.relativePath);
            break;
          case "attach_context":
            pushLocalNotice("This knowledge attachment is available to the next turn.", "success");
            break;
          case "attach_document":
            pushLocalNotice("Including documents in a turn is temporarily unavailable.", "warning");
            break;
          case "attach_url":
            await handleAttachKnowledgeUrlValue(item.action.url);
            break;
          case "launch_external_source":
            pushLocalNotice("Open External sources in Library to review and admit a source before attaching it to this conversation.", "warning");
            break;
          case "explore_workspace":
            pushLocalNotice("Explore workspace delegation is temporarily unavailable.", "warning");
            break;
          case "open_template_form": {
            openRunVariableForm({
              title: item.command,
              invocation: item.action.invocation,
              schema: item.action.schema,
              template: item.action.template,
              defaults: item.action.defaults,
            });
            break;
          }
        }
      } catch (cause) {
        setUiError(cause instanceof Error ? cause.message : "Unable to apply the palette action.");
      }
    },
    [
      handleApplyPresetById,
      handleAssignProject,
      handleAttachKnowledgeUrlValue,
      handleAttachPaletteFile,
      openRunVariableForm,
      pushLocalNotice,
      requestThreadModelPatch,
      setComposerPaletteGlobalOpen,
      setComposerPaletteQuery,
      setDraft,
      setSelectedPresetId,
      setUiError,
    ],
  );
  return { handleComposerPaletteSelect };
}
