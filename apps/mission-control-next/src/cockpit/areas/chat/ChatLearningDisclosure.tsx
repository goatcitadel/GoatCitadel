import { lazy, useState } from "react";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { DeferredChatLeaf } from "./DeferredChatLeaves";

const LearningReceipt = lazy(async () => ({
  default: (await import("./ChatLearningReceiptControl")).ChatLearningReceiptControl,
}));

interface Props {
  sessionId: string;
  turnId: string;
  workspaceId: string;
  readOnly?: boolean;
}

export function ChatLearningDisclosure(props: Props) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const access = useProjectAccess(props.workspaceId);
  if (activeWorkspaceId && activeWorkspaceId !== props.workspaceId) return null;

  const identity = JSON.stringify([access.identity, activeWorkspaceId, activeCitadelId, props.sessionId, props.turnId]);
  return <LearningDisclosure key={identity} {...props} identity={identity} isCurrent={access.current} />;
}

function LearningDisclosure({ identity, isCurrent, ...props }: Props & { identity: string; isCurrent: () => boolean }) {
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);

  return (
    <details
      className="min-w-0 border-t border-line-subtle pt-3 text-sm"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        const next = event.currentTarget.open;
        if (next) setActivated(true);
        setOpen(next);
      }}
    >
      <summary className="cursor-pointer font-medium text-fg-secondary">Memory and learning</summary>
      {activated ? (
        <DeferredChatLeaf label="Memory and learning" identity={identity} loadingVisible={open}>
          <LearningReceipt {...props} identity={identity} open={open} isCurrent={isCurrent} />
        </DeferredChatLeaf>
      ) : null}
    </details>
  );
}
