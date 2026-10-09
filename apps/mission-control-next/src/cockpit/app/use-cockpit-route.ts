import { resolveCockpitCompatibility } from "./cockpit-compatibility";
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
  const { pathname, search, hash } = readCockpitLocation();
  return pathname + search + hash;
}

export function useCockpitRoute() {
  const location = useSyncExternalStore(subscribe, readRouteLocation, () => "/chat");
  const { navigate, requestTransition } = useCockpitNavigation();
  const resolution = resolveCockpitCompatibility(location);
  const native = new URL(resolution.kind === "native" ? resolution.href : location, "http://cockpit.invalid");
  return { ...parseCockpitLocation(native.pathname), resolution, pathname: native.pathname, search: native.search, hash: native.hash, navigate, requestTransition };
}
