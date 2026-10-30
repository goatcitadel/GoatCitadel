import { useContext, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import {
  publicWebAddressFor,
  type ChannelSetupDefinition,
  type ChannelSetupDraft,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
import { CockpitOwnerLink, cockpitShellHref } from "../../../../app/CockpitOwnerLink";
import { CockpitNavigationContext } from "../../../../cockpit/app/cockpit-navigation-context";
import { usePublicWebAddress } from "../../../../cockpit/areas/settings/public-web-address-state";
import { Button } from "../../../../cockpit/ui/Button";
import { NativeOwnerLink } from "../../../../cockpit/ui/NativeOwnerLink";
import { inboundWebhookPath } from "./channel-wizard-model";

/** Until the operator sets their public web address, this placeholder is the only form of it any copy may show. */
const PUBLIC_ADDRESS_PLACEHOLDER = "https://<your public address>";
const SET_ADDRESS_LABEL = "Set your public web address";
const SET_ADDRESS_PATH = "/settings/connections";
const SET_ADDRESS_ANCHOR = "#channels";

/**
 * The address a vendor posts messages to, as the Gateway path behind the operator's own public web address (Settings ›
 * Channels), or behind a placeholder until it is set. It adds no live region: Copied is only the button's label, and a
 * clipboard that is missing or refuses leaves it on Copy. `notLiveYet` is for a new setup, whose address is known
 * before it exists as a connection.
 */
export function ChannelWebhookAddress({
  path,
  notLiveYet = false,
  className = "",
}: {
  path: string;
  notLiveYet?: boolean;
  className?: string;
}) {
  return (
    <WithQueryClient>
      <WebhookAddress path={path} notLiveYet={notLiveYet} className={className} />
    </WithQueryClient>
  );
}

function WebhookAddress({ path, notLiveYet, className }: { path: string; notLiveYet: boolean; className: string }) {
  const publicWebAddress = usePublicWebAddress();
  const builtAddress = publicWebAddressFor(publicWebAddress, path);
  const address = builtAddress ?? `${PUBLIC_ADDRESS_PLACEHOLDER}${path}`;
  // The copy belongs to the address it was made for, so a different address starts on Copy again.
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const addressId = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(address);
    } catch {
      // Copying is best-effort: with no clipboard, or one that says no, leave the label on Copy. The address stays on
      // screen to select by hand.
    }
  }

  return (
    <section aria-label="Webhook address" className={`min-w-0 space-y-1 ${className}`.trim()}>
      <p className="text-sm font-medium">Webhook address</p>
      <div className="flex flex-wrap items-center gap-2">
        <code id={addressId} className="min-w-0 break-all rounded-md bg-sunken px-2 py-1 font-mono text-xs text-fg">
          {address}
        </code>
        <Button size="sm" aria-describedby={addressId} onClick={() => void copy()}>
          {copiedAddress === address ? "Copied" : "Copy"}
        </Button>
      </div>
      {builtAddress ? (
        <p className="text-sm text-fg-secondary">
          {"Built from your public web address. Give the vendor this address."}
        </p>
      ) : (
        <>
          <p className="text-sm text-fg-secondary">
            {
              "GoatCitadel doesn't provide a public address. Put your own HTTPS address (a reverse proxy or tunnel) in front of GoatCitadel, then give the vendor this address."
            }
          </p>
          <p className="text-sm">
            <SetPublicWebAddressLink />
          </p>
        </>
      )}
      {notLiveYet ? (
        <p className="text-sm text-fg-secondary">{"This address works once you finish and the connection is on."}</p>
      ) : null}
    </section>
  );
}

/**
 * The way to Settings › Channels. The Cockpit moves there in place, after the leave review of anything unsaved; the
 * Classic guide has no such navigation, so its link opens the same page in the Cockpit shell.
 */
function SetPublicWebAddressLink() {
  const inCockpit = useContext(CockpitNavigationContext) !== null;
  return inCockpit ? (
    <NativeOwnerLink href={`${SET_ADDRESS_PATH}${SET_ADDRESS_ANCHOR}`} scope="public-web-address">
      {SET_ADDRESS_LABEL}
    </NativeOwnerLink>
  ) : (
    <CockpitOwnerLink
      href={`${cockpitShellHref(SET_ADDRESS_PATH)}${SET_ADDRESS_ANCHOR}`}
      scope="public-web-address"
      label={SET_ADDRESS_LABEL}
    />
  );
}

/**
 * The public web address is read through a query client. The Cockpit has one. The Classic guide has none, so there the
 * read gets its own, started afresh when the gateway access changes so an address read under other access is never shown.
 */
function WithQueryClient({ children }: { children: ReactNode }) {
  const inherited = useContext(QueryClientContext);
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  return inherited ? <>{children}</> : <OwnQueryClient key={accessRevision}>{children}</OwnQueryClient>;
}

function OwnQueryClient({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * What the guides' first-message step says about the webhook. A new setup keeps its draft's id as its connection's id
 * when it is finished, so it shows the real address now, and says it works once the setup is finished and the
 * connection is on. A saved connection that is being changed shows its own address.
 */
export function ChannelFirstMessageWebhook({
  definition,
  draft,
  values,
  className = "",
}: {
  definition: ChannelSetupDefinition;
  draft: Pick<ChannelSetupDraft, "lifecycleMode" | "draftId" | "connectionId">;
  values: Record<string, unknown>;
  className?: string;
}) {
  const isNewSetup = draft.lifecycleMode === "create";
  const path = inboundWebhookPath(definition, values, isNewSetup ? draft.draftId : draft.connectionId);
  return path ? <ChannelWebhookAddress path={path} notLiveYet={isNewSetup} className={className} /> : null;
}

/** The address on a saved connection's panel, from its channel's definition and its saved settings. */
export function ChannelConnectionWebhook({
  connection,
  definitions,
  className = "",
}: {
  connection: Pick<IntegrationConnection, "catalogId" | "connectionId" | "config">;
  definitions: readonly ChannelSetupDefinition[] | undefined;
  className?: string;
}) {
  const definition = definitions?.find((item) => item.catalog.catalogId === connection.catalogId);
  const path = definition ? inboundWebhookPath(definition, connection.config, connection.connectionId) : undefined;
  return path ? <ChannelWebhookAddress path={path} className={className} /> : null;
}
