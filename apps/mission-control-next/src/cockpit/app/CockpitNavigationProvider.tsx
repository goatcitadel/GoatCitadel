import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { hasDirtySections, useBeforeUnloadGuard } from "../../features/native-routes/library/use-form-dirty";
import { ShellSwitchFeedback } from "./use-cockpit-shell-switch";
import { CockpitNavigationContext, type CockpitNavigationOwner } from "./cockpit-navigation-context";
import { registerCockpitBackGuard } from "./cockpit-back-guard";
import {
  cockpitHref,
  commitCockpitNavigation,
  readCockpitHistory,
  retainsSettingsPage,
  subscribeCockpitHistory,
} from "./cockpit-history";

type HeldMove = { proceed: () => void };

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
  // Reviewed transitions that are still running already decided the drafts, kept ones included.
  const running = useRef(0);
  const [heldMove, setHeldMove] = useState<HeldMove | null>(null);
  useLayoutEffect(
    () =>
      // Back and Forward to another page wait for the leave review while any draft is unsaved.
      registerCockpitBackGuard({
        holds: () => hasDirtySections() && running.current === 0,
        review: (proceed) => setHeldMove({ proceed }),
      }),
    [],
  );
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
      running.current += 1;
      const settle = () => {
        running.current -= 1;
      };
      try {
        const result = action({
          isCurrent: current,
          signal: review.signal,
          navigate: (href, options) => current() && commitCockpitNavigation(href, options),
        });
        void Promise.resolve(result).then(settle, settle);
        return result;
      } catch (error) {
        settle();
        throw error;
      }
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
  // Requested after the commit that rendered the restored page, so the review reads the current scope.
  const reviewHeldMove = useEffectEvent((move: HeldMove) => {
    requestTransition((review) => {
      if (review.isCurrent()) move.proceed();
    });
  });
  useEffect(() => {
    if (heldMove) reviewHeldMove(heldMove);
  }, [heldMove]);
  return (
    <CockpitNavigationContext.Provider
      value={{ navigate, requestTransition, isTransitionPending: handoff.isTransitionPending }}
    >
      {children}
      <ShellSwitchFeedback owner={handoff} />
    </CockpitNavigationContext.Provider>
  );
}
