import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
type Props = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  "draft" | "onDraftChange" | "historicalReadOnly" | "sending"
>;
const STARTERS = [
  { label: "Explain this project", prompt: "Help me understand a project. Ask what files or context I can share." },
  { label: "Plan a change", prompt: "Help me plan a change. Ask what I want to achieve and what context I can share." },
  {
    label: "Draft or summarize",
    prompt: "Help me draft or summarize something. Ask what material and audience I have in mind.",
  },
] as const;
export function ChatConversationStarters({ props }: { props: Props }) {
  if (props.draft?.length || props.historicalReadOnly || props.sending || typeof props.onDraftChange !== "function")
    return null;
  return (
    <section aria-label="Conversation starters" className="mx-auto max-w-3xl space-y-4 p-5 text-sm">
      <h2 className="text-lg font-semibold text-fg">What would you like to work on?</h2>
      {/* CH-N23: a plain list of secondary buttons, not a grid of bordered cards. */}
      <ul aria-label="Starting prompts" className="flex flex-wrap gap-2">
        {STARTERS.map((item) => (
          <li key={item.label}>
            <Button
              onClick={() => {
                if (props.draft?.length || props.sending || props.historicalReadOnly) return;
                props.onDraftChange(item.prompt);
                document.getElementById("cockpit-chat-draft")?.focus();
              }}
            >
              {item.label}
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-fg-muted">Choose a starting prompt, then review it before sending.</p>
      <div className="flex flex-wrap gap-4 text-accent">
        <NativeOwnerLink scope="conversation-starters" href="/settings/models">
          Configure models
        </NativeOwnerLink>
        <NativeOwnerLink scope="conversation-starters" href="/library/knowledge">
          Import knowledge
        </NativeOwnerLink>
      </div>
    </section>
  );
}
