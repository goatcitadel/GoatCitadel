import { useQuery } from "@tanstack/react-query";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

const STARTERS = [
  { label: "Explain this project", prompt: "Help me understand a project. Ask what files or context I can share." },
  { label: "Plan a change", prompt: "Help me plan a change. Ask what I want to achieve and what context I can share." },
  {
    label: "Draft or summarize",
    prompt: "Help me draft or summarize something. Ask what material and audience I have in mind.",
  },
] as const;

export function ChatConversationStarterChoices({ onChoose }: { onChoose: (prompt: string) => void }) {
  // Setup that has not been read, or could not be, is not "unfinished": only a read that says so opens Get started.
  const onboarding = useQuery({ queryKey: ["system", "onboarding"], queryFn: fetchOnboardingState, staleTime: 60_000 });
  const modelsHref = onboarding.data?.completed === false ? "/settings/first-run" : "/settings/models";
  return (
    <>
      {/* CH-N23: keep these as a plain list of secondary buttons. */}
      <ul aria-label="Starting prompts" className="flex flex-wrap gap-2">
        {STARTERS.map((item) => (
          <li key={item.label}>
            <Button onClick={() => onChoose(item.prompt)}>{item.label}</Button>
          </li>
        ))}
      </ul>
      <p className="text-fg-muted">Choose a starting prompt, then review it before sending.</p>
      <div className="flex flex-wrap gap-4 text-accent">
        <NativeOwnerLink scope="conversation-starters" href={modelsHref}>
          Configure models
        </NativeOwnerLink>
        <NativeOwnerLink scope="conversation-starters" href="/library/knowledge">
          Import knowledge
        </NativeOwnerLink>
      </div>
    </>
  );
}
