import { useEffect, useRef, useState } from "react";
import { fetchIntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { useIntegrationConnectionMutation } from "../../../features/native-routes/settings/integration-connection-mutation";
import { Button } from "../../ui/Button";
import { ChannelActionNote } from "./ChannelActionNote";

/**
 * A change to this channel was sent and its answer was lost, so further changes to it are locked until its outcome is
 * checked. Shown once for the whole page, with the one action that can settle it.
 */
export function ChannelLockNote({ connectionId, reload }: { connectionId: string; reload: () => Promise<unknown> }) {
  const mutation = useIntegrationConnectionMutation(connectionId);
  // A lock that is already there when the page opens does not take focus; one that appears while it is open does.
  const [alreadyLocked] = useState(() => mutation.phase === "uncertain");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (mutation.phase !== "uncertain" || !mutation.message) return null;
  return (
    <ChannelActionNote message={mutation.message} fresh={!alreadyLocked}>
      <Button
        size="sm"
        disabled={Boolean(mutation.checking)}
        onClick={() =>
          void mutation
            .checkOutcome(() => fetchIntegrationConnection(connectionId))
            .then(async () => {
              if (mounted.current) await reload();
            })
        }
      >
        Check what was saved
      </Button>
    </ChannelActionNote>
  );
}
