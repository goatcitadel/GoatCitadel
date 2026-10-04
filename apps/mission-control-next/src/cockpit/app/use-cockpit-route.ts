import { useSyncExternalStore } from "react";
import { parseCockpitLocation } from "./routes";
import { useCockpitNavigation } from "./cockpit-navigation-context";
import { COCKPIT_LOCATION_EVENT, readCockpitLocation } from "./cockpit-back-guard";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(COCKPIT_LOCATION_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(COCKPIT_LOCATION_EVENT, onChange);
  };
}

function readRouteLocation() {
  const { pathname, search } = readCockpitLocation();
  return pathname + search;
}

export function useCockpitRoute() {
  const location = useSyncExternalStore(subscribe, readRouteLocation, () => "/chat");
  const queryStart = location.indexOf("?");
  const pathname = queryStart < 0 ? location : location.slice(0, queryStart);
  const search = queryStart < 0 ? "" : location.slice(queryStart);
  const { navigate, requestTransition } = useCockpitNavigation();
  return { ...parseCockpitLocation(pathname), pathname, search, navigate, requestTransition };
}
