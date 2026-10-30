import { Suspense } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { channelPickerHref } from "../../../app/routes";
import { AreaHeader } from "../../../ui/AreaHeader";
import { AREA_COLUMN } from "../../../ui/area-layout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { ChannelsSettings, PublicWebAddressSettings } from "../../settings/settings-controls";

/**
 * Chat › Messaging › Advanced channel setup: the public web address, and every channel's full settings. It sets up
 * the channels that have no page of their own in Chat, and the ways to connect those pages leave out (a Discord
 * webhook, a Slack OAuth install, WhatsApp's own steps). It moved here unchanged from the retired Settings ›
 * Connections, and `?channel=<catalog id>` still opens a new setup of that channel.
 */
export function ChannelAdvancedSetup() {
  // The same workspace Settings gave these editors: an install with none chosen edits with none.
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "";
  return (
    <section aria-label="Advanced channel setup" className={`${AREA_COLUMN} grid min-w-0 gap-6 p-4 md:p-6`}>
      <AreaHeader
        title="Advanced channel setup"
        description="Every channel's full settings, and the address the internet reaches GoatCitadel at."
        actions={
          <NativeOwnerLink href={channelPickerHref()} scope={workspaceId} className="text-sm">
            Back to channels
          </NativeOwnerLink>
        }
      />
      {/* The outline goes h1 › h2 › each part's h3, as it did in Settings. */}
      <h2 className="sr-only">Channels and the public web address</h2>
      <Suspense fallback={<p className="text-sm text-fg-muted">Loading channels…</p>}>
        <div className="min-w-0">
          <PublicWebAddressSettings />
          <ChannelsSettings key={workspaceId} workspaceId={workspaceId} />
        </div>
      </Suspense>
    </section>
  );
}
