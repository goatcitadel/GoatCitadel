import {
  describeChatUiError,
  type ChatErrorSource,
  type ChatUiErrorDescriptor,
} from "@goatcitadel/threaded-surface-core/chat-error-copy";

export type ThreadedUiErrorDescriptor = ChatUiErrorDescriptor;

export function describeThreadedUiError(
  value?: string | null,
  source: ChatErrorSource | null = "other",
): ThreadedUiErrorDescriptor | null {
  return describeChatUiError(value, source);
}
