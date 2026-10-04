import { useCockpitShellSwitch } from "./use-cockpit-shell-switch";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import type { CockpitArea } from "./routes";

const COPY: Readonly<Record<Exclude<CockpitArea, "gallery">, string>> = {
  chat: "Chat is still being rebuilt here. Open the current conversation in the classic view.",
  inbox: "Decisions and requests will collect here as this area is built.",
  work: "Runs and tasks in progress will appear here as this area is built.",
  library: "Skills, tools, knowledge, memory, and files will move here.",
  system: "Health, spend, quality, and diagnostics will move here.",
  settings: "Settings will move here as this area is built.",
};

export function AreaPlaceholder({ area }: { area: Exclude<CockpitArea, "gallery"> }) {
  const shellSwitch = useCockpitShellSwitch();
  return (
    <>
      <EmptyState
        title="This area is in progress"
        description={COPY[area]}
        action={<Button onClick={shellSwitch.visit}>Open in classic view</Button>}
      />
      {shellSwitch.feedback}
    </>
  );
}
