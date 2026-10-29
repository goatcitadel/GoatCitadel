import { useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { channelKeyChangeHref } from "../../app/routes";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Section } from "../../ui/Section";
import { ChannelActionNote } from "./ChannelActionNote";
import { KEY_CHANGE_CHANNELS } from "./channel-setup/channel-picker-model";
import { REMOVE_CONSEQUENCE, removeChannelTitle } from "./channel-remove-copy";
import { useChannelLifecycle } from "./use-channel-lifecycle";

/** A channel with a key page of its own in Chat changes its key there; every other channel's is still changed in Settings. */
function keyChangeHref(connection: IntegrationConnection): string {
  return KEY_CHANGE_CHANNELS.has(connection.key)
    ? channelKeyChangeHref(connection.connectionId)
    : "/settings/connections#channels";
}

/**
 * Turn the channel off or on (reversible, so a plain button) or remove it (red, and asked about first), and the way to
 * a new key. Both write through the connection owners Settings uses; Settings keeps its own lifecycle controls.
 */
export function ManageSection({
  connection,
  workspaceId,
  reload,
  removeOnly = false,
}: {
  connection: IntegrationConnection;
  workspaceId: string;
  reload: () => Promise<unknown>;
  /** A retired channel's connection can only be removed: no switch and no key change, which imply it can work. */
  removeOnly?: boolean;
}) {
  const lifecycle = useChannelLifecycle(connection, reload);
  const [confirming, setConfirming] = useState(false);
  // Why the last Remove in this confirmation held back; shown in the dialog, which stays open for another try.
  const [heldBack, setHeldBack] = useState<string | null>(null);
  const confirm = (open: boolean) => {
    setHeldBack(null);
    setConfirming(open);
  };
  const turningOff = connection.enabled;
  return (
    <Section title={removeOnly ? "Remove" : "Turn off or remove"}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {removeOnly ? null : (
            <Button
              disabled={lifecycle.locked && lifecycle.busy !== "toggle"}
              loading={lifecycle.busy === "toggle"}
              loadingLabel={turningOff ? "Turning off…" : "Turning on…"}
              onClick={() => void lifecycle.toggle()}
            >
              {turningOff ? "Turn off" : "Turn on"}
            </Button>
          )}
          <Button
            variant="danger"
            aria-label={`Remove ${connection.label}`}
            disabled={lifecycle.locked}
            onClick={() => confirm(true)}
          >
            Remove
          </Button>
        </div>
        {lifecycle.note ? <ChannelActionNote message={lifecycle.note} fresh /> : null}
        {removeOnly ? null : (
          <NativeOwnerLink href={keyChangeHref(connection)} scope={workspaceId} className="block text-sm">
            Change the key
          </NativeOwnerLink>
        )}
      </div>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && lifecycle.busy !== "remove") confirm(false);
        }}
        title={removeChannelTitle(connection.label)}
        description={REMOVE_CONSEQUENCE}
      >
        {heldBack ? (
          <div className="mt-4">
            <ChannelActionNote message={heldBack} fresh />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={lifecycle.locked && lifecycle.busy !== "remove"}
            loading={lifecycle.busy === "remove"}
            loadingLabel="Removing…"
            // A removal that held back for another change in flight sent nothing: the dialog stays open and says why.
            onClick={() =>
              void lifecycle.remove().then((held) => {
                if (held) setHeldBack(held);
                else confirm(false);
              })
            }
          >
            Remove channel
          </Button>
          <Button disabled={lifecycle.busy === "remove"} onClick={() => confirm(false)}>
            Keep channel
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
