import { useId, useState } from "react";
import type { ChannelSetupDefinition, ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { Button } from "../../../../cockpit/ui/Button";
import { inboundWebhookPath } from "./channel-wizard-model";

/** GoatCitadel does not know its public address, so this placeholder is the only form of it any copy may show. */
const PUBLIC_ADDRESS_PLACEHOLDER = "https://<your public address>";

/**
 * The address a vendor posts messages to, as the Gateway path behind the operator's own public address. It adds no
 * live region: Copied is only the button's label, and a clipboard that is missing or refuses leaves it on Copy.
 * `notLiveYet` is for a new setup, whose address is known before it exists as a connection.
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
  const address = `${PUBLIC_ADDRESS_PLACEHOLDER}${path}`;
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
      <p className="text-sm text-fg-secondary">
        {
          "GoatCitadel doesn't provide a public address. Put your own HTTPS address (a reverse proxy or tunnel) in front of GoatCitadel, then give the vendor this address."
        }
      </p>
      {notLiveYet ? <p className="text-sm text-fg-secondary">{"This address works once you finish."}</p> : null}
    </section>
  );
}

/**
 * What the guides' first-message step says about the webhook. A new setup keeps its draft's id as its connection's id
 * when it is finished, so it shows the real address now, and says it works once the setup is finished. A saved
 * connection that is being changed shows its own address.
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
