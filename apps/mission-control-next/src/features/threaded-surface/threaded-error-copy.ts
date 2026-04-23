import {
  describeChatUiError,
  type ChatErrorSource,
  type ChatUiErrorDescriptor,
} from "../../../../../packages/threaded-surface-core/src/chat/chat-error-copy";

export type ThreadedUiErrorDescriptor = ChatUiErrorDescriptor;

export function describeThreadedUiError(
  value?: string | null,
  source: ChatErrorSource | null = "other",
): ThreadedUiErrorDescriptor | null {
  return describeChatUiError(value, source);
}
