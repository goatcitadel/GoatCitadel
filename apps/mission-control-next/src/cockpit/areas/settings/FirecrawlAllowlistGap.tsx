import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { NETWORK_ALLOWLIST_LINK } from "../capabilities/connectors/connector-links";
import type { FirecrawlGapCause } from "./web-search-state";

/**
 * The warning above Firecrawl's form while the Gateway (or this page's preview of it) refuses the address, with the
 * governed add button. The saved address also links to the allowlist field.
 */
export function FirecrawlAllowlistGap({
  host,
  source,
  cause,
  disabled,
  busy,
  onAdd,
}: {
  host: string;
  source: "draft" | "gateway";
  cause: FirecrawlGapCause;
  disabled: boolean;
  busy: boolean;
  onAdd: () => void;
}) {
  if (cause !== "not_listed") {
    // Listing it again changes nothing, so there is no Add button.
    return (
      <Callout tone="warning" announce={false}>
        <p>
          {cause === "reserved"
            ? `${host} can't be used for Firecrawl. It is a private or reserved address that GoatCitadel does not allow for this service, even when it is on the outbound allowlist.`
            : `GoatCitadel refused ${host} although it is on the outbound allowlist. Run the connection test to see why.`}
        </p>
      </Callout>
    );
  }
  return (
    <Callout tone="warning" announce={false}>
      <p>
        {source === "gateway"
          ? `${host} is not in the outbound allowlist, so tools can't reach it and use native search instead.`
          : `${host} is not in the outbound allowlist. Tools cannot reach it, and GoatCitadel will not save Firecrawl as on until the host is allowed.`}
      </p>
      <Button size="sm" className="mt-2" disabled={disabled} onClick={onAdd}>
        {busy ? "Adding…" : `Add ${host} to the outbound allowlist`}
      </Button>
      {source === "gateway" ? (
        <NativeOwnerLink href={NETWORK_ALLOWLIST_LINK.href} scope="firecrawl-allowlist" className="mt-2 block text-sm">
          {NETWORK_ALLOWLIST_LINK.label}
        </NativeOwnerLink>
      ) : null}
    </Callout>
  );
}
