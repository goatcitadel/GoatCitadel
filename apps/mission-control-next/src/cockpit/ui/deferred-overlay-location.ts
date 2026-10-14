import { COCKPIT_LOCATION_EVENT } from "../app/cockpit-back-guard";
export let locationRevision = 0;
export const locationSubscribers = new Set<() => void>();
export const locationChanged = () => {
  locationRevision += 1;
  for (const notify of locationSubscribers) notify();
};
export function subscribeLocation(notify: () => void) {
  if (!locationSubscribers.size) {
    window.addEventListener("popstate", locationChanged);
    window.addEventListener(COCKPIT_LOCATION_EVENT, locationChanged);
  }
  locationSubscribers.add(notify);
  return () => {
    locationSubscribers.delete(notify);
    if (!locationSubscribers.size) {
      window.removeEventListener("popstate", locationChanged);
      window.removeEventListener(COCKPIT_LOCATION_EVENT, locationChanged);
    }
  };
}
export const readLocationRevision = () => locationRevision;
