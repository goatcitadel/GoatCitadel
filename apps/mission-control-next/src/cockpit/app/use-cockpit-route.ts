import { useSyncExternalStore } from "react";
import { parseCockpitLocation } from "./routes";
import { useCockpitNavigation } from "./cockpit-navigation-context";

const LOCATION_EVENT = "goatcitadel:cockpit-location";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(LOCATION_EVENT, onChange);
  };
}

export function useCockpitRoute() {
  const location = useSyncExternalStore(
    subscribe,
    () => window.location.pathname + window.location.search,
    () => "/chat",
  );
  const queryStart = location.indexOf("?");
  const pathname = queryStart < 0 ? location : location.slice(0, queryStart);
  const search = queryStart < 0 ? "" : location.slice(queryStart);
  const { navigate, requestTransition } = useCockpitNavigation();
  return { ...parseCockpitLocation(pathname), pathname, search, navigate, requestTransition };
}
