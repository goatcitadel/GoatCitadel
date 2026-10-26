import { useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Section } from "../../ui/Section";
import { ChannelActionNote } from "./ChannelActionNote";
import { useChannelLifecycle } from "./use-channel-lifecycle";

/** What removing a channel does, said before its button. */
export const REMOVE_CONSEQUENCE =
  "This affects the saved installation-wide connection and may stop its runtime. External messages and previously completed actions cannot be undone here.";

/**
 * Turn the channel off or on (reversible, so a plain button) or remove it (red, and asked about first), and the way to
 * a new key. Both write through the connection owners Settings uses; Settings keeps its own lifecycle controls.
 */
export function ManageSection({
  connection,
  workspaceId,
  reload,
}: {
  connection: IntegrationConnection;
  workspaceId: string;
  reload: () => Promise<unknown>;
}) {
  const lifecycle = useChannelLifecycle(connection, reload);
  const [confirming, setConfirming] = useState(false);
  const turningOff = connection.enabled;
  return (
    <Section title="Turn off or remove">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={lifecycle.locked && lifecycle.busy !== "toggle"}
            loading={lifecycle.busy === "toggle"}
            loadingLabel={turningOff ? "Turning off…" : "Turning on…"}
            onClick={() => void lifecycle.toggle()}
          >
            {turningOff ? "Turn off" : "Turn on"}
          </Button>
          <Button
            variant="danger"
            aria-label={`Remove ${connection.label}`}
            disabled={lifecycle.locked}
            onClick={() => setConfirming(true)}
          >
            Remove
          </Button>
        </div>
        {lifecycle.note ? <ChannelActionNote message={lifecycle.note} fresh /> : null}
        <NativeOwnerLink href="/settings/connections#channels" scope={workspaceId} className="block text-sm">
          Change the key
        </NativeOwnerLink>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && lifecycle.busy !== "remove") setConfirming(false);
        }}
        title={`Remove ${connection.label}?`}
        description={REMOVE_CONSEQUENCE}
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="danger"
            loading={lifecycle.busy === "remove"}
            loadingLabel="Removing…"
            onClick={() => void lifecycle.remove().then(() => setConfirming(false))}
          >
            Remove channel
          </Button>
          <Button disabled={lifecycle.busy === "remove"} onClick={() => setConfirming(false)}>
            Keep channel
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
