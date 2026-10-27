import { useContext, type AnchorHTMLAttributes } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { CockpitNavigationContext } from "../app/cockpit-navigation-context";
import { cockpitHref, commitCockpitNavigation } from "../app/cockpit-history";
import { ShellSwitchFeedback } from "../app/use-cockpit-shell-switch";
import { cn } from "../lib/cn";
import { isModifiedClick } from "../lib/modified-click";

/** An owner link reads as a link at its natural width (WK-N04); callers' classes merge on top. */
const LINK_CLASS = "w-fit text-accent underline-offset-2 hover:underline";

/**
 * Same-shell navigation uses the existing draft/scope/lifetime owner without remounting the application. A link with
 * no cockpit destination renders nothing (GL-N08): text that looks like a link but goes nowhere is worse than none.
 *
 * `onNavigate` runs once a plain click has been carried out: after any leave review, and also when the destination is
 * the page already open. It never runs for a modified click (new tab, new window) or a review the operator cancels.
 * A host that closes with the click, such as a sheet, uses it instead of reacting to the click itself, because
 * closing first would take this link, and the leave review it owns, away before the move happened.
 */
export function NativeOwnerLink({
  href,
  scope,
  children,
  className,
  onNavigate,
  ...attributes
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & {
  href: string;
  scope: unknown;
  onNavigate?: () => void;
}) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const navigation = useContext(CockpitNavigationContext);
  const destination = cockpitHref(href);
  const handoff = useShellHandoff([getGatewayApiBaseUrl(), activeCitadelId, activeWorkspaceId, scope, destination]);
  if (!destination) return null;
  return (
    <>
      <a
        {...attributes}
        className={cn(LINK_CLASS, className)}
        href={destination}
        aria-disabled={handoff.opening || undefined}
        onClick={(event) => {
          if (isModifiedClick(event, attributes)) return;
          event.preventDefault();
          if (!navigation) return;
          // This link already owns the exact record-scoped leave review. Do not
          // route through the frame guard again and ask for a second decision.
          handoff.requestNavigation(destination, (target) => {
            commitCockpitNavigation(target);
            onNavigate?.();
          });
        }}
      >
        {children}
      </a>
      <ShellSwitchFeedback owner={handoff} />
    </>
  );
}
