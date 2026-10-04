import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { hasDirtySections, useBeforeUnloadGuard } from "../../features/native-routes/library/use-form-dirty";
import { ShellSwitchFeedback } from "./use-cockpit-shell-switch";
import { CockpitNavigationContext, type CockpitNavigationOwner } from "./cockpit-navigation-context";
import {
  COCKPIT_LOCATION_EVENT,
  cockpitHref,
  commitCockpitNavigation,
  readCockpitHistory,
  retainsSettingsPage,
  subscribeCockpitHistory,
} from "./cockpit-history";

function currentLocation(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

/** One presentation leave owner for the frame and all imperative native route callbacks. */
export function CockpitNavigationProvider({ children }: { children: ReactNode }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const installation = getGatewayApiBaseUrl();
  const identity = canonicalJsonString([installation, activeCitadelId, activeWorkspaceId]);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const view = useRef({ identity, history });
  if (view.current.identity !== identity || view.current.history !== history) view.current = { identity, history };
  const renderedView = view.current;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const handoff = useShellHandoff([identity, history]);
  useBeforeUnloadGuard();
  const shownLocation = useRef(currentLocation());
  const heldTarget = useRef<string | null>(null);
  useLayoutEffect(() => {
    shownLocation.current = currentLocation();
  }, [history]);
  useEffect(() => {
    // Back and Forward can't be cancelled. With unsaved drafts the page puts its own URL back
    // and replays the destination through the reviewed transition below, which asks first.
    const onPopState = () => {
      const target = currentLocation();
      const source = shownLocation.current;
      if (target === source || !hasDirtySections() || retainsSettingsPage(source, target)) return;
      heldTarget.current = target;
      window.history.pushState(null, "", source);
      window.dispatchEvent(new Event(COCKPIT_LOCATION_EVENT));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const isCurrent = () =>
    mounted.current &&
    view.current === renderedView &&
    getGatewayApiBaseUrl() === installation &&
    readCockpitHistory() === history;
  const requestTransition: CockpitNavigationOwner["requestTransition"] = (action) => {
    if (!isCurrent()) return;
    handoff.requestTransition((review) => {
      const current = () => isCurrent() && review.isCurrent() && !review.signal.aborted;
      if (!current()) return;
      return action({
        isCurrent: current,
        signal: review.signal,
        navigate: (href, options) => current() && commitCockpitNavigation(href, options),
      });
    });
  };
  const navigate: CockpitNavigationOwner["navigate"] = (href, options) => {
    const destination = cockpitHref(href);
    if (!destination || !isCurrent()) return;
    const source = window.location.pathname + window.location.search + window.location.hash;
    if (cockpitHref(source) === destination) return;
    if (retainsSettingsPage(source, destination)) {
      commitCockpitNavigation(destination, options);
      return;
    }
    requestTransition((review) => {
      review.navigate(destination, options);
    });
  };
  // No dependency list on purpose: `navigate` is rebuilt every render, so this already ran after every
  // render. It must see the render that restored the URL, so the review reads current scope.
  useEffect(() => {
    const target = heldTarget.current;
    if (!target) return;
    heldTarget.current = null;
    navigate(target);
  });
  return (
    <CockpitNavigationContext.Provider
      value={{ navigate, requestTransition, isTransitionPending: handoff.isTransitionPending }}
    >
      {children}
      <ShellSwitchFeedback owner={handoff} />
    </CockpitNavigationContext.Provider>
  );
}
