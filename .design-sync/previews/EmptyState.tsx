import { EmptyState, NativeButton } from "@goatcitadel/mission-control-next";
import { Inbox, FolderOpen, Search } from "lucide-react";

export const Default = () => (
  <EmptyState
    icon={<Inbox />}
    title="No active runs"
    description="When you start a task it appears here with live status and a link to its workspace."
    primaryAction={<NativeButton variant="default">Start a task</NativeButton>}
    secondaryActions={<NativeButton variant="ghost">View history</NativeButton>}
  />
);

export const Accent = () => (
  <EmptyState
    tone="accent"
    icon={<FolderOpen />}
    title="Connect a workspace"
    description="Link a project folder so agents have a place to read and write files."
    primaryAction={<NativeButton variant="default">Choose folder</NativeButton>}
  />
);

export const NoResults = () => (
  <EmptyState
    icon={<Search />}
    title="No matches"
    description="No tests match this filter. Try clearing the search or switching tabs."
  />
);

export const Compact = () => <EmptyState size="compact" title="No items in this lane." />;
