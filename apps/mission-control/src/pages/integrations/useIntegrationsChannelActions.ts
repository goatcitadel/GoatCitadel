import { useCallback } from "react";
import type { IntegrationConnection } from "../../api/client";
import { commsReact, commsSend, commsUnsend, uploadChatAttachment } from "../../api/client";
import type { ChatAttachmentRecord, ConnectorRecord } from "@goatcitadel/contracts";
import {
  connectorSupportsDeliveryAction,
  dedupeUploadedAttachments,
  parseAttachmentIdInputs,
  parseAttachmentUrlInputs,
  requiresExplicitChannelTarget,
} from "../integrations-page-utils";
import { INTEGRATIONS_UPLOAD_SESSION_ID } from "./integrations-page-constants";

type UseIntegrationsChannelActionsArgs = {
  selectedChannelConnection: IntegrationConnection | null;
  selectedChannelConnector: ConnectorRecord | null;
  channelTestTarget: string;
  channelTestMessage: string;
  channelAttachmentUrls: string;
  channelAttachmentIdsText: string;
  uploadedChannelAttachments: ChatAttachmentRecord[];
  channelReplyToMessageId: string;
  channelReplyToPartIndex: string;
  channelEffectId: string;
  channelSubject: string;
  channelReactionMessageId: string;
  channelReactionEmoji: string;
  channelUnsendMessageId: string;
  setError: (value: string | null) => void;
  setChannelTestBusy: (value: boolean) => void;
  setChannelTestResult: (value: string | null) => void;
  setChannelActionBusy: (value: "react" | "unsend" | null) => void;
  setChannelActionResult: (value: string | null) => void;
  setChannelUploadBusy: (value: boolean) => void;
  setUploadedChannelAttachments: (
    value: ChatAttachmentRecord[] | ((current: ChatAttachmentRecord[]) => ChatAttachmentRecord[]),
  ) => void;
};

export function useIntegrationsChannelActions({
  selectedChannelConnection,
  selectedChannelConnector,
  channelTestTarget,
  channelTestMessage,
  channelAttachmentUrls,
  channelAttachmentIdsText,
  uploadedChannelAttachments,
  channelReplyToMessageId,
  channelReplyToPartIndex,
  channelEffectId,
  channelSubject,
  channelReactionMessageId,
  channelReactionEmoji,
  channelUnsendMessageId,
  setError,
  setChannelTestBusy,
  setChannelTestResult,
  setChannelActionBusy,
  setChannelActionResult,
  setChannelUploadBusy,
  setUploadedChannelAttachments,
}: UseIntegrationsChannelActionsArgs) {
  const onSendChannelTest = useCallback(async () => {
    if (!selectedChannelConnection) {
      setError("Choose a channel connection first.");
      return;
    }
    const message = channelTestMessage.trim();
    const target = channelTestTarget.trim();
    if (!message) {
      setError("Enter a test message.");
      return;
    }
    if (!target && requiresExplicitChannelTarget(selectedChannelConnection)) {
      setError("Enter a destination target or configure a default one.");
      return;
    }
    setChannelTestBusy(true);
    setChannelTestResult(null);
    try {
      const attachments = parseAttachmentUrlInputs(channelAttachmentUrls);
      const uploadedAttachmentIds = parseAttachmentIdInputs(channelAttachmentIdsText);
      for (const attachment of uploadedChannelAttachments) {
        if (!uploadedAttachmentIds.includes(attachment.attachmentId)) {
          uploadedAttachmentIds.push(attachment.attachmentId);
        }
      }
      const replyToPartIndex = channelReplyToPartIndex.trim()
        ? Number.parseInt(channelReplyToPartIndex.trim(), 10)
        : undefined;
      const result = await commsSend({
        connectionId: selectedChannelConnection.connectionId,
        target,
        message,
        attachments,
        attachmentIds: uploadedAttachmentIds.length > 0 ? uploadedAttachmentIds : undefined,
        replyToMessageId: channelReplyToMessageId.trim() || undefined,
        replyToPartIndex: Number.isFinite(replyToPartIndex) ? replyToPartIndex : undefined,
        effectId: channelEffectId.trim() || undefined,
        subject: channelSubject.trim() || undefined,
      });
      const statusText =
        typeof result === "object" && result && "status" in result
          ? String((result as { status?: unknown }).status ?? "sent")
          : "sent";
      const providerMessageId =
        typeof result === "object" && result && "providerMessageId" in result
          ? String((result as { providerMessageId?: unknown }).providerMessageId ?? "")
          : "";
      setChannelTestResult(
        providerMessageId
          ? `Delivered with status ${statusText}. Provider message id: ${providerMessageId}.`
          : `Delivered with status ${statusText}.`,
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelTestBusy(false);
    }
  }, [
    channelAttachmentIdsText,
    channelAttachmentUrls,
    channelEffectId,
    channelReplyToMessageId,
    channelReplyToPartIndex,
    channelSubject,
    channelTestMessage,
    channelTestTarget,
    selectedChannelConnection,
    setChannelTestBusy,
    setChannelTestResult,
    setError,
    uploadedChannelAttachments,
  ]);

  const onReactChannelTest = useCallback(async () => {
    if (!selectedChannelConnection || !selectedChannelConnector) {
      setError("Choose a channel connection first.");
      return;
    }
    if (!connectorSupportsDeliveryAction(selectedChannelConnector, "channel.react")) {
      setError("This channel connection does not support reactions.");
      return;
    }
    const messageId = channelReactionMessageId.trim();
    const emoji = channelReactionEmoji.trim();
    const target = channelTestTarget.trim();
    if (!messageId) {
      setError("Enter a provider message id to react to.");
      return;
    }
    if (!emoji) {
      setError("Enter a reaction emoji.");
      return;
    }
    if (!target && requiresExplicitChannelTarget(selectedChannelConnection)) {
      setError("Enter a destination target or configure a default one.");
      return;
    }
    setChannelActionBusy("react");
    setChannelActionResult(null);
    try {
      const result = await commsReact({
        connectionId: selectedChannelConnection.connectionId,
        target,
        messageId,
        reaction: emoji,
      });
      const statusText =
        typeof result === "object" && result && "status" in result
          ? String((result as { status?: unknown }).status ?? "reacted")
          : "reacted";
      setChannelActionResult(`Reaction request completed with status ${statusText}.`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelActionBusy(null);
    }
  }, [
    channelReactionEmoji,
    channelReactionMessageId,
    channelTestTarget,
    selectedChannelConnection,
    selectedChannelConnector,
    setChannelActionBusy,
    setChannelActionResult,
    setError,
  ]);

  const onUploadChannelAttachments = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) {
        return;
      }
      setChannelUploadBusy(true);
      try {
        const uploaded: ChatAttachmentRecord[] = [];
        for (const file of Array.from(fileList)) {
          uploaded.push(
            await uploadChatAttachment({
              sessionId: INTEGRATIONS_UPLOAD_SESSION_ID,
              file,
            }),
          );
        }
        setUploadedChannelAttachments((current) => dedupeUploadedAttachments([...current, ...uploaded]));
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setChannelUploadBusy(false);
      }
    },
    [setChannelUploadBusy, setError, setUploadedChannelAttachments],
  );

  const onRemoveUploadedChannelAttachment = useCallback(
    (attachmentId: string) => {
      setUploadedChannelAttachments((current) => current.filter((item) => item.attachmentId !== attachmentId));
    },
    [setUploadedChannelAttachments],
  );

  const onUnsendChannelTest = useCallback(async () => {
    if (!selectedChannelConnection || !selectedChannelConnector) {
      setError("Choose a channel connection first.");
      return;
    }
    if (!connectorSupportsDeliveryAction(selectedChannelConnector, "channel.unsend")) {
      setError("This channel connection does not support unsend.");
      return;
    }
    const messageId = channelUnsendMessageId.trim();
    const target = channelTestTarget.trim();
    if (!messageId) {
      setError("Enter a provider message id to unsend.");
      return;
    }
    if (!target && requiresExplicitChannelTarget(selectedChannelConnection)) {
      setError("Enter a destination target or configure a default one.");
      return;
    }
    setChannelActionBusy("unsend");
    setChannelActionResult(null);
    try {
      const result = await commsUnsend({
        connectionId: selectedChannelConnection.connectionId,
        target,
        messageId,
      });
      const statusText =
        typeof result === "object" && result && "status" in result
          ? String((result as { status?: unknown }).status ?? "unsent")
          : "unsent";
      setChannelActionResult(`Unsend request completed with status ${statusText}.`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChannelActionBusy(null);
    }
  }, [
    channelTestTarget,
    channelUnsendMessageId,
    selectedChannelConnection,
    selectedChannelConnector,
    setChannelActionBusy,
    setChannelActionResult,
    setError,
  ]);

  return {
    onSendChannelTest,
    onReactChannelTest,
    onUploadChannelAttachments,
    onRemoveUploadedChannelAttachment,
    onUnsendChannelTest,
  };
}
