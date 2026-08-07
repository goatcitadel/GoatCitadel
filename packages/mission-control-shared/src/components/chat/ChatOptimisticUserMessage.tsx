import type { ChatMessageRecord } from "@goatcitadel/contracts";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";
import { ChatAttachmentPreviewStack } from "./ChatAttachmentPreviewStack";
import { ActorTimestamp } from "./ChatThreadPrimitives";

export interface ChatOptimisticUserMessageView {
  messageId: string;
  content: string;
  timestamp: string;
  attachments?: ChatMessageRecord["attachments"];
}

export function ChatOptimisticUserMessage({ message }: { message: ChatOptimisticUserMessageView }) {
  return (
    <article
      className="mc-next-thread-turn streaming optimistic-user-message routine-chat"
      data-message-id={message.messageId}
      aria-busy="true"
    >
      <div className="mc-next-thread-bubble user">
        <p className="mc-next-thread-meta">
          <strong>You</strong> · <ActorTimestamp timestamp={message.timestamp} /> ·{" "}
          <span className="mc-next-thread-delivery-status">Sending</span>
        </p>
        <AssistantMessageRenderer role="user" content={message.content} />
        <ChatAttachmentPreviewStack attachments={message.attachments} eager />
      </div>
    </article>
  );
}
