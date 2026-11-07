import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { lazy } from "react";
import { DeferredChatLeaf } from "./DeferredChatLeaves";
type Props = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  "draft" | "onDraftChange" | "historicalReadOnly" | "sending"
>;
const StarterChoices = lazy(async () => ({
  default: (await import("./ChatConversationStarterChoices")).ChatConversationStarterChoices,
}));
export function ChatConversationStarters({ props }: { props: Props }) {
  if (props.draft?.length || props.historicalReadOnly || props.sending || typeof props.onDraftChange !== "function")
    return null;
  return (
    <section aria-label="Conversation starters" className="mx-auto max-w-3xl space-y-4 p-5 text-sm">
      <h2 className="text-lg font-semibold text-fg">What would you like to work on?</h2>
      <DeferredChatLeaf label="Starting prompts" identity="conversation-starters">
        <StarterChoices
          onChoose={(prompt) => {
            if (props.draft?.length || props.sending || props.historicalReadOnly) return;
            props.onDraftChange(prompt);
            document.getElementById("cockpit-chat-draft")?.focus();
          }}
        />
      </DeferredChatLeaf>
    </section>
  );
}
