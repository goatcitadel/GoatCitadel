import { useState, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
import { CockpitOwnerLink, cockpitShellHref } from "../../../../app/CockpitOwnerLink";
import { ChannelHostsCheck, type InboxLink } from "./ChannelHostsCheck";
import type { UnreadableHostField } from "./channel-wizard-model";

/** Classic has no Inbox page, so a link to one opens it in the Cockpit shell. */
const CockpitInboxLink: InboxLink = ({ href, scope, children }) => (
  <CockpitOwnerLink href={cockpitShellHref(href)} scope={scope} label={children} />
);

type HostsCheckProps = { hosts: readonly string[]; unreadable?: readonly UnreadableHostField[]; workspaceId: string };

/**
 * The hosts check for the Classic guide. Only the Cockpit has a query client, and the check reads the allowlist
 * through one, so Classic gives it its own. It is started afresh when the gateway access changes, so an allowlist
 * read under other access is never shown.
 */
export function ClassicChannelHostsCheck(props: HostsCheckProps) {
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  return <HostsCheckWithClient key={accessRevision} {...props} />;
}

function HostsCheckWithClient({ hosts, unreadable, workspaceId }: HostsCheckProps) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={client}>
      <ChannelHostsCheck
        hosts={hosts}
        {...(unreadable ? { unreadable } : {})}
        workspaceId={workspaceId}
        inboxLink={CockpitInboxLink}
      />
    </QueryClientProvider>
  );
}
