import { useContext, type AnchorHTMLAttributes } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { CockpitNavigationContext } from "../app/cockpit-navigation-context";
import { cockpitHref, commitCockpitNavigation } from "../app/cockpit-history";
import { ShellSwitchFeedback } from "../app/use-cockpit-shell-switch";
import { isModifiedClick } from "../lib/modified-click";

/** Same-shell navigation uses the existing draft/scope/lifetime owner without remounting the application. */
export function NativeOwnerLink({
  href,
  scope,
  children,
  ...attributes
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & {
  href: string;
  scope: unknown;
}) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const navigation = useContext(CockpitNavigationContext);
  const destination = cockpitHref(href);
  const handoff = useShellHandoff([getGatewayApiBaseUrl(), activeCitadelId, activeWorkspaceId, scope, destination]);
  if (!destination) return <span className={attributes.className}>{children}</span>;
  return (
    <>
      <a
        {...attributes}
        href={destination}
        aria-disabled={handoff.opening || undefined}
        onClick={(event) => {
          if (isModifiedClick(event, attributes)) return;
          event.preventDefault();
          if (!navigation) return;
          // This link already owns the exact record-scoped leave review. Do not
          // route through the frame guard again and ask for a second decision.
          handoff.requestNavigation(destination, commitCockpitNavigation);
        }}
      >
        {children}
      </a>
      <ShellSwitchFeedback owner={handoff} />
    </>
  );
}
