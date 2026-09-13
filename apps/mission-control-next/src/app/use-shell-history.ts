import { useCallback, useEffect, useRef } from "react";
import { buildAppHref, normalizeAppRoute, type AppRoute } from "./route-model";
import { coerceCompatibilityHrefToNext, resolveRouteFromLocation } from "./legacy-route-adapter";
import { hasDirtySections } from "../features/native-routes/library/use-form-dirty";

const POSITION = "goatcitadelNavigationPosition";

/** Keep a rejected Back/Forward transition on its original history entry. */
export function useShellHistory(apply: (route: AppRoute) => void) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const position = useRef<number>(Number(window.history.state?.[POSITION]) || 0);
  const currentHref = useRef(buildAppHref(resolveRouteFromLocation(window.location.href)));
  const pending = useRef<{ position: number; href: string } | null>(null);
  const restoring = useRef(false);
  const allowed = useRef(false);
  const requestRef = useRef<(route: AppRoute, options?: { replace?: boolean }) => void>(() => undefined);

  const navigate = useCallback((nextRoute: AppRoute, options?: { replace?: boolean }) => {
    const normalized = normalizeAppRoute(nextRoute);
    const href = buildAppHref(normalized);
    if (pending.current?.href === href && typeof window.history.go === "function") {
      const delta = pending.current.position - position.current;
      pending.current = null;
      if (delta) { allowed.current = true; window.history.go(delta); return; }
    }
    pending.current = null;
    const nextPosition = options?.replace ? position.current : position.current + 1;
    const mutate = options?.replace ? window.history.replaceState : window.history.pushState;
    mutate.call(window.history, { ...window.history.state, [POSITION]: nextPosition }, "", href);
    position.current = nextPosition;
    currentHref.current = href;
    applyRef.current(normalized);
  }, []);

  useEffect(() => {
    window.history.replaceState({ ...window.history.state, [POSITION]: position.current }, "", window.location.href);
    const onPopState = () => {
      if (restoring.current) { restoring.current = false; return; }
      const nextRoute = resolveRouteFromLocation(window.location.href);
      const href = buildAppHref(nextRoute);
      const targetPosition = window.history.state?.[POSITION];
      if (hasDirtySections() && !allowed.current && href !== currentHref.current) {
        if (typeof targetPosition === "number" && targetPosition !== position.current && typeof window.history.go === "function") {
          pending.current = { position: targetPosition, href };
          restoring.current = true;
          window.history.go(position.current - targetPosition);
        } else {
          // Older entries have no presentation index. Preserve their URL target for
          // the leave decision without introducing a duplicate forward navigation.
          window.history.replaceState({ ...window.history.state, [POSITION]: position.current }, "", currentHref.current);
        }
        requestRef.current(nextRoute, { replace: true });
        return;
      }
      allowed.current = false;
      pending.current = null;
      if (typeof targetPosition === "number") position.current = targetPosition;
      currentHref.current = href;
      const compatibilityHref = coerceCompatibilityHrefToNext(window.location.href);
      if (compatibilityHref && compatibilityHref !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState({ ...window.history.state, [POSITION]: position.current }, "", compatibilityHref);
      }
      applyRef.current(nextRoute);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return { navigate, requestRef, cancel: () => { pending.current = null; } };
}
