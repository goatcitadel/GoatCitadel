import { useState, type ComponentType, type ReactNode } from "react";
import { fetchChannelSetupDrafts, fetchIntegrationConnections } from "@goatcitadel/mission-control-shared/api/client";
import { NativeButton } from "../../primitives";
import { checkChannelOutcome, useChannelMutationState } from "./channel-setup-state";

type ButtonLike = ComponentType<{ disabled?: boolean; onClick: () => void; children: ReactNode }>;

/**
 * The one action that can settle the installation-wide channel lock: it reads the Gateway's record of the lost write,
 * then the canonical channel owners (drafts and connections, which throw on failure) before unlocking. The section
 * `reload` only refreshes the view afterwards; it swallows its own errors, so it is never part of the proof.
 */
export function ChannelOutcomeCheck({
  reload,
  buttonComponent: Button = NativeButton as unknown as ButtonLike,
}: {
  reload?: () => Promise<unknown> | void;
  buttonComponent?: ButtonLike;
}) {
  const mutation = useChannelMutationState();
  const [settled, setSettled] = useState<string | null>(null);
  if (!mutation.uncertain) return settled ? <p role="status">{settled}</p> : null;
  if (!mutation.transport || mutation.pending) return null;
  return (
    <Button
      disabled={mutation.checking}
      onClick={() =>
        void checkChannelOutcome(async () => {
          await Promise.all([fetchChannelSetupDrafts(), fetchIntegrationConnections()]);
        }).then(async (message) => {
          if (!message) return;
          setSettled(message);
          await Promise.resolve(reload?.()).catch(() => undefined);
        })
      }
    >
      {mutation.checking ? "Checking outcome…" : "Check outcome"}
    </Button>
  );
}
